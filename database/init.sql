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
