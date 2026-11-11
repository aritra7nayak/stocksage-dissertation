import { useEffect, useState } from "react";
import { Calculator } from "lucide-react";
import type { OptionsAnalysis, Plan, Strike } from "../../api/options";
import { BAD, GOOD, Panel, Stat, inr, pct, sideColor } from "./parts";

const SIZING_KEY = "ss-opt-sizing";

function loadSizing(): { capital: number; riskPct: number } {
  try {
    const v = JSON.parse(localStorage.getItem(SIZING_KEY) || "");
    if (v && v.capital > 0 && v.riskPct > 0) return v;
  } catch { /* first visit or storage blocked */ }
  return { capital: 100000, riskPct: 2 };
}

export default function TradePlan({ a, plan, s, lots, onLots }: {
  a: OptionsAnalysis; plan: Plan; s: Strike; lots: number; onLots: (n: number) => void;
}) {
  const [sizing, setSizing] = useState(loadSizing);
  useEffect(() => {
    try { localStorage.setItem(SIZING_KEY, JSON.stringify(sizing)); } catch { /* ignore */ }
  }, [sizing]);

  const call = s.side === "CE";
  const lot = a.lot_size;
  const riskPerLot = Math.max(0.01, (s.entry - s.premium_stop) * lot);
  const riskBudget = (sizing.capital * sizing.riskPct) / 100;
  const byRisk = Math.floor(riskBudget / riskPerLot);
  const byCapital = Math.floor(sizing.capital / s.lot_cost);
  const suggested = Math.max(0, Math.min(byRisk, byCapital));
  const qty = lots * lot;
  const from = (x: number) => pct((x / a.spot - 1) * 100, 2);

  return (
    <Panel title={`Trade plan · ${a.symbol} ${s.strike.toLocaleString("en-IN")} ${s.side}`}
      hint="Targets and stop are on the underlying, sized by the expected move over the holding window and snapped to open-interest walls. Premium levels are Black-Scholes reprices at those levels, net of the bid/ask spread.">
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1.3fr_1fr]">
        <div>
          {/* Level ladder */}
          <div className="flex flex-col gap-1.5">
            {[
              { k: "Target 2 (stretch)", u: plan.target2, p: s.premium_t2, r: s.ret_t2_pct, c: GOOD },
              { k: "Target 1 — book 50%", u: plan.target1, p: s.premium_t1, r: s.ret_t1_pct, c: GOOD },
              { k: "Entry (now)", u: a.spot, p: s.entry, r: 0, c: sideColor(s.side) },
              { k: "Stop loss — exit all", u: plan.stop, p: s.premium_stop, r: s.ret_stop_pct, c: BAD },
            ].map((x) => (
              <div key={x.k} className="grid grid-cols-[minmax(0,1.3fr)_1fr_1fr_64px] items-center gap-2 rounded-xl px-3 py-2.5"
                style={{ background: `${x.c}12`, boxShadow: `inset 3px 0 0 ${x.c}` }}>
                <span className="text-[12.5px] font-medium">{x.k}</span>
                <span className="num text-[12.5px]">{x.u.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                  {x.k !== "Entry (now)" && <span className="ml-1 text-[10.5px] text-muted">{from(x.u)}</span>}</span>
                <span className="num text-[12.5px] font-bold">{inr(x.p)}</span>
                <span className="num text-right text-[12.5px] font-bold" style={{ color: x.r > 0 ? GOOD : x.r < 0 ? BAD : undefined }}>
                  {x.r === 0 ? "—" : pct(x.r, 0)}
                </span>
              </div>
            ))}
            <div className="eyebrow grid grid-cols-[minmax(0,1.3fr)_1fr_1fr_64px] gap-2 px-3 text-[9px]">
              <span>Level</span><span>{a.symbol}</span><span>Premium</span><span className="text-right">Return</span>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <Stat label="Hold for" value={`~${plan.holding_days.toFixed(0)} day${plan.holding_days >= 2 ? "s" : ""}`}
              sub={`then ${pct(s.ret_flat_pct, 0)} if flat`} hint="Time stop: if neither target nor stop is hit, exit. The 'if flat' figure is the theta cost of waiting." />
            <Stat label="Breakeven at expiry" value={s.breakeven.toLocaleString("en-IN")} sub={`${pct(s.breakeven_move_pct, 2)} move needed`} />
            <Stat label="Hits target first" value={`${s.sim.signal.p_target.toFixed(0)}%`} sub={`stop first ${s.sim.signal.p_stop.toFixed(0)}%`}
              hint="Simulated share of paths touching target 1 before the stop within the holding window (signal view)." />
            <Stat label="Expiry win chance" value={`${s.pop_expiry.toFixed(0)}%`} sub="ends beyond breakeven"
              hint="Market-implied probability the underlying finishes past breakeven at expiry (no edge assumed)." />
          </div>

          <div className="mt-4 rounded-xl p-3.5" style={{ background: "rgb(var(--muted) / 0.07)" }}>
            <div className="eyebrow mb-2 text-[10px]">Execution playbook</div>
            <ol className="flex list-decimal flex-col gap-1 pl-4 text-[12.5px] leading-relaxed">
              <li>Limit-buy at or below <b className="num">{inr(s.ask > 0 ? s.ask : s.entry)}</b> — never a market order on options.</li>
              <li>Set a stop: exit if {a.symbol} {call ? "closes below" : "closes above"} <b className="num">{plan.stop.toLocaleString("en-IN")}</b> or premium falls to <b className="num">{inr(s.premium_stop)}</b>.</li>
              <li>At target 1 ({plan.target1.toLocaleString("en-IN")}), book half and move the stop on the rest to your entry price.</li>
              <li>Exit the rest at target 2 ({plan.target2.toLocaleString("en-IN")}) or after ~{plan.holding_days.toFixed(0)} day(s), whichever comes first.</li>
              <li>Never average down a losing option — buy a fresh setup instead.</li>
            </ol>
            {plan.notes.length > 0 && <p className="mt-2 text-[11px] text-muted">{plan.notes.join(" · ")}</p>}
          </div>
        </div>

        {/* Position sizing */}
        <div className="rounded-2xl p-4" style={{ background: "rgb(var(--muted) / 0.07)" }}>
          <div className="mb-3 flex items-center gap-2 text-sm font-bold"><Calculator size={15} /> Position size</div>
          <label className="block text-[11px] text-muted">Trading capital (₹)
            <input type="number" min={1000} step={1000} value={sizing.capital}
              onChange={(e) => setSizing({ ...sizing, capital: Math.max(0, Number(e.target.value) || 0) })}
              className="num mt-1 w-full rounded-lg border bg-transparent px-3 py-2 text-sm text-ink outline-none focus:border-brand"
              style={{ borderColor: "rgb(var(--line) / var(--line-a))" }} />
          </label>
          <label className="mt-3 block text-[11px] text-muted">Max risk per trade: <b className="num text-ink">{sizing.riskPct}%</b> ({inr(riskBudget, 0)})
            <input type="range" min={0.5} max={10} step={0.5} value={sizing.riskPct}
              onChange={(e) => setSizing({ ...sizing, riskPct: Number(e.target.value) })} className="mt-1 w-full accent-[#5B8DEF]" />
          </label>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Stat label="Risk per lot" value={inr(riskPerLot, 0)} sub="entry → stop" />
            <Stat label="Suggested" value={`${suggested} lot${suggested === 1 ? "" : "s"}`}
              sub={byRisk < byCapital ? "limited by risk" : "limited by capital"} />
          </div>
          {suggested === 0 && (
            <p className="mt-2 text-[11px]" style={{ color: BAD }}>
              Even one lot risks more than your budget ({inr(riskPerLot, 0)} vs {inr(riskBudget, 0)}). Skip, or pick a cheaper strike.
            </p>
          )}
          <div className="mt-3 flex items-center gap-2">
            <label className="text-[11px] text-muted" htmlFor="opt-lots">Lots</label>
            <input id="opt-lots" type="number" min={1} max={500} value={lots}
              onChange={(e) => onLots(Math.max(1, Math.min(500, Math.floor(Number(e.target.value) || 1))))}
              className="num w-20 rounded-lg border bg-transparent px-2 py-1.5 text-sm text-ink outline-none focus:border-brand"
              style={{ borderColor: "rgb(var(--line) / var(--line-a))" }} />
            {suggested > 0 && suggested !== lots && (
              <button onClick={() => onLots(suggested)} className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold transition hover:scale-105"
                style={{ background: "rgb(91 141 239 / 0.15)", color: "#5B8DEF" }}>Use {suggested}</button>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-1.5 text-[12.5px]">
            <Row k="Quantity" v={`${qty.toLocaleString("en-IN")} (${lots} × ${lot})`} />
            <Row k="Capital used" v={inr(s.entry * qty, 0)} sub={sizing.capital ? `${((s.entry * qty / sizing.capital) * 100).toFixed(1)}% of capital` : ""} />
            <Row k="Loss at stop" v={inr(-(s.entry - s.premium_stop) * qty, 0)} color={BAD} />
            <Row k="Profit at T1" v={inr((s.premium_t1 - s.entry) * qty, 0)} color={GOOD} />
            <Row k="Expected (if right)" v={inr((s.sim.signal.ev_pct / 100) * s.entry * qty, 0)} color={s.sim.signal.ev_pct >= 0 ? GOOD : BAD} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function Row({ k, v, sub, color }: { k: string; v: string; sub?: string; color?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b pb-1.5" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
      <span className="text-muted">{k}</span>
      <span className="num text-right font-bold" style={color ? { color } : undefined}>{v}{sub && <span className="ml-1.5 text-[10.5px] font-normal text-muted">{sub}</span>}</span>
    </div>
  );
}
