/**
 * Python semantics the port depends on: round()/format() rounding (exact
 * ties go to even), format-spec strings like "+.2f", ",.0f", ".1%", "g",
 * and a few list helpers. Reasons and verdict strings are user-facing, so
 * the phone must print exactly what the laptop prints.
 */

function isExactTie(x: number, digits: number): boolean {
  const scaled = Math.abs(x) * 10 ** digits;
  return scaled % 1 === 0.5 && scaled / 10 ** digits === Math.abs(x);
}

/** Python's f"{x:.{digits}f}" without sign/grouping. */
function fixed(x: number, digits: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  if (isExactTie(x, digits)) {
    const scaled = Math.abs(x) * 10 ** digits;
    const down = Math.floor(scaled);
    const even = down % 2 === 0 ? down : down + 1;
    const s = (even / 10 ** digits).toFixed(digits);
    return x < 0 && even !== 0 ? `-${s}` : s;
  }
  const s = x.toFixed(digits);
  // toFixed keeps "-0.00"; Python does too, so leave it.
  return s;
}

/** Python round(x, n). */
export function pyRound(x: number, digits = 0): number {
  if (!Number.isFinite(x)) return x;
  return Number(fixed(x, digits));
}

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function general(x: number, precision = 6): string {
  if (x === 0) return Object.is(x, -0) ? "-0" : "0";
  if (!Number.isFinite(x)) return Number.isNaN(x) ? "nan" : x > 0 ? "inf" : "-inf";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= precision) {
    let [mant, e] = x.toExponential(precision - 1).split("e");
    if (mant.includes(".")) mant = mant.replace(/0+$/, "").replace(/\.$/, "");
    const en = Number(e);
    return `${mant}e${en < 0 ? "-" : "+"}${String(Math.abs(en)).padStart(2, "0")}`;
  }
  let s = x.toFixed(Math.max(0, precision - 1 - exp));
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/**
 * format(x, spec) for the spec subset used by the backend:
 *   [+][,][.N](f|%|g|d)   e.g. "+.2f", ",.0f", ".1%", "+.0%", "g", "+,"
 */
export function fmt(x: number, spec: string): string {
  const m = /^([+ ])?(,)?(?:\.(\d+))?([fgd%])?$/.exec(spec);
  if (!m) throw new Error(`Unsupported format spec: ${spec}`);
  const [, sign, comma, precStr, typeRaw] = m;
  const type = typeRaw ?? (Number.isInteger(x) ? "d" : "g");
  let body: string;
  if (type === "%") body = fixed(x * 100, precStr ? Number(precStr) : 6) + "%";
  else if (type === "f") body = fixed(x, precStr ? Number(precStr) : 6);
  else if (type === "d") body = fixed(x, 0);
  else body = general(x, precStr ? Number(precStr) : 6);

  let neg = body.startsWith("-");
  if (neg) body = body.slice(1);
  if (comma) {
    const [ip, ...rest] = body.split(/(?=[.%e])/);
    body = group(ip) + rest.join("");
  }
  if (neg) return `-${body}`;
  if (sign === "+") return `+${body}`;
  if (sign === " ") return ` ${body}`;
  return body;
}

/** Rupee helpers that mirror f"₹{x:,.0f}" / f"₹{x:,.2f}". */
export const inr0 = (x: number) => `₹${fmt(x, ",.0f")}`;
export const inr2 = (x: number) => `₹${fmt(x, ",.2f")}`;

export function sum(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s;
}

export function mean(xs: number[]): number {
  return xs.length ? sum(xs) / xs.length : NaN;
}

/** Python sorted(..., key) is stable; Array.prototype.sort is stable too. */
export function sortBy<T>(xs: T[], key: (x: T) => number | string, reverse = false): T[] {
  const out = [...xs];
  out.sort((a, b) => {
    const ka = key(a), kb = key(b);
    const c = ka < kb ? -1 : ka > kb ? 1 : 0;
    return reverse ? -c : c;
  });
  return out;
}

/** max(xs, key=...) — first maximal element, like Python. */
export function maxBy<T>(xs: T[], key: (x: T) => number): T {
  let best = xs[0], bk = key(xs[0]);
  for (let i = 1; i < xs.length; i++) {
    const k = key(xs[i]);
    if (k > bk) { best = xs[i]; bk = k; }
  }
  return best;
}

export function minBy<T>(xs: T[], key: (x: T) => number): T {
  let best = xs[0], bk = key(xs[0]);
  for (let i = 1; i < xs.length; i++) {
    const k = key(xs[i]);
    if (k < bk) { best = xs[i]; bk = k; }
  }
  return best;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** HTTP-style error a route can throw; the adapter turns it into {detail}. */
export class HttpError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isNaN(v) ? null : v;
  const n = Number(String(v).replace(/,/g, "").trim());
  return Number.isNaN(n) ? null : n;
}
