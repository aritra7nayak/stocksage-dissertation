import { useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, GitMerge, Link2 } from "lucide-react";
import {
  previewImport, commitImport,
  type ImportPreview, type CommitReport,
} from "../../api/trades";

const OPT = { color: "#16161f", background: "#ffffff" } as const;

/** v3 import: upload → pick sheet (portfolios come from the Head column
    automatically; rows with a blank Head get assigned here) → report.
    Rendered via portal so it centers on the SCREEN, not the page. */
export default function ImportModal({ onClose, onImported }: {
  onClose: () => void; onImported: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [blankChoice, setBlankChoice] = useState<string>("");     // "", pf id, or "__new__"
  const [blankNew, setBlankNew] = useState("");
  const [report, setReport] = useState<CommitReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true); setErr(null);
    try {
      const p = await previewImport(file);
      setPreview(p);
      setSheet(p.default_sheet);
    } catch (e: any) {
      setErr(e?.response?.data?.detail || "Couldn't read that file.");
    } finally { setBusy(false); }
  };

  const sel = preview?.sheets.find((s) => s.name === sheet);
  const needsBlank = (sel?.blank_head_count || 0) > 0;
  const blankReady = !needsBlank || (blankChoice === "__new__" ? blankNew.trim().length > 0 : blankChoice !== "");

  const commit = async () => {
    if (!preview || !sel) return;
    setBusy(true); setErr(null);
    try {
      const blank_head = !needsBlank ? undefined :
        blankChoice === "__new__" ? { new_name: blankNew.trim() } :
        { portfolio_id: Number(blankChoice) };
      const r = await commitImport(preview.token, sheet, blank_head);
      setReport(r);
      onImported();
    } catch (e: any) {
      setErr(e?.response?.data?.detail || "Import failed.");
      if (e?.response?.status === 410) setPreview(null);
    } finally { setBusy(false); }
  };

  return createPortal(
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center p-4"
        style={{ background: "rgb(0 0 0 / 0.62)", backdropFilter: "blur(6px)" }}
        onClick={onClose}>
        <motion.div initial={{ scale: 0.94, y: 24, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 24, opacity: 0 }}
          transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="glass w-full max-w-xl overflow-hidden rounded-2xl"
          onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center justify-between border-b px-5 py-4"
            style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
            <div className="flex items-center gap-2">
              <FileSpreadsheet size={18} className="text-buy" />
              <h3 className="font-display text-lg font-bold">
                {report ? "Import complete" : preview ? "Confirm import" : "Import trades from Excel"}
              </h3>
            </div>
            <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg"
              style={{ background: "rgb(var(--muted) / 0.1)" }}>
              <X size={17} className="text-muted" />
            </button>
          </div>

          <div className="max-h-[72vh] overflow-y-auto p-5">
            {/* ── Stage 1: file ── */}
            {!preview && !report && (
              <>
                <p className="text-sm text-muted">
                  Upload your trade Excel. Portfolios are read from the <b>Head</b> column
                  automatically. Re-uploads never duplicate — only new rows land.
                </p>
                <input ref={inputRef} type="file" accept=".xlsx,.xlsm" className="hidden"
                  onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
                <button onClick={() => inputRef.current?.click()} disabled={busy}
                  className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-10 text-sm transition hover:scale-[1.01] disabled:opacity-60"
                  style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                  <Upload size={18} className={busy ? "animate-bounce" : ""} />
                  {busy ? "Reading file…" : "Choose .xlsx file"}
                </button>
                {err && <p className="mt-3 text-sm text-sell">{err}</p>}
              </>
            )}

            {/* ── Stage 2: sheet + blank-Head assignment ── */}
            {preview && !report && (
              <div className="flex flex-col gap-4">
                <div>
                  <div className="eyebrow mb-2">Which sheet?</div>
                  <div className="flex flex-col gap-2">
                    {preview.sheets.map((s) => (
                      <button key={s.name} onClick={() => { setSheet(s.name); setBlankChoice(""); }}
                        className="flex items-center justify-between rounded-xl px-4 py-3 text-left transition"
                        style={{ background: sheet === s.name ? "rgb(91 141 239 / 0.14)" : "rgb(var(--muted) / 0.06)",
                                 border: sheet === s.name ? "1px solid rgb(91 141 239 / 0.5)" : "1px solid transparent" }}>
                        <span className="num font-bold">{s.name}</span>
                        <span className="num text-[12px] text-muted">
                          {s.buys} buys · {s.sells} sells
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {sel && (
                  <div className="rounded-xl p-4" style={{ background: "rgb(var(--muted) / 0.06)" }}>
                    <div className="eyebrow mb-2">Portfolios found in the Head column</div>
                    <div className="flex flex-wrap gap-2">
                      {Object.entries(sel.heads).map(([name, n]) => {
                        const exists = preview.portfolios.some(
                          (p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
                        return (
                          <span key={name} className="num rounded-lg px-2.5 py-1 text-[12px]"
                            style={{ background: exists ? "rgb(var(--muted) / 0.1)" : "rgb(22 199 132 / 0.12)",
                                     color: exists ? "rgb(var(--ink))" : "#16C784" }}>
                            {name} · {n} rows{exists ? "" : " (new)"}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {needsBlank && sel && (
                  <div className="rounded-xl p-4" style={{ background: "rgb(242 169 59 / 0.08)" }}>
                    <div className="eyebrow mb-1.5 flex items-center gap-1.5 text-hold">
                      <AlertTriangle size={13} /> {sel.blank_head_count} row{sel.blank_head_count === 1 ? "" : "s"} with empty Head
                    </div>
                    <p className="mb-2 text-[12px] text-muted">
                      Which portfolio do these belong to? (Tip: fill Head on sold rows too —
                      my export always writes it for you.)
                    </p>
                    <div className="flex items-center gap-2">
                      <select value={blankChoice}
                        onChange={(e) => setBlankChoice(e.target.value)}
                        className="flex-1 rounded-lg px-2.5 py-2 text-[13px] outline-none"
                        style={{ background: "rgb(var(--muted) / 0.12)", color: "rgb(var(--ink))" }}>
                        <option style={OPT} value="">— choose portfolio —</option>
                        {preview.portfolios.map((p) => (
                          <option style={OPT} key={p.id} value={p.id}>{p.name}</option>
                        ))}
                        {Object.keys(sel.heads)
                          .filter((h) => !preview.portfolios.some(
                            (p) => p.name.trim().toLowerCase() === h.trim().toLowerCase()))
                          .map((h) => (
                            <option style={OPT} key={`h-${h}`} value="__new__" disabled>
                              (new from file: {h} — pick after import)
                            </option>
                          ))}
                        <option style={OPT} value="__new__">➕ Create new portfolio…</option>
                      </select>
                      {blankChoice === "__new__" && (
                        <input autoFocus value={blankNew} onChange={(e) => setBlankNew(e.target.value)}
                          placeholder="New portfolio name"
                          className="flex-1 rounded-lg px-2.5 py-2 text-[13px] outline-none"
                          style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(91 141 239 / 0.4)" }} />
                      )}
                    </div>
                  </div>
                )}

                {err && <p className="text-sm text-sell">{err}</p>}
                <button onClick={commit} disabled={busy || !sel || !blankReady}
                  className="rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"
                  style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
                  {busy ? "Importing…" : blankReady ? `Import '${sheet}'` : "Assign the blank-Head rows first"}
                </button>
              </div>
            )}

            {/* ── Stage 3: report ── */}
            {report && (
              <div className="flex flex-col gap-4">
                {report.portfolios.map((s) => (
                  <div key={s.portfolio} className="flex items-center justify-between rounded-xl px-3.5 py-3"
                    style={{ background: "rgb(var(--muted) / 0.06)" }}>
                    <span className="text-sm font-bold">
                      {s.portfolio}
                      {report.portfolios_created.includes(s.portfolio) && (
                        <span className="ml-1.5 text-[10px] text-buy">new</span>
                      )}
                    </span>
                    <span className="num text-[12px]">
                      <span className="font-bold text-buy">+{s.new_buys} buys</span>
                      {" · "}<span className="font-bold text-cyan">+{s.new_sells} sells</span>
                      {" · "}<span className="text-muted">{s.duplicates_skipped} dupes skipped</span>
                    </span>
                  </div>
                ))}

                {report.symbols_resolved.length > 0 && (
                  <div>
                    <div className="eyebrow mb-1.5 flex items-center gap-1.5">
                      <CheckCircle2 size={13} className="text-buy" /> Auto-mapped from company names ({report.symbols_resolved.length})
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {report.symbols_resolved.slice(0, 24).map((s) => (
                        <span key={s.name} className="num rounded px-2 py-0.5 text-[11px] text-buy"
                          style={{ background: "rgb(22 199 132 / 0.1)" }}>
                          {s.name} → {s.symbol.replace(".NS", "")}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {report.unmapped_count > 0 && (
                  <div className="flex items-center gap-2 rounded-xl px-3.5 py-3"
                    style={{ background: "rgb(91 141 239 / 0.08)" }}>
                    <Link2 size={14} className="text-brand" />
                    <span className="text-[12px] text-muted">
                      {report.unmapped_count} stock{report.unmapped_count === 1 ? "" : "s"} still need a price
                      symbol — use "Map symbols now" on the portfolio page.
                    </span>
                  </div>
                )}

                {report.merge_suggestions.length > 0 && (
                  <div className="rounded-xl p-3.5" style={{ background: "rgb(242 169 59 / 0.08)" }}>
                    <div className="eyebrow mb-2 flex items-center gap-1.5 text-hold">
                      <GitMerge size={13} /> Possible duplicate names — review
                    </div>
                    {report.merge_suggestions.map((m, i) => (
                      <p key={i} className="py-0.5 text-[12px]">
                        <span className="num font-bold">{m.name}</span>
                        <span className="text-muted"> looks like </span>
                        <span className="num font-bold">{m.similar_to}</span>
                        <span className="num text-muted"> ({Math.round(m.confidence * 100)}%)</span>
                      </p>
                    ))}
                  </div>
                )}

                {report.oversell_warnings.length > 0 && (
                  <div className="rounded-xl p-3.5" style={{ background: "rgb(240 82 107 / 0.07)" }}>
                    <div className="eyebrow mb-1.5 flex items-center gap-1.5 text-sell">
                      <AlertTriangle size={13} /> Lot mismatches
                    </div>
                    {report.oversell_warnings.map((w, i) => (
                      <p key={i} className="py-0.5 text-[11px] text-muted">{w}</p>
                    ))}
                  </div>
                )}

                {report.skipped_total > 0 && (
                  <details className="rounded-xl p-3.5" style={{ background: "rgb(var(--muted) / 0.06)" }}>
                    <summary className="cursor-pointer text-[12px] text-muted">
                      {report.skipped_total} rows skipped — view reasons
                    </summary>
                    <div className="mt-2 max-h-40 overflow-y-auto">
                      {report.skipped_rows.map((u, i) => (
                        <p key={i} className="py-0.5 text-[11px] text-muted">
                          R{u.row} · <span className="num">{String(u.name).slice(0, 24)}</span> — {u.reason}
                        </p>
                      ))}
                    </div>
                  </details>
                )}

                <button onClick={onClose}
                  className="rounded-xl px-4 py-2.5 text-sm font-bold text-white"
                  style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
                  Done — view portfolio
                </button>
              </div>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body);
}
