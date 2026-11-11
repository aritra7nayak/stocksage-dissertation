/**
 * /api/backtest/* — backtest/router.py + multi_router.py.
 * Long runs are in-process background jobs polled by the pages; finished
 * jobs are saved to the job_history table so history survives restarts.
 */
import { BASE, Settings } from "../config";
import { BacktestSimulator } from "../backtest/simulator";
import { batchHistory, getHistory } from "../market/fetcher";
import type { Bars } from "../market/yahoo";
import { db, log } from "../platform";
import { j, nowIso } from "../schema";
import { route } from "../server";
import { randomHex } from "../util/hash";
import { HttpError, maxBy, minBy, pyRound } from "../util/py";
import { addDays, nowIstIso, todayIst } from "../util/time";

const WINDOWS: [string, number][] = [["3Y", 365 * 3], ["2Y", 365 * 2], ["1Y", 365], ["6M", 182], ["3M", 91]];
const ORDER: Record<string, number> = { "3M": 0, "6M": 1, "1Y": 2, "2Y": 3, "3Y": 4 };

export const BT_PRESETS: Record<string, { stop_loss_pct: number; cash_reserve_pct: number; label: string; desc: string }> = {
  conservative: { stop_loss_pct: 0.08, cash_reserve_pct: 0.2, label: "Conservative", desc: "Current defaults -- -8% stop, 20% cash. Max protection." },
  medium: { stop_loss_pct: 0.1, cash_reserve_pct: 0.15, label: "Medium", desc: "-10% stop, 15% cash. Balanced." },
  aggressive: { stop_loss_pct: 0.12, cash_reserve_pct: 0.1, label: "Aggressive", desc: "-12% stop, 10% cash. More bull-market participation." },
};

type Job = Record<string, any>;
const JOBS: Record<string, Job> = {};

function universeMeta() {
  const uni = db.query("SELECT symbol, segment, sector FROM stock_universe WHERE is_active=1 ORDER BY id");
  const meta: Record<string, [string, string]> = {};
  for (const u of uni) meta[String(u.symbol)] = [String(u.segment), String(u.sector ?? "Services")];
  return { symbols: Object.keys(meta), meta };
}

let bundle: { prices: Record<string, Bars>; nifty: Bars; meta: Record<string, [string, string]>; at: number } | null = null;

async function priceBundle(job?: Job) {
  if (bundle && Date.now() - bundle.at < 3600_000) return bundle;
  const { symbols, meta } = universeMeta();
  const prices = await batchHistory(symbols, "5y", 6, (d, n) => {
    if (job) { job.stage = `Downloading price history ${d}/${n}...`; job.progress = 0.3 * (d / n); }
  });
  const nifty = await getHistory(BASE.nifty50_index, "5y");
  bundle = { prices, nifty, meta, at: Date.now() };
  return bundle;
}

const presetSettings = (key: string): Settings => ({
  ...BASE, stop_loss_pct: BT_PRESETS[key].stop_loss_pct, cash_reserve_pct: BT_PRESETS[key].cash_reserve_pct,
});

const yieldToUi = () => new Promise((r) => setTimeout(r, 0));

function saveHistory(jobId: string, kind: string, job: Job) {
  const d = new Date(Date.now() + 330 * 60_000).toISOString();
  const stamp = `${d.slice(0, 10).replace(/-/g, "")}-${d.slice(11, 19).replace(/:/g, "")}`;
  const name = `${stamp}_${kind}_${job.preset ?? "run"}_${jobId.slice(0, 6)}`;
  const { status: _s, ...rest } = job;
  const payload = { name, kind, finished_at: nowIstIso(), ...rest, status: "DONE" };
  db.run("INSERT OR REPLACE INTO job_history (name, kind, preset, finished_at, payload) VALUES (?,?,?,?,?)",
    [name, kind, job.preset ?? null, payload.finished_at, JSON.stringify(payload)]);
}

function persistRun(name: string, start: string, end: string, capital: number, r: ReturnType<BacktestSimulator["run"]>,
                    ruleConfig: unknown): number {
  const run = db.run(`INSERT INTO backtest_runs (name, start_date, end_date, initial_capital, final_value, total_return_pct,
      nifty_return_pct, max_drawdown_pct, win_rate, total_trades, rule_config, status, created_at, completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'DONE',?,?)`,
  [name, start, end, capital, r.final_value, r.total_return_pct, r.nifty_return_pct, r.max_drawdown_pct,
    r.win_rate, r.total_trades, JSON.stringify(ruleConfig), nowIso(), nowIso()]);
  db.batch(r.trades.map((t) => ({
    sql: `INSERT INTO backtest_trades (run_id, symbol, action, trade_date, quantity, price, pnl, triggered_rule, reason)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    params: [run.lastId, t.symbol, t.action, t.trade_date, t.quantity, t.price, t.pnl, t.triggered_rule, t.reason],
  })));
  return run.lastId;
}

const downsample = <T>(curve: T[], target = 180): T[] =>
  curve.length <= target ? curve : curve.filter((_, i) => i % Math.floor(curve.length / target) === 0);

// ── single run ───────────────────────────────────────────────────────────────
route("POST", "/api/backtest/run", async ({ body }) => {
  const end = body?.end_date || todayIst();
  const start = body?.start_date || addDays(end, -365);
  const capital = Number(body?.initial_capital ?? 100_000);
  const name = body?.name || "Rule-engine backtest";
  const { symbols, meta } = universeMeta();
  const prices = await batchHistory(symbols, "2y");
  const nifty = await getHistory(BASE.nifty50_index, "2y");
  const r = new BacktestSimulator(prices, meta, nifty, BASE).run(start, end, capital);
  const runId = persistRun(name, start, end, capital, r, {
    stop_loss_pct: BASE.stop_loss_pct,
    trailing: [BASE.trailing_profit_trigger, BASE.trailing_profit_giveback],
    deterioration: [BASE.deterioration_score, BASE.deterioration_days],
    notes: r.notes,
    equity_curve: r.equity_curve.filter((_, i) => i % Math.max(1, Math.floor(r.equity_curve.length / 250)) === 0),
  });
  return {
    run_id: runId, name, period: `${start} → ${end}`,
    strategy_return_pct: r.total_return_pct, nifty_buyhold_return_pct: r.nifty_return_pct,
    alpha_pct: pyRound(r.total_return_pct - r.nifty_return_pct, 3), max_drawdown_pct: r.max_drawdown_pct,
    win_rate: r.win_rate, total_trades: r.total_trades, open_positions_at_end: r.open_positions,
    final_value: r.final_value, notes: r.notes,
  };
});

route("GET", "/api/backtest/runs", () => ({
  runs: db.query("SELECT * FROM backtest_runs ORDER BY created_at DESC, id DESC LIMIT 20").map((r) => ({
    id: r.id, name: r.name, period: `${r.start_date} → ${r.end_date}`,
    return_pct: Number(r.total_return_pct ?? 0), nifty_pct: Number(r.nifty_return_pct ?? 0),
    max_dd_pct: Number(r.max_drawdown_pct ?? 0), win_rate: Number(r.win_rate ?? 0), trades: r.total_trades,
  })),
}));

route("GET", "/api/backtest/runs/:id", ({ params }) => {
  const run = db.one("SELECT * FROM backtest_runs WHERE id=?", [Number(params.id)]);
  if (!run) throw new HttpError(404, "Run not found");
  const trades = db.query("SELECT * FROM backtest_trades WHERE run_id=? ORDER BY trade_date, id", [Number(params.id)]);
  return {
    id: run.id, name: run.name,
    metrics: {
      return_pct: Number(run.total_return_pct ?? 0), nifty_pct: Number(run.nifty_return_pct ?? 0),
      max_dd_pct: Number(run.max_drawdown_pct ?? 0), win_rate: Number(run.win_rate ?? 0),
    },
    rule_config: j(run.rule_config, null),
    trades: trades.map((t) => ({
      date: t.trade_date, symbol: t.symbol, action: t.action, qty: t.quantity, price: Number(t.price ?? 0),
      pnl: t.pnl != null ? Number(t.pnl) : null, rule: t.triggered_rule, reason: t.reason,
    })),
  };
});

// ── multi-window job ─────────────────────────────────────────────────────────
async function runMulti(jobId: string, presetKey: string, capital: number) {
  const job = JOBS[jobId];
  try {
    const preset = BT_PRESETS[presetKey];
    job.stage = "Downloading price history...";
    const { prices, nifty, meta } = await priceBundle(job);
    const sim = new BacktestSimulator(prices, meta, nifty, presetSettings(presetKey));
    const end = todayIst();
    const results: Job[] = [];
    for (let idx = 0; idx < WINDOWS.length; idx++) {
      const [label, days] = WINDOWS[idx];
      job.stage = `Simulating ${label} window...`;
      job.progress = 0.3 + 0.7 * (idx / WINDOWS.length);
      await yieldToUi();
      const start = addDays(end, -days);
      const r = sim.run(start, end, capital);
      const alpha = pyRound(r.total_return_pct - r.nifty_return_pct, 3);
      const runId = persistRun(`${preset.label} ${label} (${end})`, start, end, capital, r, { preset: presetKey, window: label });
      results.push({
        window: label, run_id: runId, period: `${start} -> ${end}`,
        strategy_return_pct: r.total_return_pct, nifty_return_pct: r.nifty_return_pct, alpha_pct: alpha,
        max_drawdown_pct: r.max_drawdown_pct, win_rate: r.win_rate, total_trades: r.total_trades,
        open_positions: r.open_positions, final_value: r.final_value, equity_curve: downsample(r.equity_curve),
        trades: r.trades,
      });
      job.periods = [...results].sort((a, b) => ORDER[a.window] - ORDER[b.window]);
    }
    const beat = results.filter((p) => p.alpha_pct > 0).length;
    const avg = (k: string) => pyRound(results.reduce((a, p) => a + p[k], 0) / results.length, 3);
    const avgAlpha = avg("alpha_pct");
    job.summary = {
      preset: preset.label, preset_desc: preset.desc, avg_alpha_pct: avgAlpha,
      windows_beating_nifty: `${beat}/${results.length}`, avg_max_drawdown_pct: avg("max_drawdown_pct"),
      avg_win_rate: avg("win_rate"), best_window: maxBy(results, (p) => p.alpha_pct).window,
      worst_window: minBy(results, (p) => p.alpha_pct).window,
      verdict: beat >= 4 && avgAlpha > 3 ? "Strong, consistent edge across regimes."
        : beat >= 3 ? "Edge present but regime-dependent -- review the weak windows."
          : "Inconsistent -- doesn't reliably beat buy-and-hold across these windows.",
    };
    Object.assign(job, { progress: 1, stage: "Done", status: "DONE" });
    saveHistory(jobId, "multi", job);
  } catch (e) {
    log("error", `Multi-backtest job failed: ${(e as Error).stack}`);
    Object.assign(job, { status: "FAILED", error: (e as Error).message });
  }
}

route("POST", "/api/backtest/multi/start", ({ body }) => {
  const preset = body?.preset ?? "conservative";
  if (!BT_PRESETS[preset]) throw new HttpError(400, `Unknown preset. Choose: ${JSON.stringify(Object.keys(BT_PRESETS))}`);
  const id = randomHex(12);
  JOBS[id] = { status: "RUNNING", stage: "Starting...", progress: 0, kind: "multi", started_at: nowIstIso(),
    preset, periods: [], summary: null };
  void runMulti(id, preset, Number(body?.initial_capital ?? 100_000));
  return { job_id: id, preset };
});

const NOTES = ["Composite = technical score only (no historical news/fundamentals).",
  "Universe = today's constituents (mild survivorship bias).",
  "Costs: 0.12% per side. Trades at daily close."];

route("GET", "/api/backtest/multi/status/:id", ({ params }) => {
  const job = JOBS[params.id];
  if (!job) throw new HttpError(404, "Job not found (app may have restarted -- start a new run)");
  return { status: job.status, stage: job.stage, progress: pyRound(job.progress, 3), preset: job.preset,
    periods: job.periods, summary: job.summary, error: job.error ?? null, notes: NOTES };
});

// ── walk-forward ─────────────────────────────────────────────────────────────
async function runWalkforward(jobId: string) {
  const job = JOBS[jobId];
  try {
    const { prices, nifty, meta } = await priceBundle(job);
    const end = todayIst();
    const mid = addDays(end, -548), start = addDays(end, -365 * 3);
    const halves: [string, string, string][] = [["in_sample", start, mid], ["out_of_sample", mid, end]];
    const keys = ["conservative", "medium", "aggressive"];
    const total = keys.length * halves.length;
    let step = 0;
    const out: Record<string, any> = {};
    const base = new BacktestSimulator(prices, meta, nifty, BASE);
    for (const pk of keys) {
      const preset = BT_PRESETS[pk];
      const sim = base.withSettings(presetSettings(pk));
      const res: Record<string, any> = {};
      for (const [label, s, e] of halves) {
        job.stage = `${preset.label} · ${label.replace("_", " ")}`;
        await yieldToUi();
        const r = sim.run(s, e, 100_000);
        res[label] = { period: `${s} -> ${e}`, strategy_pct: r.total_return_pct, nifty_pct: r.nifty_return_pct,
          alpha_pct: pyRound(r.total_return_pct - r.nifty_return_pct, 3), max_dd_pct: r.max_drawdown_pct, trades: r.total_trades };
        job.progress = ++step / total;
      }
      const ia = res.in_sample.alpha_pct, oa = res.out_of_sample.alpha_pct;
      res.consistent = (ia > 0) === (oa > 0) && oa > -2;
      res.label = preset.label;
      out[pk] = res;
      job.results = { ...out };
    }
    const consistent = Object.values(out).filter((v) => v.consistent).map((v) => v.label);
    job.summary = { consistent_presets: consistent,
      verdict: consistent.length ? `Edge holds out-of-sample for: ${consistent.join(", ")}.`
        : "No preset's edge survived out-of-sample -- treat all backtests skeptically." };
    Object.assign(job, { progress: 1, stage: "Done", status: "DONE" });
    saveHistory(jobId, "walkforward", job);
  } catch (e) {
    Object.assign(job, { status: "FAILED", error: (e as Error).message });
  }
}

route("POST", "/api/backtest/walkforward/start", () => {
  const id = randomHex(12);
  JOBS[id] = { status: "RUNNING", stage: "Starting...", progress: 0, kind: "walkforward", started_at: nowIstIso(),
    preset: "walkforward", results: {}, summary: null };
  void runWalkforward(id);
  return { job_id: id };
});

route("GET", "/api/backtest/walkforward/status/:id", ({ params }) => {
  const job = JOBS[params.id];
  if (!job) throw new HttpError(404, "Job not found (app may have restarted)");
  return { status: job.status, stage: job.stage, progress: pyRound(job.progress, 3), results: job.results ?? {},
    summary: job.summary ?? null, error: job.error ?? null };
});

route("GET", "/api/backtest/multi/jobs", () => ({
  jobs: Object.entries(JOBS).map(([id, jb]) => ({ job_id: id, kind: jb.kind ?? "multi", preset: jb.preset,
    status: jb.status, progress: pyRound(jb.progress ?? 0, 3), stage: jb.stage, started_at: jb.started_at })),
}));

route("GET", "/api/backtest/multi/history", () => ({
  history: db.query("SELECT payload FROM job_history ORDER BY name DESC LIMIT 30").map((r) => {
    const d = j<any>(r.payload, {});
    return { name: d.name, kind: d.kind, preset: d.preset, finished_at: d.finished_at, summary: d.summary };
  }),
}));

route("GET", "/api/backtest/multi/history/:name", ({ params }) => {
  const r = db.one("SELECT payload FROM job_history WHERE name=?", [params.name]);
  if (!r) throw new HttpError(404, "Saved run not found");
  return j(r.payload, {});
});

route("GET", "/api/backtest/presets", () => ({
  presets: Object.entries(BT_PRESETS).map(([k, v]) => ({ key: k, label: v.label, desc: v.desc,
    stop_loss_pct: v.stop_loss_pct, cash_reserve_pct: v.cash_reserve_pct })),
}));

// ── compare all three presets ────────────────────────────────────────────────
async function runCompare(jobId: string, capital: number) {
  const job = JOBS[jobId];
  try {
    const { prices, nifty, meta } = await priceBundle(job);
    const end = todayIst();
    const keys = ["conservative", "medium", "aggressive"];
    const totalSteps = keys.length * WINDOWS.length;
    let step = 0;
    const out: Record<string, any> = {};
    const base = new BacktestSimulator(prices, meta, nifty, BASE);
    for (const pk of keys) {
      const preset = BT_PRESETS[pk];
      const sim = base.withSettings(presetSettings(pk));
      const rows: any[] = [];
      for (const [label, days] of WINDOWS) {
        job.stage = `${preset.label} · ${label}`;
        await yieldToUi();
        const r = sim.run(addDays(end, -days), end, capital);
        rows.push({ window: label, strategy_return_pct: r.total_return_pct, nifty_return_pct: r.nifty_return_pct,
          alpha_pct: pyRound(r.total_return_pct - r.nifty_return_pct, 3), max_drawdown_pct: r.max_drawdown_pct,
          win_rate: r.win_rate, total_trades: r.total_trades });
        job.progress = 0.3 + 0.7 * (++step / totalSteps);
        rows.sort((a, b) => ORDER[a.window] - ORDER[b.window]);
        const beat = rows.filter((x) => x.alpha_pct > 0).length;
        out[pk] = {
          label: preset.label, desc: preset.desc, stop_loss_pct: preset.stop_loss_pct, cash_reserve_pct: preset.cash_reserve_pct,
          windows: [...rows],
          avg_alpha: pyRound(rows.reduce((a, x) => a + x.alpha_pct, 0) / rows.length, 3),
          avg_drawdown: pyRound(rows.reduce((a, x) => a + x.max_drawdown_pct, 0) / rows.length, 3),
          windows_beating: `${beat}/${rows.length}`,
        };
        job.presets = { ...out };
      }
    }
    const best = maxBy(Object.values(out), (p) => p.avg_alpha - 0.5 * p.avg_drawdown);
    job.summary = { recommended: best.label,
      note: "Highest risk-adjusted score (avg alpha minus half the avg drawdown). " +
        "Backtest-optimized — forward-test before trusting with real money." };
    Object.assign(job, { progress: 1, stage: "Done", status: "DONE" });
    saveHistory(jobId, "compare", job);
  } catch (e) {
    Object.assign(job, { status: "FAILED", error: (e as Error).message });
  }
}

route("POST", "/api/backtest/compare/start", ({ body }) => {
  const id = randomHex(12);
  JOBS[id] = { status: "RUNNING", stage: "Starting...", progress: 0, kind: "compare", started_at: nowIstIso(),
    preset: "compare", presets: {}, summary: null };
  void runCompare(id, Number(body?.initial_capital ?? 100_000));
  return { job_id: id };
});

route("GET", "/api/backtest/compare/status/:id", ({ params }) => {
  const job = JOBS[params.id];
  if (!job) throw new HttpError(404, "Job not found (app may have restarted)");
  return { status: job.status, stage: job.stage, progress: pyRound(job.progress, 3), presets: job.presets ?? {},
    summary: job.summary ?? null, error: job.error ?? null };
});

