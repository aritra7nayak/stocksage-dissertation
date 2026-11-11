-- ══ MULTI-PORTFOLIO MIGRATION — run once ═══════════════════════════════════
--   Get-Content database/trades_portfolios.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage

CREATE TABLE IF NOT EXISTS pf_portfolios (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    name         VARCHAR(80) NOT NULL,
    last_section INTEGER,                 -- which Excel section mapped here last time
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, name)
);

ALTER TABLE pf_trades ADD COLUMN IF NOT EXISTS portfolio_ref INTEGER REFERENCES pf_portfolios(id) ON DELETE CASCADE;

-- Backfill: everything imported before this migration lands in "Portfolio 1"
INSERT INTO pf_portfolios (user_id, name, last_section)
    SELECT DISTINCT user_id, 'Portfolio 1', 1 FROM pf_trades WHERE user_id IS NOT NULL
    ON CONFLICT (user_id, name) DO NOTHING;
UPDATE pf_trades t SET portfolio_ref = p.id
    FROM pf_portfolios p
    WHERE t.portfolio_ref IS NULL AND p.user_id = t.user_id AND p.name = 'Portfolio 1';

-- Dedup becomes per-portfolio (same trade may legitimately exist in two demat accounts)
ALTER TABLE pf_trades DROP CONSTRAINT IF EXISTS pf_trades_user_id_dedup_hash_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_pf_trades_pf_hash ON pf_trades(user_id, portfolio_ref, dedup_hash);
CREATE INDEX IF NOT EXISTS ix_pf_trades_pf ON pf_trades(user_id, portfolio_ref, stock_id);

SELECT 'multi-portfolio ready' AS status;
