import { api } from "./client";

// ── Options desk (buyer analysis) ───────────────────────────────────────────
export type Side = "CE" | "PE";
export type Action = "BUY_CALL" | "BUY_PUT" | "NO_TRADE" | "WAIT";

export interface Underlying { symbol: string; name: string; lot: number; kind: "INDEX" | "STOCK"; }
export interface Factor {
  key: string; group: string; label: string; value: number; weight: number;
  detail: string; available: boolean;
}
export interface Leg {
  ltp: number; bid: number; ask: number; iv: number; oi: number; chg_oi: number;
  volume: number; chg_pct: number; delta: number;
}
export interface ChainRow { strike: number; ce: Leg | null; pe: Leg | null; }
export interface SimResult {
  ev_pct: number; median_pct: number; p_profit: number; p_target: number; p_stop: number; ev_per_lot: number;
}
export interface Strike {
  strike: number; side: Side; tag: "ATM" | "ITM" | "OTM"; entry: number; ltp: number; bid: number; ask: number;
  iv: number; oi: number; chg_oi: number; volume: number; spread_pct: number | null; lot_cost: number;
  delta: number; gamma: number; theta: number; vega: number; theta_burn_pct: number;
  breakeven: number; breakeven_move_pct: number; pop_expiry: number;
  premium_t1: number; premium_t2: number; premium_stop: number; premium_flat: number;
  ret_t1_pct: number; ret_t2_pct: number; ret_stop_pct: number; ret_flat_pct: number;
  reward_risk: number | null; sim: { neutral: SimResult; signal: SimResult }; score: number;
  score_parts: { delta: number; ev: number; liquidity: number; reward_risk: number; theta: number };
}
export interface Plan {
  target1: number; target2: number; stop: number; sigma_move: number; holding_days: number; notes: string[];
}
export interface Headline {
  headline: string; source: string | null; url: string | null; sentiment: string | null;
  score: number; severity: number; published_at: string | null;
}
export interface OptionsAnalysis {
  symbol: string; name: string; kind: "INDEX" | "STOCK"; sector: string | null; lot_size: number;
  spot: number; change_pct: number; source: "NSE" | "MODELED"; data_timestamp: string | null;
  market_open: boolean; generated_at: string; warnings: string[];
  expiry: string; expiries: string[]; days_to_expiry: number; years_to_expiry: number;
  risk_free: number; carry_q: number; forward: number;
  verdict: {
    action: Action; side: Side; trade_score: number; grade: string; stance: string; reason: string | null;
    direction: number; suitability: number; confluence: number;
  };
  direction_factors: Factor[]; suitability_factors: Factor[];
  volatility: {
    atm_iv: number | null; hv20: number | null; hv60: number | null; iv_hv_ratio: number | null;
    hv_percentile: number | null; vix: number | null; vix_change_5d: number | null; model_sigma: number;
  };
  chain_metrics: {
    atm_strike: number; atm_iv: number | null; straddle: number | null; expected_move: number | null;
    expected_move_pct: number | null; range_low: number | null; range_high: number | null; has_oi: boolean;
    skew: number | null; pcr_oi: number | null; pcr_volume: number | null; max_pain: number | null;
    support: number | null; resistance: number | null; flow_balance: number | null;
    support_levels: { strike: number; oi: number }[]; resistance_levels: { strike: number; oi: number }[];
    total_ce_oi: number | null; total_pe_oi: number | null; chg_ce_oi: number | null; chg_pe_oi: number | null;
  };
  chain: ChainRow[];
  sides: Record<Side, { plan: Plan; strikes: Strike[] }>;
  recommended: Strike | null;
  narrative: { supporting: string[]; risks: string[]; invalidation: string[] };
  checklist: { label: string; ok: boolean; detail: string }[];
  sentiment: {
    count: number; avg: number; positive: number; negative: number; neutral: number;
    market_avg: number; market_overall: string | null; market_stopped: boolean; sector_blocked: boolean;
    guard_verdict: string | null; headlines: Headline[];
  };
  context: { rs_vs_nifty_20d: number | null; nifty_trend: string | null };
  event: string | null;
  technical: Record<string, any>;
  price_series: { date: string; close: number; ema20: number; ema50: number }[];
}
export interface ScanRow {
  symbol: string; name: string; kind: string; spot: number; change_pct: number; expiry: string;
  days_to_expiry: number; source: string; verdict: OptionsAnalysis["verdict"];
  atm_iv: number | null; iv_hv_ratio: number | null; pcr: number | null; news_count: number; news_avg: number;
  best: { strike: number; side: Side; entry: number; lot_cost: number; delta: number;
          ev_signal: number; ev_neutral: number; p_profit: number; ret_t1_pct: number } | null;
}

export const getUnderlyings = () =>
  api.get<{ indices: Underlying[]; stocks: Underlying[]; scan_universe: string[] }>("/api/options/underlyings")
    .then((r) => r.data);
export const getOptionsAnalysis = (symbol: string, expiry?: string) =>
  api.get<OptionsAnalysis>(`/api/options/analyze/${encodeURIComponent(symbol)}`,
    { params: expiry ? { expiry } : {} }).then((r) => r.data);
export const getOptionsScan = () =>
  api.get<{ generated_at: string; results: ScanRow[]; errors: { symbol: string; error: string }[] }>(
    "/api/options/scan").then((r) => r.data);
