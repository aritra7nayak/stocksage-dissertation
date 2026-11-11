/**
 * Engine core — app/engine/{scoring,sector_health,planner}.py.
 * composite = 0.40·technical + 0.35·fundamental + 0.25·sentiment.
 */
import { BASE, Settings } from "../config";
import {
  BuyCandidate, BuyEvaluation, evaluateBuy, evaluateSell, MarketState, PortfolioState, SellEvaluation,
} from "../rules/rules";
import { pyRound, sortBy } from "../util/py";

// ── scoring ──────────────────────────────────────────────────────────────────
export function sentimentToUnit(score: number): number {
  return pyRound(Math.max(0, Math.min(1, (score + 1) / 2)), 3);
}

export function composite(technical: number, fundamental: number, sentimentUnit: number, s: Settings = BASE): number {
  return pyRound(s.weight_technical * technical + s.weight_fundamental * fundamental + s.weight_sentiment * sentimentUnit, 3);
}

export function recommendation(score: number): string {
  if (score >= 0.6) return "BUY";
  if (score <= 0.35) return "SELL";
  return "HOLD";
}

export function confidence(score: number): string {
  const d = Math.abs(score - 0.5);
  if (d >= 0.2) return "HIGH";
  if (d >= 0.1) return "MEDIUM";
  return "LOW";
}

// ── sector health (R10) ──────────────────────────────────────────────────────
export interface SectorHealthRow {
  sector: string; score: number; status: string; change_pct: number;
  avg_rsi: number; news_score: number; top_gainer: string | null;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function computeSectorHealth(
  stockSectors: Record<string, string>,
  dayChange: Record<string, number>,
  rsi: Record<string, number>,
  sectorNews: Record<string, number>,
  tracked: readonly string[],
): SectorHealthRow[] {
  const rows: SectorHealthRow[] = [];
  for (const sector of tracked) {
    const symbols = Object.entries(stockSectors)
      .filter(([s, sec]) => sec === sector && s in dayChange).map(([s]) => s);
    if (!symbols.length) {
      rows.push({ sector, score: 50, status: "NEUTRAL", change_pct: 0, avg_rsi: 50,
        news_score: sectorNews[sector] ?? 0, top_gainer: null });
      continue;
    }
    const changes = symbols.map((s) => dayChange[s]);
    const rsis = symbols.map((s) => rsi[s] ?? 50);
    const avgChg = changes.reduce((a, b) => a + b, 0) / changes.length;
    const avgRsi = rsis.reduce((a, b) => a + b, 0) / rsis.length;
    const news = sectorNews[sector] ?? 0;
    const score = pyRound(100 * (0.4 * clamp01((avgChg + 2) / 4) + 0.3 * clamp01((avgRsi - 20) / 60) +
      0.3 * clamp01((news + 1) / 2)), 1);
    const status = score < 40 ? "WEAK" : score > 60 ? "STRONG" : "NEUTRAL";
    let top = symbols[0];
    for (const s of symbols) if (dayChange[s] > dayChange[top]) top = s;
    rows.push({ sector, score, status, change_pct: pyRound(avgChg, 3), avg_rsi: pyRound(avgRsi, 1),
      news_score: pyRound(news, 3), top_gainer: top });
  }
  return rows;
}

// ── planner ──────────────────────────────────────────────────────────────────
export const MIN_BUY_SCORE = 0.6;
export const DEFAULT_MAX_PER_SEGMENT: Record<string, number> = {
  NIFTY50: 3, NEXT100: 2, SMALLCAP: 1, GOLD_ETF: 1, SILVER_ETF: 1,
};
const SEGMENT_ORDER = ["NIFTY50", "NEXT100", "SMALLCAP", "GOLD_ETF", "SILVER_ETF"];

function applyBuy(p: PortfolioState, ev: BuyEvaluation): PortfolioState {
  const c = ev.candidate;
  const bucket = { ...p.bucket_deployed, [c.segment]: (p.bucket_deployed[c.segment] ?? 0) + ev.total_cost };
  const sector = { ...p.sector_deployed };
  if (!c.is_etf) sector[c.sector] = (sector[c.sector] ?? 0) + ev.total_cost;
  return {
    ...p,
    cash_balance: p.cash_balance - ev.total_cost,
    invested_today: p.invested_today + ev.total_cost,
    bucket_deployed: bucket,
    sector_deployed: sector,
    held_symbols: new Set([...p.held_symbols, c.symbol]),
  };
}

/** Rank per segment and approve buys with PROVISIONAL state updates (see planner.py). */
export function planBuys(candidates: BuyCandidate[], portfolio: PortfolioState, market: MarketState, s: Settings,
                         maxPerSegment = DEFAULT_MAX_PER_SEGMENT): [BuyEvaluation[], BuyEvaluation[], PortfolioState] {
  const approved: BuyEvaluation[] = [];
  const skipped: BuyEvaluation[] = [];
  let state = portfolio;
  const bySegment: Record<string, BuyCandidate[]> = {};
  for (const c of candidates) {
    if (c.composite_score >= MIN_BUY_SCORE) (bySegment[c.segment] ??= []).push(c);
  }
  for (const segment of SEGMENT_ORDER) {
    const pool = sortBy(bySegment[segment] ?? [], (c) => c.composite_score, true);
    let taken = 0;
    for (const cand of pool) {
      if (taken >= (maxPerSegment[segment] ?? 0)) break;
      const ev = evaluateBuy(cand, state, market, s);
      if (ev.approved) {
        approved.push(ev);
        state = applyBuy(state, ev);
        taken++;
      } else {
        skipped.push(ev);
        if (ev.results[ev.results.length - 1].severity === "BLOCKER") return [approved, skipped, state];
      }
    }
  }
  return [approved, skipped, state];
}

export interface HoldingInput {
  symbol: string; avg_buy_price: number; current_price: number | null;
  peak_price: number | null; low_score_streak: number;
}

export function planSells(holdings: HoldingInput[], s: Settings): [SellEvaluation[], SellEvaluation[]] {
  const sells: SellEvaluation[] = [], holds: SellEvaluation[] = [];
  for (const h of holdings) {
    const ev = evaluateSell(h.symbol, Number(h.avg_buy_price), Number(h.current_price || 0),
      Number(h.peak_price || 0), Number(h.low_score_streak || 0), s);
    (ev.should_sell ? sells : holds).push(ev);
  }
  return [sells, holds];
}
