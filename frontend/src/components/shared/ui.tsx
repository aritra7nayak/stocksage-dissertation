import {
  motion, useMotionValue, useTransform, animate, useSpring, MotionValue,
} from "framer-motion";
import { useEffect, useRef, ReactNode } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../../lib/theme";

/* ── 3D tilt card — tracks the cursor and rotates in perspective ─────────── */
export function TiltCard({
  children, className = "", glow = "", max = 9,
}: { children: ReactNode; className?: string; glow?: string; max?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [max, -max]), { stiffness: 220, damping: 18 });
  const ry = useSpring(useTransform(px, [0, 1], [-max, max]), { stiffness: 220, damping: 18 });

  const onMove = (e: React.MouseEvent) => {
    const r = ref.current!.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  };
  const reset = () => { px.set(0.5); py.set(0.5); };

  return (
    <div className="scene">
      <motion.div
        ref={ref}
        onMouseMove={onMove}
        onMouseLeave={reset}
        style={{ rotateX: rx, rotateY: ry }}
        className={`preserve-3d glass ${glow} ${className}`}
        whileHover={{ scale: 1.015 }}
        transition={{ type: "spring", stiffness: 300, damping: 25 }}
      >
        <div style={{ transform: "translateZ(40px)" }} className="preserve-3d">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

/* ── Count-up number ──────────────────────────────────────────────────────
   Renders an em-dash for a missing/non-finite value. An API can legitimately
   return null (nothing priced yet); animate() throws on one, and an uncaught
   throw here takes the whole app down with it. */
export function AnimatedNumber({
  value, decimals = 0, prefix = "", suffix = "", className = "", style = {},
}: {
  value: number | null | undefined; decimals?: number; prefix?: string; suffix?: string;
  className?: string; style?: React.CSSProperties;
}) {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : null;
  const mv = useMotionValue(0);
  const text = useTransform(mv, (v) =>
    prefix + v.toLocaleString("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + suffix);
  useEffect(() => {
    if (safe === null) return;
    const c = animate(mv, safe, { duration: 1.2, ease: [0.16, 1, 0.3, 1] });
    return () => c.stop();
  }, [safe]);
  if (safe === null) return <span className={`${className} text-muted`} style={style}>—</span>;
  return <motion.span className={className} style={style}>{text}</motion.span>;
}

/* ── Theme toggle (cycles system → light → dark) ──────────────────────────*/
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const next = { system: "light", light: "dark", dark: "system" } as const;
  const Icon = mode === "dark" ? Moon : mode === "light" ? Sun : Monitor;
  return (
    <button
      onClick={() => setMode(next[mode])}
      className="glass grid h-10 w-10 place-items-center rounded-xl transition hover:scale-105"
      title={`Theme: ${mode}`}
    >
      <motion.span key={mode} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }}>
        <Icon size={18} />
      </motion.span>
    </button>
  );
}

export function GoStatusPill({ status }: { status: "GREEN" | "AMBER" | "RED" }) {
  const map = {
    GREEN: { c: "#16C784", label: "CLEAR TO INVEST", glow: "glow-buy" },
    AMBER: { c: "#F2A93B", label: "PROCEED WITH CAUTION", glow: "glow-hold" },
    RED: { c: "#F0526B", label: "BUYING PAUSED", glow: "glow-sell" },
  }[status];
  return (
    <div className={`glass ${map.glow} inline-flex items-center gap-2.5 rounded-full px-4 py-2`}>
      <span className="pulse-dot inline-block h-2.5 w-2.5 rounded-full" style={{ background: map.c }} />
      <span className="num text-[12px] font-bold tracking-widest" style={{ color: map.c }}>{map.label}</span>
    </div>
  );
}

export function ScoreBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full" style={{ background: "rgb(var(--muted) / 0.18)" }}>
      <motion.div className="h-full rounded-full" style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        transition={{ duration: 1, ease: "easeOut" }} />
    </div>
  );
}

export function LoadingOrb({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-5 py-24">
      <div className="relative h-16 w-16">
        <motion.span className="absolute inset-0 rounded-full border-2 border-brand/30 border-t-brand"
          animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }} />
        <motion.span className="absolute inset-2 rounded-full border-2 border-buy/20 border-b-buy"
          animate={{ rotate: -360 }} transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }} />
      </div>
      <p className="eyebrow">{label}</p>
    </div>
  );
}

/* Placeholder for one value still in flight — used where the rest of the row
   is already real, so a full-page spinner would be a lie. */
export function Shimmer({ w = "3.5rem", h = "0.85rem" }: { w?: string; h?: string }) {
  return (
    <span className="sheen inline-block rounded align-middle"
      style={{ width: w, height: h, background: "rgb(var(--muted) / 0.16)" }} />
  );
}

/* Graceful failure state with retry — used by pages that fetch on mount */
export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="glass mx-auto mt-20 max-w-md rounded-2xl p-8 text-center">
      <p className="text-sell">{message}</p>
      <button onClick={onRetry}
        className="mt-4 rounded-lg border px-4 py-2 text-sm transition hover:scale-105"
        style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
        Try again
      </button>
    </div>
  );
}
