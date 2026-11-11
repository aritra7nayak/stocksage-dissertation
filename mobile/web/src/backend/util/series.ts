/**
 * pandas Series semantics on plain arrays (NaN = missing). Only what the
 * indicator code uses, implemented to match pandas exactly:
 *   ewm(...).mean()  — adjust True/False, ignore_na=False, min_periods
 *   rolling(n, min_periods).mean/std/max/min — NaNs skipped, std ddof=1
 */
export type Series = number[];

const isNum = (x: number) => !Number.isNaN(x);

export function diff(s: Series): Series {
  return s.map((x, i) => (i === 0 ? NaN : x - s[i - 1]));
}

export function shift(s: Series, n = 1): Series {
  return s.map((_, i) => (i - n >= 0 && i - n < s.length ? s[i - n] : NaN));
}

export function pctChange(s: Series): Series {
  return s.map((x, i) => (i === 0 ? NaN : x / s[i - 1] - 1));
}

export interface EwmOpts { alpha?: number; span?: number; adjust?: boolean; minPeriods?: number }

/** pandas ewm(...).mean() with ignore_na=False. */
export function ewm(s: Series, o: EwmOpts): Series {
  const alpha = o.alpha ?? 2 / ((o.span as number) + 1);
  const adjust = o.adjust ?? true;
  const minp = Math.max(o.minPeriods ?? 0, 1);
  const oldWtFactor = 1 - alpha;
  const newWt = adjust ? 1 : alpha;
  const out: Series = new Array(s.length);
  let weighted = NaN;
  let oldWt = 1;
  let nobs = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = s[i];
    const isObs = isNum(cur);
    if (isObs) nobs++;
    if (isNum(weighted)) {
      oldWt *= oldWtFactor;   // ignore_na=False: decay even across NaNs
      if (isObs) {
        if (weighted !== cur) weighted = (oldWt * weighted + newWt * cur) / (oldWt + newWt);
        if (adjust) oldWt += newWt;
        else oldWt = 1;
      }
    } else if (isObs) {
      weighted = cur;
    }
    out[i] = nobs >= minp ? weighted : NaN;
  }
  return out;
}

function windowVals(s: Series, i: number, n: number): number[] {
  const out: number[] = [];
  for (let k = Math.max(0, i - n + 1); k <= i; k++) if (isNum(s[k])) out.push(s[k]);
  return out;
}

export function rollingMean(s: Series, n: number, minPeriods = n): Series {
  return s.map((_, i) => {
    const w = windowVals(s, i, n);
    return w.length >= minPeriods && w.length ? w.reduce((a, b) => a + b, 0) / w.length : NaN;
  });
}

export function rollingStd(s: Series, n: number, minPeriods = n): Series {
  return s.map((_, i) => {
    const w = windowVals(s, i, n);
    return w.length >= Math.max(minPeriods, 2) ? std(w) : NaN;
  });
}

export function rollingMax(s: Series, n: number, minPeriods = n): Series {
  return s.map((_, i) => {
    const w = windowVals(s, i, n);
    return w.length >= minPeriods && w.length ? Math.max(...w) : NaN;
  });
}

export function rollingMin(s: Series, n: number, minPeriods = n): Series {
  return s.map((_, i) => {
    const w = windowVals(s, i, n);
    return w.length >= minPeriods && w.length ? Math.min(...w) : NaN;
  });
}

/** Sample standard deviation (ddof=1), NaNs skipped — Series.std(). */
export function std(xs: number[]): number {
  const v = xs.filter(isNum);
  if (v.length < 2) return NaN;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  let ss = 0;
  for (const x of v) ss += (x - m) ** 2;
  return Math.sqrt(ss / (v.length - 1));
}

/** Sample variance (ddof=1). */
export function variance(xs: number[]): number {
  const s = std(xs);
  return s * s;
}

/** Sample covariance (ddof=1) of two equal-length arrays. */
export function cov(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 2) return NaN;
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (n - 1);
}

export function last(s: Series, k = 1): number {
  return s[s.length - k];
}

export function median(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
