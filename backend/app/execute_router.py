"""Paper-trading execution — turn suggestions into portfolio positions.

POST /api/execute/buy/{suggestion_id}   — execute a logged BUY suggestion
POST /api/execute/sell/{holding_id}     — sell a holding at current price
POST /api/execute/buy-manual            — buy any symbol/qty/price directly
GET  /api/execute/transactions          — full trade history

All trades respect the paper flag and update the portfolio cash balance.
Designed to be the gateway to forward-testing: every execution is logged so a
real track record accumulates.
"""
import asyncio
import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.auth_router import CurrentUser, get_current_user
from app.db.models import Holding, Portfolio, StockUniverse, SuggestionLog, Transaction

logger = logging.getLogger("stocksage.execute")
router = APIRouter(prefix="/api/execute", tags=["execute"])




async def _log_trade_config(db, txn_symbol: str, action: str, user_id: int | None = None) -> None:
    """Snapshot the live settings alongside the trade (auditable journal).
    Defensive: if the table doesn't exist yet, trading still works."""
    try:
        import json
        from app.settings_router import get_live_settings, EDITABLE
        live = await get_live_settings(user_id)
        cfg = {k: getattr(live, k) for k in EDITABLE if hasattr(live, k)}
        await db.execute(text(
            "INSERT INTO trade_config_log (symbol, action, config, user_id) "
            "VALUES (:s, :a, CAST(:c AS jsonb), :u)"),
            {"s": txn_symbol, "a": action, "c": json.dumps(cfg), "u": user_id})
    except Exception:
        logger.warning("trade_config_log insert skipped (table missing?)")


async def _portfolio(db: AsyncSession, user_id: int) -> Portfolio:
    pf = (await db.execute(select(Portfolio)
                           .where(Portfolio.user_id == user_id).limit(1))).scalar_one_or_none()
    if not pf:
        raise HTTPException(404, "No portfolio found for this user")
    return pf


@router.post("/buy/{suggestion_id}")
async def execute_buy(suggestion_id: int, db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)) -> dict:
    """Execute a logged BUY suggestion → creates/updates a holding."""
    sug = (await db.execute(select(SuggestionLog)
                            .where(SuggestionLog.id == suggestion_id))).scalar_one_or_none()
    if not sug:
        raise HTTPException(404, "Suggestion not found")
    if sug.action != "BUY":
        raise HTTPException(400, f"Suggestion is a {sug.action}, not a BUY")
    if sug.was_acted_on:
        raise HTTPException(409, "Already executed")

    qty = sug.suggested_quantity or 0
    price = float(sug.suggested_price or 0)
    total = float(sug.total_value or qty * price)
    if qty <= 0 or total <= 0:
        raise HTTPException(400, "Suggestion has no quantity/price")

    pf = await _portfolio(db, user.id)
    if sug.portfolio_id is not None and sug.portfolio_id != pf.id:
        raise HTTPException(403, "That suggestion belongs to a different user")
    if total > float(pf.cash_balance):
        raise HTTPException(400, f"Insufficient cash: need ₹{total:,.0f}, have ₹{float(pf.cash_balance):,.0f}")

    holding = (await db.execute(select(Holding)
                                .where(Holding.portfolio_id == pf.id)
                                .where(Holding.symbol == sug.symbol))).scalar_one_or_none()
    if holding:
        new_qty = holding.quantity + qty
        holding.avg_buy_price = round((float(holding.avg_buy_price) * holding.quantity + total) / new_qty, 2)
        holding.quantity = new_qty
        holding.current_price = price
        holding.peak_price = max(float(holding.peak_price or 0), price)
    else:
        db.add(Holding(portfolio_id=pf.id, symbol=sug.symbol, company_name=None,
                       quantity=qty, avg_buy_price=price, current_price=price, peak_price=price,
                       segment=sug.segment, sector=sug.sector))
    pf.cash_balance = round(float(pf.cash_balance) - total, 2)
    db.add(Transaction(portfolio_id=pf.id, symbol=sug.symbol, action="BUY", quantity=qty,
                       price=price, total_value=total, is_paper=pf.is_paper,
                       suggestion_id=sug.id, reason=f"Executed suggestion #{sug.id}"))
    sug.was_acted_on = True
    await _log_trade_config(db, sug.symbol, "BUY", user.id)
    await db.commit()
    return {"status": f"BOUGHT {qty} × {sug.symbol} @ ₹{price:,.2f}", "total": total,
            "cash_after": float(pf.cash_balance)}


@router.post("/sell/{holding_id}")
async def execute_sell(holding_id: int, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Sell an entire holding at the current market price."""
    h = (await db.execute(select(Holding).where(Holding.id == holding_id))).scalar_one_or_none()
    if not h:
        raise HTTPException(404, "Holding not found")
    pf = await _portfolio(db, user.id)
    if h.portfolio_id != pf.id:
        raise HTTPException(403, "That holding belongs to a different user")

    from app.market_data import fetcher
    try:
        price = (await asyncio.to_thread(fetcher.get_quote, h.symbol))["price"]
    except Exception:
        price = float(h.current_price or h.avg_buy_price)

    qty = h.quantity
    total = round(qty * price, 2)
    cost = float(h.avg_buy_price) * qty
    pnl = round(total - cost, 2)
    pf.cash_balance = round(float(pf.cash_balance) + total, 2)
    db.add(Transaction(portfolio_id=pf.id, symbol=h.symbol, action="SELL", quantity=qty,
                       price=price, total_value=total, is_paper=pf.is_paper,
                       reason=f"Sold position (P&L ₹{pnl:,.0f})"))
    await db.delete(h)
    await _log_trade_config(db, h.symbol, "SELL", user.id)
    await db.commit()
    return {"status": f"SOLD {qty} × {h.symbol} @ ₹{price:,.2f}", "pnl": pnl,
            "cash_after": float(pf.cash_balance)}


class ManualBuy(BaseModel):
    symbol: str
    quantity: int = Field(gt=0)
    price: float = Field(gt=0)


@router.post("/buy-manual")
async def buy_manual(body: ManualBuy, db: AsyncSession = Depends(get_db),
                     user: CurrentUser = Depends(get_current_user)) -> dict:
    """Add a holding you already own (e.g. existing real positions)."""
    pf = await _portfolio(db, user.id)
    sym = body.symbol.upper()
    total = round(body.quantity * body.price, 2)

    uni = (await db.execute(select(StockUniverse).where(StockUniverse.symbol == sym))).scalar_one_or_none()
    segment = uni.segment if uni else "NIFTY50"
    sector = uni.sector if uni else "Services"
    name = uni.company_name if uni else None

    holding = (await db.execute(select(Holding).where(Holding.portfolio_id == pf.id)
                                .where(Holding.symbol == sym))).scalar_one_or_none()
    if holding:
        new_qty = holding.quantity + body.quantity
        holding.avg_buy_price = round((float(holding.avg_buy_price) * holding.quantity + total) / new_qty, 2)
        holding.quantity = new_qty
    else:
        db.add(Holding(portfolio_id=pf.id, symbol=sym, company_name=name, quantity=body.quantity,
                       avg_buy_price=body.price, current_price=body.price, peak_price=body.price,
                       segment=segment, sector=sector))
    if total <= float(pf.cash_balance):
        pf.cash_balance = round(float(pf.cash_balance) - total, 2)
    db.add(Transaction(portfolio_id=pf.id, symbol=sym, action="BUY", quantity=body.quantity,
                       price=body.price, total_value=total, is_paper=pf.is_paper,
                       reason="Manual entry"))
    await db.commit()
    return {"status": f"Added {body.quantity} × {sym} @ ₹{body.price:,.2f}", "cash_after": float(pf.cash_balance)}


@router.get("/transactions")
async def transactions(limit: int = 50, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Full trade history, newest first."""
    pf = await _portfolio(db, user.id)
    rows = (await db.execute(select(Transaction)
                             .where(Transaction.portfolio_id == pf.id)
                             .order_by(desc(Transaction.executed_at)).limit(min(limit, 200)))).scalars().all()
    return {"count": len(rows), "transactions": [{
        "id": t.id, "symbol": t.symbol, "action": t.action, "quantity": t.quantity,
        "price": float(t.price), "total": float(t.total_value), "is_paper": t.is_paper,
        "reason": t.reason, "at": t.executed_at.isoformat() if t.executed_at else None,
    } for t in rows]}
