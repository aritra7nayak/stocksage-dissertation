"""Options desk API — call/put BUYING analysis for NSE indices and F&O stocks.

GET /api/options/underlyings          → analysable symbols with lot sizes
GET /api/options/analyze/{symbol}     → full analysis (?expiry=DD-Mon-YYYY)
GET /api/options/scan                 → ranked summary over indices + liquid stocks

All the scoring lives in analysis.py (pure); this module only gathers inputs:
the NSE chain (or a modeled fallback), price history, FinBERT headlines, the
R12 news guard, market context (Nifty trend, India VIX, relative strength)
and the next results date.
"""
import asyncio
import logging
import math
import time
from dataclasses import asdict
from datetime import datetime, timedelta

import pytz
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import AsyncSessionLocal, get_db
from app.db.models import NewsItem, StockUniverse
from app.market_data import fetcher
from app.market_data.indicators import compute_all
from app.nlp.service import get_linker
from app.options import analysis as A
from app.options import nse, pricing
from app.sentiment.pipeline import guard_status

logger = logging.getLogger("stocksage.options")
settings = get_settings()
IST = pytz.timezone(settings.timezone)
router = APIRouter(prefix="/api/options", tags=["options"])

SCAN_UNIVERSE = [
    "NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN",
    "AXISBANK", "KOTAKBANK", "LT", "BHARTIARTL", "ITC", "BAJFINANCE", "MARUTI",
    "HINDUNILVR", "SUNPHARMA", "TATASTEEL", "M&M", "ADANIENT",
]
_RESULT_TTL = 90
_results: dict[str, tuple[float, dict]] = {}
_earnings: dict[str, tuple[float, str | None]] = {}


def _yf_symbol(symbol: str) -> str:
    return nse.INDICES[symbol]["yf"] if symbol in nse.INDICES else f"{symbol}.NS"


@router.get("/underlyings")
async def underlyings() -> dict:
    lots = await asyncio.to_thread(nse.lot_sizes)
    idx = [{"symbol": s, "name": v["name"], "lot": lots.get(s, {}).get("lot", v["lot"]), "kind": "INDEX"}
           for s, v in nse.INDICES.items()]
    stocks = sorted(({"symbol": s, "name": v["name"], "lot": v["lot"], "kind": "STOCK"}
                     for s, v in lots.items() if s not in nse.INDICES and not s.startswith("NIFTY")
                     and s not in ("BANKNIFTY", "FINNIFTY", "MIDCPNIFTY")),
                    key=lambda x: x["symbol"])
    return {"indices": idx, "stocks": stocks, "scan_universe": SCAN_UNIVERSE}


# ── Input gathering ──────────────────────────────────────────────────────────

async def _sentiment(db: AsyncSession, symbol: str, name: str, sector: str | None) -> dict:
    since = datetime.now(pytz.utc) - timedelta(hours=72)
    rows = (await db.execute(
        select(NewsItem).where(NewsItem.fetched_at >= since)
        .order_by(desc(NewsItem.fetched_at)).limit(400))).scalars().all()

    if symbol == "NIFTY":
        rel = rows
    elif symbol in nse.INDICES:
        sec = nse.INDICES[symbol]["sector"]
        rel = [n for n in rows if sec in (n.related_sectors or []) or " bank" in f" {n.headline.lower()}"]
    else:
        # Linked by the entity linker; F&O names outside the stock universe
        # fall back to the bare ticker as a whole word.
        linker, target, sym = await get_linker(db), f"{symbol}.NS", symbol.lower()
        rel = [n for n in rows if target in linker.symbols(n.headline)
               or f" {sym} " in f" {n.headline.lower()} "]

    scores = [float(n.sentiment_score or 0) for n in rel]
    guard = await guard_status(db)
    blocked = guard.get("blocked_sectors") or []
    return {
        "count": len(rel),
        "avg": round(sum(scores) / len(scores), 3) if scores else 0.0,
        "positive": sum(1 for n in rel if n.sentiment == "POSITIVE"),
        "negative": sum(1 for n in rel if n.sentiment == "NEGATIVE"),
        "neutral": sum(1 for n in rel if n.sentiment not in ("POSITIVE", "NEGATIVE")),
        "market_avg": guard.get("avg_sentiment") or 0.0,
        "market_overall": guard.get("overall"),
        "market_stopped": bool(guard.get("market_stopped")),
        "sector_blocked": bool(sector and sector in blocked),
        "guard_verdict": guard.get("verdict"),
        "headlines": [{
            "headline": n.headline, "source": n.source, "url": n.url, "sentiment": n.sentiment,
            "score": float(n.sentiment_score or 0), "severity": float(n.severity or 0),
            "published_at": n.published_at.isoformat() if n.published_at else None,
        } for n in rel[:12]],
    }


def _context(symbol: str, close) -> dict:
    """Market-context factors (15% of direction) + raw readings for the UI."""
    out: dict = {"factors": [], "vix": None, "vix_change_5d": None, "rs_vs_nifty_20d": None,
                 "nifty_trend": None}
    price = float(close.iloc[-1])

    if symbol == "NIFTY":
        sma200 = float(close.rolling(200).mean().iloc[-1]) if len(close) >= 200 else None
        if sma200:
            gap = price / sma200 - 1
            out["factors"].append({"key": "lt_trend", "label": "Long-term trend (200-DMA)",
                                   "value": A._clamp(gap / 0.05), "weight": 0.08,
                                   "detail": f"Nifty {gap * 100:+.1f}% vs its 200-day average"})
    else:
        ndf = fetcher.get_history(settings.nifty50_index, "1y")
        nt = compute_all(ndf)
        npx = float(ndf["Close"].iloc[-1])
        if npx > nt.ema_20 > nt.ema_50:
            v, d = 0.7, "Nifty in a clean uptrend — tailwind for calls"
        elif nt.ema_20 > nt.ema_50:
            v, d = 0.3, "Nifty uptrend, currently pulling back"
        elif npx > nt.ema_20:
            v, d = -0.2, "Nifty bouncing inside a downtrend"
        else:
            v, d = -0.7, "Nifty in a downtrend — tailwind for puts"
        out["nifty_trend"] = d
        out["factors"].append({"key": "nifty_trend", "label": "Broad market (Nifty trend)",
                               "value": v, "weight": 0.08, "detail": d})
        if symbol not in nse.INDICES and len(close) > 21 and len(ndf) > 21:
            rs = (price / float(close.iloc[-21]) - npx / float(ndf["Close"].iloc[-21])) * 100
            out["rs_vs_nifty_20d"] = round(rs, 2)
            out["factors"].append({"key": "rel_strength", "label": "Relative strength vs Nifty (20d)",
                                   "value": A._clamp(rs / 6), "weight": 0.07,
                                   "detail": f"{rs:+.1f}% vs Nifty over 20 sessions — "
                                             + ("leader" if rs > 0 else "laggard")})

    if symbol in nse.INDICES:
        try:
            vdf = fetcher.get_history("^INDIAVIX", "3mo")
            vix = float(vdf["Close"].iloc[-1])
            chg = (vix / float(vdf["Close"].iloc[-6]) - 1) * 100 if len(vdf) > 6 else 0.0
            out["vix"], out["vix_change_5d"] = round(vix, 2), round(chg, 1)
            v = -0.7 if chg > 10 else -0.35 if chg > 5 else 0.5 if chg < -10 else 0.25 if chg < -5 else 0.0
            if vix > 22:
                v -= 0.3
            out["factors"].append({"key": "vix", "label": "India VIX (fear gauge)", "value": A._clamp(v),
                                   "weight": 0.07,
                                   "detail": f"VIX {vix:.1f}, {chg:+.1f}% over 5 sessions — "
                                             + ("fear rising" if chg > 5 else "fear easing" if chg < -5 else "stable")})
        except Exception:
            logger.warning("India VIX unavailable")
    return out


def _next_results(symbol: str) -> str | None:
    hit = _earnings.get(symbol)
    if hit and hit[0] > time.time():
        return hit[1]
    val = None
    try:
        import yfinance as yf
        cal = yf.Ticker(f"{symbol}.NS").calendar
        if isinstance(cal, dict):
            ed = cal.get("Earnings Date")
            ed = ed[0] if isinstance(ed, (list, tuple)) and ed else ed
            if ed is not None and hasattr(ed, "year"):
                val = str(ed)[:10]
    except Exception:
        pass
    _earnings[symbol] = (time.time() + 12 * 3600, val)
    return val


def _pick_expiry(symbol: str, exps: list, now: datetime):
    """Default: the nearest expiry with enough life left for a buyer."""
    min_days = 2 if symbol in nse.INDICES else 5
    for e in exps:
        if A.time_to_expiry(e, now, IST)[1] >= min_days:
            return e
    return exps[0]


# ── Core analysis ────────────────────────────────────────────────────────────

async def analyze_symbol(symbol: str, expiry: str | None, db: AsyncSession) -> dict:
    symbol = symbol.upper().removesuffix(".NS")
    lots = await asyncio.to_thread(nse.lot_sizes)
    if symbol not in lots and symbol not in nse.INDICES:
        raise HTTPException(404, f"{symbol} is not an NSE F&O underlying")
    cache_key = f"{symbol}:{expiry or 'auto'}"
    hit = _results.get(cache_key)
    if hit and hit[0] > time.time():
        return hit[1]

    is_index = symbol in nse.INDICES
    lot = lots.get(symbol, {}).get("lot") or nse.INDICES.get(symbol, {}).get("lot") or 1
    uni = None
    if not is_index:
        uni = (await db.execute(select(StockUniverse).where(StockUniverse.symbol == f"{symbol}.NS"))).scalar_one_or_none()
    name = (nse.INDICES[symbol]["name"] if is_index
            else (uni.company_name if uni and uni.company_name else lots[symbol]["name"]))
    sector = nse.INDICES[symbol]["sector"] if is_index else (uni.sector if uni else None)

    try:
        df = await asyncio.to_thread(fetcher.get_history, _yf_symbol(symbol), "1y")
    except Exception as exc:
        raise HTTPException(502, f"No price history for {symbol}: {exc}")
    if len(df) < 60:
        raise HTTPException(422, f"Only {len(df)} days of history for {symbol} — need 60+")
    close = df["Close"]
    now = datetime.now(IST)
    warnings: list[str] = []

    # Expiries + chain: live NSE first, modeled fallback second
    live_exp = True
    try:
        exps = await asyncio.to_thread(nse.expiries, symbol)
    except nse.NSEUnavailable as exc:
        live_exp = False
        exps = nse.modeled_expiries(symbol)
        warnings.append(f"NSE expiries unavailable ({exc}); using calendar-rule expiries.")
    chosen = None
    if expiry:
        try:
            chosen = nse.parse_expiry(expiry)
        except ValueError:
            raise HTTPException(400, "expiry must look like 13-Oct-2026")
        if chosen not in exps:
            raise HTTPException(400, f"{expiry} is not a listed expiry for {symbol}")
    chosen = chosen or _pick_expiry(symbol, exps, now)
    T, days = A.time_to_expiry(chosen, now, IST)

    hv20 = A.realised_vol(close, 20)
    hv60 = A.realised_vol(close, 60)
    try:
        if not live_exp:
            raise nse.NSEUnavailable("expiries were modeled")
        ch = await asyncio.to_thread(nse.chain, symbol, chosen)
    except nse.NSEUnavailable as exc:
        sigma = max(0.08, (hv20 if not math.isnan(hv20) else 0.2) * 1.1)
        ch = nse.modeled_chain(symbol, float(close.iloc[-1]), sigma, T)
        warnings.append(f"Live option chain unavailable ({exc}). Prices are MODELED from realised "
                        "volatility — no open interest, no real bid/ask. Verify in your broker.")
    source = ch["source"]
    spot, rows = ch["spot"], ch["rows"]
    has_oi = source == "NSE" and sum(((r.get("ce") or {}).get("oi", 0) + (r.get("pe") or {}).get("oi", 0))
                                     for r in rows) > 0
    has_quotes = source == "NSE"

    tech = compute_all(df, last_bar_partial=fetcher.is_market_open_ist())
    q, forward = A.implied_carry(rows, spot, T) if has_quotes else (0.0, spot * math.exp(pricing.RISK_FREE * T))
    metrics = A.chain_metrics(rows, spot, T, has_oi, q)
    sentiment = await _sentiment(db, symbol, name, sector)
    context = await asyncio.to_thread(_context, symbol, close)
    event = None
    if not is_index:
        ed = await asyncio.to_thread(_next_results, symbol)
        if ed and now.date().isoformat() <= ed <= chosen.isoformat():
            event = ed

    # Liquidity at the money (suitability input)
    atm_row = next(r for r in rows if r["strike"] == metrics["atm_strike"])
    spreads = []
    for leg in (atm_row.get("ce"), atm_row.get("pe")):
        if has_quotes and leg and leg["bid"] > 0 and leg["ask"] > 0:
            spreads.append((leg["ask"] - leg["bid"]) / ((leg["ask"] + leg["bid"]) / 2) * 100)
    liquidity = {"spread_pct": round(sum(spreads) / len(spreads), 2) if spreads else None}

    d_factors = A.direction_factors(tech=tech, close=close, metrics=metrics, spot=spot, days=days,
                                    sentiment=sentiment, context=context)
    s_factors = A.suitability_factors(tech=tech, metrics=metrics, hv20=hv20, days=days,
                                      liquidity=liquidity, event=event, vix=context.get("vix"))
    direction = round(A.weighted(d_factors) * 100, 1)
    suitability = round(A.weighted(s_factors) * 100, 1)
    v = A.verdict(direction, suitability)
    conf = A.confluence(d_factors, 1 if direction >= 0 else -1)

    # Planning vol: ATM IV re-solved from live mids on our own clock (NSE's
    # quoted IV is stamped at its snapshot time); fall back to quoted, then HV.
    solved = []
    for kind, leg in (("CE", atm_row.get("ce")), ("PE", atm_row.get("pe"))):
        if has_quotes and leg and leg["bid"] > 0 and leg["ask"] > 0:
            iv = pricing.implied_vol((leg["bid"] + leg["ask"]) / 2, spot, atm_row["strike"], T, kind, q=q)
            if iv:
                solved.append(iv)
    sigma = (sum(solved) / len(solved) if solved else None) \
        or (metrics["atm_iv"] or 0) / 100 or (hv20 if not math.isnan(hv20) else 0.2)
    sides = {}
    for side in ("CE", "PE"):
        plan, strikes = A.rank_strikes(side=side, rows=rows, spot=spot, T=T, days=days, lot=lot,
                                       metrics=metrics, direction=direction, sigma=sigma,
                                       has_quotes=has_quotes, q=q)
        sides[side] = {"plan": plan, "strikes": strikes}
    best = (sides[v["side"]]["strikes"] or [None])[0]
    story = A.narrative(d_factors, v["side"], sides[v["side"]]["plan"], best, symbol)
    checks = A.checklist(direction=direction, conf=conf, metrics=metrics, hv20=hv20, days=days,
                         best=best, event=event,
                         guard_clear=not (sentiment["market_stopped"] or sentiment["sector_blocked"]))

    # Chain table: 12 strikes either side of ATM, with deltas
    atm_i = next(i for i, r in enumerate(rows) if r["strike"] == metrics["atm_strike"])
    table = []
    for r in rows[max(0, atm_i - 12): atm_i + 13]:
        row = {"strike": r["strike"]}
        for k, kind in (("ce", "CE"), ("pe", "PE")):
            leg = r.get(k)
            if leg:
                iv = leg.get("iv") or sigma
                row[k] = {**leg, "iv": round(iv * 100, 2),
                          "delta": round(pricing.greeks(spot, r["strike"], T, iv, kind, q=q)["delta"], 3)}
            else:
                row[k] = None
        table.append(row)

    n = len(df)
    ema20 = close.ewm(span=20, adjust=False).mean()
    ema50 = close.ewm(span=50, adjust=False).mean()
    price_series = [{"date": df.index[i].strftime("%Y-%m-%d"), "close": round(float(close.iloc[i]), 2),
                     "ema20": round(float(ema20.iloc[i]), 2), "ema50": round(float(ema50.iloc[i]), 2)}
                    for i in range(max(0, n - 120), n)]

    result = {
        "symbol": symbol, "name": name, "kind": "INDEX" if is_index else "STOCK", "sector": sector,
        "lot_size": lot, "spot": round(spot, 2),
        "change_pct": round((float(close.iloc[-1]) / float(close.iloc[-2]) - 1) * 100, 2),
        "source": source, "data_timestamp": ch["timestamp"], "market_open": fetcher.is_market_open_ist(),
        "generated_at": now.isoformat(), "warnings": warnings,
        "expiry": nse.fmt_expiry(chosen), "expiries": [nse.fmt_expiry(e) for e in exps[:8]],
        "days_to_expiry": round(days, 2), "years_to_expiry": T, "risk_free": pricing.RISK_FREE,
        "carry_q": round(q, 5), "forward": round(forward, 2),
        "verdict": {**v, "direction": direction, "suitability": suitability, "confluence": conf},
        "direction_factors": d_factors, "suitability_factors": s_factors,
        "volatility": {"atm_iv": metrics["atm_iv"], "hv20": A._r(hv20 * 100), "hv60": A._r(hv60 * 100),
                       "iv_hv_ratio": A._r((metrics["atm_iv"] or 0) / 100 / hv20 if metrics["atm_iv"] and hv20 else None),
                       "hv_percentile": A.hv_percentile(close), "vix": context.get("vix"),
                       "vix_change_5d": context.get("vix_change_5d"), "model_sigma": round(sigma * 100, 2)},
        "chain_metrics": metrics, "chain": table,
        "sides": sides, "recommended": best, "narrative": story, "checklist": checks,
        "sentiment": sentiment,
        "context": {k: context[k] for k in ("rs_vs_nifty_20d", "nifty_trend")},
        "event": event,
        "technical": {k: val for k, val in asdict(tech).items()},
        "price_series": price_series,
    }
    _results[cache_key] = (time.time() + _RESULT_TTL, result)
    _results[f"{symbol}:{result['expiry']}"] = (time.time() + _RESULT_TTL, result)
    return result


@router.get("/analyze/{symbol}")
async def analyze(symbol: str, expiry: str | None = None, db: AsyncSession = Depends(get_db)) -> dict:
    return await analyze_symbol(symbol, expiry, db)


@router.get("/scan")
async def scan() -> dict:
    """Default-expiry analysis for the scan universe, ranked by trade score."""
    lots = await asyncio.to_thread(nse.lot_sizes)
    syms = [s for s in SCAN_UNIVERSE if s in lots or s in nse.INDICES]
    await asyncio.to_thread(fetcher.batch_history, [_yf_symbol(s) for s in syms], "1y")
    sem = asyncio.Semaphore(3)

    async def one(sym: str) -> dict:
        async with sem:
            try:
                async with AsyncSessionLocal() as s:
                    r = await analyze_symbol(sym, None, s)
            except Exception as exc:
                logger.warning("Scan failed for %s: %s", sym, exc)
                detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
                return {"symbol": sym, "error": str(detail)[:160]}
        b = r["recommended"]
        return {
            "symbol": sym, "name": r["name"], "kind": r["kind"], "spot": r["spot"],
            "change_pct": r["change_pct"], "expiry": r["expiry"], "days_to_expiry": r["days_to_expiry"],
            "source": r["source"], "verdict": r["verdict"], "atm_iv": r["volatility"]["atm_iv"],
            "iv_hv_ratio": r["volatility"]["iv_hv_ratio"], "pcr": r["chain_metrics"]["pcr_oi"],
            "news_count": r["sentiment"]["count"], "news_avg": r["sentiment"]["avg"],
            "best": b and {"strike": b["strike"], "side": b["side"], "entry": b["entry"],
                           "lot_cost": b["lot_cost"], "delta": b["delta"],
                           "ev_signal": b["sim"]["signal"]["ev_pct"], "ev_neutral": b["sim"]["neutral"]["ev_pct"],
                           "p_profit": b["sim"]["signal"]["p_profit"], "ret_t1_pct": b["ret_t1_pct"]},
        }

    rows = await asyncio.gather(*(one(s) for s in syms))
    ok = sorted((r for r in rows if "error" not in r),
                key=lambda r: (r["verdict"]["action"] in ("NO_TRADE", "WAIT"), -r["verdict"]["trade_score"]))
    return {"generated_at": datetime.now(IST).isoformat(), "results": ok,
            "errors": [r for r in rows if "error" in r]}
