/** /api/insights/* — insights_router.py. */
import { BASE } from "../config";
import { nameKey, portfolioRow } from "../engine/dailyRun";
import { batchHistory, dividends, getHistory } from "../market/fetcher";
import { calendar } from "../market/yahoo";
import { db, platform, Row } from "../platform";
import { nowIso } from "../schema";
import { route } from "../server";
import { guardStatus } from "../sentiment/pipeline";
import { fmt, pyRound } from "../util/py";
import { cov, pctChange, variance } from "../util/series";
import { addDays, todayIst, todayStartUtcIso } from "../util/time";

function holdingsOf(pfId: number): Row[] {
  return db.query("SELECT * FROM holdings WHERE portfolio_id=? ORDER BY id", [pfId]);
}

async function liveHoldingsValue(holdings: Row[]): Promise<[number, Record<string, number>]> {
  if (!holdings.length) return [0, {}];
  const prices: Record<string, number> = {};
  try {
    const data = await batchHistory(holdings.map((h) => String(h.symbol)), "5d");
    for (const [s, df] of Object.entries(data)) if (df.close.length) prices[s] = df.close[df.close.length - 1];
  } catch { /* stored prices */ }
  let total = 0;
  for (const h of holdings) total += (prices[String(h.symbol)] ?? Number(h.current_price ?? h.avg_buy_price)) * Number(h.quantity);
  return [pyRound(total, 2), prices];
}

route("GET", "/api/insights/equity-curve", async () => {
  const pf = portfolioRow();
  const [hv] = await liveHoldingsValue(holdingsOf(Number(pf.id)));
  const cash = Number(pf.cash_balance);
  const total = pyRound(cash + hv, 2);
  let niftyClose: number | null = null;
  try {
    const n = await getHistory(BASE.nifty50_index, "5d");
    niftyClose = pyRound(n.close[n.close.length - 1], 2);
  } catch { /* optional */ }
  let gs = "OK", gv: string | null = null;
  try {
    const g = guardStatus();
    gs = g.market_stopped ? "RED" : "OK";
    gv = g.verdict;
  } catch { /* optional */ }
  db.run(`INSERT INTO portfolio_snapshots (snapshot_date, total_value, cash, holdings_value, nifty_close, guard_status, guard_verdict, created_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(snapshot_date) DO UPDATE SET total_value=excluded.total_value,
          cash=excluded.cash, holdings_value=excluded.holdings_value,
          nifty_close=COALESCE(excluded.nifty_close, portfolio_snapshots.nifty_close),
          guard_status=excluded.guard_status, guard_verdict=excluded.guard_verdict`,
  [todayIst(), total, cash, hv, niftyClose, gs, gv, nowIso()]);

  const rows = db.query("SELECT snapshot_date, total_value, nifty_close FROM portfolio_snapshots ORDER BY snapshot_date");
  let baseV: number | null = null, baseN: number | null = null;
  const points = rows.map((r) => {
    const v = Number(r.total_value);
    const n = r.nifty_close != null ? Number(r.nifty_close) : null;
    if (baseV === null) baseV = v;
    if (baseN === null && n) baseN = n;
    return {
      date: r.snapshot_date, value: v,
      portfolio_pct: baseV ? pyRound((v / baseV - 1) * 100, 2) : 0,
      nifty_pct: n && baseN ? pyRound((n / baseN - 1) * 100, 2) : null,
    };
  });
  const ret = points.length ? points[points.length - 1].portfolio_pct : 0;
  const nret = points.length ? points[points.length - 1].nifty_pct : null;
  return { points, days_tracked: points.length, current_value: total, return_pct: ret, nifty_return_pct: nret,
    alpha_pct: nret != null ? pyRound(ret - nret, 2) : null };
});

route("GET", "/api/insights/journal", async () => {
  const pf = portfolioRow();
  const txns = db.query("SELECT * FROM transactions WHERE portfolio_id=? ORDER BY executed_at DESC, id DESC LIMIT 200", [Number(pf.id)]);
  const sells = txns.filter((t) => t.action === "SELL");
  let hist: Awaited<ReturnType<typeof batchHistory>> = {};
  if (sells.length) {
    try { hist = await batchHistory([...new Set(sells.map((t) => String(t.symbol)))], "1y"); } catch { hist = {}; }
  }
  const priceAfter = (sym: string, when: string, days = 30): number | null => {
    const df = hist[sym];
    if (!df || !df.close.length) return null;
    const target = addDays(when.slice(0, 10), days);
    const i = df.dates.findIndex((d) => d >= target);
    return df.close[i >= 0 ? i : df.close.length - 1];
  };
  const closed = sells.map((t) => {
    const exit = Number(t.price);
    const later = t.executed_at ? priceAfter(String(t.symbol), String(t.executed_at)) : null;
    let grade = "—", note = "Not enough data yet";
    if (later) {
      const move = (later / exit - 1) * 100;
      if (move <= -3) [grade, note] = ["GOOD EXIT", `Fell another ${fmt(Math.abs(move), ".1f")}% after you sold`];
      else if (move >= 5) [grade, note] = ["SOLD EARLY", `Rose ${fmt(move, ".1f")}% after you sold`];
      else [grade, note] = ["NEUTRAL", `Moved ${fmt(move, "+.1f")}% in the 30 days after`];
    }
    return { symbol: t.symbol, date: t.executed_at ? String(t.executed_at).slice(0, 10) : null, qty: t.quantity,
      exit_price: exit, pnl_text: t.reason, grade, note };
  });
  const holdings = holdingsOf(Number(pf.id));
  const sugScores: Record<string, number> = {};
  const sids = txns.filter((t) => t.action === "BUY" && t.suggestion_id).map((t) => Number(t.suggestion_id));
  if (holdings.length && sids.length) {
    for (const r of db.query(`SELECT symbol, composite_score FROM suggestions_log WHERE id IN (${sids.map(() => "?").join(",")})`, sids)) {
      sugScores[String(r.symbol)] = Number(r.composite_score ?? 0);
    }
  }
  return {
    closed,
    open: holdings.map((h) => ({ symbol: h.symbol, qty: h.quantity, avg_buy: Number(h.avg_buy_price),
      current: Number(h.current_price ?? h.avg_buy_price), entry_score: sugScores[String(h.symbol)] ?? null })),
  };
});

/** Align two date-indexed return series (inner join). */
function alignReturns(a: { dates: string[]; close: number[] }, b: { dates: string[]; close: number[] }): [number[], number[]] {
  const ra = pctChange(a.close), rb = pctChange(b.close);
  const mb = new Map(b.dates.map((d, i) => [d, rb[i]]));
  const x: number[] = [], y: number[] = [];
  a.dates.forEach((d, i) => {
    const v = mb.get(d);
    if (v !== undefined && !Number.isNaN(v) && !Number.isNaN(ra[i])) { x.push(ra[i]); y.push(v); }
  });
  return [x, y];
}

route("GET", "/api/insights/risk", async () => {
  const pf = portfolioRow();
  const holdings = holdingsOf(Number(pf.id));
  if (!holdings.length) return { has_holdings: false };
  const [hv, prices] = await liveHoldingsValue(holdings);
  const total = hv + Number(pf.cash_balance);
  const bySector: Record<string, number> = {};
  let largest: { symbol: string | null; pct: number } = { symbol: null, pct: 0 };
  const values: Record<string, number> = {};
  for (const h of holdings) {
    const sym = String(h.symbol);
    const v = (prices[sym] ?? Number(h.current_price ?? h.avg_buy_price)) * Number(h.quantity);
    values[sym] = v;
    if (!["GOLD_ETF", "SILVER_ETF"].includes(String(h.segment))) bySector[String(h.sector)] = (bySector[String(h.sector)] ?? 0) + v;
    const pct = total ? (v / total) * 100 : 0;
    if (pct > largest.pct) largest = { symbol: sym, pct: pyRound(pct, 1) };
  }
  const sectors = Object.entries(bySector).sort((a, b) => b[1] - a[1])
    .map(([s, v]) => ({ sector: s, pct: pyRound((v / total) * 100, 1), breach: v / total > 0.35 }));

  let beta: number | null = null;
  try {
    const data = await batchHistory(holdings.map((h) => String(h.symbol)), "6mo");
    const ndf = await getHistory(BASE.nifty50_index, "6mo");
    const nret = pctChange(ndf.close).slice(1);
    const v = variance(nret);
    let num = 0;
    for (const h of holdings) {
      const df = data[String(h.symbol)];
      if (!df || df.close.length < 30 || v === 0) continue;
      const [x, y] = alignReturns(df, ndf);
      if (x.length < 30) continue;
      num += (hv ? values[String(h.symbol)] / hv : 0) * (cov(x, y) / v);
    }
    beta = num ? pyRound(num, 2) : null;
  } catch { /* optional */ }
  const badDay = pyRound(hv * 0.05 * (beta || 1), 0);
  return {
    has_holdings: true, total_value: pyRound(total, 2), holdings_value: hv,
    cash_pct: total ? pyRound((Number(pf.cash_balance) / total) * 100, 1) : 0,
    sectors, sector_cap_pct: 35, largest_position: largest, portfolio_beta: beta,
    bad_day_estimate: badDay, bad_day_note: `A −5% market day would cost roughly ₹${fmt(badDay, ",.0f")} at current beta.`,
  };
});

route("GET", "/api/insights/dividends", async () => {
  const pf = portfolioRow();
  const holdings = holdingsOf(Number(pf.id));
  if (!holdings.length) return { items: [], total: 0 };
  const firstBuy: Record<string, string> = {};
  for (const t of db.query("SELECT symbol, executed_at FROM transactions WHERE portfolio_id=? AND action='BUY'", [Number(pf.id)])) {
    const s = String(t.symbol), d = String(t.executed_at ?? "");
    if (d && (!firstBuy[s] || d < firstBuy[s])) firstBuy[s] = d;
  }
  const items = [];
  for (const h of holdings) {
    const sym = String(h.symbol);
    try {
      let divs = await dividends(sym);
      if (!divs.length) continue;
      const since = firstBuy[sym]?.slice(0, 10);
      if (since) divs = divs.filter((d) => d.date >= since);
      const per = divs.reduce((a, d) => a + d.amount, 0);
      const amt = per * Number(h.quantity);
      if (amt > 0) items.push({ symbol: sym, per_share: pyRound(per, 2), qty: h.quantity, earned: pyRound(amt, 2), payouts: divs.length });
    } catch { continue; }
  }
  return { items, total: pyRound(items.reduce((a, i) => a + i.earned, 0), 2), note: "Informational — not auto-credited to cash." };
});

route("GET", "/api/insights/watch", async () => {
  const pf = portfolioRow();
  const holdings = holdingsOf(Number(pf.id));
  if (!holdings.length) return { flags: [] };
  const syms = holdings.map((h) => String(h.symbol));
  const uni: Record<string, Row> = {};
  for (const u of db.query(`SELECT * FROM stock_universe WHERE symbol IN (${syms.map(() => "?").join(",")})`, syms)) uni[String(u.symbol)] = u;
  const news = db.query("SELECT headline FROM news_items WHERE fetched_at >= ? AND is_bad_news = 1", [todayStartUtcIso()]);
  const flags: Record<string, { type: string; detail: string }[]> = Object.fromEntries(syms.map((s) => [s, []]));
  for (const sym of syms) {
    const key = nameKey((uni[sym]?.company_name as string) || sym.replace(".NS", ""));
    for (const n of news.filter((x) => String(x.headline).toLowerCase().includes(key)).slice(0, 2)) {
      flags[sym].push({ type: "BAD_NEWS", detail: String(n.headline) });
    }
  }
  let data: Awaited<ReturnType<typeof batchHistory>> = {};
  try { data = await batchHistory(syms, "3mo"); } catch { data = {}; }
  const today = todayIst(), soon = addDays(today, 7);
  for (const sym of syms) {
    const df = data[sym];
    if (df && df.volume.length >= 21) {
      const v = df.volume;
      const avg = v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
      const tv = v[v.length - 1];
      if (avg > 0 && tv / avg >= 2.5) flags[sym].push({ type: "VOLUME", detail: `Volume ${fmt(tv / avg, ".1f")}× the 20-day average` });
    }
    try {
      const cal = await calendar(sym);
      if (cal.earnings && cal.earnings >= today && cal.earnings <= soon) {
        flags[sym].push({ type: "EARNINGS", detail: `Results expected ${cal.earnings} — avoid adding just before` });
      }
      if (cal.exDividend && cal.exDividend >= today && cal.exDividend <= soon) {
        flags[sym].push({ type: "EX_DIVIDEND", detail: `Ex-dividend ${cal.exDividend} — a dip that day isn't a real fall` });
      }
    } catch { continue; }
  }
  return { flags: Object.entries(flags).filter(([, f]) => f.length).map(([symbol, items]) => ({ symbol, items })) };
});

route("GET", "/api/insights/health", () => {
  const active = db.query("SELECT symbol FROM stock_universe WHERE is_active=1");
  const benched = db.query("SELECT symbol, unbuyable_reason FROM stock_universe WHERE is_active=0");
  const analyzed = new Set(db.query("SELECT symbol FROM stock_analysis WHERE analysis_date=?", [todayIst()]).map((r) => String(r.symbol)));
  const lastRun = db.scalar<string>("SELECT suggestion_date FROM suggestions_log ORDER BY suggestion_date DESC LIMIT 1");
  const newsToday = Number(db.scalar("SELECT COUNT(*) FROM news_items WHERE fetched_at >= ?", [todayStartUtcIso()]) ?? 0);
  const missing = active.map((u) => String(u.symbol)).filter((s) => !analyzed.has(s)).sort().slice(0, 15);
  return {
    universe_active: active.length, universe_benched: benched.length,
    benched: benched.slice(0, 10).map((b) => ({ symbol: b.symbol, reason: b.unbuyable_reason })),
    analyzed_today: analyzed.size, missing_today: missing,
    coverage_pct: active.length ? pyRound((analyzed.size / active.length) * 100, 1) : 0,
    news_today: newsToday, last_engine_run: lastRun ?? null, engine_ran_today: lastRun === todayIst(),
  };
});

route("GET", "/api/insights/guard-diary", () => {
  const rows = db.query("SELECT snapshot_date, nifty_close, guard_status, guard_verdict FROM portfolio_snapshots ORDER BY snapshot_date");
  const diary: Record<string, unknown>[] = [];
  let justified = 0, totalRed = 0;
  rows.forEach((r, i) => {
    if (r.guard_status !== "RED") return;
    totalRed++;
    let nxt: number | null = null;
    if (r.nifty_close != null) {
      const later = rows.slice(i + 1).find((x) => x.nifty_close != null);
      if (later) nxt = pyRound((Number(later.nifty_close) / Number(r.nifty_close) - 1) * 100, 2);
    }
    const ok = nxt !== null && nxt < -0.3;
    if (ok) justified++;
    diary.push({ date: r.snapshot_date, verdict: r.guard_verdict, next_day_nifty_pct: nxt, justified: nxt !== null ? ok : null });
  });
  return { red_days: diary, total_red: totalRed, justified,
    note: "A RED day counts as justified if the Nifty fell >0.3% on the next tracked day. " +
      "Builds up as daily snapshots accumulate — this is the honest forward measurement " +
      "of R12 (historical news doesn't exist, so it can't be backtested)." };
});

route("GET", "/api/insights/fii-dii", async () => {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "application/json", Referer: "https://www.nseindia.com/" };
  try {
    await platform().http({ url: "https://www.nseindia.com", headers, timeoutMs: 8000 });
    const r = await platform().http({ url: "https://www.nseindia.com/api/fiidiiTradeReact", headers, timeoutMs: 8000 });
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      const rows = (Array.isArray(data) ? data : []).map((d: any) => ({
        category: d.category, date: d.date, buy: Number(d.buyValue ?? 0), sell: Number(d.sellValue ?? 0), net: Number(d.netValue ?? 0),
      }));
      return { available: rows.length > 0, rows };
    }
  } catch { /* fall through */ }
  return { available: false, note: "NSE flows unavailable right now (their API rate-limits aggressively). Try later." };
});
