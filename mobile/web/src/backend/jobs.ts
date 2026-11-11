/**
 * Scheduled runs — the APScheduler jobs of app/main.py, triggered by the
 * Android alarm (08:30 morning brief, 12:30 midday refresh, 16:00 EOD, Mon–Fri
 * IST). Each run is logged and returns the notification to show.
 */
import { db, log } from "./platform";
import { nowIso } from "./schema";
import { runEngineTracked } from "./routes/engine";
import { runEodSnapshot } from "./routes/market";
import { fmt } from "./util/py";

export type JobType = "MORNING" | "MIDDAY" | "EOD";

export interface JobOutcome { ok: boolean; title: string; body: string }

export async function runScheduledJob(type: JobType): Promise<JobOutcome> {
  const id = db.run("INSERT INTO scheduled_runs (run_type, started_at, status) VALUES (?,?,?)",
    [type, nowIso(), "RUNNING"]).lastId;
  let outcome: JobOutcome;
  try {
    if (type === "EOD") {
      const r = await runEodSnapshot();
      outcome = {
        ok: true,
        title: `Market closed · ${r.market_status}`,
        body: `Nifty ${fmt(r.nifty.price, ",.0f")} (${fmt(r.nifty.change_pct, "+.2f")}%) · ` +
          `${r.holdings_refreshed} holding${r.holdings_refreshed === 1 ? "" : "s"} refreshed`,
      };
    } else {
      const b = await runEngineTracked(type);
      const g = b.market_guard;
      const buys = b.buy_suggestions.length, sells = b.sell_alerts.length;
      const label = type === "MORNING" ? "Morning brief" : "Midday check";
      const parts = [`${buys} buy idea${buys === 1 ? "" : "s"}`];
      if (sells) parts.push(`${sells} sell alert${sells === 1 ? "" : "s"}`);
      outcome = {
        ok: true,
        title: `${label} · ${g.go_status === "GREEN" ? "🟢" : g.go_status === "AMBER" ? "🟠" : "🔴"} ${g.go_status}`,
        body: `${parts.join(" · ")}. ${g.go_message}`,
      };
      if (sells) {
        const urgent = b.sell_alerts.find((s: any) => s.urgency === "IMMEDIATE");
        if (urgent) outcome.body = `⚠ ${urgent.symbol}: stop-loss hit. ` + outcome.body;
      }
    }
    db.run("UPDATE scheduled_runs SET finished_at=?, status='DONE', summary=? WHERE id=?",
      [nowIso(), JSON.stringify(outcome), id]);
  } catch (e) {
    log("error", `Scheduled ${type} run failed: ${(e as Error).stack || e}`);
    outcome = { ok: false, title: "StockSage couldn't refresh", body: `${(e as Error).message || e}. Open the app to retry.` };
    db.run("UPDATE scheduled_runs SET finished_at=?, status='FAILED', summary=? WHERE id=?",
      [nowIso(), JSON.stringify(outcome), id]);
  }
  db.run("DELETE FROM scheduled_runs WHERE id NOT IN (SELECT id FROM scheduled_runs ORDER BY id DESC LIMIT 60)");
  return outcome;
}
