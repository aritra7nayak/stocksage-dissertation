import { motion } from "framer-motion";
import type { SectorHealth } from "../../api/client";

function fill(score: number): string {
  if (score >= 60) return `rgb(22 199 132 / ${0.1 + Math.min(1, (score - 60) / 40) * 0.2})`;
  if (score >= 40) return `rgb(242 169 59 / ${0.1 + ((score - 40) / 20) * 0.16})`;
  return `rgb(240 82 107 / ${0.1 + Math.min(1, (40 - score) / 40) * 0.2})`;
}
const edge = (s: number) => (s >= 60 ? "#16C784" : s >= 40 ? "#F2A93B" : "#F0526B");

export default function SectorHeatmap({ sectors, onSelect }: { sectors: SectorHealth[]; onSelect?: (sector: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {sectors.map((s, i) => (
        <motion.div key={s.sector}
          className="glass relative overflow-hidden rounded-2xl p-4"
          initial={{ opacity: 0, scale: 0.85, rotateX: -20 }}
          animate={{ opacity: 1, scale: 1, rotateX: 0 }}
          transition={{ delay: i * 0.05, type: "spring", stiffness: 180 }}
          whileHover={{ scale: 1.05, y: -3 }}
          onClick={() => onSelect?.(s.sector)}
          style={{ background: fill(s.score ?? 0), cursor: onSelect ? "pointer" : "default" }}>
          <div className="flex items-start justify-between">
            <span className="text-sm font-semibold leading-tight">{s.sector}</span>
            <span className="num rounded-md px-1.5 py-0.5 text-[11px] font-bold"
              style={{ color: edge(s.score ?? 0), background: "rgb(0 0 0 / 0.18)" }}>{(s.score ?? 0).toFixed(0)}</span>
          </div>
          <div className="num mt-3 text-xl font-bold" style={{ color: edge(s.score) }}>
            {(s.change_pct ?? 0) >= 0 ? "+" : ""}{(s.change_pct ?? 0).toFixed(2)}%
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-muted">
            <span>{s.status}</span>
            {s.top_gainer && <span className="num truncate">{s.top_gainer.replace(".NS", "")}</span>}
          </div>
        </motion.div>
      ))}
    </div>
  );
}
