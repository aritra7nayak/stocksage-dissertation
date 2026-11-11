/**
 * Option-BUYER analysis engine — app/options/analysis.py. Pure functions.
 * DIRECTION (−100…+100) and BUYER SUITABILITY (0–100) from weighted,
 * explained factors; expected returns from a Monte Carlo that reprices the
 * option with Black-Scholes at each exit and pays the spread.
 */
import type { TechnicalSnapshot } from "../market/indicators";
import { fmt, pyRound } from "../util/py";
import { median, rollingStd, std } from "../util/series";
import { istInstant } from "../util/time";
import type { ChainRow, Leg } from "./nse";
import * as P from "./pricing";

export const MIN_DIRECTION = 20;
export const MIN_SUITABILITY = 40;
const N_PATHS = 4000;

export const clamp = (x: number, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
export const r_ = (x: number | null | undefined, nd = 2): number | null =>
  x == null || Number.isNaN(x) ? null : pyRound(x, nd);

export function timeToExpiry(expiry: string, nowMs = Date.now()): [number, number] {
  const days = Math.max((istInstant(expiry, 15, 30) - nowMs) / 86400000, 1 / 24);
  return [days / 365, days];
}

const logReturns = (close: number[]) => close.slice(1).map((c, i) => Math.log(c / close[i])).filter((x) => !Number.isNaN(x));

export function realisedVol(close: number[], n = 20): number {
  const r = logReturns(close);
  return r.length >= n ? std(r.slice(-n)) * Math.sqrt(252) : NaN;
}

export function hvPercentile(close: number[], n = 20): number | null {
  const roll = rollingStd(logReturns(close), n).filter((x) => !Number.isNaN(x)).map((x) => x * Math.sqrt(252));
  if (roll.length < 60) return null;
  const w = roll.slice(-252);
  const lastV = w[w.length - 1];
  return pyRound((w.filter((x) => x < lastV).length / w.length) * 100, 1);
}

const mid = (l: Leg | null) => (!l ? null : l.bid > 0 && l.ask > 0 ? (l.bid + l.ask) / 2 : l.ltp || null);

export function impliedCarry(rows: ChainRow[], spot: number, T: number): [number, number] {
  const fwds: number[] = [];
  for (const r of [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot)).slice(0, 3)) {
    const c = mid(r.ce), p = mid(r.pe);
    if (c && p) fwds.push(r.strike + (c - p) * Math.exp(P.RISK_FREE * T));
  }
  if (!fwds.length || T <= 0) return [0, spot * Math.exp(P.RISK_FREE * T)];
  const F = median(fwds);
  return [clamp(P.RISK_FREE - Math.log(F / spot) / T, -0.3, 0.3), F];
}

function legIv(row: ChainRow, kind: string, spot: number, T: number, q = 0): number | null {
  const leg = kind === "CE" ? row.ce : row.pe;
  if (!leg) return null;
  if (leg.iv) return leg.iv;
  return leg.ltp > 0 ? P.impliedVol(leg.ltp, spot, row.strike, T, kind, P.RISK_FREE, q) : null;
}

const argminBy = <T>(xs: T[], f: (x: T) => number) => {
  let bi = 0;
  for (let i = 1; i < xs.length; i++) if (f(xs[i]) < f(xs[bi])) bi = i;
  return bi;
};

export function chainMetrics(rows: ChainRow[], spot: number, T: number, hasOi: boolean, q = 0): Record<string, any> {
  const atmI = argminBy(rows, (r) => Math.abs(r.strike - spot));
  const atm = rows[atmI];
  const ivs = [legIv(atm, "CE", spot, T, q), legIv(atm, "PE", spot, T, q)].filter((v): v is number => !!v);
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const ceLtp = atm.ce?.ltp || 0, peLtp = atm.pe?.ltp || 0;
  const straddle = ceLtp && peLtp ? ceLtp + peLtp : null;
  const sigmaMove = atmIv ? spot * atmIv * Math.sqrt(T) : null;
  const expMove = straddle || sigmaMove;
  const out: Record<string, any> = {
    atm_strike: atm.strike, atm_iv: r_(atmIv ? atmIv * 100 : null, 2),
    straddle: r_(straddle), expected_move: r_(expMove),
    expected_move_pct: r_(expMove ? (expMove / spot) * 100 : null),
    range_low: r_(expMove ? spot - expMove : null), range_high: r_(expMove ? spot + expMove : null),
    has_oi: hasOi,
  };
  const m = Math.max((expMove || spot * 0.02) / spot, 0.01);
  const pRow = rows[argminBy(rows, (r) => Math.abs(r.strike - spot * (1 - m)))];
  const cRow = rows[argminBy(rows, (r) => Math.abs(r.strike - spot * (1 + m)))];
  const pIv = legIv(pRow, "PE", spot, T, q), cIv = legIv(cRow, "CE", spot, T, q);
  out.skew = r_(hasOi && pIv && cIv ? (pIv - cIv) * 100 : null);
  if (!hasOi) {
    Object.assign(out, { pcr_oi: null, pcr_volume: null, max_pain: null, support: null, resistance: null,
      flow_balance: null, support_levels: [], resistance_levels: [], total_ce_oi: null, total_pe_oi: null,
      chg_ce_oi: null, chg_pe_oi: null });
    return out;
  }
  const g = (r: ChainRow, k: "ce" | "pe", f: keyof Leg) => Number((r[k] as any)?.[f] || 0);
  const totCe = rows.reduce((a, r) => a + g(r, "ce", "oi"), 0), totPe = rows.reduce((a, r) => a + g(r, "pe", "oi"), 0);
  const volCe = rows.reduce((a, r) => a + g(r, "ce", "volume"), 0), volPe = rows.reduce((a, r) => a + g(r, "pe", "volume"), 0);
  const payout = (px: number) => rows.reduce((a, r) => a + g(r, "ce", "oi") * Math.max(0, px - r.strike) + g(r, "pe", "oi") * Math.max(0, r.strike - px), 0);
  const strikes = rows.map((r) => r.strike);
  const maxPain = strikes[argminBy(strikes, payout)];
  const below = rows.filter((r) => r.strike < spot).sort((a, b) => g(b, "pe", "oi") - g(a, "pe", "oi"));
  const above = rows.filter((r) => r.strike > spot).sort((a, b) => g(b, "ce", "oi") - g(a, "ce", "oi"));
  const support = below.length && g(below[0], "pe", "oi") ? below[0].strike : null;
  const resistance = above.length && g(above[0], "ce", "oi") ? above[0].strike : null;
  const near = rows.slice(Math.max(0, atmI - 8), atmI + 9);
  const dCe = near.reduce((a, r) => a + g(r, "ce", "chg_oi"), 0), dPe = near.reduce((a, r) => a + g(r, "pe", "chg_oi"), 0);
  const denom = Math.abs(dCe) + Math.abs(dPe);
  Object.assign(out, {
    pcr_oi: r_(totCe ? totPe / totCe : null, 3), pcr_volume: r_(volCe ? volPe / volCe : null, 3),
    max_pain: maxPain, support, resistance,
    support_levels: below.slice(0, 3).map((r) => ({ strike: r.strike, oi: g(r, "pe", "oi") })),
    resistance_levels: above.slice(0, 3).map((r) => ({ strike: r.strike, oi: g(r, "ce", "oi") })),
    total_ce_oi: totCe, total_pe_oi: totPe, chg_ce_oi: dCe, chg_pe_oi: dPe,
    flow_balance: r_(denom ? (dPe - dCe) / denom : 0, 3),
  });
  return out;
}

export interface Factor { key: string; group: string; label: string; value: number; weight: number; detail: string; available: boolean }

const factor = (key: string, group: string, label: string, value: number, weight: number, detail: string, available = true): Factor =>
  ({ key, group, label, value: available ? pyRound(clamp(value), 3) : 0, weight, detail, available });

export function directionFactors(a: { tech: TechnicalSnapshot; close: number[]; metrics: Record<string, any>; spot: number;
  days: number; sentiment: Record<string, any>; context: Record<string, any> }): Factor[] {
  const { tech, close, metrics, spot, days, sentiment, context } = a;
  const f: Factor[] = [];
  const price = close[close.length - 1];
  const e20 = tech.ema_20, e50 = tech.ema_50;
  let v: number, d: string;
  if (price > e20 && e20 > e50) [v, d] = [1, `Price ${fmt(price, ",.1f")} above EMA20 ${fmt(e20, ",.1f")} above EMA50 ${fmt(e50, ",.1f")} — clean uptrend`];
  else if (e20 > e50) [v, d] = [0.3, "Uptrend (EMA20 > EMA50) but price slipped under EMA20 — pullback"];
  else if (price > e20) [v, d] = [-0.3, "Bounce above EMA20 inside a downtrend (EMA20 < EMA50)"];
  else [v, d] = [-1, `Price below EMA20 ${fmt(e20, ",.1f")} and EMA50 ${fmt(e50, ",.1f")} — clean downtrend`];
  if (tech.ema_cross === "GOLDEN") [v, d] = [clamp(v + 0.3), `${d}; fresh golden cross`];
  else if (tech.ema_cross === "DEATH") [v, d] = [clamp(v - 0.3), `${d}; fresh death cross`];
  f.push(factor("trend", "Technical", "Trend (EMA 20/50)", v, 0.12, d));

  const macdV = tech.macd_signal === "BULLISH_CROSS" ? 1 : tech.macd_signal === "BEARISH_CROSS" ? -1 : tech.macd_hist > 0 ? 0.5 : -0.5;
  const momV = clamp(tech.momentum_20d / 0.06);
  const macdTxt = tech.macd_signal !== "NONE" ? tech.macd_signal.replace("_", " ").toLowerCase()
    : tech.macd_hist > 0 ? "histogram positive" : "histogram negative";
  f.push(factor("momentum", "Technical", "Momentum (MACD + 20d)", 0.6 * macdV + 0.4 * momV, 0.1,
    `MACD ${macdTxt}; 20-day move ${fmt(tech.momentum_20d * 100, "+.1f")}%`));

  const r = tech.rsi_14;
  if (r > 75) [v, d] = [0.1, `RSI ${fmt(r, ".0f")} — overbought; upside may be exhausted`];
  else if (r >= 55) [v, d] = [0.7, `RSI ${fmt(r, ".0f")} — bullish momentum zone`];
  else if (r >= 45) [v, d] = [0, `RSI ${fmt(r, ".0f")} — neutral`];
  else if (r >= 25) [v, d] = [-0.7, `RSI ${fmt(r, ".0f")} — bearish momentum zone`];
  else [v, d] = [-0.1, `RSI ${fmt(r, ".0f")} — oversold; a bounce can hurt puts`];
  f.push(factor("rsi", "Technical", "RSI (14)", v, 0.08, d));

  const hv = realisedVol(close);
  const r5 = close.length > 6 ? close[close.length - 1] / close[close.length - 6] - 1 : 0;
  const norm = hv && !Number.isNaN(hv) ? hv * Math.sqrt(5 / 252) : 0.03;
  f.push(factor("price_action", "Technical", "Last 5 sessions", r5 / (1.5 * norm), 0.05,
    `${fmt(r5 * 100, "+.2f")}% over 5 sessions (${fmt(r5 / norm, "+.1f")}σ)`));

  const na = "No live open-interest data (modeled chain)";
  const pcr = metrics.pcr_oi;
  if (pcr == null) f.push(factor("pcr", "Options flow", "Put-Call Ratio (OI)", 0, 0.08, na, false));
  else {
    if (pcr > 1.5) [v, d] = [0.3, `PCR ${fmt(pcr, ".2f")} — very heavy put writing; bullish but stretched (contrarian risk)`];
    else if (pcr > 1.2) [v, d] = [0.7, `PCR ${fmt(pcr, ".2f")} — put writers confident: bullish`];
    else if (pcr > 1.0) [v, d] = [0.3, `PCR ${fmt(pcr, ".2f")} — mildly bullish`];
    else if (pcr > 0.8) [v, d] = [-0.2, `PCR ${fmt(pcr, ".2f")} — neutral to mildly bearish`];
    else if (pcr > 0.5) [v, d] = [-0.7, `PCR ${fmt(pcr, ".2f")} — call writers dominate: bearish`];
    else [v, d] = [-0.3, `PCR ${fmt(pcr, ".2f")} — extreme call writing; bearish but oversold`];
    f.push(factor("pcr", "Options flow", "Put-Call Ratio (OI)", v, 0.08, d));
  }
  const fb = metrics.flow_balance;
  if (fb == null) f.push(factor("oi_flow", "Options flow", "Fresh OI near ATM", 0, 0.08, na, false));
  else {
    const side = fb > 0.1 ? "put writing (bullish)" : fb < -0.1 ? "call writing (bearish)" : "balanced";
    f.push(factor("oi_flow", "Options flow", "Fresh OI near ATM", fb, 0.08,
      `Δ put OI ${fmt(metrics.chg_pe_oi, "+,")} vs Δ call OI ${fmt(metrics.chg_ce_oi, "+,")} — ${side}`));
  }
  const sup = metrics.support, res = metrics.resistance;
  if (sup && res && res > sup) {
    const pos = (spot - sup) / (res - sup);
    f.push(factor("sr_room", "Options flow", "Room between OI walls", 1 - 2 * pos, 0.07,
      `Spot is ${fmt(pos * 100, ".0f")}% of the way from put wall ${fmt(sup, ",.0f")} to call wall ${fmt(res, ",.0f")}` +
      (pos < 0.45 ? " — more room to rise" : pos > 0.55 ? " — more room to fall" : "")));
  } else f.push(factor("sr_room", "Options flow", "Room between OI walls", 0, 0.07, na, false));
  const mp = metrics.max_pain, em = metrics.expected_move;
  if (mp && em) {
    const pull = ((mp - spot) / em) * (days <= 7 ? 1 : 0.5);
    f.push(factor("max_pain", "Options flow", "Max-pain pull", pull, 0.04,
      `Max pain ${fmt(mp, ",.0f")} is ${fmt((mp / spot - 1) * 100, "+.2f")}% from spot` + (days <= 7 ? "" : " (weak pull this far from expiry)")));
  } else f.push(factor("max_pain", "Options flow", "Max-pain pull", 0, 0.04, na, false));
  const skew = metrics.skew;
  if (skew == null) f.push(factor("skew", "Options flow", "Volatility skew", 0, 0.03, "Skew unavailable", false));
  else f.push(factor("skew", "Options flow", "Volatility skew", -skew / 4, 0.03,
    `OTM puts ${fmt(skew, "+.1f")} IV points vs OTM calls — ` +
    (skew > 1.5 ? "hedging demand / fear" : skew < -1.5 ? "call chasing / greed" : "balanced")));

  const n = sentiment.count, avg = sentiment.avg;
  if (n) {
    const conf = Math.min(1, n / 4);
    f.push(factor("news", "Sentiment", "FinBERT news sentiment", 1.5 * avg * conf, 0.12,
      `${n} relevant headline${n !== 1 ? "s" : ""}, average ${fmt(avg, "+.2f")}` + (conf === 1 ? "" : " (few headlines — damped)")));
  } else f.push(factor("news", "Sentiment", "FinBERT news sentiment", 0, 0.12, "No relevant headlines in the last 3 days", false));
  if (sentiment.market_stopped) f.push(factor("news_risk", "Sentiment", "Bad-news guard (R12)", -1, 0.08, "Systemic bad-news event today — market-wide risk-off"));
  else if (sentiment.sector_blocked) f.push(factor("news_risk", "Sentiment", "Bad-news guard (R12)", -0.7, 0.08, "Severe negative news in this sector today"));
  else {
    const ma = sentiment.market_avg || 0;
    f.push(factor("news_risk", "Sentiment", "Market news tone", 2 * ma * 0.6, 0.08, `No severe-news blocks; market headline tone ${fmt(ma, "+.2f")}`));
  }
  for (const c of context.factors) f.push(factor(c.key, "Market context", c.label, c.value, c.weight, c.detail));
  return f;
}

export function suitabilityFactors(a: { tech: TechnicalSnapshot; metrics: Record<string, any>; hv20: number; days: number;
  liquidity: { spread_pct: number | null }; event: string | null; vix: number | null }): Factor[] {
  const { tech, metrics, hv20, days, liquidity, event, vix } = a;
  const f: Factor[] = [];
  const atmIv = (metrics.atm_iv || 0) / 100;
  let v: number, d: string;
  if (atmIv && hv20 && !Number.isNaN(hv20)) {
    const ratio = atmIv / hv20;
    v = ratio <= 0.9 ? 1 : ratio <= 1.1 ? 0.75 : ratio <= 1.3 ? 0.45 : ratio <= 1.6 ? 0.2 : 0;
    d = `IV ${fmt(atmIv * 100, ".1f")}% vs realised ${fmt(hv20 * 100, ".1f")}% (×${fmt(ratio, ".2f")}) — ` +
      (ratio <= 0.9 ? "options are cheap" : ratio <= 1.1 ? "fairly priced" : ratio <= 1.3 ? "premium is rich" : "premium is expensive — IV crush risk");
    if (vix) d += `; India VIX ${fmt(vix, ".1f")}`;
    f.push(factor("iv_cheap", "Buyer fit", "Premium cost (IV vs realised)", v, 0.25, d));
  } else f.push(factor("iv_cheap", "Buyer fit", "Premium cost (IV vs realised)", 0.5, 0.25, "IV unavailable — assumed fair"));
  const adx = tech.adx;
  v = adx > 30 ? 1 : adx > 25 ? 0.8 : adx > 20 ? 0.55 : 0.3;
  f.push(factor("trend_strength", "Buyer fit", "Trend strength (ADX)", v, 0.25, `ADX ${fmt(adx, ".0f")} — ` +
    (adx > 25 ? "strong trend: moves follow through" : adx > 20 ? "moderate trend" : "weak/rangebound: theta eats buyers")));
  if (days <= 1) [v, d] = [0.1, "Expiry within a day — pure gamma gamble, decay is brutal"];
  else if (days <= 3) [v, d] = [0.4, `${fmt(days, ".1f")} days left — heavy daily decay`];
  else if (days <= 7) [v, d] = [0.75, `${fmt(days, ".1f")} days left — workable for a quick move`];
  else if (days <= 35) [v, d] = [1, `${fmt(days, ".0f")} days left — room for the thesis to play out`];
  else [v, d] = [0.8, `${fmt(days, ".0f")} days left — slow decay but more capital tied up`];
  f.push(factor("time", "Buyer fit", "Time to expiry", v, 0.2, d));
  const sp = liquidity.spread_pct;
  if (sp == null) f.push(factor("liquidity", "Buyer fit", "Liquidity (ATM spread)", 0.5, 0.15, "No live quotes — check bid/ask in your broker before buying"));
  else {
    v = sp <= 1 ? 1 : sp <= 2 ? 0.75 : sp <= 4 ? 0.45 : 0.15;
    f.push(factor("liquidity", "Buyer fit", "Liquidity (ATM spread)", v, 0.15,
      `ATM bid/ask spread ${fmt(sp, ".2f")}% of premium` + (sp <= 2 ? "" : " — you lose this on entry and exit")));
  }
  if (event) f.push(factor("event", "Buyer fit", "Event risk", 0.3, 0.15, `Results due ${event} before this expiry — IV usually collapses right after`));
  else f.push(factor("event", "Buyer fit", "Event risk", 1, 0.15, "No scheduled results before expiry"));
  return f;
}

export function weighted(fs: Factor[]): number {
  const live = fs.filter((x) => x.available);
  const w = live.reduce((a, x) => a + x.weight, 0);
  return w ? live.reduce((a, x) => a + x.value * x.weight, 0) / w : 0;
}

export function confluence(fs: Factor[], sign: number): number {
  const live = fs.filter((x) => x.available && Math.abs(x.value) >= 0.1);
  const w = live.reduce((a, x) => a + x.weight, 0);
  const agree = live.filter((x) => (x.value > 0) === (sign > 0)).reduce((a, x) => a + x.weight, 0);
  return w ? pyRound((agree / w) * 100, 0) : 0;
}

export function holdingDays(days: number): number {
  const h = Math.min(Math.max(1, pyRound(days * 0.4)), 7);
  return h < days ? h : Math.max(days * 0.5, 0.1);
}

export function underlyingPlan(side: string, spot: number, sigma: number, h: number, support: number | null, resistance: number | null) {
  const sH = spot * sigma * Math.sqrt(h / 365);
  const notes: string[] = [];
  let t1: number, t2: number, stop: number;
  if (side === "CE") {
    [t1, t2, stop] = [spot + sH, spot + 1.8 * sH, spot - 0.6 * sH];
    if (resistance && spot + 0.4 * sH < resistance && resistance < t1) { t1 = resistance; notes.push("Target 1 capped at the call-OI wall (resistance)"); }
    if (support && spot - sH <= support && support < spot - 0.3 * sH) { stop = support - 0.1 * sH; notes.push("Stop placed just below the put-OI wall (support)"); }
  } else {
    [t1, t2, stop] = [spot - sH, spot - 1.8 * sH, spot + 0.6 * sH];
    if (support && t1 < support && support < spot - 0.4 * sH) { t1 = support; notes.push("Target 1 capped at the put-OI wall (support)"); }
    if (resistance && spot + 0.3 * sH < resistance && resistance <= spot + sH) { stop = resistance + 0.1 * sH; notes.push("Stop placed just above the call-OI wall (resistance)"); }
  }
  return { target1: pyRound(t1, 2), target2: pyRound(t2, 2), stop: pyRound(stop, 2), sigma_move: pyRound(sH, 2),
    holding_days: pyRound(h, 1), notes };
}

/** Seeded PRNG (mulberry32) + Box–Muller: deterministic, like the server's fixed seed. */
function normals(seed: number, count: number): Float64Array {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float64Array(count);
  for (let i = 0; i < count; i += 2) {
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    const rad = Math.sqrt(-2 * Math.log(u1));
    out[i] = rad * Math.cos(2 * Math.PI * u2);
    if (i + 1 < count) out[i + 1] = rad * Math.sin(2 * Math.PI * u2);
  }
  return out;
}

/** (N_PATHS × steps) underlying paths with antithetic pairs. */
function simulate(spot: number, sigma: number, h: number, steps: number, driftTotal: number, seed = 7): number[][] {
  const dt = h / 365 / steps;
  const half = N_PATHS / 2;
  const z = normals(seed, half * steps);
  const paths: number[][] = [];
  for (const sgn of [1, -1]) {
    for (let p = 0; p < half; p++) {
      const row: number[] = [];
      let acc = 0;
      for (let k = 0; k < steps; k++) {
        acc += driftTotal / steps - 0.5 * sigma * sigma * dt + sigma * Math.sqrt(dt) * sgn * z[p * steps + k];
        row.push(spot * Math.exp(acc));
      }
      paths.push(row);
    }
  }
  return paths;
}

function exitValues(paths: number[][], side: string, K: number, T: number, h: number, sigma: number,
                    plan: { target1: number; stop: number }, halfSpread: number, q: number) {
  const steps = paths[0].length;
  const big = steps + 1;
  const S: number[] = [], Te: number[] = [], target: boolean[] = [], stop: boolean[] = [];
  for (const p of paths) {
    let ft = big, fs = big;
    for (let k = 0; k < steps; k++) {
      const hitT = side === "CE" ? p[k] >= plan.target1 : p[k] <= plan.target1;
      const hitS = side === "CE" ? p[k] <= plan.stop : p[k] >= plan.stop;
      if (hitT && ft === big) ft = k;
      if (hitS && fs === big) fs = k;
    }
    const ei = Math.min(ft, fs, steps - 1);
    S.push(p[ei]);
    Te.push(T - ((ei + 1) * (h / steps)) / 365);
    target.push(ft < fs);
    stop.push(fs < ft);
  }
  const value = P.bsPriceVec(S, K, Te, sigma, side, P.RISK_FREE, q).map((x) => Math.max(0, x - halfSpread));
  return { value, target, stop };
}

const meanOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const shareTrue = (xs: boolean[]) => xs.filter(Boolean).length / xs.length;

export function evaluateStrike(a: { side: string; row: ChainRow; spot: number; T: number; days: number; lot: number;
  plan: ReturnType<typeof underlyingPlan>; direction: number; fallbackIv: number; paths: Record<string, number[][]>;
  maxOi: number; hasQuotes: boolean; q: number; atmStrike: number }) {
  const { side, row, spot, T, lot, plan, fallbackIv, paths, maxOi, hasQuotes, q, atmStrike } = a;
  const leg = side === "CE" ? row.ce : row.pe;
  if (!leg) return null;
  const K = row.strike;
  const entry = hasQuotes && leg.ask > 0 ? leg.ask : leg.ltp;
  if (entry < 0.5) return null;
  const bid = hasQuotes ? leg.bid : 0;
  const spread = hasQuotes && bid > 0 && leg.ask > 0 ? leg.ask - bid : null;
  const midP = spread !== null ? (leg.ask + bid) / 2 : entry;
  const spreadPct = spread !== null && midP ? (spread / midP) * 100 : null;
  const halfSpread = spread !== null ? spread / 2 : entry * 0.005;
  const iv = (hasQuotes ? P.impliedVol(midP, spot, K, T, side, P.RISK_FREE, q) : null)
    || leg.iv || P.impliedVol(entry, spot, K, T, side, P.RISK_FREE, q) || fallbackIv;
  const g = P.greeks(spot, K, T, iv, side, P.RISK_FREE, q);
  const h = plan.holding_days;
  const be = side === "CE" ? K + entry : K - entry;
  let pop = P.probFinishAbove(spot, be, T, iv, P.RISK_FREE, q);
  pop = side === "CE" ? pop : 1 - pop;
  const tHalf = Math.max(T - (h * 0.5) / 365, 1e-6), tEnd = Math.max(T - h / 365, 1e-6);
  const pT1 = P.bsPrice(plan.target1, K, tHalf, iv, side, P.RISK_FREE, q) - halfSpread;
  const pT2 = P.bsPrice(plan.target2, K, tEnd, iv, side, P.RISK_FREE, q) - halfSpread;
  const pSl = Math.max(0, P.bsPrice(plan.stop, K, tHalf, iv, side, P.RISK_FREE, q) - halfSpread);
  const pFlat = Math.max(0, P.bsPrice(spot, K, tEnd, iv, side, P.RISK_FREE, q) - halfSpread);
  const sims: Record<string, any> = {};
  for (const [name, p] of Object.entries(paths)) {
    const ev = exitValues(p, side, K, T, h, iv, plan, halfSpread, q);
    const ret = ev.value.map((x) => x / entry - 1);
    sims[name] = {
      ev_pct: pyRound(meanOf(ret) * 100, 1), median_pct: pyRound(median(ret) * 100, 1),
      p_profit: pyRound((ret.filter((x) => x > 0).length / ret.length) * 100, 1),
      p_target: pyRound(shareTrue(ev.target) * 100, 1), p_stop: pyRound(shareTrue(ev.stop) * 100, 1),
      ev_per_lot: pyRound(meanOf(ret) * entry * lot, 0),
    };
  }
  const gain = pT1 - entry, loss = entry - pSl;
  const rr = loss > 0 ? gain / loss : null;
  const ad = Math.abs(g.delta);
  const deltaS = ad >= 0.4 && ad <= 0.6 ? 1 : ad >= 0.3 && ad <= 0.75 ? 0.7 : ad >= 0.2 ? 0.4 : 0.15;
  const evS = clamp((sims.signal.ev_pct / 100 + 0.2) / 0.6, 0, 1);
  let liqS: number;
  if (spreadPct === null) liqS = 0.5;
  else {
    const spS = spreadPct <= 1 ? 1 : spreadPct <= 2 ? 0.75 : spreadPct <= 4 ? 0.45 : 0.15;
    liqS = 0.6 * spS + 0.4 * Math.sqrt(maxOi ? leg.oi / maxOi : 0);
  }
  const rrS = clamp((rr || 0) / 2.5, 0, 1);
  const burn = (Math.abs(g.theta) / entry) * 100;
  const thS = burn <= 2 ? 1 : burn <= 4 ? 0.7 : burn <= 7 ? 0.4 : 0.15;
  const score = 100 * (0.25 * deltaS + 0.25 * evS + 0.2 * liqS + 0.15 * rrS + 0.15 * thS);
  const moneyness = ((spot - K) / spot) * (side === "CE" ? 1 : -1);
  const tag = K === atmStrike ? "ATM" : moneyness > 0 ? "ITM" : "OTM";
  return {
    strike: K, side, tag, entry: pyRound(entry, 2), ltp: leg.ltp, bid: leg.bid, ask: leg.ask, iv: pyRound(iv * 100, 2),
    oi: leg.oi, chg_oi: leg.chg_oi, volume: leg.volume, spread_pct: r_(spreadPct), lot_cost: pyRound(entry * lot, 0),
    delta: pyRound(g.delta, 3), gamma: pyRound(g.gamma, 5), theta: pyRound(g.theta, 2), vega: pyRound(g.vega, 2),
    theta_burn_pct: pyRound(burn, 2), breakeven: pyRound(be, 2), breakeven_move_pct: pyRound((be / spot - 1) * 100, 2),
    pop_expiry: pyRound(pop * 100, 1), premium_t1: pyRound(Math.max(0, pT1), 2), premium_t2: pyRound(Math.max(0, pT2), 2),
    premium_stop: pyRound(pSl, 2), premium_flat: pyRound(pFlat, 2),
    ret_t1_pct: pyRound((pT1 / entry - 1) * 100, 1), ret_t2_pct: pyRound((pT2 / entry - 1) * 100, 1),
    ret_stop_pct: pyRound((pSl / entry - 1) * 100, 1), ret_flat_pct: pyRound((pFlat / entry - 1) * 100, 1),
    reward_risk: r_(rr), sim: sims, score: pyRound(score, 1),
    score_parts: { delta: pyRound(deltaS, 2), ev: pyRound(evS, 2), liquidity: pyRound(liqS, 2), reward_risk: pyRound(rrS, 2), theta: pyRound(thS, 2) },
  };
}

export function rankStrikes(a: { side: string; rows: ChainRow[]; spot: number; T: number; days: number; lot: number;
  metrics: Record<string, any>; direction: number; sigma: number; hasQuotes: boolean; q: number }) {
  const { side, rows, spot, T, days, lot, metrics, direction, sigma, hasQuotes, q } = a;
  const h = holdingDays(days);
  const plan = underlyingPlan(side, spot, sigma, h, metrics.support, metrics.resistance);
  const steps = Math.max(1, Math.ceil(h));
  const sH = sigma * Math.sqrt(h / 365);
  const fair = ((P.RISK_FREE - q) * h) / 365;
  const tilt = (direction / 100) * 0.5 * sH;
  const paths = { neutral: simulate(spot, sigma, h, steps, fair), signal: simulate(spot, sigma, h, steps, fair + tilt) };
  const atmI = argminBy(rows, (r) => Math.abs(r.strike - spot));
  const [lo, hi] = side === "CE" ? [atmI - 2, atmI + 6] : [atmI - 5, atmI + 3];
  const window = rows.slice(Math.max(0, lo), hi);
  const key = side === "CE" ? "ce" : "pe";
  const maxOi = Math.max(0, ...window.map((r) => (r[key]?.oi ?? 0)));
  const out = [];
  for (const r of window) {
    const e = evaluateStrike({ side, row: r, spot, T, days, lot, plan, direction, fallbackIv: sigma, paths, maxOi,
      hasQuotes, q, atmStrike: rows[atmI].strike });
    if (e) out.push(e);
  }
  out.sort((x, y) => y.score - x.score);
  return { plan, strikes: out };
}

export function verdict(direction: number, suitability: number) {
  const side = direction > 0 ? "CE" : "PE";
  const tradeScore = pyRound(0.6 * Math.abs(direction) + 0.4 * suitability);
  let action: string, why: string | null = null;
  if (Math.abs(direction) < MIN_DIRECTION) {
    action = "NO_TRADE";
    why = "No directional edge — sideways markets bleed option buyers through time decay. Wait for a clearer setup.";
  } else if (suitability < MIN_SUITABILITY) {
    action = "WAIT";
    why = "Direction is there, but conditions are hostile to buyers (expensive premium, weak trend or too little time). Wait or size very small.";
  } else action = side === "CE" ? "BUY_CALL" : "BUY_PUT";
  let grade = tradeScore >= 75 ? "A" : tradeScore >= 60 ? "B" : tradeScore >= 45 ? "C" : "D";
  if (action === "NO_TRADE" || action === "WAIT") grade = "—";
  const stance = direction >= 45 ? "Strongly bullish" : direction >= MIN_DIRECTION ? "Bullish"
    : direction <= -45 ? "Strongly bearish" : direction <= -MIN_DIRECTION ? "Bearish" : "Neutral";
  return { action, side, trade_score: tradeScore, grade, stance, reason: why };
}

export function narrative(fs: Factor[], side: string, plan: ReturnType<typeof underlyingPlan>, best: any, symbol: string) {
  const sign = side === "CE" ? 1 : -1;
  const live = fs.filter((x) => x.available);
  const pro = live.filter((x) => x.value * sign > 0.05).sort((a, b) => b.value * sign * b.weight - a.value * sign * a.weight);
  const con = live.filter((x) => x.value * sign < -0.05).sort((a, b) => a.value * sign * a.weight - b.value * sign * b.weight);
  const word = side === "CE" ? "above" : "below", against = side === "CE" ? "below" : "above";
  const inval = [`${symbol} closes ${against} ${fmt(plan.stop, ",.2f")} (the stop level)`,
    `No progress ${word} ${fmt(plan.target1, ",.2f")} within ~${fmt(plan.holding_days, ".0f")} day(s) — time decay wins`];
  if (best) inval.push(`Premium falls to ₹${fmt(best.premium_stop, ",.2f")} (${fmt(best.ret_stop_pct, "+.0f")}%)`);
  return { supporting: pro.slice(0, 4).map((x) => `${x.label}: ${x.detail}`),
    risks: con.slice(0, 4).map((x) => `${x.label}: ${x.detail}`), invalidation: inval };
}

export function checklist(a: { direction: number; conf: number; metrics: Record<string, any>; hv20: number; days: number;
  best: any; event: string | null; guardClear: boolean }) {
  const { direction, conf, metrics, hv20, days, best, event, guardClear } = a;
  const atmIv = (metrics.atm_iv || 0) / 100;
  const ratio = atmIv && hv20 && !Number.isNaN(hv20) ? atmIv / hv20 : null;
  const items: [string, boolean, string][] = [
    ["Clear direction (|score| ≥ 20)", Math.abs(direction) >= MIN_DIRECTION, `Direction ${fmt(direction, "+.0f")}`],
    ["Factors agree (confluence ≥ 60%)", conf >= 60, `${fmt(conf, ".0f")}% of weighted signals agree`],
    ["Premium not expensive (IV ≤ 1.25× realised)", ratio !== null && ratio <= 1.25, ratio ? `IV/HV ×${fmt(ratio, ".2f")}` : "IV unavailable"],
    ["At least 3 days to expiry", days >= 3, `${fmt(days, ".1f")} days left`],
    ["Tight spread on chosen strike (≤ 2%)", !!(best && best.spread_pct != null && best.spread_pct <= 2),
      best && best.spread_pct != null ? `${fmt(best.spread_pct, ".2f")}%` : "No live quote"],
    ["No results before expiry", !event, event ? `Results ${event}` : "None scheduled"],
    ["Bad-news guard clear", guardClear, guardClear ? "No severe market/sector news" : "Severe news flagged"],
    ["Positive expected value if the analysis is right", !!(best && best.sim.signal.ev_pct > 0),
      best ? `${fmt(best.sim.signal.ev_pct, "+.1f")}%` : "—"],
  ];
  return items.map(([label, ok, detail]) => ({ label, ok, detail }));
}
