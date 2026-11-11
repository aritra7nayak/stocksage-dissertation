"""Stock deep-dive — everything about one symbol on one screen (Tier 2 / C).

GET /api/deepdive/{symbol}  → price history (1y), all indicators, fundamentals,
                              composite score breakdown, related news, sector peers.

Reuses the existing market_data + sentiment modules; no new heavy computation.
"""
import asyncio
import logging
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import get_db
from app.db.models import NewsItem, StockUniverse
from app.engine import scoring
from app.market_data import fetcher
from app.market_data.fundamentals import score_fundamentals
from app.market_data.indicators import compute_all
from app.nlp.service import get_linker

logger = logging.getLogger("stocksage.deepdive")
settings = get_settings()
router = APIRouter(prefix="/api/deepdive", tags=["deepdive"])


# ── Search + sector drill-down (registered BEFORE /{symbol} so the
#    catch-all never swallows these paths) ─────────────────────────────────

@router.get("/search")
async def search_stocks(q: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Instant stock search over the universe (symbol or company name)."""
    term = (q or "").strip()
    if len(term) < 2:
        return {"results": []}
    like = f"%{term}%"
    rows = (await db.execute(
        select(StockUniverse)
        .where(StockUniverse.is_active.is_(True))
        .where((StockUniverse.symbol.ilike(like)) | (StockUniverse.company_name.ilike(like)))
        .limit(8))).scalars().all()
    return {"results": [{
        "symbol": r.symbol, "name": r.company_name,
        "sector": r.sector, "segment": r.segment,
    } for r in rows]}


@router.get("/sector/{sector}/stocks")
async def sector_stocks(sector: str, db: AsyncSession = Depends(get_db)) -> dict:
    """All stocks in one sector with latest price + day change (one batch fetch)."""
    rows = (await db.execute(
        select(StockUniverse)
        .where(StockUniverse.is_active.is_(True))
        .where(StockUniverse.sector == sector))).scalars().all()
    if not rows:
        raise HTTPException(404, f"No active stocks in sector '{sector}'")
    symbols = [r.symbol for r in rows]
    meta = {r.symbol: r for r in rows}

    prices = await asyncio.to_thread(fetcher.batch_history, symbols, "5d")
    out = []
    for sym in symbols:
        df = prices.get(sym)
        if df is None or len(df) < 1:
            continue
        closes = df["Close"]
        last = float(closes.iloc[-1])
        prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
        chg = round((last / prev - 1) * 100, 2) if prev else 0.0
        u = meta[sym]
        out.append({"symbol": sym, "name": u.company_name, "segment": u.segment,
                    "price": round(last, 2), "change_pct": chg})
    out.sort(key=lambda x: x["change_pct"], reverse=True)
    return {"sector": sector, "count": len(out), "stocks": out}


@router.get("/{symbol}")
async def deepdive(symbol: str, db: AsyncSession = Depends(get_db)) -> dict:
    sym = symbol.upper()
    if not sym.endswith(".NS"):
        sym = sym + ".NS"

    uni = (await db.execute(select(StockUniverse).where(StockUniverse.symbol == sym))).scalar_one_or_none()
    is_etf = bool(uni and uni.segment in ("GOLD_ETF", "SILVER_ETF"))

    try:
        df = await asyncio.to_thread(fetcher.get_history, sym, "1y")
    except Exception as exc:
        raise HTTPException(404, f"No price data for {sym}: {exc}")

    tech = compute_all(df, last_bar_partial=fetcher.is_market_open_ist())
    fund = await asyncio.to_thread(score_fundamentals, sym, is_etf)

    # Down-sampled price series with EMA overlays for charting
    closes = df["Close"]
    ema20 = closes.ewm(span=20, adjust=False).mean()
    ema50 = closes.ewm(span=50, adjust=False).mean()
    n = len(df)
    step = max(1, n // 180)
    price_series = []
    for i in range(0, n, step):
        price_series.append({
            "date": df.index[i].strftime("%Y-%m-%d"),
            "close": round(float(closes.iloc[i]), 2),
            "ema20": round(float(ema20.iloc[i]), 2),
            "ema50": round(float(ema50.iloc[i]), 2),
        })

    # Composite (technical 40 / fundamental 35 / sentiment 25 — sentiment from news below)
    name = uni.company_name if uni else sym.replace(".NS", "")
    linker = await get_linker(db)
    news_rows = (await db.execute(
        select(NewsItem).where(NewsItem.fetched_at.isnot(None))
        .order_by(desc(NewsItem.fetched_at)).limit(200))).scalars().all()
    related = [n for n in news_rows if sym in linker.symbols(n.headline)][:8]
    sent_vals = [float(n.sentiment_score or 0) for n in related]
    news_sent = round(sum(sent_vals) / len(sent_vals), 3) if sent_vals else 0.0
    sent_unit = scoring.sentiment_to_unit(news_sent)

    # Same weights and thresholds as the engine (one implementation, in scoring.py)
    composite = scoring.composite(tech.technical_score, fund.fundamental_score, sent_unit)
    rec = scoring.recommendation(composite)

    # Sector peers (same sector, by symbol)
    peers = []
    if uni:
        peer_rows = (await db.execute(
            select(StockUniverse).where(StockUniverse.sector == uni.sector)
            .where(StockUniverse.symbol != sym).where(StockUniverse.is_active.is_(True))
            .limit(8))).scalars().all()
        peers = [{"symbol": p.symbol, "name": p.company_name, "segment": p.segment} for p in peer_rows]

    # 52-week context + relative strength vs Nifty (20d)
    wk52_high = round(float(closes.max()), 2)
    wk52_low = round(float(closes.min()), 2)
    last = float(closes.iloc[-1])
    wk52_pos = round((last - wk52_low) / (wk52_high - wk52_low) * 100, 1) if wk52_high > wk52_low else 50.0
    rs_vs_nifty = None
    try:
        ndf = await asyncio.to_thread(fetcher.get_history, settings.nifty50_index, "3mo")
        if len(closes) > 21 and len(ndf) > 21:
            s20 = (last / float(closes.iloc[-21]) - 1) * 100
            n20 = (float(ndf["Close"].iloc[-1]) / float(ndf["Close"].iloc[-21]) - 1) * 100
            rs_vs_nifty = round(s20 - n20, 2)
    except Exception:
        pass
    next_earnings = None
    try:
        def _cal():
            import yfinance as yf
            c = yf.Ticker(sym).calendar
            if isinstance(c, dict):
                ed = c.get("Earnings Date")
                return ed[0] if isinstance(ed, (list, tuple)) and ed else ed
            return None
        ed = await asyncio.to_thread(_cal)
        if ed is not None and hasattr(ed, "year"):
            next_earnings = str(ed)
    except Exception:
        pass

    return {
        "symbol": sym,
        "name": name,
        "week52": {"high": wk52_high, "low": wk52_low, "position_pct": wk52_pos},
        "rs_vs_nifty_20d": rs_vs_nifty,
        "next_earnings": next_earnings,
        "sector": uni.sector if uni else None,
        "segment": uni.segment if uni else None,
        "is_etf": is_etf,
        "current_price": round(float(closes.iloc[-1]), 2),
        "price_series": price_series,
        "technical": asdict(tech),
        "fundamental": asdict(fund),
        "scores": {
            "technical": tech.technical_score,
            "fundamental": fund.fundamental_score,
            "sentiment": round(sent_unit, 3),
            "composite": composite,
        },
        "recommendation": rec,
        "news_sentiment": news_sent,
        "related_news": [{
            "headline": n.headline, "source": n.source, "url": n.url,
            "sentiment": n.sentiment, "sentiment_score": float(n.sentiment_score or 0),
            "severity": float(n.severity or 0),
        } for n in related],
        "peers": peers,
    }
