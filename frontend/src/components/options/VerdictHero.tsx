import { motion } from "framer-motion";
import { TrendingUp, TrendingDown, Ban, Clock } from "lucide-react";
import type { OptionsAnalysis, Strike } from "../../api/options";
import { BAD, GOOD, WARN, Hint, inr, pct, pnlColor, sideColor } from "./parts";

function Ring({ value, label, hint, color }: { value: number; label: string; hint: string; color: string }) {
  const r = 34, c = 2 * Math.PI * r, v = Math.max(0, Math.min(100, value));
  return (
    <div className="flex flex-col items-center">
      <svg width="88" height="88" viewBox="0 0 88 88" role="img" aria-label={`${label} ${v.toFixed(0)} of 100`}>
        <circle cx="44" cy="44" r={r} fill="none" stroke="rgb(var(--muted) / 0.15)" strokeWidth="7" />
        <motion.circle cx="44" cy="44" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={c} transform="rotate(-90 44 44)"
          initial={{ strokeDashoffset: c }} animate={{ strokeDashoffset: c * (1 - v / 100) }}
          transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }} />
        <text x="44" y="50" textAnchor="middle" className="num" fontSize="20" fontWeight="700" fill="rgb(var(--ink))">
          {v.toFixed(0)}
        </text>
      </svg>
      <div className="eyebrow mt-1 flex items-center gap-1 text-[10px]">{label}<Hint text={hint} /></div>
    </div>
  );
}

function DirectionMeter({ value }: { value: number }) {
  const pos = (Math.max(-100, Math.min(100, value)) + 100) / 2;
  return (
    <div>
      <div className="eyebrow mb-2 flex items-center gap-1 text-[10px]">Direction score
        <Hint text="−100 (strongly bearish) to +100 (strongly bullish). Weighted blend of technicals 35%, option-chain flow 30%, news sentiment 20% and market context 15%. Inside ±20 there is no edge for a buyer." />
      </div>
      <div className="relative h-3 rounded-full"
        style={{ background: `linear-gradient(90deg, ${BAD} 0%, rgb(var(--muted) / 0.25) 40%, rgb(var(--muted) / 0.25) 60%, ${GOOD} 100%)` }}>
        <div className="absolute inset-y-0 rounded" style={{ left: "40%", width: "20%", background: "rgb(var(--surface) / 0.55)" }} />
        <motion.div className="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px]"
          style={{ background: "rgb(var(--ink))", borderColor: "rgb(var(--surface))" }}
          initial={{ left: "50%" }} animate={{ left: `${pos}%` }} transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }} />
      </div>
      <div className="mt-1.5 flex justify-between text-[10px] text-muted">
        <span>Bearish</span><span>No edge</span><span>Bullish</span>
      </div>
      <div className="num mt-1 text-center text-2xl font-bold">{value > 0 ? "+" : ""}{value.toFixed(0)}</div>
    </div>
  );
}

export default function VerdictHero({ a, pick }: { a: OptionsAnalysis; pick: Strike | null }) {
  const v = a.verdict;
  const trade = v.action === "BUY_CALL" || v.action === "BUY_PUT";
  const color = trade ? sideColor(v.side) : v.action === "WAIT" ? WARN : "rgb(var(--muted))";
  const Icon = v.action === "BUY_CALL" ? TrendingUp : v.action === "BUY_PUT" ? TrendingDown : v.action === "WAIT" ? Clock : Ban;
  const title = { BUY_CALL: "BUY CALL", BUY_PUT: "BUY PUT", NO_TRADE: "NO TRADE", WAIT: "WAIT" }[v.action];
  const best = a.recommended;

  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="glass relative overflow-hidden rounded-3xl p-6"
      style={{ boxShadow: `0 0 34px ${trade ? sideColor(v.side) : "#000"}22, inset 0 0 0 1px ${trade ? sideColor(v.side) + "44" : "transparent"}` }}>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.25fr_1fr_1.1fr]">
        {/* Verdict */}
        <div>
          <div className="eyebrow mb-2">Verdict · {a.expiry} expiry</div>
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl" style={{ background: `${trade ? sideColor(v.side) : "#7c8cb2"}22` }}>
              <Icon size={24} style={{ color }} />
            </div>
            <div>
              <div className="font-display text-3xl font-extrabold tracking-tight" style={{ color }}>{title}</div>
              <div className="text-sm text-muted">{v.stance} · {v.confluence.toFixed(0)}% of signals agree</div>
            </div>
            {trade && (
              <div className="ml-auto grid h-14 w-14 place-items-center rounded-2xl border-2 font-display text-2xl font-extrabold"
                style={{ borderColor: color, color }} title="Setup grade (A best → D)">{v.grade}</div>
            )}
          </div>
          {v.reason ? (
            <p className="mt-4 text-sm leading-relaxed text-muted">{v.reason}</p>
          ) : best && (
            <div className="mt-4 rounded-xl p-3.5" style={{ background: `${sideColor(best.side)}14` }}>
              <div className="eyebrow mb-1 text-[10px]">Suggested contract</div>
              <div className="font-display text-lg font-bold">
                {a.symbol} {a.expiry} {best.strike.toLocaleString("en-IN")} {best.side}
              </div>
              <div className="num mt-0.5 text-sm text-muted">
                Buy at ≤ {inr(best.entry)} · 1 lot = {a.lot_size} × {inr(best.entry)} = <b className="text-ink">{inr(best.lot_cost, 0)}</b>
              </div>
            </div>
          )}
          {!trade && best && (
            <p className="mt-3 text-[12px] text-muted">
              If you still want exposure, the best-ranked {best.side === "CE" ? "call" : "put"} is {best.strike.toLocaleString("en-IN")} {best.side} at {inr(best.entry)} — see the strike table.
            </p>
          )}
        </div>

        {/* Scores */}
        <div className="flex flex-col justify-between gap-4">
          <DirectionMeter value={v.direction} />
          <div className="flex justify-around">
            <Ring value={v.trade_score} label="Trade score" color={color === "rgb(var(--muted))" ? "#7C8CB2" : color}
              hint="60% conviction (|direction|) + 40% buyer suitability. Grade A ≥ 75, B ≥ 60, C ≥ 45." />
            <Ring value={v.suitability} label="Buyer fit" color={v.suitability >= 60 ? GOOD : v.suitability >= 40 ? WARN : BAD}
              hint="Is now a good time to PAY premium? IV vs realised vol 25%, trend strength 25%, time to expiry 20%, liquidity 15%, event risk 15%." />
          </div>
        </div>

        {/* Expected outcome for the chosen strike */}
        <div className="grid grid-cols-2 gap-2.5 self-start">
          {pick ? (
            <>
              <Outcome label="Expected return if right" value={pct(pick.sim.signal.ev_pct)} color={pnlColor(pick.sim.signal.ev_pct)}
                hint="Monte Carlo average over the holding window, with the drift tilted by the direction score (up to ½σ). Includes the bid/ask spread." />
              <Outcome label="Expected return, no edge" value={pct(pick.sim.neutral.ev_pct)} color={pnlColor(pick.sim.neutral.ev_pct)}
                hint="Same simulation with no directional edge. Usually slightly negative — that is the cost of buying options." />
              <Outcome label="At target 1" value={pct(pick.ret_t1_pct, 0)} color={GOOD}
                sub={`${inr(pick.premium_t1)} premium`} />
              <Outcome label="At stop" value={pct(pick.ret_stop_pct, 0)} color={BAD}
                sub={`${inr(pick.premium_stop)} premium`} />
              <Outcome label="Chance of profit" value={`${pick.sim.signal.p_profit.toFixed(0)}%`}
                hint="Share of simulated paths that exit with a profit (signal view)." sub={`${pick.sim.neutral.p_profit.toFixed(0)}% with no edge`} />
              <Outcome label="Max loss / lot" value={inr(pick.lot_cost, 0)} color={BAD}
                sub="if held to expiry worthless" />
            </>
          ) : <p className="col-span-2 text-sm text-muted">No tradable strike found for this expiry.</p>}
        </div>
      </div>
    </motion.div>
  );
}

function Outcome({ label, value, sub, hint, color }: { label: string; value: string; sub?: string; hint?: string; color?: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "rgb(var(--muted) / 0.08)" }}>
      <div className="eyebrow flex items-center gap-1 text-[9.5px]">{label}{hint && <Hint text={hint} />}</div>
      <div className="num mt-1 text-lg font-bold" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[10.5px] text-muted">{sub}</div>}
    </div>
  );
}
