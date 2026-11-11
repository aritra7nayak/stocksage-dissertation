import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Play, Trophy, ShieldCheck, Activity, Layers, ChevronDown } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Cell,
  LineChart, Line, Legend, CartesianGrid, ReferenceLine,
} from "recharts";
import {
  getPresets, startMultiBacktest, pollMultiBacktest, getJobHistory, getJobHistoryItem,
  type Preset, type MultiStatus, type BTPeriod, type HistoryEntry,
} from "../api/client";
import { useJobs } from "../lib/jobStore";
import { History } from "lucide-react";
import { AnimatedNumber, LoadingOrb, TiltCard } from "../components/shared/ui";

const WCOLORS: Record<string, string> = {
  "3M": "#22C5E0", "6M": "#5B8DEF", "1Y": "#16C784", "2Y": "#8B7CF6", "3Y": "#F2A93B",
};

export default function AnalyzerPage() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("conservative");
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<MultiStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState("1Y");
  const timer = useRef<number | null>(null);
  const { activeMulti, setActiveMulti, lastMultiResult, setLastMultiResult } = useJobs();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [histOpen, setHistOpen] = useState(false);

  const startPolling = (job_id: string) => {
    if (timer.current) clearInterval(timer.current);
    setRunning(true);
    timer.current = window.setInterval(async () => {
      try {
        const s = await pollMultiBacktest(job_id);
        setJob(s);
        if (s.periods.length && !s.periods.find((p) => p.window === tab))
          setTab(s.periods.find((p) => p.window === "1Y")?.window || s.periods[0].window);
        if (s.status === "DONE" || s.status === "FAILED") {
          if (timer.current) clearInterval(timer.current);
          setRunning(false);
          setActiveMulti(null);
          if (s.status === "DONE") setLastMultiResult(s);
          if (s.status === "FAILED") setErr(s.error || "Backtest failed.");
          getJobHistory().then(setHistory).catch(() => {});
        }
      } catch (e: any) {
        if (timer.current) clearInterval(timer.current);
        setRunning(false);
        if (e?.response?.status === 404) {
          setActiveMulti(null);
          setErr("That run was lost when the backend restarted — start a new one.");
        } else setErr("Lost contact with the backend. Is it still running?");
      }
    }, 2500);
  };

  // Mount: presets, restore last result, resume a running job, load history.
  useEffect(() => {
    getPresets().then(setPresets).catch(() => {});
    if (lastMultiResult) setJob(lastMultiResult);
    if (activeMulti) startPolling(activeMulti.jobId);
    getJobHistory().then(setHistory).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setErr(null); setJob(null); setLastMultiResult(null);
    try {
      const { job_id } = await startMultiBacktest(preset);
      setActiveMulti({ jobId: job_id, preset });
      startPolling(job_id);
    } catch {
      setRunning(false);
      setErr("Couldn't start the backtest — is the backend running?");
    }
  };

  const loadSaved = async (name: string) => {
    try {
      const d = await getJobHistoryItem(name);
      if (d.kind === "multi") { setJob(d); setLastMultiResult(d); setErr(null); }
      else setErr("That saved run is a Compare run — open it on the Compare page.");
    } catch { setErr("Couldn't load that saved run."); }
  };

  const activePreset = presets.find((p) => p.key === preset);
  const periods = job?.periods || [];
  const active = periods.find((p) => p.window === tab) || periods[0];
  const summary = job?.summary;

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Strategy Analyzer</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Full Backtest Analysis</h1>
        </div>
        <div className="flex items-center gap-3">
          {/* Preset dropdown */}
          <div className="relative">
            <button onClick={() => setOpen(!open)} disabled={running}
              className="glass flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium disabled:opacity-50">
              <span className="text-muted">Preset:</span>
              <span className="font-bold">{activePreset?.label || "Conservative"}</span>
              <ChevronDown size={15} className={open ? "rotate-180 transition" : "transition"} />
            </button>
            <AnimatePresence>
              {open && (
                <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                  className="glass absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-xl p-1.5">
                  {presets.map((p) => (
                    <button key={p.key} onClick={() => { setPreset(p.key); setOpen(false); }}
                      className="block w-full rounded-lg px-3 py-2.5 text-left transition hover:bg-[rgb(var(--muted)/0.12)]"
                      style={{ background: p.key === preset ? "rgb(91 141 239 / 0.14)" : "transparent" }}>
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-sm">{p.label}</span>
                        {p.key === "conservative" && <span className="eyebrow text-[9px]">DEFAULT</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted">{p.desc}</div>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <button onClick={run} disabled={running}
            className="glass glow-brand flex items-center gap-2 rounded-xl px-5 py-2.5 font-medium transition hover:scale-105 disabled:opacity-60">
            {running ? <Activity size={16} className="animate-pulse" /> : <Play size={16} />}
            {running ? "Running…" : job ? "Re-run" : "Run analysis"}
          </button>
        </div>
      </div>

      {/* Progress bar while running */}
      <AnimatePresence>
        {running && job && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}
            className="glass mt-6 overflow-hidden rounded-2xl p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted">{job.stage}</span>
              <span className="num font-bold">{Math.round(job.progress * 100)}%</span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.18)" }}>
              <motion.div className="h-full rounded-full" style={{ background: "linear-gradient(90deg,#5B8DEF,#16C784)" }}
                animate={{ width: `${job.progress * 100}%` }} transition={{ ease: "easeOut" }} />
            </div>
            <div className="mt-3 flex gap-2">
              {["3M", "6M", "1Y", "2Y", "3Y"].map((w) => {
                const done = periods.find((p) => p.window === w);
                return (
                  <span key={w} className="num rounded-md px-2 py-1 text-[11px] font-bold"
                    style={{ background: done ? "rgb(22 199 132 / 0.15)" : "rgb(var(--muted) / 0.1)",
                             color: done ? "#16C784" : "rgb(var(--muted))" }}>
                    {w} {done ? "✓" : "…"}
                  </span>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {err && <div className="glass mt-6 rounded-2xl p-5 text-sm text-sell">{err}</div>}

      {/* Empty state */}
      {!job && !running && !err && (
        <TiltCard className="mt-10 rounded-3xl p-12 text-center" max={4}>
          <Layers size={40} className="mx-auto mb-4 text-brand" />
          <h2 className="font-display text-2xl font-bold">Full strategy analysis</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Pick a rule preset and run. It replays all 15 rules over five trailing windows —
            3 months to 3 years — against a Nifty buy-and-hold benchmark, streaming each
            window's result as it finishes.
          </p>
        </TiltCard>
      )}

      {/* Results */}
      {summary && (
        <motion.div initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} className="scene mt-6">
          <div className="preserve-3d glass glow-brand relative overflow-hidden rounded-3xl p-7">
            <div className="absolute inset-0 sheen opacity-30" />
            <div className="relative grid gap-6 md:grid-cols-4">
              <div className="md:col-span-2">
                <div className="eyebrow mb-2">Verdict · {summary.preset}</div>
                <p className="font-display text-2xl font-bold leading-snug">{summary.verdict}</p>
                <p className="mt-3 text-sm text-muted">
                  Beat the Nifty in <span className="num font-bold text-buy">{summary.windows_beating_nifty}</span> windows ·
                  best in <span className="num font-bold">{summary.best_window}</span>, weakest in <span className="num font-bold">{summary.worst_window}</span>.
                </p>
              </div>
              <Metric icon={Trophy} label="Avg Alpha" value={summary.avg_alpha_pct} suffix="%" color={summary.avg_alpha_pct >= 0 ? "#16C784" : "#F0526B"} />
              <Metric icon={ShieldCheck} label="Avg Max Drawdown" value={summary.avg_max_drawdown_pct} prefix="−" suffix="%" color="#F2A93B" />
            </div>
          </div>
        </motion.div>
      )}

      {periods.length > 0 && (
        <>
          <div className="mt-6 grid gap-6 lg:grid-cols-2">
            <TiltCard className="rounded-2xl p-5" max={4}>
              <div className="eyebrow mb-4">Strategy vs Nifty — by window</div>
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={periods.map((p) => ({ window: p.window, Strategy: p.strategy_return_pct, Nifty: p.nifty_return_pct }))} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
                  <XAxis dataKey="window" tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} />
                  <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} unit="%" width={42} />
                  <Tooltip cursor={{ fill: "rgb(var(--muted) / 0.08)" }}
                    contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)", borderRadius: 12, color: "rgb(var(--ink))" }} />
                  <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.4)" />
                  <Bar dataKey="Nifty" radius={[4, 4, 0, 0]} fill="rgb(var(--muted) / 0.5)" />
                  <Bar dataKey="Strategy" radius={[4, 4, 0, 0]}>
                    {periods.map((p, i) => <Cell key={i} fill={p.strategy_return_pct >= p.nifty_return_pct ? "#16C784" : "#F0526B"} />)}
                  </Bar>
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </BarChart>
              </ResponsiveContainer>
            </TiltCard>

            <TiltCard className="rounded-2xl p-5" max={4}>
              <div className="eyebrow mb-4">Equity curves — normalized to start</div>
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={buildOverlay(periods).rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
                  <XAxis dataKey="t" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} minTickGap={50} />
                  <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} unit="%" width={42} />
                  <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)", borderRadius: 12, color: "rgb(var(--ink))" }} />
                  <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.4)" />
                  {buildOverlay(periods).keys.map((k) => (
                    <Line key={k} type="monotone" dataKey={k} stroke={WCOLORS[k]} strokeWidth={2} dot={false} />
                  ))}
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                </LineChart>
              </ResponsiveContainer>
            </TiltCard>
          </div>

          <div className="mt-6">
            <div className="mb-4 flex gap-2">
              {periods.map((p) => (
                <button key={p.window} onClick={() => setTab(p.window)} className="relative rounded-xl px-4 py-2 text-sm font-medium transition"
                  style={{ color: tab === p.window ? "rgb(var(--ink))" : "rgb(var(--muted))" }}>
                  {tab === p.window && <motion.div layoutId="tabActive" className="absolute inset-0 rounded-xl glass glow-brand" />}
                  <span className="relative z-10 num">{p.window}</span>
                </button>
              ))}
            </div>
            {active && (
              <AnimatePresence mode="wait">
                <motion.div key={tab} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
                  <WindowDetail p={active} />
                </motion.div>
              </AnimatePresence>
            )}
          </div>

          {job?.notes && (
            <div className="mt-6 glass rounded-2xl p-5">
              <div className="eyebrow mb-2">Honest caveats</div>
              {job.notes.map((n, i) => <p key={i} className="text-[12px] leading-relaxed text-muted">• {n}</p>)}
            </div>
          )}
        </>
      )}

      {history.filter((h) => h.kind === "multi").length > 0 && (
        <div className="glass mt-6 rounded-2xl p-5">
          <button onClick={() => setHistOpen(!histOpen)} className="flex w-full items-center gap-2">
            <History size={15} className="text-muted" />
            <span className="eyebrow">Past analyzer runs ({history.filter((h) => h.kind === "multi").length})</span>
          </button>
          {histOpen && (
            <div className="mt-3 flex flex-col gap-1.5">
              {history.filter((h) => h.kind === "multi").map((h) => (
                <button key={h.name} onClick={() => loadSaved(h.name)}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:scale-[1.01]"
                  style={{ background: "rgb(var(--muted) / 0.06)" }}>
                  <span className="num text-muted">{h.finished_at?.slice(0, 16).replace("T", " ")} · {h.preset}</span>
                  <span className="num font-bold" style={{ color: (h.summary?.avg_alpha_pct ?? 0) >= 0 ? "#16C784" : "#F0526B" }}>
                    {h.summary ? `${h.summary.avg_alpha_pct >= 0 ? "+" : ""}${h.summary.avg_alpha_pct}% α` : "view"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({ icon: Icon, label, value, prefix = "", suffix = "", color }: any) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgb(var(--elevated) / 0.5)" }}>
      <Icon size={18} style={{ color }} />
      <div className="eyebrow mt-2">{label}</div>
      <AnimatedNumber value={Math.abs(value)} decimals={1} prefix={prefix} suffix={suffix} className="num text-2xl font-bold" style={{ color }} />
    </div>
  );
}

function WindowDetail({ p }: { p: BTPeriod }) {
  const stats = [
    { l: "Strategy Return", v: p.strategy_return_pct, c: p.strategy_return_pct >= 0 ? "#16C784" : "#F0526B", suf: "%" },
    { l: "Nifty Return", v: p.nifty_return_pct, c: "rgb(var(--muted))", suf: "%" },
    { l: "Alpha", v: p.alpha_pct, c: p.alpha_pct >= 0 ? "#16C784" : "#F0526B", suf: "%" },
    { l: "Max Drawdown", v: -Math.abs(p.max_drawdown_pct), c: "#F2A93B", suf: "%" },
    { l: "Win Rate", v: p.win_rate * 100, c: "#5B8DEF", suf: "%" },
    { l: "Trades", v: p.total_trades, c: "rgb(var(--ink))", suf: "" },
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="lg:col-span-1">
        <div className="grid grid-cols-2 gap-3">
          {stats.map((s) => (
            <div key={s.l} className="glass rounded-xl p-3">
              <div className="eyebrow mb-1 text-[10px]">{s.l}</div>
              <AnimatedNumber value={s.v} decimals={s.suf ? 1 : 0} suffix={s.suf} className="num text-lg font-bold" style={{ color: s.c }} />
            </div>
          ))}
        </div>
        <div className="num mt-3 text-center text-[11px] text-muted">{p.period}</div>
      </div>
      <div className="glass overflow-hidden rounded-2xl lg:col-span-2">
        <div className="eyebrow border-b px-5 py-3" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>Trades ({p.trades.length})</div>
        <div className="max-h-72 overflow-y-auto">
          <table className="w-full text-sm">
            <tbody>
              {p.trades.length === 0 && <tr><td className="px-5 py-4 text-muted">No trades in this window.</td></tr>}
              {p.trades.map((t, i) => (
                <tr key={i} className="border-b" style={{ borderColor: "rgb(var(--line) / calc(var(--line-a) * 0.6))" }}>
                  <td className="num px-5 py-2 text-muted">{t.trade_date}</td>
                  <td className="px-3 py-2 font-bold">{t.symbol.replace(".NS", "")}</td>
                  <td className="px-3 py-2"><span className="num text-[11px] font-bold" style={{ color: t.action === "BUY" ? "#16C784" : "#F0526B" }}>{t.action}</span></td>
                  <td className="num px-3 py-2">₹{t.price?.toLocaleString("en-IN")}</td>
                  <td className="num px-3 py-2" style={{ color: t.pnl == null ? "rgb(var(--muted))" : t.pnl >= 0 ? "#16C784" : "#F0526B" }}>
                    {t.pnl != null ? `${t.pnl >= 0 ? "+" : ""}₹${t.pnl.toLocaleString("en-IN")}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-muted">{t.triggered_rule || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function buildOverlay(periods: BTPeriod[]) {
  const keys = ["1Y", "2Y", "3Y"].filter((k) => periods.some((p) => p.window === k));
  const series: Record<string, number[]> = {};
  let maxLen = 0;
  for (const k of keys) {
    const p = periods.find((x) => x.window === k)!;
    const base = p.equity_curve[0]?.equity || 1;
    series[k] = p.equity_curve.map((e) => +(((e.equity / base) - 1) * 100).toFixed(2));
    maxLen = Math.max(maxLen, series[k].length);
  }
  const rows = Array.from({ length: maxLen }, (_, i) => {
    const row: any = { t: i };
    for (const k of keys) {
      const arr = series[k];
      const offset = maxLen - arr.length;
      if (i >= offset) row[k] = arr[i - offset];
    }
    return row;
  });
  return { keys, rows };
}
