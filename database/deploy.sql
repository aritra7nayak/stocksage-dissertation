-- ============================================================================
-- StockSage India - one-shot deployment schema
--
-- Every migration in database/ concatenated in dependency order, so a fresh
-- managed Postgres (Neon / Supabase) can be set up in a single command:
--
--   psql "<DATABASE_URL_SYNC>" -f database/deploy.sql
--
-- Order matters: multiuser.sql ALTERs tables that the files above it create.
-- Intended for an EMPTY database - init.sql uses bare CREATE TABLE, so
-- re-running this against a live database will error rather than silently
-- half-apply. Keep in sync by hand when you add a migration to database/.
-- ============================================================================



-- ==========================================================================
-- init.sql - Core schema: portfolios, universe, holdings, analysis, settings
-- ==========================================================================
-- ============================================================================
-- StockSage India — Database Schema (v2, architecture-reviewed)
-- Adds over original spec: sell-rule fields, paper trading, backtest tables,
-- sector_health history, app_settings, composite score breakdown, data freshness.
-- ============================================================================

-- ── Portfolios ──────────────────────────────────────────────────────────────
CREATE TABLE portfolios (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL DEFAULT 'My Portfolio',
    total_capital   NUMERIC(14,2) NOT NULL DEFAULT 100000,   -- cash + holdings value, recomputed daily
    cash_balance    NUMERIC(14,2) NOT NULL DEFAULT 100000,   -- uninvested cash
    is_paper        BOOLEAN NOT NULL DEFAULT TRUE,           -- paper-trading mode
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── Stock Universe ──────────────────────────────────────────────────────────
CREATE TABLE stock_universe (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(24) UNIQUE NOT NULL,             -- yfinance symbol, e.g. INFY.NS
    company_name    VARCHAR(200),
    sector          VARCHAR(100),                            -- normalized to the 9 tracked sectors
    industry        VARCHAR(150),
    segment         VARCHAR(20) NOT NULL,                    -- NIFTY50 | NEXT100 | SMALLCAP | GOLD_ETF | SILVER_ETF
    market_cap      NUMERIC(20,2),
    is_active       BOOLEAN DEFAULT TRUE,
    unbuyable_reason TEXT,                                   -- e.g. 'single share exceeds ₹9000 purchase band'
    added_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Holdings ────────────────────────────────────────────────────────────────
CREATE TABLE holdings (
    id              SERIAL PRIMARY KEY,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol          VARCHAR(24) NOT NULL,
    company_name    VARCHAR(200),
    quantity        INTEGER NOT NULL CHECK (quantity > 0),
    avg_buy_price   NUMERIC(12,2) NOT NULL,
    current_price   NUMERIC(12,2),
    peak_price      NUMERIC(12,2),                           -- highest close since buy → R15 trailing logic
    segment         VARCHAR(20),
    sector          VARCHAR(100),
    low_score_streak INTEGER NOT NULL DEFAULT 0,             -- consecutive days below deterioration score → R14
    bought_at       TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (portfolio_id, symbol)
);

-- ── Transactions ────────────────────────────────────────────────────────────
CREATE TABLE transactions (
    id              SERIAL PRIMARY KEY,
    portfolio_id    INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    symbol          VARCHAR(24) NOT NULL,
    action          VARCHAR(6) NOT NULL CHECK (action IN ('BUY','SELL')),
    quantity        INTEGER NOT NULL,
    price           NUMERIC(12,2) NOT NULL,
    total_value     NUMERIC(14,2) NOT NULL,
    is_paper        BOOLEAN NOT NULL DEFAULT TRUE,
    suggestion_id   INTEGER,                                 -- links back to suggestions_log if engine-driven
    reason          TEXT,
    executed_at     TIMESTAMPTZ DEFAULT NOW()
);

-- ── Daily Market Snapshots ──────────────────────────────────────────────────
CREATE TABLE market_snapshots (
    id                  SERIAL PRIMARY KEY,
    snapshot_date       DATE UNIQUE NOT NULL,
    nifty50_open        NUMERIC(12,2),
    nifty50_close       NUMERIC(12,2),
    nifty50_change_pct  NUMERIC(7,3),
    sensex_open         NUMERIC(12,2),
    sensex_close        NUMERIC(12,2),
    sensex_change_pct   NUMERIC(7,3),
    gold_etf_price      NUMERIC(12,2),
    silver_etf_price    NUMERIC(12,2),
    market_status       VARCHAR(12),                         -- BULLISH | BEARISH | NEUTRAL
    nifty_fell          BOOLEAN DEFAULT FALSE,               -- R11 input
    is_intraday         BOOLEAN DEFAULT FALSE,               -- TRUE for the 12:30 midday refresh row
    data_age_minutes    INTEGER,                             -- freshness honesty
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Daily Stock Analysis ────────────────────────────────────────────────────
CREATE TABLE stock_analysis (
    id                  SERIAL PRIMARY KEY,
    symbol              VARCHAR(24) NOT NULL,
    analysis_date       DATE NOT NULL,
    current_price       NUMERIC(12,2),
    -- Technicals
    rsi_14              NUMERIC(6,2),
    macd_hist           NUMERIC(12,4),
    macd_signal         VARCHAR(16),                         -- BULLISH_CROSS | BEARISH_CROSS | NONE
    ema_20              NUMERIC(12,2),
    ema_50              NUMERIC(12,2),
    ema_cross           VARCHAR(12),                         -- GOLDEN | DEATH | NONE
    bb_percent_b        NUMERIC(6,3),
    adx                 NUMERIC(6,2),
    stoch_k             NUMERIC(6,2),
    volume_ratio        NUMERIC(8,3),                        -- today / 20d SMA
    momentum_20d        NUMERIC(8,4),
    dist_52w_high       NUMERIC(6,3),
    -- Fundamentals
    pe_ratio            NUMERIC(10,2),
    pb_ratio            NUMERIC(10,2),
    roe                 NUMERIC(8,2),
    debt_to_equity      NUMERIC(10,2),
    revenue_growth      NUMERIC(8,2),
    profit_margin       NUMERIC(8,2),
    dividend_yield      NUMERIC(6,3),
    -- Sentiment
    news_sentiment      NUMERIC(5,3),                        -- -1..1
    sector_sentiment    NUMERIC(5,3),
    -- Composite (transparent weighted score, NOT opaque ML)
    technical_score     NUMERIC(5,3),                        -- 0..1
    fundamental_score   NUMERIC(5,3),
    sentiment_score     NUMERIC(5,3),
    composite_score     NUMERIC(5,3),                        -- 0.40*tech + 0.35*fund + 0.25*sent
    recommendation      VARCHAR(6),                          -- BUY | SELL | HOLD | SKIP
    confidence          VARCHAR(8),                          -- HIGH | MEDIUM | LOW
    top_reasons         JSONB,                               -- plain-English driver list
    UNIQUE (symbol, analysis_date)
);

-- ── Sector Health (history, not just latest) ────────────────────────────────
CREATE TABLE sector_health (
    id              SERIAL PRIMARY KEY,
    sector          VARCHAR(100) NOT NULL,
    health_date     DATE NOT NULL,
    score           NUMERIC(5,1),                            -- 0..100
    status          VARCHAR(10),                             -- STRONG | NEUTRAL | WEAK
    change_pct      NUMERIC(7,3),
    avg_rsi         NUMERIC(6,2),
    news_score      NUMERIC(5,3),
    top_gainer      VARCHAR(24),
    is_blocked      BOOLEAN DEFAULT FALSE,                   -- R10/R12 result
    block_reason    TEXT,
    UNIQUE (sector, health_date)
);

-- ── News Store ──────────────────────────────────────────────────────────────
CREATE TABLE news_items (
    id              SERIAL PRIMARY KEY,
    headline        TEXT NOT NULL,
    url             TEXT,
    source          VARCHAR(100),
    sentiment       VARCHAR(10),                             -- POSITIVE | NEGATIVE | NEUTRAL
    sentiment_score NUMERIC(5,3),
    severity        NUMERIC(4,1) DEFAULT 0,                  -- 0..10 keyword severity
    is_bad_news     BOOLEAN DEFAULT FALSE,
    related_symbols TEXT[],
    related_sectors TEXT[],
    published_at    TIMESTAMPTZ,
    fetched_at      TIMESTAMPTZ DEFAULT NOW(),
    url_hash        VARCHAR(64) UNIQUE                       -- dedup across RSS fetches
);

-- ── Suggestions Log (full audit trail) ──────────────────────────────────────
CREATE TABLE suggestions_log (
    id                  SERIAL PRIMARY KEY,
    suggestion_date     DATE NOT NULL,
    run_type            VARCHAR(10) DEFAULT 'MORNING',       -- MORNING | MIDDAY | MANUAL
    portfolio_id        INTEGER REFERENCES portfolios(id),
    symbol              VARCHAR(24),
    action              VARCHAR(6) NOT NULL,                 -- BUY | SELL | HOLD | SKIP
    segment             VARCHAR(20),
    sector              VARCHAR(100),
    suggested_quantity  INTEGER,
    suggested_price     NUMERIC(12,2),
    total_value         NUMERIC(14,2),
    composite_score     NUMERIC(5,3),
    confidence          VARCHAR(8),
    rules_passed        JSONB,
    rules_failed        JSONB,
    reasoning           JSONB,                               -- list of plain-English reasons
    was_acted_on        BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── Backtesting ─────────────────────────────────────────────────────────────
CREATE TABLE backtest_runs (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(120),
    start_date      DATE NOT NULL,
    end_date        DATE NOT NULL,
    initial_capital NUMERIC(14,2) NOT NULL,
    final_value     NUMERIC(14,2),
    total_return_pct NUMERIC(8,3),
    nifty_return_pct NUMERIC(8,3),                           -- benchmark over same window
    max_drawdown_pct NUMERIC(8,3),
    win_rate         NUMERIC(5,3),
    total_trades     INTEGER,
    rule_config      JSONB,                                  -- frozen copy of rule params used
    status           VARCHAR(12) DEFAULT 'PENDING',          -- PENDING | RUNNING | DONE | FAILED
    created_at       TIMESTAMPTZ DEFAULT NOW(),
    completed_at     TIMESTAMPTZ
);

CREATE TABLE backtest_trades (
    id              SERIAL PRIMARY KEY,
    run_id          INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
    symbol          VARCHAR(24) NOT NULL,
    action          VARCHAR(6) NOT NULL,
    trade_date      DATE NOT NULL,
    quantity        INTEGER,
    price           NUMERIC(12,2),
    pnl             NUMERIC(14,2),                           -- realized on SELL rows
    triggered_rule  VARCHAR(8),                              -- which rule fired (R13 stop-loss etc.)
    reason          TEXT
);

-- ── App Settings (rules editable from UI without restarts) ──────────────────
CREATE TABLE app_settings (
    key         VARCHAR(60) PRIMARY KEY,
    value       TEXT NOT NULL,
    value_type  VARCHAR(10) DEFAULT 'str',                   -- str | int | float | bool
    description TEXT,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX idx_holdings_portfolio       ON holdings(portfolio_id);
CREATE INDEX idx_analysis_symbol_date     ON stock_analysis(symbol, analysis_date DESC);
CREATE INDEX idx_analysis_date_score      ON stock_analysis(analysis_date, composite_score DESC);
CREATE INDEX idx_news_published           ON news_items(published_at DESC);
CREATE INDEX idx_news_bad                 ON news_items(is_bad_news) WHERE is_bad_news = TRUE;
CREATE INDEX idx_suggestions_date         ON suggestions_log(suggestion_date DESC, action);
CREATE INDEX idx_sector_health_date       ON sector_health(health_date DESC);
CREATE INDEX idx_transactions_portfolio   ON transactions(portfolio_id, executed_at DESC);
CREATE INDEX idx_backtest_trades_run      ON backtest_trades(run_id, trade_date);

-- ── Seed data ───────────────────────────────────────────────────────────────
INSERT INTO portfolios (name, total_capital, cash_balance, is_paper)
VALUES ('My Portfolio', 100000, 100000, TRUE);

INSERT INTO app_settings (key, value, value_type, description) VALUES
('stop_loss_pct',            '0.08', 'float', 'R13: exit when price falls this % below avg buy'),
('deterioration_score',      '0.35', 'float', 'R14: composite score floor'),
('deterioration_days',       '3',    'int',   'R14: consecutive days below floor before SELL'),
('trailing_profit_trigger',  '0.15', 'float', 'R15: gain % that arms trailing protection'),
('trailing_profit_giveback', '0.05', 'float', 'R15: giveback % from peak that triggers SELL'),
('nifty_fall_threshold',     '-0.10','float', 'R11: Nifty change % at/below this = no buying'),
('bad_news_headline_limit',  '3',    'int',   'R12: severe headlines today that pause the market'),
('max_daily_invest_pct',     '0.20', 'float', 'R8: max share of capital deployable per day');

-- The 9 tracked sectors, seeded so sector_health always has a frame
-- (populated with real scores by the engine each day)


-- ==========================================================================
-- insights_tables.sql - Portfolio snapshots + trade config log
-- ==========================================================================
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


-- ==========================================================================
-- users must exist before the pf_* tables below reference it. multiuser.sql
-- (later) repeats this with IF NOT EXISTS, so the duplicate is harmless.
-- ==========================================================================
CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(48) UNIQUE NOT NULL,
    display_name  VARCHAR(80),
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN DEFAULT FALSE,
    created_at    TIMESTAMPTZ DEFAULT now()
);


-- ==========================================================================
-- nse_catalog.sql - NSE symbol catalog
-- ==========================================================================
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


-- ==========================================================================
-- trades_tables.sql - Trade import: stocks, aliases, trades
-- ==========================================================================
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


-- ==========================================================================
-- trades_portfolios.sql - Named trade portfolios
-- ==========================================================================
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


-- ==========================================================================
-- trades_v3.sql - Trade import v3 columns
-- ==========================================================================
-- ══ TRADES v3 (new file format) — run once ═════════════════════════════════
--   Get-Content database/trades_v3.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
ALTER TABLE pf_stocks ADD COLUMN IF NOT EXISTS full_name VARCHAR(200);
SELECT 'trades v3 ready' AS status;


-- ==========================================================================
-- multiuser.sql - Users + per-user scoping (runs after the tables it alters)
-- ==========================================================================
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


-- ==========================================================================
-- fix_tickers.sql - Yahoo ticker drift corrections
-- ==========================================================================
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


-- ==========================================================================
-- bench_dead_tickers.sql - Disable symbols Yahoo 404s on
-- ==========================================================================
-- Bench the two tickers Yahoo genuinely 404s on (stops the error noise
-- on every engine run). Re-enable later if Yahoo restores them.
--   Get-Content database/bench_dead_tickers.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
UPDATE stock_universe SET is_active = FALSE, unbuyable_reason = 'Yahoo 404 — symbol unavailable'
WHERE symbol IN ('TATAMOTORS.NS', 'LTIM.NS');
SELECT symbol, is_active, unbuyable_reason FROM stock_universe
WHERE symbol IN ('TATAMOTORS.NS', 'LTIM.NS');


-- ==========================================================================
-- nlp_v1.sql - News prediction provenance (summary, model and linker versions)
-- ==========================================================================
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

-- ==========================================================================
-- mlops_v1.sql - Shadow-model predictions and champion confidence
-- ==========================================================================
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


-- ==========================================================================
-- research_v1.sql - Corpus annotation (Research tab)
-- ==========================================================================
-- == Research v1: corpus annotation from the Research tab - idempotent, safe to re-run ==
--   Get-Content database/research_v1.sql | docker exec -i stocksage_db psql -U stocksage -d stocksage
-- The API also applies these statements at startup (app/db/schema.py).

-- Which user is annotator A (labels the full sample) and B (the double subset).
CREATE TABLE IF NOT EXISTS annotation_roles (
    user_id  INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    role     CHAR(1) NOT NULL UNIQUE CHECK (role IN ('A', 'B'))
);

-- One label per headline per annotator. `prelabel` holds the LLM pre-label the
-- annotator was shown when the row was first saved (NULL = labelled from blank),
-- so import can mark the row human_verified and measure how often it was changed.
-- Exported with: python -m research.build_sample import-db --annotator A --to ...
CREATE TABLE IF NOT EXISTS annotations (
    id          SERIAL PRIMARY KEY,
    item_id     VARCHAR(64) NOT NULL,
    annotator   CHAR(1) NOT NULL CHECK (annotator IN ('A', 'B')),
    user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sentiment   VARCHAR(10) NOT NULL,
    events      JSONB NOT NULL,
    severity    VARCHAR(10) NOT NULL,
    scope       VARCHAR(10) NOT NULL,
    companies   JSONB NOT NULL DEFAULT '[]',
    sectors     JSONB NOT NULL DEFAULT '[]',
    notes       TEXT,
    prelabel    JSONB,
    seconds     REAL NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (item_id, annotator)
);
