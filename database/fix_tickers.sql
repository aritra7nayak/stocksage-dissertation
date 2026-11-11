-- ── Ticker fixes (Tier 2 / E) ──────────────────────────────────────────────
-- Run once against your database to correct Yahoo ticker drift.
--
--   docker exec -i stocksage_db psql -U stocksage -d stocksage < database/fix_tickers.sql
--
-- Or paste each line into:
--   docker exec stocksage_db psql -U stocksage -d stocksage -c "<line>"

-- REC Limited: Yahoo lists it as RECLTD.NS (not REC.NS)
UPDATE stock_universe SET symbol = 'RECLTD.NS', is_active = TRUE, unbuyable_reason = NULL
WHERE symbol = 'REC.NS';

-- Tata Motors: re-enable (Yahoo symbol is valid; was benched defensively)
UPDATE stock_universe SET is_active = TRUE, unbuyable_reason = NULL
WHERE symbol = 'TATAMOTORS.NS';

-- LTIMindtree: Yahoo symbol is LTIM.NS — keep enabled; if it 404s on your
-- machine, Yahoo is having a bad day for that ticker, the engine will just skip
-- it for that run (never crashes). Re-enable explicitly here:
UPDATE stock_universe SET is_active = TRUE, unbuyable_reason = NULL
WHERE symbol = 'LTIM.NS';

-- Verify
SELECT symbol, company_name, is_active FROM stock_universe
WHERE symbol IN ('RECLTD.NS', 'REC.NS', 'TATAMOTORS.NS', 'LTIM.NS')
ORDER BY symbol;
