import { ReactNode, useState } from "react";
import { motion } from "framer-motion";
import { Info } from "lucide-react";

// Series identity for calls vs puts — validated pair (CVD ΔE 27, ≥3:1 on both
// themes). Gain/loss polarity keeps the app's buy/sell colours.
export const CALL = "#5B8DEF";
export const PUT = "#C9742A";
export const GOOD = "#16C784";
export const BAD = "#F0526B";
export const WARN = "#F2A93B";
export const sideColor = (s: "CE" | "PE") => (s === "CE" ? CALL : PUT);
export const pnlColor = (v: number) => (v > 0 ? GOOD : v < 0 ? BAD : "rgb(var(--muted))");

export const inr = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—"
    : (v < 0 ? "-₹" : "₹") + Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
export const num = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v: number | null | undefined, d = 1, sign = true) =>
  v == null || !Number.isFinite(v) ? "—" : `${sign && v > 0 ? "+" : ""}${v.toFixed(d)}%`;
export const compact = (v: number | null | undefined) =>
  v == null ? "—" : Math.abs(v) >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : Math.abs(v) >= 1e5 ? `${(v / 1e5).toFixed(2)} L`
    : v.toLocaleString("en-IN");

export const tooltipStyle = {
  background: "rgb(var(--surface))", border: "1px solid rgb(var(--muted) / 0.2)",
  borderRadius: 12, color: "rgb(var(--ink))", fontSize: 12,
};

/** Hover/focus explainer for jargon. */
export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label={text} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
        className="text-muted transition hover:text-ink"><Info size={12} /></button>
      {open && (
        <span role="tooltip" className="glass absolute bottom-full left-1/2 z-30 mb-2 w-60 -translate-x-1/2 rounded-lg p-2.5 text-[11px] font-normal normal-case leading-relaxed tracking-normal text-ink"
          style={{ fontFamily: "Inter, system-ui, sans-serif" }}>{text}</span>
      )}
    </span>
  );
}

export function Panel({ title, hint, right, children, className = "" }: {
  title: string; hint?: string; right?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className={`glass rounded-2xl p-5 ${className}`}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="eyebrow flex items-center gap-1.5">{title}{hint && <Hint text={hint} />}</div>
        {right}
      </div>
      {children}
    </motion.section>
  );
}

export function Stat({ label, value, sub, hint, color }: {
  label: string; value: ReactNode; sub?: ReactNode; hint?: string; color?: string;
}) {
  return (
    <div className="rounded-xl p-3" style={{ background: "rgb(var(--muted) / 0.08)" }}>
      <div className="eyebrow flex items-center gap-1 text-[10px]">{label}{hint && <Hint text={hint} />}</div>
      <div className="num mt-1 text-base font-bold" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

/** −1…+1 bar growing left (bearish) or right (bullish) from a centre line. */
export function DivergingBar({ value, muted = false }: { value: number; muted?: boolean }) {
  const v = Math.max(-1, Math.min(1, value));
  const color = muted ? "rgb(var(--muted) / 0.4)" : v >= 0 ? GOOD : BAD;
  return (
    <div className="relative h-2 w-full rounded-full" style={{ background: "rgb(var(--muted) / 0.14)" }}>
      <div className="absolute left-1/2 top-[-3px] h-[14px] w-px" style={{ background: "rgb(var(--muted) / 0.5)" }} />
      <motion.div className="absolute top-0 h-full rounded-full" style={{ background: color, [v >= 0 ? "left" : "right"]: "50%" }}
        initial={{ width: 0 }} animate={{ width: `${Math.abs(v) * 50}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
    </div>
  );
}

/** 0…1 bar for "how good is this for a buyer". */
export function FitBar({ value }: { value: number }) {
  const v = Math.max(0, Math.min(1, value));
  const color = v >= 0.7 ? GOOD : v >= 0.45 ? WARN : BAD;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.14)" }}>
      <motion.div className="h-full rounded-full" style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${v * 100}%` }} transition={{ duration: 0.8, ease: "easeOut" }} />
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: ReactNode; color?: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-xl p-1" style={{ background: "rgb(var(--muted) / 0.1)" }} role="tablist">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button key={o.value} role="tab" aria-selected={on} onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-xs font-bold transition ${on ? "text-ink" : "text-muted hover:text-ink"}`}
            style={on ? { background: "rgb(var(--surface))", boxShadow: o.color ? `inset 0 -2px 0 ${o.color}` : undefined } : undefined}>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
