/**
 * Trades system, pure half — trades_router.py parsing, FIFO replay and the
 * symbol-matching heuristics. No database access here.
 */
import * as XLSX from "xlsx";
import { ratio } from "../util/difflib";
import { sha256Hex } from "../util/hash";
import { fmt, num, pyRound } from "../util/py";

export function normName(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const JUNK_PATTERNS = /^(COMP|TOTAL|INVESTED|PURCHASE COST|IN \d|RBI BOND|SGBT ?\d)/i;
const SKIP_ROW_MARKERS = ["TOTAL SALE", "PRESENT HOLDING", "(A)"];

/** A date-formatted cell (openpyxl hands these back as datetime). */
export class XDate {
  constructor(public iso: string) {}
}

type Cell = number | string | boolean | XDate | null;

export interface SheetReader {
  name: string;
  maxRow: number;
  maxCol: number;
  cell(row: number, col: number): Cell;   // 1-based, like openpyxl
}

/** Excel number format that renders a date (what openpyxl turns into datetime). */
function isDateFormat(z: string): boolean {
  if (z === "General") return false;
  const bare = z.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "");
  return /[dmyhs]/i.test(bare);
}

/** 1900-system serial → ISO date (Excel's day 0 is 1899-12-30 once the 1900 leap bug is folded in). */
function serialToIso(v: number): string {
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(v + 1e-9) * 86400000).toISOString().slice(0, 10);
}

export function readWorkbook(content: ArrayBuffer): SheetReader[] {
  const wb = XLSX.read(content, { type: "array", cellDates: false, cellNF: true });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } };
    return {
      name,
      maxRow: range.e.r + 1,
      maxCol: range.e.c + 1,
      cell(row: number, col: number): Cell {
        const c = ws[XLSX.utils.encode_cell({ r: row - 1, c: col - 1 })];
        if (!c || c.v == null || c.t === "z") return null;
        if (c.t === "n" && c.z && isDateFormat(String(c.z))) return new XDate(serialToIso(c.v as number));
        if (c.t === "d") return new XDate(new Date(c.v as Date).toISOString().slice(0, 10));
        if (c.t === "e") return null;
        return c.v as Cell;
      },
    };
  });
}

const str = (v: Cell): string => {
  if (v == null || v === "" || v === false || v === 0) return "";       // Python `v or ""`
  if (v instanceof XDate) return `${v.iso} 00:00:00`;
  return String(v);
};

const numCell = (v: Cell): number | null => (v instanceof XDate ? null : typeof v === "boolean" ? Number(v) : num(v));
const dateCell = (v: Cell): string | null => (v instanceof XDate ? v.iso : null);

type Cols = Record<string, number | null>;

function headerMap(ws: SheetReader, hr: number): Cols | null {
  const names: Record<string, number[]> = {};
  for (let c = 1; c <= ws.maxCol; c++) {
    const v = str(ws.cell(hr, c)).trim().toUpperCase();
    if (v) (names[v] ??= []).push(c);
  }
  if (!names.COMP || !names["FULL FORM"]) return null;
  const first = (...keys: string[]) => { for (const k of keys) if (names[k]) return names[k][0]; return null; };
  const nth = (k: string, i: number) => names[k]?.[i] ?? null;
  const cols: Cols = {
    comp: first("COMP"), full: first("FULL FORM"), head: first("HEAD"),
    bprice: nth("@", 0), bqty: nth("QTY", 0), bgross: first("PURCH AMT"), bcost: first("AMT+BROCK"),
    brate: first("RATE", "EFF RATE"), bdate: first("PURCH DATE"), bbroker: first("BROKER"), bbrokpct: nth("%", 0),
    sdate: first("SALE DATE"), sprice: nth("@", 1), sqty: nth("QTY", 1), sgross: first("SALE AMT"),
    snet: first("SALE-BRCOK", "SALE-BROCK"), nsdl: first("NSDL CH"), profit: first("PROFIT"),
    profitpct: first("% PROFIT"), days: first("DAYS"), xim: first("XIM %"), tbrock: first("TOTAL BROCK"),
    tbrockpct: first("% T BROCK"),
  };
  if (!(cols.bprice && cols.bqty && cols.bdate)) return null;
  return cols;
}

export function listCandidateSheets(sheets: SheetReader[]): { name: string; header_row: number }[] {
  const out = [];
  for (const ws of sheets) {
    for (let hr = 1; hr <= Math.min(6, ws.maxRow); hr++) {
      const vals: string[] = [];
      for (let c = 1; c <= Math.min(ws.maxCol || 1, 30); c++) vals.push(str(ws.cell(hr, c)).trim().toUpperCase());
      if (vals.includes("COMP") && vals.includes("FULL FORM")) {
        out.push({ name: ws.name, header_row: hr });
        break;
      }
    }
  }
  return out;
}

export interface ParsedTrade {
  raw_name: string; norm: string; full_form: string | null; head: string | null; date: string;
  qty: number; price: number; gross: number; cost?: number | null; brokerage?: number | null;
  extras: Record<string, unknown>; sheet: string; row: number; dedup_hash?: string;
}

export interface Skipped { sheet: string; row: number; name: string; reason: string }

export async function parseSheet(ws: SheetReader): Promise<{ buys: ParsedTrade[]; sells: ParsedTrade[]; skipped: Skipped[] }> {
  const sheet = ws.name;
  let cols: Cols | null = null, hr = 0;
  for (let r = 1; r <= Math.min(6, ws.maxRow); r++) {
    cols = headerMap(ws, r);
    if (cols) { hr = r; break; }
  }
  if (!cols) throw new Error(`Sheet '${sheet}' doesn't have the expected COMP/Full Form header`);
  const cv = (r: number, key: string): Cell => (cols![key] ? ws.cell(r, cols![key]!) : null);
  const buys: ParsedTrade[] = [], sells: ParsedTrade[] = [], skipped: Skipped[] = [];

  for (let r = hr + 1; r <= ws.maxRow; r++) {
    const rawCell = cv(r, "comp");
    if (rawCell == null || !String(rawCell instanceof XDate ? rawCell.iso : rawCell).trim()) continue;
    const raw = String(rawCell instanceof XDate ? rawCell.iso : rawCell).trim();
    const up = raw.toUpperCase();
    if (up === "COMP" || SKIP_ROW_MARKERS.some((m) => up.startsWith(m))) continue;
    if (JUNK_PATTERNS.test(raw)) {
      skipped.push({ sheet, row: r, name: raw, reason: "Non-equity row (bond/summary)" });
      continue;
    }
    const bPrice = numCell(cv(r, "bprice")), bQty = numCell(cv(r, "bqty")), bDate = dateCell(cv(r, "bdate"));
    if (!(bPrice && bPrice > 0 && bQty && bQty > 0 && bDate)) {
      skipped.push({ sheet, row: r, name: raw, reason: "Missing/invalid qty, price or date in buy block" });
      continue;
    }
    const full = str(cv(r, "full")).trim() || null;
    const head = str(cv(r, "head")).trim() || null;
    const n = normName(raw);
    buys.push({
      raw_name: raw, norm: n, full_form: full, head, date: bDate, qty: bQty, price: bPrice,
      gross: numCell(cv(r, "bgross")) || pyRound(bQty * bPrice, 2),
      cost: numCell(cv(r, "bcost")), brokerage: numCell(cv(r, "bbroker")),
      extras: { Rate: numCell(cv(r, "brate")), BrokerPct: numCell(cv(r, "bbrokpct")), _sheet: sheet },
      sheet, row: r,
    });
    const sDate = dateCell(cv(r, "sdate")), sQty = numCell(cv(r, "sqty")), sPrice = numCell(cv(r, "sprice"));
    if (sDate && sQty && sQty > 0 && sPrice && sPrice > 0) {
      const ratio_ = sPrice / bPrice;
      if (!(ratio_ >= 0.05 && ratio_ <= 20)) {
        skipped.push({ sheet, row: r, name: raw, reason: `Sale price ${fmt(ratio_, ",.0f")}x the buy price — looks wrong, sale skipped` });
      } else {
        sells.push({
          raw_name: raw, norm: n, full_form: full, head, date: sDate, qty: sQty, price: sPrice,
          gross: numCell(cv(r, "sgross")) || pyRound(sQty * sPrice, 2),
          extras: {
            _sheet: sheet, SaleNet: numCell(cv(r, "snet")), NSDLCh: numCell(cv(r, "nsdl")),
            Profit: numCell(cv(r, "profit")), ProfitPct: numCell(cv(r, "profitpct")), Days: numCell(cv(r, "days")),
            XIMPct: numCell(cv(r, "xim")), TotalBrock: numCell(cv(r, "tbrock")), TBrockPct: numCell(cv(r, "tbrockpct")),
          },
          sheet, row: r,
        });
      }
    } else if (sDate || sQty || sPrice) {
      skipped.push({ sheet, row: r, name: raw, reason: "Partial sale block — buy imported, sale skipped" });
    }
  }

  for (const [coll, side] of [[buys, "BUY"], [sells, "SELL"]] as const) {
    const seen: Record<string, number> = {};
    for (const t of coll) {
      const h = await baseHash(side, t.norm, t.date, t.qty, t.price);
      seen[h] = (seen[h] ?? 0) + 1;
      t.dedup_hash = `${h}#${seen[h]}`;
    }
  }
  return { buys, sells, skipped };
}

export async function baseHash(side: string, norm: string, date: string, qty: number, price: number): Promise<string> {
  return (await sha256Hex(`${side}|${norm}|${date}|${fmt(qty, ".4f")}|${fmt(price, ".4f")}`)).slice(0, 24);
}

// ── FIFO replay ──────────────────────────────────────────────────────────────
export interface LotIn { id: number; date: string; qty: number }
export interface SellIn extends LotIn { target_lot_id?: number | null }

export function replayFifo(buys: LotIn[], sells: SellIn[]): [Map<number, number>, Map<number, [number, number][]>, string[]] {
  const cmp = (a: LotIn, b: LotIn) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id);
  const sorted = [...buys].sort(cmp);
  const remaining = new Map(sorted.map((b) => [b.id, Number(b.qty)]));
  const consumption = new Map<number, [number, number][]>();
  const warnings: string[] = [];
  for (const s of [...sells].sort(cmp)) {
    let need = Number(s.qty);
    const eaten: [number, number][] = [];
    const tgt = s.target_lot_id;
    if (tgt && (remaining.get(tgt) ?? 0) > 0) {
      const take = Math.min(need, remaining.get(tgt)!);
      remaining.set(tgt, remaining.get(tgt)! - take);
      eaten.push([tgt, take]);
      need -= take;
    }
    for (const b of sorted) {
      if (need <= 1e-9) break;
      const r = remaining.get(b.id)!;
      if (r <= 1e-9) continue;
      const take = Math.min(need, r);
      remaining.set(b.id, r - take);
      eaten.push([b.id, take]);
      need -= take;
    }
    if (need > 1e-9) {
      warnings.push(`Sell of ${fmt(s.qty, "g")} on ${s.date} exceeds shares held by ${fmt(need, "g")} — recorded, ` +
        `but ${fmt(need, "g")} could not be matched to any lot`);
    }
    consumption.set(s.id, eaten);
  }
  return [remaining, consumption, warnings];
}

// ── symbol matching ──────────────────────────────────────────────────────────
export type Prepared = [string, string | null, string, string, string[], string, string];

export function prepareRows(rows: [string, string | null][]): Prepared[] {
  return rows.map(([sym, company]) => {
    const root = sym.replace(".NS", "").toUpperCase();
    const compNorm = normName(company ?? "");
    const words = (company ?? "").toUpperCase().split(/[^A-Za-z]+/).filter(Boolean);
    const iniAll = words.filter((w) => w !== "THE").map((w) => w[0]).join("");
    const iniCore = words.filter((w) => !["LTD", "LIMITED", "THE"].includes(w)).map((w) => w[0]).join("");
    return [sym, company, root, compNorm, words, iniAll, iniCore];
  });
}

const STOPWORDS = new Set(["OF", "THE", "AND", "LTD", "LIMITED", "&", "CO", "CORP", "CORPORATION"]);

/** Word-prefix composition (ADAPOW = ADA(ni)+POW(er)); returns max words used. */
export function composes(norm: string, words: string[]): number {
  const ws = words.filter((w) => w && !STOPWORDS.has(w));
  const n = norm.length, m = ws.length;
  if (!n || !m) return 0;
  let best = 0;
  // trades_router._composes memoises but never prunes on it; same search here.
  const dp = (i: number, j: number, used: number): void => {
    if (i === n) {
      if (used >= 1) best = Math.max(best, used);
      return;
    }
    if (j === m) return;
    dp(i, j + 1, used);
    const w = ws[j];
    let k = 1;
    while (k <= w.length && i + k <= n && norm.slice(i, i + k) === w.slice(0, k)) {
      dp(i + k, j + 1, used + 1);
      k++;
    }
  };
  dp(0, 0, 0);
  return best;
}

function isSubseq(needle: string, hay: string): boolean {
  let p = 0;
  for (const ch of needle) {
    const i = hay.indexOf(ch, p);
    if (i < 0) return false;
    p = i + 1;
  }
  return true;
}

export function symbolCandidates(norm: string, rows: Prepared[]): { symbol: string; company: string | null; score: number }[] {
  const out = [];
  for (const [sym, company, root, compNorm, words, iniAll, iniCore] of rows) {
    let score = ratio(norm, root);
    if (compNorm) score = Math.max(score, ratio(norm, compNorm.slice(0, Math.max(norm.length, 6))) * 0.95);
    if ((norm === iniAll || norm === iniCore) && norm.length >= 2) score = Math.max(score, 0.96);
    else if (iniCore && norm.length >= 2 && (norm.startsWith(iniCore) || iniCore.startsWith(norm))) score = Math.max(score, 0.75);
    const used = composes(norm, words);
    if (used >= 2) score = Math.max(score, 0.89);
    else if (used === 1 && norm.length >= 4) score = Math.max(score, 0.8);
    if (norm.length >= 3 && root.startsWith(norm.slice(0, 4))) score = Math.max(score, 0.8);
    if (norm.length >= 4 && compNorm.includes(norm)) score = Math.max(score, 0.85);
    if (norm.length >= 4 && isSubseq(norm, compNorm)) score = Math.max(score, 0.72);
    if (score >= 0.45) out.push({ symbol: sym, company, score: pyRound(score, 2) });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}

export function autoSymbolFromFullname(fullName: string | null, rows: Prepared[]): string | null {
  if (!fullName || !rows.length) return null;
  const fn = normName(fullName.replace(/\(.*?\)/g, " "));
  if (fn.length < 4) return null;
  let best: string | null = null, bestScore = 0;
  for (const [sym, , , compNorm] of rows) {
    if (!compNorm) continue;
    let s = ratio(fn, compNorm);
    if (fn === compNorm) s = 1;
    else if (compNorm.startsWith(fn) || fn.startsWith(compNorm)) s = Math.max(s, 0.93);
    if (s > bestScore) { best = sym; bestScore = s; }
  }
  return bestScore >= 0.9 ? best : null;
}

export function suggestMerges(newNorms: string[], existing: [number, string, string][]) {
  const out = [];
  for (const n of newNorms) {
    for (const [sid, disp, en] of existing) {
      if (en === n) continue;
      const r = ratio(n, en);
      if (r >= 0.8) out.push({ name: n, similar_to: disp, similar_stock_id: sid, confidence: pyRound(r, 2) });
    }
  }
  return out;
}
