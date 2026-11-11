"""Fundamental scoring — every metric scored 0–10 with a stated reason.

Missing data scores a neutral 5 and says so; the engine never crashes on a
stock with patchy Yahoo fundamentals. ETFs skip fundamentals entirely
(score 0.5 neutral) — technicals and sentiment drive ETF decisions.
"""
from dataclasses import dataclass, field

from app.market_data.fetcher import get_fundamentals_raw

# Weights sum to 1.0 — transparent
WEIGHTS = {
    "pe": 0.20, "pb": 0.10, "roe": 0.20, "de": 0.15,
    "growth": 0.15, "margin": 0.15, "dividend": 0.05,
}


@dataclass
class FundamentalSnapshot:
    """Scored fundamentals for one stock."""

    pe_ratio: float | None = None
    pb_ratio: float | None = None
    roe: float | None = None
    debt_to_equity: float | None = None
    revenue_growth: float | None = None
    profit_margin: float | None = None
    dividend_yield: float | None = None
    fundamental_score: float = 0.5
    reasons: list[str] = field(default_factory=list)


def _score_pe(pe: float | None) -> tuple[float, str]:
    if pe is None or pe <= 0:
        return 5.0, "P/E unavailable or negative earnings — neutral"
    if pe < 15:
        return 10.0, f"P/E {pe:.1f}: attractively valued"
    if pe < 25:
        return 7.0, f"P/E {pe:.1f}: fairly valued"
    if pe < 40:
        return 4.0, f"P/E {pe:.1f}: expensive"
    return 2.0, f"P/E {pe:.1f}: very expensive — priced for perfection"


def _score_pb(pb: float | None) -> tuple[float, str]:
    if pb is None or pb <= 0:
        return 5.0, "P/B unavailable — neutral"
    if pb < 2:
        return 9.0, f"P/B {pb:.1f}: trading near book value"
    if pb < 5:
        return 6.0, f"P/B {pb:.1f}: reasonable"
    return 3.0, f"P/B {pb:.1f}: rich vs book"


def _score_roe(roe: float | None) -> tuple[float, str]:
    if roe is None:
        return 5.0, "ROE unavailable — neutral"
    pct = roe * 100
    if pct > 20:
        return 10.0, f"ROE {pct:.0f}%: excellent capital efficiency"
    if pct > 15:
        return 8.0, f"ROE {pct:.0f}%: strong"
    if pct > 10:
        return 6.0, f"ROE {pct:.0f}%: decent"
    if pct > 0:
        return 3.0, f"ROE {pct:.0f}%: weak returns on equity"
    return 1.0, f"ROE {pct:.0f}%: destroying shareholder value"


def _score_de(de: float | None) -> tuple[float, str]:
    if de is None:
        return 5.0, "Debt/Equity unavailable — neutral"
    de = de / 100 if de > 10 else de  # yfinance sometimes reports as percentage
    if de < 0.3:
        return 10.0, f"D/E {de:.2f}: nearly debt-free"
    if de < 1.0:
        return 7.0, f"D/E {de:.2f}: manageable leverage"
    if de < 2.0:
        return 4.0, f"D/E {de:.2f}: heavily leveraged"
    return 1.0, f"D/E {de:.2f}: dangerous debt load"


def _score_growth(g: float | None) -> tuple[float, str]:
    if g is None:
        return 5.0, "Revenue growth unavailable — neutral"
    pct = g * 100
    if pct > 20:
        return 10.0, f"Revenue growth {pct:.0f}% YoY: rapid expansion"
    if pct > 10:
        return 8.0, f"Revenue growth {pct:.0f}% YoY: healthy"
    if pct > 0:
        return 5.0, f"Revenue growth {pct:.0f}% YoY: slow"
    return 2.0, f"Revenue shrinking {pct:.0f}% YoY"


def _score_margin(m: float | None) -> tuple[float, str]:
    if m is None:
        return 5.0, "Profit margin unavailable — neutral"
    pct = m * 100
    if pct > 20:
        return 10.0, f"Net margin {pct:.0f}%: highly profitable"
    if pct > 10:
        return 7.0, f"Net margin {pct:.0f}%: solid"
    if pct > 0:
        return 4.0, f"Net margin {pct:.0f}%: thin"
    return 1.0, f"Loss-making (margin {pct:.0f}%)"


def _score_dividend(d: float | None) -> tuple[float, str]:
    if d is None or d == 0:
        return 5.0, "No dividend — neutral (growth stocks reinvest)"
    pct = d * 100 if d < 1 else d
    if pct > 2:
        return 9.0, f"Dividend yield {pct:.1f}%: meaningful income"
    return 7.0, f"Dividend yield {pct:.1f}%: token payout"


def score_fundamentals(symbol: str, is_etf: bool = False) -> FundamentalSnapshot:
    """Fetch and score fundamentals for one stock.

    Args:
        symbol: yfinance symbol, e.g. 'INFY.NS'.
        is_etf: ETFs have no meaningful fundamentals — return neutral 0.5.
    """
    if is_etf:
        return FundamentalSnapshot(reasons=["ETF — fundamentals not applicable, neutral 0.5"])

    try:
        info = get_fundamentals_raw(symbol)
    except Exception as exc:  # network failure → neutral, never crash
        return FundamentalSnapshot(reasons=[f"Fundamentals fetch failed ({exc}) — neutral 0.5"])

    snap = FundamentalSnapshot(
        pe_ratio=info.get("trailingPE"),
        pb_ratio=info.get("priceToBook"),
        roe=info.get("returnOnEquity"),
        debt_to_equity=info.get("debtToEquity"),
        revenue_growth=info.get("revenueGrowth"),
        profit_margin=info.get("profitMargins"),
        dividend_yield=info.get("dividendYield"),
    )

    scores, reasons = {}, []
    for key, (fn, value) in {
        "pe": (_score_pe, snap.pe_ratio),
        "pb": (_score_pb, snap.pb_ratio),
        "roe": (_score_roe, snap.roe),
        "de": (_score_de, snap.debt_to_equity),
        "growth": (_score_growth, snap.revenue_growth),
        "margin": (_score_margin, snap.profit_margin),
        "dividend": (_score_dividend, snap.dividend_yield),
    }.items():
        s, why = fn(value)
        scores[key] = s
        reasons.append(why)

    snap.fundamental_score = round(sum(WEIGHTS[k] * v for k, v in scores.items()) / 10, 3)
    snap.reasons = reasons
    return snap
