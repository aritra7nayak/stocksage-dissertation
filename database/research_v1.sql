-- == Research v1: corpus annotation from the Research tab - idempotent, safe to re-run ==
--   Get-Content database/research_v1.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- The API also applies these statements at startup (app/db/schema.py).

-- Which user is annotator A (labels the full sample) and B (the double subset).
CREATE TABLE IF NOT EXISTS annotation_roles (
    user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role     CHAR(1) NOT NULL UNIQUE CHECK (role IN ('A', 'B'))
);

-- One label per headline per annotator. `prelabel` holds the LLM pre-label the
-- annotator was shown when the row was first saved (NULL = labelled from blank),
-- so import can mark the row human_verified and measure how often it was changed.
-- Exported with: python -m research.build_sample import-db --annotator A --to ...
CREATE TABLE IF NOT EXISTS annotations (
    id          SERIAL PRIMARY KEY,
    item_id     VARCHAR(64) NOT NULL,
    annotator   CHAR(1) NOT NULL CHECK (annotator IN ('A', 'B')),
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sentiment   VARCHAR(10) NOT NULL,
    events      JSONB NOT NULL,
    severity    VARCHAR(10) NOT NULL,
    scope       VARCHAR(10) NOT NULL,
    companies   JSONB NOT NULL DEFAULT '[]',
    sectors     JSONB NOT NULL DEFAULT '[]',
    notes       TEXT,
    prelabel    JSONB,
    seconds     REAL NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, annotator)
);
