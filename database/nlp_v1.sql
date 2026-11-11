-- ══ NLP v1: provenance for every news prediction — idempotent, safe to re-run ══
--   Get-Content database/nlp_v1.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- The API also applies these statements at startup (app/db/schema.py), so an
-- existing database upgrades itself on the next deploy.

-- RSS summary/description (previously discarded)
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS summary TEXT;
-- '<hub-model>@<commit>' that produced sentiment/sentiment_score (NULL = fallback/legacy)
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS sentiment_model VARCHAR(160);
-- Which linker wrote related_symbols (NULL = row predates the entity linker)
ALTER TABLE news_items ADD COLUMN IF NOT EXISTS linker_version VARCHAR(40);
CREATE INDEX IF NOT EXISTS idx_news_related_symbols ON news_items USING GIN (related_symbols);
