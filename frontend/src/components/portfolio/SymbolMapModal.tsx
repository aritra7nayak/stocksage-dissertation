import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, Link2, Sparkles } from "lucide-react";
import { getUnmappedSuggestions, applySymbols, getCatalogStatus, refreshCatalog, searchCatalog, type UnmappedStock } from "../../api/trades";
import { Database } from "lucide-react";

/** Bulk price-symbol mapper. Each unmapped stock shows up to 10 ranked
    candidates (initials + fuzzy against ticker and company name).
    Near-certain matches come pre-selected; ambiguous ones (RELII could be
    Reliance Infra, not Reliance Industries) are left for the user. A free-
    text box accepts any Yahoo symbol for stocks outside the universe. */
export default function SymbolMapModal({ onClose, onApplied }: {
  onClose: () => void; onApplied: (msg: string) => void;
}) {
  const [items, setItems] = useState<UnmappedStock[] | null>(null);
  const [choice, setChoice] = useState<Record<number, string>>({});   // stock_id → symbol | "" | "__free__"
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [catalogCount, setCatalogCount] = useState<number | null>(null);
  const [loadingCat, setLoadingCat] = useState(false);
  const [catHits, setCatHits] = useState<Record<number, { symbol: string; company: string }[]>>({});

  useEffect(() => {
    getCatalogStatus().then((s) => setCatalogCount(s.count)).catch(() => {});
    getUnmappedSuggestions()
      .then((u) => {
        setItems(u);
        const pre: Record<number, string> = {};
        for (const s of u) if (s.preselect) pre[s.stock_id] = s.preselect;
        setChoice(pre);
      })
      .catch(() => setErr("Couldn't load suggestions."));
  }, []);

  const chosenCount = Object.entries(choice).filter(([id, v]) =>
    v && (v !== "__free__" || (freeText[Number(id)] || "").trim())).length;

  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const mappings = Object.entries(choice)
        .map(([id, v]) => ({
          stock_id: Number(id),
          symbol: v === "__free__" ? (freeText[Number(id)] || "").trim() : v,
        }))
        .filter((m) => m.symbol);
      const r = await applySymbols(mappings);
      onApplied(r.status);
      onClose();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || "Apply failed.");
    } finally { setBusy(false); }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center p-4"
        style={{ background: "rgb(0 0 0 / 0.62)", backdropFilter: "blur(6px)" }} onClick={onClose}>
        <motion.div initial={{ scale: 0.94, y: 24, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="glass w-full max-w-2xl overflow-hidden rounded-2xl"
          onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b px-5 py-4"
            style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
            <div className="flex items-center gap-2">
              <Link2 size={18} className="text-brand" />
              <h3 className="font-display text-lg font-bold">Map price symbols</h3>
              {items && <span className="num text-[12px] text-muted">({items.length} unmapped)</span>}
            </div>
            <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg"
              style={{ background: "rgb(var(--muted) / 0.1)" }}>
              <X size={17} className="text-muted" />
            </button>
          </div>

          <div className="max-h-[68vh] overflow-y-auto p-4">
            {!items && !err && <p className="p-4 text-sm text-muted">Finding best matches…</p>}
            {err && <p className="p-2 text-sm text-sell">{err}</p>}
            {items && items.length === 0 && (
              <p className="p-4 text-sm text-muted">Everything already has a price symbol. ✓</p>
            )}

            {items && items.length > 0 && (
              <>
                {catalogCount !== null && catalogCount < 500 && (
                  <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5"
                    style={{ background: "rgb(91 141 239 / 0.08)" }}>
                    <Database size={14} className="text-brand" />
                    <span className="text-[12px] text-muted">
                      {catalogCount <= 0
                        ? "Only the 206-stock engine universe is loaded — many of your stocks won't be found."
                        : `Catalog has ${catalogCount} entries.`}
                      {" "}Load the full NSE list (~2,000+ companies) for complete mapping.
                    </span>
                    <button disabled={loadingCat}
                      onClick={async () => {
                        setLoadingCat(true); setErr(null);
                        try {
                          const r = await refreshCatalog();
                          setCatalogCount(r.loaded);
                          const u = await getUnmappedSuggestions();   // re-rank with full catalog
                          setItems(u);
                          const pre: Record<number, string> = {};
                          for (const s of u) if (s.preselect) pre[s.stock_id] = s.preselect;
                          setChoice((old) => ({ ...pre, ...old }));
                        } catch (e: any) {
                          setErr(e?.response?.data?.detail || "Download failed — NSE may be rate-limiting; try again.");
                        } finally { setLoadingCat(false); }
                      }}
                      className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-60"
                      style={{ background: "#5B8DEF" }}>
                      {loadingCat ? "Downloading…" : "Load full NSE list"}
                    </button>
                  </div>
                )}
                <p className="mb-3 flex items-center gap-1.5 text-[12px] text-muted">
                  <Sparkles size={13} className="text-hold" />
                  Near-certain matches are pre-selected. Ambiguous ones are left blank on purpose —
                  a look-alike ticker can be a different company. Leave blank to skip.
                </p>
                <div className="flex flex-col gap-2">
                  {items.map((s) => (
                    <div key={s.stock_id} className="flex flex-wrap items-center gap-2 rounded-xl px-3.5 py-2.5"
                      style={{ background: "rgb(var(--muted) / 0.06)" }}>
                      <span className="num w-24 shrink-0 text-sm font-bold">{s.name}</span>
                      <select
                        value={choice[s.stock_id] ?? ""}
                        onChange={(e) => setChoice({ ...choice, [s.stock_id]: e.target.value })}
                        className="min-w-0 flex-1 rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                        style={{ background: "rgb(var(--muted) / 0.12)", color: "rgb(var(--ink))" }}>
                        <option style={{ color: "#16161f", background: "#ffffff" }} value="">— skip / no match —</option>
                        {s.candidates.map((c) => (
                          <option style={{ color: "#16161f", background: "#ffffff" }} key={c.symbol} value={c.symbol}>
                            {c.symbol.replace(".NS", "")} · {c.company} ({Math.round(c.score * 100)}%)
                          </option>
                        ))}
                        <option style={{ color: "#16161f", background: "#ffffff" }} value="__free__">✏️ Type a symbol…</option>
                      </select>
                      {choice[s.stock_id] === "__free__" && (
                        <div className="relative w-56">
                          <input value={freeText[s.stock_id] || ""}
                            onChange={async (e) => {
                              const v = e.target.value;
                              setFreeText({ ...freeText, [s.stock_id]: v });
                              if (v.trim().length >= 2) {
                                try { setCatHits({ ...catHits, [s.stock_id]: await searchCatalog(v) }); }
                                catch { /* quiet */ }
                              } else setCatHits({ ...catHits, [s.stock_id]: [] });
                            }}
                            placeholder="Search full NSE list…"
                            className="num w-full rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                            style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(91 141 239 / 0.4)" }} />
                          {(catHits[s.stock_id] || []).length > 0 && (
                            <div className="glass absolute left-0 right-0 top-full z-20 mt-1 max-h-44 overflow-y-auto rounded-lg p-1"
                              style={{ boxShadow: "0 10px 30px rgb(0 0 0 / 0.4)" }}>
                              {(catHits[s.stock_id] || []).map((h) => (
                                <button key={h.symbol} type="button"
                                  onClick={() => {
                                    setFreeText({ ...freeText, [s.stock_id]: h.symbol.replace(".NS", "") });
                                    setCatHits({ ...catHits, [s.stock_id]: [] });
                                  }}
                                  className="block w-full rounded-md px-2.5 py-1.5 text-left text-[11px] transition hover:scale-[1.01]"
                                  style={{ background: "transparent" }}>
                                  <span className="num font-bold">{h.symbol.replace(".NS", "")}</span>
                                  <span className="ml-1.5 text-muted">{h.company}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {items && items.length > 0 && (
            <div className="border-t px-5 py-4" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
              <button onClick={apply} disabled={busy || chosenCount === 0}
                className="w-full rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
                {busy ? "Applying…" : `Apply ${chosenCount} mapping${chosenCount === 1 ? "" : "s"}`}
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body);
}
