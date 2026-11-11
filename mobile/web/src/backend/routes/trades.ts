/** /api/trades/* — trades_router.py endpoints over the pure logic in trades/logic.ts. */
import * as XLSX from "xlsx";
import { batchHistory, cachedHistory, getHistory } from "../market/fetcher";
import type { Bars } from "../market/yahoo";
import { db, platform, SqlValue } from "../platform";
import { j, nowIso, numeric } from "../schema";
import { FileResult, route } from "../server";
import {
  autoSymbolFromFullname, listCandidateSheets, normName, parseSheet, ParsedTrade, prepareRows, Prepared,
  readWorkbook, replayFifo, suggestMerges, symbolCandidates,
} from "../trades/logic";
import { randomHex } from "../util/hash";
import { fmt, HttpError, num, pyRound } from "../util/py";
import { daysBetween, ddmmyy, todayIst } from "../util/time";

const finite = (v: unknown): number | null => {
  const f = Number(v);
  return v == null || !Number.isFinite(f) ? null : f;
};

function universeTickerMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of db.query("SELECT symbol FROM stock_universe")) out[String(r.symbol).replace(".NS", "").toUpperCase()] = String(r.symbol);
  return out;
}

function catalogRows(): [string, string | null][] {
  const uni = db.query("SELECT symbol, company_name FROM stock_universe WHERE is_active=1")
    .map((r) => [String(r.symbol), r.company_name as string | null] as [string, string | null]);
  const seen = new Set(uni.map((r) => r[0]));
  const cat = db.query("SELECT symbol, company_name FROM nse_catalog")
    .filter((r) => !seen.has(String(r.symbol)))
    .map((r) => [String(r.symbol), r.company_name as string | null] as [string, string | null]);
  return [...uni, ...cat];
}

function resolveStock(rawName: string, universe?: Record<string, string>, fullName?: string | null,
                      prepared?: Prepared[]): [number, boolean, string | null] {
  const n = normName(rawName);
  const alias = db.one("SELECT stock_id FROM pf_aliases WHERE raw_norm=?", [n]);
  if (alias) {
    if (fullName) db.run("UPDATE pf_stocks SET full_name=COALESCE(full_name, ?) WHERE id=?", [fullName, Number(alias.stock_id)]);
    return [Number(alias.stock_id), false, null];
  }
  const st = db.one("SELECT id FROM pf_stocks WHERE norm_key=?", [n]);
  if (st) {
    db.run("INSERT INTO pf_aliases (raw_norm, stock_id) VALUES (?,?) ON CONFLICT DO NOTHING", [n, Number(st.id)]);
    return [Number(st.id), false, null];
  }
  let symbol: string | null = universe ? universe[n] ?? null : null;
  if (symbol === null && fullName) symbol = autoSymbolFromFullname(fullName, prepared ?? []);
  const sid = db.run("INSERT INTO pf_stocks (display_name, norm_key, symbol, full_name, created_at) VALUES (?,?,?,?,?)",
    [rawName, n, symbol, fullName ?? null, nowIso()]).lastId;
  db.run("INSERT INTO pf_aliases (raw_norm, stock_id) VALUES (?,?)", [n, sid]);
  return [sid, true, symbol];
}

function replayStock(portfolioRef: number | null, stockId: number): string[] {
  const rows = db.query("SELECT id, side, trade_date, qty, target_lot_id FROM pf_trades WHERE stock_id=? AND portfolio_ref IS ?",
    [stockId, portfolioRef]);
  const buys = rows.filter((r) => r.side === "BUY").map((r) => ({ id: Number(r.id), date: String(r.trade_date), qty: Number(r.qty) }));
  const sells = rows.filter((r) => r.side === "SELL").map((r) => ({
    id: Number(r.id), date: String(r.trade_date), qty: Number(r.qty), target_lot_id: r.target_lot_id as number | null,
  }));
  const [remaining, , warnings] = replayFifo(buys, sells);
  db.batch([...remaining.entries()].map(([id, rem]) => ({
    sql: "UPDATE pf_trades SET qty_remaining=? WHERE id=?", params: [pyRound(rem, 4), id],
  })));
  return warnings;
}

route("GET", "/api/trades/suggest", ({ query }) => {
  const term = (query.get("q") ?? "").trim();
  if (term.length < 2) return { results: [] };
  const like = `%${term}%`;
  const own = db.query("SELECT id, display_name, symbol FROM pf_stocks WHERE display_name LIKE ? OR symbol LIKE ? ORDER BY display_name LIMIT 6",
    [like, like]);
  const results: any[] = own.map((r) => ({ name: r.display_name, symbol: r.symbol, company: null, source: "portfolio" }));
  const takenSyms = new Set(own.filter((r) => r.symbol).map((r) => String(r.symbol)));
  const takenNames = new Set(own.map((r) => normName(String(r.display_name))));
  for (const u of db.query("SELECT symbol, company_name FROM stock_universe WHERE is_active=1 AND (symbol LIKE ? OR company_name LIKE ?) LIMIT 8", [like, like])) {
    const root = String(u.symbol).replace(".NS", "");
    if (takenSyms.has(String(u.symbol)) || takenNames.has(normName(root))) continue;
    results.push({ name: root, symbol: u.symbol, company: u.company_name, source: "nse" });
    if (results.length >= 10) break;
  }
  return { results };
});

const PENDING = new Map<string, { parsed: Record<string, Awaited<ReturnType<typeof parseSheet>>>; ts: number }>();

route("GET", "/api/trades/portfolios", () => ({
  portfolios: db.query(`SELECT p.id, p.name, p.last_section, COUNT(t.id) AS trades FROM pf_portfolios p
      LEFT JOIN pf_trades t ON t.portfolio_ref = p.id GROUP BY p.id ORDER BY p.id`)
    .map((r) => ({ id: r.id, name: r.name, last_section: r.last_section, trades: r.trades })),
}));

route("POST", "/api/trades/portfolios", ({ body }) => {
  const name = String(body?.name ?? "").trim();
  if (!name) throw new HttpError(400, "Portfolio needs a name");
  try {
    const id = db.run("INSERT INTO pf_portfolios (name, created_at) VALUES (?,?)", [name, nowIso()]).lastId;
    return { id, name };
  } catch {
    throw new HttpError(409, `You already have a portfolio named '${name}'`);
  }
});

route("POST", "/api/trades/import/preview", async ({ body }) => {
  const file = body instanceof FormData ? (body.get("file") as File | null) : null;
  if (!file) throw new HttpError(400, "Please upload an .xlsx file");
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) throw new HttpError(400, "Please upload an .xlsx file");
  const sheets = readWorkbook(await file.arrayBuffer());
  const cand = listCandidateSheets(sheets);
  if (!cand.length) throw new HttpError(400, "No sheet with the COMP / Full Form header found");
  const parsedCache: Record<string, Awaited<ReturnType<typeof parseSheet>>> = {};
  const out = [];
  for (const c of cand) {
    let p;
    try { p = await parseSheet(sheets.find((s) => s.name === c.name)!); } catch { continue; }
    parsedCache[c.name] = p;
    const heads: Record<string, number> = {};
    let blank = 0;
    for (const t of [...p.buys, ...p.sells]) {
      if (t.head) heads[t.head] = (heads[t.head] ?? 0) + 1;
      else blank++;
    }
    out.push({ name: c.name, header_row: c.header_row, buys: p.buys.length, sells: p.sells.length,
      skipped: p.skipped.length, heads, blank_head_count: blank });
  }
  if (!out.length) throw new HttpError(400, "Found the header but couldn't parse any sheet");
  for (const [k, v] of PENDING) if (v.ts < Date.now() - 900_000) PENDING.delete(k);
  const token = randomHex(32);
  PENDING.set(token, { parsed: parsedCache, ts: Date.now() });
  return {
    token, sheets: out, default_sheet: out.some((s) => s.name === "23.24") ? "23.24" : out[0].name,
    portfolios: db.query("SELECT id, name FROM pf_portfolios ORDER BY id").map((r) => ({ id: r.id, name: r.name })),
  };
});

route("POST", "/api/trades/import/commit", async ({ body }) => {
  const pend = PENDING.get(body?.token ?? "");
  if (!pend) throw new HttpError(410, "Upload expired (or the app restarted) — please re-upload the file");
  const p = pend.parsed[body?.sheet];
  if (!p) throw new HttpError(400, `Sheet '${body?.sheet}' wasn't in the preview`);
  const all = [...p.buys, ...p.sells];
  const blankCount = all.filter((t) => !t.head).length;
  const blankChoice = body?.blank_head ?? {};
  if (blankCount && !(blankChoice.portfolio_id || String(blankChoice.new_name ?? "").trim())) {
    throw new HttpError(400, `${blankCount} rows have an empty Head — pick a portfolio for them`);
  }
  const byLower = new Map(db.query("SELECT id, name FROM pf_portfolios").map((r) => [String(r.name).trim().toLowerCase(), Number(r.id)]));
  const createdPortfolios: string[] = [];
  const pfForName = (name: string): number => {
    const key = name.trim().toLowerCase();
    if (byLower.has(key)) return byLower.get(key)!;
    const id = db.run("INSERT INTO pf_portfolios (name, created_at) VALUES (?,?)", [name.trim(), nowIso()]).lastId;
    byLower.set(key, id);
    createdPortfolios.push(name.trim());
    return id;
  };
  let blankPfId: number | null = null;
  if (blankCount) {
    if (blankChoice.new_name) blankPfId = pfForName(String(blankChoice.new_name));
    else {
      blankPfId = Number(blankChoice.portfolio_id);
      if (!db.one("SELECT 1 FROM pf_portfolios WHERE id=?", [blankPfId])) throw new HttpError(404, "That portfolio doesn't exist");
    }
  }

  const universe = universeTickerMap();
  const prepared = prepareRows(catalogRows());
  const preExisting = db.query("SELECT id, display_name, norm_key FROM pf_stocks")
    .map((r) => [Number(r.id), String(r.display_name), String(r.norm_key)] as [number, string, string]);
  const stockCache = new Map<string, number>();
  const stocksCreated: string[] = [], symbolsResolved: { name: string; symbol: string }[] = [];
  const stockFor = (t: ParsedTrade): number => {
    if (stockCache.has(t.norm)) return stockCache.get(t.norm)!;
    const [sid, created, sym] = resolveStock(t.raw_name, universe, t.full_form, prepared);
    stockCache.set(t.norm, sid);
    if (created) {
      stocksCreated.push(t.raw_name);
      if (sym) symbolsResolved.push({ name: t.raw_name, symbol: sym });
    }
    return sid;
  };

  const grouped = new Map<number, { buys: ParsedTrade[]; sells: ParsedTrade[] }>();
  for (const [list, key] of [[p.buys, "buys"], [p.sells, "sells"]] as const) {
    for (const t of list) {
      const pfId = t.head ? pfForName(t.head) : blankPfId!;
      if (!grouped.has(pfId)) grouped.set(pfId, { buys: [], sells: [] });
      grouped.get(pfId)![key].push(t);
    }
  }
  const touched = new Set<string>();
  const report = [];
  for (const [pfId, g] of grouped) {
    const hashes = [...g.buys, ...g.sells].map((t) => t.dedup_hash!);
    const exist = new Set<string>();
    for (let i = 0; i < hashes.length; i += 400) {
      const chunk = hashes.slice(i, i + 400);
      for (const r of db.query(`SELECT dedup_hash FROM pf_trades WHERE portfolio_ref=? AND dedup_hash IN (${chunk.map(() => "?").join(",")})`,
        [pfId, ...chunk])) exist.add(String(r.dedup_hash));
    }
    let nb = 0, ns = 0, dup = 0;
    const stmts: { sql: string; params: SqlValue[] }[] = [];
    for (const t of g.buys) {
      if (exist.has(t.dedup_hash!)) { dup++; continue; }
      const sid = stockFor(t);
      stmts.push({ sql: `INSERT INTO pf_trades (portfolio_ref, stock_id, side, trade_date, qty, price, gross_value, cost_value,
                    brokerage, source, dedup_hash, extras, created_at) VALUES (?,?,'BUY',?,?,?,?,?,?,'IMPORT',?,?,?)`,
        params: [pfId, sid, t.date, numeric(t.qty, 4), numeric(t.price, 4), numeric(t.gross), numeric(t.cost), numeric(t.brokerage),
          t.dedup_hash!, JSON.stringify(t.extras), nowIso()] });
      nb++;
      touched.add(`${pfId}:${sid}`);
    }
    for (const t of g.sells) {
      if (exist.has(t.dedup_hash!)) { dup++; continue; }
      const sid = stockFor(t);
      stmts.push({ sql: `INSERT INTO pf_trades (portfolio_ref, stock_id, side, trade_date, qty, price, gross_value, source,
                    dedup_hash, extras, created_at) VALUES (?,?,'SELL',?,?,?,?,'IMPORT',?,?,?)`,
        params: [pfId, sid, t.date, numeric(t.qty, 4), numeric(t.price, 4), numeric(t.gross), t.dedup_hash!, JSON.stringify(t.extras), nowIso()] });
      ns++;
      touched.add(`${pfId}:${sid}`);
    }
    db.batch(stmts);
    report.push({ portfolio: db.scalar("SELECT name FROM pf_portfolios WHERE id=?", [pfId]), new_buys: nb, new_sells: ns, duplicates_skipped: dup });
  }
  const warnings: string[] = [];
  for (const key of touched) {
    const [pf, sid] = key.split(":").map(Number);
    warnings.push(...replayStock(pf, sid));
  }
  PENDING.delete(body.token);
  return {
    portfolios: report, portfolios_created: createdPortfolios, stocks_created: stocksCreated,
    symbols_resolved: symbolsResolved,
    unmapped_count: Number(db.scalar("SELECT COUNT(*) FROM pf_stocks WHERE symbol IS NULL") ?? 0),
    skipped_rows: p.skipped.slice(0, 40), skipped_total: p.skipped.length,
    merge_suggestions: suggestMerges(stocksCreated.map(normName), preExisting).slice(0, 20),
    oversell_warnings: warnings.slice(0, 20),
  };
});

function quotesFromHistory(data: Record<string, Bars>): Record<string, { price: number; change_pct: number }> {
  const out: Record<string, { price: number; change_pct: number }> = {};
  for (const [sym, df] of Object.entries(data)) {
    if (!df?.close.length) continue;
    const c = df.close;
    const last = finite(c[c.length - 1]);
    if (last === null) continue;
    const prev = c.length >= 2 ? finite(c[c.length - 2]) : last;
    out[sym] = { price: pyRound(last, 2), change_pct: prev ? pyRound((last / prev - 1) * 100, 2) : 0 };
  }
  return out;
}

async function fetchQuotes(symbols: string[]) {
  if (!symbols.length) return {};
  try { return quotesFromHistory(await batchHistory(symbols, "5d")); } catch { return {}; }
}

route("GET", "/api/trades/portfolio", async ({ query }) => {
  const pfParam = query.get("portfolio_id");
  const params: SqlValue[] = [];
  let sql = `SELECT s.id AS sid, s.display_name, s.symbol, t.id AS tid, t.trade_date, t.qty, t.price, t.qty_remaining,
               t.cost_value, t.portfolio_ref, p.name AS pname
             FROM pf_trades t JOIN pf_stocks s ON s.id = t.stock_id LEFT JOIN pf_portfolios p ON p.id = t.portfolio_ref
             WHERE t.side='BUY'`;
  if (pfParam) { sql += " AND t.portfolio_ref=?"; params.push(Number(pfParam)); }
  sql += " ORDER BY t.id";
  const per = new Map<string, any>();
  for (const r of db.query(sql, params)) {
    const rem = Number(r.qty_remaining ?? r.qty);
    const key = `${r.portfolio_ref}:${r.sid}`;
    if (!per.has(key)) per.set(key, { stock_id: r.sid, name: r.display_name, symbol: r.symbol, portfolio_id: r.portfolio_ref,
      portfolio_name: r.pname, held: 0, value_open: 0, cost_open: 0, lots_open: 0, lowest: null, total_lots: 0 });
    const st = per.get(key);
    st.total_lots++;
    if (rem > 1e-9) {
      const p = Number(r.price);
      const eff = r.cost_value && Number(r.qty) ? Number(r.cost_value) / Number(r.qty) : p;
      st.held += rem; st.value_open += rem * p; st.cost_open += rem * eff; st.lots_open++;
      if (st.lowest === null || p < st.lowest.price) st.lowest = { lot_id: r.tid, price: p, qty_remaining: pyRound(rem, 4), date: r.trade_date };
    }
  }
  const held = [...per.values()].filter((s) => s.held > 1e-9);
  const symbols = [...new Set(held.filter((s) => s.symbol).map((s) => String(s.symbol)))].sort();
  const quotes = query.get("prices") === "full" ? await fetchQuotes(symbols) : quotesFromHistory(cachedHistory(symbols, "5d"));
  const out = held.map((s) => {
    const q = quotes[s.symbol ?? ""];
    const avg = s.held ? s.value_open / s.held : 0, avgEff = s.held ? s.cost_open / s.held : 0;
    const cur = q ? q.price : null;
    return {
      stock_id: s.stock_id, name: s.name, symbol: s.symbol, portfolio_id: s.portfolio_id, portfolio_name: s.portfolio_name,
      held_qty: pyRound(s.held, 4), avg_buy: pyRound(avg, 2), avg_buy_incl_brokerage: pyRound(avgEff, 2),
      invested: pyRound(s.value_open, 2), current_price: cur, day_change_pct: q ? q.change_pct : null,
      market_value: cur !== null ? pyRound(cur * s.held, 2) : null,
      pnl: cur !== null ? pyRound((cur - avg) * s.held, 2) : null,
      pnl_pct: cur !== null && avg ? pyRound((cur / avg - 1) * 100, 2) : null,
      lots_open: s.lots_open, total_lots: s.total_lots, lowest_lot: s.lowest,
    };
  });
  out.sort((a, b) => (b.market_value || b.invested) - (a.market_value || a.invested));
  return {
    holdings: out,
    totals: {
      invested: pyRound(out.reduce((a, x) => a + x.invested, 0), 2),
      market_value: pyRound(out.reduce((a, x) => a + (x.market_value || x.invested), 0), 2),
      pnl: pyRound(out.reduce((a, x) => a + (x.pnl || 0), 0), 2),
      stocks: out.length, priced: out.filter((x) => x.current_price !== null).length,
      unpriceable: out.filter((x) => !x.symbol).length,
    },
    pending_symbols: [...new Set(out.filter((x) => x.symbol && x.current_price === null).map((x) => String(x.symbol)))].sort(),
  };
});

route("GET", "/api/trades/quotes", async ({ query }) => {
  const wanted = (query.get("symbols") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 40);
  if (!wanted.length) return { quotes: {}, missing: [] };
  const got = await fetchQuotes(wanted);
  return { quotes: got, missing: wanted.filter((s) => !(s in got)) };
});

route("GET", "/api/trades/stock/:id", async ({ params, query }) => {
  const st = db.one("SELECT id, display_name, symbol FROM pf_stocks WHERE id=?", [Number(params.id)]);
  if (!st) throw new HttpError(404, "Stock not found");
  const pfParam = query.get("portfolio_id");
  const rows = db.query(`SELECT * FROM pf_trades WHERE stock_id=? ${pfParam ? "AND portfolio_ref=?" : ""} ORDER BY trade_date, id`,
    pfParam ? [Number(params.id), Number(pfParam)] : [Number(params.id)]);
  const lots: any[] = [], sells: any[] = [];
  for (const r of rows) {
    if (r.side === "BUY") {
      const qty = Number(r.qty), rem = Number(r.qty_remaining ?? r.qty);
      const status = Math.abs(rem - qty) < 1e-9 ? "OPEN" : rem <= 1e-9 ? "SOLD" : "PARTIAL";
      lots.push({ lot_id: r.id, date: r.trade_date, qty, price: Number(r.price), gross: Number(r.gross_value ?? 0),
        cost: r.cost_value ? Number(r.cost_value) : null, brokerage: r.brokerage ? Number(r.brokerage) : null,
        qty_remaining: pyRound(rem, 4), status, source: r.source });
    } else {
      sells.push({ trade_id: r.id, date: r.trade_date, qty: Number(r.qty), price: Number(r.price),
        value: Number(r.gross_value ?? 0), target_lot_id: r.target_lot_id, source: r.source });
    }
  }
  let quote = null;
  if (st.symbol) {
    try {
      const q = quotesFromHistory({ [String(st.symbol)]: await getHistory(String(st.symbol), "5d") });
      quote = q[String(st.symbol)] ?? null;
    } catch { /* unpriced */ }
  }
  const order: Record<string, number> = { OPEN: 0, PARTIAL: 0, SOLD: 1 };
  lots.sort((a, b) => order[a.status] - order[b.status] || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { stock_id: st.id, name: st.display_name, symbol: st.symbol, quote, lots, sells,
    held_qty: pyRound(lots.reduce((a, l) => a + l.qty_remaining, 0), 4) };
});

function parseDateOrToday(d: unknown): string {
  if (!d) return todayIst();
  const s = String(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new HttpError(400, "Date must be YYYY-MM-DD");
  return s;
}

route("POST", "/api/trades/add", ({ body }) => {
  const name = String(body?.name ?? "").trim();
  const qty = num(body?.qty), price = num(body?.price);
  const brokerage = num(body?.brokerage) || 0;
  if (!name || !qty || qty <= 0 || !price || price <= 0) throw new HttpError(400, "Need name, qty > 0 and price > 0");
  const d = parseDateOrToday(body?.date);
  let pfId: number | null = body?.portfolio_id ?? null;
  const pfs = db.query("SELECT id FROM pf_portfolios ORDER BY id").map((r) => Number(r.id));
  if (pfId == null) {
    if (pfs.length === 0) pfId = db.run("INSERT INTO pf_portfolios (name, created_at) VALUES ('Portfolio 1', ?)", [nowIso()]).lastId;
    else if (pfs.length === 1) pfId = pfs[0];
    else throw new HttpError(400, "You have multiple portfolios — pick one");
  } else if (!pfs.includes(Number(pfId))) throw new HttpError(404, "Portfolio not found");
  const [sid, created, symResolved] = resolveStock(name, universeTickerMap());
  let sym = symResolved;
  let picked = String(body?.symbol ?? "").trim().toUpperCase();
  if (picked) {
    if (!picked.endsWith(".NS")) picked += ".NS";
    db.run("UPDATE pf_stocks SET symbol=? WHERE id=?", [picked, sid]);
    sym = picked;
  }
  const gross = pyRound(qty * price, 2);
  db.run(`INSERT INTO pf_trades (portfolio_ref, stock_id, side, trade_date, qty, price, gross_value, cost_value, brokerage,
          source, dedup_hash, created_at) VALUES (?,?,'BUY',?,?,?,?,?,?,'MANUAL',?,?)`,
  [Number(pfId), sid, d, numeric(qty, 4), numeric(price, 4), gross, pyRound(gross + brokerage, 2), numeric(brokerage), `MANUAL-${randomHex(20)}`, nowIso()]);
  replayStock(Number(pfId), sid);
  return { status: `Added ${fmt(qty, "g")} × ${name} @ ₹${fmt(price, ",.2f")}`, stock_id: sid, new_stock: created, symbol_resolved: sym };
});

route("POST", "/api/trades/sell", ({ body }) => {
  const stockId = Number(body?.stock_id);
  const qty = num(body?.qty), price = num(body?.price);
  if (!stockId || !qty || qty <= 0 || !price || price <= 0) throw new HttpError(400, "Need stock_id, qty > 0 and price > 0");
  const d = parseDateOrToday(body?.date);
  const pfId = body?.portfolio_id;
  if (!pfId) throw new HttpError(400, "portfolio_id is required");
  if (!db.one("SELECT 1 FROM pf_stocks WHERE id=?", [stockId])) throw new HttpError(404, "Stock not found");
  const avail = Number(db.scalar("SELECT COALESCE(SUM(qty_remaining),0) FROM pf_trades WHERE stock_id=? AND side='BUY' AND portfolio_ref=?",
    [stockId, Number(pfId)]) ?? 0);
  if (qty > avail + 1e-9) throw new HttpError(400, `Only ${fmt(avail, "g")} shares held — can't sell ${fmt(qty, "g")}`);
  db.run(`INSERT INTO pf_trades (portfolio_ref, stock_id, side, trade_date, qty, price, gross_value, source, dedup_hash, created_at)
          VALUES (?,?,'SELL',?,?,?,?,'MANUAL',?,?)`,
  [Number(pfId), stockId, d, numeric(qty, 4), numeric(price, 4), pyRound(qty * price, 2), `MANUAL-${randomHex(20)}`, nowIso()]);
  replayStock(Number(pfId), stockId);
  return { status: `Sold ${fmt(qty, "g")} @ ₹${fmt(price, ",.2f")} (FIFO across lots)` };
});

route("POST", "/api/trades/sell-lot", ({ body }) => {
  const lotId = Number(body?.lot_id);
  const price = num(body?.price);
  let qty = num(body?.qty);
  if (!lotId || !price || price <= 0) throw new HttpError(400, "Need lot_id and price > 0");
  const d = parseDateOrToday(body?.date);
  const lot = db.one("SELECT id, stock_id, qty_remaining, portfolio_ref FROM pf_trades WHERE id=? AND side='BUY'", [lotId]);
  if (!lot) throw new HttpError(404, "Lot not found");
  const rem = Number(lot.qty_remaining ?? 0);
  if (rem <= 1e-9) throw new HttpError(400, "That lot is already fully sold");
  qty = qty || rem;
  if (qty > rem + 1e-9) throw new HttpError(400, `Lot has only ${fmt(rem, "g")} shares remaining`);
  db.run(`INSERT INTO pf_trades (portfolio_ref, stock_id, side, trade_date, qty, price, gross_value, target_lot_id, source,
          dedup_hash, created_at) VALUES (?,?,'SELL',?,?,?,?,?,'MANUAL',?,?)`,
  [lot.portfolio_ref, Number(lot.stock_id), d, numeric(qty, 4), numeric(price, 4), pyRound(qty * price, 2), lotId, `MANUAL-${randomHex(20)}`, nowIso()]);
  replayStock(lot.portfolio_ref as number | null, Number(lot.stock_id));
  return { status: `Sold ${fmt(qty, "g")} from this lot @ ₹${fmt(price, ",.2f")}` };
});

route("POST", "/api/trades/stocks/:id/merge", ({ params, body }) => {
  const a = db.one("SELECT id, display_name FROM pf_stocks WHERE id=?", [Number(params.id)]);
  const b = db.one("SELECT id, display_name FROM pf_stocks WHERE id=?", [Number(body?.other_stock_id)]);
  if (!a || !b || a.id === b.id) throw new HttpError(404, "Both stocks must exist and differ");
  db.batch([
    { sql: "UPDATE pf_trades SET stock_id=? WHERE stock_id=?", params: [Number(a.id), Number(b.id)] },
    { sql: "UPDATE pf_aliases SET stock_id=? WHERE stock_id=?", params: [Number(a.id), Number(b.id)] },
    { sql: "DELETE FROM pf_stocks WHERE id=?", params: [Number(b.id)] },
  ]);
  for (const r of db.query("SELECT DISTINCT portfolio_ref FROM pf_trades WHERE stock_id=?", [Number(a.id)])) {
    replayStock(r.portfolio_ref as number | null, Number(a.id));
  }
  return { status: `Merged '${b.display_name}' into '${a.display_name}' — future imports of either name land here` };
});

route("POST", "/api/trades/stocks/:id/symbol", ({ params, body }) => {
  let sym = String(body?.symbol ?? "").trim().toUpperCase();
  if (sym && !sym.endsWith(".NS")) sym += ".NS";
  const row = db.one("SELECT display_name FROM pf_stocks WHERE id=?", [Number(params.id)]);
  if (!row) throw new HttpError(404, "Stock not found");
  db.run("UPDATE pf_stocks SET symbol=? WHERE id=?", [sym || null, Number(params.id)]);
  return { status: `${row.display_name} → ${sym || "no symbol (price lookup off)"}` };
});

route("GET", "/api/trades/catalog/status", () => ({ count: Number(db.scalar("SELECT COUNT(*) FROM nse_catalog") ?? 0) }));

route("POST", "/api/trades/catalog/refresh", async () => {
  const headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", Accept: "text/csv,*/*" };
  const urls = ["https://archives.nseindia.com/content/equities/EQUITY_L.csv",
    "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
    "https://archives.nseindia.com/content/equities/eq_etfseclist.csv",
    "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv"];
  const collected: [string, string | null][] = [];
  const sources: string[] = [];
  for (const u of urls) {
    try {
      const r = await platform().http({ url: u, headers, timeoutMs: 25000 });
      if (r.status !== 200 || !r.body.slice(0, 300).toUpperCase().includes("SYMBOL")) continue;
      const lines = r.body.split(/\r?\n/).filter((l) => l.trim());
      const hdr = splitCsv(lines[0]).map((h) => h.trim().toUpperCase());
      let got = 0;
      for (const line of lines.slice(1)) {
        const cells = splitCsv(line).map((c) => c.trim());
        const row: Record<string, string> = {};
        hdr.forEach((h, i) => { row[h] = cells[i] ?? ""; });
        const sym = row.SYMBOL;
        const name = row["NAME OF COMPANY"] || row["NAME OF THE COMPANY"] || row["SECURITY NAME"] || row.UNDERLYING || null;
        const series = (row.SERIES ?? "").toUpperCase();
        if (sym && ["EQ", "BE", "BZ", "SM", "ST", ""].includes(series)) { collected.push([`${sym.toUpperCase()}.NS`, name]); got++; }
      }
      if (got) sources.push(u.split("/").pop()!);
    } catch { continue; }
  }
  if (!collected.length) throw new HttpError(502, "Couldn't download NSE's equity list right now — try again in a minute");
  db.batch(collected.map(([s, n]) => ({
    sql: "INSERT INTO nse_catalog (symbol, company_name, updated_at) VALUES (?,?,?) ON CONFLICT(symbol) DO UPDATE SET company_name=excluded.company_name, updated_at=excluded.updated_at",
    params: [s, n, nowIso()],
  })));
  return { loaded: collected.length, source: sources.join(" + "),
    status: `NSE catalog loaded — ${fmt(collected.length, ",")} companies available for mapping` };
});

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

route("GET", "/api/trades/catalog/search", ({ query }) => {
  const term = (query.get("q") ?? "").trim();
  if (term.length < 2) return { results: [] };
  const rows = db.query(`SELECT symbol, company_name FROM nse_catalog WHERE symbol LIKE ? OR company_name LIKE ?
      ORDER BY (symbol LIKE ?) DESC, symbol LIMIT 12`, [`%${term}%`, `%${term}%`, `${term}%`]);
  return { results: rows.map((r) => ({ symbol: r.symbol, company: r.company_name })) };
});

route("GET", "/api/trades/unmapped-suggestions", () => {
  const stocks = db.query(`SELECT DISTINCT s.id, s.display_name, s.norm_key FROM pf_stocks s JOIN pf_trades t ON t.stock_id = s.id
      WHERE s.symbol IS NULL ORDER BY s.display_name`);
  const prepared = prepareRows(catalogRows());
  return {
    unmapped: stocks.map((s) => {
      const cands = symbolCandidates(String(s.norm_key), prepared);
      return { stock_id: s.id, name: s.display_name, candidates: cands,
        preselect: cands.length && cands[0].score >= 0.9 ? cands[0].symbol : null };
    }),
  };
});

route("POST", "/api/trades/apply-symbols", ({ body }) => {
  let applied = 0;
  for (const m of body?.mappings ?? []) {
    let sym = String(m?.symbol ?? "").trim().toUpperCase();
    const sid = m?.stock_id;
    if (!sym || !sid) continue;
    if (!sym.endsWith(".NS")) sym += ".NS";
    if (db.run("UPDATE pf_stocks SET symbol=? WHERE id=?", [sym, Number(sid)]).changes) applied++;
  }
  return { applied, status: `Linked ${applied} stock(s) to live prices` };
});

// ── Export in the user's v3 layout ───────────────────────────────────────────
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const excelSerial = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86400000;

route("GET", "/api/trades/export", () => {
  const rows = db.query(`SELECT t.id, s.display_name, s.full_name, t.side, t.trade_date, t.qty, t.price, t.gross_value,
      t.cost_value, t.brokerage, t.qty_remaining, t.target_lot_id, t.extras, t.stock_id, t.portfolio_ref,
      COALESCE(p.name,'') AS pname FROM pf_trades t JOIN pf_stocks s ON s.id=t.stock_id
      LEFT JOIN pf_portfolios p ON p.id=t.portfolio_ref ORDER BY s.display_name, t.trade_date, t.id`);
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const groups = new Map<string, { buys: any[]; sells: any[] }>();
  for (const r of rows) {
    const key = `${r.portfolio_ref}:${r.stock_id}`;
    if (!groups.has(key)) groups.set(key, { buys: [], sells: [] });
    const rec = { id: Number(r.id), date: String(r.trade_date), qty: Number(r.qty), target_lot_id: r.target_lot_id as number | null };
    groups.get(key)![r.side === "BUY" ? "buys" : "sells"].push(rec);
  }
  const consumption = new Map<number, [number, number][]>();
  for (const g of groups.values()) for (const [k, v] of replayFifo(g.buys, g.sells)[1]) consumption.set(k, v);

  type C = string | number | null | { date: string };
  const aoa: C[][] = [];
  const HDR = ["COMP", "Full Form", "Head", "@", "Qty", "Purch Amt", "Amt+Brock", "Rate", "Purch Date", "Broker", "%", "",
    "Sale Date", "@", "Qty", "Sale Amt", "Sale-Brcok", "NSDL Ch", "Profit", "% Profit", "Days", "XIM %", "Total Brock", "% T Brock"];
  aoa.push(HDR);
  const sells = rows.filter((r) => r.side === "SELL")
    .sort((a, b) => (String(a.trade_date) < String(b.trade_date) ? -1 : String(a.trade_date) > String(b.trade_date) ? 1 : Number(a.id) - Number(b.id)));
  const sums: Record<string, number> = {};
  const add = (k: string, v: number) => { sums[k] = (sums[k] ?? 0) + v; };
  for (const r of sells) {
    const ex = j<Record<string, any>>(r.extras, {});
    const sQty = Number(r.qty), sPrice = Number(r.price);
    const sAmt = Number(r.gross_value || sQty * sPrice);
    let bAmt = 0, bCost = 0, bBroker = 0, bDate: string | null = null;
    for (const [lotId, take] of consumption.get(Number(r.id)) ?? []) {
      const lot = byId.get(lotId);
      if (!lot) continue;
      const lqty = Number(lot.qty) || 1;
      const frac = take / lqty;
      bAmt += take * Number(lot.price);
      bCost += frac * Number(lot.cost_value || lot.gross_value || take * Number(lot.price));
      bBroker += frac * Number(lot.brokerage || 0);
      if (bDate === null || String(lot.trade_date) < bDate) bDate = String(lot.trade_date);
    }
    if (bDate === null) bDate = String(r.trade_date);
    const rate = sQty ? bCost / sQty : null;
    const sNet = ex.SaleNet ?? sAmt;
    const nsdl = ex.NSDLCh ?? 0;
    const saleBroker = sAmt - Number(sNet);
    const profit = ex.Profit ?? Number(sNet) - bCost - Number(nsdl);
    const ppct = ex.ProfitPct ?? (bCost ? (profit / bCost) * 100 : 0);
    const days = ex.Days ?? daysBetween(bDate, String(r.trade_date));
    const xim = ex.XIMPct ?? (days != null ? (ppct * 365) / (days + 1) : null);
    const tbrock = ex.TotalBrock ?? bBroker + saleBroker + Number(nsdl);
    const tbpct = ex.TBrockPct ?? (sAmt ? (tbrock / sAmt) * 100 : 0);
    const bpct = bAmt ? (bBroker / bAmt) * 100 : null;
    aoa.push([r.display_name as string, r.full_name as string, (r.pname as string) || "",
      sQty ? pyRound(bAmt / sQty, 4) : null, sQty, pyRound(bAmt, 2), pyRound(bCost, 2), rate ? pyRound(rate, 6) : null,
      { date: bDate }, pyRound(bBroker, 2), bpct, "", { date: String(r.trade_date) }, sPrice, sQty, pyRound(sAmt, 2),
      pyRound(Number(sNet), 2), pyRound(Number(nsdl), 2), pyRound(Number(profit), 4), ppct, days, xim, pyRound(Number(tbrock), 4), tbpct]);
    add("PurchAmt", bAmt); add("Cost", bCost); add("Broker", bBroker); add("SaleAmt", sAmt);
    add("SaleNet", Number(sNet)); add("NSDL", Number(nsdl)); add("Profit", Number(profit)); add("TBrock", Number(tbrock));
  }
  aoa.push([]);
  if (sells.length) {
    aoa.push(["TOTAL SALE at a GLANCE", "", "", "", "", pyRound(sums.PurchAmt, 2), pyRound(sums.Cost, 2), "", "",
      pyRound(sums.Broker, 2), sums.PurchAmt ? (sums.Broker / sums.PurchAmt) * 100 : null, "", "", "", "",
      pyRound(sums.SaleAmt, 2), pyRound(sums.SaleNet, 2), pyRound(sums.NSDL, 2), pyRound(sums.Profit, 4),
      sums.Cost ? (sums.Profit / sums.Cost) * 100 : null, "", "", pyRound(sums.TBrock, 4),
      sums.SaleAmt ? (sums.TBrock / sums.SaleAmt) * 100 : null]);
  }
  aoa.push([]);
  const openLots = rows.filter((r) => r.side === "BUY" && Number(r.qty_remaining ?? r.qty) > 1e-9)
    .sort((a, b) => cmpStr(String(a.display_name), String(b.display_name)) ||
      cmpStr(String(a.trade_date), String(b.trade_date)) || Number(a.id) - Number(b.id));
  const hsum = { Amt: 0, Cost: 0, Broker: 0 };
  for (const r of openLots) {
    const qty = Number(r.qty), rem = Number(r.qty_remaining ?? qty);
    const frac = qty ? rem / qty : 1;
    const price = Number(r.price), amt = rem * price;
    const cost = frac * Number(r.cost_value || r.gross_value || amt);
    const broker = frac * Number(r.brokerage || 0);
    aoa.push([r.display_name as string, r.full_name as string, (r.pname as string) || "", price, rem, pyRound(amt, 2),
      pyRound(cost, 2), rem ? pyRound(cost / rem, 6) : null, { date: String(r.trade_date) }, pyRound(broker, 2),
      amt ? (broker / amt) * 100 : null]);
    hsum.Amt += amt; hsum.Cost += cost; hsum.Broker += broker;
  }
  aoa.push(["Present Holding at a Glance", "", "", "", "", pyRound(hsum.Amt, 2), pyRound(hsum.Cost, 2), "", "",
    pyRound(hsum.Broker, 2), hsum.Amt ? (hsum.Broker / hsum.Amt) * 100 : null]);
  aoa.push(["COMP", "Full Form", "Head", "@", "Qty", "Purch Amt", "Amt+Brock", "Eff Rate", "Purch Date", "Broker", "%"]);
  aoa.push(["(A)", "(B)", "C", "D", "E", "F", "G", "H", "K", "L", "(J)"]);

  const ws: XLSX.WorkSheet = {};
  let maxC = 0;
  aoa.forEach((row, r) => row.forEach((v, c) => {
    maxC = Math.max(maxC, c);
    if (v === null || v === undefined) return;
    const ref = XLSX.utils.encode_cell({ r, c });
    if (typeof v === "object") ws[ref] = { t: "n", v: excelSerial(v.date), z: "yyyy-mm-dd" };
    else if (typeof v === "number") ws[ref] = { t: "n", v };
    else if (v !== "") ws[ref] = { t: "s", v };
  }));
  ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: maxC } });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "23.24");
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  const filename = `CF1_Share_Software_${ddmmyy(todayIst())}.xlsx`;
  return new FileResult(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), filename);
});
