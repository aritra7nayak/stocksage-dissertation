-- ══ FULL NSE CATALOG (for symbol mapping) — run once ═══════════════════════
--   Get-Content database/nse_catalog.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- Table is seeded from inside the app: the "Load full NSE list" button
-- downloads NSE's official equity list (~2000+ companies) into it.

CREATE TABLE IF NOT EXISTS nse_catalog (
    symbol       VARCHAR(24) PRIMARY KEY,     -- e.g. RELINFRA.NS
    company_name VARCHAR(200),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

SELECT 'nse catalog table ready' AS status;
