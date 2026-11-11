/** /api/market/* and /api/news/* — market_data/router.py, snapshot.py, sentiment/router.py. */
import { BASE } from "../config";
import { db } from "../platform";
import { j, nowIso } from "../schema";
import { route } from "../server";
import * as fetcher from "../market/fetcher";
import { scoreFundamentals } from "../market/fundamentals";
import { computeAll } from "../market/indicators";
import { modelStatus } from "../sentiment/finbert";
import { guardStatus, refreshNews, sectorNewsScores } from "../sentiment/pipeline";
import { HttpError } from "../util/py";
import { isMarketOpenIst, todayIst } from "../util/time";

/** End-of-day snapshot: today's market_snapshots row + holding prices/peaks (R15 input). */
export async function runEodSnapshot() {
  const [nifty, sensex, gold, silver] = await Promise.all([
    fetcher.getQuote(BASE.nifty50_index), fetcher.getQuote(BASE.sensex_index),
    fetcher.getQuote(BASE.gold_etf), fetcher.getQuote(BASE.silver_etf),
  ]);
  const niftyFell = nifty.change_pct <= BASE.nifty_fall_threshold;
  const status = nifty.change_pct > 0.25 ? "BULLISH" : nifty.change_pct < -0.25 ? "BEARISH" : "NEUTRAL";
  const today = todayIst();
  const intraday = isMarketOpenIst();
  db.run(`INSERT INTO market_snapshots (snapshot_date, nifty50_close, nifty50_change_pct, sensex_close, sensex_change_pct,
            gold_etf_price, silver_etf_price, market_status, nifty_fell, is_intraday, data_age_minutes, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(snapshot_date) DO UPDATE SET nifty50_close=excluded.nifty50_close,
            nifty50_change_pct=excluded.nifty50_change_pct, sensex_close=excluded.sensex_close,
            sensex_change_pct=excluded.sensex_change_pct, gold_etf_price=excluded.gold_etf_price,
            silver_etf_price=excluded.silver_etf_price, market_status=excluded.market_status,
            nifty_fell=excluded.nifty_fell, is_intraday=excluded.is_intraday`,
  [today, nifty.price, nifty.change_pct, sensex.price, sensex.change_pct, gold.price, silver.price, status,
    niftyFell ? 1 : 0, intraday ? 1 : 0, intraday ? 15 : 0, nowIso()]);

  let updated = 0;
  for (const h of db.query("SELECT id, symbol, peak_price FROM holdings")) {
    try {
      const q = await fetcher.getQuote(String(h.symbol));
      db.run("UPDATE holdings SET current_price=?, peak_price=?, updated_at=? WHERE id=?",
        [q.price, Math.max(Number(h.peak_price ?? 0), q.price), nowIso(), Number(h.id)]);
      updated++;
    } catch {
      /* keep last value */
    }
  }
  return { snapshot_date: today, nifty, sensex, gold, silver, market_status: status, nifty_fell: niftyFell, holdings_refreshed: updated };
}

route("GET", "/api/market/indices", () => fetcher.getIndices());
route("GET", "/api/market/nifty-status", () => fetcher.getNiftyStatus());
route("GET", "/api/market/gold-silver", () => fetcher.getGoldSilver());

route("GET", "/api/market/quote/:symbol", async ({ params }) => {
  try {
    return await fetcher.getQuote(params.symbol.toUpperCase());
  } catch (e) {
    throw new HttpError(404, `No data for ${params.symbol}: ${(e as Error).message}`);
  }
});

route("GET", "/api/market/technicals/:symbol", async ({ params }) => {
  const sym = params.symbol.toUpperCase();
  let df;
  try {
    df = await fetcher.getHistory(sym, "1y");
  } catch (e) {
    throw new HttpError(404, `No data for ${params.symbol}: ${(e as Error).message}`);
  }
  return { symbol: sym, ...computeAll(df, isMarketOpenIst()) };
});

route("GET", "/api/market/fundamentals/:symbol", async ({ params }) => {
  const sym = params.symbol.toUpperCase();
  const row = db.one("SELECT segment FROM stock_universe WHERE symbol = ?", [sym]);
  const isEtf = !!row && ["GOLD_ETF", "SILVER_ETF"].includes(String(row.segment));
  return { symbol: sym, ...(await scoreFundamentals(sym, isEtf)) };
});

route("GET", "/api/market/universe", ({ query }) => {
  const seg = query.get("segment");
  const rows = seg
    ? db.query("SELECT * FROM stock_universe WHERE is_active=1 AND segment=? ORDER BY segment, symbol", [seg.toUpperCase()])
    : db.query("SELECT * FROM stock_universe WHERE is_active=1 ORDER BY segment, symbol");
  return {
    count: rows.length,
    stocks: rows.map((r) => ({ symbol: r.symbol, name: r.company_name, sector: r.sector, segment: r.segment })),
  };
});

route("POST", "/api/market/refresh-eod", () => runEodSnapshot());

// ── News ─────────────────────────────────────────────────────────────────────
route("POST", "/api/news/refresh", () => refreshNews());

route("GET", "/api/news/feed", ({ query }) => {
  const limit = Math.min(Number(query.get("limit") ?? 30), 100);
  const onlyBad = query.get("only_bad") === "true";
  const rows = db.query(
    `SELECT * FROM news_items ${onlyBad ? "WHERE is_bad_news = 1" : ""} ORDER BY fetched_at DESC, id DESC LIMIT ?`, [limit]);
  return {
    count: rows.length,
    items: rows.map((r) => ({
      headline: r.headline, source: r.source, url: r.url, sentiment: r.sentiment,
      sentiment_score: Number(r.sentiment_score ?? 0), severity: Number(r.severity ?? 0),
      is_bad_news: !!r.is_bad_news, sectors: j<string[]>(r.related_sectors, []),
      published_at: r.published_at,
    })),
  };
});

route("GET", "/api/news/guard-status", () => guardStatus());
route("GET", "/api/news/sector-sentiment", () => sectorNewsScores());
route("GET", "/api/news/model-status", () => modelStatus());
