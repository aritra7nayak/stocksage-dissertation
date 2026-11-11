import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Check, X, ChevronDown, ShoppingCart, CheckCircle2 } from "lucide-react";
import {
  getDailyBrief, getTodaySuggestions, executeBuy,
  type DailyBrief, type TodaySuggestion,
} from "../api/client";
import { LoadingOrb, TiltCard, ErrorState } from "../components/shared/ui";

const ALL_RULES = ["R11", "R12", "R12s", "R10", "DUP", "R6", "R8", "R3", "R1", "R9"];
const RULE_LABEL: Record<string, string> = {
  R11: "Nifty guard", R12: "Market news", R12s: "Sector news", R10: "Sector health",
  DUP: "Not duplicate", R6: "Purchase band", R8: "Daily limit", R3: "Bucket fit",
  R1: "Cash reserve", R9: "Diversification",
};

export default function SuggestionsPage() {
  const nav = useNavigate();
  const [brief, setBrief] = useState<DailyBrief | null>(null);
  const [today, setToday] = useState<TodaySuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [b, t] = await Promise.all([getDailyBrief(), getTodaySuggestions().catch(() => [])]);
      setBrief(b); setToday(t);
    } catch { setError("Couldn't load suggestions. Is the backend running on port 8000?"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  // map symbol -> today's logged BUY suggestion (carries the DB id + acted flag)
  const buyId = (symbol: string) => today.find((t) => t.symbol === symbol && t.action === "BUY");

  const doBuy = async (symbol: string) => {
    const sug = buyId(symbol);
    if (!sug) { flash("This suggestion isn't in today's log yet — run the engine first.", false); return; }
    setBusy(sug.id);
    try { const r = await executeBuy(sug.id); flash(r.status || "Bought"); await load(); }
    catch (e: any) { flash(e?.response?.data?.detail || "Buy failed", false); }
    finally { setBusy(null); }
  };

  if (loading) return <LoadingOrb label="Loading suggestions…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!brief) return null;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="eyebrow mb-2">Decision Engine · {brief.date}</div>
      <h1 className="mb-8 font-display text-4xl font-extrabold tracking-tight">Suggestions</h1>

      <h2 className="mb-3 font-display text-lg font-bold text-buy">Buy ({brief.buy_suggestions.length})</h2>
      <div className="mb-8 flex flex-col gap-3">
        {brief.buy_suggestions.length === 0 && (
          <div className="glass rounded-2xl p-6 text-sm text-muted">No buys clear all rules right now.</div>
        )}
        {brief.buy_suggestions.map((s) => {
          const sug = buyId(s.symbol);
          const done = sug?.was_acted_on;
          return (
            <TiltCard key={s.symbol} className="rounded-2xl p-5" glow="glow-buy" max={5}>
              <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-3">
                  <button onClick={() => nav(`/stock/${s.symbol}`)} className="font-display text-xl font-bold transition hover:text-cyan">{s.symbol.replace(".NS", "")}</button>
                  <span className="text-sm text-muted">{s.name}</span>
                </div>
                <div className="num text-lg font-bold text-buy">
                  {s.quantity} × ₹{s.price.toLocaleString("en-IN")} = ₹{s.total_value.toLocaleString("en-IN")}
                </div>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {ALL_RULES.map((r) => {
                  const passed = s.rules_passed.includes(r);
                  return (
                    <span key={r} className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px]"
                      style={{ background: passed ? "rgb(22 199 132 / 0.12)" : "rgb(240 82 107 / 0.12)", color: passed ? "#16C784" : "#F0526B" }}>
                      {passed ? <Check size={11} /> : <X size={11} />}{RULE_LABEL[r] || r}
                    </span>
                  );
                })}
              </div>
              <div className="mt-4 flex items-center justify-between">
                <button onClick={() => setOpen(open === s.symbol ? null : s.symbol)} className="flex items-center gap-1 text-sm text-brand">
                  Why this? <ChevronDown size={14} className={open === s.symbol ? "rotate-180 transition" : "transition"} />
                </button>
                {done ? (
                  <span className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-buy" style={{ background: "rgb(22 199 132 / 0.14)" }}>
                    <CheckCircle2 size={15} /> Done
                  </span>
                ) : (
                  <button onClick={() => doBuy(s.symbol)} disabled={busy === sug?.id || !sug}
                    className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-bold text-bg transition hover:scale-105 disabled:opacity-50"
                    style={{ background: "linear-gradient(135deg,#16C784,#22C5E0)" }}>
                    <ShoppingCart size={15} /> {busy === sug?.id ? "Buying…" : "Mark as Done"}
                  </button>
                )}
              </div>
              <AnimatePresence>
                {open === s.symbol && (
                  <motion.ul initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                    {s.reasons.map((r, i) => <li key={i} className="mt-2 flex gap-2 text-sm text-muted"><span className="text-brand">›</span> {r}</li>)}
                  </motion.ul>
                )}
              </AnimatePresence>
            </TiltCard>
          );
        })}
      </div>

      {brief.sell_alerts.length > 0 && (
        <>
          <h2 className="mb-3 font-display text-lg font-bold text-sell">Sell Alerts ({brief.sell_alerts.length})</h2>
          <div className="mb-8 flex flex-col gap-3">
            {brief.sell_alerts.map((a) => (
              <div key={a.symbol} className="glass glow-sell rounded-2xl p-5">
                <div className="flex items-center justify-between">
                  <span className="font-display text-lg font-bold">{a.symbol.replace(".NS", "")}</span>
                  <span className="num rounded-md px-2 py-0.5 text-[11px] font-bold text-sell" style={{ background: "rgb(240 82 107 / 0.14)" }}>{a.rule} · {a.urgency}</span>
                </div>
                <p className="mt-2 text-sm text-muted">{a.reason}</p>
                <p className="mt-2 text-[11px] text-muted">Sell from the Portfolio page.</p>
              </div>
            ))}
          </div>
        </>
      )}

      <h2 className="mb-3 font-display text-lg font-bold text-muted">Considered but skipped ({brief.skipped.length})</h2>
      <div className="flex flex-col gap-2">
        {brief.skipped.map((s) => (
          <div key={s.symbol} className="glass flex items-center justify-between rounded-xl px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="num font-bold">{s.symbol.replace(".NS", "")}</span>
              <span className="rounded-md px-2 py-0.5 num text-[11px] font-bold text-sell" style={{ background: "rgb(240 82 107 / 0.12)" }}>{s.killed_by}</span>
            </div>
            <span className="max-w-md text-right text-xs text-muted">{s.reason}</span>
          </div>
        ))}
      </div>

      <AnimatePresence>
        {toast && (
          <motion.div initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
            className="fixed right-6 top-6 z-40 glass rounded-xl px-4 py-3 text-sm"
            style={{ borderColor: toast.ok ? "rgb(22 199 132 / 0.4)" : "rgb(240 82 107 / 0.4)" }}>
            <span style={{ color: toast.ok ? "#16C784" : "#F0526B" }}>{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
