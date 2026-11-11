/**
 * Yahoo Finance, spoken directly — what yfinance does under the hood.
 *
 *  chart       v8/finance/chart          OHLCV + dividend events (no auth)
 *  summary     v10/finance/quoteSummary  fundamentals + calendar (cookie + crumb)
 *
 * yfinance semantics reproduced: auto_adjust (OHLC scaled by adjclose/close),
 * NaN/placeholder bars dropped, one bar per exchange (IST) date.
 */
import { platform, log } from "../platform";
import { istDateFromEpoch } from "../util/time";

export interface Bars {
  dates: string[];       // IST trading dates, ascending
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

export interface Dividend { date: string; amount: number }

// Yahoo answers 429 to mobile and library user agents but serves desktop Chrome.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const HEADERS = { "User-Agent": UA, Accept: "application/json,text/plain,*/*", "Accept-Language": "en-US,en;q=0.9" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** tenacity(stop_after_attempt(3), wait_exponential(min=2, max=10)) */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (e instanceof NoDataError) throw e;          // a 404 won't fix itself
      if (i < attempts - 1) await sleep(Math.min(10000, 2000 * 2 ** i));
    }
  }
  throw lastErr;
}

export class NoDataError extends Error {}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const r = await platform().http({ url, headers: { ...HEADERS, ...headers }, timeoutMs: 20000 });
  let json: any = null;
  try {
    json = JSON.parse(r.body);
  } catch {
    /* non-JSON (rate-limit page etc.) */
  }
  return { status: r.status, json };
}

/** One symbol's daily history. range: 5d | 1mo | 3mo | 6mo | 1y | 2y | 5y | max */
export async function chart(symbol: string, range: string): Promise<{ bars: Bars; dividends: Dividend[] }> {
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?range=${range}&interval=1d&includePrePost=false&events=div%2Csplits`;
  const { status, json } = await getJson(url);
  const res = json?.chart?.result?.[0];
  if (!res) {
    const err = json?.chart?.error?.description || `HTTP ${status}`;
    if (status === 404 || /no data|delisted|not found/i.test(err)) throw new NoDataError(`${symbol}: ${err}`);
    throw new Error(`${symbol}: ${err}`);
  }
  const ts: number[] = res.timestamp ?? [];
  const q = res.indicators?.quote?.[0] ?? {};
  const adj: (number | null)[] | undefined = res.indicators?.adjclose?.[0]?.adjclose;

  // Collapse to one bar per IST date (Yahoo sometimes emits a live bar
  // stamped "now" next to today's daily bar) — the later one wins.
  const byDate = new Map<string, number>();
  ts.forEach((t, i) => byDate.set(istDateFromEpoch(t), i));
  const bars: Bars = { dates: [], open: [], high: [], low: [], close: [], volume: [] };
  for (const [date, i] of byDate) {
    const c = q.close?.[i];
    if (c == null || Number.isNaN(c)) continue;          // _clean_history
    const ratio = adj && adj[i] != null && c ? (adj[i] as number) / c : 1;
    bars.dates.push(date);
    bars.open.push((q.open?.[i] ?? c) * ratio);
    bars.high.push((q.high?.[i] ?? c) * ratio);
    bars.low.push((q.low?.[i] ?? c) * ratio);
    bars.close.push(c * ratio);
    bars.volume.push(q.volume?.[i] ?? 0);
  }
  if (!bars.dates.length) throw new NoDataError(`No price data returned for ${symbol}`);

  const divs: Dividend[] = Object.values(res.events?.dividends ?? {})
    .map((d: any) => ({ date: istDateFromEpoch(d.date), amount: Number(d.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return { bars, dividends: divs };
}

// ── quoteSummary (needs Yahoo's cookie + crumb handshake) ────────────────────
let crumb: string | null = null;
let crumbAt = 0;
let crumbFlight: Promise<string> | null = null;

/** Single-flight: concurrent callers share one handshake, or their cookies clobber each other. */
function getCrumb(force = false, stale?: string): Promise<string> {
  if (crumb && !force && Date.now() - crumbAt < 6 * 3600_000) return Promise.resolve(crumb);
  if (force && crumb && stale !== crumb) return Promise.resolve(crumb);   // someone already refreshed
  crumbFlight ??= fetchCrumb().finally(() => { crumbFlight = null; });
  return crumbFlight;
}

async function fetchCrumb(): Promise<string> {
  const p = platform();
  // fc.yahoo.com answers 404 but sets the A3 cookie the crumb endpoint wants;
  // the native cookie jar keeps it for the calls below.
  await p.http({ url: "https://fc.yahoo.com", headers: HEADERS, timeoutMs: 15000 }).catch(() => null);
  const r = await p.http({ url: "https://query1.finance.yahoo.com/v1/test/getcrumb", headers: HEADERS, timeoutMs: 15000 });
  if (r.status !== 200 || !r.body || r.body.length > 40 || r.body.includes("<")) {
    throw new Error(`Yahoo crumb unavailable (HTTP ${r.status})`);
  }
  crumb = r.body.trim();
  crumbAt = Date.now();
  return crumb;
}

export async function quoteSummary(symbol: string, modules: string[]): Promise<any> {
  let used: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getCrumb(attempt > 0, used);
    used = c;
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
      `?modules=${modules.join("%2C")}&crumb=${encodeURIComponent(c)}`;
    const { status, json } = await getJson(url);
    if (status === 401 || status === 403) {
      log("warn", `quoteSummary ${symbol}: HTTP ${status} — refreshing crumb`);
      continue;
    }
    const res = json?.quoteSummary?.result?.[0];
    if (!res) {
      const err = json?.quoteSummary?.error?.description || `HTTP ${status}`;
      throw new Error(`${symbol}: ${err}`);
    }
    return res;
  }
  throw new Error(`${symbol}: Yahoo refused the crumb`);
}

const raw = (v: any): number | null => {
  const x = v && typeof v === "object" ? v.raw : v;
  return typeof x === "number" && Number.isFinite(x) ? x : null;
};

/** The subset of yfinance's Ticker.info the scorer reads. */
export async function info(symbol: string): Promise<Record<string, number | null>> {
  const r = await quoteSummary(symbol, ["summaryDetail", "defaultKeyStatistics", "financialData"]);
  const sd = r.summaryDetail ?? {}, ks = r.defaultKeyStatistics ?? {}, fd = r.financialData ?? {};
  return {
    trailingPE: raw(sd.trailingPE),
    priceToBook: raw(ks.priceToBook),
    returnOnEquity: raw(fd.returnOnEquity),
    debtToEquity: raw(fd.debtToEquity),
    revenueGrowth: raw(fd.revenueGrowth),
    profitMargins: raw(ks.profitMargins) ?? raw(fd.profitMargins),
    // Yahoo's raw value is a fraction (0.012 = 1.2%), which the scorer expects.
    dividendYield: raw(sd.dividendYield),
  };
}

/** Ticker.calendar → next earnings date and ex-dividend date (YYYY-MM-DD). */
export async function calendar(symbol: string): Promise<{ earnings: string | null; exDividend: string | null }> {
  const r = await quoteSummary(symbol, ["calendarEvents"]);
  const ce = r.calendarEvents ?? {};
  const ed = ce.earnings?.earningsDate?.[0];
  const e = raw(ed);
  const x = raw(ce.exDividendDate);
  return {
    earnings: e ? istDateFromEpoch(e) : null,
    exDividend: x ? istDateFromEpoch(x) : null,
  };
}
