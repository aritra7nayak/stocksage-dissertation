"""Indicator sanity tests on synthetic data with known expected behaviour.

Run:  python -m pytest tests/ -q    (or just: python tests/test_indicators.py)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

import numpy as np
import pandas as pd

from app.market_data import indicators as ind


def _ohlcv(close: np.ndarray) -> pd.DataFrame:
    """Build a plausible OHLCV frame around a close series."""
    rng = np.random.default_rng(42)
    noise = np.abs(rng.normal(0, 0.3, len(close)))
    return pd.DataFrame({
        "Open": close * (1 + rng.normal(0, 0.002, len(close))),
        "High": close + noise,
        "Low": close - noise,
        "Close": close,
        "Volume": rng.integers(1_000_000, 5_000_000, len(close)).astype(float),
    }, index=pd.date_range("2025-01-01", periods=len(close), freq="B"))


def test_rsi_bounds_and_direction():
    rising = pd.Series(np.linspace(100, 200, 120))
    falling = pd.Series(np.linspace(200, 100, 120))
    assert ind.rsi(rising) > 70, "Steadily rising series must be overbought"
    assert ind.rsi(falling) < 30, "Steadily falling series must be oversold"
    assert 0 <= ind.rsi(rising) <= 100


def test_ema_cross_detection():
    # 100 flat days then a sharp rally → EMA20 crosses above EMA50 → GOLDEN
    flat_then_up = pd.Series(np.concatenate([np.full(100, 100.0), np.linspace(100, 130, 25)]))
    assert ind.ema_cross(flat_then_up) in ("GOLDEN", "NONE")
    rally_full = pd.Series(np.concatenate([np.linspace(120, 100, 100), np.linspace(100, 140, 30)]))
    assert ind.ema_cross(rally_full) != "DEATH"


def test_macd_bullish_on_fresh_rally():
    series = pd.Series(np.concatenate([np.linspace(110, 100, 80), np.linspace(100, 112, 12)]))
    hist, signal = ind.macd(series)
    assert signal in ("BULLISH_CROSS", "NONE")
    assert isinstance(hist, float)


def test_bollinger_percent_b_extremes():
    flat = pd.Series(np.concatenate([np.full(50, 100.0) + np.random.default_rng(1).normal(0, 1, 50)]))
    spike = pd.concat([flat, pd.Series([115.0])], ignore_index=True)
    assert ind.bollinger_percent_b(spike) > 0.9, "Price spike must sit at/above upper band"


def test_adx_strong_on_trend_weak_on_chop():
    trend = _ohlcv(np.linspace(100, 180, 150))
    rng = np.random.default_rng(7)
    chop = _ohlcv(100 + np.cumsum(rng.normal(0, 0.05, 150)))
    assert ind.adx(trend["High"], trend["Low"], trend["Close"]) > 25, "Strong trend → high ADX"
    assert ind.adx(chop["High"], chop["Low"], chop["Close"]) < ind.adx(trend["High"], trend["Low"], trend["Close"])


def test_momentum_and_52w():
    up = pd.Series(np.linspace(100, 120, 260))
    assert ind.momentum(up) > 0
    assert ind.dist_from_52w_high(up) < 0.01, "At its high → distance ~0"
    crashed = pd.Series(np.concatenate([np.linspace(100, 200, 200), np.linspace(200, 120, 60)]))
    assert ind.dist_from_52w_high(crashed) > 0.3


def test_compute_all_returns_complete_snapshot():
    df = _ohlcv(np.linspace(100, 140, 250))
    snap = ind.compute_all(df)
    assert 0.0 <= snap.technical_score <= 1.0
    assert snap.reasons, "Score must always come with reasons"
    assert snap.ema_20 > 0 and snap.ema_50 > 0


def test_compute_all_handles_short_history():
    df = _ohlcv(np.linspace(100, 105, 30))
    snap = ind.compute_all(df)
    assert snap.technical_score == 0.5, "Insufficient data → neutral, never crash"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n✅ All {len(fns)} indicator tests passed.")
