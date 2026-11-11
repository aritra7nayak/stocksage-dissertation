-- ══ TRADES SYSTEM (portfolio revamp) — run once ════════════════════════════
--   Get-Content database/trades_tables.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage

-- Canonical stock identity per user (display name = user's own naming)
CREATE TABLE IF NOT EXISTS pf_stocks (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    display_name VARCHAR(120) NOT NULL,
    norm_key     VARCHAR(120) NOT NULL,      -- normalized (upper, alnum only)
    symbol       VARCHAR(24),                -- resolved Yahoo symbol (nullable)
    created_at   TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, norm_key)
);

-- Every raw spelling ever seen maps to one canonical stock (survives re-imports)
CREATE TABLE IF NOT EXISTS pf_aliases (
    id        SERIAL PRIMARY KEY,
    user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
    raw_norm  VARCHAR(120) NOT NULL,
    stock_id  INTEGER REFERENCES pf_stocks(id) ON DELETE CASCADE,
    UNIQUE(user_id, raw_norm)
);

-- The system of record: every buy (a lot) and every sell, imported or manual
CREATE TABLE IF NOT EXISTS pf_trades (
    id            SERIAL PRIMARY KEY,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    stock_id      INTEGER REFERENCES pf_stocks(id) ON DELETE CASCADE,
    side          VARCHAR(4) NOT NULL,            -- BUY | SELL
    trade_date    DATE NOT NULL,
    qty           NUMERIC(14,4) NOT NULL,
    price         NUMERIC(14,4) NOT NULL,
    gross_value   NUMERIC(16,2),                  -- qty × price
    cost_value    NUMERIC(16,2),                  -- incl. brokerage (from file)
    brokerage     NUMERIC(12,2),
    qty_remaining NUMERIC(14,4),                  -- BUY lots only; maintained by FIFO replay
    target_lot_id INTEGER,                        -- SELL only: row-level sell against one lot
    source        VARCHAR(8) DEFAULT 'IMPORT',    -- IMPORT | MANUAL
    dedup_hash    VARCHAR(96),                    -- idempotent re-import key
    extras        JSONB,                          -- all original columns preserved
    created_at    TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, dedup_hash)
);
CREATE INDEX IF NOT EXISTS ix_pf_trades_user_stock ON pf_trades(user_id, stock_id);

SELECT 'trades system ready' AS status;
