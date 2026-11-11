// Black-Scholes-Merton for the options scenario lab — the same model the
// backend uses (backend/app/options/pricing.py), so a slider move here
// reprices exactly as the server's projections do. q is the market's implied
// carry yield, returned by the API as `carry_q`.

const erf = (x: number) => {
  // Abramowitz–Stegun 7.1.26, |error| < 1.5e-7
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const ncdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
const npdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

export type Kind = "CE" | "PE";

export function bsPrice(S: number, K: number, T: number, sigma: number, kind: Kind, r: number, q: number) {
  if (T <= 0 || sigma <= 0) return kind === "CE" ? Math.max(0, S - K) : Math.max(0, K - S);
  const vt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt;
  const d2 = d1 - vt;
  const dr = Math.exp(-r * T), dq = Math.exp(-q * T);
  return kind === "CE" ? S * dq * ncdf(d1) - K * dr * ncdf(d2) : K * dr * ncdf(-d2) - S * dq * ncdf(-d1);
}

export function bsGreeks(S: number, K: number, T: number, sigma: number, kind: Kind, r: number, q: number) {
  if (T <= 0 || sigma <= 0) {
    const itm = kind === "CE" ? S > K : S < K;
    return { delta: (itm ? 1 : 0) * (kind === "CE" ? 1 : -1), gamma: 0, theta: 0, vega: 0 };
  }
  const vt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt;
  const d2 = d1 - vt;
  const dr = Math.exp(-r * T), dq = Math.exp(-q * T);
  const gamma = (dq * npdf(d1)) / (S * vt);
  const vega = (S * dq * npdf(d1) * Math.sqrt(T)) / 100;
  const decay = (-S * dq * npdf(d1) * sigma) / (2 * Math.sqrt(T));
  const theta = kind === "CE"
    ? decay - r * K * dr * ncdf(d2) + q * S * dq * ncdf(d1)
    : decay + r * K * dr * ncdf(-d2) - q * S * dq * ncdf(-d1);
  const delta = kind === "CE" ? dq * ncdf(d1) : dq * (ncdf(d1) - 1);
  return { delta, gamma, theta: theta / 365, vega };
}
