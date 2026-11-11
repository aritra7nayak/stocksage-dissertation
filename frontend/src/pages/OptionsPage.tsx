import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { RefreshCw, TriangleAlert, Radio } from "lucide-react";
import { getOptionsAnalysis, type OptionsAnalysis, type Side } from "../api/options";
import { ErrorState, LoadingOrb } from "../components/shared/ui";
import UnderlyingPicker from "../components/options/UnderlyingPicker";
import VerdictHero from "../components/options/VerdictHero";
import { DirectionBreakdown, SuitabilityBreakdown } from "../components/options/ScoreBreakdown";
import { ChecklistPanel, ThesisPanel } from "../components/options/Thesis";
import StrikeTable from "../components/options/StrikeTable";
import TradePlan from "../components/options/TradePlan";
import ScenarioLab from "../components/options/ScenarioLab";
import ChainIntel from "../components/options/ChainIntel";
import { PriceMap, SentimentPanel, TechnicalPanel } from "../components/options/MarketPanels";
import ScannerView from "../components/options/ScannerView";
import { Segmented, inr, pct, pnlColor } from "../components/options/parts";

const LAST_KEY = "ss-opt-last";

export default function OptionsPage() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as "analyze" | "scan") || "analyze";
  const symbol = (params.get("symbol") || (() => { try { return localStorage.getItem(LAST_KEY); } catch { return null; } })() || "NIFTY").toUpperCase();
  const expiry = params.get("expiry") || undefined;

  const [a, setA] = useState<OptionsAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [side, setSide] = useState<Side>("CE");
  const [strike, setStrike] = useState<number | null>(null);
  const [lots, setLots] = useState(1);
  const [auto, setAuto] = useState(false);

  const setQuery = (next: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params);
    Object.entries(next).forEach(([k, v]) => (v ? p.set(k, v) : p.delete(k)));
    setParams(p, { replace: false });
  };

  const load = useCallback(async (soft = false) => {
    soft ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const d = await getOptionsAnalysis(symbol, expiry);
      setA((prev) => {
        // Keep the user's side/strike on a soft refresh of the same contract set
        const same = prev && prev.symbol === d.symbol && prev.expiry === d.expiry;
        if (!same) {
          setSide(d.verdict.side);
          setStrike(d.sides[d.verdict.side].strikes[0]?.strike ?? null);
          setLots(1);
        }
        return d;
      });
      try { localStorage.setItem(LAST_KEY, d.symbol); } catch { /* ignore */ }
    } catch (e: any) {
      setError(e?.response?.data?.detail || `Couldn't analyse ${symbol}. The backend may be busy or NSE unreachable.`);
    } finally { setLoading(false); setRefreshing(false); }
  }, [symbol, expiry]);

  useEffect(() => { if (tab === "analyze") load(); }, [load, tab]);

  // Optional live refresh while the market is open (NSE chain cache is 60 s)
  useEffect(() => {
    if (!auto || !a?.market_open || tab !== "analyze") return;
    const id = window.setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, [auto, a?.market_open, load, tab]);

  const plan = a?.sides[side].plan;
  const pick = useMemo(() => {
    if (!a) return null;
    const list = a.sides[side].strikes;
    return list.find((s) => s.strike === strike) || list[0] || null;
  }, [a, side, strike]);

  const changeSide = (s: Side) => { setSide(s); setStrike(a?.sides[s].strikes[0]?.strike ?? null); };

  return (
    <div className="mx-auto max-w-7xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Options desk · buying calls & puts only</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Option Buyer's Analysis</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Direction, timing, the right strike and what to realistically expect — every number explained. You decide; this is research, not advice.
          </p>
        </div>
        <Segmented value={tab} onChange={(t) => setQuery({ tab: t === "analyze" ? undefined : t })}
          options={[{ value: "analyze", label: "Analyse" }, { value: "scan", label: "Scanner" }]} />
      </div>

      {tab === "scan" ? (
        <div className="mt-6">
          <ScannerView onPick={(s) => setQuery({ tab: undefined, symbol: s, expiry: undefined })} />
        </div>
      ) : (
        <>
          {/* Toolbar */}
          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <UnderlyingPicker value={symbol} onPick={(s) => setQuery({ symbol: s, expiry: undefined })} />
            <div className="flex flex-wrap items-center gap-2">
              {a && (
                <label className="glass flex items-center gap-2 rounded-xl px-3 py-2 text-xs">
                  <span className="text-muted">Expiry</span>
                  <select value={a.expiry} onChange={(e) => setQuery({ expiry: e.target.value })}
                    className="num bg-transparent font-bold outline-none">
                    {a.expiries.map((x) => <option key={x} value={x} className="bg-surface">{x}</option>)}
                  </select>
                </label>
              )}
              {a?.market_open && (
                <button onClick={() => setAuto(!auto)} title="Re-analyse every 60 seconds"
                  className="glass flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition"
                  style={{ color: auto ? "#16C784" : undefined }}>
                  <Radio size={13} className={auto ? "animate-pulse" : ""} /> Live {auto ? "on" : "off"}
                </button>
              )}
              <button onClick={() => load(true)} disabled={loading || refreshing}
                className="glass flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-bold transition hover:scale-105 disabled:opacity-60">
                <RefreshCw size={13} className={refreshing ? "animate-spin" : ""} /> Refresh
              </button>
            </div>
          </div>

          {loading && !a ? <LoadingOrb label={`Analysing ${symbol} options…`} />
            : error && !a ? <ErrorState message={error} onRetry={() => load()} />
            : a && plan && (
              <div className={`mt-5 flex flex-col gap-5 transition ${loading ? "opacity-50" : ""}`}>
                {error && <p className="text-sm" style={{ color: "#F0526B" }}>{error}</p>}

                {/* Identity + data provenance */}
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div>
                    <div className="eyebrow mb-1">{a.kind === "INDEX" ? "Index" : a.sector || "Stock"} · lot size {a.lot_size}</div>
                    <div className="flex items-baseline gap-3">
                      <h2 className="font-display text-3xl font-extrabold tracking-tight">{a.symbol}</h2>
                      <span className="num text-2xl font-bold">{a.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
                      <span className="num text-sm font-bold" style={{ color: pnlColor(a.change_pct) }}>{pct(a.change_pct, 2)}</span>
                    </div>
                    <div className="text-sm text-muted">{a.name} · {a.days_to_expiry.toFixed(1)} days to expiry</div>
                  </div>
                  <div className="text-right text-[11px] text-muted">
                    <span className="num rounded-md px-2 py-1 font-bold"
                      style={{ color: a.source === "NSE" ? "#16C784" : "#F2A93B", background: a.source === "NSE" ? "rgb(22 199 132 / 0.12)" : "rgb(242 169 59 / 0.14)" }}>
                      {a.source === "NSE" ? "LIVE NSE CHAIN" : "MODELED PRICES"}
                    </span>
                    <div className="mt-1.5">Data as of {a.data_timestamp ?? "—"} · market {a.market_open ? "open" : "closed"}</div>
                    <div>Analysed {new Date(a.generated_at).toLocaleTimeString("en-IN")}</div>
                  </div>
                </div>

                {a.warnings.length > 0 && (
                  <div className="flex items-start gap-2.5 rounded-xl p-3 text-[12.5px]" style={{ background: "rgb(242 169 59 / 0.12)" }}>
                    <TriangleAlert size={16} className="mt-0.5 shrink-0 text-hold" />
                    <div>{a.warnings.map((w, i) => <p key={i}>{w}</p>)}</div>
                  </div>
                )}
                {!a.market_open && (
                  <p className="text-[12px] text-muted">
                    Market is closed — premiums are from the last session. Re-check prices at the open before acting; gaps change everything.
                  </p>
                )}

                <VerdictHero a={a} pick={a.verdict.side === side ? pick : a.recommended} />

                <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                  <ThesisPanel a={a} />
                  <ChecklistPanel a={a} />
                </div>

                <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.25fr_1fr]">
                  <DirectionBreakdown factors={a.direction_factors} />
                  <SuitabilityBreakdown factors={a.suitability_factors} />
                </div>

                <StrikeTable a={a} side={side} onSide={changeSide} selected={pick?.strike ?? null} onSelect={setStrike} />

                {pick && <TradePlan a={a} plan={plan} s={pick} lots={lots} onLots={setLots} />}
                {pick && <ScenarioLab key={`${a.symbol}-${a.expiry}-${pick.side}-${pick.strike}`} a={a} s={pick} plan={plan} lots={lots} />}

                <ChainIntel a={a} />

                <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[1.4fr_1fr]">
                  <PriceMap a={a} plan={plan} />
                  <SentimentPanel a={a} />
                </div>

                <TechnicalPanel a={a} />

                <div className="rounded-2xl border p-4 text-[11.5px] leading-relaxed text-muted" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                  <b className="text-ink">How to read this.</b> Probabilities and expected returns come from a model (Black-Scholes with
                  the market's own implied volatility, simulated over the holding window) — they are estimates, not promises. Option buyers
                  can lose 100% of the premium paid ({pick ? `${inr(pick.lot_cost, 0)} per lot here` : "the full premium"}). Brokerage,
                  STT and exchange charges are not included. Personal research tool — not investment advice.
                </div>
              </div>
            )}
        </>
      )}
    </div>
  );
}
