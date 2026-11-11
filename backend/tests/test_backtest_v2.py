"""Backtest additions for the dissertation: risk metrics, next-open fills,
point-in-time news alignment and news-driven R12 blocks.

Reuses the synthetic market from test_backtest.py.
"""
import math
import sys
from datetime import date, datetime, time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytz

from app.backtest import metrics
from app.backtest.news_signals import HistoricalHeadline, build, session_for
from app.backtest.simulator import BacktestSimulator, NewsSignals
from tests.test_backtest import DATES, RESULT, S, build_market

IST = pytz.timezone("Asia/Kolkata")
START, END = DATES[210].date(), DATES[-1].date()
# build_market draws from a shared RNG, so build once: every run below must
# see the identical market for comparisons to mean anything.
MARKET = build_market()


def _sim(**kw):
    prices, meta, nifty = MARKET
    return BacktestSimulator(prices, meta, nifty, S, **kw).run(START, END, 100_000)


CLOSE = _sim()


# ── metrics ──────────────────────────────────────────────────────────────

def test_metrics_constant_growth():
    vals = [100 * 1.001 ** i for i in range(253)]
    m = metrics.summarize(vals, rf_annual=0.0)
    assert math.isclose(m["cagr_pct"], (1.001 ** 252 - 1) * 100, rel_tol=1e-3)
    assert m["max_drawdown_pct"] == 0
    assert m["sharpe"] is None, "Zero volatility: Sharpe is undefined, not infinite"
    assert m["sortino"] is None and m["calmar"] is None


def test_metrics_drawdown_and_signs():
    vals = [100, 110, 99, 105, 120, 90, 95]
    m = metrics.summarize(vals)
    assert math.isclose(metrics.max_drawdown(vals), 0.25)
    assert m["max_drawdown_pct"] == 25.0
    assert m["volatility_pct"] > 0 and m["sharpe"] is not None and m["sortino"] is not None


def test_metrics_too_short():
    assert metrics.summarize([100])["sharpe"] is None


def test_result_carries_metrics():
    assert RESULT.metrics["max_drawdown_pct"] == RESULT.max_drawdown_pct
    assert RESULT.nifty_metrics["cagr_pct"] is not None
    assert RESULT.fill_mode == "close"


# ── next-open fills ──────────────────────────────────────────────────────

def test_next_open_fills_one_session_later():
    r = _sim(fill="next_open")
    assert r.fill_mode == "next_open"
    # First entry per symbol: later re-entries legitimately diverge because
    # the two runs fill at different prices.
    close_buys, open_buys = {}, {}
    for t in CLOSE.trades:
        if t.action == "BUY":
            close_buys.setdefault(t.symbol, t.trade_date)
    for t in r.trades:
        if t.action == "BUY":
            open_buys.setdefault(t.symbol, t.trade_date)
    assert set(open_buys) == set(close_buys)
    sessions = [d.date() for d in DATES]
    for sym, d in close_buys.items():
        assert open_buys[sym] == sessions[sessions.index(d) + 1]


def test_next_open_still_stops_out_crash():
    r = _sim(fill="next_open")
    assert any(t.action == "SELL" and t.symbol == "CRASH.NS" for t in r.trades)


def test_bad_fill_mode_rejected():
    prices, meta, nifty = MARKET
    try:
        BacktestSimulator(prices, meta, nifty, S, fill="vwap")
    except ValueError:
        return
    raise AssertionError("unknown fill mode must raise")


# ── news alignment ───────────────────────────────────────────────────────

SESSIONS = [date(2026, 1, 2), date(2026, 1, 5), date(2026, 1, 6)]   # Fri, Mon, Tue


def _ist(d: date, hh: int, mm: int = 0) -> datetime:
    return IST.localize(datetime.combine(d, time(hh, mm)))


def test_session_for_cutoff_and_weekend():
    assert session_for(_ist(date(2026, 1, 2), 8, 59), SESSIONS) == date(2026, 1, 2)
    assert session_for(_ist(date(2026, 1, 2), 9, 1), SESSIONS) == date(2026, 1, 5), \
        "After the cut-off it must wait for the next session (no look-ahead)"
    assert session_for(_ist(date(2026, 1, 3), 14), SESSIONS) == date(2026, 1, 5), "weekend rolls"
    assert session_for(_ist(date(2026, 1, 6), 18), SESSIONS) is None
    utc = datetime(2026, 1, 5, 3, 0, tzinfo=pytz.utc)                 # 08:30 IST
    assert session_for(utc, SESSIONS) == date(2026, 1, 5)


def test_build_aggregates_by_session():
    hs = [
        HistoricalHeadline(_ist(date(2026, 1, 5), 7), "Infosys wins large deal", "POSITIVE", 0.8),
        HistoricalHeadline(_ist(date(2026, 1, 5), 8), "Infosys shares rise", "POSITIVE", 0.4),
        HistoricalHeadline(_ist(date(2026, 1, 5), 10), "Infosys cuts guidance", "NEGATIVE", -0.9),
    ]
    sig = build(hs, SESSIONS, link=lambda h: {"INFY.NS"} if "infosys" in h.lower() else set())
    assert sig.symbol_sentiment[date(2026, 1, 5)]["INFY.NS"] == 0.6
    assert sig.symbol_sentiment[date(2026, 1, 6)]["INFY.NS"] == -0.9


def test_build_market_halt():
    bad = ["War fears grip markets as missile strikes reported",
           "Sensex crashes over 1,200 points in bloodbath",
           "Pandemic lockdown fears return as new variant spreads",
           "Rupee crashes to record low against the dollar"]
    hs = [HistoricalHeadline(_ist(date(2026, 1, 2), 7), h, "NEGATIVE", -0.9) for h in bad]
    sig = build(hs, SESSIONS, link=lambda h: set())
    assert sig.market_stopped[date(2026, 1, 2)] is True


def test_news_halt_blocks_all_buys():
    sessions = [d.date() for d in DATES]
    halt = NewsSignals(market_stopped={d: True for d in sessions}, label="halt")
    r = _sim(news=halt)
    assert not [t for t in r.trades if t.action == "BUY"], "R12 market halt must stop every buy"
    assert r.news_blocked_days > 0


def test_neutral_news_dilutes_scores():
    # Neutral sentiment (0.5) pulls every composite toward 0.5, so fewer names
    # clear the 0.60 buy bar than in the technical-only run. E4 therefore
    # compares model-driven news against this neutral control, not against
    # technical-only, so dilution is not mistaken for information.
    neutral = _sim(news=NewsSignals(label="neutral"))
    tech_only = [t for t in CLOSE.trades if t.action == "BUY"]
    assert len([t for t in neutral.trades if t.action == "BUY"]) <= len(tech_only)


def test_positive_news_lifts_a_name_over_the_bar():
    sessions = [d.date() for d in DATES]
    good = NewsSignals(symbol_sentiment={d: {"RALLY.NS": 1.0} for d in sessions}, label="good")
    r = _sim(news=good)
    assert any(t.action == "BUY" and t.symbol == "RALLY.NS" for t in r.trades)
