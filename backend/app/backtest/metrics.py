"""Risk-adjusted performance metrics from a daily equity curve.

All ratios are annualised with 252 trading days. The risk-free rate defaults
to 6% a year (the same constant the options module uses for Indian T-bills)
and is converted to a daily rate. Returns None where a ratio is undefined
(too few days, zero volatility, no losing days), never inf or NaN, so results
serialise cleanly to JSON.
"""
import math
from collections.abc import Sequence

TRADING_DAYS = 252
RISK_FREE_ANNUAL = 0.06
_EPS = 1e-12           # below this a daily deviation is rounding noise


def daily_returns(values: Sequence[float]) -> list[float]:
    return [values[i] / values[i - 1] - 1 for i in range(1, len(values)) if values[i - 1] > 0]


def _std(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def max_drawdown(values: Sequence[float]) -> float:
    """Largest peak-to-trough fall, as a positive fraction."""
    peak, worst = -math.inf, 0.0
    for v in values:
        peak = max(peak, v)
        if peak > 0:
            worst = max(worst, (peak - v) / peak)
    return worst


def summarize(values: Sequence[float], rf_annual: float = RISK_FREE_ANNUAL) -> dict:
    """CAGR, volatility, Sharpe, Sortino and Calmar for one equity series."""
    out = {"cagr_pct": None, "volatility_pct": None, "sharpe": None,
           "sortino": None, "calmar": None, "max_drawdown_pct": None}
    if len(values) < 2 or values[0] <= 0:
        return out
    rets = daily_returns(values)
    years = len(rets) / TRADING_DAYS
    rf_daily = (1 + rf_annual) ** (1 / TRADING_DAYS) - 1
    excess = [r - rf_daily for r in rets]

    mdd = max_drawdown(values)
    out["max_drawdown_pct"] = round(mdd * 100, 3)
    if years > 0 and values[-1] > 0:
        cagr = (values[-1] / values[0]) ** (1 / years) - 1
        out["cagr_pct"] = round(cagr * 100, 3)
        if mdd > 0:
            out["calmar"] = round(cagr / mdd, 3)
    sd = _std(rets)
    if sd > _EPS:
        out["volatility_pct"] = round(sd * math.sqrt(TRADING_DAYS) * 100, 3)
        out["sharpe"] = round(sum(excess) / len(excess) / sd * math.sqrt(TRADING_DAYS), 3)
    downside = [min(0.0, e) for e in excess]
    dd_dev = math.sqrt(sum(d * d for d in downside) / len(downside)) if downside else 0.0
    if dd_dev > _EPS:
        out["sortino"] = round(sum(excess) / len(excess) / dd_dev * math.sqrt(TRADING_DAYS), 3)
    return out
