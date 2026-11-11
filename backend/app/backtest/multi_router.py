"""Multi-period backtest as a BACKGROUND JOB with selectable rule presets.

Why a job, not a blocking request: running 5 windows takes 7-10 min, far past
what a browser will wait. So:
    POST /api/backtest/multi/start            -> returns {job_id} instantly
    GET  /api/backtest/multi/status/{job_id}  -> progress + results-so-far (poll)

The price download is cached per-process, so a second run (e.g. a different
preset) skips the slow part and finishes in ~1-2 min.

PRESETS override stop-loss and cash-reserve WITHOUT touching the saved defaults
in settings -- your live engine keeps running Conservative.
"""
import asyncio
import json
import logging
import uuid
from pathlib import Path
from dataclasses import asdict
from datetime import datetime, timedelta

import pytz
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from app.backtest.simulator import BacktestSimulator
from app.config import get_settings
from app.db.database import AsyncSessionLocal
from app.db.models import BacktestRun, BacktestTrade, StockUniverse

logger = logging.getLogger("stocksage.backtest.multi")
settings = get_settings()
router = APIRouter(prefix="/api/backtest", tags=["backtest"])

WINDOWS = [("3Y", 365 * 3), ("2Y", 365 * 2), ("1Y", 365), ("6M", 182), ("3M", 91)]

PRESETS = {
    "conservative": {"stop_loss_pct": 0.08, "cash_reserve_pct": 0.20,
                     "label": "Conservative", "desc": "Current defaults -- -8% stop, 20% cash. Max protection."},
    "medium": {"stop_loss_pct": 0.10, "cash_reserve_pct": 0.15,
               "label": "Medium", "desc": "-10% stop, 15% cash. Balanced."},
    "aggressive": {"stop_loss_pct": 0.12, "cash_reserve_pct": 0.10,
                   "label": "Aggressive", "desc": "-12% stop, 10% cash. More bull-market participation."},
}

_JOBS: dict[str, dict] = {}
# Strong references to running jobs: the event loop only keeps weak ones, so an
# unreferenced task can be garbage-collected mid-run.
_TASKS: set[asyncio.Task] = set()


def _spawn(coro) -> None:
    task = asyncio.create_task(coro)
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
HISTORY_DIR = Path(__file__).resolve().parent.parent.parent / "job_history"
HISTORY_DIR.mkdir(exist_ok=True)


def _save_history(job_id: str, kind: str, job: dict) -> None:
    """Persist a finished job to disk so history survives restarts."""
    try:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        name = f"{stamp}_{kind}_{job.get('preset', 'run')}_{job_id[:6]}"
        payload = {"name": name, "kind": kind, "finished_at": datetime.now().isoformat(),
                   **{k: v for k, v in job.items() if k != "status"}, "status": "DONE"}
        (HISTORY_DIR / f"{name}.json").write_text(json.dumps(payload), encoding="utf-8")
    except Exception:
        logger.exception("Could not save job history (non-fatal)")
_PRICE_CACHE = {"prices": None, "nifty": None, "meta": None, "stamp": None}


class StartIn(BaseModel):
    preset: str = "conservative"
    initial_capital: float = 100_000


def _downsample(curve, target=180):
    if len(curve) <= target:
        return curve
    return curve[:: len(curve) // target]


async def _load_price_bundle():
    fresh = _PRICE_CACHE["stamp"] and (datetime.utcnow() - _PRICE_CACHE["stamp"]).total_seconds() < 3600
    if fresh:
        return _PRICE_CACHE["prices"], _PRICE_CACHE["nifty"], _PRICE_CACHE["meta"]
    from app.market_data import fetcher
    async with AsyncSessionLocal() as db:
        uni = (await db.execute(select(StockUniverse).where(StockUniverse.is_active.is_(True)))).scalars().all()
    symbols = [u.symbol for u in uni]
    meta = {u.symbol: (u.segment, u.sector or "Services") for u in uni}
    prices = await asyncio.to_thread(fetcher.batch_history, symbols, "5y")
    nifty = await asyncio.to_thread(fetcher.get_history, settings.nifty50_index, "5y")
    _PRICE_CACHE.update(prices=prices, nifty=nifty, meta=meta, stamp=datetime.utcnow())
    return prices, nifty, meta


async def _run_job(job_id, preset_key, capital):
    job = _JOBS[job_id]
    try:
        preset = PRESETS[preset_key]
        cfg = settings.model_copy(update={"stop_loss_pct": preset["stop_loss_pct"], "cash_reserve_pct": preset["cash_reserve_pct"]})
        job["stage"] = "Downloading price history..."
        prices, nifty, meta = await _load_price_bundle()
        sim = BacktestSimulator(prices, meta, nifty, cfg)
        end = datetime.now(pytz.timezone(settings.timezone)).date()
        order = {"3M": 0, "6M": 1, "1Y": 2, "2Y": 3, "3Y": 4}
        results = []
        for idx, (label, days) in enumerate(WINDOWS):
            job["stage"] = f"Simulating {label} window..."
            job["progress"] = idx / len(WINDOWS)
            start = end - timedelta(days=days)
            r = await asyncio.to_thread(sim.run, start, end, capital)
            alpha = round(r.total_return_pct - r.nifty_return_pct, 3)
            async with AsyncSessionLocal() as db:
                run = BacktestRun(name=f"{preset['label']} {label} ({end})", start_date=start, end_date=end,
                                  initial_capital=capital, final_value=r.final_value,
                                  total_return_pct=r.total_return_pct, nifty_return_pct=r.nifty_return_pct,
                                  max_drawdown_pct=r.max_drawdown_pct, win_rate=r.win_rate,
                                  total_trades=r.total_trades, status="DONE", completed_at=datetime.utcnow(),
                                  rule_config={"preset": preset_key, "window": label})
                db.add(run); await db.flush()
                for t in r.trades:
                    db.add(BacktestTrade(run_id=run.id, symbol=t.symbol, action=t.action,
                                         trade_date=t.trade_date, quantity=t.quantity, price=t.price,
                                         pnl=t.pnl, triggered_rule=t.triggered_rule, reason=t.reason))
                await db.commit(); run_id = run.id
            results.append({"window": label, "run_id": run_id, "period": f"{start} -> {end}",
                            "strategy_return_pct": r.total_return_pct, "nifty_return_pct": r.nifty_return_pct,
                            "alpha_pct": alpha, "max_drawdown_pct": r.max_drawdown_pct, "win_rate": r.win_rate,
                            "total_trades": r.total_trades, "open_positions": r.open_positions,
                            "final_value": r.final_value, "equity_curve": _downsample(r.equity_curve),
                            "metrics": r.metrics, "nifty_metrics": r.nifty_metrics,
                            "trades": [asdict(t) | {"trade_date": str(t.trade_date)} for t in r.trades]})
            job["periods"] = sorted(results, key=lambda p: order[p["window"]])
        beat = sum(1 for p in results if p["alpha_pct"] > 0)
        avg_alpha = round(sum(p["alpha_pct"] for p in results) / len(results), 3)
        avg_dd = round(sum(p["max_drawdown_pct"] for p in results) / len(results), 3)
        avg_win = round(sum(p["win_rate"] for p in results) / len(results), 3)
        best = max(results, key=lambda p: p["alpha_pct"]); worst = min(results, key=lambda p: p["alpha_pct"])
        job["summary"] = {"preset": preset["label"], "preset_desc": preset["desc"], "avg_alpha_pct": avg_alpha,
                          "windows_beating_nifty": f"{beat}/{len(results)}", "avg_max_drawdown_pct": avg_dd,
                          "avg_win_rate": avg_win, "best_window": best["window"], "worst_window": worst["window"],
                          "verdict": ("Strong, consistent edge across regimes." if beat >= 4 and avg_alpha > 3
                                      else "Edge present but regime-dependent -- review the weak windows." if beat >= 3
                                      else "Inconsistent -- doesn't reliably beat buy-and-hold across these windows.")}
        job["progress"] = 1.0; job["stage"] = "Done"; job["status"] = "DONE"
        _save_history(job_id, "multi", job)
    except Exception as exc:
        logger.exception("Multi-backtest job failed")
        job["status"] = "FAILED"; job["error"] = str(exc)


@router.post("/multi/start")
async def multi_start(body: StartIn) -> dict:
    if body.preset not in PRESETS:
        raise HTTPException(400, f"Unknown preset. Choose: {list(PRESETS)}")
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "RUNNING", "stage": "Starting...", "progress": 0.0,
                     "kind": "multi", "started_at": datetime.now().isoformat(),
                     "preset": body.preset, "periods": [], "summary": None}
    _spawn(_run_job(job_id, body.preset, body.initial_capital))
    return {"job_id": job_id, "preset": body.preset}


@router.get("/multi/status/{job_id}")
async def multi_status(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (server may have restarted -- start a new run)")
    return {"status": job["status"], "stage": job["stage"], "progress": round(job["progress"], 3),
            "preset": job["preset"], "periods": job["periods"], "summary": job["summary"],
            "error": job.get("error"),
            "notes": ["Composite = technical score only (no historical news/fundamentals).",
                      "Universe = today's constituents (mild survivorship bias).",
                      "Costs: 0.12% per side. Trades at daily close."]}


@router.post("/walkforward/start")
async def walkforward_start() -> dict:
    """Honest split-sample check: each preset judged on the half of history it
    was NOT tuned on. In-sample = older half of 3Y, out-of-sample = recent half.
    A preset whose edge survives out-of-sample is trustworthy; one that only
    wins in-sample is overfit."""
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "RUNNING", "stage": "Starting...", "progress": 0.0,
                     "kind": "walkforward", "started_at": datetime.now().isoformat(),
                     "preset": "walkforward", "results": {}, "summary": None}
    _spawn(_run_walkforward(job_id))
    return {"job_id": job_id}


async def _run_walkforward(job_id: str):
    job = _JOBS[job_id]
    try:
        prices, nifty, meta = await _load_price_bundle()
        end = datetime.now(pytz.timezone(settings.timezone)).date()
        mid = end - timedelta(days=548)          # ~18 months back
        start = end - timedelta(days=365 * 3)
        halves = [("in_sample", start, mid), ("out_of_sample", mid, end)]
        keys = ["conservative", "medium", "aggressive"]
        total = len(keys) * len(halves)
        step, out = 0, {}
        for pk in keys:
            preset = PRESETS[pk]
            cfg = settings.model_copy(update={"stop_loss_pct": preset["stop_loss_pct"],
                                              "cash_reserve_pct": preset["cash_reserve_pct"]})
            sim = BacktestSimulator(prices, meta, nifty, cfg)
            res = {}
            for label, s, e in halves:
                job["stage"] = f"{preset['label']} · {label.replace('_', ' ')}"
                r = await asyncio.to_thread(sim.run, s, e, 100_000)
                res[label] = {"period": f"{s} -> {e}",
                              "strategy_pct": r.total_return_pct,
                              "nifty_pct": r.nifty_return_pct,
                              "alpha_pct": round(r.total_return_pct - r.nifty_return_pct, 3),
                              "max_dd_pct": r.max_drawdown_pct, "trades": r.total_trades,
                              "sharpe": r.metrics.get("sharpe"),
                              "sortino": r.metrics.get("sortino"),
                              "nifty_sharpe": r.nifty_metrics.get("sharpe")}
                step += 1
                job["progress"] = step / total
            ia, oa = res["in_sample"]["alpha_pct"], res["out_of_sample"]["alpha_pct"]
            res["consistent"] = (ia > 0) == (oa > 0) and oa > -2
            res["label"] = preset["label"]
            out[pk] = res
            job["results"] = dict(out)
        consistent = [v["label"] for v in out.values() if v["consistent"]]
        job["summary"] = {"consistent_presets": consistent,
                          "verdict": (f"Edge holds out-of-sample for: {', '.join(consistent)}."
                                      if consistent else
                                      "No preset's edge survived out-of-sample -- treat all backtests skeptically.")}
        job["progress"] = 1.0; job["stage"] = "Done"; job["status"] = "DONE"
        _save_history(job_id, "walkforward", job)
    except Exception as exc:
        logger.exception("Walk-forward failed")
        job["status"] = "FAILED"; job["error"] = str(exc)


@router.get("/walkforward/status/{job_id}")
async def walkforward_status(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (server may have restarted)")
    return {"status": job["status"], "stage": job["stage"], "progress": round(job["progress"], 3),
            "results": job.get("results", {}), "summary": job.get("summary"), "error": job.get("error")}


@router.get("/multi/jobs")
async def active_jobs() -> dict:
    """Jobs currently in memory (RUNNING or recently finished this process)."""
    return {"jobs": [{"job_id": jid, "kind": j.get("kind", "multi"),
                      "preset": j.get("preset"), "status": j["status"],
                      "progress": round(j.get("progress", 0), 3),
                      "stage": j.get("stage"), "started_at": j.get("started_at")}
                     for jid, j in _JOBS.items()]}


@router.get("/multi/history")
async def job_history() -> dict:
    """Completed runs persisted to disk (newest first). Survives restarts."""
    items = []
    for f in sorted(HISTORY_DIR.glob("*.json"), reverse=True)[:30]:
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            items.append({"name": d["name"], "kind": d.get("kind"),
                          "preset": d.get("preset"), "finished_at": d.get("finished_at"),
                          "summary": d.get("summary")})
        except Exception:
            continue
    return {"history": items}


@router.get("/multi/history/{name}")
async def job_history_item(name: str) -> dict:
    """Load one saved run's full payload."""
    safe = "".join(ch for ch in name if ch.isalnum() or ch in "-_")
    path = HISTORY_DIR / f"{safe}.json"
    if not path.exists():
        raise HTTPException(404, "Saved run not found")
    return json.loads(path.read_text(encoding="utf-8"))


@router.get("/presets")
async def list_presets() -> dict:
    return {"presets": [{"key": k, "label": v["label"], "desc": v["desc"],
                         "stop_loss_pct": v["stop_loss_pct"], "cash_reserve_pct": v["cash_reserve_pct"]}
                        for k, v in PRESETS.items()]}


# ── Comparison: run all 3 presets, return side-by-side (Tier 2 / D) ──────────
class CompareIn(BaseModel):
    initial_capital: float = 100_000


@router.post("/compare/start")
async def compare_start(body: CompareIn) -> dict:
    """Start a background job that runs ALL THREE presets across all windows."""
    job_id = uuid.uuid4().hex[:12]
    _JOBS[job_id] = {"status": "RUNNING", "stage": "Starting...", "progress": 0.0,
                     "kind": "compare", "started_at": datetime.now().isoformat(),
                     "preset": "compare", "presets": {}, "summary": None}
    _spawn(_run_compare(job_id, body.initial_capital))
    return {"job_id": job_id}


async def _run_compare(job_id: str, capital: float):
    job = _JOBS[job_id]
    try:
        prices, nifty, meta = await _load_price_bundle()
        end = datetime.now(pytz.timezone(settings.timezone)).date()
        order = {"3M": 0, "6M": 1, "1Y": 2, "2Y": 3, "3Y": 4}
        keys = ["conservative", "medium", "aggressive"]
        total_steps = len(keys) * len(WINDOWS)
        step = 0
        out: dict[str, dict] = {}
        for pk in keys:
            preset = PRESETS[pk]
            cfg = settings.model_copy(update={"stop_loss_pct": preset["stop_loss_pct"],
                                              "cash_reserve_pct": preset["cash_reserve_pct"]})
            sim = BacktestSimulator(prices, meta, nifty, cfg)
            rows = []
            for label, days in WINDOWS:
                job["stage"] = f"{preset['label']} · {label}"
                start = end - timedelta(days=days)
                r = await asyncio.to_thread(sim.run, start, end, capital)
                rows.append({"window": label, "strategy_return_pct": r.total_return_pct,
                             "nifty_return_pct": r.nifty_return_pct,
                             "alpha_pct": round(r.total_return_pct - r.nifty_return_pct, 3),
                             "max_drawdown_pct": r.max_drawdown_pct, "win_rate": r.win_rate,
                             "total_trades": r.total_trades, "sharpe": r.metrics.get("sharpe"),
                             "sortino": r.metrics.get("sortino")})
                step += 1
                job["progress"] = step / total_steps
                rows.sort(key=lambda x: order[x["window"]])
                beat = sum(1 for x in rows if x["alpha_pct"] > 0)
                out[pk] = {
                    "label": preset["label"], "desc": preset["desc"],
                    "stop_loss_pct": preset["stop_loss_pct"], "cash_reserve_pct": preset["cash_reserve_pct"],
                    "windows": rows,
                    "avg_alpha": round(sum(x["alpha_pct"] for x in rows) / len(rows), 3),
                    "avg_drawdown": round(sum(x["max_drawdown_pct"] for x in rows) / len(rows), 3),
                    "windows_beating": f"{beat}/{len(rows)}",
                }
                job["presets"] = dict(out)
        # pick a recommendation: best avg_alpha with drawdown penalty
        best = max(out.values(), key=lambda p: p["avg_alpha"] - 0.5 * p["avg_drawdown"])
        job["summary"] = {"recommended": best["label"],
                          "note": "Highest risk-adjusted score (avg alpha minus half the avg drawdown). "
                                  "Backtest-optimized — forward-test before trusting with real money."}
        job["progress"] = 1.0; job["stage"] = "Done"; job["status"] = "DONE"
        _save_history(job_id, "compare", job)
    except Exception as exc:
        logger.exception("Compare job failed")
        job["status"] = "FAILED"; job["error"] = str(exc)


@router.get("/compare/status/{job_id}")
async def compare_status(job_id: str) -> dict:
    job = _JOBS.get(job_id)
    if not job:
        raise HTTPException(404, "Job not found (server may have restarted)")
    return {"status": job["status"], "stage": job["stage"], "progress": round(job["progress"], 3),
            "presets": job.get("presets", {}), "summary": job.get("summary"), "error": job.get("error")}
