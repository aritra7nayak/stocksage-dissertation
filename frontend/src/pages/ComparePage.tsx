import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GitCompareArrows, Trophy } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import { startCompare, pollCompare, getJobHistory, getJobHistoryItem, type CompareStatus, type ComparePreset, type HistoryEntry } from "../api/client";
import { useJobs } from "../lib/jobStore";
import { History } from "lucide-react";
import { LoadingOrb, TiltCard } from "../components/shared/ui";

const PCOLOR: Record<string, string> = { Conservative: "#22C5E0", Medium: "#8B7CF6", Aggressive: "#F2A93B" };
const ORDER = ["conservative", "medium", "aggressive"];

export default function ComparePage() {
  const [job, setJob] = useState<CompareStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const { activeCompare, setActiveCompare, lastCompareResult, setLastCompareResult } = useJobs();
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [histOpen, setHistOpen] = useState(false);

  const startPolling = (job_id: string) => {
    if (timer.current) clearInterval(timer.current);
    setRunning(true);
    timer.current = window.setInterval(async () => {
      try {
        const s = await pollCompare(job_id);
        setJob(s);
        if (s.status === "DONE" || s.status === "FAILED") {
          if (timer.current) clearInterval(timer.current);
          setRunning(false);
          setActiveCompare(null);
          if (s.status === "DONE") setLastCompareResult(s);
          if (s.status === "FAILED") setErr(s.error || "Comparison failed.");
          getJobHistory().then(setHistory).catch(() => {});
        }
      } catch (e: any) {
        if (timer.current) clearInterval(timer.current);
        setRunning(false);
        if (e?.response?.status === 404) {
          setActiveCompare(null);
          setErr("That run was lost when the backend restarted — start a new one.");
        } else setErr("Lost contact with the backend.");
      }
    }, 2500);
  };

  // On mount: restore last finished result instantly, resume a running job,
  // and load saved history. Cleanup stops the timer only (job keeps running server-side).
  useEffect(() => {
    if (lastCompareResult) setJob(lastCompareResult);
    if (activeCompare) startPolling(activeCompare.jobId);
    getJobHistory().then(setHistory).catch(() => {});
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async () => {
    setErr(null); setJob(null); setLastCompareResult(null);
    try {
      const { job_id } = await startCompare();
      setActiveCompare({ jobId: job_id });
      startPolling(job_id);
    } catch { setRunning(false); setErr("Couldn't start — is the backend running?"); }
  };

  const loadSaved = async (name: string) => {
    try {
      const d = await getJobHistoryItem(name);
      if (d.kind === "compare") { setJob(d); setLastCompareResult(d); setErr(null); }
      else setErr("That saved run is an Analyzer run — open it on the Analyzer page.");
    } catch { setErr("Couldn't load that saved run."); }
  };

  const presets = job?.presets || {};
  const ordered = ORDER.map((k) => presets[k]).filter(Boolean) as ComparePreset[];

  // build alpha-by-window chart data
  const windows = ["3M", "6M", "1Y", "2Y", "3Y"];
  const chartData = windows.map((w) => {
    const row: any = { window: w };
    for (const k of ORDER) {
      const p = presets[k];
      if (p) row[p.label] = p.windows.find((x) => x.window === w)?.alpha_pct ?? null;
    }
    return row;
  });

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Strategy Comparison</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Compare Presets</h1>
        </div>
        <button onClick={run} disabled={running}
          className="glass glow-brand flex items-center gap-2 rounded-xl px-5 py-2.5 font-medium transition hover:scale-105 disabled:opacity-60">
          <GitCompareArrows size={16} /> {running ? "Running…" : job ? "Re-run" : "Run comparison"}
        </button>
      </div>

      {running && job && (
        <div className="glass mt-6 rounded-2xl p-5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted">{job.stage}</span>
            <span className="num font-bold">{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.18)" }}>
            <motion.div className="h-full rounded-full" style={{ background: "linear-gradient(90deg,#5B8DEF,#16C784)" }}
              animate={{ width: `${job.progress * 100}%` }} />
          </div>
        </div>
      )}

      {err && <div className="glass mt-6 rounded-2xl p-5 text-sm text-sell">{err}</div>}

      {!job && !running && !err && (
        <TiltCard className="mt-10 rounded-3xl p-12 text-center" max={4}>
          <GitCompareArrows size={40} className="mx-auto mb-4 text-brand" />
          <h2 className="font-display text-2xl font-bold">Conservative vs Medium vs Aggressive</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Runs all three rule presets across every window and lays them side by side —
            so you can see the exact return-vs-drawdown tradeoff and pick your default.
            Takes ~3–5 min (cached after the first data pull).
          </p>
        </TiltCard>
      )}

      {/* Recommendation */}
      {job?.summary && (
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
          className="glass glow-brand mt-6 flex items-center gap-4 rounded-2xl p-6">
          <Trophy size={28} className="text-brand" />
          <div>
            <div className="eyebrow mb-1">Recommended</div>
            <div className="font-display text-2xl font-bold">{job.summary.recommended}</div>
            <p className="mt-1 text-sm text-muted">{job.summary.note}</p>
          </div>
        </motion.div>
      )}

      {/* Side-by-side cards */}
      {ordered.length > 0 && (
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          {ordered.map((p) => (
            <TiltCard key={p.label} className="rounded-2xl p-5" max={4}
              glow={job?.summary?.recommended === p.label ? "glow-brand" : ""}>
              <div className="flex items-center justify-between">
                <span className="font-display text-lg font-bold" style={{ color: PCOLOR[p.label] }}>{p.label}</span>
                <span className="num text-[11px] text-muted">−{((p.stop_loss_pct ?? 0) * 100).toFixed(0)}% / {((p.cash_reserve_pct ?? 0) * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg p-2.5" style={{ background: "rgb(var(--muted) / 0.08)" }}>
                  <div className="eyebrow text-[10px]">Avg Alpha</div>
                  <div className="num text-lg font-bold" style={{ color: p.avg_alpha >= 0 ? "#16C784" : "#F0526B" }}>
                    {(p.avg_alpha ?? 0) >= 0 ? "+" : ""}{(p.avg_alpha ?? 0).toFixed(1)}%
                  </div>
                </div>
                <div className="rounded-lg p-2.5" style={{ background: "rgb(var(--muted) / 0.08)" }}>
                  <div className="eyebrow text-[10px]">Avg Drawdown</div>
                  <div className="num text-lg font-bold text-hold">−{(p.avg_drawdown ?? 0).toFixed(1)}%</div>
                </div>
              </div>
              <div className="mt-2 text-center text-[11px] text-muted">Beat Nifty {p.windows_beating} windows</div>
              <div className="mt-3 border-t pt-3" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                {p.windows.map((w) => (
                  <div key={w.window} className="flex items-center justify-between py-1 text-[12px]">
                    <span className="num text-muted">{w.window}</span>
                    <span className="num font-bold" style={{ color: w.alpha_pct >= 0 ? "#16C784" : "#F0526B" }}>
                      {(w.alpha_pct ?? 0) >= 0 ? "+" : ""}{(w.alpha_pct ?? 0).toFixed(1)}% α
                    </span>
                  </div>
                ))}
              </div>
            </TiltCard>
          ))}
        </div>
      )}

      {/* Alpha-by-window grouped bars */}
      {ordered.length === 3 && (
        <TiltCard className="mt-6 rounded-2xl p-5" max={3}>
          <div className="eyebrow mb-4">Alpha by window — all presets</div>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={chartData} barGap={2}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
              <XAxis dataKey="window" tick={{ fill: "rgb(var(--muted))", fontSize: 12 }} />
              <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} unit="%" width={42} />
              <Tooltip cursor={{ fill: "rgb(var(--muted) / 0.08)" }}
                contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)", borderRadius: 12, color: "rgb(var(--ink))" }} />
              <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.4)" />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Bar dataKey="Conservative" fill="#22C5E0" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Medium" fill="#8B7CF6" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Aggressive" fill="#F2A93B" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </TiltCard>
      )}
      {/* Past runs */}
      {history.filter((h) => h.kind === "compare").length > 0 && (
        <div className="glass mt-6 rounded-2xl p-5">
          <button onClick={() => setHistOpen(!histOpen)} className="flex w-full items-center gap-2">
            <History size={15} className="text-muted" />
            <span className="eyebrow">Past comparison runs ({history.filter((h) => h.kind === "compare").length})</span>
          </button>
          {histOpen && (
            <div className="mt-3 flex flex-col gap-1.5">
              {history.filter((h) => h.kind === "compare").map((h) => (
                <button key={h.name} onClick={() => loadSaved(h.name)}
                  className="flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition hover:scale-[1.01]"
                  style={{ background: "rgb(var(--muted) / 0.06)" }}>
                  <span className="num text-muted">{h.finished_at?.slice(0, 16).replace("T", " ")}</span>
                  <span className="num font-bold text-brand">{h.summary?.recommended ? `→ ${h.summary.recommended}` : "view"}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
