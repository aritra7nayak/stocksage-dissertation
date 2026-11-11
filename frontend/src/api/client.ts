import axios from "axios";

// Same-origin by default: in dev the Vite proxy forwards /api to :8000, and in
// the single-container deployment FastAPI serves this bundle itself. Set
// VITE_API_URL at build time only when the API lives on a different host.
const BASE_URL = import.meta.env.VITE_API_URL ?? "";

export const api = axios.create({ baseURL: BASE_URL, timeout: 600_000 });

// Attach the session token to every request
api.interceptors.request.use((config) => {
  const token = localStorage.getItem("ss-token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});
// Any 401 → clear the session and return to the login screen
api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err?.response?.status === 401 && !String(err?.config?.url).includes("/api/auth/")) {
      localStorage.removeItem("ss-token");
      localStorage.removeItem("ss-user");
      window.location.href = "/";
    }
    return Promise.reject(err);
  }
);

export const authLogin = (username: string, password: string) =>
  api.post("/api/auth/login", { username, password }).then((r) => r.data);
export const authRegister = (username: string, password: string, display_name?: string) =>
  api.post("/api/auth/register", { username, password, display_name }).then((r) => r.data);

export interface SectorHealth {
  sector: string; score: number; status: "STRONG" | "NEUTRAL" | "WEAK";
  change_pct: number; avg_rsi: number; news_score: number; top_gainer: string | null;
}
export interface BuySuggestion {
  symbol: string; name: string; segment: string; sector: string; price: number;
  quantity: number; total_value: number; composite_score: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  scores: { technical: number; fundamental: number; sentiment: number };
  reasons: string[]; rules_passed: string[];
}
export interface Skipped { symbol: string; score: number; killed_by: string; reason: string; }
export interface DailyBrief {
  date: string; run_type: string; generated_at: string; duration_seconds: number;
  market_guard: {
    go_status: "GREEN" | "AMBER" | "RED"; nifty_fell: boolean; nifty_change_pct: number;
    guard_basis: string; bad_news_detected: boolean; blocked_sectors: string[];
    weak_sectors: string[]; go_message: string;
  };
  capital_status: {
    total: number; cash: number; invested_today: number; available_today: number;
    by_bucket: Record<string, { target: number; deployed: number }>;
  };
  sector_health: SectorHealth[];
  buy_suggestions: BuySuggestion[];
  sell_alerts: { symbol: string; rule: string; urgency: string; reason: string }[];
  hold: { symbol: string; note: string }[];
  skipped: Skipped[];
  news: { overall: string; avg_sentiment: number; headlines_today: number };
}
export interface NewsItem {
  headline: string; source: string; url: string; sentiment: string;
  sentiment_score: number; severity: number; is_bad_news: boolean; sectors: string[];
}
export interface Holding {
  id: number; symbol: string; name: string | null; qty: number; avg_buy: number; current: number;
  value: number; pnl: number; pnl_pct: number; segment: string; sector: string; low_score_streak: number;
}

// Single backtest runs
export interface BacktestRun {
  id: number; name: string; period: string; return_pct: number;
  nifty_pct: number; max_dd_pct: number; win_rate: number; trades: number;
}
/** Most recent runs, newest first. Unwraps the API's { runs: [...] } envelope. */
export const getBacktestRuns = () =>
  api.get<{ runs: BacktestRun[] }>("/api/backtest/runs").then((r) => r.data.runs);

// Multi-backtest
export interface BTTrade {
  symbol: string; action: string; trade_date: string; quantity: number;
  price: number; pnl: number | null; triggered_rule: string | null; reason: string;
}
export interface BTPeriod {
  window: string; run_id: number; period: string;
  strategy_return_pct: number; nifty_return_pct: number; alpha_pct: number;
  max_drawdown_pct: number; win_rate: number; total_trades: number;
  open_positions: number; final_value: number;
  equity_curve: { date: string; equity: number }[];
  trades: BTTrade[];
}
export interface MultiBacktest {
  generated_at: string; initial_capital: number;
  summary: {
    avg_alpha_pct: number; windows_beating_nifty: string; avg_max_drawdown_pct: number;
    avg_win_rate: number; best_window: string; worst_window: string; verdict: string;
  };
  periods: BTPeriod[]; notes: string[];
}

export const getDailyBrief = () => api.get<DailyBrief>("/api/daily-brief").then((r) => r.data);
export const runEngine = () => api.post<DailyBrief>("/api/engine/run").then((r) => r.data);
export const getNews = (limit = 30) =>
  api.get<{ items: NewsItem[] }>(`/api/news/feed?limit=${limit}`).then((r) => r.data.items);
export const getPortfolio = () =>
  api.get<{ total_capital: number; cash: number; holdings_value: number; holdings: Holding[] }>(
    "/api/portfolio/summary").then((r) => r.data);
export interface Preset {
  key: string; label: string; desc: string; stop_loss_pct: number; cash_reserve_pct: number;
}
export interface MultiStatus {
  status: "RUNNING" | "DONE" | "FAILED";
  stage: string; progress: number; preset: string;
  periods: BTPeriod[];
  summary: (MultiBacktest["summary"] & { preset: string; preset_desc: string }) | null;
  error: string | null; notes: string[];
}

export const getPresets = () =>
  api.get<{ presets: Preset[] }>("/api/backtest/presets").then((r) => r.data.presets);
export const startMultiBacktest = (preset: string) =>
  api.post<{ job_id: string; preset: string }>("/api/backtest/multi/start", {
    preset, initial_capital: 100000,
  }).then((r) => r.data);
export const pollMultiBacktest = (jobId: string) =>
  api.get<MultiStatus>(`/api/backtest/multi/status/${jobId}`).then((r) => r.data);

// ── Settings ────────────────────────────────────────────────────────────────
export interface SettingItem {
  key: string; label: string; group: string; type: "int" | "float";
  value: number; default: number; is_overridden: boolean;
}
export interface SettingsResponse {
  settings: SettingItem[]; allocation_sum: number; allocation_ok: boolean;
}
export const getSettings = () => api.get<SettingsResponse>("/api/settings").then((r) => r.data);
export const updateSettings = (values: Record<string, number>) =>
  api.put("/api/settings", { values }).then((r) => r.data);
export const applyPreset = (preset: string) =>
  api.post(`/api/settings/preset/${preset}`).then((r) => r.data);
export const resetSettings = () => api.post("/api/settings/reset").then((r) => r.data);

// ── Execution ───────────────────────────────────────────────────────────────
export const executeBuy = (suggestionId: number) =>
  api.post(`/api/execute/buy/${suggestionId}`).then((r) => r.data);
export const executeSell = (holdingId: number) =>
  api.post(`/api/execute/sell/${holdingId}`).then((r) => r.data);
export const buyManual = (symbol: string, quantity: number, price: number) =>
  api.post("/api/execute/buy-manual", { symbol, quantity, price }).then((r) => r.data);
export interface Txn {
  id: number; symbol: string; action: string; quantity: number;
  price: number; total: number; is_paper: boolean; reason: string; at: string | null;
}
export const getTransactions = (limit = 50) =>
  api.get<{ transactions: Txn[] }>(`/api/execute/transactions?limit=${limit}`).then((r) => r.data.transactions);

// suggestions/today returns logged suggestions with their DB ids (needed to execute)
export interface TodaySuggestion {
  id: number; symbol: string; action: string; segment: string; sector: string;
  quantity: number; price: number; total_value: number; score: number;
  confidence: string; was_acted_on: boolean;
}
export const getTodaySuggestions = () =>
  api.get<{ suggestions: TodaySuggestion[] }>("/api/suggestions/today").then((r) => r.data.suggestions);


// ── Deep-dive (Tier 2 / C) ──────────────────────────────────────────────────
export interface DeepDive {
  symbol: string; name: string; sector: string | null; segment: string | null; is_etf: boolean;
  current_price: number;
  price_series: { date: string; close: number; ema20: number; ema50: number }[];
  technical: any; fundamental: any;
  scores: { technical: number; fundamental: number; sentiment: number; composite: number };
  recommendation: string; news_sentiment: number;
  related_news: { headline: string; source: string; url: string; sentiment: string; sentiment_score: number; severity: number }[];
  peers: { symbol: string; name: string; segment: string }[];
}
export const getDeepDive = (symbol: string) =>
  api.get<DeepDive>(`/api/deepdive/${symbol}`).then((r) => r.data);

// ── Preset comparison (Tier 2 / D) ──────────────────────────────────────────
export interface ComparePreset {
  label: string; desc: string; stop_loss_pct: number; cash_reserve_pct: number;
  windows: { window: string; strategy_return_pct: number; nifty_return_pct: number; alpha_pct: number; max_drawdown_pct: number; win_rate: number; total_trades: number }[];
  avg_alpha: number; avg_drawdown: number; windows_beating: string;
}
export interface CompareStatus {
  status: "RUNNING" | "DONE" | "FAILED"; stage: string; progress: number;
  presets: Record<string, ComparePreset>;
  summary: { recommended: string; note: string } | null; error: string | null;
}
export const startCompare = () =>
  api.post<{ job_id: string }>("/api/backtest/compare/start", { initial_capital: 100000 }).then((r) => r.data);
export const pollCompare = (jobId: string) =>
  api.get<CompareStatus>(`/api/backtest/compare/status/${jobId}`).then((r) => r.data);

// ── Search + sector drill-down + guard evidence ─────────────────────────────
export interface SearchHit { symbol: string; name: string; sector: string | null; segment: string | null; }
export const searchStocks = (q: string) =>
  api.get<{ results: SearchHit[] }>(`/api/deepdive/search?q=${encodeURIComponent(q)}`).then((r) => r.data.results);

export interface SectorStock { symbol: string; name: string; segment: string; price: number; change_pct: number; }
export const getSectorStocks = (sector: string) =>
  api.get<{ stocks: SectorStock[] }>(`/api/deepdive/sector/${encodeURIComponent(sector)}/stocks`).then((r) => r.data.stocks);

export interface GuardEvidence { headline: string; severity: number; keywords: string[]; systemic: boolean; sectors: string[]; }
export interface GuardStatus {
  severe_count: number; systemic_count: number; market_stopped: boolean;
  blocked_sectors: string[]; evidence: GuardEvidence[]; verdict: string;
  headlines_today: number; avg_sentiment: number; overall: string;
}
export const getGuardStatus = () =>
  api.get<GuardStatus>("/api/news/guard-status").then((r) => r.data);

// ── Job history ─────────────────────────────────────────────────────────────
export interface HistoryEntry {
  name: string; kind: "multi" | "compare"; preset: string | null;
  finished_at: string | null; summary: any | null;
}
export const getJobHistory = () =>
  api.get<{ history: HistoryEntry[] }>("/api/backtest/multi/history").then((r) => r.data.history);
export const getJobHistoryItem = (name: string) =>
  api.get<any>(`/api/backtest/multi/history/${encodeURIComponent(name)}`).then((r) => r.data);

// ── Insights ────────────────────────────────────────────────────────────────
export interface EquityPoint { date: string; value: number; portfolio_pct: number; nifty_pct: number | null; }
export interface EquityCurve {
  points: EquityPoint[]; days_tracked: number; current_value: number;
  return_pct: number; nifty_return_pct: number | null; alpha_pct: number | null;
}
export const getEquityCurve = () => api.get<EquityCurve>("/api/insights/equity-curve").then((r) => r.data);

export interface JournalClosed { symbol: string; date: string | null; qty: number; exit_price: number; pnl_text: string; grade: string; note: string; }
export interface JournalOpen { symbol: string; qty: number; avg_buy: number; current: number; entry_score: number | null; }
export const getJournal = () => api.get<{ closed: JournalClosed[]; open: JournalOpen[] }>("/api/insights/journal").then((r) => r.data);

export interface RiskReport {
  has_holdings: boolean; total_value?: number; holdings_value?: number; cash_pct?: number;
  sectors?: { sector: string; pct: number; breach: boolean }[]; sector_cap_pct?: number;
  largest_position?: { symbol: string | null; pct: number }; portfolio_beta?: number | null;
  bad_day_estimate?: number; bad_day_note?: string;
}
export const getRisk = () => api.get<RiskReport>("/api/insights/risk").then((r) => r.data);

export const getDividends = () =>
  api.get<{ items: { symbol: string; per_share: number; qty: number; earned: number; payouts: number }[]; total: number; note: string }>("/api/insights/dividends").then((r) => r.data);

export interface WatchFlag { symbol: string; items: { type: string; detail: string }[]; }
export const getWatchFlags = () => api.get<{ flags: WatchFlag[] }>("/api/insights/watch").then((r) => r.data.flags);

export interface HealthReport {
  universe_active: number; universe_benched: number;
  benched: { symbol: string; reason: string | null }[];
  analyzed_today: number; missing_today: string[]; coverage_pct: number;
  news_today: number; last_engine_run: string | null; engine_ran_today: boolean;
}
export const getHealth = () => api.get<HealthReport>("/api/insights/health").then((r) => r.data);

export interface GuardDiary {
  red_days: { date: string; verdict: string | null; next_day_nifty_pct: number | null; justified: boolean | null }[];
  total_red: number; justified: number; note: string;
}
export const getGuardDiary = () => api.get<GuardDiary>("/api/insights/guard-diary").then((r) => r.data);

export const getFiiDii = () =>
  api.get<{ available: boolean; rows?: { category: string; date: string; buy: number; sell: number; net: number }[]; note?: string }>("/api/insights/fii-dii").then((r) => r.data);

// Walk-forward
export const startWalkforward = () =>
  api.post<{ job_id: string }>("/api/backtest/walkforward/start").then((r) => r.data);
export interface WalkforwardStatus {
  status: "RUNNING" | "DONE" | "FAILED"; stage: string; progress: number;
  results: Record<string, any>; summary: { consistent_presets: string[]; verdict: string } | null; error: string | null;
}
export const pollWalkforward = (id: string) =>
  api.get<WalkforwardStatus>(`/api/backtest/walkforward/status/${id}`).then((r) => r.data);
