/** /api/health and the phone-only /api/mobile/* endpoints (schedule log, data reset). */
import { BASE } from "../config";
import { db, platform } from "../platform";
import { j } from "../schema";
import { route } from "../server";
import { modelStatus } from "../sentiment/finbert";
import { nowIstIso } from "../util/time";

route("GET", "/api/health", () => ({
  status: "ok", service: "stocksage-india", runtime: platform().name, time_ist: nowIstIso(),
  paper_trading: BASE.paper_trading, scheduler_enabled: true,
  scheduler_jobs: ["Mon–Fri 08:30 IST morning brief", "Mon–Fri 12:30 IST midday refresh", "Mon–Fri 16:00 IST EOD snapshot"],
}));

route("GET", "/api/mobile/status", () => ({
  finbert: modelStatus(),
  counts: Object.fromEntries(["news_items", "stock_analysis", "suggestions_log", "transactions", "holdings", "pf_trades",
    "backtest_runs", "portfolio_snapshots"].map((t) => [t, Number(db.scalar(`SELECT COUNT(*) FROM ${t}`) ?? 0)])),
  runs: db.query("SELECT * FROM scheduled_runs ORDER BY id DESC LIMIT 15").map((r) => ({
    run_type: r.run_type, started_at: r.started_at, finished_at: r.finished_at, status: r.status,
    summary: j(r.summary, null),
  })),
}));

/** Wipe everything the user created; keeps the universe and settings. */
route("POST", "/api/mobile/reset", ({ body }) => {
  const scope = body?.scope === "everything" ? "everything" : "paper";
  const paper = ["holdings", "transactions", "suggestions_log", "portfolio_snapshots", "trade_config_log", "briefs"];
  const all = [...paper, "pf_trades", "pf_aliases", "pf_stocks", "pf_portfolios", "backtest_trades", "backtest_runs",
    "job_history", "news_items", "stock_analysis", "sector_health", "market_snapshots", "scheduled_runs"];
  db.batch([
    ...(scope === "everything" ? all : paper).map((t) => ({ sql: `DELETE FROM ${t}` })),
    { sql: "UPDATE portfolios SET cash_balance = total_capital" },
  ]);
  return { status: scope === "everything" ? "All app data cleared" : "Paper portfolio reset" };
});
