"""Option-BUYER analysis engine — pure functions, no I/O (router.py feeds it).

The question it answers: "Should I buy a CALL, a PUT, or nothing — which
contract, and what can I realistically expect?" Buying options has two
enemies besides being wrong on direction: time decay and overpriced
volatility. So the verdict rests on two independent scores:

  DIRECTION  (−100 bearish … +100 bullish)
      technicals 35% · option-chain flow 30% · news sentiment 20% · market context 15%
  BUYER SUITABILITY  (0–100) — is this a good moment to pay premium at all?
      IV vs realised vol 25% · trend strength 25% · time to expiry 20% ·
      liquidity 15% · event risk 15%

Every factor carries its weight, raw value and a plain-English reason. A
factor whose data is missing (no OI on a modeled chain, no headlines) is
marked unavailable and the remaining weights are re-normalised.

Expected returns come from a Monte Carlo of the underlying over the holding
window, repricing the option with Black-Scholes at each exit and paying the
bid/ask spread. Two scenarios are reported side by side:
  • "No edge"     — zero drift. What buying this option is worth if the
                    analysis is no better than a coin flip (usually < 0).
  • "Signal view" — the direction score tilts the drift by up to half a
                    standard deviation of the holding-window move.
"""
import math
from datetime import date, datetime, time as dtime

import numpy as np
import pandas as pd

from app.options import pricing

# Score thresholds for the verdict
MIN_DIRECTION = 20       # |direction| below this = no edge, stay out
MIN_SUITABILITY = 40     # below this, conditions are hostile to buyers

N_PATHS = 4000


def _clamp(x: float, lo: float = -1.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _r(x: float | None, nd: int = 2) -> float | None:
    return None if x is None or (isinstance(x, float) and math.isnan(x)) else round(float(x), nd)


# ── Time & volatility ────────────────────────────────────────────────────────

def time_to_expiry(expiry: date, now: datetime, tz) -> tuple[float, float]:
    """(years, calendar days) until 15:30 on expiry day. `tz` is the pytz IST zone."""
    exp_dt = tz.localize(datetime.combine(expiry, dtime(15, 30)))
    days = max((exp_dt - now).total_seconds() / 86400, 1 / 24)   # floor at 1 hour
    return days / 365.0, days


def realised_vol(close: pd.Series, n: int = 20) -> float:
    r = np.log(close / close.shift(1)).dropna()
    return float(r.iloc[-n:].std() * math.sqrt(252)) if len(r) >= n else float("nan")


def hv_percentile(close: pd.Series, n: int = 20) -> float | None:
    """Where today's 20-day realised vol sits within its own past year (0–100)."""
    r = np.log(close / close.shift(1)).dropna()
    roll = r.rolling(n).std().dropna() * math.sqrt(252)
    if len(roll) < 60:
        return None
    window = roll.iloc[-252:]
    return round(float((window < window.iloc[-1]).mean() * 100), 1)


# ── Option-chain metrics ─────────────────────────────────────────────────────

def implied_carry(rows: list[dict], spot: float, T: float) -> tuple[float, float]:
    """(q, forward) from put-call parity: F = K + (C − P)·e^{rT}, median over
    the 3 quoted strikes nearest spot. q is the carry yield that makes
    S·e^{(r−q)T} = F; clamped because a stale quote on a 1-day expiry can
    otherwise imply an absurd yield."""
    def mid(leg):
        if not leg:
            return None
        if leg["bid"] > 0 and leg["ask"] > 0:
            return (leg["bid"] + leg["ask"]) / 2
        return leg["ltp"] or None
    fwds = []
    for r in sorted(rows, key=lambda r: abs(r["strike"] - spot))[:3]:
        c, p = mid(r.get("ce")), mid(r.get("pe"))
        if c and p:
            fwds.append(r["strike"] + (c - p) * math.exp(pricing.RISK_FREE * T))
    if not fwds or T <= 0:
        return 0.0, spot * math.exp(pricing.RISK_FREE * T)
    F = float(np.median(fwds))
    q = _clamp(pricing.RISK_FREE - math.log(F / spot) / T, -0.3, 0.3)
    return q, F


def _leg_iv(row: dict, kind: str, spot: float, T: float, q: float = 0.0) -> float | None:
    leg = row.get("ce" if kind == "CE" else "pe")
    if not leg:
        return None
    if leg.get("iv"):
        return leg["iv"]
    return pricing.implied_vol(leg["ltp"], spot, row["strike"], T, kind, q=q) if leg["ltp"] > 0 else None


def chain_metrics(rows: list[dict], spot: float, T: float, has_oi: bool, q: float = 0.0) -> dict:
    """PCR, max pain, OI walls, ATM IV, skew, expected move, and OI-flow balance."""
    strikes = [r["strike"] for r in rows]
    atm_i = min(range(len(rows)), key=lambda i: abs(strikes[i] - spot))
    atm = rows[atm_i]

    ivs = [v for v in (_leg_iv(atm, "CE", spot, T, q), _leg_iv(atm, "PE", spot, T, q)) if v]
    atm_iv = sum(ivs) / len(ivs) if ivs else None

    ce_ltp = (atm.get("ce") or {}).get("ltp") or 0
    pe_ltp = (atm.get("pe") or {}).get("ltp") or 0
    straddle = ce_ltp + pe_ltp if ce_ltp and pe_ltp else None
    sigma_move = spot * atm_iv * math.sqrt(T) if atm_iv else None
    exp_move = straddle or sigma_move

    out: dict = {
        "atm_strike": atm["strike"], "atm_iv": _r(atm_iv * 100 if atm_iv else None, 2),
        "straddle": _r(straddle), "expected_move": _r(exp_move),
        "expected_move_pct": _r(exp_move / spot * 100 if exp_move else None),
        "range_low": _r(spot - exp_move if exp_move else None),
        "range_high": _r(spot + exp_move if exp_move else None),
        "has_oi": has_oi,
    }

    # Skew: put IV vs call IV ~one expected move out of the money (vol points)
    m = max((exp_move or spot * 0.02) / spot, 0.01)
    p_row = min(rows, key=lambda r: abs(r["strike"] - spot * (1 - m)))
    c_row = min(rows, key=lambda r: abs(r["strike"] - spot * (1 + m)))
    p_iv, c_iv = _leg_iv(p_row, "PE", spot, T, q), _leg_iv(c_row, "CE", spot, T, q)
    # A modeled chain (no OI) is priced at one flat IV, so its skew is meaningless
    out["skew"] = _r((p_iv - c_iv) * 100 if has_oi and p_iv and c_iv else None)

    if not has_oi:
        out.update({"pcr_oi": None, "pcr_volume": None, "max_pain": None,
                    "support": None, "resistance": None, "flow_balance": None,
                    "support_levels": [], "resistance_levels": [],
                    "total_ce_oi": None, "total_pe_oi": None,
                    "chg_ce_oi": None, "chg_pe_oi": None})
        return out

    g = lambda r, k, f: (r.get(k) or {}).get(f, 0) or 0  # noqa: E731
    tot_ce = sum(g(r, "ce", "oi") for r in rows)
    tot_pe = sum(g(r, "pe", "oi") for r in rows)
    vol_ce = sum(g(r, "ce", "volume") for r in rows)
    vol_pe = sum(g(r, "pe", "volume") for r in rows)

    # Max pain: the expiry price at which option holders collectively lose most
    def payout(px: float) -> float:
        return sum(g(r, "ce", "oi") * max(0.0, px - r["strike"])
                   + g(r, "pe", "oi") * max(0.0, r["strike"] - px) for r in rows)
    max_pain = min(strikes, key=payout)

    below = sorted((r for r in rows if r["strike"] < spot), key=lambda r: -g(r, "pe", "oi"))
    above = sorted((r for r in rows if r["strike"] > spot), key=lambda r: -g(r, "ce", "oi"))
    support = below[0]["strike"] if below and g(below[0], "pe", "oi") else None
    resistance = above[0]["strike"] if above and g(above[0], "ce", "oi") else None

    # Fresh writing near the money: put writers are bullish, call writers bearish
    near = rows[max(0, atm_i - 8): atm_i + 9]
    d_ce = sum(g(r, "ce", "chg_oi") for r in near)
    d_pe = sum(g(r, "pe", "chg_oi") for r in near)
    denom = abs(d_ce) + abs(d_pe)

    out.update({
        "pcr_oi": _r(tot_pe / tot_ce if tot_ce else None, 3),
        "pcr_volume": _r(vol_pe / vol_ce if vol_ce else None, 3),
        "max_pain": max_pain, "support": support, "resistance": resistance,
        "support_levels": [{"strike": r["strike"], "oi": g(r, "pe", "oi")} for r in below[:3]],
        "resistance_levels": [{"strike": r["strike"], "oi": g(r, "ce", "oi")} for r in above[:3]],
        "total_ce_oi": tot_ce, "total_pe_oi": tot_pe,
        "chg_ce_oi": d_ce, "chg_pe_oi": d_pe,
        "flow_balance": _r((d_pe - d_ce) / denom if denom else 0.0, 3),
    })
    return out


# ── Scoring ──────────────────────────────────────────────────────────────────

def _factor(key, group, label, value, weight, detail, available=True) -> dict:
    return {"key": key, "group": group, "label": label,
            "value": round(_clamp(value), 3) if available else 0.0,
            "weight": weight, "detail": detail, "available": available}


def direction_factors(*, tech, close: pd.Series, metrics: dict, spot: float, days: float,
                      sentiment: dict, context: dict) -> list[dict]:
    """Each factor: value in [−1 bearish, +1 bullish] × weight."""
    f: list[dict] = []
    price = float(close.iloc[-1])

    # ── Technicals (35%) ──
    e20, e50 = tech.ema_20, tech.ema_50
    if price > e20 > e50:
        v, d = 1.0, f"Price {price:,.1f} above EMA20 {e20:,.1f} above EMA50 {e50:,.1f} — clean uptrend"
    elif e20 > e50:
        v, d = 0.3, "Uptrend (EMA20 > EMA50) but price slipped under EMA20 — pullback"
    elif price > e20:
        v, d = -0.3, "Bounce above EMA20 inside a downtrend (EMA20 < EMA50)"
    else:
        v, d = -1.0, f"Price below EMA20 {e20:,.1f} and EMA50 {e50:,.1f} — clean downtrend"
    if tech.ema_cross == "GOLDEN":
        v, d = _clamp(v + 0.3), d + "; fresh golden cross"
    elif tech.ema_cross == "DEATH":
        v, d = _clamp(v - 0.3), d + "; fresh death cross"
    f.append(_factor("trend", "Technical", "Trend (EMA 20/50)", v, 0.12, d))

    macd_v = {"BULLISH_CROSS": 1.0, "BEARISH_CROSS": -1.0}.get(
        tech.macd_signal, 0.5 if tech.macd_hist > 0 else -0.5)
    mom_v = _clamp(tech.momentum_20d / 0.06)
    f.append(_factor("momentum", "Technical", "Momentum (MACD + 20d)", 0.6 * macd_v + 0.4 * mom_v, 0.10,
                     f"MACD {tech.macd_signal.replace('_', ' ').lower() if tech.macd_signal != 'NONE' else ('histogram positive' if tech.macd_hist > 0 else 'histogram negative')}; "
                     f"20-day move {tech.momentum_20d * 100:+.1f}%"))

    r = tech.rsi_14
    if r > 75:
        v, d = 0.1, f"RSI {r:.0f} — overbought; upside may be exhausted"
    elif r >= 55:
        v, d = 0.7, f"RSI {r:.0f} — bullish momentum zone"
    elif r >= 45:
        v, d = 0.0, f"RSI {r:.0f} — neutral"
    elif r >= 25:
        v, d = -0.7, f"RSI {r:.0f} — bearish momentum zone"
    else:
        v, d = -0.1, f"RSI {r:.0f} — oversold; a bounce can hurt puts"
    f.append(_factor("rsi", "Technical", "RSI (14)", v, 0.08, d))

    hv = realised_vol(close)
    r5 = float(close.iloc[-1] / close.iloc[-6] - 1) if len(close) > 6 else 0.0
    norm = hv * math.sqrt(5 / 252) if hv and not math.isnan(hv) else 0.03
    f.append(_factor("price_action", "Technical", "Last 5 sessions", r5 / (1.5 * norm), 0.05,
                     f"{r5 * 100:+.2f}% over 5 sessions ({r5 / norm:+.1f}σ)"))

    # ── Option-chain flow (30%) ──
    na = "No live open-interest data (modeled chain)"
    pcr = metrics.get("pcr_oi")
    if pcr is None:
        f.append(_factor("pcr", "Options flow", "Put-Call Ratio (OI)", 0, 0.08, na, False))
    else:
        if pcr > 1.5:
            v, d = 0.3, f"PCR {pcr:.2f} — very heavy put writing; bullish but stretched (contrarian risk)"
        elif pcr > 1.2:
            v, d = 0.7, f"PCR {pcr:.2f} — put writers confident: bullish"
        elif pcr > 1.0:
            v, d = 0.3, f"PCR {pcr:.2f} — mildly bullish"
        elif pcr > 0.8:
            v, d = -0.2, f"PCR {pcr:.2f} — neutral to mildly bearish"
        elif pcr > 0.5:
            v, d = -0.7, f"PCR {pcr:.2f} — call writers dominate: bearish"
        else:
            v, d = -0.3, f"PCR {pcr:.2f} — extreme call writing; bearish but oversold"
        f.append(_factor("pcr", "Options flow", "Put-Call Ratio (OI)", v, 0.08, d))

    fb = metrics.get("flow_balance")
    if fb is None:
        f.append(_factor("oi_flow", "Options flow", "Fresh OI near ATM", 0, 0.08, na, False))
    else:
        dce, dpe = metrics["chg_ce_oi"], metrics["chg_pe_oi"]
        side = "put writing (bullish)" if fb > 0.1 else "call writing (bearish)" if fb < -0.1 else "balanced"
        f.append(_factor("oi_flow", "Options flow", "Fresh OI near ATM", fb, 0.08,
                         f"Δ put OI {dpe:+,} vs Δ call OI {dce:+,} — {side}"))

    sup, res = metrics.get("support"), metrics.get("resistance")
    if sup and res and res > sup:
        pos = (spot - sup) / (res - sup)
        f.append(_factor("sr_room", "Options flow", "Room between OI walls", 1 - 2 * pos, 0.07,
                         f"Spot is {pos * 100:.0f}% of the way from put wall {sup:,.0f} to call wall {res:,.0f}"
                         + (" — more room to rise" if pos < 0.45 else " — more room to fall" if pos > 0.55 else "")))
    else:
        f.append(_factor("sr_room", "Options flow", "Room between OI walls", 0, 0.07, na, False))

    mp, em = metrics.get("max_pain"), metrics.get("expected_move")
    if mp and em:
        pull = (mp - spot) / em * (1.0 if days <= 7 else 0.5)
        f.append(_factor("max_pain", "Options flow", "Max-pain pull", pull, 0.04,
                         f"Max pain {mp:,.0f} is {(mp / spot - 1) * 100:+.2f}% from spot"
                         + ("" if days <= 7 else " (weak pull this far from expiry)")))
    else:
        f.append(_factor("max_pain", "Options flow", "Max-pain pull", 0, 0.04, na, False))

    skew = metrics.get("skew")
    if skew is None:
        f.append(_factor("skew", "Options flow", "Volatility skew", 0, 0.03, "Skew unavailable", False))
    else:
        f.append(_factor("skew", "Options flow", "Volatility skew", -skew / 4, 0.03,
                         f"OTM puts {skew:+.1f} IV points vs OTM calls — "
                         + ("hedging demand / fear" if skew > 1.5 else "call chasing / greed" if skew < -1.5 else "balanced")))

    # ── Sentiment (20%) ──
    n, avg = sentiment["count"], sentiment["avg"]
    if n:
        conf = min(1.0, n / 4)
        f.append(_factor("news", "Sentiment", "FinBERT news sentiment", 1.5 * avg * conf, 0.12,
                         f"{n} relevant headline{'s' if n != 1 else ''}, average {avg:+.2f}"
                         + ("" if conf == 1 else " (few headlines — damped)")))
    else:
        f.append(_factor("news", "Sentiment", "FinBERT news sentiment", 0, 0.12,
                         "No relevant headlines in the last 3 days", False))

    if sentiment.get("market_stopped"):
        f.append(_factor("news_risk", "Sentiment", "Bad-news guard (R12)", -1.0, 0.08,
                         "Systemic bad-news event today — market-wide risk-off"))
    elif sentiment.get("sector_blocked"):
        f.append(_factor("news_risk", "Sentiment", "Bad-news guard (R12)", -0.7, 0.08,
                         "Severe negative news in this sector today"))
    else:
        ma = sentiment.get("market_avg") or 0.0
        f.append(_factor("news_risk", "Sentiment", "Market news tone", 2 * ma * 0.6, 0.08,
                         f"No severe-news blocks; market headline tone {ma:+.2f}"))

    # ── Market context (15%) ──
    for c in context["factors"]:
        f.append(_factor(c["key"], "Market context", c["label"], c["value"], c["weight"], c["detail"]))
    return f


def suitability_factors(*, tech, metrics: dict, hv20: float, days: float,
                        liquidity: dict, event: str | None, vix: float | None) -> list[dict]:
    """Each factor: value in [0 hostile, 1 ideal] for an option BUYER."""
    f: list[dict] = []
    atm_iv = (metrics.get("atm_iv") or 0) / 100
    if atm_iv and hv20 and not math.isnan(hv20):
        ratio = atm_iv / hv20
        v = 1.0 if ratio <= 0.9 else 0.75 if ratio <= 1.1 else 0.45 if ratio <= 1.3 else 0.2 if ratio <= 1.6 else 0.0
        d = (f"IV {atm_iv * 100:.1f}% vs realised {hv20 * 100:.1f}% (×{ratio:.2f}) — "
             + ("options are cheap" if ratio <= 0.9 else "fairly priced" if ratio <= 1.1
                else "premium is rich" if ratio <= 1.3 else "premium is expensive — IV crush risk"))
        if vix:
            d += f"; India VIX {vix:.1f}"
        f.append(_factor("iv_cheap", "Buyer fit", "Premium cost (IV vs realised)", v, 0.25, d))
    else:
        f.append(_factor("iv_cheap", "Buyer fit", "Premium cost (IV vs realised)", 0.5, 0.25,
                         "IV unavailable — assumed fair"))

    a = tech.adx
    v = 1.0 if a > 30 else 0.8 if a > 25 else 0.55 if a > 20 else 0.3
    f.append(_factor("trend_strength", "Buyer fit", "Trend strength (ADX)", v, 0.25,
                     f"ADX {a:.0f} — " + ("strong trend: moves follow through" if a > 25
                                         else "moderate trend" if a > 20 else "weak/rangebound: theta eats buyers")))

    if days <= 1:
        v, d = 0.1, "Expiry within a day — pure gamma gamble, decay is brutal"
    elif days <= 3:
        v, d = 0.4, f"{days:.1f} days left — heavy daily decay"
    elif days <= 7:
        v, d = 0.75, f"{days:.1f} days left — workable for a quick move"
    elif days <= 35:
        v, d = 1.0, f"{days:.0f} days left — room for the thesis to play out"
    else:
        v, d = 0.8, f"{days:.0f} days left — slow decay but more capital tied up"
    f.append(_factor("time", "Buyer fit", "Time to expiry", v, 0.20, d))

    sp = liquidity.get("spread_pct")
    if sp is None:
        f.append(_factor("liquidity", "Buyer fit", "Liquidity (ATM spread)", 0.5, 0.15,
                         "No live quotes — check bid/ask in your broker before buying"))
    else:
        v = 1.0 if sp <= 1 else 0.75 if sp <= 2 else 0.45 if sp <= 4 else 0.15
        f.append(_factor("liquidity", "Buyer fit", "Liquidity (ATM spread)", v, 0.15,
                         f"ATM bid/ask spread {sp:.2f}% of premium"
                         + ("" if sp <= 2 else " — you lose this on entry and exit")))

    if event:
        f.append(_factor("event", "Buyer fit", "Event risk", 0.3, 0.15,
                         f"Results due {event} before this expiry — IV usually collapses right after"))
    else:
        f.append(_factor("event", "Buyer fit", "Event risk", 1.0, 0.15, "No scheduled results before expiry"))
    return f


def weighted(factors: list[dict]) -> float:
    w = sum(x["weight"] for x in factors if x["available"])
    return sum(x["value"] * x["weight"] for x in factors if x["available"]) / w if w else 0.0


def confluence(factors: list[dict], sign: int) -> float:
    """Share of (weighted, available, non-zero) factors agreeing with `sign`."""
    live = [x for x in factors if x["available"] and abs(x["value"]) >= 0.1]
    w = sum(x["weight"] for x in live)
    agree = sum(x["weight"] for x in live if (x["value"] > 0) == (sign > 0))
    return round(agree / w * 100, 0) if w else 0.0


# ── Trade plan & strike ranking ──────────────────────────────────────────────

def holding_days(days: float) -> float:
    h = min(max(1.0, round(days * 0.4)), 7.0)
    return h if h < days else max(days * 0.5, 0.1)


def underlying_plan(side: str, spot: float, sigma: float, h: float,
                    support: float | None, resistance: float | None) -> dict:
    """Targets and stop on the UNDERLYING, sized by the expected move over the
    holding window and snapped to OI walls when they sit in a sensible spot."""
    s_h = spot * sigma * math.sqrt(h / 365)
    notes = []
    if side == "CE":
        t1, t2, stop = spot + s_h, spot + 1.8 * s_h, spot - 0.6 * s_h
        if resistance and spot + 0.4 * s_h < resistance < t1:
            t1 = resistance; notes.append("Target 1 capped at the call-OI wall (resistance)")
        if support and spot - s_h <= support < spot - 0.3 * s_h:
            stop = support - 0.1 * s_h; notes.append("Stop placed just below the put-OI wall (support)")
    else:
        t1, t2, stop = spot - s_h, spot - 1.8 * s_h, spot + 0.6 * s_h
        if support and t1 < support < spot - 0.4 * s_h:
            t1 = support; notes.append("Target 1 capped at the put-OI wall (support)")
        if resistance and spot + 0.3 * s_h < resistance <= spot + s_h:
            stop = resistance + 0.1 * s_h; notes.append("Stop placed just above the call-OI wall (resistance)")
    return {"target1": round(t1, 2), "target2": round(t2, 2), "stop": round(stop, 2),
            "sigma_move": round(s_h, 2), "holding_days": round(h, 1), "notes": notes}


def _simulate(spot: float, sigma: float, h: float, steps: int, drift_total: float,
              seed: int = 7) -> np.ndarray:
    """(N_PATHS, steps) underlying prices; total log-drift `drift_total` over h days.

    Antithetic pairs (z, −z): with one fixed seed, plain sampling leaves a small
    net drift in the paths, and 20× option leverage turns that into several
    points of fake edge for one side and fake loss for the other."""
    rng = np.random.default_rng(seed)
    dt = h / 365 / steps
    half = rng.standard_normal((N_PATHS // 2, steps))
    z = np.concatenate([half, -half])
    inc = (drift_total / steps - 0.5 * sigma * sigma * dt) + sigma * math.sqrt(dt) * z
    return spot * np.exp(np.cumsum(inc, axis=1))


def _exit_values(paths: np.ndarray, side: str, K: float, T: float, h: float, sigma: float,
                 plan: dict, half_spread: float, q: float) -> dict:
    steps = paths.shape[1]
    t_step = np.arange(1, steps + 1) * (h / steps) / 365
    if side == "CE":
        hit_t, hit_s = paths >= plan["target1"], paths <= plan["stop"]
    else:
        hit_t, hit_s = paths <= plan["target1"], paths >= plan["stop"]
    big = steps + 1
    first_t = np.where(hit_t.any(1), hit_t.argmax(1), big)
    first_s = np.where(hit_s.any(1), hit_s.argmax(1), big)
    exit_i = np.minimum(np.minimum(first_t, first_s), steps - 1)
    S_exit = paths[np.arange(len(paths)), exit_i]
    T_exit = T - t_step[exit_i]
    val = np.maximum(0.0, pricing.bs_price_vec(S_exit, K, T_exit, sigma, side, q=q) - half_spread)
    return {"value": val, "target": first_t < first_s, "stop": first_s < first_t}


def evaluate_strike(*, side: str, row: dict, spot: float, T: float, days: float, lot: int,
                    plan: dict, direction: float, fallback_iv: float, paths: dict,
                    max_oi: int, has_quotes: bool, q: float = 0.0,
                    atm_strike: float | None = None) -> dict | None:
    leg = row.get("ce" if side == "CE" else "pe")
    if not leg:
        return None
    K = row["strike"]
    entry = leg["ask"] if has_quotes and leg["ask"] > 0 else leg["ltp"]
    if entry < 0.5:
        return None
    bid = leg["bid"] if has_quotes else 0
    spread = (leg["ask"] - bid) if has_quotes and bid > 0 and leg["ask"] > 0 else None
    mid = (leg["ask"] + bid) / 2 if spread is not None else entry
    spread_pct = spread / mid * 100 if spread is not None and mid else None
    half_spread = spread / 2 if spread is not None else entry * 0.005
    # Solve IV from the live mid with OUR clock, so the model reprices to the
    # market at t=0. NSE's quoted IV was stamped at its own snapshot time (e.g.
    # Friday's close), and pairing it with a weekend-shortened T would book a
    # phantom loss on entry.
    iv = (pricing.implied_vol(mid, spot, K, T, side, q=q) if has_quotes else None) \
        or leg.get("iv") or pricing.implied_vol(entry, spot, K, T, side, q=q) or fallback_iv
    g = pricing.greeks(spot, K, T, iv, side, q=q)

    h = plan["holding_days"]
    be = K + entry if side == "CE" else K - entry
    pop = pricing.prob_finish_above(spot, be, T, iv, q=q)
    pop = pop if side == "CE" else 1 - pop

    t_half = max(T - h * 0.5 / 365, 1e-6)
    p_t1 = pricing.bs_price(plan["target1"], K, t_half, iv, side, q=q) - half_spread
    p_t2 = pricing.bs_price(plan["target2"], K, max(T - h / 365, 1e-6), iv, side, q=q) - half_spread
    p_sl = max(0.0, pricing.bs_price(plan["stop"], K, t_half, iv, side, q=q) - half_spread)
    p_flat = max(0.0, pricing.bs_price(spot, K, max(T - h / 365, 1e-6), iv, side, q=q) - half_spread)

    sims = {}
    for name, p in paths.items():
        ev = _exit_values(p, side, K, T, h, iv, plan, half_spread, q)
        ret = ev["value"] / entry - 1
        sims[name] = {"ev_pct": round(float(ret.mean()) * 100, 1),
                      "median_pct": round(float(np.median(ret)) * 100, 1),
                      "p_profit": round(float((ret > 0).mean()) * 100, 1),
                      "p_target": round(float(ev["target"].mean()) * 100, 1),
                      "p_stop": round(float(ev["stop"].mean()) * 100, 1),
                      "ev_per_lot": round(float(ret.mean()) * entry * lot, 0)}

    gain, loss = p_t1 - entry, entry - p_sl
    rr = gain / loss if loss > 0 else None
    ad = abs(g["delta"])
    delta_s = 1.0 if 0.4 <= ad <= 0.6 else 0.7 if 0.3 <= ad <= 0.75 else 0.4 if ad >= 0.2 else 0.15
    ev_s = _clamp((sims["signal"]["ev_pct"] / 100 + 0.2) / 0.6, 0, 1)
    if spread_pct is None:
        liq_s = 0.5
    else:
        sp_s = 1.0 if spread_pct <= 1 else 0.75 if spread_pct <= 2 else 0.45 if spread_pct <= 4 else 0.15
        liq_s = 0.6 * sp_s + 0.4 * math.sqrt(leg["oi"] / max_oi if max_oi else 0)
    rr_s = _clamp((rr or 0) / 2.5, 0, 1)
    burn = abs(g["theta"]) / entry * 100
    th_s = 1.0 if burn <= 2 else 0.7 if burn <= 4 else 0.4 if burn <= 7 else 0.15
    score = 100 * (0.25 * delta_s + 0.25 * ev_s + 0.20 * liq_s + 0.15 * rr_s + 0.15 * th_s)

    moneyness = (spot - K) / spot * (1 if side == "CE" else -1)
    tag = "ATM" if K == atm_strike else ("ITM" if moneyness > 0 else "OTM")
    return {
        "strike": K, "side": side, "tag": tag, "entry": round(entry, 2), "ltp": leg["ltp"],
        "bid": leg["bid"], "ask": leg["ask"], "iv": round(iv * 100, 2),
        "oi": leg["oi"], "chg_oi": leg["chg_oi"], "volume": leg["volume"],
        "spread_pct": _r(spread_pct), "lot_cost": round(entry * lot, 0),
        "delta": round(g["delta"], 3), "gamma": round(g["gamma"], 5),
        "theta": round(g["theta"], 2), "vega": round(g["vega"], 2), "theta_burn_pct": round(burn, 2),
        "breakeven": round(be, 2), "breakeven_move_pct": round((be / spot - 1) * 100, 2),
        "pop_expiry": round(pop * 100, 1),
        "premium_t1": round(max(0.0, p_t1), 2), "premium_t2": round(max(0.0, p_t2), 2),
        "premium_stop": round(p_sl, 2), "premium_flat": round(p_flat, 2),
        "ret_t1_pct": round((p_t1 / entry - 1) * 100, 1), "ret_t2_pct": round((p_t2 / entry - 1) * 100, 1),
        "ret_stop_pct": round((p_sl / entry - 1) * 100, 1), "ret_flat_pct": round((p_flat / entry - 1) * 100, 1),
        "reward_risk": _r(rr), "sim": sims, "score": round(score, 1),
        "score_parts": {"delta": round(delta_s, 2), "ev": round(ev_s, 2), "liquidity": round(liq_s, 2),
                        "reward_risk": round(rr_s, 2), "theta": round(th_s, 2)},
    }


def rank_strikes(*, side: str, rows: list[dict], spot: float, T: float, days: float, lot: int,
                 metrics: dict, direction: float, sigma: float, has_quotes: bool,
                 q: float = 0.0) -> tuple[dict, list[dict]]:
    """Plan for `side` plus every candidate strike (2 ITM … 5 OTM), best first."""
    h = holding_days(days)
    plan = underlying_plan(side, spot, sigma, h, metrics.get("support"), metrics.get("resistance"))
    steps = max(1, math.ceil(h))
    s_h = sigma * math.sqrt(h / 365)
    # "No edge" drifts at the market's own carry (r − q) — the drift the
    # premiums already price in — so a fairly priced option scores ~0 minus the spread paid.
    fair = (pricing.RISK_FREE - q) * h / 365
    tilt = (direction / 100) * 0.5 * s_h   # signed: a bearish score drifts paths down
    paths = {"neutral": _simulate(spot, sigma, h, steps, fair),
             "signal": _simulate(spot, sigma, h, steps, fair + tilt)}

    strikes = [r["strike"] for r in rows]
    atm_i = min(range(len(rows)), key=lambda i: abs(strikes[i] - spot))
    lo, hi = (atm_i - 2, atm_i + 6) if side == "CE" else (atm_i - 5, atm_i + 3)
    window = rows[max(0, lo): hi]
    leg_key = "ce" if side == "CE" else "pe"
    max_oi = max(((r.get(leg_key) or {}).get("oi", 0) for r in window), default=0)

    out = []
    for r in window:
        e = evaluate_strike(side=side, row=r, spot=spot, T=T, days=days, lot=lot, plan=plan,
                            direction=direction, fallback_iv=sigma, paths=paths,
                            max_oi=max_oi, has_quotes=has_quotes, q=q, atm_strike=strikes[atm_i])
        if e:
            out.append(e)
    out.sort(key=lambda x: -x["score"])
    return plan, out


# ── Verdict, narrative, checklist ────────────────────────────────────────────

def verdict(direction: float, suitability: float) -> dict:
    side = "CE" if direction > 0 else "PE"
    trade_score = round(0.6 * abs(direction) + 0.4 * suitability)
    if abs(direction) < MIN_DIRECTION:
        action, why = "NO_TRADE", ("No directional edge — sideways markets bleed option buyers through "
                                   "time decay. Wait for a clearer setup.")
    elif suitability < MIN_SUITABILITY:
        action, why = "WAIT", ("Direction is there, but conditions are hostile to buyers "
                               "(expensive premium, weak trend or too little time). Wait or size very small.")
    else:
        action = "BUY_CALL" if side == "CE" else "BUY_PUT"
        why = None
    grade = ("A" if trade_score >= 75 else "B" if trade_score >= 60 else "C" if trade_score >= 45 else "D")
    if action in ("NO_TRADE", "WAIT"):
        grade = "—"
    stance = ("Strongly bullish" if direction >= 45 else "Bullish" if direction >= MIN_DIRECTION
              else "Strongly bearish" if direction <= -45 else "Bearish" if direction <= -MIN_DIRECTION
              else "Neutral")
    return {"action": action, "side": side, "trade_score": trade_score, "grade": grade,
            "stance": stance, "reason": why}


def narrative(factors: list[dict], side: str, plan: dict, best: dict | None, symbol: str) -> dict:
    sign = 1 if side == "CE" else -1
    live = [x for x in factors if x["available"]]
    pro = sorted((x for x in live if x["value"] * sign > 0.05), key=lambda x: -x["value"] * sign * x["weight"])
    con = sorted((x for x in live if x["value"] * sign < -0.05), key=lambda x: x["value"] * sign * x["weight"])
    word = "above" if side == "CE" else "below"
    against = "below" if side == "CE" else "above"
    inval = [f"{symbol} closes {against} {plan['stop']:,.2f} (the stop level)",
             f"No progress {word} {plan['target1']:,.2f} within ~{plan['holding_days']:.0f} day(s) — time decay wins"]
    if best:
        inval.append(f"Premium falls to ₹{best['premium_stop']:,.2f} ({best['ret_stop_pct']:+.0f}%)")
    return {"supporting": [f"{x['label']}: {x['detail']}" for x in pro[:4]],
            "risks": [f"{x['label']}: {x['detail']}" for x in con[:4]],
            "invalidation": inval}


def checklist(*, direction: float, conf: float, metrics: dict, hv20: float, days: float,
              best: dict | None, event: str | None, guard_clear: bool) -> list[dict]:
    atm_iv = (metrics.get("atm_iv") or 0) / 100
    ratio = atm_iv / hv20 if atm_iv and hv20 and not math.isnan(hv20) else None
    items = [
        ("Clear direction (|score| ≥ 20)", abs(direction) >= MIN_DIRECTION, f"Direction {direction:+.0f}"),
        ("Factors agree (confluence ≥ 60%)", conf >= 60, f"{conf:.0f}% of weighted signals agree"),
        ("Premium not expensive (IV ≤ 1.25× realised)", ratio is not None and ratio <= 1.25,
         f"IV/HV ×{ratio:.2f}" if ratio else "IV unavailable"),
        ("At least 3 days to expiry", days >= 3, f"{days:.1f} days left"),
        ("Tight spread on chosen strike (≤ 2%)",
         bool(best and best["spread_pct"] is not None and best["spread_pct"] <= 2),
         f"{best['spread_pct']:.2f}%" if best and best["spread_pct"] is not None else "No live quote"),
        ("No results before expiry", not event, event and f"Results {event}" or "None scheduled"),
        ("Bad-news guard clear", guard_clear, "No severe market/sector news" if guard_clear else "Severe news flagged"),
        ("Positive expected value if the analysis is right",
         bool(best and best["sim"]["signal"]["ev_pct"] > 0),
         f"{best['sim']['signal']['ev_pct']:+.1f}%" if best else "—"),
    ]
    return [{"label": l, "ok": bool(ok), "detail": d} for l, ok, d in items]
