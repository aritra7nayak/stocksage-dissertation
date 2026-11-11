import { useCallback, useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Save, RotateCcw, Check, AlertTriangle, Zap } from "lucide-react";
import {
  getSettings, updateSettings, applyPreset, resetSettings,
  type SettingItem,
} from "../api/client";
import { LoadingOrb, ErrorState, TiltCard } from "../components/shared/ui";

const PCT_KEYS = new Set([
  "cash_reserve_pct", "gold_silver_pct", "nifty50_pct", "nifty_next100_pct", "smallcap_pct",
  "max_daily_invest_pct", "stop_loss_pct", "deterioration_score", "trailing_profit_trigger",
  "trailing_profit_giveback", "nifty_fall_threshold",
]);

const GROUP_ORDER = ["Capital", "Allocation", "Purchase bands", "Limits", "Sell rules", "Guards"];

export default function SettingsPage() {
  const [items, setItems] = useState<SettingItem[]>([]);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await getSettings();
      setItems(data.settings);
      setDraft(Object.fromEntries(data.settings.map((s) => [s.key, s.value])));
    } catch { setError("Couldn't load settings. Is the backend running on port 8000?"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  // Display helper: pct keys shown as %, others as raw
  const toDisplay = (k: string, v: number) => (PCT_KEYS.has(k) ? +(v * 100).toFixed(2) : v);
  const fromDisplay = (k: string, v: number) => (PCT_KEYS.has(k) ? v / 100 : v);

  const allocSum = ["cash_reserve_pct", "gold_silver_pct", "nifty50_pct", "nifty_next100_pct", "smallcap_pct"]
    .reduce((a, k) => a + (draft[k] ?? 0), 0);
  const allocOk = Math.abs(allocSum - 1) < 1e-6;

  const dirty = items.some((s) => draft[s.key] !== s.value);

  const save = async () => {
    if (!allocOk) { flash(`Allocation must total 100% (now ${(allocSum * 100).toFixed(1)}%)`, false); return; }
    setSaving(true);
    const changed = Object.fromEntries(items.filter((s) => draft[s.key] !== s.value).map((s) => [s.key, draft[s.key]]));
    try { await updateSettings(changed); await load(); flash("Settings saved — takes effect next engine run."); }
    catch (e: any) { flash(e?.response?.data?.detail || "Save failed", false); }
    finally { setSaving(false); }
  };

  const promote = async (preset: string) => {
    try { await applyPreset(preset); await load(); flash(`${preset[0].toUpperCase() + preset.slice(1)} preset promoted to live rules.`); }
    catch { flash("Couldn't apply preset", false); }
  };

  const doReset = async () => {
    try { await resetSettings(); await load(); flash("Reset to defaults."); }
    catch { flash("Reset failed", false); }
  };

  if (loading) return <LoadingOrb label="Loading settings…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const groups = GROUP_ORDER.map((g) => ({ group: g, items: items.filter((s) => s.group === g) })).filter((g) => g.items.length);

  return (
    <div className="mx-auto max-w-5xl pb-24">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Configuration</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Settings</h1>
        </div>
        <button onClick={doReset} className="glass flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition hover:scale-105">
          <RotateCcw size={15} /> Reset to defaults
        </button>
      </div>

      {/* Preset promotion */}
      <TiltCard className="mt-6 rounded-2xl p-5" max={3}>
        <div className="flex items-center gap-2">
          <Zap size={16} className="text-brand" />
          <div className="eyebrow">Promote a backtest preset to live rules</div>
        </div>
        <p className="mt-1 text-sm text-muted">Sets stop-loss and cash-reserve to a tested profile in one click.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {[
            { k: "conservative", label: "Conservative", d: "−8% / 20%" },
            { k: "medium", label: "Medium", d: "−10% / 15%" },
            { k: "aggressive", label: "Aggressive", d: "−12% / 10%" },
          ].map((p) => (
            <button key={p.k} onClick={() => promote(p.k)}
              className="glass rounded-xl px-4 py-2.5 text-sm transition hover:scale-105">
              <span className="font-bold">{p.label}</span> <span className="num text-muted ml-1">{p.d}</span>
            </button>
          ))}
        </div>
      </TiltCard>

      {/* Allocation health banner */}
      <motion.div layout className="glass mt-6 flex items-center justify-between rounded-2xl p-4"
        style={{ borderColor: allocOk ? "rgb(22 199 132 / 0.3)" : "rgb(242 169 59 / 0.4)" }}>
        <div className="flex items-center gap-2 text-sm">
          {allocOk ? <Check size={16} className="text-buy" /> : <AlertTriangle size={16} className="text-hold" />}
          <span>Allocation buckets total</span>
          <span className="num font-bold" style={{ color: allocOk ? "#16C784" : "#F2A93B" }}>{(allocSum * 100).toFixed(1)}%</span>
        </div>
        {!allocOk && <span className="text-xs text-hold">Must equal 100% to save</span>}
      </motion.div>

      {/* Grouped fields */}
      <div className="mt-6 grid gap-6 md:grid-cols-2">
        {groups.map((g) => (
          <TiltCard key={g.group} className="rounded-2xl p-5" max={3}>
            <div className="eyebrow mb-4">{g.group}</div>
            <div className="flex flex-col gap-3">
              {g.items.map((s) => (
                <div key={s.key} className="flex items-center justify-between gap-3">
                  <label className="text-sm">{s.label.replace(" %", "").replace(" (₹)", "")}
                    {s.is_overridden && <span className="ml-1.5 text-[10px] text-brand">●</span>}
                  </label>
                  <div className="flex items-center gap-1">
                    <input type="number" step={PCT_KEYS.has(s.key) ? 0.5 : s.type === "int" ? 1 : 100}
                      value={toDisplay(s.key, draft[s.key] ?? s.value)}
                      onChange={(e) => setDraft({ ...draft, [s.key]: fromDisplay(s.key, parseFloat(e.target.value) || 0) })}
                      className="num w-28 rounded-lg px-2.5 py-1.5 text-right text-sm outline-none"
                      style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(var(--line) / var(--line-a))" }} />
                    <span className="w-4 text-xs text-muted">{PCT_KEYS.has(s.key) ? "%" : s.label.includes("₹") ? "₹" : ""}</span>
                  </div>
                </div>
              ))}
            </div>
          </TiltCard>
        ))}
      </div>

      {/* Sticky save bar */}
      <AnimatePresence>
        {dirty && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }}
            className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2">
            <div className="glass glow-brand flex items-center gap-4 rounded-2xl px-5 py-3">
              <span className="text-sm text-muted">Unsaved changes</span>
              <button onClick={save} disabled={saving || !allocOk}
                className="flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold text-bg disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
                <Save size={15} /> {saving ? "Saving…" : "Save changes"}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Toast */}
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
