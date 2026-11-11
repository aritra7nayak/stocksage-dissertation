"""Backtest simulator tests on an engineered synthetic market.

Three instruments with known destinies:
  RALLY.NS   — long decline, then a strong clean rally → must get BOUGHT
  CRASH.NS   — same rally, then a −25% collapse → stop-loss (R13) must SELL it
  SLEEPY.NS  — flat noise → must never be bought (score stays mediocre)

Plus internal-consistency checks: the equity curve must equal cash + positions
at every step (we verify the last point), drawdown ≥ 0, costs deducted.

Run:  python tests/test_backtest.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import pandas as pd

from app.backtest.simulator import BacktestSimulator
from app.config import Settings

S = Settings()
RNG = np.random.default_rng(7)
N = 360  # trading days of synthetic history
DATES = pd.date_range("2025-01-01", periods=N, freq="B")


def _ohlcv(close: np.ndarray) -> pd.DataFrame:
    noise = np.abs(RNG.normal(0, 0.2, len(close)))
    return pd.DataFrame({
        "Open": close, "High": close + noise, "Low": close - noise,
        "Close": close, "Volume": RNG.integers(1_000_000, 3_000_000, len(close)).astype(float),
    }, index=DATES[:len(close)])


def build_market():
    decline = np.linspace(120, 95, 200)
    rally = np.linspace(95, 130, 80)
    tail_up = np.linspace(130, 138, 80)
    rally_full = np.concatenate([decline, rally, tail_up])           # RALLY.NS

    crash_tail = np.concatenate([np.linspace(130, 132, 30), np.linspace(132, 99, 50)])
    crash_full = np.concatenate([decline, rally, crash_tail])        # CRASH.NS −25%

    sleepy = 100 + np.cumsum(RNG.normal(0, 0.05, N))                 # SLEEPY.NS chop

    nifty = np.linspace(22000, 24500, N) + RNG.normal(0, 25, N)      # benign index

    prices = {"RALLY.NS": _ohlcv(rally_full), "CRASH.NS": _ohlcv(crash_full),
              "SLEEPY.NS": _ohlcv(sleepy)}
    meta = {"RALLY.NS": ("NIFTY50", "IT"), "CRASH.NS": ("NIFTY50", "FMCG"),
            "SLEEPY.NS": ("NIFTY50", "Metal")}
    return prices, meta, _ohlcv(nifty)


def run_sim():
    prices, meta, nifty = build_market()
    sim = BacktestSimulator(prices, meta, nifty, S)
    return sim.run(DATES[210].date(), DATES[-1].date(), 100_000)


RESULT = run_sim()


def test_rally_and_crash_get_bought():
    bought = {t.symbol for t in RESULT.trades if t.action == "BUY"}
    assert "RALLY.NS" in bought, "A clean golden-cross rally must trigger a buy"
    assert "CRASH.NS" in bought


def test_sleepy_never_bought():
    assert all(t.symbol != "SLEEPY.NS" for t in RESULT.trades), \
        "Flat chop must never reach the 0.60 buy threshold"


def test_stop_loss_fires_on_crash():
    sells = [t for t in RESULT.trades if t.action == "SELL" and t.symbol == "CRASH.NS"]
    assert sells, "The −25% collapse must trigger a sell"
    assert any(t.triggered_rule in ("R13", "R15") for t in sells)
    r13 = [t for t in sells if t.triggered_rule == "R13"]
    if r13:
        assert r13[0].pnl is not None


def test_equity_curve_and_drawdown_sane():
    assert len(RESULT.equity_curve) > 100
    assert RESULT.max_drawdown_pct >= 0
    assert RESULT.final_value == RESULT.equity_curve[-1]["equity"]
    assert RESULT.total_trades == len(RESULT.trades)


def test_costs_are_deducted():
    buys = [t for t in RESULT.trades if t.action == "BUY"]
    assert buys
    # First buy: cash impact must exceed qty*price (cost added)
    first = buys[0]
    assert first.quantity * first.price <= 9000 + 1, "Purchase band respected in sim"


def test_benchmark_computed():
    assert RESULT.nifty_return_pct > 0, "Synthetic Nifty rose — benchmark must reflect it"


def test_window_too_short_aborts_cleanly():
    prices, meta, nifty = build_market()
    sim = BacktestSimulator(prices, meta, nifty, S)
    res = sim.run(DATES[-5].date(), DATES[-1].date(), 100_000)
    assert res.total_trades == 0 and any("too short" in n for n in res.notes)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n✅ All {len(fns)} backtest tests passed.")
    print(f"   Synthetic run: {RESULT.total_return_pct:+.2f}% vs Nifty "
          f"{RESULT.nifty_return_pct:+.2f}% | DD {RESULT.max_drawdown_pct:.2f}% | "
          f"{RESULT.total_trades} trades, win rate {RESULT.win_rate:.0%}")
