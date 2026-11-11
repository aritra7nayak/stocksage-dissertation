-- Bench the two tickers Yahoo genuinely 404s on (stops the error noise
-- on every engine run). Re-enable later if Yahoo restores them.
--   Get-Content database/bench_dead_tickers.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
UPDATE stock_universe SET is_active = FALSE, unbuyable_reason = 'Yahoo 404 — symbol unavailable'
WHERE symbol IN ('TATAMOTORS.NS', 'LTIM.NS');
SELECT symbol, is_active, unbuyable_reason FROM stock_universe
WHERE symbol IN ('TATAMOTORS.NS', 'LTIM.NS');
