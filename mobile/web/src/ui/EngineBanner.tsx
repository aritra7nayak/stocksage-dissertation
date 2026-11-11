/** Live progress of an engine run, under the top bar — the phone's equivalent of watching the server log. */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { api } from "@app/api/client";

interface Status { running: boolean; stage: string; fraction: number }

export default function EngineBanner() {
  const [st, setSt] = useState<Status | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await api.get<Status>("/api/engine/status");
        if (alive) setSt(r.data);
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 700);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <AnimatePresence>
      {st?.running && (
        <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
          className="overflow-hidden">
          <div className="flex items-center justify-between px-4 pb-1.5 text-[11px]">
            <span className="num truncate text-muted">{st.stage}</span>
            <span className="num shrink-0 pl-2 font-bold text-brand">{Math.round(st.fraction * 100)}%</span>
          </div>
          <div className="h-[3px] w-full" style={{ background: "rgb(var(--muted) / 0.15)" }}>
            <motion.div className="h-full" style={{ background: "linear-gradient(90deg,#5B8DEF,#16C784)" }}
              animate={{ width: `${Math.max(3, st.fraction * 100)}%` }} transition={{ ease: "easeOut", duration: 0.5 }} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
