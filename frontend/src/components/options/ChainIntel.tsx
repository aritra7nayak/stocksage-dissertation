import { useState } from "react";
import { BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, Legend, CartesianGrid, ReferenceLine } from "recharts";
import { ChevronDown } from "lucide-react";
import type { OptionsAnalysis } from "../../api/options";
import { CALL, PUT, Panel, Segmented, Stat, compact, inr, num, pct, tooltipStyle } from "./parts";

export default function ChainIntel({ a }: { a: OptionsAnalysis }) {
  const m = a.chain_metrics, vol = a.volatility;
  const [mode, setMode] = useState<"oi" | "chg">("oi");
  const [open, setOpen] = useState(false);
  const live = m.has_oi;

  const bars = a.chain.map((r) => ({
    strike: r.strike,
    CE: mode === "oi" ? r.ce?.oi ?? 0 : r.ce?.chg_oi ?? 0,
    PE: mode === "oi" ? r.pe?.oi ?? 0 : r.pe?.chg_oi ?? 0,
  }));
  const ivhv = vol.iv_hv_ratio;

  return (
    <Panel title="Option-chain intelligence"
      hint="What option writers (the big money that sells options) are positioned for. Heavy put OI below spot acts as support, heavy call OI above acts as resistance.">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Expected move" value={m.expected_move ? `±${num(m.expected_move, 0)}` : "—"} sub={m.expected_move_pct ? `±${m.expected_move_pct.toFixed(2)}% by expiry` : undefined}
          hint="Priced by the ATM straddle: the market's one-standard-deviation range to expiry." />
        <Stat label="Expiry range" value={m.range_low ? `${num(m.range_low, 0)}–${num(m.range_high, 0)}` : "—"} sub="~68% likely" />
        <Stat label="PCR (OI)" value={m.pcr_oi != null ? m.pcr_oi.toFixed(2) : "—"} sub={m.pcr_volume != null ? `volume PCR ${m.pcr_volume.toFixed(2)}` : "no live OI"}
          hint="Put-call ratio of open interest. Above ~1.2 = put writers confident (bullish); below ~0.8 = call writers dominate (bearish). Extremes can reverse." />
        <Stat label="Max pain" value={m.max_pain ? num(m.max_pain, 0) : "—"} sub={m.max_pain ? pct((m.max_pain / a.spot - 1) * 100, 2) + " from spot" : undefined}
          hint="Expiry price at which option buyers collectively lose the most. Prices often drift toward it in the final days." />
        <Stat label="Support (put wall)" value={m.support ? num(m.support, 0) : "—"} color={PUT}
          sub={m.support_levels.slice(1).map((l) => num(l.strike, 0)).join(" · ") || undefined} />
        <Stat label="Resistance (call wall)" value={m.resistance ? num(m.resistance, 0) : "—"} color={CALL}
          sub={m.resistance_levels.slice(1).map((l) => num(l.strike, 0)).join(" · ") || undefined} />
        <Stat label="ATM IV" value={m.atm_iv != null ? `${m.atm_iv.toFixed(1)}%` : "—"} sub={`HV20 ${vol.hv20 ?? "—"}% · HV60 ${vol.hv60 ?? "—"}%`}
          hint="Implied volatility (what options price in) vs historical volatility (what the stock actually did)." />
        <Stat label="IV ÷ realised" value={ivhv != null ? `${ivhv.toFixed(2)}×` : "—"}
          color={ivhv == null ? undefined : ivhv <= 1.1 ? "#16C784" : ivhv <= 1.3 ? "#F2A93B" : "#F0526B"}
          sub={ivhv == null ? undefined : ivhv <= 0.9 ? "options cheap" : ivhv <= 1.1 ? "fair" : ivhv <= 1.3 ? "rich" : "expensive"} />
        <Stat label="Vol regime" value={vol.hv_percentile != null ? `${vol.hv_percentile.toFixed(0)}th pct` : "—"} sub="HV20 vs its past year"
          hint="High percentile = the stock is moving more than usual lately; low = unusually quiet (breakouts often follow)." />
        <Stat label="Skew" value={m.skew != null ? `${m.skew > 0 ? "+" : ""}${m.skew.toFixed(1)} pts` : "—"} sub="OTM put IV − OTM call IV"
          hint="Positive = traders pay up for downside protection (fear). Negative = chasing upside (greed)." />
        {a.kind === "INDEX" ? (
          <Stat label="India VIX" value={vol.vix != null ? vol.vix.toFixed(2) : "—"} sub={vol.vix_change_5d != null ? `${pct(vol.vix_change_5d)} in 5 sessions` : undefined}
            hint="The market's fear gauge. Rising VIX makes options pricier and usually comes with falling markets." />
        ) : (
          <Stat label="vs Nifty (20d)" value={pct(a.context.rs_vs_nifty_20d, 1)} sub="relative strength" />
        )}
        <Stat label="Implied forward" value={num(a.forward, 1)} sub={`${pct((a.forward / a.spot - 1) * 100, 2)} vs spot at expiry`}
          hint="The expiry price the market is pricing off (from put-call parity). Used so calls and puts are valued on the same basis." />
      </div>

      {live ? (
        <div className="mt-5">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-bold">{mode === "oi" ? "Open interest by strike" : "Change in OI today"}</span>
            <Segmented value={mode} onChange={setMode} options={[{ value: "oi", label: "Open interest" }, { value: "chg", label: "Change in OI" }]} />
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={bars} barGap={2} margin={{ top: 20, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgb(var(--muted) / 0.15)" vertical={false} />
              <XAxis dataKey="strike" tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} interval="preserveStartEnd" minTickGap={18}
                tickFormatter={(v) => Number(v).toLocaleString("en-IN")} />
              <YAxis tick={{ fill: "rgb(var(--muted))", fontSize: 10 }} width={56} tickFormatter={(v) => compact(Number(v))} />
              <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "rgb(var(--muted) / 0.08)" }}
                labelFormatter={(v) => `Strike ${Number(v).toLocaleString("en-IN")}`}
                formatter={(v: number, n: string) => [Number(v).toLocaleString("en-IN"), n === "CE" ? "Calls (CE)" : "Puts (PE)"]} />
              <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => (v === "CE" ? "Calls (CE) — resistance" : "Puts (PE) — support")} />
              <ReferenceLine y={0} stroke="rgb(var(--muted) / 0.5)" />
              <ReferenceLine x={m.atm_strike} stroke="rgb(var(--muted) / 0.8)" strokeDasharray="4 4"
                label={{ value: `Spot ${num(a.spot, 0)}`, fill: "rgb(var(--muted))", fontSize: 10, position: "top" }} />
              <Bar dataKey="CE" fill={CALL} radius={[4, 4, 0, 0]} maxBarSize={14} />
              <Bar dataKey="PE" fill={PUT} radius={[4, 4, 0, 0]} maxBarSize={14} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="mt-4 rounded-xl p-3 text-[12px] text-muted" style={{ background: "rgb(var(--muted) / 0.08)" }}>
          Open-interest data needs the live NSE chain. Prices shown are modeled, so OI walls, PCR and max pain are unavailable.
        </p>
      )}

      <button onClick={() => setOpen(!open)} className="mt-4 flex items-center gap-1.5 text-[12px] font-bold text-muted transition hover:text-ink"
        aria-expanded={open}>
        <ChevronDown size={14} className={open ? "rotate-180 transition" : "transition"} /> {open ? "Hide" : "Show"} full option chain ({a.chain.length} strikes)
      </button>
      {open && (
        <div className="mt-3 overflow-x-auto">
          <table className="num w-full min-w-[760px] text-right text-[11.5px]">
            <thead>
              <tr className="eyebrow text-[9px]">
                <th colSpan={6} className="pb-1 text-center" style={{ color: CALL }}>Calls (CE)</th>
                <th />
                <th colSpan={6} className="pb-1 text-center" style={{ color: PUT }}>Puts (PE)</th>
              </tr>
              <tr className="eyebrow text-[9px]">
                {["OI", "ΔOI", "Volume", "IV", "Delta", "LTP"].map((h) => <th key={"c" + h} className="px-1.5 pb-2 font-normal">{h}</th>)}
                <th className="px-2 pb-2 text-center font-normal">Strike</th>
                {["LTP", "Delta", "IV", "Volume", "ΔOI", "OI"].map((h) => <th key={"p" + h} className="px-1.5 pb-2 font-normal">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {a.chain.map((r) => {
                const atm = r.strike === m.atm_strike;
                const ceItm = r.strike < a.spot, peItm = r.strike > a.spot;
                const cell = (itm: boolean) => ({ background: itm ? "rgb(var(--muted) / 0.08)" : undefined });
                return (
                  <tr key={r.strike} className="border-t" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                    {[r.ce && compact(r.ce.oi), r.ce && compact(r.ce.chg_oi), r.ce && compact(r.ce.volume), r.ce && `${r.ce.iv.toFixed(1)}`,
                      r.ce && r.ce.delta.toFixed(2), r.ce && inr(r.ce.ltp)].map((v, i) =>
                      <td key={"c" + i} className="px-1.5 py-1.5" style={cell(ceItm)}>{v ?? "—"}</td>)}
                    <td className="px-2 text-center font-bold" style={atm ? { background: "rgb(91 141 239 / 0.18)" } : undefined}>
                      {r.strike.toLocaleString("en-IN")}
                    </td>
                    {[r.pe && inr(r.pe.ltp), r.pe && r.pe.delta.toFixed(2), r.pe && `${r.pe.iv.toFixed(1)}`, r.pe && compact(r.pe.volume),
                      r.pe && compact(r.pe.chg_oi), r.pe && compact(r.pe.oi)].map((v, i) =>
                      <td key={"p" + i} className="px-1.5 py-1.5" style={cell(peItm)}>{v ?? "—"}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-muted">Shaded cells are in the money. ATM strike highlighted.</p>
        </div>
      )}
    </Panel>
  );
}
