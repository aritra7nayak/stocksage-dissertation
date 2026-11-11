/** /api/daily-brief, /api/engine/*, /api/suggestions, /api/sector-health, /api/analysis, /api/portfolio/* */
import { BASE } from "../config";
import { cachedBrief, engineRunning, portfolioRow, runDailyEngine } from "../engine/dailyRun";
import { db } from "../platform";
import { j, nowIso } from "../schema";
import { route } from "../server";
import { HttpError, pyRound } from "../util/py";
import { todayIst } from "../util/time";

/** Live progress of the current engine run, for the mobile progress banner. */
export const engineProgress = { running: false, stage: "", fraction: 0, started_at: null as string | null };

export async function runEngineTracked(runType: string): Promise<any> {
  if (!engineRunning()) Object.assign(engineProgress, { running: true, stage: "Starting…", fraction: 0, started_at: nowIso() });
  try {
    return await runDailyEngine(runType, (stage, fraction) => Object.assign(engineProgress, { stage, fraction }));
  } finally {
    engineProgress.running = false;
  }
}

route("GET", "/api/daily-brief", async () => cachedBrief() ?? runEngineTracked("MANUAL"));
route("POST", "/api/engine/run", () => runEngineTracked("MANUAL"));
route("GET", "/api/engine/status", () => ({ ...engineProgress, has_brief_today: cachedBrief() !== null }));

route("GET", "/api/suggestions/today", () => {
  const pf = portfolioRow();
  const rows = db.query(
    "SELECT * FROM suggestions_log WHERE suggestion_date = ? AND portfolio_id = ? ORDER BY created_at DESC, id DESC",
    [todayIst(), Number(pf.id)]);
  return {
    date: todayIst(), count: rows.length,
    suggestions: rows.map((r) => ({
      id: r.id, symbol: r.symbol, action: r.action, segment: r.segment, sector: r.sector,
      quantity: r.suggested_quantity, price: Number(r.suggested_price ?? 0), total_value: Number(r.total_value ?? 0),
      score: Number(r.composite_score ?? 0), confidence: r.confidence,
      reasoning: j(r.reasoning, null), rules_failed: j(r.rules_failed, null), was_acted_on: !!r.was_acted_on,
    })),
  };
});

route("GET", "/api/sector-health", () => {
  const rows = db.query("SELECT * FROM sector_health ORDER BY health_date DESC, sector LIMIT ?", [BASE.tracked_sectors.length]);
  return {
    sectors: rows.map((r) => ({
      sector: r.sector, date: r.health_date, score: Number(r.score ?? 0), status: r.status,
      change_pct: Number(r.change_pct ?? 0), avg_rsi: Number(r.avg_rsi ?? 0), news_score: Number(r.news_score ?? 0),
      top_gainer: r.top_gainer, is_blocked: !!r.is_blocked,
    })),
  };
});

route("GET", "/api/analysis/:symbol", ({ params }) => {
  const row = db.one("SELECT * FROM stock_analysis WHERE symbol = ? ORDER BY analysis_date DESC LIMIT 1",
    [params.symbol.toUpperCase()]);
  if (!row) throw new HttpError(404, `No analysis stored for ${params.symbol} — run the engine first`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v == null) continue;
    out[k] = k === "top_reasons" ? j(v, v) : v;
  }
  return out;
});

route("POST", "/api/portfolio/holdings", ({ body }) => {
  const pf = portfolioRow();
  const qty = Number(body.quantity), avg = Number(body.avg_buy_price);
  if (!body.symbol || !(qty > 0) || !(avg > 0)) throw new HttpError(422, "symbol, quantity > 0 and avg_buy_price > 0 are required");
  const r = db.run(`INSERT INTO holdings (portfolio_id, symbol, quantity, avg_buy_price, peak_price, segment, sector,
      company_name, bought_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [Number(pf.id), String(body.symbol).toUpperCase(), qty, avg, avg, String(body.segment ?? "NIFTY50").toUpperCase(),
    body.sector ?? "Services", body.company_name ?? null, nowIso(), nowIso()]);
  return { id: r.lastId, symbol: String(body.symbol).toUpperCase(), status: "added" };
});

route("GET", "/api/portfolio/summary", () => {
  const pf = portfolioRow();
  const holdings = db.query("SELECT * FROM holdings WHERE portfolio_id = ? ORDER BY id", [Number(pf.id)]);
  let mkt = 0;
  const out = holdings.map((h) => {
    const price = Number(h.current_price ?? h.avg_buy_price);
    const qty = Number(h.quantity);
    const value = price * qty, cost = Number(h.avg_buy_price) * qty;
    mkt += value;
    return {
      id: h.id, symbol: h.symbol, name: h.company_name, qty, avg_buy: Number(h.avg_buy_price), current: price,
      value: pyRound(value, 2), pnl: pyRound(value - cost, 2), pnl_pct: cost ? pyRound((value / cost - 1) * 100, 2) : 0,
      segment: h.segment, sector: h.sector, low_score_streak: Number(h.low_score_streak ?? 0),
    };
  });
  return {
    name: pf.name, is_paper: !!pf.is_paper, total_capital: Number(pf.total_capital), cash: Number(pf.cash_balance),
    holdings_value: pyRound(mkt, 2), holdings: out,
  };
});
