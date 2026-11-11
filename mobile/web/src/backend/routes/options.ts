/** /api/options/* — options/router.py: gathers inputs, analysis.ts scores them. */
import { BASE } from "../config";
import { nameKey } from "../engine/dailyRun";
import { batchHistory, getHistory, isMarketOpenIst } from "../market/fetcher";
import { computeAll, emaSeries } from "../market/indicators";
import { calendar } from "../market/yahoo";
import { db, log } from "../platform";
import { j } from "../schema";
import { route } from "../server";
import { guardStatus } from "../sentiment/pipeline";
import { fmt, HttpError, pyRound } from "../util/py";
import { rollingMean } from "../util/series";
import { fmtExpiry, nowIstIso, parseExpiry, todayIst } from "../util/time";
import * as A from "../options/analysis";
import * as N from "../options/nse";
import * as P from "../options/pricing";

const SCAN_UNIVERSE = ["NIFTY", "BANKNIFTY", "RELIANCE", "HDFCBANK", "ICICIBANK", "INFY", "TCS", "SBIN",
  "AXISBANK", "KOTAKBANK", "LT", "BHARTIARTL", "ITC", "BAJFINANCE", "MARUTI",
  "HINDUNILVR", "SUNPHARMA", "TATASTEEL", "M&M", "ADANIENT"];
const results = new Map<string, { exp: number; value: any }>();
const earnings = new Map<string, { exp: number; value: string | null }>();

const yfSymbol = (s: string) => (s in N.INDICES ? N.INDICES[s].yf : `${s}.NS`);

route("GET", "/api/options/underlyings", async () => {
  const lots = await N.lotSizes();
  const idx = Object.entries(N.INDICES).map(([s, v]) => ({ symbol: s, name: v.name, lot: lots[s]?.lot ?? v.lot, kind: "INDEX" }));
  const stocks = Object.entries(lots)
    .filter(([s]) => !(s in N.INDICES) && !s.startsWith("NIFTY") && !["BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"].includes(s))
    .map(([s, v]) => ({ symbol: s, name: v.name, lot: v.lot, kind: "STOCK" }))
    .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return { indices: idx, stocks, scan_universe: SCAN_UNIVERSE };
});

function sentimentFor(symbol: string, name: string, sector: string | null) {
  const since = new Date(Date.now() - 72 * 3600_000).toISOString();
  const rows = db.query("SELECT * FROM news_items WHERE fetched_at >= ? ORDER BY fetched_at DESC, id DESC LIMIT 400", [since]);
  let rel = rows;
  if (symbol !== "NIFTY") {
    if (symbol in N.INDICES) {
      const sec = N.INDICES[symbol].sector;
      rel = rows.filter((n) => j<string[]>(n.related_sectors, []).includes(String(sec)) || ` ${String(n.headline).toLowerCase()}`.includes(" bank"));
    } else {
      const key = nameKey(name), sym = symbol.toLowerCase();
      rel = rows.filter((n) => { const h = String(n.headline).toLowerCase(); return h.includes(key) || ` ${h} `.includes(` ${sym} `); });
    }
  }
  const scores = rel.map((n) => Number(n.sentiment_score ?? 0));
  const guard = guardStatus();
  return {
    count: rel.length,
    avg: scores.length ? pyRound(scores.reduce((a, b) => a + b, 0) / scores.length, 3) : 0,
    positive: rel.filter((n) => n.sentiment === "POSITIVE").length,
    negative: rel.filter((n) => n.sentiment === "NEGATIVE").length,
    neutral: rel.filter((n) => n.sentiment !== "POSITIVE" && n.sentiment !== "NEGATIVE").length,
    market_avg: guard.avg_sentiment || 0, market_overall: guard.overall, market_stopped: guard.market_stopped,
    sector_blocked: !!sector && guard.blocked_sectors.includes(sector), guard_verdict: guard.verdict,
    headlines: rel.slice(0, 12).map((n) => ({ headline: n.headline, source: n.source, url: n.url, sentiment: n.sentiment,
      score: Number(n.sentiment_score ?? 0), severity: Number(n.severity ?? 0), published_at: n.published_at })),
  };
}

async function contextFor(symbol: string, close: number[]) {
  const out: Record<string, any> = { factors: [], vix: null, vix_change_5d: null, rs_vs_nifty_20d: null, nifty_trend: null };
  const price = close[close.length - 1];
  if (symbol === "NIFTY") {
    const sma200 = close.length >= 200 ? rollingMean(close, 200)[close.length - 1] : null;
    if (sma200) {
      const gap = price / sma200 - 1;
      out.factors.push({ key: "lt_trend", label: "Long-term trend (200-DMA)", value: A.clamp(gap / 0.05), weight: 0.08,
        detail: `Nifty ${fmt(gap * 100, "+.1f")}% vs its 200-day average` });
    }
  } else {
    const ndf = await getHistory(BASE.nifty50_index, "1y");
    const nt = computeAll(ndf);
    const npx = ndf.close[ndf.close.length - 1];
    let v: number, d: string;
    if (npx > nt.ema_20 && nt.ema_20 > nt.ema_50) [v, d] = [0.7, "Nifty in a clean uptrend — tailwind for calls"];
    else if (nt.ema_20 > nt.ema_50) [v, d] = [0.3, "Nifty uptrend, currently pulling back"];
    else if (npx > nt.ema_20) [v, d] = [-0.2, "Nifty bouncing inside a downtrend"];
    else [v, d] = [-0.7, "Nifty in a downtrend — tailwind for puts"];
    out.nifty_trend = d;
    out.factors.push({ key: "nifty_trend", label: "Broad market (Nifty trend)", value: v, weight: 0.08, detail: d });
    if (!(symbol in N.INDICES) && close.length > 21 && ndf.close.length > 21) {
      const rs = (price / close[close.length - 21] - npx / ndf.close[ndf.close.length - 21]) * 100;
      out.rs_vs_nifty_20d = pyRound(rs, 2);
      out.factors.push({ key: "rel_strength", label: "Relative strength vs Nifty (20d)", value: A.clamp(rs / 6), weight: 0.07,
        detail: `${fmt(rs, "+.1f")}% vs Nifty over 20 sessions — ${rs > 0 ? "leader" : "laggard"}` });
    }
  }
  if (symbol in N.INDICES) {
    try {
      const vdf = await getHistory("^INDIAVIX", "3mo");
      const vc = vdf.close;
      const vix = vc[vc.length - 1];
      const chg = vc.length > 6 ? (vix / vc[vc.length - 6] - 1) * 100 : 0;
      out.vix = pyRound(vix, 2);
      out.vix_change_5d = pyRound(chg, 1);
      let v = chg > 10 ? -0.7 : chg > 5 ? -0.35 : chg < -10 ? 0.5 : chg < -5 ? 0.25 : 0;
      if (vix > 22) v -= 0.3;
      out.factors.push({ key: "vix", label: "India VIX (fear gauge)", value: A.clamp(v), weight: 0.07,
        detail: `VIX ${fmt(vix, ".1f")}, ${fmt(chg, "+.1f")}% over 5 sessions — ` +
          (chg > 5 ? "fear rising" : chg < -5 ? "fear easing" : "stable") });
    } catch {
      log("warn", "India VIX unavailable");
    }
  }
  return out;
}

async function nextResults(symbol: string): Promise<string | null> {
  const hit = earnings.get(symbol);
  if (hit && hit.exp > Date.now()) return hit.value;
  let val: string | null = null;
  try { val = (await calendar(`${symbol}.NS`)).earnings; } catch { /* none */ }
  earnings.set(symbol, { exp: Date.now() + 12 * 3600_000, value: val });
  return val;
}

function pickExpiry(symbol: string, exps: string[]): string {
  const minDays = symbol in N.INDICES ? 2 : 5;
  return exps.find((e) => A.timeToExpiry(e)[1] >= minDays) ?? exps[0];
}

export async function analyzeSymbol(symbolIn: string, expiry: string | null): Promise<any> {
  const symbol = symbolIn.toUpperCase().replace(/\.NS$/, "");
  const lots = await N.lotSizes();
  if (!(symbol in lots) && !(symbol in N.INDICES)) throw new HttpError(404, `${symbol} is not an NSE F&O underlying`);
  const cacheKey = `${symbol}:${expiry ?? "auto"}`;
  const hit = results.get(cacheKey);
  if (hit && hit.exp > Date.now()) return hit.value;

  const isIndex = symbol in N.INDICES;
  const lot = lots[symbol]?.lot || N.INDICES[symbol]?.lot || 1;
  const uni = isIndex ? null : db.one("SELECT * FROM stock_universe WHERE symbol=?", [`${symbol}.NS`]);
  const name = isIndex ? N.INDICES[symbol].name : (uni?.company_name as string) || lots[symbol].name;
  const sector = isIndex ? N.INDICES[symbol].sector : (uni?.sector as string | null) ?? null;

  let df;
  try {
    df = await getHistory(yfSymbol(symbol), "1y");
  } catch (e) {
    throw new HttpError(502, `No price history for ${symbol}: ${(e as Error).message}`);
  }
  if (df.close.length < 60) throw new HttpError(422, `Only ${df.close.length} days of history for ${symbol} — need 60+`);
  const close = df.close;
  const warnings: string[] = [];

  let liveExp = true;
  let exps: string[];
  try {
    exps = await N.expiries(symbol);
  } catch (e) {
    liveExp = false;
    exps = N.modeledExpiries(symbol);
    warnings.push(`NSE expiries unavailable (${(e as Error).message}); using calendar-rule expiries.`);
  }
  let chosen: string | null = null;
  if (expiry) {
    try { chosen = parseExpiry(expiry); } catch { throw new HttpError(400, "expiry must look like 13-Oct-2026"); }
    if (!exps.includes(chosen)) throw new HttpError(400, `${expiry} is not a listed expiry for ${symbol}`);
  }
  chosen = chosen ?? pickExpiry(symbol, exps);
  const [T, days] = A.timeToExpiry(chosen);
  const hv20 = A.realisedVol(close, 20), hv60 = A.realisedVol(close, 60);

  let ch: N.Chain;
  try {
    if (!liveExp) throw new N.NSEUnavailable("expiries were modeled");
    ch = await N.chain(symbol, chosen);
  } catch (e) {
    const sigma = Math.max(0.08, (Number.isNaN(hv20) ? 0.2 : hv20) * 1.1);
    ch = N.modeledChain(symbol, close[close.length - 1], sigma, T);
    warnings.push(`Live option chain unavailable (${(e as Error).message}). Prices are MODELED from realised ` +
      "volatility — no open interest, no real bid/ask. Verify in your broker.");
  }
  const source = ch.source, spot = ch.spot, rows = ch.rows;
  const hasOi = source === "NSE" && rows.reduce((a, r) => a + (r.ce?.oi ?? 0) + (r.pe?.oi ?? 0), 0) > 0;
  const hasQuotes = source === "NSE";

  const tech = computeAll(df, isMarketOpenIst());
  const [q, forward] = hasQuotes ? A.impliedCarry(rows, spot, T) : [0, spot * Math.exp(P.RISK_FREE * T)];
  const metrics = A.chainMetrics(rows, spot, T, hasOi, q);
  const sentiment = sentimentFor(symbol, name, sector);
  const context = await contextFor(symbol, close);
  let event: string | null = null;
  if (!isIndex) {
    const ed = await nextResults(symbol);
    if (ed && todayIst() <= ed && ed <= chosen) event = ed;
  }

  const atmRow = rows.find((r) => r.strike === metrics.atm_strike)!;
  const spreads: number[] = [];
  for (const leg of [atmRow.ce, atmRow.pe]) {
    if (hasQuotes && leg && leg.bid > 0 && leg.ask > 0) spreads.push(((leg.ask - leg.bid) / ((leg.ask + leg.bid) / 2)) * 100);
  }
  const liquidity = { spread_pct: spreads.length ? pyRound(spreads.reduce((a, b) => a + b, 0) / spreads.length, 2) : null };

  const dF = A.directionFactors({ tech, close, metrics, spot, days, sentiment, context });
  const sF = A.suitabilityFactors({ tech, metrics, hv20, days, liquidity, event, vix: context.vix });
  const direction = pyRound(A.weighted(dF) * 100, 1);
  const suitability = pyRound(A.weighted(sF) * 100, 1);
  const v = A.verdict(direction, suitability);
  const conf = A.confluence(dF, direction >= 0 ? 1 : -1);

  const solved: number[] = [];
  for (const [kind, leg] of [["CE", atmRow.ce], ["PE", atmRow.pe]] as const) {
    if (hasQuotes && leg && leg.bid > 0 && leg.ask > 0) {
      const iv = P.impliedVol((leg.bid + leg.ask) / 2, spot, atmRow.strike, T, kind, P.RISK_FREE, q);
      if (iv) solved.push(iv);
    }
  }
  const sigma = (solved.length ? solved.reduce((a, b) => a + b, 0) / solved.length : null)
    || (metrics.atm_iv || 0) / 100 || (Number.isNaN(hv20) ? 0.2 : hv20);
  const sides: Record<string, any> = {};
  for (const side of ["CE", "PE"]) {
    sides[side] = A.rankStrikes({ side, rows, spot, T, days, lot, metrics, direction, sigma, hasQuotes, q });
  }
  const best = sides[v.side].strikes[0] ?? null;
  const story = A.narrative(dF, v.side, sides[v.side].plan, best, symbol);
  const checks = A.checklist({ direction, conf, metrics, hv20, days, best, event,
    guardClear: !(sentiment.market_stopped || sentiment.sector_blocked) });

  const atmI = rows.findIndex((r) => r.strike === metrics.atm_strike);
  const table = rows.slice(Math.max(0, atmI - 12), atmI + 13).map((r) => {
    const row: Record<string, any> = { strike: r.strike };
    for (const [k, kind] of [["ce", "CE"], ["pe", "PE"]] as const) {
      const leg = r[k];
      if (leg) {
        const iv = leg.iv || sigma;
        row[k] = { ...leg, iv: pyRound(iv * 100, 2), delta: pyRound(P.greeks(spot, r.strike, T, iv, kind, P.RISK_FREE, q).delta, 3) };
      } else row[k] = null;
    }
    return row;
  });

  const n = close.length;
  const e20 = emaSeries(close, 20), e50 = emaSeries(close, 50);
  const priceSeries = [];
  for (let i = Math.max(0, n - 120); i < n; i++) {
    priceSeries.push({ date: df.dates[i], close: pyRound(close[i], 2), ema20: pyRound(e20[i], 2), ema50: pyRound(e50[i], 2) });
  }
  const result = {
    symbol, name, kind: isIndex ? "INDEX" : "STOCK", sector, lot_size: lot, spot: pyRound(spot, 2),
    change_pct: pyRound((close[n - 1] / close[n - 2] - 1) * 100, 2),
    source, data_timestamp: ch.timestamp, market_open: isMarketOpenIst(), generated_at: nowIstIso(), warnings,
    expiry: fmtExpiry(chosen), expiries: exps.slice(0, 8).map(fmtExpiry), days_to_expiry: pyRound(days, 2),
    years_to_expiry: T, risk_free: P.RISK_FREE, carry_q: pyRound(q, 5), forward: pyRound(forward, 2),
    verdict: { ...v, direction, suitability, confluence: conf },
    direction_factors: dF, suitability_factors: sF,
    volatility: {
      atm_iv: metrics.atm_iv, hv20: A.r_(hv20 * 100), hv60: A.r_(hv60 * 100),
      iv_hv_ratio: A.r_(metrics.atm_iv && hv20 ? metrics.atm_iv / 100 / hv20 : null),
      hv_percentile: A.hvPercentile(close), vix: context.vix, vix_change_5d: context.vix_change_5d,
      model_sigma: pyRound(sigma * 100, 2),
    },
    chain_metrics: metrics, chain: table, sides, recommended: best, narrative: story, checklist: checks, sentiment,
    context: { rs_vs_nifty_20d: context.rs_vs_nifty_20d, nifty_trend: context.nifty_trend }, event,
    technical: tech, price_series: priceSeries,
  };
  const exp = Date.now() + 90_000;
  results.set(cacheKey, { exp, value: result });
  results.set(`${symbol}:${result.expiry}`, { exp, value: result });
  return result;
}

route("GET", "/api/options/analyze/:symbol", ({ params, query }) => analyzeSymbol(params.symbol, query.get("expiry")));

route("GET", "/api/options/scan", async () => {
  const lots = await N.lotSizes();
  const syms = SCAN_UNIVERSE.filter((s) => s in lots || s in N.INDICES);
  await batchHistory(syms.map(yfSymbol), "1y");
  const rows: any[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < syms.length) {
      const sym = syms[next++];
      try {
        const r = await analyzeSymbol(sym, null);
        const b = r.recommended;
        rows.push({
          symbol: sym, name: r.name, kind: r.kind, spot: r.spot, change_pct: r.change_pct, expiry: r.expiry,
          days_to_expiry: r.days_to_expiry, source: r.source, verdict: r.verdict, atm_iv: r.volatility.atm_iv,
          iv_hv_ratio: r.volatility.iv_hv_ratio, pcr: r.chain_metrics.pcr_oi, news_count: r.sentiment.count,
          news_avg: r.sentiment.avg,
          best: b && { strike: b.strike, side: b.side, entry: b.entry, lot_cost: b.lot_cost, delta: b.delta,
            ev_signal: b.sim.signal.ev_pct, ev_neutral: b.sim.neutral.ev_pct, p_profit: b.sim.signal.p_profit,
            ret_t1_pct: b.ret_t1_pct },
        });
      } catch (e) {
        const detail = e instanceof HttpError ? e.detail : (e as Error).message;
        rows.push({ symbol: sym, error: String(detail).slice(0, 160) });
      }
    }
  }));
  rows.sort((a, b) => syms.indexOf(a.symbol) - syms.indexOf(b.symbol));   // gather() order
  const ok = rows.filter((r) => !("error" in r)).sort((a, b) => {
    const wa = ["NO_TRADE", "WAIT"].includes(a.verdict.action) ? 1 : 0, wb = ["NO_TRADE", "WAIT"].includes(b.verdict.action) ? 1 : 0;
    return wa - wb || b.verdict.trade_score - a.verdict.trade_score;
  });
  return { generated_at: nowIstIso(), results: ok, errors: rows.filter((r) => "error" in r) };
});

