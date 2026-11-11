-- ══ TRADES v3 (new file format) — run once ═════════════════════════════════
--   Get-Content database/trades_v3.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
ALTER TABLE pf_stocks ADD COLUMN IF NOT EXISTS full_name VARCHAR(200);
SELECT 'trades v3 ready' AS status;
