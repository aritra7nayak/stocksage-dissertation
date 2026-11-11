import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { X, ArrowUpRight, ArrowDownRight, GitMerge, Link2, TrendingDown } from "lucide-react";
import {
  getStockDetail, sellLot, mergeStocks, setStockSymbol,
  type StockDetail, type Lot, type HoldingRow,
} from "../../api/trades";
import { Field } from "./TradeModals";

const STATUS_COLOR: Record<string, string> = { OPEN: "#16C784", PARTIAL: "#F2A93B", SOLD: "rgb(var(--muted))" };

/** Drill-down: quote header, open lots first, filters, sell-a-lot inline,
    plus fix-ups (merge duplicate-name stock, map price symbol). */
export default function StockDrawer({ stockId, portfolioId, holdings, onClose, onChanged }: {
  stockId: number; portfolioId: number | null; holdings: HoldingRow[];
  onClose: () => void; onChanged: (msg?: string) => void;
}) {
  const [d, setD] = useState<StockDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [status, setStatus] = useState<"ALL" | "OPEN" | "SOLD">("ALL");
  const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [sortBy, setSortBy] = useState<"date" | "price" | "qty">("date");
  const [sellFor, setSellFor] = useState<Lot | null>(null);
  const [sellPrice, setSellPrice] = useState(""); const [sellQty, setSellQty] = useState("");
  const [tool, setTool] = useState<"none" | "merge" | "symbol">("none");
  const [mergeWith, setMergeWith] = useState<number | "">("");
  const [symInput, setSymInput] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setD(await getStockDetail(stockId, portfolioId)); setErr(null); }
    catch { setErr("Couldn't load this stock."); }
  }, [stockId, portfolioId]);
  useEffect(() => { load(); }, [load]);

  const lots = useMemo(() => {
    if (!d) return [];
    let ls = [...d.lots];
    if (status === "OPEN") ls = ls.filter((l) => l.status !== "SOLD");
    if (status === "SOLD") ls = ls.filter((l) => l.status === "SOLD");
    if (from) ls = ls.filter((l) => l.date >= from);
    if (to) ls = ls.filter((l) => l.date <= to);
    const grp = (l: Lot) => (l.status === "SOLD" ? 1 : 0);   // open/partial always first
    ls.sort((a, b) => grp(a) - grp(b) ||
      (sortBy === "price" ? a.price - b.price :
       sortBy === "qty" ? b.qty - a.qty :
       a.date < b.date ? 1 : -1));
    return ls;
  }, [d, status, from, to, sortBy]);

  const doSellLot = async () => {
    if (!sellFor) return;
    const price = parseFloat(sellPrice);
    const qty = sellQty ? parseFloat(sellQty) : undefined;
    if (!price || price <= 0) return;
    setBusy(true);
    try {
      const r = await sellLot({ lot_id: sellFor.lot_id, price, qty });
      setSellFor(null); setSellPrice(""); setSellQty("");
      await load(); onChanged(r.status);
    } catch (e: any) { setErr(e?.response?.data?.detail || "Sell failed"); }
    finally { setBusy(false); }
  };

  const doMerge = async () => {
    if (!mergeWith || !d) return;
    setBusy(true);
    try {
      const r = await mergeStocks(d.stock_id, Number(mergeWith));
      setTool("none"); await load(); onChanged(r.status);
    } catch (e: any) { setErr(e?.response?.data?.detail || "Merge failed"); }
    finally { setBusy(false); }
  };

  const doSymbol = async () => {
    if (!d) return;
    setBusy(true);
    try {
      const r = await setStockSymbol(d.stock_id, symInput.trim());
      setTool("none"); await load(); onChanged(r.status);
    } catch (e: any) { setErr(e?.response?.data?.detail || "Couldn't set symbol"); }
    finally { setBusy(false); }
  };

  const q = d?.quote;
  const up = (q?.change_pct ?? 0) >= 0;

  return createPortal(
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex justify-end"
        style={{ background: "rgb(0 0 0 / 0.55)", backdropFilter: "blur(4px)" }} onClick={onClose}>
        <motion.div initial={{ x: 560 }} animate={{ x: 0 }} exit={{ x: 560 }}
          transition={{ type: "spring", stiffness: 300, damping: 32 }}
          className="glass h-full w-full max-w-[560px] overflow-y-auto"
          style={{ borderRadius: 0 }} onClick={(e) => e.stopPropagation()}>

          {/* Header */}
          <div className="sticky top-0 z-10 border-b px-5 py-4 backdrop-blur-xl"
            style={{ borderColor: "rgb(var(--line) / var(--line-a))", background: "rgb(var(--surface) / 0.85)" }}>
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-display text-2xl font-bold">{d?.name || "…"}</h3>
                <div className="mt-0.5 flex items-center gap-2 text-[12px] text-muted">
                  {d?.symbol ? <span className="num">{d.symbol}</span> : <span>No price symbol mapped</span>}
                  <span>·</span>
                  <span className="num">{d ? `${d.held_qty} held` : ""}</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {q && (
                  <div className="text-right">
                    <div className="num text-xl font-bold">₹{(q.price ?? 0).toLocaleString("en-IN")}</div>
                    <div className="num flex items-center justify-end gap-0.5 text-[12px] font-bold"
                      style={{ color: up ? "#16C784" : "#F0526B" }}>
                      {up ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                      {up ? "+" : ""}{(q.change_pct ?? 0).toFixed(2)}% today
                    </div>
                  </div>
                )}
                <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-lg"
                  style={{ background: "rgb(var(--muted) / 0.1)" }}>
                  <X size={17} className="text-muted" />
                </button>
              </div>
            </div>

            {/* Tools row */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button onClick={() => setTool(tool === "merge" ? "none" : "merge")}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-muted transition hover:scale-105"
                style={{ background: "rgb(var(--muted) / 0.1)" }}>
                <GitMerge size={12} /> Merge into…
              </button>
              <button onClick={() => { setTool(tool === "symbol" ? "none" : "symbol"); setSymInput(d?.symbol?.replace(".NS", "") || ""); }}
                className="flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-[11px] text-muted transition hover:scale-105"
                style={{ background: "rgb(var(--muted) / 0.1)" }}>
                <Link2 size={12} /> {d?.symbol ? "Change" : "Set"} price symbol
              </button>
            </div>

            {tool === "merge" && (
              <div className="mt-2 flex items-center gap-2">
                <select value={mergeWith} onChange={(e) => setMergeWith(e.target.value ? Number(e.target.value) : "")}
                  className="flex-1 rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                  style={{ background: "rgb(var(--muted) / 0.12)", color: "rgb(var(--ink))" }}>
                  <option style={{ color: "#16161f", background: "#ffffff" }} value="">Absorb which stock into "{d?.name}"?</option>
                  {holdings.filter((h) => h.stock_id !== stockId).map((h) => (
                    <option style={{ color: "#16161f", background: "#ffffff" }} key={h.stock_id} value={h.stock_id}>{h.name}</option>
                  ))}
                </select>
                <button onClick={doMerge} disabled={busy || !mergeWith}
                  className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                  style={{ background: "#F2A93B" }}>Merge</button>
              </div>
            )}
            {tool === "symbol" && (
              <div className="mt-2 flex items-center gap-2">
                <input value={symInput} onChange={(e) => setSymInput(e.target.value)}
                  placeholder="e.g. PAYTM (→ PAYTM.NS)"
                  className="num flex-1 rounded-lg px-2.5 py-1.5 text-[12px] outline-none"
                  style={{ background: "rgb(var(--muted) / 0.12)" }} />
                <button onClick={doSymbol} disabled={busy}
                  className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-white disabled:opacity-50"
                  style={{ background: "#5B8DEF" }}>Save</button>
              </div>
            )}

            {/* Filters */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {(["ALL", "OPEN", "SOLD"] as const).map((s) => (
                <button key={s} onClick={() => setStatus(s)}
                  className="rounded-lg px-2.5 py-1 text-[11px] font-bold transition"
                  style={{ background: status === s ? "rgb(91 141 239 / 0.2)" : "rgb(var(--muted) / 0.08)",
                           color: status === s ? "#5B8DEF" : "rgb(var(--muted))" }}>{s}</button>
              ))}
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
                className="num rounded-lg px-2 py-1 text-[11px]" style={{ background: "rgb(var(--muted) / 0.1)", color: "rgb(var(--ink))" }} />
              <span className="text-[11px] text-muted">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
                className="num rounded-lg px-2 py-1 text-[11px]" style={{ background: "rgb(var(--muted) / 0.1)", color: "rgb(var(--ink))" }} />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as any)}
                className="ml-auto rounded-lg px-2 py-1 text-[11px]"
                style={{ background: "rgb(var(--muted) / 0.1)", color: "rgb(var(--ink))" }}>
                <option style={{ color: "#16161f", background: "#ffffff" }} value="date">Sort: date</option>
                <option style={{ color: "#16161f", background: "#ffffff" }} value="price">Sort: price</option>
                <option style={{ color: "#16161f", background: "#ffffff" }} value="qty">Sort: quantity</option>
              </select>
            </div>
          </div>

          {/* Lots */}
          <div className="flex flex-col gap-2 p-4">
            {err && <p className="text-sm text-sell">{err}</p>}
            {!d && !err && <p className="p-4 text-sm text-muted">Loading…</p>}

            {lots.map((l) => (
              <div key={l.lot_id} className="rounded-xl p-3.5"
                style={{ background: l.status === "SOLD" ? "rgb(var(--muted) / 0.04)" : "rgb(var(--muted) / 0.08)",
                         opacity: l.status === "SOLD" ? 0.65 : 1 }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className="num rounded px-1.5 py-0.5 text-[10px] font-bold"
                      style={{ color: STATUS_COLOR[l.status], background: "rgb(0 0 0 / 0.15)" }}>{l.status}</span>
                    <span className="num text-sm font-bold">{l.qty}</span>
                    <span className="text-[11px] text-muted">@</span>
                    <span className="num text-sm font-bold">₹{(l.price ?? 0).toLocaleString("en-IN")}</span>
                    <span className="num text-[11px] text-muted">{l.date}</span>
                    {l.source === "MANUAL" && <span className="rounded px-1 text-[9px] text-brand" style={{ background: "rgb(91 141 239 / 0.12)" }}>app</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    {l.status !== "OPEN" && l.status !== "PARTIAL" ? null : (
                      <>
                        <span className="num text-[11px] text-muted">{l.qty_remaining} left</span>
                        <button onClick={() => { setSellFor(sellFor?.lot_id === l.lot_id ? null : l); setSellQty(String(l.qty_remaining)); setSellPrice(""); }}
                          className="flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-bold text-sell transition hover:scale-105"
                          style={{ background: "rgb(240 82 107 / 0.12)" }}>
                          <TrendingDown size={11} /> Sell
                        </button>
                      </>
                    )}
                  </div>
                </div>
                {sellFor?.lot_id === l.lot_id && (
                  <div className="mt-3 flex items-end gap-2">
                    <div className="flex-1"><Field label={`Qty (max ${l.qty_remaining})`} type="number" value={sellQty} onChange={setSellQty} /></div>
                    <div className="flex-1"><Field label="Sell price ₹" type="number" value={sellPrice} onChange={setSellPrice} /></div>
                    <button onClick={doSellLot} disabled={busy || !sellPrice}
                      className="rounded-lg px-3 py-2 text-[12px] font-bold text-white disabled:opacity-50"
                      style={{ background: "linear-gradient(135deg,#F0526B,#F2A93B)" }}>
                      {busy ? "…" : "Sell this lot"}
                    </button>
                  </div>
                )}
              </div>
            ))}

            {/* Sell history */}
            {d && d.sells.length > 0 && (
              <>
                <div className="eyebrow mt-3">Sells ({d.sells.length})</div>
                {d.sells.map((s) => (
                  <div key={s.trade_id} className="flex items-center justify-between rounded-lg px-3 py-2 text-[12px]"
                    style={{ background: "rgb(240 82 107 / 0.05)" }}>
                    <span className="num text-muted">{s.date}</span>
                    <span className="num">{s.qty} @ ₹{(s.price ?? 0).toLocaleString("en-IN")}</span>
                    <span className="num font-bold">₹{(s.value ?? 0).toLocaleString("en-IN")}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body);
}
