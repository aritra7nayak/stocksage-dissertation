/**
 * The daily engine run — app/engine/daily_run.py on the phone.
 *
 *  1–2  news refresh → R12 guard; Nifty status → R11
 *  3–4  1y history for the active universe → technicals
 *  5    sector health (R10)
 *  6    fundamentals for top-12-by-technicals per equity segment + holdings
 *  7    per-symbol news sentiment
 *  8    composite scores → stock_analysis
 *  9    portfolio state: prices, peaks (R15), low-score streaks (R14)
 * 10    plan sells (R13/R15/R14) and buys (all buy rules, provisional state)
 * 11    persist suggestions + the brief itself (phone-only: survives restarts)
 */
import { BASE, liveSettings } from "../config";
import { db, log, Row } from "../platform";
import { j, nowIso, numeric } from "../schema";
import { computeAll, TechnicalSnapshot } from "../market/indicators";
import { batchHistory, getNiftyStatus, isMarketOpenIst } from "../market/fetcher";
import { FundamentalSnapshot, scoreFundamentals } from "../market/fundamentals";
import type { Bars } from "../market/yahoo";
import { BuyCandidate, BuyEvaluation, marketState, PortfolioState, rulesFailed, rulesPassed } from "../rules/rules";
import { guardStatus, refreshNews, sectorNewsScores } from "../sentiment/pipeline";
import { pyRound, sortBy } from "../util/py";
import { nowIstIso, todayIst, todayStartUtcIso } from "../util/time";
import {
  composite, computeSectorHealth, confidence, planBuys, planSells, recommendation, sentimentToUnit,
} from "./core";

const FUNDAMENTALS_TOP_N = 12;
const EQUITY = ["NIFTY50", "NEXT100", "SMALLCAP"];
const ETF = ["GOLD_ETF", "SILVER_ETF"];

export type Progress = (stage: string, fraction: number) => void;

/** First distinctive word of a company name, for headline matching. */
export function nameKey(company: string | null | undefined): string {
  for (const w of (company ?? "").split(/\s+/)) {
    const w2 = Array.from(w).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join("").toLowerCase();
    if (w2.length >= 4 && !["india", "limited", "corp"].includes(w2)) return w2;
  }
  return (company ?? "").toLowerCase().slice(0, 6);
}

export function portfolioRow(): Row {
  const pf = db.one("SELECT * FROM portfolios ORDER BY id LIMIT 1");
  if (!pf) throw new Error("No portfolio found");
  return pf;
}

let running: Promise<any> | null = null;

/** One engine run at a time — a second caller just awaits the first. */
export function runDailyEngine(runType = "MANUAL", progress?: Progress): Promise<any> {
  if (!running) running = doRun(runType, progress).finally(() => { running = null; });
  return running;
}

export function engineRunning(): boolean {
  return running !== null;
}

async function doRun(runType: string, progress: Progress = () => {}): Promise<any> {
  const t0 = Date.now();
  const live = liveSettings();
  const today = todayIst();

  // ── 1–2. Guards ──────────────────────────────────────────────────────────
  progress("Reading today's news", 0.02);
  const newsSummary = await refreshNews();
  const guard = guardStatus();
  progress("Checking the Nifty guard", 0.12);
  const nifty = await getNiftyStatus(live.nifty_fall_threshold);
  const market = marketState({
    nifty_fell: nifty.nifty_fell,
    nifty_change_pct: nifty.change_pct,
    guard_basis: nifty.guard_basis,
    market_stopped: guard.market_stopped,
    bad_headline_count: guard.severe_count,
    blocked_sectors: new Set(guard.blocked_sectors),
  });

  // ── 3–4. Universe + technicals ────────────────────────────────────────────
  const uni = db.query("SELECT * FROM stock_universe WHERE is_active = 1 ORDER BY id");
  const info: Record<string, Row> = {};
  for (const u of uni) info[String(u.symbol)] = u;
  const symbols = uni.map((u) => String(u.symbol));
  const hist = await batchHistory(symbols, "1y", 8,
    (d, n) => progress(`Downloading prices ${d}/${n}`, 0.14 + 0.5 * (d / n)));
  const liveSession = isMarketOpenIst();
  const tech: Record<string, TechnicalSnapshot> = {};
  const dayChange: Record<string, number> = {};
  for (const sym of symbols) {
    const df = hist[sym];
    if (!df || df.close.length < 60) continue;
    tech[sym] = computeAll(df, liveSession);
    const n = df.close.length;
    dayChange[sym] = pyRound((df.close[n - 1] / df.close[n - 2] - 1) * 100, 3);
  }
  log("info", `Technicals computed for ${Object.keys(tech).length}/${symbols.length} symbols`);

  // ── 5. Sector health ─────────────────────────────────────────────────────
  progress("Scoring sector health", 0.66);
  const snews = sectorNewsScores();
  const equitySectors: Record<string, string> = {};
  for (const s of Object.keys(tech)) if (EQUITY.includes(String(info[s].segment))) equitySectors[s] = String(info[s].sector);
  const rsiMap: Record<string, number> = {};
  for (const [s, t] of Object.entries(tech)) rsiMap[s] = t.rsi_14;
  const health = computeSectorHealth(equitySectors, dayChange, rsiMap, snews, BASE.tracked_sectors);
  market.weak_sectors = new Set(health.filter((h) => h.status === "WEAK").map((h) => h.sector));
  db.batch(health.map((h) => {
    const blocked = market.blocked_sectors.has(h.sector);
    return {
      sql: `INSERT INTO sector_health (sector, health_date, score, status, change_pct, avg_rsi, news_score, top_gainer, is_blocked, block_reason)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(sector, health_date) DO UPDATE SET score=excluded.score, status=excluded.status,
              change_pct=excluded.change_pct, avg_rsi=excluded.avg_rsi, news_score=excluded.news_score,
              top_gainer=excluded.top_gainer, is_blocked=excluded.is_blocked`,
      params: [h.sector, today, h.score, h.status, h.change_pct, h.avg_rsi, h.news_score, h.top_gainer,
        blocked ? 1 : 0, blocked ? "Severe sector news (R12)" : null],
    };
  }));

  // ── 6. Targeted fundamentals ─────────────────────────────────────────────
  const pf = portfolioRow();
  const pfId = Number(pf.id);
  const holdings = db.query("SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY id", [pfId]);
  const held = new Set(holdings.map((h) => String(h.symbol)));
  const targets = new Set([...held].filter((s) => info[s]));
  for (const seg of EQUITY) {
    const ranked = sortBy(Object.keys(tech).filter((s) => info[s].segment === seg), (s) => tech[s].technical_score, true);
    ranked.slice(0, FUNDAMENTALS_TOP_N).forEach((s) => targets.add(s));
  }
  const funds: Record<string, FundamentalSnapshot> = {};
  let fd = 0;
  const tlist = [...targets];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (tlist.length) {
      const sym = tlist.shift()!;
      funds[sym] = await scoreFundamentals(sym, ETF.includes(String(info[sym]?.segment)));
      progress(`Fundamentals ${++fd}/${targets.size}`, 0.68 + 0.17 * (fd / targets.size));
    }
  }));
  log("info", `Fundamentals fetched for ${Object.keys(funds).length} targeted symbols`);

  // ── 7. Per-symbol news sentiment ─────────────────────────────────────────
  progress("Matching headlines to stocks", 0.86);
  const headlines = db.query("SELECT headline, sentiment_score FROM news_items WHERE fetched_at >= ?", [todayStartUtcIso()])
    .map((r) => [String(r.headline).toLowerCase(), Number(r.sentiment_score ?? 0)] as const);
  const symSent: Record<string, number> = {};
  for (const sym of Object.keys(tech)) {
    const key = nameKey(String(info[sym].company_name ?? sym));
    const matches = headlines.filter(([h]) => h.includes(key)).map(([, s]) => s);
    symSent[sym] = matches.length ? matches.reduce((a, b) => a + b, 0) / matches.length : snews[String(info[sym].sector)] ?? 0;
  }

  // ── 8. Composite scores → stock_analysis ─────────────────────────────────
  progress("Scoring every stock", 0.9);
  const composites: Record<string, number> = {};
  const lastPrice = (sym: string) => { const c = (hist[sym] as Bars).close; return c[c.length - 1]; };
  const analysisRows = Object.entries(tech).map(([sym, t]) => {
    const f = funds[sym];
    const fScore = f ? f.fundamental_score : 0.5;
    const sUnit = sentimentToUnit(symSent[sym] ?? 0);
    const comp = composite(t.technical_score, fScore, sUnit);
    composites[sym] = comp;
    const price = lastPrice(sym);
    return {
      sql: `INSERT INTO stock_analysis (symbol, analysis_date, current_price, rsi_14, macd_hist, macd_signal, ema_20, ema_50,
              ema_cross, bb_percent_b, adx, stoch_k, volume_ratio, momentum_20d, dist_52w_high, pe_ratio, pb_ratio, roe,
              debt_to_equity, revenue_growth, profit_margin, dividend_yield, news_sentiment, sector_sentiment,
              technical_score, fundamental_score, sentiment_score, composite_score, recommendation, confidence, top_reasons)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(symbol, analysis_date) DO UPDATE SET composite_score=excluded.composite_score,
              current_price=excluded.current_price, technical_score=excluded.technical_score,
              fundamental_score=excluded.fundamental_score, sentiment_score=excluded.sentiment_score,
              recommendation=excluded.recommendation, confidence=excluded.confidence`,
      params: [sym, today, numeric(price), t.rsi_14, t.macd_hist, t.macd_signal, t.ema_20, t.ema_50, t.ema_cross,
        t.bb_percent_b, t.adx, t.stoch_k, t.volume_ratio, t.momentum_20d, t.dist_52w_high,
        f?.pe_ratio ?? null, f?.pb_ratio ?? null, f?.roe ?? null, f?.debt_to_equity ?? null,
        f?.revenue_growth ?? null, f?.profit_margin ?? null, f?.dividend_yield ?? null,
        pyRound(symSent[sym] ?? 0, 3), pyRound(snews[String(info[sym].sector)] ?? 0, 3),
        t.technical_score, fScore, sUnit, comp, recommendation(comp), confidence(comp),
        JSON.stringify({ technical: t.reasons.slice(0, 4), fundamental: f ? f.reasons.slice(0, 3) : [] })],
    };
  });
  db.batch(analysisRows);

  // ── 9. Portfolio state ───────────────────────────────────────────────────
  const bucketDep: Record<string, number> = {}, sectorDep: Record<string, number> = {};
  let mktValue = 0;
  const holdingUpdates = holdings.map((h) => {
    const sym = String(h.symbol);
    const price = hist[sym] ? lastPrice(sym) : Number(h.current_price ?? h.avg_buy_price);
    const peak = Math.max(Number(h.peak_price ?? 0), price);
    const comp = composites[sym];
    let streak = Number(h.low_score_streak ?? 0);
    if (comp !== undefined) streak = comp < live.deterioration_score ? streak + 1 : 0;
    const qty = Number(h.quantity);
    const cost = Number(h.avg_buy_price) * qty;
    mktValue += price * qty;
    bucketDep[String(h.segment)] = (bucketDep[String(h.segment)] ?? 0) + cost;
    if (EQUITY.includes(String(h.segment))) sectorDep[String(h.sector)] = (sectorDep[String(h.sector)] ?? 0) + cost;
    Object.assign(h, { current_price: price, peak_price: peak, low_score_streak: streak });
    return {
      sql: "UPDATE holdings SET current_price=?, peak_price=?, low_score_streak=?, updated_at=? WHERE id=?",
      params: [numeric(price), numeric(peak), streak, nowIso(), Number(h.id)],
    };
  });
  const totalCapital = pyRound(Number(pf.cash_balance) + mktValue, 2);
  db.batch([...holdingUpdates, {
    sql: "UPDATE portfolios SET total_capital=?, updated_at=? WHERE id=?", params: [totalCapital, nowIso(), pfId],
  }]);

  const investedToday = Number(db.scalar(
    `SELECT COALESCE(SUM(total_value), 0) FROM transactions WHERE action='BUY' AND portfolio_id=? AND executed_at >= ?`,
    [pfId, todayStartUtcIso()]) ?? 0);
  const pstate: PortfolioState = {
    total_capital: totalCapital, cash_balance: Number(pf.cash_balance), invested_today: investedToday,
    bucket_deployed: bucketDep, sector_deployed: sectorDep, held_symbols: held,
  };

  // ── 10. Plan ─────────────────────────────────────────────────────────────
  progress("Running the 15 rules", 0.95);
  const [sells, holds] = planSells(holdings.map((h) => ({
    symbol: String(h.symbol), avg_buy_price: Number(h.avg_buy_price), current_price: Number(h.current_price),
    peak_price: Number(h.peak_price), low_score_streak: Number(h.low_score_streak),
  })), live);
  const candidates: BuyCandidate[] = Object.keys(composites).map((sym) => ({
    symbol: sym, segment: String(info[sym].segment), sector: String(info[sym].sector ?? "Services"),
    price: lastPrice(sym), composite_score: composites[sym], is_etf: ETF.includes(String(info[sym].segment)),
  }));
  const [buys, skips] = planBuys(candidates, pstate, market, live);

  // ── 11. Persist + brief ──────────────────────────────────────────────────
  const created = nowIso();
  const sugRow = (ev: BuyEvaluation, action: string) => {
    const c = ev.candidate;
    return {
      sql: `INSERT INTO suggestions_log (suggestion_date, run_type, portfolio_id, symbol, action, segment, sector,
              suggested_quantity, suggested_price, total_value, composite_score, confidence, rules_passed, rules_failed,
              reasoning, was_acted_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)`,
      params: [today, runType, pfId, c.symbol, action, c.segment, c.sector, ev.quantity || null, numeric(c.price),
        numeric(ev.total_cost || null), c.composite_score, confidence(c.composite_score),
        JSON.stringify(rulesPassed(ev)), JSON.stringify(rulesFailed(ev)),
        JSON.stringify({ rules: ev.results.map((r) => r.reason) }), created],
    };
  };
  db.batch([
    ...buys.map((ev) => sugRow(ev, "BUY")),
    ...skips.slice(0, 10).map((ev) => sugRow(ev, "SKIP")),
    ...sells.map((s) => ({
      sql: `INSERT INTO suggestions_log (suggestion_date, run_type, portfolio_id, symbol, action, reasoning, rules_failed, was_acted_on, created_at)
            VALUES (?,?,?,?,?,?,?,0,?)`,
      params: [today, runType, pfId, s.symbol, "SELL", JSON.stringify({ rules: [s.reason], urgency: s.urgency }),
        JSON.stringify([{ rule_id: s.triggered_rule }]), created],
    })),
  ]);

  const avoid = [...new Set([...market.weak_sectors, ...market.blocked_sectors])].sort();
  const go = market.nifty_fell || market.market_stopped ? "RED"
    : market.blocked_sectors.size || market.weak_sectors.size ? "AMBER" : "GREEN";
  const dailyCap = totalCapital * live.max_daily_invest_pct;
  const buckets: [string, number][] = [
    ["NIFTY50", live.nifty50_pct], ["NEXT100", live.nifty_next100_pct], ["SMALLCAP", live.smallcap_pct],
    ["GOLD_ETF", live.gold_silver_pct / 2], ["SILVER_ETF", live.gold_silver_pct / 2],
  ];
  const brief = {
    date: today, run_type: runType, generated_at: nowIstIso(),
    duration_seconds: pyRound((Date.now() - t0) / 1000, 1),
    market_guard: {
      go_status: go,
      nifty_fell: market.nifty_fell,
      nifty_change_pct: market.nifty_change_pct,
      guard_basis: market.guard_basis,
      bad_news_detected: market.market_stopped,
      blocked_sectors: [...market.blocked_sectors].sort(),
      weak_sectors: [...market.weak_sectors].sort(),
      go_message: market.nifty_fell ? "Nifty fell — NO buying today (R11). Capital preserved."
        : market.market_stopped ? "Severe news flow — ALL buying paused (R12)."
          : avoid.length ? `Proceed with caution — avoid: ${avoid.join(", ")}.`
            : "Market is healthy. Conditions are good to invest today.",
    },
    capital_status: {
      total: totalCapital, cash: Number(pf.cash_balance), invested_today: investedToday,
      available_today: pyRound(Math.max(0, dailyCap - investedToday), 2),
      by_bucket: Object.fromEntries(buckets.map(([seg, pct]) => [seg, {
        target: pyRound(totalCapital * pct, 2), deployed: pyRound(bucketDep[seg] ?? 0, 2),
      }])),
    },
    sector_health: health,
    buy_suggestions: buys.map((ev) => {
      const sym = ev.candidate.symbol;
      return {
        symbol: sym, name: info[sym].company_name, segment: ev.candidate.segment, sector: ev.candidate.sector,
        price: ev.candidate.price, quantity: ev.quantity, total_value: ev.total_cost,
        composite_score: ev.candidate.composite_score, confidence: confidence(ev.candidate.composite_score),
        scores: {
          technical: tech[sym].technical_score,
          fundamental: funds[sym] ? funds[sym].fundamental_score : 0.5,
          sentiment: sentimentToUnit(symSent[sym] ?? 0),
        },
        reasons: [...tech[sym].reasons.slice(0, 3), ...(funds[sym] ? funds[sym].reasons.slice(0, 2) : [])],
        rules_passed: rulesPassed(ev).map((r) => r.rule_id),
      };
    }),
    sell_alerts: sells.map((s) => ({ symbol: s.symbol, rule: s.triggered_rule, urgency: s.urgency, reason: s.reason })),
    hold: holds.map((h) => ({ symbol: h.symbol, note: h.reason })),
    skipped: skips.slice(0, 10).map((ev) => {
      const lastR = ev.results[ev.results.length - 1];
      return { symbol: ev.candidate.symbol, score: ev.candidate.composite_score, killed_by: lastR.rule_id, reason: lastR.reason };
    }),
    news: {
      overall: guard.overall, avg_sentiment: guard.avg_sentiment, headlines_today: guard.headlines_today,
      finbert: (newsSummary as any).finbert ?? {},
    },
  };
  db.run("INSERT INTO briefs (brief_date, run_type, generated_at, payload) VALUES (?,?,?,?)",
    [today, runType, brief.generated_at, JSON.stringify(brief)]);
  db.run("DELETE FROM briefs WHERE brief_date < date(?, '-30 day')", [today]);
  progress("Done", 1);
  log("info", `Engine run complete in ${brief.duration_seconds}s — ${buys.length} buys, ${sells.length} sells, ` +
    `${skips.length} skips, status ${go}`);
  return brief;
}

/** Today's latest stored brief, if any. */
export function cachedBrief(): any | null {
  const r = db.one("SELECT payload FROM briefs WHERE brief_date = ? ORDER BY id DESC LIMIT 1", [todayIst()]);
  return r ? j(r.payload, null) : null;
}
