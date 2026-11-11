import { useEffect, useState } from "react";
import { Radar, Activity } from "lucide-react";
import { getOptionsScan, type ScanRow } from "../../api/options";
import { LoadingOrb, ScoreBar } from "../shared/ui";
import { BAD, GOOD, WARN, Panel, Segmented, inr, pct, pnlColor, sideColor } from "./parts";

type Filter = "all" | "trade" | "CE" | "PE";
// Survives switching tabs; a scan takes ~10–30 s so don't throw it away.
let lastScan: { at: string; rows: ScanRow[]; errors: { symbol: string; error: string }[] } | null = null;

const actionLabel = { BUY_CALL: "BUY CALL", BUY_PUT: "BUY PUT", NO_TRADE: "NO TRADE", WAIT: "WAIT" } as const;

export default function ScannerView({ onPick }: { onPick: (symbol: string) => void }) {
  const [scan, setScan] = useState(lastScan);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const run = async () => {
    setBusy(true); setErr(null);
    try {
      const d = await getOptionsScan();
      lastScan = { at: d.generated_at, rows: d.results, errors: d.errors };
      setScan(lastScan);
    } catch { setErr("Scan failed — is the backend running?"); }
    finally { setBusy(false); }
  };

  // Opening the Scanner tab IS the request — start straight away unless a
  // scan from this session is already on screen.
  useEffect(() => { if (!lastScan) run(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rows = (scan?.rows || []).filter((r) => {
    const trade = r.verdict.action === "BUY_CALL" || r.verdict.action === "BUY_PUT";
    if (filter === "trade") return trade;
    if (filter === "CE") return trade && r.verdict.side === "CE";
    if (filter === "PE") return trade && r.verdict.side === "PE";
    return true;
  });

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Market scanner — Nifty, Bank Nifty and 18 liquid F&O stocks"
        hint="Runs the full analysis on each underlying at its default expiry and ranks the setups by trade score. Click a row to open the full analysis."
        right={
          <button onClick={run} disabled={busy}
            className="glass glow-brand flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition hover:scale-105 disabled:opacity-60">
            {busy ? <Activity size={15} className="animate-pulse" /> : <Radar size={15} />}
            {busy ? "Scanning…" : scan ? "Re-scan" : "Run scan"}
          </button>
        }>
        {!scan && !busy && <p className="text-sm text-muted">Run a scan to rank today's call and put setups. Takes 10–30 seconds.</p>}
        {busy && !scan && <LoadingOrb label="Analysing 20 underlyings…" />}
        {err && <p className="text-sm" style={{ color: BAD }}>{err}</p>}
        {scan && (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <Segmented value={filter} onChange={setFilter} options={[
                { value: "all", label: `All (${scan.rows.length})` },
                { value: "trade", label: "Tradeable" },
                { value: "CE", label: "Calls" },
                { value: "PE", label: "Puts" },
              ]} />
              <span className="text-[11px] text-muted">Scanned {new Date(scan.at).toLocaleTimeString("en-IN")}</span>
            </div>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full min-w-[980px] text-[12.5px]">
                <thead>
                  <tr className="eyebrow text-left text-[9.5px]">
                    {["Underlying", "Spot", "Verdict", "Trade score", "Direction", "Buyer fit", "Best contract", "1 lot", "If right", "No edge", "Win %", "IV÷HV", "PCR", "Expiry"]
                      .map((h) => <th key={h} className="whitespace-nowrap px-2 pb-2 font-normal">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const v = r.verdict, b = r.best;
                    const trade = v.action === "BUY_CALL" || v.action === "BUY_PUT";
                    const c = trade ? sideColor(v.side) : v.action === "WAIT" ? WARN : "rgb(var(--muted))";
                    return (
                      <tr key={r.symbol} onClick={() => onPick(r.symbol)} tabIndex={0}
                        onKeyDown={(e) => e.key === "Enter" && onPick(r.symbol)}
                        className="num cursor-pointer border-t transition hover:bg-[rgb(var(--muted)/0.08)]"
                        style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                        <td className="px-2 py-2.5">
                          <div className="font-bold" style={{ fontFamily: "Inter, sans-serif" }}>{r.symbol}</div>
                          <div className="max-w-[160px] truncate text-[10.5px] text-muted" style={{ fontFamily: "Inter, sans-serif" }}>{r.name}</div>
                        </td>
                        <td className="whitespace-nowrap px-2">{r.spot.toLocaleString("en-IN")}
                          <div className="text-[10.5px]" style={{ color: pnlColor(r.change_pct) }}>{pct(r.change_pct, 2)}</div></td>
                        <td className="whitespace-nowrap px-2">
                          <span className="rounded-md px-2 py-1 text-[10.5px] font-bold" style={{ color: c, background: trade ? `${c}1f` : "rgb(var(--muted) / 0.12)" }}>
                            {actionLabel[v.action]}{trade && ` · ${v.grade}`}
                          </span>
                        </td>
                        <td className="w-28 px-2">
                          <div className="mb-1 font-bold">{v.trade_score}</div>
                          <ScoreBar value={v.trade_score / 100} color={trade ? c : "#7C8CB2"} />
                        </td>
                        <td className="px-2 font-bold" style={{ color: v.direction >= 20 ? GOOD : v.direction <= -20 ? BAD : undefined }}>
                          {v.direction > 0 ? "+" : ""}{v.direction.toFixed(0)}</td>
                        <td className="px-2">{v.suitability.toFixed(0)}</td>
                        <td className="whitespace-nowrap px-2">{b ? <><b>{b.strike.toLocaleString("en-IN")} {b.side}</b> <span className="text-muted">@ {inr(b.entry)}</span></> : "—"}</td>
                        <td className="px-2">{b ? inr(b.lot_cost, 0) : "—"}</td>
                        <td className="px-2 font-bold" style={{ color: b ? pnlColor(b.ev_signal) : undefined }}>{b ? pct(b.ev_signal) : "—"}</td>
                        <td className="px-2" style={{ color: b ? pnlColor(b.ev_neutral) : undefined }}>{b ? pct(b.ev_neutral) : "—"}</td>
                        <td className="px-2">{b ? `${b.p_profit.toFixed(0)}%` : "—"}</td>
                        <td className="px-2">{r.iv_hv_ratio != null ? `${r.iv_hv_ratio.toFixed(2)}×` : "—"}</td>
                        <td className="px-2">{r.pcr != null ? r.pcr.toFixed(2) : "—"}</td>
                        <td className="whitespace-nowrap px-2 text-muted">{r.expiry}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rows.length === 0 && <p className="mt-3 text-sm text-muted">Nothing matches this filter.</p>}
            {scan.errors.length > 0 && (
              <p className="mt-3 text-[11px] text-muted">Skipped: {scan.errors.map((e) => `${e.symbol} (${e.error})`).join(" · ")}</p>
            )}
          </>
        )}
      </Panel>
    </div>
  );
}
