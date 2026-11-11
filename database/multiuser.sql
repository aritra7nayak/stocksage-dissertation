-- ══ MULTI-USER MIGRATION (combined Phase 1+2 — run once) ═══════════════════
--   Get-Content database/multiuser.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- Safe to run even if auth/insights SQL was never applied (all guarded).

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(48) UNIQUE NOT NULL,
    display_name  VARCHAR(80),
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    snapshot_date  DATE,
    total_value    NUMERIC(14,2) NOT NULL,
    cash           NUMERIC(14,2) NOT NULL,
    holdings_value NUMERIC(14,2) NOT NULL,
    nifty_close    NUMERIC(12,2),
    guard_status   VARCHAR(8),
    guard_verdict  TEXT,
    created_at     TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trade_config_log (
    id SERIAL PRIMARY KEY, transaction_id INTEGER, symbol VARCHAR(24),
    action VARCHAR(8), config JSONB, created_at TIMESTAMPTZ DEFAULT now()
);

-- user_id everywhere it matters (holdings/transactions/suggestions scope
-- through portfolio_id, so portfolios.user_id covers them)
ALTER TABLE portfolios          ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE portfolio_snapshots ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE trade_config_log    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE app_settings        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;

-- portfolio_snapshots: (user_id, date) is the new identity
ALTER TABLE portfolio_snapshots DROP CONSTRAINT IF EXISTS portfolio_snapshots_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS ux_snap_user_date ON portfolio_snapshots(user_id, snapshot_date);

-- app_settings: per-user keys → surrogate id PK + unique (user_id, key)
ALTER TABLE app_settings DROP CONSTRAINT IF EXISTS app_settings_pkey;
ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS id SERIAL;
DO $$ BEGIN ALTER TABLE app_settings ADD PRIMARY KEY (id); EXCEPTION WHEN others THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_settings_user_key ON app_settings(user_id, key);

SELECT 'multi-user schema ready' AS status;
