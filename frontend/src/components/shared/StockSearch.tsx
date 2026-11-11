import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Search, TrendingUp } from "lucide-react";
import { searchStocks, type SearchHit } from "../../api/client";

/** Command-palette style stock search. Debounced, keyboard-navigable,
    ⌘K / Ctrl+K to focus. Click or Enter → deep-dive page. */
export default function StockSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | null>(null);

  // ⌘K / Ctrl+K focuses the search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close when clicking outside
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const runSearch = useCallback((term: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (term.trim().length < 2) { setHits([]); setOpen(false); return; }
    timer.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchStocks(term);
        setHits(r); setActive(0); setOpen(true);
      } catch { /* backend briefly busy — stay quiet */ }
      finally { setSearching(false); }
    }, 220);
  }, []);

  const go = (h: SearchHit) => {
    setOpen(false); setQ("");
    nav(`/stock/${h.symbol}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
    if (e.key === "Enter") { e.preventDefault(); go(hits[active]); }
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative w-full max-w-sm">
      <div className="glass flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 transition focus-within:scale-[1.02]"
        style={{ boxShadow: open ? "0 0 22px rgb(91 141 239 / 0.25)" : undefined }}>
        <Search size={16} className="shrink-0 text-muted" />
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => { setQ(e.target.value); runSearch(e.target.value); }}
          onFocus={() => q.trim().length >= 2 && hits.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search any stock…"
          className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
        />
        <kbd className="num hidden shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted sm:block"
          style={{ background: "rgb(var(--muted) / 0.12)" }}>⌘K</kbd>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.15 }}
            className="glass absolute left-0 right-0 top-full z-40 mt-2 overflow-hidden rounded-xl p-1.5"
            style={{ boxShadow: "0 18px 50px rgb(0 0 0 / 0.35)" }}
          >
            {hits.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted">
                {searching ? "Searching…" : "No matches in the universe."}
              </div>
            ) : hits.map((h, i) => (
              <button key={h.symbol}
                onMouseEnter={() => setActive(i)}
                onClick={() => go(h)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left transition"
                style={{ background: i === active ? "rgb(91 141 239 / 0.14)" : "transparent" }}>
                <div className="flex items-center gap-2.5">
                  <TrendingUp size={14} className="text-brand" />
                  <div>
                    <div className="num text-sm font-bold">{h.symbol.replace(".NS", "")}</div>
                    <div className="text-[11px] text-muted">{h.name}</div>
                  </div>
                </div>
                <span className="num rounded-md px-1.5 py-0.5 text-[10px] text-muted"
                  style={{ background: "rgb(var(--muted) / 0.1)" }}>{h.sector || h.segment}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
