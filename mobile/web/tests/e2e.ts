/**
 * End-to-end flow test of every /api route family against the live internet.
 * Run after a smoke engine run (SMOKE_DB) so a brief and suggestions exist:
 *   SMOKE_DB=... npx tsx tests/e2e.ts
 */
import * as XLSX from "xlsx";
import { dispatch, initBackend } from "../src/backend";
import { nodePlatform } from "./nodePlatform";

initBackend(nodePlatform(process.env.SMOKE_DB));
let failures = 0;

async function call(method: string, url: string, body: unknown = {}, expect = 200): Promise<any> {
  const t0 = Date.now();
  const { status, data } = await dispatch(method, url, body);
  const ok = status === expect;
  if (!ok) failures++;
  const s = (data as any)?.blob instanceof Blob ? `<File ${(data as any).filename} ${(data as any).blob.size} bytes>` : JSON.stringify(data);
  console.log(`${ok ? "ok  " : "FAIL"} ${status} ${method} ${url} (${((Date.now() - t0) / 1000).toFixed(1)}s) ${s.slice(0, 220)}`);
  return data;
}

// ── paper trading flow ────────────────────────────────────────────────────────
const sugs = (await call("GET", "/api/suggestions/today")).suggestions;
const buy = sugs.find((s: any) => s.action === "BUY" && !s.was_acted_on);
if (buy) {
  await call("POST", `/api/execute/buy/${buy.id}`);
  await call("POST", `/api/execute/buy/${buy.id}`, {}, 409);
}
await call("POST", "/api/execute/buy-manual", { symbol: "ITC.NS", quantity: 10, price: 400 });
const pf = await call("GET", "/api/portfolio/summary");
const itc = pf.holdings.find((h: any) => h.symbol === "ITC.NS");
await call("GET", "/api/execute/transactions?limit=10");
if (itc) await call("POST", `/api/execute/sell/${itc.id}`);
await call("GET", "/api/sector-health");
await call("GET", "/api/analysis/INFY.NS");
await call("GET", "/api/analysis/NOPE.NS", {}, 404);

// ── settings ─────────────────────────────────────────────────────────────────
await call("GET", "/api/settings");
await call("PUT", "/api/settings", { values: { stop_loss_pct: 0.09 } });
await call("PUT", "/api/settings", { values: { nifty50_pct: 0.5 } }, 400);
await call("POST", "/api/settings/preset/medium");
await call("POST", "/api/settings/preset/bogus", {}, 400);
await call("POST", "/api/settings/reset");

// ── insights / deep dive / news ──────────────────────────────────────────────
for (const u of ["equity-curve", "journal", "risk", "dividends", "watch", "health", "guard-diary", "fii-dii"]) {
  await call("GET", `/api/insights/${u}`);
}
await call("GET", "/api/deepdive/search?q=tata");
await call("GET", `/api/deepdive/sector/${encodeURIComponent("Banking & Finance")}/stocks`);
await call("GET", "/api/deepdive/TCS");
await call("GET", "/api/news/feed?limit=5");
await call("GET", "/api/news/guard-status");
await call("GET", "/api/market/universe?segment=GOLD_ETF");

// ── trades: build a workbook in the user's v3 layout, import, export ─────────
const HDR = ["COMP", "Full Form", "Head", "@", "Qty", "Purch Amt", "Amt+Brock", "Rate", "Purch Date", "Broker", "%", "",
  "Sale Date", "@", "Qty", "Sale Amt", "Sale-Brcok", "NSDL Ch", "Profit", "% Profit", "Days", "XIM %", "Total Brock", "% T Brock"];
const d = (iso: string) => ({ t: "n", v: (Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 864e5, z: "dd-mm-yyyy" });
const rows: any[][] = [HDR,
  ["INFY", "Infosys Limited", "Demat A", 1400, 5, 7000, 7010, 1402, d("2025-03-10"), 10, 0.14, "", d("2025-09-01"), 1550, 3, 4650],
  ["INFY", "Infosys Limited", "Demat A", 1300, 4, 5200, 5208, 1302, d("2025-05-12"), 8, 0.15],
  ["RELIANCE", "Reliance Industries Ltd", "", 1250, 6, 7500, 7512, 1252, d("2025-02-03"), 12, 0.16],
  ["ADAPOW", "Adani Power Limited", "Demat B", 520, 15, 7800, 7810, 520.6, d("2025-06-20"), 10, 0.13],
  ["TOTAL", "", "", "", "", 27500],
];
const ws: XLSX.WorkSheet = {};
rows.forEach((r, ri) => r.forEach((v, ci) => {
  if (v === "" || v == null) return;
  ws[XLSX.utils.encode_cell({ r: ri, c: ci })] = typeof v === "object" ? v : typeof v === "number" ? { t: "n", v } : { t: "s", v };
}));
ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: HDR.length - 1 } });
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws, "23.24");
const file = new File([XLSX.write(wb, { type: "array", bookType: "xlsx" })], "trades.xlsx");
const fd = new FormData();
fd.append("file", file);
const prev = await call("POST", "/api/trades/import/preview", fd);
await call("POST", "/api/trades/import/commit", { token: prev.token, sheet: "23.24" }, 400);   // blank Head needs a portfolio
const rep = await call("POST", "/api/trades/import/commit", { token: prev.token, sheet: "23.24", blank_head: { new_name: "Main" } });
const fd2 = new FormData();
fd2.append("file", file);
const prev2 = await call("POST", "/api/trades/import/preview", fd2);
const rep2 = await call("POST", "/api/trades/import/commit", { token: prev2.token, sheet: "23.24", blank_head: { new_name: "Main" } });
console.log("   re-import duplicates skipped:", rep2.portfolios.map((p: any) => p.duplicates_skipped).join(","), "(expect all)");
const tp = await call("GET", "/api/trades/portfolio?prices=full");
const infy = tp.holdings.find((h: any) => h.name === "INFY");
console.log(`   INFY held ${infy?.held_qty} (expect 6 = 5+4-3 FIFO), lowest lot ${JSON.stringify(infy?.lowest_lot)}`);
await call("GET", `/api/trades/stock/${infy.stock_id}`);
await call("POST", "/api/trades/sell", { stock_id: infy.stock_id, qty: 2, price: 1500, portfolio_id: infy.portfolio_id });
await call("POST", "/api/trades/sell", { stock_id: infy.stock_id, qty: 99, price: 1500, portfolio_id: infy.portfolio_id }, 400);
await call("POST", "/api/trades/add", { name: "TCS", qty: 2, price: 3100, portfolio_id: infy.portfolio_id });
await call("GET", "/api/trades/suggest?q=tata");
await call("GET", "/api/trades/unmapped-suggestions");
await call("GET", "/api/trades/quotes?symbols=INFY.NS,RELIANCE.NS");
await call("POST", "/api/trades/catalog/refresh");
await call("GET", "/api/trades/catalog/status");
await call("GET", "/api/trades/catalog/search?q=adani");
const um = await call("GET", "/api/trades/unmapped-suggestions");
console.log("   unmapped:", um.unmapped.map((u: any) => `${u.name}→${u.candidates[0]?.symbol}(${u.candidates[0]?.score})`).join(" "));
const blob = await call("GET", "/api/trades/export");
const back = XLSX.read(await (blob.blob as Blob).arrayBuffer(), { type: "array" });
console.log("   export sheet rows:", XLSX.utils.sheet_to_json(back.Sheets["23.24"], { header: 1 }).length);
console.log("   import report:", JSON.stringify(rep).slice(0, 400));

// ── options ──────────────────────────────────────────────────────────────────
const und = await call("GET", "/api/options/underlyings");
console.log(`   F&O underlyings: ${und.stocks.length} stocks`);
const nifty = await call("GET", "/api/options/analyze/NIFTY");
console.log(`   NIFTY: source=${nifty.source} expiry=${nifty.expiry} verdict=${nifty.verdict?.action} dir=${nifty.verdict?.direction} best=${nifty.recommended?.strike}${nifty.recommended?.side}`);
await call("GET", "/api/options/analyze/RELIANCE");
await call("GET", "/api/options/analyze/NOTREAL", {}, 404);

// ── backtests ────────────────────────────────────────────────────────────────
await call("GET", "/api/backtest/presets");
const job = await call("POST", "/api/backtest/multi/start", { preset: "conservative" });
let st: any;
do {
  await new Promise((r) => setTimeout(r, 3000));
  st = (await dispatch("GET", `/api/backtest/multi/status/${job.job_id}`, {})).data;
  process.stdout.write(`\r   multi: ${st.status} ${st.stage} ${Math.round(st.progress * 100)}%      `);
} while (st.status === "RUNNING");
console.log(`\n   multi summary: ${JSON.stringify(st.summary)}`);
const cmp = await call("POST", "/api/backtest/compare/start", {});
do {
  await new Promise((r) => setTimeout(r, 2000));
  st = (await dispatch("GET", `/api/backtest/compare/status/${cmp.job_id}`, {})).data;
} while (st.status === "RUNNING");
console.log(`   compare: ${st.status} ${JSON.stringify(st.summary)}`);
const wf = await call("POST", "/api/backtest/walkforward/start");
do {
  await new Promise((r) => setTimeout(r, 2000));
  st = (await dispatch("GET", `/api/backtest/walkforward/status/${wf.job_id}`, {})).data;
} while (st.status === "RUNNING");
console.log(`   walk-forward: ${st.status} ${JSON.stringify(st.summary)}`);
const hist = await call("GET", "/api/backtest/multi/history");
await call("GET", `/api/backtest/multi/history/${encodeURIComponent(hist.history[0].name)}`);
const runs = await call("GET", "/api/backtest/runs");
await call("GET", `/api/backtest/runs/${runs.runs[0].id}`);
await call("GET", "/api/mobile/status");

console.log(failures ? `\n${failures} FAILURES` : "\nALL ROUTES OK");
process.exit(failures ? 1 : 0);
