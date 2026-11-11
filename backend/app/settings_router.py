"""Settings API — edit capital and rule parameters live, no restart.

All editable values live in the app_settings table (seeded in init.sql). This
router reads/writes them and validates the allocation buckets sum to 100%.

IMPORTANT — how live values reach the engine:
  The engine reads these via get_live_settings() (below), which overlays any
  app_settings rows on top of the .env defaults. So changing capital or a rule
  here takes effect on the NEXT engine run, with no process restart.

Mounted by app.main as settings_router.
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import AsyncSessionLocal, get_db
from app.auth_router import CurrentUser, get_current_user
from app.db.models import AppSetting, Portfolio

logger = logging.getLogger("stocksage.settings")
base = get_settings()
router = APIRouter(prefix="/api/settings", tags=["settings"])

# Editable keys, their type, label, and the .env default (fallback when no row)
EDITABLE: dict[str, dict] = {
    "total_capital":            {"type": "float", "label": "Total Capital (₹)",        "default": base.total_capital, "group": "Capital"},
    "cash_reserve_pct":         {"type": "float", "label": "Cash Reserve %",            "default": base.cash_reserve_pct, "group": "Allocation"},
    "gold_silver_pct":          {"type": "float", "label": "Gold + Silver ETF %",       "default": base.gold_silver_pct, "group": "Allocation"},
    "nifty50_pct":              {"type": "float", "label": "Nifty 50 %",                "default": base.nifty50_pct, "group": "Allocation"},
    "nifty_next100_pct":        {"type": "float", "label": "Nifty Next 100 %",          "default": base.nifty_next100_pct, "group": "Allocation"},
    "smallcap_pct":             {"type": "float", "label": "Smallcap %",                "default": base.smallcap_pct, "group": "Allocation"},
    "min_stock_purchase":       {"type": "float", "label": "Min Stock Buy (₹)",         "default": base.min_stock_purchase, "group": "Purchase bands"},
    "max_stock_purchase":       {"type": "float", "label": "Max Stock Buy (₹)",         "default": base.max_stock_purchase, "group": "Purchase bands"},
    "min_etf_purchase":         {"type": "float", "label": "Min ETF Buy (₹)",           "default": base.min_etf_purchase, "group": "Purchase bands"},
    "max_etf_purchase":         {"type": "float", "label": "Max ETF Buy (₹)",           "default": base.max_etf_purchase, "group": "Purchase bands"},
    "max_daily_invest_pct":     {"type": "float", "label": "Max Daily Invest %",        "default": base.max_daily_invest_pct, "group": "Limits"},
    "stop_loss_pct":            {"type": "float", "label": "Stop Loss %",               "default": base.stop_loss_pct, "group": "Sell rules"},
    "deterioration_score":      {"type": "float", "label": "Deterioration Score Floor", "default": base.deterioration_score, "group": "Sell rules"},
    "deterioration_days":       {"type": "int",   "label": "Deterioration Days",        "default": base.deterioration_days, "group": "Sell rules"},
    "trailing_profit_trigger":  {"type": "float", "label": "Trailing Profit Trigger %", "default": base.trailing_profit_trigger, "group": "Sell rules"},
    "trailing_profit_giveback": {"type": "float", "label": "Trailing Giveback %",       "default": base.trailing_profit_giveback, "group": "Sell rules"},
    "nifty_fall_threshold":     {"type": "float", "label": "Nifty Fall Threshold %",    "default": base.nifty_fall_threshold, "group": "Guards"},
    "bad_news_headline_limit":  {"type": "int",   "label": "Bad-news Headline Limit",   "default": base.bad_news_headline_limit, "group": "Guards"},
}

PRESETS = {
    "conservative": {"stop_loss_pct": 0.08, "cash_reserve_pct": 0.20},
    "medium":       {"stop_loss_pct": 0.10, "cash_reserve_pct": 0.15},
    "aggressive":   {"stop_loss_pct": 0.12, "cash_reserve_pct": 0.10},
}


def _cast(value: str, t: str):
    return int(float(value)) if t == "int" else float(value)


async def read_overrides(db: AsyncSession, user_id: int | None = None) -> dict:
    """All app_settings rows as {key: typed_value}."""
    q = select(AppSetting).where(AppSetting.user_id == user_id) if user_id is not None else select(AppSetting)
    rows = (await db.execute(q)).scalars().all()
    out = {}
    for r in rows:
        if r.key in EDITABLE:
            try:
                out[r.key] = _cast(r.value, EDITABLE[r.key]["type"])
            except (ValueError, TypeError):
                pass
    return out


async def get_live_settings(user_id: int | None = None):
    """Return a Settings copy with app_settings overrides applied.

    The engine and backtester call this instead of get_settings() so user edits
    take effect immediately. Falls back cleanly to .env defaults if the DB is
    unreachable.
    """
    try:
        async with AsyncSessionLocal() as db:
            overrides = await read_overrides(db, user_id)
        if overrides:
            return base.model_copy(update=overrides)
    except Exception:
        logger.warning("Could not load settings overrides — using .env defaults", exc_info=True)
    return base


class UpdateIn(BaseModel):
    values: dict[str, float] = Field(..., description="key -> new value")


@router.get("")
async def get_all(db: AsyncSession = Depends(get_db),
                  user: CurrentUser = Depends(get_current_user)) -> dict:
    """Current effective values + metadata, grouped for the UI."""
    overrides = await read_overrides(db, user.id)
    items = []
    for key, meta in EDITABLE.items():
        items.append({
            "key": key, "label": meta["label"], "group": meta["group"], "type": meta["type"],
            "value": overrides.get(key, meta["default"]),
            "default": meta["default"],
            "is_overridden": key in overrides,
        })
    # allocation health
    alloc_keys = ["cash_reserve_pct", "gold_silver_pct", "nifty50_pct", "nifty_next100_pct", "smallcap_pct"]
    alloc_sum = sum(overrides.get(k, EDITABLE[k]["default"]) for k in alloc_keys)
    return {"settings": items, "allocation_sum": round(alloc_sum, 4),
            "allocation_ok": abs(alloc_sum - 1.0) < 1e-6}


@router.put("")
async def update(body: UpdateIn, db: AsyncSession = Depends(get_db),
                 user: CurrentUser = Depends(get_current_user)) -> dict:
    """Update one or more settings. Validates allocation sums to 100%."""
    for k in body.values:
        if k not in EDITABLE:
            raise HTTPException(400, f"Unknown setting: {k}")

    # Validate allocation if any allocation key is being changed
    current = await read_overrides(db, user.id)
    merged = {**{k: EDITABLE[k]["default"] for k in EDITABLE}, **current, **body.values}
    alloc_keys = ["cash_reserve_pct", "gold_silver_pct", "nifty50_pct", "nifty_next100_pct", "smallcap_pct"]
    alloc_sum = sum(merged[k] for k in alloc_keys)
    if abs(alloc_sum - 1.0) > 1e-6:
        raise HTTPException(400,
            f"Allocation must sum to 100%. Cash + Gold/Silver + Nifty50 + Next100 + Smallcap "
            f"= {alloc_sum*100:.1f}%. Adjust the buckets so they total 100%.")

    for key, val in body.values.items():
        await db.execute(pg_insert(AppSetting).values(
            user_id=user.id, key=key, value=str(val), value_type=EDITABLE[key]["type"],
            description=EDITABLE[key]["label"]
        ).on_conflict_do_update(index_elements=["user_id", "key"], set_={"value": str(val)}))

    # If total_capital changed, reflect it on the portfolio's cash if no holdings yet
    if "total_capital" in body.values:
        pf = (await db.execute(select(Portfolio).where(Portfolio.user_id == user.id).limit(1))).scalar_one_or_none()
        if pf:
            new_cap = float(body.values["total_capital"])
            # Only reset cash if nothing invested yet (cash == capital)
            if abs(float(pf.cash_balance) - float(pf.total_capital)) < 1.0:
                pf.cash_balance = new_cap
            pf.total_capital = new_cap

    await db.commit()
    return {"status": "saved", "updated": list(body.values.keys())}


@router.post("/preset/{preset}")
async def apply_preset(preset: str, db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Promote a backtest preset (conservative/medium/aggressive) to LIVE rules."""
    if preset not in PRESETS:
        raise HTTPException(400, f"Unknown preset. Choose: {list(PRESETS)}")
    vals = PRESETS[preset]
    for key, val in vals.items():
        await db.execute(pg_insert(AppSetting).values(
            user_id=user.id, key=key, value=str(val), value_type="float", description=EDITABLE[key]["label"]
        ).on_conflict_do_update(index_elements=["user_id", "key"], set_={"value": str(val)}))
    await db.commit()
    return {"status": "applied", "preset": preset, "values": vals}


@router.post("/reset")
async def reset(db: AsyncSession = Depends(get_db),
                user: CurrentUser = Depends(get_current_user)) -> dict:
    """Delete all overrides → back to .env defaults."""
    rows = (await db.execute(select(AppSetting).where(AppSetting.user_id == user.id))).scalars().all()
    for r in rows:
        if r.key in EDITABLE:
            await db.delete(r)
    await db.commit()
    return {"status": "reset to defaults"}
