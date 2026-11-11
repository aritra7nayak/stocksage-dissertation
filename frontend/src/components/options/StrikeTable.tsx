import { Star } from "lucide-react";
import type { OptionsAnalysis, Side, Strike } from "../../api/options";
import { CALL, PUT, Panel, Segmented, compact, inr, num, pct, pnlColor, sideColor } from "./parts";

export default function StrikeTable({ a, side, onSide, selected, onSelect }: {
  a: OptionsAnalysis; side: Side; onSide: (s: Side) => void;
  selected: number | null; onSelect: (strike: number) => void;
}) {
  const strikes = a.sides[side].strikes;
  const top = strikes[0]?.strike;
  const against = side !== a.verdict.side && Math.abs(a.verdict.direction) >= 20;

  return (
    <Panel title="Strike selector — ranked for a buyer"
      hint="Score = delta fit 25% (0.40–0.60 ideal) + expected return if right 25% + liquidity 20% + reward:risk 15% + theta burn 15%. Click a row to load it into the trade plan and scenario lab."
      right={<Segmented value={side} onChange={onSide} options={[
        { value: "CE", label: "Calls (CE)", color: CALL }, { value: "PE", label: "Puts (PE)", color: PUT }]} />}>
      {against && (
        <p className="mb-3 rounded-lg px-3 py-2 text-[12px]" style={{ background: "rgb(240 82 107 / 0.1)" }}>
          You're viewing {side === "CE" ? "calls" : "puts"}, against the analysis ({a.verdict.stance.toLowerCase()}). Expected returns below reflect that.
        </p>
      )}
      <div className="-mx-1 overflow-x-auto px-1">
        <table className="w-full min-w-[920px] text-[12.5px]">
          <thead>
            <tr className="eyebrow text-left text-[9.5px]">
              {["Score", "Strike", "Premium", "1 lot", "Delta", "Theta/day", "IV", "Breakeven", "At T1", "At stop", "R:R",
                "If right", "No edge", "Spread", "OI"].map((h) => <th key={h} className="whitespace-nowrap px-2 pb-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {strikes.map((s: Strike) => {
              const on = s.strike === selected;
              return (
                <tr key={s.strike} onClick={() => onSelect(s.strike)} tabIndex={0}
                  onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(s.strike)}
                  className="num cursor-pointer border-t transition hover:bg-[rgb(var(--muted)/0.08)] focus:outline-none focus-visible:bg-[rgb(var(--muted)/0.12)]"
                  style={{ borderColor: "rgb(var(--line) / var(--line-a))", background: on ? `${sideColor(side)}1c` : undefined,
                    boxShadow: on ? `inset 3px 0 0 ${sideColor(side)}` : undefined }}>
                  <td className="px-2 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold">{s.score.toFixed(0)}</span>
                      {s.strike === top && <Star size={12} fill="#F2A93B" stroke="#F2A93B" aria-label="top pick" />}
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2">
                    <span className="font-bold">{s.strike.toLocaleString("en-IN")}</span>
                    <span className="ml-1.5 rounded px-1 py-0.5 text-[9.5px] font-bold text-muted" style={{ background: "rgb(var(--muted) / 0.14)" }}>{s.tag}</span>
                  </td>
                  <td className="px-2 font-bold">{inr(s.entry)}</td>
                  <td className="px-2">{inr(s.lot_cost, 0)}</td>
                  <td className="px-2">{num(s.delta, 2)}</td>
                  <td className="whitespace-nowrap px-2">{inr(s.theta)} <span className="text-muted">({s.theta_burn_pct.toFixed(1)}%)</span></td>
                  <td className="px-2">{s.iv.toFixed(1)}%</td>
                  <td className="whitespace-nowrap px-2">{s.breakeven.toLocaleString("en-IN")} <span className="text-muted">({pct(s.breakeven_move_pct, 1)})</span></td>
                  <td className="px-2" style={{ color: pnlColor(s.ret_t1_pct) }}>{pct(s.ret_t1_pct, 0)}</td>
                  <td className="px-2" style={{ color: pnlColor(s.ret_stop_pct) }}>{pct(s.ret_stop_pct, 0)}</td>
                  <td className="px-2">{s.reward_risk != null ? `${s.reward_risk.toFixed(2)}×` : "—"}</td>
                  <td className="px-2 font-bold" style={{ color: pnlColor(s.sim.signal.ev_pct) }}>{pct(s.sim.signal.ev_pct)}</td>
                  <td className="px-2" style={{ color: pnlColor(s.sim.neutral.ev_pct) }}>{pct(s.sim.neutral.ev_pct)}</td>
                  <td className="px-2">{s.spread_pct != null ? `${s.spread_pct.toFixed(2)}%` : "—"}</td>
                  <td className="px-2">{a.source === "NSE" ? compact(s.oi) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {strikes.length === 0 && <p className="text-sm text-muted">No liquid strikes for this side.</p>}
      <p className="mt-3 text-[11px] text-muted">
        Theta/day is the premium lost per calendar day if nothing moves (and its % of premium). "If right" tilts the simulation by the direction score;
        "No edge" assumes a fair coin — both include the bid/ask spread.
      </p>
    </Panel>
  );
}
