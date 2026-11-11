import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { RefreshCw, TrendingUp, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { getDailyBrief, runEngine, type DailyBrief } from "../api/client";
import { AnimatedNumber, GoStatusPill, ScoreBar, LoadingOrb, TiltCard } from "../components/shared/ui";
import SectorHeatmap from "../components/dashboard/SectorHeatmap";
import SectorModal from "../components/dashboard/SectorModal";
import StockSearch from "../components/shared/StockSearch";
import { getGuardStatus, type GuardStatus } from "../api/client";
import { AlertTriangle, ChevronDown } from "lucide-react";

export default function DashboardPage() {
  const nav = useNavigate();
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sectorOpen, setSectorOpen] = useState<string | null>(null);
  const [guard, setGuard] = useState<GuardStatus | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const load = async () => {
    try { setError(null); setBrief(await getDailyBrief()); }
    catch { setError("Couldn't reach the engine. Is the backend running on port 8000?"); }
    finally { setLoading(false); }
  };
  const refresh = async () => {
    setRunning(true);
    try { setBrief(await runEngine()); }
    catch { setError("Engine run failed — check the backend logs."); }
    finally { setRunning(false); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (brief?.market_guard.go_status === "RED" && brief.market_guard.bad_news_detected) {
      getGuardStatus().then(setGuard).catch(() => {});
    } else { setGuard(null); }
  }, [brief]);

  if (loading) return <LoadingOrb label="Loading today's brief…" />;
  if (error) return (
    <div className="glass mx-auto mt-20 max-w-md rounded-2xl p-8 text-center">
      <p className="text-sell">{error}</p>
      <button onClick={load} className="mt-4 rounded-lg border px-4 py-2 text-sm" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>Try again</button>
    </div>
  );
  if (!brief) return null;

  const g = brief.market_guard;
  const c = brief.capital_status;
  const up = g.nifty_change_pct >= 0;
  const cards = [
    { label: "Total Capital", value: c.total, color: "rgb(var(--ink))" },
    { label: "Cash Available", value: c.cash, color: "#22C5E0" },
    { label: "Deployable Today", value: c.available_today, color: "#16C784" },
    { label: "Invested Today", value: c.invested_today, color: "#F2A93B" },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Morning Intelligence Brief · {brief.date}</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Good morning. Here's the read.</h1>
        </div>
        <div className="flex flex-1 items-center justify-end gap-3">
        <StockSearch />
        <button onClick={refresh} disabled={running}
          className="glass flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition hover:scale-105 disabled:opacity-50">
          <RefreshCw size={16} className={running ? "animate-spin" : ""} />
          {running ? "Running engine…" : "Refresh"}
        </button>
        </div>
      </div>

      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
        className="glass mb-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl p-6">
        <div className="flex items-center gap-5">
          <GoStatusPill status={g.go_status} />
          <p className="max-w-md text-sm text-muted">{g.go_message}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="eyebrow">Nifty 50</span>
          <span className={`num flex items-center gap-1 text-xl font-bold`} style={{ color: up ? "#16C784" : "#F0526B" }}>
            {up ? <ArrowUpRight size={18} /> : <ArrowDownRight size={18} />}
            {(g.nifty_change_pct ?? 0) >= 0 ? "+" : ""}{(g.nifty_change_pct ?? 0).toFixed(2)}%
          </span>
        </div>
      </motion.div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.06 }}>
            <TiltCard className="rounded-2xl p-5">
              <div className="eyebrow mb-2">{s.label}</div>
              <AnimatedNumber value={s.value} prefix="₹" className="num text-2xl font-bold" style={{ color: s.color }} />
            </TiltCard>
          </motion.div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <div className="mb-3 flex items-center gap-2">
            <TrendingUp size={18} className="text-buy" />
            <h2 className="font-display text-lg font-bold">Today's Buy Signals</h2>
            <span className="num ml-auto text-sm text-muted">{brief.buy_suggestions.length} found</span>
          </div>
          <div className="flex flex-col gap-3">
            {brief.buy_suggestions.length === 0 && (
              <div className="glass rounded-2xl p-6 text-sm text-muted">
                No buys clear all rules right now. That's the system working — discipline over activity.
              </div>
            )}
            {brief.buy_suggestions.map((s, i) => (
              <motion.div key={s.symbol} initial={{ opacity: 0, x: -16 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }}>
                <TiltCard className="rounded-2xl p-5" glow="glow-buy" max={6}>
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-md px-2 py-0.5 num text-[11px] font-bold text-buy" style={{ background: "rgb(22 199 132 / 0.15)" }}>BUY</span>
                        <button onClick={() => nav(`/stock/${s.symbol}`)} className="font-display text-lg font-bold transition hover:text-cyan">{s.symbol.replace(".NS", "")}</button>
                      </div>
                      <div className="mt-0.5 text-sm text-muted">{s.name} · {s.sector}</div>
                    </div>
                    <div className="text-right">
                      <div className="num text-lg font-bold">₹{s.total_value.toLocaleString("en-IN")}</div>
                      <div className="num text-xs text-muted">{s.quantity} × ₹{s.price.toLocaleString("en-IN")}</div>
                    </div>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3">
                    {[{ l: "Technical", v: s.scores.technical, c: "#22C5E0" },
                      { l: "Fundamental", v: s.scores.fundamental, c: "#F2A93B" },
                      { l: "Sentiment", v: s.scores.sentiment, c: "#16C784" }].map((m) => (
                      <div key={m.l}>
                        <div className="mb-1 flex justify-between text-[11px] text-muted"><span>{m.l}</span><span className="num">{((m.v ?? 0) * 100).toFixed(0)}</span></div>
                        <ScoreBar value={m.v} color={m.c} />
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between">
                    <div className="flex flex-wrap gap-1.5">
                      {s.reasons.slice(0, 2).map((r, j) => (
                        <span key={j} className="rounded-md px-2 py-1 text-[11px] text-muted" style={{ background: "rgb(var(--muted) / 0.1)" }}>{r}</span>
                      ))}
                    </div>
                    <div className="text-right">
                      <div className="num text-xl font-bold text-buy">{((s.composite_score ?? 0) * 100).toFixed(0)}</div>
                      <div className="eyebrow">{s.confidence}</div>
                    </div>
                  </div>
                </TiltCard>
              </motion.div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-2">
          <div className="mb-3"><h2 className="font-display text-lg font-bold">Sector Health</h2></div>
          <SectorHeatmap sectors={brief.sector_health} onSelect={(s) => setSectorOpen(s)} />
        </div>
      </div>

      {sectorOpen && <SectorModal sector={sectorOpen} onClose={() => setSectorOpen(null)} />}
    </div>
  );
}
