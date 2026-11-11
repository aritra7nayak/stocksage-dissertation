/** /api/settings/* and /api/execute/* — settings_router.py, execute_router.py, backtest/router.py execution bits. */
import { ALLOC_KEYS, BASE, EDITABLE, EditableKey, liveSettings, readOverrides } from "../config";
import { portfolioRow } from "../engine/dailyRun";
import { getQuote } from "../market/fetcher";
import { db } from "../platform";
import { nowIso, numeric } from "../schema";
import { route } from "../server";
import { fmt, HttpError, pyRound } from "../util/py";

export const PRESETS: Record<string, { stop_loss_pct: number; cash_reserve_pct: number }> = {
  conservative: { stop_loss_pct: 0.08, cash_reserve_pct: 0.2 },
  medium: { stop_loss_pct: 0.1, cash_reserve_pct: 0.15 },
  aggressive: { stop_loss_pct: 0.12, cash_reserve_pct: 0.1 },
};

const upsertSetting = (key: string, val: number) => ({
  sql: `INSERT INTO app_settings (key, value, value_type, description, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  params: [key, String(val), EDITABLE[key as EditableKey].type, EDITABLE[key as EditableKey].label, nowIso()],
});

route("GET", "/api/settings", () => {
  const o = readOverrides();
  const items = (Object.keys(EDITABLE) as EditableKey[]).map((key) => ({
    key, label: EDITABLE[key].label, group: EDITABLE[key].group, type: EDITABLE[key].type,
    value: o[key] ?? BASE[key], default: BASE[key], is_overridden: key in o,
  }));
  const allocSum = ALLOC_KEYS.reduce((a, k) => a + (o[k] ?? BASE[k]), 0);
  return { settings: items, allocation_sum: pyRound(allocSum, 4), allocation_ok: Math.abs(allocSum - 1) < 1e-6 };
});

route("PUT", "/api/settings", ({ body }) => {
  const values: Record<string, number> = body?.values ?? {};
  for (const k of Object.keys(values)) if (!(k in EDITABLE)) throw new HttpError(400, `Unknown setting: ${k}`);
  const merged = { ...BASE, ...readOverrides(), ...values } as unknown as Record<string, number>;
  const allocSum = ALLOC_KEYS.reduce((a, k) => a + Number(merged[k]), 0);
  if (Math.abs(allocSum - 1) > 1e-6) {
    throw new HttpError(400, `Allocation must sum to 100%. Cash + Gold/Silver + Nifty50 + Next100 + Smallcap ` +
      `= ${fmt(allocSum * 100, ".1f")}%. Adjust the buckets so they total 100%.`);
  }
  const stmts = Object.entries(values).map(([k, v]) => upsertSetting(k, Number(v)));
  if ("total_capital" in values) {
    const pf = portfolioRow();
    const cap = Number(values.total_capital);
    // Only reset cash when nothing is invested yet (cash == capital)
    const cash = Math.abs(Number(pf.cash_balance) - Number(pf.total_capital)) < 1 ? cap : Number(pf.cash_balance);
    stmts.push({ sql: "UPDATE portfolios SET cash_balance=?, total_capital=?, updated_at=? WHERE id=?",
      params: [cash, cap, nowIso(), Number(pf.id)] as any });
  }
  db.batch(stmts);
  return { status: "saved", updated: Object.keys(values) };
});

route("POST", "/api/settings/preset/:preset", ({ params }) => {
  const vals = PRESETS[params.preset];
  if (!vals) throw new HttpError(400, `Unknown preset. Choose: ${JSON.stringify(Object.keys(PRESETS))}`);
  db.batch(Object.entries(vals).map(([k, v]) => upsertSetting(k, v)));
  return { status: "applied", preset: params.preset, values: vals };
});

route("POST", "/api/settings/reset", () => {
  db.run("DELETE FROM app_settings");
  return { status: "reset to defaults" };
});

// ── Paper-trading execution ──────────────────────────────────────────────────
function logTradeConfig(symbol: string, action: string) {
  const live = liveSettings() as unknown as Record<string, number>;
  const cfg = Object.fromEntries(Object.keys(EDITABLE).map((k) => [k, live[k]]));
  return { sql: "INSERT INTO trade_config_log (symbol, action, config, created_at) VALUES (?,?,?,?)",
    params: [symbol, action, JSON.stringify(cfg), nowIso()] };
}

function addOrMergeHolding(pfId: number, symbol: string, qty: number, price: number, total: number,
                           segment: string | null, sector: string | null, name: string | null, setCurrent: boolean) {
  const h = db.one("SELECT * FROM holdings WHERE portfolio_id=? AND symbol=?", [pfId, symbol]);
  if (h) {
    const newQty = Number(h.quantity) + qty;
    const avg = pyRound((Number(h.avg_buy_price) * Number(h.quantity) + total) / newQty, 2);
    return setCurrent
      ? { sql: "UPDATE holdings SET quantity=?, avg_buy_price=?, current_price=?, peak_price=?, updated_at=? WHERE id=?",
        params: [newQty, avg, numeric(price), numeric(Math.max(Number(h.peak_price ?? 0), price)), nowIso(), Number(h.id)] }
      : { sql: "UPDATE holdings SET quantity=?, avg_buy_price=?, updated_at=? WHERE id=?",
        params: [newQty, avg, nowIso(), Number(h.id)] };
  }
  return { sql: `INSERT INTO holdings (portfolio_id, symbol, company_name, quantity, avg_buy_price, current_price, peak_price,
      segment, sector, bought_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    params: [pfId, symbol, name, qty, numeric(price), numeric(price), numeric(price), segment, sector, nowIso(), nowIso()] };
}

function executeSuggestion(id: number, verb: "buy" | "any") {
  const sug = db.one("SELECT * FROM suggestions_log WHERE id=?", [id]);
  if (!sug) throw new HttpError(404, "Suggestion not found");
  if (verb === "buy" && sug.action !== "BUY") throw new HttpError(400, `Suggestion is a ${sug.action}, not a BUY`);
  if (sug.was_acted_on) throw new HttpError(409, verb === "buy" ? "Already executed" : `Suggestion ${id} was already executed`);
  return sug;
}

route("POST", "/api/execute/buy/:id", ({ params }) => {
  const sug = executeSuggestion(Number(params.id), "buy");
  const qty = Number(sug.suggested_quantity ?? 0), price = Number(sug.suggested_price ?? 0);
  const total = Number(sug.total_value ?? qty * price);
  if (qty <= 0 || total <= 0) throw new HttpError(400, "Suggestion has no quantity/price");
  const pf = portfolioRow();
  const cash = Number(pf.cash_balance);
  if (total > cash) throw new HttpError(400, `Insufficient cash: need ₹${fmt(total, ",.0f")}, have ₹${fmt(cash, ",.0f")}`);
  const sym = String(sug.symbol);
  const cashAfter = pyRound(cash - total, 2);
  db.batch([
    addOrMergeHolding(Number(pf.id), sym, qty, price, total, sug.segment as string, sug.sector as string, null, true),
    { sql: "UPDATE portfolios SET cash_balance=?, updated_at=? WHERE id=?", params: [cashAfter, nowIso(), Number(pf.id)] },
    { sql: `INSERT INTO transactions (portfolio_id, symbol, action, quantity, price, total_value, is_paper, suggestion_id, reason, executed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [Number(pf.id), sym, "BUY", qty, price, total, Number(pf.is_paper), Number(sug.id), `Executed suggestion #${sug.id}`, nowIso()] },
    { sql: "UPDATE suggestions_log SET was_acted_on=1 WHERE id=?", params: [Number(sug.id)] },
    logTradeConfig(sym, "BUY"),
  ]);
  return { status: `BOUGHT ${qty} × ${sym} @ ₹${fmt(price, ",.2f")}`, total, cash_after: cashAfter };
});

async function sellHolding(h: Record<string, any>, reason: (pnl: number) => string, suggestionId: number | null = null) {
  const pf = portfolioRow();
  let price: number;
  try {
    price = (await getQuote(String(h.symbol))).price;
  } catch {
    price = Number(h.current_price ?? h.avg_buy_price);
  }
  const qty = Number(h.quantity);
  const total = pyRound(qty * price, 2);
  const pnl = pyRound(total - Number(h.avg_buy_price) * qty, 2);
  const cashAfter = pyRound(Number(pf.cash_balance) + total, 2);
  db.batch([
    { sql: "UPDATE portfolios SET cash_balance=?, updated_at=? WHERE id=?", params: [cashAfter, nowIso(), Number(pf.id)] },
    { sql: `INSERT INTO transactions (portfolio_id, symbol, action, quantity, price, total_value, is_paper, suggestion_id, reason, executed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      params: [Number(pf.id), h.symbol, "SELL", qty, numeric(price), total, Number(pf.is_paper), suggestionId, reason(pnl), nowIso()] },
    { sql: "DELETE FROM holdings WHERE id=?", params: [Number(h.id)] },
    logTradeConfig(String(h.symbol), "SELL"),
  ]);
  return { qty, price, total, pnl, cashAfter };
}

route("POST", "/api/execute/sell/:id", async ({ params }) => {
  const h = db.one("SELECT * FROM holdings WHERE id=?", [Number(params.id)]);
  if (!h) throw new HttpError(404, "Holding not found");
  const r = await sellHolding(h, (pnl) => `Sold position (P&L ₹${fmt(pnl, ",.0f")})`);
  return { status: `SOLD ${r.qty} × ${h.symbol} @ ₹${fmt(r.price, ",.2f")}`, pnl: r.pnl, cash_after: r.cashAfter };
});

route("POST", "/api/execute/buy-manual", ({ body }) => {
  const qty = Number(body?.quantity), price = Number(body?.price);
  if (!body?.symbol || !(qty > 0) || !(price > 0)) throw new HttpError(422, "symbol, quantity > 0 and price > 0 are required");
  const pf = portfolioRow();
  const sym = String(body.symbol).toUpperCase();
  const total = pyRound(qty * price, 2);
  const uni = db.one("SELECT * FROM stock_universe WHERE symbol=?", [sym]);
  const cash = Number(pf.cash_balance);
  const cashAfter = total <= cash ? pyRound(cash - total, 2) : cash;
  db.batch([
    addOrMergeHolding(Number(pf.id), sym, qty, price, total, (uni?.segment as string) ?? "NIFTY50",
      (uni?.sector as string) ?? "Services", (uni?.company_name as string) ?? null, false),
    { sql: "UPDATE portfolios SET cash_balance=?, updated_at=? WHERE id=?", params: [cashAfter, nowIso(), Number(pf.id)] },
    { sql: `INSERT INTO transactions (portfolio_id, symbol, action, quantity, price, total_value, is_paper, reason, executed_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
      params: [Number(pf.id), sym, "BUY", qty, numeric(price), total, Number(pf.is_paper), "Manual entry", nowIso()] },
  ]);
  return { status: `Added ${qty} × ${sym} @ ₹${fmt(price, ",.2f")}`, cash_after: cashAfter };
});

route("GET", "/api/execute/transactions", ({ query }) => {
  const pf = portfolioRow();
  const limit = Math.min(Number(query.get("limit") ?? 50), 200);
  const rows = db.query("SELECT * FROM transactions WHERE portfolio_id=? ORDER BY executed_at DESC, id DESC LIMIT ?",
    [Number(pf.id), limit]);
  return {
    count: rows.length,
    transactions: rows.map((t) => ({
      id: t.id, symbol: t.symbol, action: t.action, quantity: t.quantity, price: Number(t.price),
      total: Number(t.total_value), is_paper: !!t.is_paper, reason: t.reason, at: t.executed_at,
    })),
  };
});

// 'Mark as Done' — backtest/router.py execute_suggestion (BUY or SELL)
route("POST", "/api/portfolio/execute/:id", async ({ params }) => {
  const sug = executeSuggestion(Number(params.id), "any");
  if (!["BUY", "SELL"].includes(String(sug.action))) throw new HttpError(400, `Cannot execute a ${sug.action} suggestion`);
  const pf = portfolioRow();
  const sym = String(sug.symbol);
  const holding = db.one("SELECT * FROM holdings WHERE portfolio_id=? AND symbol=?", [Number(pf.id), sym]);
  if (sug.action === "BUY") {
    const qty = Number(sug.suggested_quantity ?? 0), price = Number(sug.suggested_price ?? 0);
    const total = Number(sug.total_value ?? qty * price);
    if (total <= 0 || qty <= 0) throw new HttpError(400, "Suggestion has no quantity/price");
    const cash = Number(pf.cash_balance);
    if (total > cash) throw new HttpError(400, `Insufficient cash: need ₹${fmt(total, ",.0f")}, have ₹${fmt(cash, ",.0f")}`);
    const cashAfter = pyRound(cash - total, 2);
    db.batch([
      addOrMergeHolding(Number(pf.id), sym, qty, price, total, sug.segment as string, sug.sector as string, null, false),
      { sql: "UPDATE portfolios SET cash_balance=? WHERE id=?", params: [cashAfter, Number(pf.id)] },
      { sql: `INSERT INTO transactions (portfolio_id, symbol, action, quantity, price, total_value, is_paper, suggestion_id, reason, executed_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        params: [Number(pf.id), sym, "BUY", qty, price, total, Number(pf.is_paper), Number(sug.id), `Executed suggestion #${sug.id}`, nowIso()] },
      { sql: "UPDATE suggestions_log SET was_acted_on=1 WHERE id=?", params: [Number(sug.id)] },
    ]);
    return { status: `BOUGHT ${qty} × ${sym} @ ₹${fmt(price, ",.2f")} = ₹${fmt(total, ",.2f")}`, paper: !!pf.is_paper, cash_after: cashAfter };
  }
  if (!holding) throw new HttpError(400, `No holding in ${sym} to sell`);
  const r = await sellHolding(holding, () => `Executed suggestion #${sug.id}`, Number(sug.id));
  db.run("UPDATE suggestions_log SET was_acted_on=1 WHERE id=?", [Number(sug.id)]);
  return { status: `SOLD ${r.qty} × ${sym} @ ₹${fmt(r.price, ",.2f")} = ₹${fmt(r.total, ",.2f")}`, paper: !!pf.is_paper, cash_after: r.cashAfter };
});

route("DELETE", "/api/portfolio/holdings/:id", ({ params }) => {
  const h = db.one("SELECT symbol FROM holdings WHERE id=?", [Number(params.id)]);
  if (!h) throw new HttpError(404, "Holding not found");
  db.run("DELETE FROM holdings WHERE id=?", [Number(params.id)]);
  return { deleted: h.symbol };
});
