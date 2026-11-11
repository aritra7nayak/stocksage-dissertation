"""Market data API endpoints."""
import asyncio
from dataclasses import asdict

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import StockUniverse
from app.market_data import fetcher
from app.market_data.fundamentals import score_fundamentals
from app.market_data.indicators import compute_all
from app.market_data.snapshot import run_eod_snapshot

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/indices")
async def indices() -> dict:
    """Nifty 50 + Sensex, live (15-min delayed) or last close."""
    return await asyncio.to_thread(fetcher.get_indices)


@router.get("/nifty-status")
async def nifty_status() -> dict:
    """R11 guard input — did the Nifty fall? Includes guard basis (live vs prev close)."""
    return await asyncio.to_thread(fetcher.get_nifty_status)


@router.get("/gold-silver")
async def gold_silver() -> dict:
    """GOLDBEES and SILVERBEES quotes."""
    return await asyncio.to_thread(fetcher.get_gold_silver)


@router.get("/quote/{symbol}")
async def quote(symbol: str) -> dict:
    """Quote for any symbol (use .NS suffix, e.g. INFY.NS)."""
    try:
        return await asyncio.to_thread(fetcher.get_quote, symbol.upper())
    except Exception as exc:
        raise HTTPException(404, f"No data for {symbol}: {exc}") from exc


@router.get("/technicals/{symbol}")
async def technicals(symbol: str) -> dict:
    """All indicators + transparent 0–1 technical score with reasons."""
    try:
        df = await asyncio.to_thread(fetcher.get_history, symbol.upper(), "1y")
    except Exception as exc:
        raise HTTPException(404, f"No data for {symbol}: {exc}") from exc
    snap = compute_all(df, last_bar_partial=fetcher.is_market_open_ist())
    return {"symbol": symbol.upper(), **asdict(snap)}


@router.get("/fundamentals/{symbol}")
async def fundamentals(symbol: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Scored fundamentals (0–1) with per-metric reasons. ETFs return neutral."""
    sym = symbol.upper()
    row = (await db.execute(select(StockUniverse).where(StockUniverse.symbol == sym))).scalar_one_or_none()
    is_etf = bool(row and row.segment in ("GOLD_ETF", "SILVER_ETF"))
    snap = await asyncio.to_thread(score_fundamentals, sym, is_etf)
    return {"symbol": sym, **asdict(snap)}


@router.get("/universe")
async def universe(segment: str | None = None, db: AsyncSession = Depends(get_db)) -> dict:
    """The seeded stock universe, optionally filtered by segment."""
    q = select(StockUniverse).where(StockUniverse.is_active.is_(True))
    if segment:
        q = q.where(StockUniverse.segment == segment.upper())
    rows = (await db.execute(q.order_by(StockUniverse.segment, StockUniverse.symbol))).scalars().all()
    return {
        "count": len(rows),
        "stocks": [
            {"symbol": r.symbol, "name": r.company_name, "sector": r.sector, "segment": r.segment}
            for r in rows
        ],
    }


@router.post("/refresh-eod")
async def refresh_eod(db: AsyncSession = Depends(get_db)) -> dict:
    """Manually trigger the EOD snapshot (also runs automatically at 16:00 IST)."""
    return await run_eod_snapshot(db)
