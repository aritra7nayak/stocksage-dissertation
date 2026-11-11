import { api } from "./client";

// ── Core types ──────────────────────────────────────────────────────────────
export interface LowestLot { lot_id: number; price: number; qty_remaining: number; date: string; }
export interface HoldingRow {
  stock_id: number; name: string; symbol: string | null;
  portfolio_id: number | null; portfolio_name: string | null;
  held_qty: number; avg_buy: number; avg_buy_incl_brokerage: number;
  invested: number; current_price: number | null; day_change_pct: number | null;
  market_value: number | null; pnl: number | null; pnl_pct: number | null;
  lots_open: number; total_lots: number; lowest_lot: LowestLot | null;
}
export interface PortfolioTotals {
  invested: number; market_value: number; pnl: number;
  stocks: number; priced: number; unpriceable: number;
}
export interface Quote { price: number; change_pct: number; }

export interface Lot {
  lot_id: number; date: string; qty: number; price: number; gross: number;
  cost: number | null; brokerage: number | null; qty_remaining: number;
  status: "OPEN" | "PARTIAL" | "SOLD"; source: string;
}
export interface SellRow {
  trade_id: number; date: string; qty: number; price: number; value: number;
  target_lot_id: number | null; source: string;
}
export interface StockDetail {
  stock_id: number; name: string; symbol: string | null;
  quote: { price: number; change_pct: number } | null;
  lots: Lot[]; sells: SellRow[]; held_qty: number;
}
export interface Portfolio { id: number; name: string; last_section?: number | null; trades?: number; }

// ── Portfolio + detail ──────────────────────────────────────────────────────
export const getPortfolios = () =>
  api.get<{ portfolios: Portfolio[] }>("/api/trades/portfolios").then((r) => r.data.portfolios);

/** Cache-only by default: returns instantly, with pending_symbols left for
 *  getQuotes() to fill in a chunk at a time. */
export const getTradesPortfolio = (portfolioId?: number | null) =>
  api.get<{ holdings: HoldingRow[]; totals: PortfolioTotals; pending_symbols: string[] }>(
    `/api/trades/portfolio${portfolioId ? `?portfolio_id=${portfolioId}` : ""}`).then((r) => r.data);

/** Live prices for one small batch of symbols (backend caps at 40). */
export const getQuotes = (symbols: string[]) =>
  api.get<{ quotes: Record<string, Quote>; missing: string[] }>(
    `/api/trades/quotes?symbols=${encodeURIComponent(symbols.join(","))}`,
    { timeout: 120_000 }).then((r) => r.data);

export const getStockDetail = (id: number, portfolioId?: number | null) =>
  api.get<StockDetail>(`/api/trades/stock/${id}${portfolioId ? `?portfolio_id=${portfolioId}` : ""}`).then((r) => r.data);

// ── Import (v3: sheet picker + Head-driven portfolios) ──────────────────────
export interface PreviewSheet {
  name: string; header_row: number; buys: number; sells: number; skipped: number;
  heads: Record<string, number>; blank_head_count: number;
}
export interface ImportPreview {
  token: string; sheets: PreviewSheet[]; default_sheet: string; portfolios: Portfolio[];
}
export const previewImport = (file: File) => {
  const fd = new FormData();
  fd.append("file", file);
  return api.post<ImportPreview>("/api/trades/import/preview", fd,
    { headers: { "Content-Type": "multipart/form-data" }, timeout: 300_000 }).then((r) => r.data);
};

export interface CommitReport {
  portfolios: { portfolio: string; new_buys: number; new_sells: number; duplicates_skipped: number }[];
  portfolios_created: string[];
  stocks_created: string[];
  symbols_resolved: { name: string; symbol: string }[];
  unmapped_count: number;
  skipped_rows: { sheet: string; row: number; name: string; reason: string }[];
  skipped_total: number;
  merge_suggestions: { name: string; similar_to: string; similar_stock_id: number; confidence: number }[];
  oversell_warnings: string[];
}
export const commitImport = (token: string, sheet: string,
  blank_head?: { portfolio_id?: number; new_name?: string }) =>
  api.post<CommitReport>("/api/trades/import/commit", { token, sheet, blank_head },
    { timeout: 300_000 }).then((r) => r.data);

// ── Trades: add / sell / lot-sell ───────────────────────────────────────────
export const addTrade = (body: { name: string; qty: number; price: number; date?: string; brokerage?: number; symbol?: string; portfolio_id?: number }) =>
  api.post("/api/trades/add", body).then((r) => r.data);

export const sellGeneric = (body: { stock_id: number; qty: number; price: number; date?: string; portfolio_id: number }) =>
  api.post("/api/trades/sell", body).then((r) => r.data);

export const sellLot = (body: { lot_id: number; price: number; qty?: number; date?: string }) =>
  api.post("/api/trades/sell-lot", body).then((r) => r.data);

// ── Stock fix-ups ───────────────────────────────────────────────────────────
export const mergeStocks = (keepId: number, otherId: number) =>
  api.post(`/api/trades/stocks/${keepId}/merge`, { other_stock_id: otherId }).then((r) => r.data);

export const setStockSymbol = (id: number, symbol: string) =>
  api.post(`/api/trades/stocks/${id}/symbol`, { symbol }).then((r) => r.data);

// ── Export ──────────────────────────────────────────────────────────────────
export const downloadTradesExcel = async () => {
  const res = await api.get("/api/trades/export", { responseType: "blob", timeout: 120_000 });
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `CF1_Share_Software_${new Date().toISOString().slice(0, 10)}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

// ── Autocomplete (Add-trade form) ───────────────────────────────────────────
export interface StockSuggestion { name: string; symbol: string | null; company: string | null; source: "portfolio" | "nse"; }
export const suggestStocks = (q: string) =>
  api.get<{ results: StockSuggestion[] }>(`/api/trades/suggest?q=${encodeURIComponent(q)}`).then((r) => r.data.results);

// ── Bulk symbol mapping ─────────────────────────────────────────────────────
export interface SymbolCandidate { symbol: string; company: string; score: number; }
export interface UnmappedStock { stock_id: number; name: string; candidates: SymbolCandidate[]; preselect: string | null; }
export const getUnmappedSuggestions = () =>
  api.get<{ unmapped: UnmappedStock[] }>("/api/trades/unmapped-suggestions").then((r) => r.data.unmapped);
export const applySymbols = (mappings: { stock_id: number; symbol: string }[]) =>
  api.post<{ applied: number; status: string }>("/api/trades/apply-symbols", { mappings }).then((r) => r.data);

// ── NSE catalog (full symbol + ETF list) ────────────────────────────────────
export const getCatalogStatus = () =>
  api.get<{ count: number }>("/api/trades/catalog/status").then((r) => r.data);
export const refreshCatalog = () =>
  api.post<{ loaded: number; status: string }>("/api/trades/catalog/refresh", {}, { timeout: 120_000 }).then((r) => r.data);
export const searchCatalog = (q: string) =>
  api.get<{ results: { symbol: string; company: string }[] }>(`/api/trades/catalog/search?q=${encodeURIComponent(q)}`).then((r) => r.data.results);
