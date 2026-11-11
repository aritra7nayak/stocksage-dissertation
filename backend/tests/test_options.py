"""Options desk: pricing math and buyer-analysis logic on synthetic chains.

Run:  python -m pytest tests/ -q    (or just: python tests/test_options.py)
"""
import math
import sys
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

import pytz

from app.options import analysis as A
from app.options import nse, pricing

IST = pytz.timezone("Asia/Kolkata")


def _chain(spot=100.0, sigma=0.25, T=20 / 365, q=0.0, oi=True, spread=0.2):
    """Black-Scholes-consistent chain with symmetric quotes around fair value."""
    rows = []
    for k in range(80, 121, 5):
        legs = {}
        for kind in ("CE", "PE"):
            fair = pricing.bs_price(spot, k, T, sigma, kind, q=q)
            legs[kind.lower()] = {
                "ltp": round(fair, 2), "bid": max(0.05, fair - spread / 2), "ask": fair + spread / 2,
                "iv": sigma, "oi": (1000 if oi else 0), "chg_oi": 0, "volume": 100, "chg_pct": 0.0,
            }
        rows.append({"strike": float(k), **legs})
    return rows


def test_put_call_parity():
    S, K, T, s, r, q = 100.0, 105.0, 0.1, 0.3, pricing.RISK_FREE, 0.02
    c = pricing.bs_price(S, K, T, s, "CE", r, q)
    p = pricing.bs_price(S, K, T, s, "PE", r, q)
    assert abs((c - p) - (S * math.exp(-q * T) - K * math.exp(-r * T))) < 1e-9


def test_implied_vol_roundtrip():
    for kind in ("CE", "PE"):
        price = pricing.bs_price(22500, 22600, 4 / 365, 0.13, kind, q=0.01)
        iv = pricing.implied_vol(price, 22500, 22600, 4 / 365, kind, q=0.01)
        assert iv is not None and abs(iv - 0.13) < 1e-5


def test_implied_vol_rejects_below_intrinsic():
    assert pricing.implied_vol(1.0, 110, 100, 0.1, "CE") is None


def test_greeks_signs_and_delta_bounds():
    gc = pricing.greeks(100, 100, 0.1, 0.2, "CE")
    gp = pricing.greeks(100, 100, 0.1, 0.2, "PE")
    assert 0 < gc["delta"] < 1 and -1 < gp["delta"] < 0
    assert gc["theta"] < 0 and gp["theta"] < 0, "Long options always decay at the money"
    assert gc["gamma"] > 0 and abs(gc["vega"] - gp["vega"]) < 1e-9


def test_vector_pricer_matches_scalar():
    import numpy as np
    S = np.array([90.0, 100.0, 110.0])
    T = np.array([0.05, 0.0, 0.2])
    vec = pricing.bs_price_vec(S, 100, T, 0.25, "PE", q=0.01)
    for i in range(3):
        assert abs(vec[i] - pricing.bs_price(S[i], 100, T[i], 0.25, "PE", q=0.01)) < 1e-5


def test_implied_carry_recovers_dividend_yield():
    rows = _chain(q=0.03, spread=0.0)
    q, fwd = A.implied_carry(rows, 100.0, 20 / 365)
    assert abs(q - 0.03) < 0.002
    assert abs(fwd - 100 * math.exp((pricing.RISK_FREE - 0.03) * 20 / 365)) < 0.01


def test_max_pain_and_oi_walls():
    rows = _chain()
    for r in rows:   # heavy put wall at 90, call wall at 110
        r["pe"]["oi"] = 50_000 if r["strike"] == 90 else 1000
        r["ce"]["oi"] = 60_000 if r["strike"] == 110 else 1000
    m = A.chain_metrics(rows, 100.0, 20 / 365, has_oi=True)
    assert m["support"] == 90 and m["resistance"] == 110
    assert 90 <= m["max_pain"] <= 110
    assert m["pcr_oi"] < 1


def test_modeled_chain_has_no_oi_signals():
    m = A.chain_metrics(_chain(oi=False), 100.0, 20 / 365, has_oi=False)
    assert m["pcr_oi"] is None and m["max_pain"] is None and m["skew"] is None


def test_verdict_thresholds():
    assert A.verdict(10, 90)["action"] == "NO_TRADE"
    assert A.verdict(-50, 30)["action"] == "WAIT"
    assert A.verdict(50, 80)["action"] == "BUY_CALL"
    v = A.verdict(-50, 80)
    assert v["action"] == "BUY_PUT" and v["side"] == "PE"


def test_weighted_ignores_unavailable_factors():
    f = [A._factor("a", "g", "a", 1.0, 0.5, ""), A._factor("b", "g", "b", -1.0, 0.5, "", available=False)]
    assert A.weighted(f) == 1.0


def test_no_edge_ev_is_about_minus_the_spread():
    """With a fair chain and zero drift, buying should lose roughly the spread
    — for calls AND puts alike (catches carry or path-sampling bias)."""
    spot, T = 100.0, 20 / 365
    rows = _chain(spot=spot, T=T, spread=0.1)
    metrics = A.chain_metrics(rows, spot, T, has_oi=True)
    for side in ("CE", "PE"):
        _, strikes = A.rank_strikes(side=side, rows=rows, spot=spot, T=T, days=20, lot=100,
                                    metrics=metrics, direction=0, sigma=0.25, has_quotes=True)
        atm = next(s for s in strikes if s["strike"] == 100)
        assert -6 < atm["sim"]["neutral"]["ev_pct"] < 1, (side, atm["sim"]["neutral"])


def test_signal_view_favours_the_signalled_side():
    spot, T = 100.0, 20 / 365
    rows = _chain(spot=spot, T=T)
    metrics = A.chain_metrics(rows, spot, T, has_oi=True)
    _, puts = A.rank_strikes(side="PE", rows=rows, spot=spot, T=T, days=20, lot=100,
                             metrics=metrics, direction=-60, sigma=0.25, has_quotes=True)
    p = next(s for s in puts if s["strike"] == 100)
    assert p["sim"]["signal"]["ev_pct"] > p["sim"]["neutral"]["ev_pct"]


def test_time_to_expiry_counts_to_1530():
    now = IST.localize(datetime(2026, 10, 12, 15, 30))
    T, days = A.time_to_expiry(date(2026, 10, 13), now, IST)
    assert abs(days - 1.0) < 1e-9 and abs(T - 1 / 365) < 1e-12


def test_modeled_expiries_follow_calendar_rules():
    exps = nse.modeled_expiries("NIFTY", date(2026, 10, 10))
    assert exps[0] == date(2026, 10, 13) and all(e.weekday() == 1 for e in exps)
    stock = nse.modeled_expiries("RELIANCE", date(2026, 10, 10))
    assert stock[0] == date(2026, 10, 27)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok ", name)
