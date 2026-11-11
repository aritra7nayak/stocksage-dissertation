import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, ArrowUpRight, ArrowDownRight } from "lucide-react";
import { getSectorStocks, type SectorStock } from "../../api/client";

/** Popup shown when a sector tile is clicked: every active stock in the
    sector with latest price + day change, sorted best→worst. Row click →
    deep-dive. Prices come from one batched fetch (a few seconds). */
export default function SectorModal({ sector, onClose }: { sector: string; onClose: () => void }) {
  const nav = useNavigate();
  const [stocks, setStocks] = useState<SectorStock[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setStocks(null); setError(null);
    getSectorStocks(sector)
      .then((s) => { if (alive) setStocks(s); })
      .catch(() => { if (alive) setError("Couldn't fetch sector prices — try again in a moment."); });
    return () => { alive = false; };
  }, [sector]);

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center p-4"
        style={{ background: "rgb(0 0 0 / 0.62)", backdropFilter: "blur(6px)" }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.94, y: 24, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="glass w-full max-w-lg overflow-hidden rounded-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b px-5 py-4"
            style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
            <div>
              <div className="eyebrow">Sector</div>
              <h3 className="font-display text-xl font-bold">{sector}</h3>
            </div>
            <button onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-lg transition hover:scale-110"
              style={{ background: "rgb(var(--muted) / 0.1)" }}>
              <X size={17} className="text-muted" />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {error && <div className="px-4 py-6 text-center text-sm text-sell">{error}</div>}

            {!stocks && !error && (
              <div className="flex flex-col gap-2 p-2">
                {[...Array(6)].map((_, i) => (
                  <motion.div key={i} className="h-12 rounded-xl"
                    style={{ background: "rgb(var(--muted) / 0.08)" }}
                    animate={{ opacity: [0.4, 0.8, 0.4] }}
                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.08 }} />
                ))}
              </div>
            )}

            {stocks && stocks.length === 0 && (
              <div className="px-4 py-6 text-center text-sm text-muted">No price data right now.</div>
            )}

            {stocks && stocks.map((s, i) => {
              const up = (s.change_pct ?? 0) >= 0;
              return (
                <motion.button key={s.symbol}
                  initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: Math.min(i * 0.03, 0.4) }}
                  onClick={() => { onClose(); nav(`/stock/${s.symbol}`); }}
                  className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-left transition hover:scale-[1.015]"
                  style={{ background: i % 2 ? "transparent" : "rgb(var(--muted) / 0.05)" }}>
                  <div>
                    <div className="num text-sm font-bold">{s.symbol.replace(".NS", "")}</div>
                    <div className="text-[11px] text-muted">{s.name} · {s.segment}</div>
                  </div>
                  <div className="text-right">
                    <div className="num text-sm font-bold">₹{(s.price ?? 0).toLocaleString("en-IN")}</div>
                    <div className="num flex items-center justify-end gap-0.5 text-[12px] font-bold"
                      style={{ color: up ? "#16C784" : "#F0526B" }}>
                      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                      {up ? "+" : ""}{(s.change_pct ?? 0).toFixed(2)}%
                    </div>
                  </div>
                </motion.button>
              );
            })}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
