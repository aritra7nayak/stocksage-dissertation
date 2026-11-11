/** /api/deepdive/* — deepdive_router.py. */
import { BASE } from "../config";
import { nameKey } from "../engine/dailyRun";
import { batchHistory, getHistory, isMarketOpenIst } from "../market/fetcher";
import { scoreFundamentals } from "../market/fundamentals";
import { computeAll, emaSeries } from "../market/indicators";
import { calendar } from "../market/yahoo";
import { db } from "../platform";
import { route } from "../server";
import { HttpError, pyRound, sortBy } from "../util/py";

route("GET", "/api/deepdive/search", ({ query }) => {
  const term = (query.get("q") ?? "").trim();
  if (term.length < 2) return { results: [] };
  const like = `%${term}%`;
  const rows = db.query(
    "SELECT * FROM stock_universe WHERE is_active=1 AND (symbol LIKE ? OR company_name LIKE ?) LIMIT 8", [like, like]);
  return { results: rows.map((r) => ({ symbol: r.symbol, name: r.company_name, sector: r.sector, segment: r.segment })) };
});

route("GET", "/api/deepdive/sector/:sector/stocks", async ({ params }) => {
  const rows = db.query("SELECT * FROM stock_universe WHERE is_active=1 AND sector=?", [params.sector]);
  if (!rows.length) throw new HttpError(404, `No active stocks in sector '${params.sector}'`);
  const prices = await batchHistory(rows.map((r) => String(r.symbol)), "5d");
  const out = [];
  for (const u of rows) {
    const df = prices[String(u.symbol)];
    if (!df || !df.close.length) continue;
    const c = df.close, last = c[c.length - 1];
    const prev = c.length >= 2 ? c[c.length - 2] : last;
    out.push({ symbol: u.symbol, name: u.company_name, segment: u.segment, price: pyRound(last, 2),
      change_pct: prev ? pyRound((last / prev - 1) * 100, 2) : 0 });
  }
  return { sector: params.sector, count: out.length, stocks: sortBy(out, (x) => x.change_pct, true) };
});

route("GET", "/api/deepdive/:symbol", async ({ params }) => {
  let sym = params.symbol.toUpperCase();
  if (!sym.endsWith(".NS")) sym += ".NS";
  const uni = db.one("SELECT * FROM stock_universe WHERE symbol=?", [sym]);
  const isEtf = !!uni && ["GOLD_ETF", "SILVER_ETF"].includes(String(uni.segment));

  let df;
  try {
    df = await getHistory(sym, "1y");
  } catch (e) {
    throw new HttpError(404, `No price data for ${sym}: ${(e as Error).message}`);
  }
  const [tech, fund] = [computeAll(df, isMarketOpenIst()), await scoreFundamentals(sym, isEtf)];

  const closes = df.close;
  const e20 = emaSeries(closes, 20), e50 = emaSeries(closes, 50);
  const n = closes.length;
  const step = Math.max(1, Math.floor(n / 180));
  const priceSeries = [];
  for (let i = 0; i < n; i += step) {
    priceSeries.push({ date: df.dates[i], close: pyRound(closes[i], 2), ema20: pyRound(e20[i], 2), ema50: pyRound(e50[i], 2) });
  }

  const name = uni ? String(uni.company_name) : sym.replace(".NS", "");
  const key = nameKey(name || sym);
  const newsRows = db.query("SELECT * FROM news_items WHERE fetched_at IS NOT NULL ORDER BY fetched_at DESC, id DESC LIMIT 200");
  const related = newsRows.filter((r) => String(r.headline).toLowerCase().includes(key)).slice(0, 8);
  const sentVals = related.map((r) => Number(r.sentiment_score ?? 0));
  const newsSent = sentVals.length ? pyRound(sentVals.reduce((a, b) => a + b, 0) / sentVals.length, 3) : 0;
  const sentUnit = Math.max(0, Math.min(1, (newsSent + 1) / 2));
  const comp = pyRound(0.4 * tech.technical_score + 0.35 * fund.fundamental_score + 0.25 * sentUnit, 3);
  const rec = comp >= 0.6 ? "BUY" : comp <= 0.35 ? "SELL" : "HOLD";

  const peers = uni ? db.query(
    "SELECT symbol, company_name, segment FROM stock_universe WHERE sector=? AND symbol<>? AND is_active=1 LIMIT 8",
    [uni.sector, sym]).map((p) => ({ symbol: p.symbol, name: p.company_name, segment: p.segment })) : [];

  const hi = pyRound(Math.max(...closes), 2), lo = pyRound(Math.min(...closes), 2);
  const last = closes[n - 1];
  const pos52 = hi > lo ? pyRound(((last - lo) / (hi - lo)) * 100, 1) : 50;
  let rs: number | null = null;
  try {
    const ndf = await getHistory(BASE.nifty50_index, "3mo");
    if (n > 21 && ndf.close.length > 21) {
      const s20 = (last / closes[n - 21] - 1) * 100;
      const nc = ndf.close;
      const n20 = (nc[nc.length - 1] / nc[nc.length - 21] - 1) * 100;
      rs = pyRound(s20 - n20, 2);
    }
  } catch { /* optional */ }
  let nextEarnings: string | null = null;
  try {
    nextEarnings = (await calendar(sym)).earnings;
  } catch { /* optional */ }

  return {
    symbol: sym, name,
    week52: { high: hi, low: lo, position_pct: pos52 },
    rs_vs_nifty_20d: rs, next_earnings: nextEarnings,
    sector: uni?.sector ?? null, segment: uni?.segment ?? null, is_etf: isEtf,
    current_price: pyRound(last, 2), price_series: priceSeries,
    technical: tech, fundamental: fund,
    scores: { technical: tech.technical_score, fundamental: fund.fundamental_score, sentiment: pyRound(sentUnit, 3), composite: comp },
    recommendation: rec, news_sentiment: newsSent,
    related_news: related.map((r) => ({ headline: r.headline, source: r.source, url: r.url, sentiment: r.sentiment,
      sentiment_score: Number(r.sentiment_score ?? 0), severity: Number(r.severity ?? 0) })),
    peers,
  };
});
