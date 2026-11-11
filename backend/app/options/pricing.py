"""Black-Scholes(-Merton) pricing, Greeks and probabilities — pure math, no I/O.

NSE index and stock options are European-style, so Black-Scholes is the right
model. `q` is a continuous carry yield (dividends / futures basis). Rather
than guess it, analysis.py backs it out of put-call parity at the money, so
calls and puts are priced off the same forward the market is using — without
it, every put looks a little cheap and every call a little dear.

Time is in YEARS of calendar days, matching how NSE quotes implied volatility.
Scalar functions use math.erf. `bs_price_vec` is the numpy twin used by the
Monte Carlo, with an erf approximation accurate to ~1e-7.
"""
import math

import numpy as np

RISK_FREE = 0.06          # ~91-day T-bill; a 1% error here moves premiums by pennies
_SQRT2 = math.sqrt(2.0)


def ncdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / _SQRT2))


def npdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _d1_d2(S: float, K: float, T: float, sigma: float, r: float, q: float) -> tuple[float, float]:
    vt = sigma * math.sqrt(T)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vt
    return d1, d1 - vt


def bs_price(S: float, K: float, T: float, sigma: float, kind: str,
             r: float = RISK_FREE, q: float = 0.0) -> float:
    """Option fair value. kind is 'CE' or 'PE'. At/after expiry → intrinsic."""
    if T <= 0 or sigma <= 0:
        return max(0.0, S - K) if kind == "CE" else max(0.0, K - S)
    d1, d2 = _d1_d2(S, K, T, sigma, r, q)
    df_r, df_q = math.exp(-r * T), math.exp(-q * T)
    if kind == "CE":
        return S * df_q * ncdf(d1) - K * df_r * ncdf(d2)
    return K * df_r * ncdf(-d2) - S * df_q * ncdf(-d1)


def greeks(S: float, K: float, T: float, sigma: float, kind: str,
           r: float = RISK_FREE, q: float = 0.0) -> dict:
    """Delta, gamma, theta (₹ per calendar day) and vega (₹ per 1 IV point)."""
    if T <= 0 or sigma <= 0:
        itm = (S > K) if kind == "CE" else (S < K)
        return {"delta": (1.0 if itm else 0.0) * (1 if kind == "CE" else -1),
                "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    d1, d2 = _d1_d2(S, K, T, sigma, r, q)
    df_r, df_q = math.exp(-r * T), math.exp(-q * T)
    gamma = df_q * npdf(d1) / (S * sigma * math.sqrt(T))
    vega = S * df_q * npdf(d1) * math.sqrt(T) / 100.0
    decay = -S * df_q * npdf(d1) * sigma / (2 * math.sqrt(T))
    if kind == "CE":
        delta = df_q * ncdf(d1)
        theta = decay - r * K * df_r * ncdf(d2) + q * S * df_q * ncdf(d1)
    else:
        delta = df_q * (ncdf(d1) - 1.0)
        theta = decay + r * K * df_r * ncdf(-d2) - q * S * df_q * ncdf(-d1)
    return {"delta": delta, "gamma": gamma, "theta": theta / 365.0, "vega": vega}


def implied_vol(price: float, S: float, K: float, T: float, kind: str,
                r: float = RISK_FREE, q: float = 0.0) -> float | None:
    """Bisection IV solve. None when the price is below intrinsic or unsolvable."""
    if price <= 0 or T <= 0:
        return None
    if price < bs_price(S, K, T, 1e-4, kind, r, q) - 1e-6:   # below discounted intrinsic
        return None
    lo, hi = 0.005, 4.0
    if bs_price(S, K, T, hi, kind, r, q) < price:
        return None
    for _ in range(80):
        mid = 0.5 * (lo + hi)
        if bs_price(S, K, T, mid, kind, r, q) > price:
            hi = mid
        else:
            lo = mid
    return 0.5 * (lo + hi)


def prob_finish_above(S: float, level: float, T: float, sigma: float,
                      r: float = RISK_FREE, q: float = 0.0) -> float:
    """Lognormal (risk-neutral) probability that the underlying ends above `level`."""
    if T <= 0 or sigma <= 0:
        return 1.0 if S > level else 0.0
    _, d2 = _d1_d2(S, level, T, sigma, r, q)
    return ncdf(d2)


# ── Vectorised twin for Monte Carlo repricing ────────────────────────────────

def _erf_vec(x: np.ndarray) -> np.ndarray:
    """Abramowitz–Stegun 7.1.26 (|error| < 1.5e-7) — numpy has no erf."""
    sign = np.sign(x)
    a = np.abs(x)
    t = 1.0 / (1.0 + 0.3275911 * a)
    y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t
                - 0.284496736) * t + 0.254829592) * t * np.exp(-a * a)
    return sign * y


def _ncdf_vec(x: np.ndarray) -> np.ndarray:
    return 0.5 * (1.0 + _erf_vec(x / _SQRT2))


def bs_price_vec(S: np.ndarray, K: float, T: np.ndarray | float, sigma: float, kind: str,
                 r: float = RISK_FREE, q: float = 0.0) -> np.ndarray:
    """Element-wise price; T may be an array (paths exiting at different times)."""
    S = np.asarray(S, dtype=float)
    T = np.broadcast_to(np.asarray(T, dtype=float), S.shape)
    intrinsic = np.maximum(0.0, S - K) if kind == "CE" else np.maximum(0.0, K - S)
    if sigma <= 0:
        return intrinsic
    Tp = np.maximum(T, 1e-9)
    vt = sigma * np.sqrt(Tp)
    d1 = (np.log(S / K) + (r - q + 0.5 * sigma * sigma) * Tp) / vt
    d2 = d1 - vt
    df_r, df_q = np.exp(-r * Tp), np.exp(-q * Tp)
    if kind == "CE":
        val = S * df_q * _ncdf_vec(d1) - K * df_r * _ncdf_vec(d2)
    else:
        val = K * df_r * _ncdf_vec(-d2) - S * df_q * _ncdf_vec(-d1)
    return np.where(T <= 0, intrinsic, val)
