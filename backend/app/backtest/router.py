"""Backtest API + paper-trading execution.

POST /api/backtest/run            — run the simulator over real history
GET  /api/backtest/runs           — past runs with metrics
GET  /api/backtest/runs/{id}      — one run incl. trades + equity curve
POST /api/portfolio/execute/{id}  — 'Mark as Done': execute a logged suggestion
DELETE /api/portfolio/holdings/{id}
"""
import asyncio
from datetime import date, datetime, timedelta
from typing import Literal

import pytz
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.backtest.simulator import BacktestSimulator
from app.config import get_settings
from app.auth_router import CurrentUser, get_current_user
from app.db.database import get_db
from app.db.models import (
    BacktestRun, BacktestTrade, Holding, Portfolio, StockUniverse, SuggestionLog, Transaction,
)
from app.market_data import fetcher

settings = get_settings()
router = APIRouter(prefix="/api", tags=["backtest"])


class BacktestIn(BaseModel):
    name: str = "Rule-engine backtest"
    start_date: date | None = None          # default: 1 year ago
    end_date: date | None = None            # default: today
    initial_capital: float = Field(default=100_000, gt=10_000)
    # "next_open" fills each decision at the following session's open
    fill: Literal["close", "next_open"] = "close"


@router.post("/backtest/run")
async def backtest_run(body: BacktestIn, db: AsyncSession = Depends(get_db)) -> dict:
    """Replay the full rule engine over history. Takes ~1–3 min (data download + sim)."""
    end = body.end_date or datetime.now(pytz.timezone(settings.timezone)).date()
    start = body.start_date or (end - timedelta(days=365))

    uni = (await db.execute(select(StockUniverse)
                            .where(StockUniverse.is_active.is_(True)))).scalars().all()
    symbols = [u.symbol for u in uni]
    meta = {u.symbol: (u.segment, u.sector or "Services") for u in uni}

    # ~1.6y of data so indicators are warm at `start`
    period = "2y"
    prices = await asyncio.to_thread(fetcher.batch_history, symbols, period)
    nifty = await asyncio.to_thread(fetcher.get_history, settings.nifty50_index, period)

    sim = BacktestSimulator(prices, meta, nifty, settings, fill=body.fill)
    result = await asyncio.to_thread(sim.run, start, end, body.initial_capital)

    run = BacktestRun(
        name=body.name, start_date=start, end_date=end,
        initial_capital=body.initial_capital, final_value=result.final_value,
        total_return_pct=result.total_return_pct, nifty_return_pct=result.nifty_return_pct,
        max_drawdown_pct=result.max_drawdown_pct, win_rate=result.win_rate,
        total_trades=result.total_trades, status="DONE",
        completed_at=datetime.utcnow(),
        rule_config={
            "stop_loss_pct": settings.stop_loss_pct,
            "trailing": [settings.trailing_profit_trigger, settings.trailing_profit_giveback],
            "deterioration": [settings.deterioration_score, settings.deterioration_days],
            "notes": result.notes,
            "fill": result.fill_mode,
            "metrics": result.metrics,
            "nifty_metrics": result.nifty_metrics,
            "equity_curve": result.equity_curve[::max(1, len(result.equity_curve) // 250)],
        })
    db.add(run)
    await db.flush()
    for t in result.trades:
        db.add(BacktestTrade(run_id=run.id, symbol=t.symbol, action=t.action,
                             trade_date=t.trade_date, quantity=t.quantity,
                             price=t.price, pnl=t.pnl,
                             triggered_rule=t.triggered_rule, reason=t.reason))
    return {
        "run_id": run.id, "name": body.name,
        "period": f"{start} → {end}",
        "strategy_return_pct": result.total_return_pct,
        "nifty_buyhold_return_pct": result.nifty_return_pct,
        "alpha_pct": round(result.total_return_pct - result.nifty_return_pct, 3),
        "max_drawdown_pct": result.max_drawdown_pct,
        "win_rate": result.win_rate,
        "total_trades": result.total_trades,
        "open_positions_at_end": result.open_positions,
        "final_value": result.final_value,
        "fill": result.fill_mode,
        "metrics": result.metrics,
        "nifty_metrics": result.nifty_metrics,
        "notes": result.notes,
    }


@router.get("/backtest/runs")
async def backtest_runs(db: AsyncSession = Depends(get_db)) -> dict:
    rows = (await db.execute(select(BacktestRun)
                             .order_by(desc(BacktestRun.created_at)).limit(20))).scalars().all()
    return {"runs": [{
        "id": r.id, "name": r.name, "period": f"{r.start_date} → {r.end_date}",
        "return_pct": float(r.total_return_pct or 0),
        "nifty_pct": float(r.nifty_return_pct or 0),
        "max_dd_pct": float(r.max_drawdown_pct or 0),
        "win_rate": float(r.win_rate or 0), "trades": r.total_trades,
    } for r in rows]}


@router.get("/backtest/runs/{run_id}")
async def backtest_detail(run_id: int, db: AsyncSession = Depends(get_db)) -> dict:
    run = (await db.execute(select(BacktestRun)
                            .where(BacktestRun.id == run_id))).scalar_one_or_none()
    if not run:
        raise HTTPException(404, "Run not found")
    trades = (await db.execute(select(BacktestTrade)
                               .where(BacktestTrade.run_id == run_id)
                               .order_by(BacktestTrade.trade_date))).scalars().all()
    return {
        "id": run.id, "name": run.name,
        "metrics": {"return_pct": float(run.total_return_pct or 0),
                    "nifty_pct": float(run.nifty_return_pct or 0),
                    "max_dd_pct": float(run.max_drawdown_pct or 0),
                    "win_rate": float(run.win_rate or 0)},
        "rule_config": run.rule_config,
        "trades": [{"date": str(t.trade_date), "symbol": t.symbol, "action": t.action,
                    "qty": t.quantity, "price": float(t.price or 0),
                    "pnl": float(t.pnl) if t.pnl is not None else None,
                    "rule": t.triggered_rule, "reason": t.reason} for t in trades],
    }


# ── Paper-trading execution ──────────────────────────────────────────────────

@router.post("/portfolio/execute/{suggestion_id}")
async def execute_suggestion(suggestion_id: int, db: AsyncSession = Depends(get_db),
                             user: CurrentUser = Depends(get_current_user)) -> dict:
    """'Mark as Done' — execute a logged BUY/SELL suggestion in the paper portfolio."""
    sug = (await db.execute(select(SuggestionLog)
                            .where(SuggestionLog.id == suggestion_id))).scalar_one_or_none()
    if not sug:
        raise HTTPException(404, "Suggestion not found")
    if sug.was_acted_on:
        raise HTTPException(409, f"Suggestion {suggestion_id} was already executed")
    if sug.action not in ("BUY", "SELL"):
        raise HTTPException(400, f"Cannot execute a {sug.action} suggestion")

    pf = (await db.execute(select(Portfolio)
                           .where(Portfolio.user_id == user.id).limit(1))).scalar_one_or_none()
    if not pf:
        raise HTTPException(404, "No portfolio found for this user")
    if sug.portfolio_id is not None and sug.portfolio_id != pf.id:
        raise HTTPException(403, "That suggestion belongs to a different user")
    holding = (await db.execute(select(Holding)
                                .where(Holding.portfolio_id == pf.id)
                                .where(Holding.symbol == sug.symbol))).scalar_one_or_none()

    if sug.action == "BUY":
        qty, price = sug.suggested_quantity or 0, float(sug.suggested_price or 0)
        total = float(sug.total_value or qty * price)
        if total <= 0 or qty <= 0:
            raise HTTPException(400, "Suggestion has no quantity/price")
        if total > float(pf.cash_balance):
            raise HTTPException(400, f"Insufficient cash: need ₹{total:,.0f}, "
                                     f"have ₹{float(pf.cash_balance):,.0f}")
        if holding:
            new_qty = holding.quantity + qty
            holding.avg_buy_price = round((float(holding.avg_buy_price) * holding.quantity
                                           + total) / new_qty, 2)
            holding.quantity = new_qty
        else:
            db.add(Holding(portfolio_id=pf.id, symbol=sug.symbol, quantity=qty,
                           avg_buy_price=price, current_price=price, peak_price=price,
                           segment=sug.segment, sector=sug.sector))
        pf.cash_balance = round(float(pf.cash_balance) - total, 2)
        verb = "BOUGHT"
    else:  # SELL — close the whole position at current market
        if not holding:
            raise HTTPException(400, f"No holding in {sug.symbol} to sell")
        try:
            price = (await asyncio.to_thread(fetcher.get_quote, sug.symbol))["price"]
        except Exception:
            price = float(holding.current_price or holding.avg_buy_price)
        qty = holding.quantity
        total = round(qty * price, 2)
        pf.cash_balance = round(float(pf.cash_balance) + total, 2)
        await db.delete(holding)
        verb = "SOLD"

    db.add(Transaction(portfolio_id=pf.id, symbol=sug.symbol, action=sug.action,
                       quantity=qty, price=price, total_value=total,
                       is_paper=pf.is_paper, suggestion_id=sug.id,
                       reason=f"Executed suggestion #{sug.id}"))
    sug.was_acted_on = True
    return {"status": f"{verb} {qty} × {sug.symbol} @ ₹{price:,.2f} = ₹{total:,.2f}",
            "paper": pf.is_paper, "cash_after": float(pf.cash_balance)}


@router.delete("/portfolio/holdings/{holding_id}")
async def delete_holding(holding_id: int, db: AsyncSession = Depends(get_db),
                         user: CurrentUser = Depends(get_current_user)) -> dict:
    h = (await db.execute(select(Holding)
                          .join(Portfolio, Portfolio.id == Holding.portfolio_id)
                          .where(Holding.id == holding_id)
                          .where(Portfolio.user_id == user.id))).scalar_one_or_none()
    if not h:
        raise HTTPException(404, "Holding not found")
    await db.delete(h)
    return {"deleted": h.symbol}
