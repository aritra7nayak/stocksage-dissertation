-- ── Insights tables (run once) ─────────────────────────────────────────────
--   Get-Content database/insights_tables.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage

-- Daily snapshot of YOUR paper portfolio + market context.
-- Powers: equity curve, guard diary. Upserted lazily whenever the app is used.
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    snapshot_date  DATE PRIMARY KEY,
    total_value    NUMERIC(14,2) NOT NULL,
    cash           NUMERIC(14,2) NOT NULL,
    holdings_value NUMERIC(14,2) NOT NULL,
    nifty_close    NUMERIC(12,2),
    guard_status   VARCHAR(8),          -- OK | RED
    guard_verdict  TEXT,
    created_at     TIMESTAMPTZ DEFAULT now()
);

-- Which settings were live when each trade executed (auditable journal).
CREATE TABLE IF NOT EXISTS trade_config_log (
    id             SERIAL PRIMARY KEY,
    transaction_id INTEGER,
    symbol         VARCHAR(24),
    action         VARCHAR(8),
    config         JSONB,
    created_at     TIMESTAMPTZ DEFAULT now()
);

SELECT 'insights tables ready' AS status;
