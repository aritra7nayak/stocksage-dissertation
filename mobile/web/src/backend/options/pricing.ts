/**
 * Black-Scholes(-Merton) pricing, Greeks, IV and probabilities —
 * app/options/pricing.py. European options, carry yield q, time in years of
 * calendar days. Scalar functions use a full-precision erf; the vector twin
 * used by the Monte Carlo keeps the Abramowitz–Stegun approximation the
 * server uses, so simulated values line up.
 */
export const RISK_FREE = 0.06;
const SQRT2 = Math.SQRT2;

/** erf to ~1e-15: positive-term series below 3, continued fraction above. */
export function erf(x: number): number {
  const ax = Math.abs(x);
  let r: number;
  if (ax < 3) {
    const x2 = ax * ax;
    let term = ax, s = ax;
    for (let n = 1; n < 300; n++) {
      term *= (2 * x2) / (2 * n + 1);
      s += term;
      if (term < s * 1e-17) break;
    }
    r = (2 / Math.sqrt(Math.PI)) * Math.exp(-x2) * s;
  } else {
    let f = ax;
    for (let k = 80; k >= 1; k--) f = ax + k / 2 / f;
    r = 1 - Math.exp(-ax * ax) / Math.sqrt(Math.PI) / f;
  }
  return x < 0 ? -r : r;
}

export const ncdf = (x: number) => 0.5 * (1 + erf(x / SQRT2));
export const npdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

function d1d2(S: number, K: number, T: number, sigma: number, r: number, q: number): [number, number] {
  const vt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt;
  return [d1, d1 - vt];
}

export function bsPrice(S: number, K: number, T: number, sigma: number, kind: string, r = RISK_FREE, q = 0): number {
  if (T <= 0 || sigma <= 0) return kind === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  const [d1, d2] = d1d2(S, K, T, sigma, r, q);
  const dfr = Math.exp(-r * T), dfq = Math.exp(-q * T);
  return kind === "CE" ? S * dfq * ncdf(d1) - K * dfr * ncdf(d2) : K * dfr * ncdf(-d2) - S * dfq * ncdf(-d1);
}

export function greeks(S: number, K: number, T: number, sigma: number, kind: string, r = RISK_FREE, q = 0) {
  if (T <= 0 || sigma <= 0) {
    const itm = kind === "CE" ? S > K : S < K;
    return { delta: (itm ? 1 : 0) * (kind === "CE" ? 1 : -1), gamma: 0, theta: 0, vega: 0 };
  }
  const [d1, d2] = d1d2(S, K, T, sigma, r, q);
  const dfr = Math.exp(-r * T), dfq = Math.exp(-q * T);
  const gamma = (dfq * npdf(d1)) / (S * sigma * Math.sqrt(T));
  const vega = (S * dfq * npdf(d1) * Math.sqrt(T)) / 100;
  const decay = (-S * dfq * npdf(d1) * sigma) / (2 * Math.sqrt(T));
  let delta: number, theta: number;
  if (kind === "CE") {
    delta = dfq * ncdf(d1);
    theta = decay - r * K * dfr * ncdf(d2) + q * S * dfq * ncdf(d1);
  } else {
    delta = dfq * (ncdf(d1) - 1);
    theta = decay + r * K * dfr * ncdf(-d2) - q * S * dfq * ncdf(-d1);
  }
  return { delta, gamma, theta: theta / 365, vega };
}

export function impliedVol(price: number, S: number, K: number, T: number, kind: string, r = RISK_FREE, q = 0): number | null {
  if (price <= 0 || T <= 0) return null;
  if (price < bsPrice(S, K, T, 1e-4, kind, r, q) - 1e-6) return null;
  let lo = 0.005, hi = 4.0;
  if (bsPrice(S, K, T, hi, kind, r, q) < price) return null;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (bsPrice(S, K, T, mid, kind, r, q) > price) hi = mid;
    else lo = mid;
  }
  return 0.5 * (lo + hi);
}

export function probFinishAbove(S: number, level: number, T: number, sigma: number, r = RISK_FREE, q = 0): number {
  if (T <= 0 || sigma <= 0) return S > level ? 1 : 0;
  return ncdf(d1d2(S, level, T, sigma, r, q)[1]);
}

/** Abramowitz–Stegun 7.1.26, as numpy's _erf_vec. */
function erfAs(x: number): number {
  const sign = Math.sign(x), a = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return sign * y;
}

const ncdfAs = (x: number) => 0.5 * (1 + erfAs(x / SQRT2));

/** Element-wise twin used by the Monte Carlo (paths exit at different times). */
export function bsPriceVec(S: number[], K: number, T: number[], sigma: number, kind: string, r = RISK_FREE, q = 0): number[] {
  return S.map((s, i) => {
    const intrinsic = kind === "CE" ? Math.max(0, s - K) : Math.max(0, K - s);
    if (sigma <= 0 || T[i] <= 0) return intrinsic;
    const Tp = Math.max(T[i], 1e-9);
    const vt = sigma * Math.sqrt(Tp);
    const d1 = (Math.log(s / K) + (r - q + 0.5 * sigma * sigma) * Tp) / vt;
    const d2 = d1 - vt;
    const dfr = Math.exp(-r * Tp), dfq = Math.exp(-q * Tp);
    return kind === "CE" ? s * dfq * ncdfAs(d1) - K * dfr * ncdfAs(d2) : K * dfr * ncdfAs(-d2) - s * dfq * ncdfAs(-d1);
  });
}
