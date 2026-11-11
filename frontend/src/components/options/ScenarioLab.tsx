import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, CartesianGrid, ReferenceLine, ReferenceDot,
} from "recharts";
import { RotateCcw } from "lucide-react";
import type { OptionsAnalysis, Plan, Strike } from "../../api/options";
import { bsGreeks, bsPrice } from "../../lib/blackScholes";
import { BAD, GOOD, Panel, Stat, inr, num, pct, pnlColor, sideColor, tooltipStyle } from "./parts";

const EXPIRY_GREY = "#7C8CB2";

export default function ScenarioLab({ a, s, plan, lots }: { a: OptionsAnalysis; s: Strike; plan: Plan; lots: number }) {
  const T0 = a.years_to_expiry, r = a.risk_free, q = a.carry_q;
  const sigma0 = s.iv / 100;
  const qty = lots * a.lot_size;
  const maxDays = Math.max(0, Math.floor(a.days_to_expiry * 10) / 10);
  const range = Math.max(2, Math.ceil(2.5 * sigma0 * Math.sqrt(T0) * 100));

  const [move, setMove] = useState(0);
  const [days, setDays] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const reset = () => { setMove(0); setDays(0); setIvShift(0); };

  const S = a.spot * (1 + move / 100);
  const T = Math.max(0, T0 - days / 365);
  const sig = Math.max(0.01, sigma0 * (1 + ivShift / 100));
  const value = bsPrice(S, s.strike, T, sig, s.side, r, q);
  const pnl = (value - s.entry) * qty;
  const pnlPct = (value / s.entry - 1) * 100;
  const g = bsGreeks(S, s.strike, T, sig, s.side, r, q);

  const curve = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 80; i++) {
      const px = a.spot * (1 - range / 100 + (2 * range / 100) * (i / 80));
      const atExp = (s.side === "CE" ? Math.max(0, px - s.strike) : Math.max(0, s.strike - px)) - s.entry;
      const now = bsPrice(px, s.strike, T, sig, s.side, r, q) - s.entry;
      pts.push({ px: Math.round(px * 100) / 100, expiry: Math.round(atExp * qty), scenario: Math.round(now * qty) });
    }
    return pts;
  }, [a.spot, range, s, T, sig, r, q, qty]);

  // P&L grid: moves in units of the holding-window σ × checkpoints in time
  const grid = useMemo(() => {
    const sm = plan.sigma_move / a.spot;
    const moves = [-2, -1, -0.5, 0, 0.5, 1, 2].map((k) => k * sm * 100);
    const cps = Array.from(new Set([0, Math.min(1, maxDays), Math.min(Math.round(plan.holding_days), maxDays), maxDays]
      .map((d) => Math.round(d * 10) / 10))).sort((x, y) => x - y);
    return { moves, cps, cell: (m: number, d: number) => {
      const v = bsPrice(a.spot * (1 + m / 100), s.strike, Math.max(0, T0 - d / 365), sigma0, s.side, r, q);
      return { pct: (v / s.entry - 1) * 100, rs: (v - s.entry) * qty };
    } };
  }, [plan, a.spot, maxDays, s, T0, sigma0, r, q, qty]);

  const tint = (p: number) => {
    const k = Math.min(1, Math.abs(p) / 100);
    return p >= 0 ? `rgb(22 199 132 / ${0.08 + 0.42 * k})` : `rgb(240 82 107 / ${0.08 + 0.42 * k})`;
  };

  return (
    <Panel title={`Scenario lab · ${s.strike.toLocaleString("en-IN")} ${s.side} × ${lots} lot${lots > 1 ? "s" : ""}`}
      hint="Drag the sliders to see what this position is worth if the underlying moves, time passes or volatility changes. Uses the same Black-Scholes model and market carry as the analysis. Excludes the exit spread and brokerage."
      right={<button onClick={reset} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] text-muted transition hover:text-ink"
        style={{ background: "rgb(var(--muted) / 0.1)" }}><RotateCcw size={12} /> Reset</button>}>
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_1.6fr]">
        <div className="flex flex-col gap-4">
          <Slider label={`${a.symbol} move`} value={move} min={-range} max={range} step={0.1} onChange={setMove}
            display={`${pct(move, 1)} → ${num(S, 2)}`} />
          <Slider label="Days passed" value={days} min={0} max={maxDays} step={0.1} onChange={setDays}
            display={`${days.toFixed(1)} of ${a.days_to_expiry.toFixed(1)} days`} />
          <Slider label="Implied volatility change" value={ivShift} min={-50} max={50} step={1} onChange={setIvShift}
            display={`${pct(ivShift, 0)} → IV ${(sig * 100).toFixed(1)}%`} />
          <div className="grid grid-cols-2 gap-2.5">
            <Stat label="Option price" value={inr(value)} sub={`paid ${inr(s.entry)}`} />
            <Stat label="Position P&L" value={inr(pnl, 0)} color={pnlColor(pnl)} sub={pct(pnlPct, 1)} />
            <Stat label="Delta (position)" value={num(g.delta * qty, 0)} sub={`₹ per 1-pt move · ${num(g.delta, 2)}/unit`}
              hint="How many rupees the position gains for a 1-point move in the underlying." />
            <Stat label="Theta (position)" value={inr(g.theta * qty, 0)} color={BAD} sub="lost per day if nothing moves" />
            <Stat label="Vega (position)" value={inr(g.vega * qty, 0)} sub="per 1 IV point"
              hint="Gain if implied volatility rises one point; loss if it falls (e.g. after results)." />
            <Stat label="Gamma" value={num(g.gamma, 4)} sub="delta change per point" />
          </div>
        </div>

        <div>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={curve} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
              <XAxis dataKey="px" type="number" domain={["dataMin", "dataMax"]} tick={{ fill: "rgb(var(--muted))", fontSize: 10 }}
                tickFormatter={(v) => Number(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })} />
              <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} width={64}
                tickFormatter={(v) => `₹${Number(v).toLocaleString("en-IN", { notation: "compact" })}`} />
              <Tooltip contentStyle={tooltipStyle}
                labelFormatter={(v) => `${a.symbol} at ${Number(v).toLocaleString("en-IN")}`}
                formatter={(v: number, n: string) => [inr(v, 0), n]} />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.6)" />
              <ReferenceLine x={a.spot} stroke="rgb(var(--muted) / 0.7)" strokeDasharray="4 4"
                label={{ value: "Spot", fill: "rgb(var(--muted))", fontSize: 10, position: "insideTopLeft" }} />
              <ReferenceLine x={plan.target1} stroke={GOOD} strokeDasharray="2 4"
                label={{ value: "T1", fill: "rgb(var(--muted))", fontSize: 10, position: "insideTop" }} />
              <ReferenceLine x={plan.stop} stroke={BAD} strokeDasharray="2 4"
                label={{ value: "Stop", fill: "rgb(var(--muted))", fontSize: 10, position: "insideTop" }} />
              <Line type="monotone" dataKey="expiry" name="At expiry" stroke={EXPIRY_GREY} strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="scenario" name={`After ${days.toFixed(1)} day(s)`} stroke={sideColor(s.side)} strokeWidth={2} dot={false} />
              <ReferenceDot x={Math.round(S * 100) / 100} y={Math.round(pnl)} r={5} fill={sideColor(s.side)}
                stroke="rgb(var(--surface))" strokeWidth={2} />
            </LineChart>
          </ResponsiveContainer>

          <div className="mt-4">
            <div className="eyebrow mb-2 text-[10px]">P&L grid — return on premium by move (σ of holding window) and day</div>
            <div className="overflow-x-auto">
              <table className="num w-full min-w-[420px] text-center text-[11.5px]">
                <thead>
                  <tr className="text-muted">
                    <th className="px-1.5 pb-1.5 text-left font-normal">Move ↓ / Day →</th>
                    {grid.cps.map((d) => <th key={d} className="px-1.5 pb-1.5 font-normal">{d === 0 ? "Now" : d >= maxDays ? "Expiry" : `+${d}d`}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {grid.moves.map((m, i) => (
                    <tr key={i}>
                      <td className="whitespace-nowrap px-1.5 py-0.5 text-left text-muted">
                        {[-2, -1, -0.5, 0, 0.5, 1, 2][i] > 0 ? "+" : ""}{[-2, -1, -0.5, 0, 0.5, 1, 2][i]}σ <span className="text-[10px]">({pct(m, 1)})</span>
                      </td>
                      {grid.cps.map((d) => {
                        const c = grid.cell(m, d);
                        return (
                          <td key={d} className="px-0.5 py-0.5">
                            <div className="rounded-md px-1.5 py-1 font-bold" style={{ background: tint(c.pct) }} title={inr(c.rs, 0)}>
                              {pct(c.pct, 0)}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Slider({ label, value, min, max, step, onChange, display }: {
  label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; display: string;
}) {
  return (
    <label className="block">
      <div className="flex items-baseline justify-between text-[12px]">
        <span className="text-muted">{label}</span><span className="num font-bold">{display}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 w-full accent-[#5B8DEF]" />
    </label>
  );
}
