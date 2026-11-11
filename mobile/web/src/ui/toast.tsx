import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, AlertTriangle, Info } from "lucide-react";
import { create } from "zustand";

type Kind = "success" | "error" | "info";
interface Toast { id: number; text: string; kind: Kind }

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let seq = 0;

export function toast(text: string, kind: Kind = "info") {
  const id = ++seq;
  useToasts.setState((s) => ({ items: [...s.items, { id, text, kind }] }));
  setTimeout(() => useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) })), 3800);
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  return (
    <div className="pointer-events-none fixed inset-x-0 z-[80] flex flex-col items-center gap-2 px-4"
      style={{ bottom: "calc(var(--sab) + var(--tabbar) + 14px)" }}>
      <AnimatePresence>
        {items.map((t) => {
          const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? AlertTriangle : Info;
          const c = t.kind === "success" ? "#16C784" : t.kind === "error" ? "#F0526B" : "#5B8DEF";
          return (
            <motion.div key={t.id} layout
              initial={{ opacity: 0, y: 16, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.98 }} transition={{ type: "spring", stiffness: 420, damping: 32 }}
              className="bar-glass pointer-events-auto flex max-w-sm items-center gap-2.5 rounded-2xl px-4 py-3 text-sm shadow-soft">
              <Icon size={17} style={{ color: c }} className="shrink-0" />
              <span>{t.text}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
