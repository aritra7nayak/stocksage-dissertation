import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, CartesianGrid, ReferenceLine } from "recharts";
import { Newspaper, CalendarClock } from "lucide-react";
import type { OptionsAnalysis, Plan } from "../../api/options";
import { BAD, CALL, GOOD, PUT, DivergingBar, Panel, Stat, num, pct, tooltipStyle } from "./parts";

const CLOSE = "#22C5E0", EMA20 = "#8B7CF6", EMA50 = "#7C8CB2";

/** Price with EMAs and the trade's levels drawn on — "where am I, where am I going". */
export function PriceMap({ a, plan }: { a: OptionsAnalysis; plan: Plan }) {
  const m = a.chain_metrics;
  const lv = [plan.target1, plan.target2, plan.stop, m.support, m.resistance].filter((x): x is number => x != null);
  const closes = a.price_series.map((p) => p.close);
  const lo = Math.min(...closes, ...lv), hi = Math.max(...closes, ...lv);
  const pad = (hi - lo) * 0.04;
  const lbl = (value: string) => ({ value, fill: "rgb(var(--muted))", fontSize: 10, position: "insideRight" as const });
  return (
    <Panel title="Trade map · last 6 months" hint="Recent price with trend lines, the plan's target/stop levels and the option-chain support/resistance walls.">
      <ResponsiveContainer width="100%" height={280}>
        <LineChart data={a.price_series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
          <XAxis dataKey="date" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} minTickGap={50} />
          <YAxis domain={[lo - pad, hi + pad]} tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} width={60}
            tickFormatter={(v) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })} />
          <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [num(v, 2), n]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={plan.target2} stroke={GOOD} strokeDasharray="2 5" label={lbl("T2")} />
          <ReferenceLine y={plan.target1} stroke={GOOD} strokeDasharray="5 4" label={lbl("T1")} />
          <ReferenceLine y={plan.stop} stroke={BAD} strokeDasharray="5 4" label={lbl("Stop")} />
          {m.resistance && <ReferenceLine y={m.resistance} stroke={CALL} strokeDasharray="1 4" label={{ ...lbl("Call wall"), position: "insideLeft" }} />}
          {m.support && <ReferenceLine y={m.support} stroke={PUT} strokeDasharray="1 4" label={{ ...lbl("Put wall"), position: "insideLeft" }} />}
          <Line type="monotone" dataKey="close" name="Close" stroke={CLOSE} strokeWidth={2} dot={false} />
          <Line type="monotone" dataKey="ema20" name="EMA20" stroke={EMA20} strokeWidth={1.5} dot={false} />
          <Line type="monotone" dataKey="ema50" name="EMA50" stroke={EMA50} strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </Panel>
  );
}

export function SentimentPanel({ a }: { a: OptionsAnalysis }) {
  const s = a.sentiment;
  const total = s.positive + s.negative + s.neutral;
  const scope = a.symbol === "NIFTY" ? "market-wide headlines" : a.kind === "INDEX" ? "banking & finance headlines" : `headlines mentioning ${a.name}`;
  return (
    <Panel title="News sentiment (FinBERT)" hint="Headlines from the last 3 days scored by FinBERT, a finance-tuned language model: −1 very negative to +1 very positive. Refresh news on the News page.">
      <div className="grid grid-cols-2 gap-2.5">
        <div className="col-span-2 rounded-xl p-3" style={{ background: "rgb(var(--muted) / 0.08)" }}>
          <div className="flex items-baseline justify-between">
            <span className="eyebrow text-[10px]">Average tone · {scope}</span>
            <span className="num text-lg font-bold" style={{ color: s.avg > 0.05 ? GOOD : s.avg < -0.05 ? BAD : undefined }}>
              {s.count ? `${s.avg > 0 ? "+" : ""}${s.avg.toFixed(2)}` : "—"}
            </span>
          </div>
          <div className="mt-2"><DivergingBar value={s.avg} muted={!s.count} /></div>
          {total > 0 && (
            <div className="mt-3">
              <div className="flex h-2 overflow-hidden rounded-full" role="img"
                aria-label={`${s.positive} positive, ${s.neutral} neutral, ${s.negative} negative`}>
                <div style={{ width: `${(s.positive / total) * 100}%`, background: GOOD }} />
                <div style={{ width: `${(s.neutral / total) * 100}%`, background: "rgb(var(--muted) / 0.35)", marginLeft: 2 }} />
                <div style={{ width: `${(s.negative / total) * 100}%`, background: BAD, marginLeft: 2 }} />
              </div>
              <div className="mt-1 flex justify-between text-[10.5px] text-muted">
                <span>{s.positive} positive</span><span>{s.neutral} neutral</span><span>{s.negative} negative</span>
              </div>
            </div>
          )}
        </div>
        <Stat label="Market tone" value={`${s.market_avg > 0 ? "+" : ""}${s.market_avg.toFixed(2)}`} sub={s.market_overall ?? undefined} />
        <Stat label="Bad-news guard" value={s.market_stopped ? "RISK-OFF" : s.sector_blocked ? "SECTOR HIT" : "Clear"}
          color={s.market_stopped || s.sector_blocked ? BAD : GOOD} sub={s.guard_verdict ?? undefined} />
      </div>
      {a.event && (
        <div className="mt-3 flex items-start gap-2.5 rounded-xl p-3" style={{ background: "rgb(139 124 246 / 0.12)" }}>
          <CalendarClock size={16} className="mt-0.5 shrink-0 text-violet" />
          <p className="text-[12px]"><b>Results on {a.event}</b>, before this expiry. Implied volatility usually collapses right after results
            ("IV crush"), which can make a correct directional bet lose money. Prefer buying after the announcement, or size small.</p>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        {s.headlines.length === 0 && (
          <p className="flex items-center gap-2 text-[12px] text-muted"><Newspaper size={14} /> No matching headlines in the last 3 days.</p>
        )}
        {s.headlines.slice(0, 8).map((h, i) => (
          <a key={i} href={h.url ?? undefined} target="_blank" rel="noreferrer"
            className="flex items-start justify-between gap-3 rounded-xl p-2.5 transition hover:bg-[rgb(var(--muted)/0.08)]">
            <span className="text-[12.5px] leading-snug">{h.headline}<span className="ml-1.5 text-[10.5px] text-muted">{h.source}</span></span>
            <span className="num shrink-0 rounded px-1.5 py-0.5 text-[11px] font-bold"
              style={{ color: h.score > 0.05 ? GOOD : h.score < -0.05 ? BAD : "rgb(var(--muted))", background: "rgb(var(--muted) / 0.12)" }}>
              {h.score > 0 ? "+" : ""}{h.score.toFixed(2)}
            </span>
          </a>
        ))}
      </div>
    </Panel>
  );
}

export function TechnicalPanel({ a }: { a: OptionsAnalysis }) {
  const t = a.technical;
  const cross = (v: string) => (v === "NONE" ? "None" : v.replace("_", " ").toLowerCase());
  return (
    <Panel title="Technical snapshot" hint="Daily indicators the direction score is built from.">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="RSI (14)" value={num(t.rsi_14, 1)} sub={t.rsi_14 > 70 ? "overbought" : t.rsi_14 < 30 ? "oversold" : t.rsi_14 >= 55 ? "bullish zone" : t.rsi_14 <= 45 ? "bearish zone" : "neutral"} />
        <Stat label="MACD" value={t.macd_hist > 0 ? "Positive" : "Negative"} sub={`cross: ${cross(t.macd_signal)}`} color={t.macd_hist > 0 ? GOOD : BAD} />
        <Stat label="ADX" value={num(t.adx, 0)} sub={t.adx > 25 ? "trending" : t.adx > 20 ? "moderate" : "rangebound"} />
        <Stat label="EMA 20 / 50" value={`${num(t.ema_20, 0)} / ${num(t.ema_50, 0)}`} sub={`cross: ${cross(t.ema_cross)}`} />
        <Stat label="Stochastic %K" value={num(t.stoch_k, 0)} />
        <Stat label="Bollinger %B" value={num(t.bb_percent_b, 2)} sub="0 = lower band, 1 = upper" />
        <Stat label="20-day momentum" value={pct(t.momentum_20d * 100, 1)} color={t.momentum_20d >= 0 ? GOOD : BAD} />
        <Stat label="Volume vs avg" value={`${num(t.volume_ratio, 2)}×`} />
        <Stat label="Below 52w high" value={pct(-t.dist_52w_high * 100, 1, false)} />
      </div>
      {a.context.nifty_trend && <p className="mt-3 text-[12px] text-muted">Broad market: {a.context.nifty_trend}.</p>}
    </Panel>
  );
}
