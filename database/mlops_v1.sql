-- == MLOps v1: shadow-model predictions - idempotent, safe to re-run ==
--   Get-Content database/mlops_v1.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- The API also applies these statements at startup (app/db/schema.py).

-- One row per headline scored by the shadow model (models/serving.json).
-- Never read by the engine; used to compare a candidate with the champion
-- on live traffic before promotion (research/drift.py, Grafana).
CREATE TABLE IF NOT EXISTS shadow_predictions (
    id               SERIAL PRIMARY KEY,
    url_hash         VARCHAR(64) NOT NULL,
    model_version    VARCHAR(160) NOT NULL,
    sentiment        VARCHAR(10) NOT NULL,
    sentiment_score  NUMERIC(5, 3) NOT NULL,
    confidence       NUMERIC(4, 3) NOT NULL,
    champion_model   VARCHAR(160),
    champion_sentiment VARCHAR(10),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (url_hash, model_version)
);
CREATE INDEX IF NOT EXISTS idx_shadow_created ON shadow_predictions (created_at);
-- Champion confidence (top-class probability), for drift and active learning.
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS sentiment_confidence NUMERIC(4, 3);
