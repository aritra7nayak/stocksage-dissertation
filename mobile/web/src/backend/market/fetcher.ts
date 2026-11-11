/**
 * Market data fetcher — app/market_data/fetcher.py on the phone.
 * In-memory TTL cache (15 min prices, 4 h fundamentals), retries with
 * backoff, and a bounded-concurrency batch download for the universe.
 */
import { BASE } from "../config";
import { log } from "../platform";
import { fmt, pyRound } from "../util/py";
import { isMarketOpenIst } from "../util/time";
import { Bars, chart, info, withRetry, Dividend } from "./yahoo";

const PRICE_TTL = 15 * 60_000;
const FUND_TTL = 4 * 3600_000;
const cache = new Map<string, { exp: number; value: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

function cget<T>(key: string): T | undefined {
  const hit = cache.get(key);
  return hit && hit.exp > Date.now() ? (hit.value as T) : undefined;
}

function cput(key: string, value: unknown, ttl: number): void {
  cache.set(key, { exp: Date.now() + ttl, value });
}

/** Coalesce concurrent identical requests (the UI fires several at once). */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const p = inflight.get(key) as Promise<T> | undefined;
  if (p) return p;
  const np = fn().finally(() => inflight.delete(key));
  inflight.set(key, np);
  return np;
}

export { isMarketOpenIst };

export async function getHistory(symbol: string, period = "1y"): Promise<Bars> {
  const key = `hist:${symbol}:${period}`;
  const hit = cget<Bars>(key);
  if (hit) return hit;
  return once(key, async () => {
    const { bars, dividends } = await withRetry(() => chart(symbol, period));
    cput(key, bars, PRICE_TTL);
    cput(`divs:${symbol}`, dividends, PRICE_TTL);
    return bars;
  });
}

export function cachedHistory(symbols: string[], period = "1y"): Record<string, Bars> {
  const out: Record<string, Bars> = {};
  for (const s of symbols) {
    const b = cget<Bars>(`hist:${s}:${period}`);
    if (b) out[s] = b;
  }
  return out;
}

/** Many symbols at once; failures are logged and omitted (never fatal). */
export async function batchHistory(symbols: string[], period = "1y", concurrency = 8,
                                   onProgress?: (done: number, total: number) => void): Promise<Record<string, Bars>> {
  const out: Record<string, Bars> = {};
  const todo = [...new Set(symbols)];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      const s = todo[next++];
      try {
        out[s] = await getHistory(s, period);
      } catch (e) {
        log("warn", `No data for ${s} — skipped (${(e as Error).message})`);
      }
      done++;
      onProgress?.(done, todo.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return out;
}

export async function dividends(symbol: string): Promise<Dividend[]> {
  const key = `divs-max:${symbol}`;
  const hit = cget<Dividend[]>(key);
  if (hit) return hit;
  const { dividends: d } = await withRetry(() => chart(symbol, "max"));
  cput(key, d, FUND_TTL);
  return d;
}

export interface Quote {
  symbol: string; price: number; prev_close: number; change_pct: number;
  as_of: string; is_live_session: boolean;
}

export async function getQuote(symbol: string): Promise<Quote> {
  const b = await getHistory(symbol, "5d");
  const n = b.close.length;
  if (n < 2) throw new Error(`Not enough bars for ${symbol}`);
  const last = b.close[n - 1], prev = b.close[n - 2];
  return {
    symbol,
    price: pyRound(last, 2),
    prev_close: pyRound(prev, 2),
    change_pct: pyRound((last / prev - 1) * 100, 3),
    as_of: b.dates[n - 1],
    is_live_session: isMarketOpenIst(),
  };
}

export async function getIndices() {
  const [nifty50, sensex] = await Promise.all([getQuote(BASE.nifty50_index), getQuote(BASE.sensex_index)]);
  return { nifty50, sensex };
}

export async function getGoldSilver() {
  const [gold, silver] = await Promise.all([getQuote(BASE.gold_etf), getQuote(BASE.silver_etf)]);
  return { gold, silver };
}

/** R11 input — live intraday vs yesterday during market hours, else last two closes. */
export async function getNiftyStatus(threshold = BASE.nifty_fall_threshold) {
  const q = await getQuote(BASE.nifty50_index);
  const fell = q.change_pct <= threshold;
  const basis = q.is_live_session ? "live intraday session" : "previous session close";
  return {
    nifty_value: q.price,
    change_pct: q.change_pct,
    nifty_fell: fell,
    guard_basis: basis,
    rule: "R11",
    verdict: `Nifty ${fell ? "fell" : "is steady/up"} (${fmt(q.change_pct, "+.2f")}%, based on ${basis}). ` +
      (fell ? "Buying is PAUSED today." : "Buying is permitted by R11."),
  };
}

export async function getFundamentalsRaw(symbol: string): Promise<Record<string, number | null>> {
  const key = `fund:${symbol}`;
  const hit = cget<Record<string, number | null>>(key);
  if (hit) return hit;
  return once(key, async () => {
    const i = await withRetry(() => info(symbol));
    cput(key, i, FUND_TTL);
    return i;
  });
}

/** Drop the price cache (pull-to-refresh). */
export function clearPriceCache(): void {
  for (const k of [...cache.keys()]) if (k.startsWith("hist:")) cache.delete(k);
}
