"""DB-backed, cached EntityLinker shared by the engine and the routers.

Linkable companies are the stock universe. The full NSE catalogue, when
loaded, is used only to recognise ambiguous words (for example the many
listed "Reliance" companies), never as link targets.
"""
import time

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import StockUniverse
from app.nlp.entity_linker import EntityLinker

LINKER_VERSION = "alias-v1"
_TTL_S = 3600

_cached: EntityLinker | None = None
_built_at = 0.0


async def get_linker(db: AsyncSession) -> EntityLinker:
    global _cached, _built_at
    if _cached is not None and time.monotonic() - _built_at < _TTL_S:
        return _cached
    companies = (await db.execute(
        select(StockUniverse.symbol, StockUniverse.company_name))).all()
    catalogue: list = []
    # to_regclass avoids a failing statement, which would abort the caller's
    # transaction on PostgreSQL when the optional table is missing.
    if (await db.execute(text("SELECT to_regclass('nse_catalog')"))).scalar():
        catalogue = (await db.execute(
            text("SELECT symbol, company_name FROM nse_catalog"))).all()
    _cached = EntityLinker([(s, n) for s, n in companies],
                           extra_catalogue=[(s, n) for s, n in catalogue])
    _built_at = time.monotonic()
    return _cached


def invalidate() -> None:
    """Force a rebuild on next use (call after the universe or catalogue changes)."""
    global _cached
    _cached = None
