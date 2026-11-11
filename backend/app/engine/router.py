"""Engine API: daily brief, suggestions, sector health — plus minimal portfolio endpoints.

Multi-user: the brief, suggestions and portfolio endpoints all resolve the
signed-in user's own portfolio. Market-wide data (sector health, per-symbol
analysis) is shared. Auth is enforced globally in main.py; endpoints that
need the identity take it via get_current_user.
"""
import asyncio
from datetime import date, datetime

import pytz
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth_router import CurrentUser, get_current_user
from app.config import get_settings
from app.db.database import get_db
from app.db.models import Holding, Portfolio, SectorHealth, StockAnalysis, SuggestionLog
from app.engine.daily_run import get_cached_brief, run_daily_engine

settings = get_settings()
router = APIRouter(prefix="/api", tags=["engine"])
# One cold-cache engine run per user; concurrent requests wait and reuse it.
_brief_locks: dict[int, asyncio.Lock] = {}


def _today() -> date:
    return datetime.now(pytz.timezone(settings.timezone)).date()


async def _user_pf(db: AsyncSession, user_id: int) -> Portfolio:
    pf = (await db.execute(select(Portfolio)
                           .where(Portfolio.user_id == user_id).limit(1))).scalar_one_or_none()
    if not pf:
        raise HTTPException(404, "No portfolio found for this user")
    return pf


@router.get("/daily-brief")
async def daily_brief(user: CurrentUser = Depends(get_current_user)) -> dict:
    """The Morning Intelligence Brief for YOUR portfolio. Cached per user per
    day; runs the full engine (1–4 min on a cold cache) if none exists yet."""
    cached = get_cached_brief(user.id)
    if cached:
        return cached
    async with _brief_locks.setdefault(user.id, asyncio.Lock()):
        cached = get_cached_brief(user.id)
        if cached:
            return cached
        return await run_daily_engine(run_type="MANUAL", user_id=user.id)


@router.post("/engine/run")
async def engine_run(user: CurrentUser = Depends(get_current_user)) -> dict:
    """Force a fresh full engine run for YOUR portfolio right now."""
    return await run_daily_engine(run_type="MANUAL", user_id=user.id)


@router.get("/suggestions/today")
async def suggestions_today(db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(get_current_user)) -> dict:
    """Everything the engine logged today for YOUR portfolio."""
    pf = await _user_pf(db, user.id)
    rows = (await db.execute(
        select(SuggestionLog).where(SuggestionLog.suggestion_date == _today())
        .where(SuggestionLog.portfolio_id == pf.id)
        .order_by(desc(SuggestionLog.created_at)))).scalars().all()
    return {"date": str(_today()), "count": len(rows), "suggestions": [{
        "id": r.id, "symbol": r.symbol, "action": r.action, "segment": r.segment,
        "sector": r.sector, "quantity": r.suggested_quantity,
        "price": float(r.suggested_price or 0), "total_value": float(r.total_value or 0),
        "score": float(r.composite_score or 0), "confidence": r.confidence,
        "reasoning": r.reasoning, "rules_failed": r.rules_failed,
        "was_acted_on": r.was_acted_on,
    } for r in rows]}


@router.get("/sector-health")
async def sector_health(db: AsyncSession = Depends(get_db)) -> dict:
    """Latest stored sector health rows (market-wide, shared)."""
    latest = (await db.execute(
        select(SectorHealth).order_by(desc(SectorHealth.health_date), SectorHealth.sector)
        .limit(len(settings.tracked_sectors)))).scalars().all()
    return {"sectors": [{
        "sector": r.sector, "date": str(r.health_date), "score": float(r.score or 0),
        "status": r.status, "change_pct": float(r.change_pct or 0),
        "avg_rsi": float(r.avg_rsi or 0), "news_score": float(r.news_score or 0),
        "top_gainer": r.top_gainer, "is_blocked": r.is_blocked,
    } for r in latest]}


@router.get("/analysis/{symbol}")
async def analysis(symbol: str, db: AsyncSession = Depends(get_db)) -> dict:
    """Latest stored full analysis for one symbol (market-wide, shared)."""
    row = (await db.execute(
        select(StockAnalysis).where(StockAnalysis.symbol == symbol.upper())
        .order_by(desc(StockAnalysis.analysis_date)).limit(1))).scalar_one_or_none()
    if not row:
        raise HTTPException(404, f"No analysis stored for {symbol} — run the engine first")
    return {c.name: (float(v) if hasattr(v, "__float__") and not isinstance(v, (bool, date)) else
                     str(v) if isinstance(v, date) else v)
            for c in row.__table__.columns if (v := getattr(row, c.name)) is not None}


# ── Minimal portfolio endpoints ──────────────────────────────────────────────

class HoldingIn(BaseModel):
    symbol: str = Field(examples=["INFY.NS"])
    quantity: int = Field(gt=0)
    avg_buy_price: float = Field(gt=0)
    segment: str = Field(default="NIFTY50")
    sector: str = Field(default="Services")
    company_name: str | None = None


@router.post("/portfolio/holdings")
async def add_holding(body: HoldingIn, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)) -> dict:
    """Register an existing holding into YOUR portfolio."""
    pf = await _user_pf(db, user.id)
    h = Holding(portfolio_id=pf.id, symbol=body.symbol.upper(), quantity=body.quantity,
                avg_buy_price=body.avg_buy_price, peak_price=body.avg_buy_price,
                segment=body.segment.upper(), sector=body.sector,
                company_name=body.company_name)
    db.add(h)
    await db.flush()
    return {"id": h.id, "symbol": h.symbol, "status": "added"}


@router.get("/portfolio/summary")
async def portfolio_summary(db: AsyncSession = Depends(get_db),
                            user: CurrentUser = Depends(get_current_user)) -> dict:
    """YOUR capital, holdings and P&L at a glance."""
    pf = await _user_pf(db, user.id)
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all()
    out, mkt = [], 0.0
    for h in holdings:
        price = float(h.current_price or h.avg_buy_price)
        value = price * h.quantity
        cost = float(h.avg_buy_price) * h.quantity
        mkt += value
        out.append({"id": h.id, "symbol": h.symbol, "name": h.company_name, "qty": h.quantity,
                    "avg_buy": float(h.avg_buy_price), "current": price,
                    "value": round(value, 2), "pnl": round(value - cost, 2),
                    "pnl_pct": round((value / cost - 1) * 100, 2) if cost else 0,
                    "segment": h.segment, "sector": h.sector,
                    "low_score_streak": h.low_score_streak})
    return {"name": pf.name, "is_paper": pf.is_paper,
            "total_capital": float(pf.total_capital), "cash": float(pf.cash_balance),
            "holdings_value": round(mkt, 2), "holdings": out}
