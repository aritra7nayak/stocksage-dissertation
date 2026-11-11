/**
 * Rules engine R1–R15 — app/rules/{base,buy_rules,sell_rules}.py.
 * Pure functions: no I/O, so the live engine and the backtester share them.
 */
import type { Settings } from "../config";
import { fmt, pyRound } from "../util/py";

export type Severity = "BLOCKER" | "FAIL" | "WARNING" | "PASS";

export interface RuleResult {
  rule_id: string;
  name: string;
  passed: boolean;
  reason: string;
  severity: Severity;
}

export interface BuyCandidate {
  symbol: string;
  segment: string;
  sector: string;
  price: number;
  composite_score: number;
  is_etf: boolean;
}

export interface PortfolioState {
  total_capital: number;
  cash_balance: number;
  invested_today: number;
  bucket_deployed: Record<string, number>;
  sector_deployed: Record<string, number>;
  held_symbols: Set<string>;
}

export interface MarketState {
  nifty_fell: boolean;
  nifty_change_pct: number;
  guard_basis: string;
  market_stopped: boolean;
  bad_headline_count: number;
  blocked_sectors: Set<string>;
  weak_sectors: Set<string>;
}

export interface BuyEvaluation {
  candidate: BuyCandidate;
  approved: boolean;
  quantity: number;
  total_cost: number;
  results: RuleResult[];
}

export interface SellEvaluation {
  symbol: string;
  should_sell: boolean;
  triggered_rule: string | null;
  reason: string;
  urgency: string;
}

export function marketState(p: Partial<MarketState> = {}): MarketState {
  return {
    nifty_fell: false, nifty_change_pct: 0, guard_basis: "previous session close",
    market_stopped: false, bad_headline_count: 0,
    blocked_sectors: new Set(), weak_sectors: new Set(), ...p,
  };
}

export const rulesPassed = (ev: BuyEvaluation) => ev.results.filter((r) => r.passed);
export const rulesFailed = (ev: BuyEvaluation) => ev.results.filter((r) => !r.passed);

const EQUITY = new Set(["NIFTY50", "NEXT100", "SMALLCAP"]);

export function equityDeployed(p: PortfolioState): number {
  let s = 0;
  for (const [k, v] of Object.entries(p.bucket_deployed)) if (EQUITY.has(k)) s += v;
  return s;
}

const R = (rule_id: string, name: string, passed: boolean, reason: string, severity: Severity): RuleResult =>
  ({ rule_id, name, passed, reason, severity });

const inr0 = (x: number) => `₹${fmt(x, ",.0f")}`;

// ── Buy rules ────────────────────────────────────────────────────────────────
export const SECTOR_CONCENTRATION_CAP = 0.35;
export const CONCENTRATION_MIN_DEPLOYED = 25_000;

export function bucketTarget(segment: string, totalCapital: number, s: Settings): number {
  const pct: Record<string, number> = {
    NIFTY50: s.nifty50_pct, NEXT100: s.nifty_next100_pct, SMALLCAP: s.smallcap_pct,
    GOLD_ETF: s.gold_silver_pct / 2, SILVER_ETF: s.gold_silver_pct / 2,
  };
  return pyRound(totalCapital * (pct[segment] ?? 0), 2);
}

export function ruleR11(m: MarketState): RuleResult {
  if (m.nifty_fell) {
    return R("R11", "Nifty guard", false,
      `Nifty is down ${fmt(m.nifty_change_pct, "+.2f")}% (${m.guard_basis}) — all buying paused today`, "BLOCKER");
  }
  return R("R11", "Nifty guard", true,
    `Nifty ${fmt(m.nifty_change_pct, "+.2f")}% (${m.guard_basis}) — buying permitted`, "PASS");
}

export function ruleR12Market(m: MarketState, s: Settings): RuleResult {
  if (m.market_stopped) {
    return R("R12", "Bad-news guard (market)", false,
      `${m.bad_headline_count} severe headlines today (limit ${s.bad_news_headline_limit}) — market paused, capital preserved`,
      "BLOCKER");
  }
  return R("R12", "Bad-news guard (market)", true,
    `${m.bad_headline_count} severe headlines — below pause threshold`, "PASS");
}

export function ruleR12Sector(c: BuyCandidate, m: MarketState): RuleResult {
  if (!c.is_etf && m.blocked_sectors.has(c.sector)) {
    return R("R12s", "Bad-news guard (sector)", false,
      `${c.sector} sector paused today due to severe negative news`, "FAIL");
  }
  return R("R12s", "Bad-news guard (sector)", true, `No news block on ${!c.is_etf ? c.sector : "ETFs"}`, "PASS");
}

export function ruleR10(c: BuyCandidate, m: MarketState): RuleResult {
  if (!c.is_etf && m.weak_sectors.has(c.sector)) {
    return R("R10", "Sector health", false,
      `${c.sector} is currently WEAK (negative momentum / sentiment) — skipping`, "FAIL");
  }
  return R("R10", "Sector health", true,
    !c.is_etf ? `${c.sector} sector health acceptable` : "ETF — sector health N/A", "PASS");
}

export function ruleDup(c: BuyCandidate, p: PortfolioState): RuleResult {
  if (p.held_symbols.has(c.symbol)) {
    return R("DUP", "Position discipline", false,
      `Already holding ${c.symbol} — not adding to avoid single-stock concentration`, "FAIL");
  }
  return R("DUP", "Position discipline", true, "New position", "PASS");
}

export function ruleBand(c: BuyCandidate, s: Settings): [RuleResult, number, number] {
  const [lo, hi] = c.is_etf ? [s.min_etf_purchase, s.max_etf_purchase] : [s.min_stock_purchase, s.max_stock_purchase];
  const [rid, name] = c.is_etf ? ["R7", "ETF purchase band"] : ["R6", "Stock purchase band"];
  if (c.price == null || !Number.isFinite(c.price) || c.price <= 0) {
    return [R(rid, name, false, `No valid price for ${c.symbol}`, "FAIL"), 0, 0];
  }
  if (c.price > hi) {
    return [R(rid, name, false,
      `One share costs ${inr0(c.price)} — exceeds band max ${inr0(hi)}; unbuyable under this rule`, "FAIL"), 0, 0];
  }
  const qty = Math.floor(hi / c.price);
  const cost = pyRound(qty * c.price, 2);
  if (cost < lo) {
    return [R(rid, name, false,
      `Best fit is ${qty} share(s) = ${inr0(cost)}, below band min ${inr0(lo)}`, "FAIL"), 0, 0];
  }
  return [R(rid, name, true,
    `${qty} share(s) × ₹${fmt(c.price, ",.2f")} = ${inr0(cost)} — inside ${inr0(lo)}–${inr0(hi)} band`, "PASS"), qty, cost];
}

export function ruleR8(cost: number, p: PortfolioState, s: Settings): RuleResult {
  const cap = p.total_capital * s.max_daily_invest_pct;
  const after = p.invested_today + cost;
  if (after > cap + 0.01) {
    return R("R8", "Daily investment limit", false,
      `${inr0(p.invested_today)} already deployed today; adding ${inr0(cost)} would exceed the daily cap of ${inr0(cap)}`,
      "FAIL");
  }
  return R("R8", "Daily investment limit", true, `${inr0(after)} of ${inr0(cap)} daily cap after this buy`, "PASS");
}

export function ruleBucket(c: BuyCandidate, cost: number, p: PortfolioState, s: Settings): RuleResult {
  const target = bucketTarget(c.segment, p.total_capital, s);
  const deployed = p.bucket_deployed[c.segment] ?? 0;
  const available = target - deployed;
  const rid = ({ NIFTY50: "R3", NEXT100: "R4", SMALLCAP: "R5", GOLD_ETF: "R2", SILVER_ETF: "R2" } as Record<string, string>)[c.segment] ?? "R?";
  if (cost > available + 0.01) {
    return R(rid, `${c.segment} bucket capacity`, false,
      `Bucket has ${inr0(available)} room (target ${inr0(target)}, deployed ${inr0(deployed)}) — ${inr0(cost)} doesn't fit`,
      "FAIL");
  }
  return R(rid, `${c.segment} bucket capacity`, true,
    `${inr0(cost)} fits — ${inr0(available - cost)} will remain in this bucket`, "PASS");
}

export function ruleR1(cost: number, p: PortfolioState, s: Settings): RuleResult {
  const reserve = p.total_capital * s.cash_reserve_pct;
  const cashAfter = p.cash_balance - cost;
  if (cashAfter < reserve - 0.01) {
    return R("R1", "Cash reserve", false,
      `Buy would leave ${inr0(cashAfter)} cash, below the ${inr0(reserve)} (20%) untouchable reserve`, "FAIL");
  }
  return R("R1", "Cash reserve", true,
    `${inr0(cashAfter)} cash remains after buy — reserve of ${inr0(reserve)} intact`, "PASS");
}

export function ruleR9(c: BuyCandidate, cost: number, p: PortfolioState): RuleResult {
  if (c.is_etf) return R("R9", "Sector diversification", true, "ETF — exempt", "PASS");
  const equityAfter = equityDeployed(p) + cost;
  if (equityAfter < CONCENTRATION_MIN_DEPLOYED) {
    return R("R9", "Sector diversification", true,
      "Portfolio still small — concentration cap not yet active", "PASS");
  }
  const sectorAfter = (p.sector_deployed[c.sector] ?? 0) + cost;
  const share = sectorAfter / equityAfter;
  if (share > SECTOR_CONCENTRATION_CAP) {
    return R("R9", "Sector diversification", false,
      `${c.sector} would become ${fmt(share, ".0%")} of equity (cap ${fmt(SECTOR_CONCENTRATION_CAP, ".0%")})`, "FAIL");
  }
  return R("R9", "Sector diversification", true,
    `${c.sector} at ${fmt(share, ".0%")} of equity after buy — within ${fmt(SECTOR_CONCENTRATION_CAP, ".0%")} cap`, "PASS");
}

/** Every buy rule in order, short-circuiting on the first failure. */
export function evaluateBuy(c: BuyCandidate, p: PortfolioState, m: MarketState, s: Settings): BuyEvaluation {
  const ev: BuyEvaluation = { candidate: c, approved: false, quantity: 0, total_cost: 0, results: [] };
  for (const r of [ruleR11(m), ruleR12Market(m, s)]) {
    ev.results.push(r);
    if (!r.passed) return ev;
  }
  for (const r of [ruleR12Sector(c, m), ruleR10(c, m), ruleDup(c, p)]) {
    ev.results.push(r);
    if (!r.passed) return ev;
  }
  const [band, qty, cost] = ruleBand(c, s);
  ev.results.push(band);
  if (!band.passed) return ev;
  for (const fn of [() => ruleR8(cost, p, s), () => ruleBucket(c, cost, p, s), () => ruleR1(cost, p, s), () => ruleR9(c, cost, p)]) {
    const r = fn();
    ev.results.push(r);
    if (!r.passed) return ev;
  }
  ev.approved = true;
  ev.quantity = qty;
  ev.total_cost = cost;
  return ev;
}

// ── Sell rules ───────────────────────────────────────────────────────────────
export function evaluateSell(symbol: string, avgBuy: number, current: number, peakPrice: number | null,
                             lowScoreStreak: number, s: Settings): SellEvaluation {
  const ev: SellEvaluation = { symbol, should_sell: false, triggered_rule: null, reason: "", urgency: "NONE" };
  if (avgBuy <= 0 || current <= 0) return ev;
  const peak = Math.max(peakPrice || 0, avgBuy, current);
  const pnl = current / avgBuy - 1;

  if (pnl <= -s.stop_loss_pct) {
    return {
      ...ev, should_sell: true, triggered_rule: "R13", urgency: "IMMEDIATE",
      reason: `STOP LOSS: ${symbol} is ${fmt(pnl, ".1%")} below your ₹${fmt(avgBuy, ",.2f")} average ` +
        `(limit −${fmt(s.stop_loss_pct, ".0%")}). Selling caps the damage; holding and hoping is how small losses become big ones.`,
    };
  }
  const peakGain = peak / avgBuy - 1;
  const giveback = peak > 0 ? 1 - current / peak : 0;
  if (peakGain >= s.trailing_profit_trigger && giveback >= s.trailing_profit_giveback) {
    return {
      ...ev, should_sell: true, triggered_rule: "R15", urgency: "HIGH",
      reason: `PROFIT PROTECT: ${symbol} peaked at ₹${fmt(peak, ",.2f")} (${fmt(peakGain, "+.0%")} on your buy) ` +
        `and has given back ${fmt(giveback, ".1%")} from that peak. Locking in the remaining ` +
        `${fmt(pnl, "+.1%")} gain before it erodes further.`,
    };
  }
  if (lowScoreStreak >= s.deterioration_days) {
    return {
      ...ev, should_sell: true, triggered_rule: "R14", urgency: "REVIEW",
      reason: `DETERIORATION: ${symbol}'s composite score has stayed below ${s.deterioration_score} for ` +
        `${lowScoreStreak} straight days — technicals, fundamentals or sentiment have weakened persistently. ` +
        `Current P&L ${fmt(pnl, "+.1%")}. Review and consider exiting.`,
    };
  }
  return { ...ev, reason: `${symbol} healthy: P&L ${fmt(pnl, "+.1%")}, no sell rule triggered.` };
}
