import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  AlertTriangle, Volume2, CalendarClock, Coins, ShieldCheck, Activity,
  BookOpenCheck, Stethoscope, Landmark, FlaskConical, Play,
} from "lucide-react";
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import {
  getEquityCurve, getJournal, getRisk, getDividends, getWatchFlags, getHealth,
  getGuardDiary, getFiiDii, startWalkforward, pollWalkforward,
  type EquityCurve, type RiskReport, type WatchFlag, type HealthReport,
  type GuardDiary, type JournalClosed, type JournalOpen, type WalkforwardStatus,
} from "../api/client";
import { AnimatedNumber, LoadingOrb, TiltCard } from "../components/shared/ui";

const FLAG_META: Record<string, { icon: any; color: string; label: string }> = {
  BAD_NEWS: { icon: AlertTriangle, color: "#F0526B", label: "Bad news" },
  VOLUME: { icon: Volume2, color: "#F2A93B", label: "Volume spike" },
  EARNINGS: { icon: CalendarClock, color: "#8B7CF6", label: "Earnings soon" },
  EX_DIVIDEND: { icon: Coins, color: "#22C5E0", label: "Ex-dividend" },
};

export default function InsightsPage() {
  const nav = useNavigate();
  const [curve, setCurve] = useState<EquityCurve | null>(null);
  const [risk, setRisk] = useState<RiskReport | null>(null);
  const [flags, setFlags] = useState<WatchFlag[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [diary, setDiary] = useState<GuardDiary | null>(null);
  const [journal, setJournal] = useState<{ closed: JournalClosed[]; open: JournalOpen[] } | null>(null);
  const [divs, setDivs] = useState<Awaited<ReturnType<typeof getDividends>> | null>(null);
  const [fii, setFii] = useState<Awaited<ReturnType<typeof getFiiDii>> | null>(null);
  const [loading, setLoading] = useState(true);

  // Walk-forward
  const [wf, setWf] = useState<WalkforwardStatus | null>(null);
  const [wfRunning, setWfRunning] = useState(false);
  const wfTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    // Progressive: equity curve first (it also writes today's snapshot),
    // then everything else in parallel — each panel fails independently.
    try { setCurve(await getEquityCurve()); } catch { /* panel shows fallback */ }
    setLoading(false);
    getRisk().then(setRisk).catch(() => {});
    getWatchFlags().then(setFlags).catch(() => {});
    getHealth().then(setHealth).catch(() => {});
    getGuardDiary().then(setDiary).catch(() => {});
    getJournal().then(setJournal).catch(() => {});
    getDividends().then(setDivs).catch(() => {});
    getFiiDii().then(setFii).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    return () => { if (wfTimer.current) clearInterval(wfTimer.current); };
  }, [load]);

  const runWalkforward = async () => {
    setWfRunning(true); setWf(null);
    try {
      const { job_id } = await startWalkforward();
      wfTimer.current = window.setInterval(async () => {
        try {
          const s = await pollWalkforward(job_id);
          setWf(s);
          if (s.status !== "RUNNING") {
            if (wfTimer.current) clearInterval(wfTimer.current);
            setWfRunning(false);
          }
        } catch {
          if (wfTimer.current) clearInterval(wfTimer.current);
          setWfRunning(false);
        }
      }, 2500);
    } catch { setWfRunning(false); }
  };

  if (loading) return <LoadingOrb label="Building your insights…" />;

  const pts = curve?.points || [];
  const hasCurve = pts.length >= 2;

  return (
    <div className="mx-auto max-w-6xl pb-16">
      <div className="eyebrow mb-2">Know Thyself</div>
      <h1 className="mb-8 font-display text-4xl font-extrabold tracking-tight">Insights</h1>

      {/* ── Hero: YOUR equity curve ── */}
      <TiltCard className="rounded-3xl p-6" max={3} glow="glow-brand">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="eyebrow mb-1">Your Track Record · paper portfolio vs Nifty</div>
            <AnimatedNumber value={curve?.current_value || 0} prefix="₹" className="num text-3xl font-bold" />
          </div>
          <div className="flex gap-6 text-right">
            <div>
              <div className="eyebrow">Return</div>
              <div className="num text-xl font-bold" style={{ color: (curve?.return_pct || 0) >= 0 ? "#16C784" : "#F0526B" }}>
                {(curve?.return_pct || 0) >= 0 ? "+" : ""}{curve?.return_pct ?? 0}%
              </div>
            </div>
            {curve?.alpha_pct != null && (
              <div>
                <div className="eyebrow">Alpha vs Nifty</div>
                <div className="num text-xl font-bold" style={{ color: curve.alpha_pct >= 0 ? "#16C784" : "#F0526B" }}>
                  {curve.alpha_pct >= 0 ? "+" : ""}{curve.alpha_pct}%
                </div>
              </div>
            )}
            <div>
              <div className="eyebrow">Days Tracked</div>
              <div className="num text-xl font-bold">{curve?.days_tracked ?? 0}</div>
            </div>
          </div>
        </div>
        {hasCurve ? (
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={pts}>
              <defs>
                <linearGradient id="pfFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#5B8DEF" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#5B8DEF" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
              <XAxis dataKey="date" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} minTickGap={50} />
              <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} unit="%" width={44} />
              <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)", borderRadius: 12, color: "rgb(var(--ink))" }} />
              <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.4)" />
              <Area type="monotone" dataKey="portfolio_pct" name="You" stroke="#5B8DEF" strokeWidth={2} fill="url(#pfFill)" />
              <Area type="monotone" dataKey="nifty_pct" name="Nifty" stroke="rgb(var(--muted))" strokeWidth={1.5} strokeDasharray="5 4" fill="none" />
              <Legend wrapperStyle={{ fontSize: 12 }} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="rounded-xl p-6 text-center text-sm text-muted" style={{ background: "rgb(var(--muted) / 0.06)" }}>
            Today's snapshot is saved. Your curve appears from tomorrow — it builds one point per day you use the app.
          </div>
        )}
      </TiltCard>

      {/* ── Needs attention ── */}
      <SectionTitle icon={AlertTriangle} title="Needs attention today" />
      {flags.length === 0 ? (
        <div className="glass rounded-2xl p-5 text-sm text-muted">All quiet — no bad news, volume spikes, earnings, or ex-dividend dates on your holdings.</div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {flags.map((f) => (
            <TiltCard key={f.symbol} className="rounded-2xl p-4" max={4}>
              <button onClick={() => nav(`/stock/${f.symbol}`)} className="num font-bold hover:text-cyan">{f.symbol.replace(".NS", "")}</button>
              <div className="mt-2 flex flex-col gap-1.5">
                {f.items.map((it, i) => {
                  const m = FLAG_META[it.type] || FLAG_META.BAD_NEWS;
                  const Icon = m.icon;
                  return (
                    <div key={i} className="flex items-start gap-2 text-[12px]">
                      <Icon size={13} style={{ color: m.color }} className="mt-0.5 shrink-0" />
                      <span className="text-muted">{it.detail}</span>
                    </div>
                  );
                })}
              </div>
            </TiltCard>
          ))}
        </div>
      )}

      {/* ── Risk ── */}
      <SectionTitle icon={ShieldCheck} title="Risk" />
      {!risk?.has_holdings ? (
        <div className="glass rounded-2xl p-5 text-sm text-muted">No holdings yet — risk metrics appear once you execute a buy.</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="grid grid-cols-1 gap-3">
            <StatCard label="Portfolio Beta" value={risk.portfolio_beta != null ? String(risk.portfolio_beta) : "—"}
              sub={risk.portfolio_beta != null ? (risk.portfolio_beta > 1 ? "Moves more than the market" : "Moves less than the market") : "Needs more history"} color="#8B7CF6" />
            <StatCard label="Worst-day estimate" value={`−₹${(risk.bad_day_estimate || 0).toLocaleString("en-IN")}`} sub="If the market drops 5%" color="#F0526B" />
            <StatCard label="Largest position" value={`${risk.largest_position?.pct ?? 0}%`} sub={risk.largest_position?.symbol?.replace(".NS", "") || "—"} color="#F2A93B" />
          </div>
          <div className="glass rounded-2xl p-5 lg:col-span-2">
            <div className="eyebrow mb-3">Sector concentration (cap {risk.sector_cap_pct}%)</div>
            <div className="flex flex-col gap-2.5">
              {(risk.sectors || []).map((s) => (
                <div key={s.sector}>
                  <div className="mb-1 flex justify-between text-[12px]">
                    <span>{s.sector}</span>
                    <span className="num font-bold" style={{ color: s.breach ? "#F0526B" : "rgb(var(--ink))" }}>{s.pct}%{s.breach ? " ⚠" : ""}</span>
                  </div>
                  <div className="relative h-2 overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.15)" }}>
                    <motion.div className="h-full rounded-full" initial={{ width: 0 }} animate={{ width: `${Math.min(100, s.pct)}%` }}
                      style={{ background: s.breach ? "#F0526B" : "linear-gradient(90deg,#5B8DEF,#16C784)" }} />
                    <div className="absolute top-0 h-full w-px" style={{ left: "35%", background: "rgb(var(--muted) / 0.6)" }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Guard diary ── */}
      <SectionTitle icon={Activity} title="Guard diary — was each RED day justified?" />
      <div className="glass rounded-2xl p-5">
        {!diary || diary.total_red === 0 ? (
          <p className="text-sm text-muted">No RED days recorded yet. Each day you open the app, the guard's verdict is logged — over weeks this becomes the honest forward measurement of R12.</p>
        ) : (
          <>
            <p className="mb-3 text-sm">
              <span className="num font-bold text-buy">{diary.justified}</span> of <span className="num font-bold">{diary.total_red}</span> RED days were followed by a real market fall.
            </p>
            <div className="flex flex-col gap-1.5">
              {diary.red_days.slice(-8).map((d) => (
                <div key={d.date} className="flex items-center justify-between rounded-lg px-3 py-2 text-[12px]" style={{ background: "rgb(var(--muted) / 0.06)" }}>
                  <span className="num text-muted">{d.date}</span>
                  <span className="max-w-[50%] truncate text-muted">{d.verdict}</span>
                  <span className="num font-bold" style={{ color: d.justified == null ? "rgb(var(--muted))" : d.justified ? "#16C784" : "#F2A93B" }}>
                    {d.next_day_nifty_pct == null ? "pending" : `next: ${d.next_day_nifty_pct >= 0 ? "+" : ""}${d.next_day_nifty_pct}% ${d.justified ? "✓ justified" : "· cried wolf"}`}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Journal ── */}
      <SectionTitle icon={BookOpenCheck} title="Trade journal" />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="glass rounded-2xl p-5">
          <div className="eyebrow mb-3">Closed trades — graded with hindsight</div>
          {!journal || journal.closed.length === 0 ? (
            <p className="text-sm text-muted">No sells yet. When you close a position, the system checks what the stock did in the 30 days after and grades the exit.</p>
          ) : journal.closed.map((t, i) => (
            <div key={i} className="mb-2 rounded-xl px-3.5 py-2.5" style={{ background: "rgb(var(--muted) / 0.06)" }}>
              <div className="flex items-center justify-between">
                <span className="num font-bold">{t.symbol.replace(".NS", "")}</span>
                <span className="num rounded px-2 py-0.5 text-[10px] font-bold"
                  style={{ color: t.grade === "GOOD EXIT" ? "#16C784" : t.grade === "SOLD EARLY" ? "#F2A93B" : "rgb(var(--muted))",
                           background: "rgb(var(--muted) / 0.12)" }}>{t.grade}</span>
              </div>
              <div className="mt-1 text-[11px] text-muted">{t.date} · {t.qty} @ ₹{(t.exit_price ?? 0).toLocaleString("en-IN")} · {t.note}</div>
            </div>
          ))}
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="eyebrow mb-3">Open positions — entry scores</div>
          {!journal || journal.open.length === 0 ? (
            <p className="text-sm text-muted">No open positions.</p>
          ) : journal.open.map((p, i) => {
            const pnl = (p.current / p.avg_buy - 1) * 100;
            return (
              <div key={i} className="mb-2 flex items-center justify-between rounded-xl px-3.5 py-2.5" style={{ background: "rgb(var(--muted) / 0.06)" }}>
                <button onClick={() => nav(`/stock/${p.symbol}`)} className="num font-bold hover:text-cyan">{p.symbol.replace(".NS", "")}</button>
                <span className="num text-[12px] text-muted">{p.entry_score != null ? `entry score ${(p.entry_score * 100).toFixed(0)}` : "manual entry"}</span>
                <span className="num text-[12px] font-bold" style={{ color: pnl >= 0 ? "#16C784" : "#F0526B" }}>{pnl >= 0 ? "+" : ""}{(pnl ?? 0).toFixed(1)}%</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Dividends + FII/DII ── */}
      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        <div className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2"><Coins size={15} className="text-hold" /><span className="eyebrow">Dividends earned</span></div>
          {!divs || divs.items.length === 0 ? (
            <p className="text-sm text-muted">No dividends recorded on current holdings yet.</p>
          ) : (
            <>
              {divs.items.map((d) => (
                <div key={d.symbol} className="flex justify-between py-1 text-[13px]">
                  <span className="num">{d.symbol.replace(".NS", "")} <span className="text-muted">× {d.qty}</span></span>
                  <span className="num font-bold text-buy">+₹{d.earned.toLocaleString("en-IN")}</span>
                </div>
              ))}
              <div className="mt-2 border-t pt-2 text-right" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                <span className="num font-bold text-buy">Total +₹{divs.total.toLocaleString("en-IN")}</span>
                <div className="text-[10px] text-muted">{divs.note}</div>
              </div>
            </>
          )}
        </div>
        <div className="glass rounded-2xl p-5">
          <div className="mb-3 flex items-center gap-2"><Landmark size={15} className="text-brand" /><span className="eyebrow">FII / DII flows (₹ cr)</span></div>
          {!fii?.available ? (
            <p className="text-sm text-muted">{fii?.note || "Loading…"}</p>
          ) : (fii.rows || []).map((r, i) => (
            <div key={i} className="flex justify-between py-1 text-[13px]">
              <span>{r.category} <span className="text-muted">{r.date}</span></span>
              <span className="num font-bold" style={{ color: r.net >= 0 ? "#16C784" : "#F0526B" }}>{r.net >= 0 ? "+" : ""}{r.net.toLocaleString("en-IN")}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Data health ── */}
      <SectionTitle icon={Stethoscope} title="Data health" />
      <div className="grid gap-3 md:grid-cols-4">
        <StatCard label="Coverage today" value={`${health?.coverage_pct ?? 0}%`} sub={`${health?.analyzed_today ?? 0}/${health?.universe_active ?? 0} symbols analyzed`} color={(health?.coverage_pct ?? 0) >= 95 ? "#16C784" : "#F2A93B"} />
        <StatCard label="Engine ran today" value={health?.engine_ran_today ? "Yes" : "No"} sub={health?.last_engine_run ? `Last: ${health.last_engine_run}` : "Never"} color={health?.engine_ran_today ? "#16C784" : "#F0526B"} />
        <StatCard label="Headlines today" value={String(health?.news_today ?? 0)} sub="Scored by FinBERT" color="#22C5E0" />
        <StatCard label="Benched symbols" value={String(health?.universe_benched ?? 0)} sub={(health?.benched || []).map((b) => b.symbol.replace(".NS", "")).join(", ") || "None"} color="#8B7CF6" />
      </div>
      {(health?.missing_today || []).length > 0 && (
        <p className="mt-2 text-[11px] text-muted">Missing today: {health!.missing_today.join(", ")}</p>
      )}

      {/* ── Walk-forward rigor check ── */}
      <SectionTitle icon={FlaskConical} title="Walk-forward check — does the edge survive out-of-sample?" />
      <div className="glass rounded-2xl p-5">
        <p className="mb-3 text-sm text-muted">
          Splits the last 3 years in half: each preset is judged on the recent half it wasn't tuned on.
          An edge that only exists in-sample is overfitting.
        </p>
        {!wf && (
          <button onClick={runWalkforward} disabled={wfRunning}
            className="glass glow-brand flex items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-medium transition hover:scale-105 disabled:opacity-60">
            <Play size={15} /> {wfRunning ? "Running…" : "Run walk-forward (~3–5 min)"}
          </button>
        )}
        {wf && wf.status === "RUNNING" && (
          <div>
            <div className="flex justify-between text-sm"><span className="text-muted">{wf.stage}</span><span className="num font-bold">{Math.round(wf.progress * 100)}%</span></div>
            <div className="mt-2 h-2 overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.15)" }}>
              <motion.div className="h-full rounded-full" style={{ background: "linear-gradient(90deg,#5B8DEF,#16C784)" }} animate={{ width: `${wf.progress * 100}%` }} />
            </div>
          </div>
        )}
        {wf?.summary && (
          <>
            <p className="mb-3 font-display text-lg font-bold">{wf.summary.verdict}</p>
            <div className="grid gap-3 md:grid-cols-3">
              {Object.values(wf.results).map((r: any) => (
                <div key={r.label} className="rounded-xl p-3.5" style={{ background: "rgb(var(--muted) / 0.06)" }}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold">{r.label}</span>
                    <span className="num text-[10px] font-bold" style={{ color: r.consistent ? "#16C784" : "#F0526B" }}>{r.consistent ? "CONSISTENT" : "OVERFIT?"}</span>
                  </div>
                  <div className="mt-2 flex justify-between text-[12px]"><span className="text-muted">In-sample α</span><span className="num font-bold">{r.in_sample.alpha_pct >= 0 ? "+" : ""}{r.in_sample.alpha_pct}%</span></div>
                  <div className="flex justify-between text-[12px]"><span className="text-muted">Out-of-sample α</span><span className="num font-bold" style={{ color: r.out_of_sample.alpha_pct >= 0 ? "#16C784" : "#F0526B" }}>{r.out_of_sample.alpha_pct >= 0 ? "+" : ""}{r.out_of_sample.alpha_pct}%</span></div>
                </div>
              ))}
            </div>
            <button onClick={runWalkforward} className="mt-3 text-sm text-brand">Re-run</button>
          </>
        )}
        {wf?.status === "FAILED" && <p className="text-sm text-sell">{wf.error || "Walk-forward failed."}</p>}
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, title }: { icon: any; title: string }) {
  return (
    <div className="mb-3 mt-8 flex items-center gap-2">
      <Icon size={17} className="text-brand" />
      <h2 className="font-display text-lg font-bold">{title}</h2>
    </div>
  );
}

function StatCard({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="glass rounded-2xl p-4">
      <div className="eyebrow mb-1">{label}</div>
      <div className="num text-xl font-bold" style={{ color }}>{value}</div>
      <div className="mt-0.5 truncate text-[11px] text-muted">{sub}</div>
    </div>
  );
}
