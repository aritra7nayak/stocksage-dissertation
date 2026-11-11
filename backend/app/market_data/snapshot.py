"""End-of-day snapshot: persists the day's market state and refreshes holdings.

Runs at 16:00 IST (after close) and on demand via POST /api/market/refresh-eod.
Also maintains peak_price per holding — the input to R15 trailing-profit logic.
"""
import logging
from datetime import date, datetime

import pytz
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import AsyncSessionLocal
from app.db.models import Holding, MarketSnapshot
from app.market_data import fetcher

logger = logging.getLogger("stocksage.snapshot")
settings = get_settings()


async def run_eod_snapshot(db: AsyncSession | None = None) -> dict:
    """Fetch indices + ETFs, upsert today's market_snapshots row, update holdings."""
    own_session = db is None
    session = db or AsyncSessionLocal()
    try:
        nifty = fetcher.get_quote(settings.nifty50_index)
        sensex = fetcher.get_quote(settings.sensex_index)
        gold = fetcher.get_quote(settings.gold_etf)
        silver = fetcher.get_quote(settings.silver_etf)

        nifty_fell = nifty["change_pct"] <= settings.nifty_fall_threshold
        status = "BULLISH" if nifty["change_pct"] > 0.25 else "BEARISH" if nifty["change_pct"] < -0.25 else "NEUTRAL"

        ist = pytz.timezone(settings.timezone)
        today: date = datetime.now(ist).date()
        is_intraday = fetcher.is_market_open_ist()

        stmt = pg_insert(MarketSnapshot).values(
            snapshot_date=today,
            nifty50_close=nifty["price"],
            nifty50_change_pct=nifty["change_pct"],
            sensex_close=sensex["price"],
            sensex_change_pct=sensex["change_pct"],
            gold_etf_price=gold["price"],
            silver_etf_price=silver["price"],
            market_status=status,
            nifty_fell=nifty_fell,
            is_intraday=is_intraday,
            data_age_minutes=15 if is_intraday else 0,
        ).on_conflict_do_update(
            index_elements=[MarketSnapshot.snapshot_date],
            set_={
                "nifty50_close": nifty["price"], "nifty50_change_pct": nifty["change_pct"],
                "sensex_close": sensex["price"], "sensex_change_pct": sensex["change_pct"],
                "gold_etf_price": gold["price"], "silver_etf_price": silver["price"],
                "market_status": status, "nifty_fell": nifty_fell,
                "is_intraday": is_intraday,
            },
        )
        await session.execute(stmt)

        # Refresh holdings: current price + peak price (R15 input)
        holdings = (await session.execute(select(Holding))).scalars().all()
        updated = 0
        for h in holdings:
            try:
                q = fetcher.get_quote(h.symbol)
                h.current_price = q["price"]
                h.peak_price = max(float(h.peak_price or 0), q["price"])
                updated += 1
            except Exception as exc:
                logger.warning("Could not refresh %s: %s", h.symbol, exc)

        if own_session:
            await session.commit()

        result = {
            "snapshot_date": str(today),
            "nifty": nifty, "sensex": sensex, "gold": gold, "silver": silver,
            "market_status": status, "nifty_fell": nifty_fell,
            "holdings_refreshed": updated,
        }
        logger.info("EOD snapshot stored: %s (%s)", today, status)
        return result
    finally:
        if own_session:
            await session.close()
