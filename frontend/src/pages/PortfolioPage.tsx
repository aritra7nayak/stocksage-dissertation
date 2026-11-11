import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Upload, Download, Plus, TrendingDown, Layers } from "lucide-react";
import {
  getTradesPortfolio, downloadTradesExcel, getPortfolios, getQuotes,
  type HoldingRow, type Portfolio, type Quote,
} from "../api/trades";
import { AnimatedNumber, LoadingOrb, TiltCard, ErrorState, Shimmer } from "../components/shared/ui";
import ImportModal from "../components/portfolio/ImportModal";
import StockDrawer from "../components/portfolio/StockDrawer";
import { AddTradeModal, SellModal } from "../components/portfolio/TradeModals";
import SymbolMapModal from "../components/portfolio/SymbolMapModal";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";

const CHUNK = 12;   // symbols per /quotes call — small enough to paint fast
const LANES = 3;    // parallel chunks in flight
const r2 = (n: number) => Math.round(n * 100) / 100;

export default function PortfolioPage() {
  const [holdings, setHoldings] = useState<HoldingRow[]>([]);
  const [portfolios, setPortfolios] = useState<Portfolio[]>([]);
  const [activePf, setActivePf] = useState<number | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [unavailable, setUnavailable] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [showSell, setShowSell] = useState<null | HoldingRow | "generic">(null);
  const [drawer, setDrawer] = useState<{ stockId: number; portfolioId: number | null } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [showSymbols, setShowSymbols] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 25;

  // Prices arrive after the table does, a chunk at a time, so a slow Yahoo
  // download never holds the whole page hostage. runId invalidates a stream
  // still in flight when the user switches portfolios or reloads.
  const runId = useRef(0);

  const applyQuotes = useCallback((quotes: Record<string, Quote>, missing: string[]) => {
    setHoldings((prev) => prev.map((h) => {
      const q = h.symbol ? quotes[h.symbol] : undefined;
      if (!q) return h;
      const mv = q.price * h.held_qty;
      return {
        ...h, current_price: q.price, day_change_pct: q.change_pct,
        market_value: r2(mv), pnl: r2(mv - h.invested),
        pnl_pct: h.avg_buy ? r2((q.price / h.avg_buy - 1) * 100) : null,
      };
    }));
    const done = [...Object.keys(quotes), ...missing];
    setPending((prev) => { const n = new Set(prev); done.forEach((s) => n.delete(s)); return n; });
    if (missing.length) setUnavailable((prev) => new Set([...prev, ...missing]));
  }, []);

  const streamQuotes = useCallback(async (symbols: string[], run: number) => {
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
    let next = 0;
    const lane = async () => {
      for (;;) {
        const batch = chunks[next++];
        if (!batch || runId.current !== run) return;
        try {
          const { quotes, missing } = await getQuotes(batch);
          if (runId.current !== run) return;
          applyQuotes(quotes, missing);
        } catch {
          if (runId.current !== run) return;
          applyQuotes({}, batch);   // a failed chunk stops shimmering, shows —
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, chunks.length) }, lane));
  }, [applyQuotes]);

  const load = useCallback(async () => {
    const run = ++runId.current;
    setError(null);
    let d;
    try {
      const [res, pfs] = await Promise.all([getTradesPortfolio(activePf), getPortfolios()]);
      if (runId.current !== run) return;
      d = res;
      setHoldings(d.holdings); setPortfolios(pfs);
      setPending(new Set(d.pending_symbols)); setUnavailable(new Set());
    } catch { setError("Couldn't load your trades. Is the backend running on port 8000?"); }
    finally { setLoading(false); }
    // Biggest positions first — holdings come back sorted by value.
    if (d) {
      const order = d.holdings.filter((h) => h.symbol && h.current_price == null)
        .map((h) => h.symbol!);
      streamQuotes([...new Set(order)], run);
    }
  }, [activePf, streamQuotes]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => () => { runId.current++; }, []);   // drop streams on unmount
  useEffect(() => { setPage(0); }, [activePf, query]);

  // Totals are derived, not fetched, so every chunk of prices that lands moves
  // the header cards with it.
  const t = useMemo(() => ({
    invested: r2(holdings.reduce((a, h) => a + h.invested, 0)),
    market_value: r2(holdings.reduce((a, h) => a + (h.market_value ?? h.invested), 0)),
    pnl: r2(holdings.reduce((a, h) => a + (h.pnl ?? 0), 0)),
    stocks: holdings.length,
    priced: holdings.filter((h) => h.current_price != null).length,
    noSymbol: holdings.filter((h) => !h.symbol).length,
  }), [holdings]);

  const flash = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 4000); };

  const doExport = async () => {
    setExporting(true);
    try { await downloadTradesExcel(); flash("Excel downloaded — same layout as your file."); }
    catch { flash("Export failed", false); }
    finally { setExporting(false); }
  };

  if (loading) return <LoadingOrb label="Loading your trades…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const q = query.trim().toLowerCase();
  const filtered = q
    ? holdings.filter((h) => h.name.toLowerCase().includes(q) ||
        (h.symbol || "").toLowerCase().includes(q))
    : holdings;
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pricing = pending.size > 0;
  const cards = [
    { l: "Invested (open)", v: t.invested, c: "rgb(var(--ink))" },
    { l: "Market Value", v: t.market_value, c: "#22C5E0", partial: pricing },
    { l: "Unrealised P&L", v: t.pnl, c: t.pnl >= 0 ? "#16C784" : "#F0526B", partial: pricing },
    { l: "Stocks Held", v: t.stocks, c: "#8B7CF6", plain: true },
  ] as { l: string; v: number; c: string; plain?: boolean; partial?: boolean }[];

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow mb-2">Your Trades · lot-based</div>
          <h1 className="font-display text-4xl font-extrabold tracking-tight">Portfolio</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn onClick={() => setShowImport(true)} icon={<Upload size={15} />} label="Import Excel" />
          <Btn onClick={doExport} icon={<Download size={15} className={exporting ? "animate-bounce" : ""} />}
            label={exporting ? "Building…" : "Export Excel"} />
          <Btn onClick={() => setShowAdd(true)} icon={<Plus size={15} />} label="Add trade" accent="#16C784" />
          <Btn onClick={() => setShowSell("generic")} icon={<TrendingDown size={15} />} label="Sell" accent="#F0526B" />
        </div>
      </div>

      {portfolios.length > 0 && (
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button onClick={() => setActivePf(null)}
            className="rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition"
            style={{ background: activePf === null ? "rgb(91 141 239 / 0.2)" : "rgb(var(--muted) / 0.08)",
                     color: activePf === null ? "#5B8DEF" : "rgb(var(--muted))" }}>
            All portfolios
          </button>
          {portfolios.map((p) => (
            <button key={p.id} onClick={() => setActivePf(p.id)}
              className="rounded-xl px-3.5 py-1.5 text-[12px] font-bold transition"
              style={{ background: activePf === p.id ? "rgb(91 141 239 / 0.2)" : "rgb(var(--muted) / 0.08)",
                       color: activePf === p.id ? "#5B8DEF" : "rgb(var(--muted))" }}>
              {p.name}
            </button>
          ))}
        </div>
      )}

      <div className="mb-6 mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((s, i) => (
          <motion.div key={s.l} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <TiltCard className="rounded-2xl p-5">
              <div className="eyebrow mb-2">{s.l}</div>
              {s.plain
                ? <div className="num text-2xl font-bold" style={{ color: s.c }}>{s.v}</div>
                : <AnimatedNumber value={s.v} prefix="₹" className="num text-2xl font-bold" style={{ color: s.c }} />}
              {s.partial && (
                <div className="mt-1.5 text-[10px] text-muted">
                  partial · unpriced stocks counted at cost
                </div>
              )}
            </TiltCard>
          </motion.div>
        ))}
      </div>

      {(pricing || t.noSymbol > 0 || unavailable.size > 0) && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          {pricing && (
            <p className="flex items-center gap-2 text-[12px] text-muted">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand pulse-dot" />
              Live prices {t.priced}/{t.stocks - t.noSymbol} — rows fill in as they arrive.
            </p>
          )}
          {!pricing && unavailable.size > 0 && (
            <p className="text-[12px] text-muted">
              No quote for {unavailable.size} symbol{unavailable.size === 1 ? "" : "s"} right now.
            </p>
          )}
          {t.noSymbol > 0 && (
            <>
              <p className="text-[12px] text-muted">
                {t.noSymbol} stock{t.noSymbol === 1 ? " has" : "s have"} no symbol mapped.
              </p>
              <button onClick={() => setShowSymbols(true)}
                className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-brand transition hover:scale-105"
                style={{ background: "rgb(91 141 239 / 0.12)" }}>
                Map symbols now →
              </button>
            </>
          )}
        </div>
      )}

      {holdings.length === 0 ? (
        <TiltCard className="rounded-3xl p-12 text-center" max={4}>
          <Layers size={40} className="mx-auto mb-4 text-brand" />
          <h2 className="font-display text-2xl font-bold">No trades yet</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-muted">
            Import your trade Excel to bring your whole history in — every buy becomes a
            trackable lot. Or add a trade manually. Re-imports never duplicate.
          </p>
          <button onClick={() => setShowImport(true)}
            className="mt-5 rounded-xl px-5 py-2.5 text-sm font-bold text-white"
            style={{ background: "linear-gradient(135deg,#5B8DEF,#16C784)" }}>
            <Upload size={14} className="mr-1.5 inline" /> Import Excel
          </button>
        </TiltCard>
      ) : (
        <>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="glass flex max-w-xs flex-1 items-center gap-2 rounded-xl px-3 py-2">
            <Search size={14} className="shrink-0 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter stocks…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted" />
          </div>
          <span className="num text-[12px] text-muted">
            {filtered.length} holding{filtered.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="glass overflow-x-auto rounded-2xl">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b text-left text-muted" style={{ borderColor: "rgb(var(--line) / var(--line-a))" }}>
                {["Stock", "Held", "Avg Buy", "Current", "P&L", "Lowest Open Lot", ""].map((h) => (
                  <th key={h} className="px-4 py-3 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paged.map((h, i) => {
                const waiting = h.current_price == null && !!h.symbol && pending.has(h.symbol);
                return (
                <motion.tr key={h.stock_id}
                  className="cursor-pointer border-b transition hover:bg-[rgb(var(--muted)/0.05)]"
                  style={{ borderColor: "rgb(var(--line) / calc(var(--line-a) * 0.6))" }}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.03, 0.5) }}
                  onClick={() => setDrawer({ stockId: h.stock_id, portfolioId: h.portfolio_id })}>
                  <td className="px-4 py-3">
                    <div className="font-bold">{h.name}</div>
                    <div className="flex items-center gap-1.5 text-[11px] text-muted">
                      <span>{h.symbol ? h.symbol.replace(".NS", "") : "no symbol"} · {h.lots_open} open lot{h.lots_open === 1 ? "" : "s"}</span>
                      {activePf === null && h.portfolio_name && (
                        <span className="rounded px-1.5 py-0.5 text-[9px] font-bold text-brand"
                          style={{ background: "rgb(91 141 239 / 0.12)" }}>{h.portfolio_name}</span>
                      )}
                    </div>
                  </td>
                  <td className="num px-4 py-3 font-bold">{h.held_qty}</td>
                  <td className="num px-4 py-3">
                    ₹{(h.avg_buy ?? 0).toLocaleString("en-IN")}
                    <div className="text-[10px] text-muted">₹{(h.avg_buy_incl_brokerage ?? 0).toLocaleString("en-IN")} w/ brokerage</div>
                  </td>
                  <td className="num px-4 py-3">
                    {h.current_price != null ? (
                      <>
                        ₹{h.current_price.toLocaleString("en-IN")}
                        <div className="text-[10px] font-bold"
                          style={{ color: (h.day_change_pct ?? 0) >= 0 ? "#16C784" : "#F0526B" }}>
                          {(h.day_change_pct ?? 0) >= 0 ? "+" : ""}{(h.day_change_pct ?? 0).toFixed(2)}% today
                        </div>
                      </>
                    ) : waiting ? (
                      <>
                        <Shimmer w="4.5rem" />
                        <div className="mt-1"><Shimmer w="3rem" h="0.6rem" /></div>
                      </>
                    ) : (
                      <span className="text-muted" title={h.symbol ? "No quote available" : "No symbol mapped"}>—</span>
                    )}
                  </td>
                  <td className="num px-4 py-3 font-bold"
                    style={{ color: (h.pnl ?? 0) >= 0 ? "#16C784" : "#F0526B" }}>
                    {h.pnl != null ? (
                      <>
                        {h.pnl >= 0 ? "+" : ""}₹{h.pnl.toLocaleString("en-IN")}
                        <div className="text-[10px]">{(h.pnl_pct ?? 0) >= 0 ? "+" : ""}{(h.pnl_pct ?? 0).toFixed(1)}%</div>
                      </>
                    ) : waiting ? (
                      <>
                        <Shimmer w="4rem" />
                        <div className="mt-1"><Shimmer w="2.5rem" h="0.6rem" /></div>
                      </>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    {h.lowest_lot ? (
                      <div className="num text-[12px]">
                        <span className="font-bold text-cyan">₹{(h.lowest_lot.price ?? 0).toLocaleString("en-IN")}</span>
                        <span className="text-muted"> × {h.lowest_lot.qty_remaining}</span>
                        <div className="text-[10px] text-muted">{h.lowest_lot.date}</div>
                      </div>
                    ) : <span className="text-muted">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <button onClick={(e) => { e.stopPropagation(); setShowSell(h); }}
                      className="rounded-lg px-3 py-1.5 text-[12px] font-bold text-sell transition hover:scale-105"
                      style={{ background: "rgb(240 82 107 / 0.12)" }}>
                      Sell
                    </button>
                  </td>
                </motion.tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className="mt-4 flex items-center justify-center gap-3">
            <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
              className="glass grid h-9 w-9 place-items-center rounded-xl transition hover:scale-110 disabled:opacity-40">
              <ChevronLeft size={16} />
            </button>
            <span className="num text-sm text-muted">Page {page + 1} of {totalPages}</span>
            <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))} disabled={page >= totalPages - 1}
              className="glass grid h-9 w-9 place-items-center rounded-xl transition hover:scale-110 disabled:opacity-40">
              <ChevronRight size={16} />
            </button>
          </div>
        )}
        </>
      )}

      {showImport && <ImportModal onClose={() => setShowImport(false)} onImported={load} />}
      {showSymbols && <SymbolMapModal onClose={() => setShowSymbols(false)} onApplied={(m) => { flash(m); load(); }} />}
      {showAdd && <AddTradeModal portfolios={portfolios} defaultPortfolio={activePf} onClose={() => setShowAdd(false)} onDone={(m) => { flash(m); load(); }} />}
      {showSell !== null && (
        <SellModal holdings={holdings} preselect={showSell === "generic" ? null : showSell}
          onClose={() => setShowSell(null)} onDone={(m) => { flash(m); load(); }} />
      )}
      {drawer !== null && (
        <StockDrawer stockId={drawer.stockId} portfolioId={drawer.portfolioId} holdings={holdings}
          onClose={() => setDrawer(null)}
          onChanged={(m) => { if (m) flash(m); load(); }} />
      )}

      <AnimatePresence>
        {toast && (
          <motion.div initial={{ y: -40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }}
            className="fixed right-6 top-6 z-[60] glass rounded-xl px-4 py-3 text-sm"
            style={{ borderColor: toast.ok ? "rgb(22 199 132 / 0.4)" : "rgb(240 82 107 / 0.4)" }}>
            <span style={{ color: toast.ok ? "#16C784" : "#F0526B" }}>{toast.msg}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Btn({ onClick, icon, label, accent }: {
  onClick: () => void; icon: any; label: string; accent?: string;
}) {
  return (
    <button onClick={onClick}
      className="glass flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition hover:scale-105"
      style={accent ? { color: accent } : undefined}>
      {icon} {label}
    </button>
  );
}
