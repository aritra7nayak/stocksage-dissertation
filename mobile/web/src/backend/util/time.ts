/**
 * IST clock helpers. India has no DST, so IST is a fixed UTC+05:30 offset —
 * no timezone database needed on the phone.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;

export interface IstParts {
  date: string;          // YYYY-MM-DD
  hour: number;
  minute: number;
  weekday: number;       // Python convention: Mon=0 … Sun=6
}

export function istParts(at: Date = new Date()): IstParts {
  const t = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    date: t.toISOString().slice(0, 10),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    weekday: (t.getUTCDay() + 6) % 7,
  };
}

export function todayIst(): string {
  return istParts().date;
}

/** NSE hours: 09:15–15:30 IST, Mon–Fri (holidays not modeled, like the server). */
export function isMarketOpenIst(at: Date = new Date()): boolean {
  const p = istParts(at);
  if (p.weekday >= 5) return false;
  const m = p.hour * 60 + p.minute;
  return m >= 9 * 60 + 15 && m <= 15 * 60 + 30;
}

/** UTC instant (ISO) of today's IST midnight — "fetched today" filters. */
export function todayStartUtcIso(): string {
  const d = todayIst();
  return new Date(Date.parse(`${d}T00:00:00Z`) - IST_OFFSET_MS).toISOString();
}

/** IST calendar date of a UTC epoch (seconds). */
export function istDateFromEpoch(sec: number): string {
  return new Date(sec * 1000 + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Python weekday() for a YYYY-MM-DD date. */
export function weekdayOf(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** Epoch ms of HH:MM IST on a given IST date. */
export function istInstant(date: string, hour: number, minute: number): number {
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`) - IST_OFFSET_MS;
}

/** datetime.now(IST).isoformat() — e.g. 2026-10-12T08:30:01.123456+05:30 */
export function nowIstIso(): string {
  const t = new Date(Date.now() + IST_OFFSET_MS).toISOString().replace("Z", "");
  return `${t}+05:30`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 13-Oct-2026 ⇄ 2026-10-13 (NSE expiry format). */
export function fmtExpiry(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
}

export function parseExpiry(s: string): string {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s.trim());
  if (!m) throw new Error(`Bad expiry: ${s}`);
  const mi = MONTHS.findIndex((x) => x.toLowerCase() === m[2].toLowerCase());
  if (mi < 0) throw new Error(`Bad expiry: ${s}`);
  return `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

/** 12-Oct-2026 14:05:09 (NSE-style timestamp, IST). */
export function nseTimestamp(at: Date = new Date()): string {
  const t = new Date(at.getTime() + IST_OFFSET_MS).toISOString();
  return `${fmtExpiry(t.slice(0, 10))} ${t.slice(11, 19)}`;
}

/** DD_MM_YY for export filenames. */
export function ddmmyy(date: string): string {
  const [y, m, d] = date.split("-");
  return `${d}_${m}_${y.slice(2)}`;
}
