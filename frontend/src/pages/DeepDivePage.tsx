import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { ArrowLeft, ShoppingCart, Crosshair } from "lucide-react";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, CartesianGrid,
} from "recharts";
import { getDeepDive, type DeepDive } from "../api/client";
import { LoadingOrb, ErrorState, ScoreBar, AnimatedNumber, TiltCard } from "../components/shared/ui";

const recColor = (r: string) => (r === "BUY" ? "#16C784" : r === "SELL" ? "#F0526B" : "#F2A93B");

export default function DeepDivePage() {
  const { symbol } = useParams();
  const nav = useNavigate();
  const [d, setD] = useState<DeepDive | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!symbol) return;
    setLoading(true); setError(null);
    try { setD(await getDeepDive(symbol)); }
    catch { setError(`Couldn't load ${symbol}. The backend may be busy or the symbol unavailable.`); }
    finally { setLoading(false); }
  }, [symbol]);
  useEffect(() => { load(); }, [load]);

  if (loading) return <LoadingOrb label={`Analyzing ${symbol?.replace(".NS", "")}…`} />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!d) return null;

  const t = d.technical;
  const f = d.fundamental;

  return (
    <div className="mx-auto max-w-6xl">
      <button onClick={() => nav(-1)} className="mb-4 flex items-center gap-1.5 text-sm text-muted transition hover:text-ink">
        <ArrowLeft size={15} /> Back
      </button>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">{d.sector || "—"} · {d.segment || "—"}</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">{d.symbol.replace(".NS", "")}</h1>
          <p className="mt-1 text-muted">{d.name}</p>
        </div>
        <div className="text-right">
          <AnimatedNumber value={d.current_price} prefix="₹" decimals={2} className="num text-3xl font-bold" />
          <div className="mt-2 inline-flex items-center gap-2 rounded-full px-3 py-1" style={{ background: `${recColor(d.recommendation)}22` }}>
            <span className="num text-sm font-bold" style={{ color: recColor(d.recommendation) }}>{d.recommendation}</span>
          </div>
          {!d.is_etf && (
            <button onClick={() => nav(`/options?symbol=${encodeURIComponent(d.symbol.replace(".NS", ""))}`)}
              className="ml-2 mt-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm font-bold transition hover:scale-105"
              style={{ background: "rgb(91 141 239 / 0.14)", color: "#5B8DEF" }}>
              <Crosshair size={13} /> Options
            </button>
          )}
        </div>
      </div>

      {/* Context strip: 52-week range, relative strength, earnings */}
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {(d as any).week52 && (
          <div className="glass rounded-2xl p-4">
            <div className="eyebrow mb-2">52-week range</div>
            <div className="relative h-2 rounded-full" style={{ background: "rgb(var(--muted) / 0.15)" }}>
              <div className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2"
                style={{ left: `calc(${(d as any).week52.position_pct}% - 7px)`, background: "#5B8DEF", borderColor: "rgb(var(--surface))" }} />
            </div>
            <div className="mt-2 flex justify-between text-[11px] text-muted">
              <span className="num">₹{(d as any).week52.low.toLocaleString("en-IN")}</span>
              <span className="num font-bold" style={{ color: "rgb(var(--ink))" }}>{(d as any).week52.position_pct}% of range</span>
              <span className="num">₹{(d as any).week52.high.toLocaleString("en-IN")}</span>
            </div>
          </div>
        )}
        {(d as any).rs_vs_nifty_20d != null && (
          <div className="glass rounded-2xl p-4">
            <div className="eyebrow mb-2">Relative strength (20d vs Nifty)</div>
            <div className="num text-2xl font-bold" style={{ color: (d as any).rs_vs_nifty_20d >= 0 ? "#16C784" : "#F0526B" }}>
              {(d as any).rs_vs_nifty_20d >= 0 ? "+" : ""}{(d as any).rs_vs_nifty_20d}%
            </div>
            <div className="mt-0.5 text-[11px] text-muted">{(d as any).rs_vs_nifty_20d >= 0 ? "Outperforming the index" : "Lagging the index"}</div>
          </div>
        )}
        {(d as any).next_earnings && (
          <div className="glass rounded-2xl p-4" style={{ borderColor: "rgb(139 124 246 / 0.35)" }}>
            <div className="eyebrow mb-2">Next earnings</div>
            <div className="num text-lg font-bold text-violet">{(d as any).next_earnings}</div>
            <div className="mt-0.5 text-[11px] text-muted">Avoid fresh buys 2 days before results</div>
          </div>
        )}
      </div>

      {/* Score breakdown */}
      <div className="mt-6 grid gap-4 md:grid-cols-4">
        {[
          { l: "Composite", v: d.scores.composite, c: recColor(d.recommendation) },
          { l: "Technical", v: d.scores.technical, c: "#22C5E0" },
          { l: "Fundamental", v: d.scores.fundamental, c: "#F2A93B" },
          { l: "Sentiment", v: d.scores.sentiment, c: "#16C784" },
        ].map((s, i) => (
          <motion.div key={s.l} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <TiltCard className="rounded-2xl p-5">
              <div className="eyebrow mb-2">{s.l}</div>
              <div className="num mb-2 text-2xl font-bold" style={{ color: s.c }}>{((s.v ?? 0) * 100).toFixed(0)}</div>
              <ScoreBar value={s.v} color={s.c} />
            </TiltCard>
          </motion.div>
        ))}
      </div>

      {/* Price chart */}
      <TiltCard className="mt-6 rounded-2xl p-5" max={3}>
        <div className="eyebrow mb-4">Price · 1 year · EMA20 / EMA50 overlay</div>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={d.price_series}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
            <XAxis dataKey="date" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} minTickGap={60} />
            <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 11 }} domain={["auto", "auto"]} width={56} />
            <Tooltip contentStyle={{ background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)", borderRadius: 12, color: "rgb(var(--ink))" }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="close" stroke="#22C5E0" strokeWidth={2} dot={false} name="Close" />
            <Line type="monotone" dataKey="ema20" stroke="#16C784" strokeWidth={1.5} dot={false} name="EMA20" />
            <Line type="monotone" dataKey="ema50" stroke="#F2A93B" strokeWidth={1.5} dot={false} name="EMA50" />
          </LineChart>
        </ResponsiveContainer>
      </TiltCard>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Technicals */}
        <TiltCard className="rounded-2xl p-5" max={3}>
          <div className="eyebrow mb-4">Technical Indicators</div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { l: "RSI (14)", v: t.rsi_14?.toFixed(1) },
              { l: "MACD", v: t.macd_signal },
              { l: "EMA Cross", v: t.ema_cross },
              { l: "ADX", v: t.adx?.toFixed(1) },
              { l: "Stochastic", v: t.stoch_k?.toFixed(1) },
              { l: "Bollinger %B", v: t.bb_percent_b?.toFixed(2) },
              { l: "Volume Ratio", v: t.volume_ratio?.toFixed(2) },
              { l: "20d Momentum", v: t.momentum_20d != null ? `${(t.momentum_20d * 100).toFixed(1)}%` : "—" },
            ].map((x) => (
              <div key={x.l} className="rounded-lg p-2.5" style={{ background: "rgb(var(--muted) / 0.08)" }}>
                <div className="eyebrow text-[10px]">{x.l}</div>
                <div className="num mt-0.5 text-sm font-bold">{x.v ?? "—"}</div>
              </div>
            ))}
          </div>
          {t.reasons?.length > 0 && (
            <div className="mt-4">
              {t.reasons.slice(0, 4).map((r: string, i: number) => (
                <p key={i} className="mt-1.5 flex gap-2 text-[12px] text-muted"><span className="text-cyan">›</span> {r}</p>
              ))}
            </div>
          )}
        </TiltCard>

        {/* Fundamentals */}
        <TiltCard className="rounded-2xl p-5" max={3}>
          <div className="eyebrow mb-4">Fundamentals {d.is_etf && "(ETF — limited)"}</div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { l: "P/E", v: f.pe_ratio?.toFixed(1) },
              { l: "P/B", v: f.pb_ratio?.toFixed(1) },
              { l: "ROE", v: f.roe != null ? `${(f.roe * 100).toFixed(0)}%` : "—" },
              { l: "D/E", v: f.debt_to_equity?.toFixed(2) },
              { l: "Rev Growth", v: f.revenue_growth != null ? `${(f.revenue_growth * 100).toFixed(0)}%` : "—" },
              { l: "Margin", v: f.profit_margin != null ? `${(f.profit_margin * 100).toFixed(0)}%` : "—" },
            ].map((x) => (
              <div key={x.l} className="rounded-lg p-2.5" style={{ background: "rgb(var(--muted) / 0.08)" }}>
                <div className="eyebrow text-[10px]">{x.l}</div>
                <div className="num mt-0.5 text-sm font-bold">{x.v ?? "—"}</div>
              </div>
            ))}
          </div>
          {f.reasons?.length > 0 && (
            <div className="mt-4">
              {f.reasons.slice(0, 4).map((r: string, i: number) => (
                <p key={i} className="mt-1.5 flex gap-2 text-[12px] text-muted"><span className="text-hold">›</span> {r}</p>
              ))}
            </div>
          )}
        </TiltCard>
      </div>

      {/* News + peers */}
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="eyebrow mb-3">Recent News</div>
          {d.related_news.length === 0 ? (
            <div className="glass rounded-2xl p-6 text-sm text-muted">No recent news matched this stock.</div>
          ) : (
            <div className="flex flex-col gap-2">
              {d.related_news.map((n, i) => (
                <a key={i} href={n.url} target="_blank" rel="noreferrer" className="glass block rounded-xl p-3.5 transition hover:scale-[1.01]">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm leading-relaxed">{n.headline}</p>
                    <span className="num shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold"
                      style={{ color: n.sentiment === "POSITIVE" ? "#16C784" : n.sentiment === "NEGATIVE" ? "#F0526B" : "rgb(var(--muted))", background: "rgb(var(--muted) / 0.12)" }}>
                      {(n.sentiment_score ?? 0) >= 0 ? "+" : ""}{(n.sentiment_score ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted">{n.source}</div>
                </a>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="eyebrow mb-3">Sector Peers</div>
          <div className="flex flex-col gap-2">
            {d.peers.map((p) => (
              <button key={p.symbol} onClick={() => nav(`/stock/${p.symbol}`)}
                className="glass flex items-center justify-between rounded-xl px-3.5 py-2.5 text-left transition hover:scale-[1.02]">
                <span className="font-bold text-sm">{p.symbol.replace(".NS", "")}</span>
                <span className="num text-[11px] text-muted">{p.segment}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
