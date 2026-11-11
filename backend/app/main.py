"""StockSage India — application entrypoint (multi-user).

Every API router is protected by JWT auth except /api/auth/* and the
/api/health* probes. The morning and midday scheduler jobs run the engine
once per registered user (each against their own portfolio and settings);
the EOD snapshot is market-wide and runs once.
"""
import logging
from logging.handlers import TimedRotatingFileHandler
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

import pytz
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.interval import IntervalTrigger
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import AsyncSessionLocal, get_db
from app.db.schema import apply_upgrades
from app.auth_router import get_current_user, router as auth_router
from app.market_data.router import router as market_router
from app.market_data.snapshot import run_eod_snapshot
from app.sentiment.pipeline import refresh_news
from app.sentiment.router import router as news_router
from app.engine.router import router as engine_router
from app.engine.daily_run import run_daily_engine
from app.backtest.router import router as backtest_router
from app.backtest.multi_router import router as multi_backtest_router
from app.settings_router import router as settings_router
from app.execute_router import router as execute_router
from app.deepdive_router import router as deepdive_router
from app.insights_router import router as insights_router
from app.trades_router import router as trades_router
from app.options.router import router as options_router
from app.monitoring import router as metrics_router
from app.research_router import router as research_router

_LOG_FORMAT = "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
logging.basicConfig(level=logging.INFO, format=_LOG_FORMAT)
# Also keep a file (repo-root logs/, git-ignored) so a day's run can be reviewed
# after the console window is closed: one file per day, 30 days kept.
try:
    _log_dir = Path(__file__).resolve().parents[2] / "logs"
    _log_dir.mkdir(exist_ok=True)
    _fh = TimedRotatingFileHandler(_log_dir / "stocksage.log", when="midnight",
                                   backupCount=30, encoding="utf-8")
    _fh.setFormatter(logging.Formatter(_LOG_FORMAT))
    logging.getLogger().addHandler(_fh)
except OSError:
    pass                                   # read-only filesystem (containers): console only
logger = logging.getLogger("stocksage")

settings = get_settings()
scheduler = AsyncIOScheduler(timezone=pytz.timezone(settings.timezone))


async def _all_user_ids() -> list[int | None]:
    """Every user with a portfolio; [None] as legacy fallback if none yet."""
    try:
        async with AsyncSessionLocal() as db:
            rows = (await db.execute(text(
                "SELECT DISTINCT user_id FROM portfolios WHERE user_id IS NOT NULL ORDER BY user_id"
            ))).scalars().all()
        return list(rows) if rows else [None]
    except Exception:
        logger.exception("Could not list users — falling back to legacy single run")
        return [None]


# ── Scheduled jobs (per-user engine runs) ────────────────────────────────────
async def job_morning_brief() -> None:
    """08:30 IST — full engine run for EVERY user (R11 uses previous close)."""
    for uid in await _all_user_ids():
        try:
            brief = await run_daily_engine(run_type="MORNING", user_id=uid)
            logger.info("Morning brief ready (user %s): %s", uid, brief["market_guard"]["go_status"])
        except Exception:
            logger.exception("Morning brief failed for user %s", uid)


async def job_midday_refresh() -> None:
    """12:30 IST — re-run with LIVE intraday data for every user."""
    for uid in await _all_user_ids():
        try:
            brief = await run_daily_engine(run_type="MIDDAY", user_id=uid)
            logger.info("Midday refresh (user %s): %s", uid, brief["market_guard"]["go_status"])
        except Exception:
            logger.exception("Midday refresh failed for user %s", uid)


async def job_eod_snapshot() -> None:
    """16:00 IST — market-wide snapshot (shared; runs once)."""
    try:
        result = await run_eod_snapshot()
        logger.info("EOD snapshot complete: %s", result["market_status"])
    except Exception:
        logger.exception("EOD snapshot failed — will use last cached values")


async def job_news_poll() -> None:
    """Every NEWS_POLL_MINUTES, all week: fetch, score and store new headlines
    only (no engine run), so the corpus keeps headlines that scroll off a feed
    between engine runs."""
    try:
        await refresh_news()
    except Exception:
        logger.exception("News poll failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await apply_upgrades()
    if not settings.enable_scheduler:
        # Hosts that sleep when idle can't honour a cron clock; those
        # deployments drive runs with POST /api/engine/run instead.
        logger.info("Scheduler disabled (ENABLE_SCHEDULER=false) — trigger runs via /api/engine/run.")
        yield
        return

    scheduler.add_job(job_morning_brief, CronTrigger(
        hour=settings.morning_brief_hour, minute=settings.morning_brief_minute, day_of_week="mon-fri"))
    scheduler.add_job(job_midday_refresh, CronTrigger(
        hour=settings.midday_refresh_hour, minute=settings.midday_refresh_minute, day_of_week="mon-fri"))
    scheduler.add_job(job_eod_snapshot, CronTrigger(
        hour=settings.eod_snapshot_hour, minute=settings.eod_snapshot_minute, day_of_week="mon-fri"))
    if settings.news_poll_minutes > 0:
        scheduler.add_job(job_news_poll, IntervalTrigger(minutes=settings.news_poll_minutes),
                          max_instances=1, coalesce=True, misfire_grace_time=None,  # run once on wake
                          next_run_time=datetime.now(pytz.timezone(settings.timezone)))
    scheduler.start()
    logger.info("Scheduler started with %d jobs (IST).", len(scheduler.get_jobs()))
    yield
    scheduler.shutdown(wait=False)


app = FastAPI(
    title="StockSage India",
    version="0.2.0",
    description="Rule-governed Indian stock market intelligence. Personal research tool — not investment advice.",
    lifespan=lifespan,
)

# Allowed browser origins come from CORS_ORIGINS (comma-separated). Auth is a
# Bearer token in localStorage, not a cookie, so a wildcard origin stays usable.
_origins = settings.cors_origin_list
app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_origin_regex=None if "*" not in _origins else ".*",
    allow_credentials="*" not in _origins,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Auth endpoints are open; EVERYTHING else requires a valid session token.
app.include_router(auth_router)
_protected = [Depends(get_current_user)]
app.include_router(market_router, dependencies=_protected)
app.include_router(news_router, dependencies=_protected)
app.include_router(engine_router, dependencies=_protected)
app.include_router(backtest_router, dependencies=_protected)
app.include_router(multi_backtest_router, dependencies=_protected)
app.include_router(settings_router, dependencies=_protected)
app.include_router(execute_router, dependencies=_protected)
app.include_router(deepdive_router, dependencies=_protected)
app.include_router(insights_router, dependencies=_protected)
app.include_router(trades_router, dependencies=_protected)
app.include_router(options_router, dependencies=_protected)
app.include_router(research_router, dependencies=_protected)
# Prometheus scrape endpoint: aggregate counters only, optional METRICS_TOKEN.
app.include_router(metrics_router)

# ── Open health probes ───────────────────────────────────────────────────────
@app.get("/api/health")
async def health() -> dict:
    ist = pytz.timezone(settings.timezone)
    return {
        "status": "ok",
        "service": "stocksage-india",
        "time_ist": datetime.now(ist).isoformat(),
        "paper_trading": settings.paper_trading,
        "scheduler_enabled": settings.enable_scheduler,
        "scheduler_jobs": [str(j.trigger) for j in scheduler.get_jobs()] if scheduler.running else [],
    }


@app.get("/api/health/db")
async def health_db(db: AsyncSession = Depends(get_db)) -> dict:
    """Readiness probe. Deliberately reveals nothing about the schema or user
    counts, because it is reachable without a token."""
    tables = (await db.execute(text(
        "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public'"
    ))).scalar()
    return {"status": "ok", "table_count": tables}


@app.get("/api/health/gpu")
async def health_gpu() -> dict:
    try:
        import torch
        available = torch.cuda.is_available()
        return {
            "torch_installed": True,
            "cuda_available": available,
            "device": torch.cuda.get_device_name(0) if available else "cpu",
            "vram_gb": round(torch.cuda.get_device_properties(0).total_memory / 1e9, 1) if available else None,
        }
    except ImportError:
        return {"torch_installed": False, "hint": "Install with: pip install torch --index-url https://download.pytorch.org/whl/cu121"}


# ── Static frontend (single-container deployments) ───────────────────────────
# When the React bundle is built into ./static (see Dockerfile), the API also
# serves the SPA, so the whole app runs on one origin and needs no CORS setup.
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

if settings.serve_frontend and STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        """Serve real files as-is; send every other path to index.html so
        react-router can handle deep links like /portfolio on a hard refresh."""
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (STATIC_DIR / full_path).resolve()
        if full_path and candidate.is_file() and candidate.is_relative_to(STATIC_DIR.resolve()):
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")

    logger.info("Serving frontend bundle from %s", STATIC_DIR)
elif settings.serve_frontend:
    logger.warning("SERVE_FRONTEND=true but %s does not exist — API only.", STATIC_DIR)
