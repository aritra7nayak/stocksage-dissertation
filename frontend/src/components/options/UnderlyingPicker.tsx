import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { getUnderlyings, type Underlying } from "../../api/options";

let cached: { indices: Underlying[]; stocks: Underlying[] } | null = null;
const RECENT_KEY = "ss-opt-recent";

function readRecent(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]").slice(0, 5); } catch { return []; }
}

export default function UnderlyingPicker({ value, onPick }: { value: string; onPick: (s: string) => void }) {
  const [list, setList] = useState(cached);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(readRecent);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cached) getUnderlyings().then((d) => { cached = d; setList(d); }).catch(() => {});
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const hits = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (!list || t.length < 1) return [];
    return [...list.indices, ...list.stocks]
      .filter((u) => u.symbol.includes(t) || u.name.toUpperCase().includes(t))
      .sort((x, y) => Number(!x.symbol.startsWith(t)) - Number(!y.symbol.startsWith(t)))
      .slice(0, 8);
  }, [q, list]);

  const pick = (s: string) => {
    setQ(""); setOpen(false); onPick(s);
    const next = [s, ...recent.filter((r) => r !== s)].slice(0, 5);
    setRecent(next);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(next)); } catch { /* ignore */ }
  };

  const chips = Array.from(new Set(["NIFTY", "BANKNIFTY", ...recent]));
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((s) => (
        <button key={s} onClick={() => pick(s)}
          className={`rounded-xl px-3 py-2 text-xs font-bold transition hover:scale-105 ${s === value ? "glow-brand" : ""}`}
          style={{ background: s === value ? "rgb(91 141 239 / 0.16)" : "rgb(var(--muted) / 0.1)" }}>
          {s}
        </button>
      ))}
      <div ref={box} className="relative">
        <div className="glass flex items-center gap-2 rounded-xl px-3 py-2">
          <Search size={14} className="text-muted" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
            onKeyDown={(e) => { if (e.key === "Enter" && hits[0]) pick(hits[0].symbol); if (e.key === "Escape") setOpen(false); }}
            placeholder={list ? `Search ${list.stocks.length} F&O stocks…` : "Search F&O stocks…"}
            aria-label="Search F&O underlyings" className="w-48 bg-transparent text-sm outline-none placeholder:text-muted" />
        </div>
        {open && hits.length > 0 && (
          <div className="glass absolute left-0 z-30 mt-2 w-80 overflow-hidden rounded-xl p-1.5" role="listbox">
            {hits.map((h) => (
              <button key={h.symbol} role="option" aria-selected={false} onClick={() => pick(h.symbol)}
                className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition hover:bg-[rgb(var(--muted)/0.12)]">
                <span className="min-w-0">
                  <span className="block text-sm font-bold">{h.symbol}</span>
                  <span className="block truncate text-[11px] text-muted">{h.name}</span>
                </span>
                <span className="num shrink-0 text-[10.5px] text-muted">lot {h.lot}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
