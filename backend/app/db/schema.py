"""Idempotent schema upgrades applied at API startup.

Only additive, re-runnable statements belong here (ADD COLUMN IF NOT EXISTS,
CREATE INDEX IF NOT EXISTS). Each file is also kept in database/ for manual use
and appended to database/deploy.sql for fresh installs.
"""
import logging

from sqlalchemy import text

from app.db.database import engine

logger = logging.getLogger("stocksage.schema")

_EMBEDDED = {
    # Mirrors database/nlp_v1.sql, so a container without the database/
    # folder upgrades too.
    "nlp_v1": [
        "ALTER TABLE news_items ADD COLUMN IF NOT EXISTS summary TEXT",
        "ALTER TABLE news_items ADD COLUMN IF NOT EXISTS sentiment_model VARCHAR(160)",
        "ALTER TABLE news_items ADD COLUMN IF NOT EXISTS linker_version VARCHAR(40)",
        "CREATE INDEX IF NOT EXISTS idx_news_related_symbols "
        "ON news_items USING GIN (related_symbols)",
    ],
    # Mirrors database/mlops_v1.sql.
    "mlops_v1": [
        "CREATE TABLE IF NOT EXISTS shadow_predictions ("
        " id SERIAL PRIMARY KEY, url_hash VARCHAR(64) NOT NULL,"
        " model_version VARCHAR(160) NOT NULL, sentiment VARCHAR(10) NOT NULL,"
        " sentiment_score NUMERIC(5, 3) NOT NULL, confidence NUMERIC(4, 3) NOT NULL,"
        " champion_model VARCHAR(160), champion_sentiment VARCHAR(10),"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (url_hash, model_version))",
        "CREATE INDEX IF NOT EXISTS idx_shadow_created ON shadow_predictions (created_at)",
        "ALTER TABLE news_items ADD COLUMN IF NOT EXISTS sentiment_confidence NUMERIC(4, 3)",
    ],
    # Mirrors database/research_v1.sql.
    "research_v1": [
        "CREATE TABLE IF NOT EXISTS annotation_roles ("
        " user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,"
        " role CHAR(1) NOT NULL UNIQUE CHECK (role IN ('A', 'B')))",
        "CREATE TABLE IF NOT EXISTS annotations ("
        " id SERIAL PRIMARY KEY, item_id VARCHAR(64) NOT NULL,"
        " annotator CHAR(1) NOT NULL CHECK (annotator IN ('A', 'B')),"
        " user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,"
        " sentiment VARCHAR(10) NOT NULL, events JSONB NOT NULL, severity VARCHAR(10) NOT NULL,"
        " scope VARCHAR(10) NOT NULL, companies JSONB NOT NULL DEFAULT '[]',"
        " sectors JSONB NOT NULL DEFAULT '[]', notes TEXT, prelabel JSONB,"
        " seconds REAL NOT NULL DEFAULT 0,"
        " created_at TIMESTAMPTZ NOT NULL DEFAULT now(),"
        " updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (item_id, annotator))",
    ],
}


async def apply_upgrades() -> None:
    """Never blocks startup: a failure is logged and the app still boots."""
    for name, statements in _EMBEDDED.items():
        try:
            async with engine.begin() as conn:
                if not (await conn.execute(text("SELECT to_regclass('news_items')"))).scalar():
                    logger.info("Schema upgrade %s skipped: base schema not created yet", name)
                    continue
                for stmt in statements:
                    await conn.execute(text(stmt))
            logger.info("Schema upgrade %s applied", name)
        except Exception:
            logger.exception("Schema upgrade %s failed — run database/%s.sql manually",
                             name, name)
