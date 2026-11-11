"""Async SQLAlchemy engine and session management."""
from collections.abc import AsyncGenerator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

# libpq-only query params that asyncpg rejects as unexpected keyword arguments.
# Managed Postgres providers (Neon, Supabase, Render) hand out URLs containing
# them, so strip them here and translate the intent into connect_args.
_LIBPQ_ONLY = {"sslmode", "channel_binding", "sslrootcert", "target_session_attrs"}


def _normalize_asyncpg_url(url: str) -> tuple[str, dict]:
    """Return (url_without_libpq_params, connect_args).

    A cloud URL such as
        postgresql+asyncpg://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require
    becomes a bare URL plus {"ssl": True}, which is what asyncpg actually wants.
    Local URLs with no such params pass through untouched.
    """
    parts = urlsplit(url)
    params = dict(parse_qsl(parts.query))
    connect_args: dict = {}

    sslmode = params.get("sslmode")
    if sslmode and sslmode not in ("disable", "allow"):
        connect_args["ssl"] = True

    kept = {k: v for k, v in params.items() if k not in _LIBPQ_ONLY}
    clean = urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(kept), parts.fragment))
    return clean, connect_args


_url, _connect_args = _normalize_asyncpg_url(settings.database_url)

engine = create_async_engine(
    _url,
    pool_size=settings.db_pool_size,
    max_overflow=settings.db_max_overflow,
    pool_pre_ping=True,
    # Free Postgres tiers drop idle connections; recycle before they go stale.
    pool_recycle=300,
    connect_args=_connect_args,
    echo=False,
)

AsyncSessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    """Declarative base for all ORM models."""


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency that yields a database session."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
