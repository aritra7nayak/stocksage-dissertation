import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, Plus, TrendingDown } from "lucide-react";
import { addTrade, sellGeneric, suggestStocks, type HoldingRow, type StockSuggestion, type Portfolio } from "../../api/trades";

function Shell({ title, icon, onClose, children }: any) {
  return createPortal(
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 grid place-items-center p-4"
        style={{ background: "rgb(0 0 0 / 0.62)", backdropFilter: "blur(6px)" }} onClick={onClose}>
        <motion.div initial={{ scale: 0.94, y: 20, opacity: 0 }} animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 20, opacity: 0 }} transition={{ type: "spring", stiffness: 280, damping: 26 }}
          className="glass w-full max-w-sm rounded-2xl p-6" onClick={(e: any) => e.stopPropagation()}>
          <div className="mb-4 flex items-center justify-between">
            <h3 className="flex items-center gap-2 font-display text-lg font-bold">{icon}{title}</h3>
            <button onClick={onClose}><X size={18} className="text-muted" /></button>
          </div>
          {children}
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body);
}

export function Field({ label, value, onChange, type = "text", placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="eyebrow mb-1 block">{label}</span>
      <input type={type} value={value} placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="num w-full rounded-lg px-3 py-2 text-sm outline-none"
        style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(var(--line) / var(--line-a))" }} />
    </label>
  );
}

/** Debounced stock autocomplete: fires after 2 chars, ~200ms debounce.
    Your own portfolio names come first (keeps naming consistent); NSE
    universe results auto-map the price symbol when picked. */
function StockNameField({ value, onChange, onPick }: {
  value: string; onChange: (v: string) => void;
  onPick: (s: StockSuggestion) => void;
}) {
  const [hits, setHits] = useState<StockSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const timer = useRef<number | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, []);

  const search = (term: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    if (term.trim().length < 2) { setHits([]); setOpen(false); return; }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await suggestStocks(term);
        setHits(r); setActive(0); setOpen(r.length > 0);
      } catch { /* quiet */ }
    }, 200);
  };

  const pick = (s: StockSuggestion) => { onPick(s); setOpen(false); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % hits.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + hits.length) % hits.length); }
    if (e.key === "Enter") { e.preventDefault(); pick(hits[active]); }
    if (e.key === "Escape") setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <label className="block">
        <span className="eyebrow mb-1 block">Stock (name or symbol — 2+ letters)</span>
        <input value={value} autoFocus
          onChange={(e) => { onChange(e.target.value); search(e.target.value); }}
          onKeyDown={onKeyDown}
          onFocus={() => hits.length > 0 && value.trim().length >= 2 && setOpen(true)}
          placeholder="e.g. NM… → NMDC"
          className="num w-full rounded-lg px-3 py-2 text-sm outline-none"
          style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(var(--line) / var(--line-a))" }} />
      </label>
      {open && (
        <div className="glass absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl p-1"
          style={{ boxShadow: "0 14px 40px rgb(0 0 0 / 0.35)" }}>
          {hits.map((s, i) => (
            <button key={`${s.source}-${s.name}`} type="button"
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(s)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition"
              style={{ background: i === active ? "rgb(91 141 239 / 0.14)" : "transparent" }}>
              <div>
                <span className="num text-sm font-bold">{s.name}</span>
                {s.company && <span className="ml-2 text-[11px] text-muted">{s.company}</span>}
              </div>
              <span className="num rounded px-1.5 py-0.5 text-[9px] font-bold"
                style={{ color: s.source === "portfolio" ? "#16C784" : "#5B8DEF",
                         background: "rgb(var(--muted) / 0.1)" }}>
                {s.source === "portfolio" ? "YOURS" : "NSE"}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Manual BUY — a first-class trade, appears in export too. */
export function AddTradeModal({ portfolios, defaultPortfolio, onClose, onDone }: {
  portfolios: Portfolio[]; defaultPortfolio: number | null;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const [f, setF] = useState({ name: "", qty: "", price: "", date: "", brokerage: "" });
  const [pickedSymbol, setPickedSymbol] = useState<string | null>(null);
  const [pfId, setPfId] = useState<number | "">(defaultPortfolio ?? (portfolios.length === 1 ? portfolios[0].id : ""));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const qty = parseFloat(f.qty), price = parseFloat(f.price);
    if (!f.name.trim() || !qty || qty <= 0 || !price || price <= 0) {
      setErr("Need stock name, quantity and price."); return;
    }
    if (portfolios.length > 1 && !pfId) { setErr("Pick a portfolio."); return; }
    setBusy(true); setErr(null);
    try {
      const r = await addTrade({ name: f.name.trim(), qty, price,
        date: f.date || undefined, brokerage: f.brokerage ? parseFloat(f.brokerage) : undefined,
        symbol: pickedSymbol || undefined,
        portfolio_id: pfId ? Number(pfId) : undefined });
      onDone(r.status); onClose();
    } catch (e: any) { setErr(e?.response?.data?.detail || "Add failed"); }
    finally { setBusy(false); }
  };

  return (
    <Shell title="Add trade (buy)" icon={<Plus size={17} className="text-buy" />} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <StockNameField value={f.name}
          onChange={(v) => { setF({ ...f, name: v }); setPickedSymbol(null); }}
          onPick={(s) => { setF({ ...f, name: s.name }); setPickedSymbol(s.symbol); }} />
        {pickedSymbol && (
          <p className="text-[11px] text-buy">Price symbol {pickedSymbol.replace(".NS", "")} will be linked automatically.</p>
        )}
        {portfolios.length > 1 && (
          <label className="block">
            <span className="eyebrow mb-1 block">Portfolio</span>
            <select value={pfId} onChange={(e) => setPfId(e.target.value ? Number(e.target.value) : "")}
              className="w-full rounded-lg px-3 py-2 text-sm outline-none"
              style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(var(--line) / var(--line-a))", color: "rgb(var(--ink))" }}>
              <option style={{ color: "#16161f", background: "#ffffff" }} value="">Choose portfolio…</option>
              {portfolios.map((p) => <option style={{ color: "#16161f", background: "#ffffff" }} key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Quantity" type="number" value={f.qty} onChange={(v) => setF({ ...f, qty: v })} />
          <Field label="Price (₹)" type="number" value={f.price} onChange={(v) => setF({ ...f, price: v })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date (optional)" type="date" value={f.date} onChange={(v) => setF({ ...f, date: v })} />
          <Field label="Brokerage ₹ (optional)" type="number" value={f.brokerage} onChange={(v) => setF({ ...f, brokerage: v })} />
        </div>
        {err && <p className="text-sm text-sell">{err}</p>}
        <button onClick={submit} disabled={busy}
          className="mt-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          style={{ background: "linear-gradient(135deg,#16C784,#22C5E0)" }}>
          {busy ? "Adding…" : "Add to portfolio"}
        </button>
      </div>
    </Shell>
  );
}

/** Generic sell: pick stock, qty + price → FIFO across open lots. */
export function SellModal({ holdings, preselect, onClose, onDone }: {
  holdings: HoldingRow[]; preselect?: HoldingRow | null;
  onClose: () => void; onDone: (msg: string) => void;
}) {
  const rowKey = (h: HoldingRow) => `${h.portfolio_id ?? 0}:${h.stock_id}`;
  const [selKey, setSelKey] = useState<string>(preselect ? rowKey(preselect) : "");
  const [f, setF] = useState({ qty: "", price: "", date: "" });
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sellable = holdings.filter((h) => h.held_qty > 0);
  const sel = sellable.find((h) => rowKey(h) === selKey);

  const submit = async () => {
    const qty = parseFloat(f.qty), price = parseFloat(f.price);
    if (!sel || !qty || qty <= 0 || !price || price <= 0) {
      setErr("Pick a stock and enter quantity + price."); return;
    }
    setBusy(true); setErr(null);
    try {
      const r = await sellGeneric({ stock_id: sel.stock_id, portfolio_id: sel.portfolio_id ?? 0,
        qty, price, date: f.date || undefined });
      onDone(r.status); onClose();
    } catch (e: any) { setErr(e?.response?.data?.detail || "Sell failed"); }
    finally { setBusy(false); }
  };

  return (
    <Shell title="Sell shares" icon={<TrendingDown size={17} className="text-sell" />} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <label className="block">
          <span className="eyebrow mb-1 block">Stock</span>
          <select value={selKey} onChange={(e) => setSelKey(e.target.value)}
            className="w-full rounded-lg px-3 py-2 text-sm outline-none"
            style={{ background: "rgb(var(--muted) / 0.12)", border: "1px solid rgb(var(--line) / var(--line-a))", color: "rgb(var(--ink))" }}>
            <option style={{ color: "#16161f", background: "#ffffff" }} value="">Choose…</option>
            {sellable.map((h) => (
              <option style={{ color: "#16161f", background: "#ffffff" }} key={rowKey(h)} value={rowKey(h)}>
                {h.name}{h.portfolio_name ? ` [${h.portfolio_name}]` : ""} — {h.held_qty} held
              </option>
            ))}
          </select>
        </label>
        {sel && (
          <p className="text-[11px] text-muted">
            Holding {sel.held_qty} across {sel.lots_open} open lot{sel.lots_open === 1 ? "" : "s"} —
            sells draw from the oldest lots first (FIFO).
          </p>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Quantity${sel ? ` (max ${sel.held_qty})` : ""}`} type="number"
            value={f.qty} onChange={(v) => setF({ ...f, qty: v })} />
          <Field label="Sell price (₹)" type="number" value={f.price} onChange={(v) => setF({ ...f, price: v })} />
        </div>
        <Field label="Date (optional, default today)" type="date" value={f.date} onChange={(v) => setF({ ...f, date: v })} />
        {err && <p className="text-sm text-sell">{err}</p>}
        <button onClick={submit} disabled={busy}
          className="mt-1 rounded-xl px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
          style={{ background: "linear-gradient(135deg,#F0526B,#F2A93B)" }}>
          {busy ? "Selling…" : "Confirm sell"}
        </button>
      </div>
    </Shell>
  );
}
