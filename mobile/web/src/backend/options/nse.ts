/**
 * NSE option-chain adapter — app/options/nse.py. NSE's JSON endpoints only
 * answer a client that first loaded the website and holds its cookies; the
 * native HTTP stack keeps that cookie jar. If NSE refuses, callers fall back
 * to a Black-Scholes "modeled" chain that the UI labels as such.
 */
import { platform } from "../platform";
import { fmtExpiry, istParts, nseTimestamp, parseExpiry, todayIst, weekdayOf, addDays } from "../util/time";
import { bsPrice } from "./pricing";

const BASE = "https://www.nseindia.com";
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: `${BASE}/option-chain`,
};

export const INDICES: Record<string, { name: string; yf: string; step: number; lot: number; sector: string | null }> = {
  NIFTY: { name: "Nifty 50", yf: "^NSEI", step: 50, lot: 65, sector: null },
  BANKNIFTY: { name: "Nifty Bank", yf: "^NSEBANK", step: 100, lot: 30, sector: "Banking & Finance" },
};

export class NSEUnavailable extends Error {}

const cache = new Map<string, { exp: number; value: unknown }>();
const cached = <T>(k: string): T | undefined => {
  const h = cache.get(k);
  return h && h.exp > Date.now() ? (h.value as T) : undefined;
};
const put = (k: string, v: unknown, ttlSec: number) => cache.set(k, { exp: Date.now() + ttlSec * 1000, value: v });

let warmedAt = 0;
let lock: Promise<unknown> = Promise.resolve();

/** NSE dislikes parallel bursts from one cookie jar — serialise requests. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => undefined);
  return run;
}

async function warm(force = false) {
  if (force || Date.now() - warmedAt > 300_000) {
    await platform().http({ url: `${BASE}/option-chain`, headers: { ...HEADERS, Accept: "text/html,*/*" }, timeoutMs: 12000 });
    warmedAt = Date.now();
  }
}

async function get(url: string) {
  return serial(async () => {
    try {
      await warm();
      let r = await platform().http({ url, headers: HEADERS, timeoutMs: 12000 });
      if (r.status === 401 || r.status === 403) {
        await warm(true);
        r = await platform().http({ url, headers: HEADERS, timeoutMs: 12000 });
      }
      if (r.status !== 200) throw new NSEUnavailable(`NSE returned HTTP ${r.status}`);
      return r.body;
    } catch (e) {
      if (e instanceof NSEUnavailable) throw e;
      throw new NSEUnavailable(`NSE request failed: ${(e as Error).message}`);
    }
  });
}

async function json(url: string): Promise<any> {
  const body = await get(url);
  let data: any;
  try {
    data = JSON.parse(body);
  } catch {
    throw new NSEUnavailable("NSE returned non-JSON (likely a bot challenge)");
  }
  if (!data || (typeof data === "object" && !Object.keys(data).length)) throw new NSEUnavailable("NSE returned an empty payload");
  return data;
}

export async function lotSizes(): Promise<Record<string, { name: string; lot: number }>> {
  const hit = cached<Record<string, { name: string; lot: number }>>("lots");
  if (hit) return hit;
  const out: Record<string, { name: string; lot: number }> = {};
  for (const [k, v] of Object.entries(INDICES)) out[k] = { name: v.name, lot: v.lot };
  try {
    const text = await get("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv");
    for (const line of text.split(/\r?\n/)) {
      const row = line.split(",");
      if (row.length < 3) continue;
      const name = row[0].trim(), sym = row[1].trim();
      const lot = row.slice(2).map((c) => c.trim()).find((c) => /^\d+$/.test(c));
      if (!sym || sym.toUpperCase() === "SYMBOL" || lot === undefined) continue;
      out[sym] = { name: name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()), lot: Number(lot) };
    }
    put("lots", out, 12 * 3600);
  } catch {
    put("lots", out, 600);
  }
  return out;
}

function lastTuesday(year: number, month: number): string {
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const wd = weekdayOf(last);
  return addDays(last, -(((wd - 1) % 7) + 7) % 7);
}

/** Calendar-rule expiries: NIFTY weekly Tuesdays, everything else last Tuesday of the month. */
export function modeledExpiries(symbol: string, today = todayIst()): string[] {
  const out: string[] = [];
  if (symbol === "NIFTY") {
    const d = addDays(today, (((1 - weekdayOf(today)) % 7) + 7) % 7);
    for (let i = 0; i < 5; i++) out.push(addDays(d, 7 * i));
  }
  let [y, m] = today.split("-").map(Number);
  for (let i = 0; i < 3; i++) {
    const lt = lastTuesday(y, m);
    if (lt >= today && !out.includes(lt)) out.push(lt);
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  if (out.length < 3) out.push(lastTuesday(y, m));
  return out.sort();
}

export async function expiries(symbol: string): Promise<string[]> {
  const key = `exp:${symbol}`;
  const hit = cached<string[]>(key);
  if (hit) return hit;
  const data = await json(`${BASE}/api/option-chain-contract-info?symbol=${encodeURIComponent(symbol)}`);
  const today = todayIst();
  const out = (data.expiryDates ?? []).map((s: string) => parseExpiry(s)).filter((d: string) => d >= today).sort();
  if (!out.length) throw new NSEUnavailable("NSE listed no future expiries");
  put(key, out, 600);
  return out;
}

export interface Leg { ltp: number; bid: number; ask: number; iv: number | null; oi: number; chg_oi: number; volume: number; chg_pct: number }
export interface ChainRow { strike: number; ce: Leg | null; pe: Leg | null }
export interface Chain { source: "NSE" | "MODELED"; spot: number; timestamp: string | null; rows: ChainRow[] }

function leg(raw: any): Leg | null {
  if (!raw || !raw.strikePrice) return null;
  const iv = Number(raw.impliedVolatility || 0);
  return {
    ltp: Number(raw.lastPrice || 0), bid: Number(raw.buyPrice1 || 0), ask: Number(raw.sellPrice1 || 0),
    iv: iv > 0 ? iv / 100 : null, oi: Math.trunc(Number(raw.openInterest || 0)),
    chg_oi: Math.trunc(Number(raw.changeinOpenInterest || 0)), volume: Math.trunc(Number(raw.totalTradedVolume || 0)),
    chg_pct: Math.round(Number(raw.pChange || 0) * 100) / 100,
  };
}

export async function chain(symbol: string, expiry: string): Promise<Chain> {
  const key = `chain:${symbol}:${expiry}`;
  const hit = cached<Chain>(key);
  if (hit) return hit;
  const kind = symbol in INDICES ? "Indices" : "Equity";
  const data = await json(`${BASE}/api/option-chain-v3?type=${kind}&symbol=${encodeURIComponent(symbol)}&expiry=${fmtExpiry(expiry)}`);
  const rec = data.records ?? {};
  const rows: ChainRow[] = [];
  for (const d of rec.data ?? []) {
    const ce = leg(d.CE), pe = leg(d.PE);
    if (ce || pe) rows.push({ strike: Number(d.strikePrice), ce, pe });
  }
  const spot = rec.underlyingValue;
  if (!rows.length || !spot) throw new NSEUnavailable(`Empty option chain for ${symbol} ${fmtExpiry(expiry)}`);
  const out: Chain = { source: "NSE", spot: Number(spot), timestamp: rec.timestamp ?? null, rows: rows.sort((a, b) => a.strike - b.strike) };
  put(key, out, 60);
  return out;
}

export function strikeStep(symbol: string, spot: number): number {
  if (symbol in INDICES) return INDICES[symbol].step;
  for (const [limit, step] of [[100, 1], [250, 2.5], [500, 5], [1000, 10], [2500, 20], [5000, 50]]) if (spot < limit) return step;
  return 100;
}

/** Python round(): half to even. */
function bankers(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

export function modeledChain(symbol: string, spot: number, sigma: number, T: number, nEach = 15): Chain {
  const step = strikeStep(symbol, spot);
  const atm = bankers(spot / step) * step;
  const rows: ChainRow[] = [];
  for (let i = -nEach; i <= nEach; i++) {
    const k = atm + i * step;
    if (k <= 0) continue;
    const mk = (kind: string): Leg => ({
      ltp: Math.round(bsPrice(spot, k, T, sigma, kind) * 100) / 100,
      bid: 0, ask: 0, iv: sigma, oi: 0, chg_oi: 0, volume: 0, chg_pct: 0,
    });
    rows.push({ strike: k, ce: mk("CE"), pe: mk("PE") });
  }
  return { source: "MODELED", spot, timestamp: nseTimestamp(), rows };
}

export { istParts };
