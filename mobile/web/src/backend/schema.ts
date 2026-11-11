/**
 * On-device SQLite schema — the Postgres schema (database/*.sql) collapsed to
 * one user. user_id columns are gone: the phone IS the user. Dates are
 * 'YYYY-MM-DD' text, timestamps ISO-8601 UTC text, JSON columns are text.
 *
 * Migrations are keyed on PRAGMA user_version; append, never edit, entries.
 */
import { db, log } from "./platform";
import { UNIVERSE } from "./market/universe";

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT 'My Portfolio',
      total_capital REAL NOT NULL DEFAULT 100000,
      cash_balance REAL NOT NULL DEFAULT 100000,
      is_paper INTEGER NOT NULL DEFAULT 1,
      created_at TEXT, updated_at TEXT)`,
    `CREATE TABLE stock_universe (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT UNIQUE NOT NULL, company_name TEXT, sector TEXT, industry TEXT,
      segment TEXT NOT NULL, market_cap REAL, is_active INTEGER DEFAULT 1,
      unbuyable_reason TEXT, added_at TEXT)`,
    `CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL, company_name TEXT,
      quantity INTEGER NOT NULL CHECK (quantity > 0),
      avg_buy_price REAL NOT NULL, current_price REAL, peak_price REAL,
      segment TEXT, sector TEXT, low_score_streak INTEGER NOT NULL DEFAULT 0,
      bought_at TEXT, updated_at TEXT,
      UNIQUE (portfolio_id, symbol))`,
    `CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_id INTEGER NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL, action TEXT NOT NULL CHECK (action IN ('BUY','SELL')),
      quantity INTEGER NOT NULL, price REAL NOT NULL, total_value REAL NOT NULL,
      is_paper INTEGER NOT NULL DEFAULT 1, suggestion_id INTEGER, reason TEXT, executed_at TEXT)`,
    `CREATE TABLE market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT UNIQUE NOT NULL,
      nifty50_open REAL, nifty50_close REAL, nifty50_change_pct REAL,
      sensex_open REAL, sensex_close REAL, sensex_change_pct REAL,
      gold_etf_price REAL, silver_etf_price REAL, market_status TEXT,
      nifty_fell INTEGER DEFAULT 0, is_intraday INTEGER DEFAULT 0,
      data_age_minutes INTEGER, created_at TEXT)`,
    `CREATE TABLE stock_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      symbol TEXT NOT NULL, analysis_date TEXT NOT NULL, current_price REAL,
      rsi_14 REAL, macd_hist REAL, macd_signal TEXT, ema_20 REAL, ema_50 REAL, ema_cross TEXT,
      bb_percent_b REAL, adx REAL, stoch_k REAL, volume_ratio REAL, momentum_20d REAL,
      dist_52w_high REAL, pe_ratio REAL, pb_ratio REAL, roe REAL, debt_to_equity REAL,
      revenue_growth REAL, profit_margin REAL, dividend_yield REAL,
      news_sentiment REAL, sector_sentiment REAL,
      technical_score REAL, fundamental_score REAL, sentiment_score REAL, composite_score REAL,
      recommendation TEXT, confidence TEXT, top_reasons TEXT,
      UNIQUE (symbol, analysis_date))`,
    `CREATE TABLE sector_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sector TEXT NOT NULL, health_date TEXT NOT NULL, score REAL, status TEXT,
      change_pct REAL, avg_rsi REAL, news_score REAL, top_gainer TEXT,
      is_blocked INTEGER DEFAULT 0, block_reason TEXT,
      UNIQUE (sector, health_date))`,
    `CREATE TABLE news_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT NOT NULL, url TEXT, source TEXT, sentiment TEXT, sentiment_score REAL,
      severity REAL DEFAULT 0, is_bad_news INTEGER DEFAULT 0,
      related_symbols TEXT, related_sectors TEXT,
      published_at TEXT, fetched_at TEXT, url_hash TEXT UNIQUE)`,
    `CREATE TABLE suggestions_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suggestion_date TEXT NOT NULL, run_type TEXT DEFAULT 'MORNING',
      portfolio_id INTEGER REFERENCES portfolios(id),
      symbol TEXT, action TEXT NOT NULL, segment TEXT, sector TEXT,
      suggested_quantity INTEGER, suggested_price REAL, total_value REAL,
      composite_score REAL, confidence TEXT,
      rules_passed TEXT, rules_failed TEXT, reasoning TEXT,
      was_acted_on INTEGER DEFAULT 0, created_at TEXT)`,
    `CREATE TABLE backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
      initial_capital REAL NOT NULL, final_value REAL, total_return_pct REAL,
      nifty_return_pct REAL, max_drawdown_pct REAL, win_rate REAL, total_trades INTEGER,
      rule_config TEXT, status TEXT DEFAULT 'PENDING', created_at TEXT, completed_at TEXT)`,
    `CREATE TABLE backtest_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL REFERENCES backtest_runs(id) ON DELETE CASCADE,
      symbol TEXT NOT NULL, action TEXT NOT NULL, trade_date TEXT NOT NULL,
      quantity INTEGER, price REAL, pnl REAL, triggered_rule TEXT, reason TEXT)`,
    `CREATE TABLE app_settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, value_type TEXT DEFAULT 'str',
      description TEXT, updated_at TEXT)`,
    `CREATE TABLE portfolio_snapshots (
      snapshot_date TEXT PRIMARY KEY, total_value REAL NOT NULL, cash REAL NOT NULL,
      holdings_value REAL NOT NULL, nifty_close REAL, guard_status TEXT, guard_verdict TEXT,
      created_at TEXT)`,
    `CREATE TABLE trade_config_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_id INTEGER, symbol TEXT,
      action TEXT, config TEXT, created_at TEXT)`,
    `CREATE TABLE nse_catalog (symbol TEXT PRIMARY KEY, company_name TEXT, updated_at TEXT)`,
    `CREATE TABLE pf_portfolios (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
      last_section INTEGER, created_at TEXT)`,
    `CREATE TABLE pf_stocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT NOT NULL,
      norm_key TEXT NOT NULL UNIQUE, symbol TEXT, full_name TEXT, created_at TEXT)`,
    `CREATE TABLE pf_aliases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, raw_norm TEXT NOT NULL UNIQUE,
      stock_id INTEGER REFERENCES pf_stocks(id) ON DELETE CASCADE)`,
    `CREATE TABLE pf_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      portfolio_ref INTEGER REFERENCES pf_portfolios(id) ON DELETE CASCADE,
      stock_id INTEGER REFERENCES pf_stocks(id) ON DELETE CASCADE,
      side TEXT NOT NULL, trade_date TEXT NOT NULL, qty REAL NOT NULL, price REAL NOT NULL,
      gross_value REAL, cost_value REAL, brokerage REAL, qty_remaining REAL,
      target_lot_id INTEGER, source TEXT DEFAULT 'IMPORT', dedup_hash TEXT, extras TEXT,
      created_at TEXT, UNIQUE (portfolio_ref, dedup_hash))`,
    // Phone-only: the brief survives app restarts so a background run's
    // result is on screen the moment the app opens.
    `CREATE TABLE briefs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, brief_date TEXT NOT NULL, run_type TEXT,
      generated_at TEXT, payload TEXT NOT NULL)`,
    `CREATE TABLE job_history (
      name TEXT PRIMARY KEY, kind TEXT, preset TEXT, finished_at TEXT, payload TEXT NOT NULL)`,
    `CREATE TABLE scheduled_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, run_type TEXT, started_at TEXT, finished_at TEXT,
      status TEXT, summary TEXT)`,
    `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE INDEX idx_holdings_portfolio ON holdings(portfolio_id)`,
    `CREATE INDEX idx_analysis_symbol_date ON stock_analysis(symbol, analysis_date DESC)`,
    `CREATE INDEX idx_news_fetched ON news_items(fetched_at DESC)`,
    `CREATE INDEX idx_suggestions_date ON suggestions_log(suggestion_date DESC, action)`,
    `CREATE INDEX idx_sector_health_date ON sector_health(health_date DESC)`,
    `CREATE INDEX idx_transactions_portfolio ON transactions(portfolio_id, executed_at DESC)`,
    `CREATE INDEX idx_backtest_trades_run ON backtest_trades(run_id, trade_date)`,
    `CREATE INDEX idx_briefs_date ON briefs(brief_date DESC, id DESC)`,
    `CREATE INDEX ix_pf_trades_pf ON pf_trades(portfolio_ref, stock_id)`,
  ],
];

export function nowIso(): string {
  return new Date().toISOString();
}

/** Create/upgrade the schema and seed first-run data. Idempotent. */
export function migrate(): void {
  const version = Number(db.scalar("PRAGMA user_version") ?? 0);
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.batch([
      ...MIGRATIONS[v].map((sql) => ({ sql })),
      { sql: `PRAGMA user_version = ${v + 1}` },
    ]);
    log("info", `Database migrated to v${v + 1}`);
  }
  seed();
}

function seed(): void {
  if (!db.scalar("SELECT COUNT(*) FROM portfolios")) {
    db.run(
      "INSERT INTO portfolios (name, total_capital, cash_balance, is_paper, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      ["My Portfolio", 100000, 100000, 1, nowIso(), nowIso()],
    );
  }
  // Universe: insert missing symbols only, so user edits (benching) survive.
  if (Number(db.scalar("SELECT COUNT(*) FROM stock_universe")) < UNIVERSE.length) {
    const ts = nowIso();
    db.batch(UNIVERSE.map(([symbol, name, sector, segment, active]) => ({
      sql: `INSERT INTO stock_universe (symbol, company_name, sector, segment, is_active, unbuyable_reason, added_at)
            VALUES (?,?,?,?,?,?,?) ON CONFLICT(symbol) DO NOTHING`,
      params: [symbol, name, sector, segment, active ? 1 : 0, active ? null : "Yahoo 404 — symbol unavailable", ts],
    })));
  }
}

/** Postgres NUMERIC(p, d) storage rounding — SQLite REAL keeps every float bit. */
export const numeric = (x: number | null | undefined, d = 2): number | null =>
  x == null || !Number.isFinite(Number(x)) ? null : Number(Number(x).toFixed(d));

/** Parse a JSON text column; tolerate nulls and junk. */
export function j<T = unknown>(v: unknown, fallback: T): T {
  if (v == null || v === "") return fallback;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}
