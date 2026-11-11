"""Vectorized indicator series for backtesting.

The live engine computes indicators for "today" only. A backtest needs them
for EVERY day, so we precompute full series per symbol once (pure pandas,
same formulas as app.market_data.indicators) and then read rows in O(1)
inside the daily loop. 200 symbols × 250 days stays under a few seconds.

ADX/Stochastic are intentionally omitted here (rolling Wilder ADX per-day adds
cost for a 0.10-weight component); their weight is redistributed:
    trend 0.28 · RSI 0.22 · MACD 0.22 · position 0.17 · volume 0.11
"""
import numpy as np
import pandas as pd


def indicator_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Precompute all indicator series for one symbol's OHLCV history."""
    close, vol = df["Close"], df["Volume"]
    out = pd.DataFrame(index=df.index)
    out["close"] = close
    out["open"] = df["Open"].fillna(close) if "Open" in df else close   # next-open fills

    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / 14, min_periods=14).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / 14, min_periods=14).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    out["rsi"] = rsi.where(loss != 0, np.where(gain > 0, 100.0, 50.0))

    e12 = close.ewm(span=12, adjust=False).mean()
    e26 = close.ewm(span=26, adjust=False).mean()
    macd = e12 - e26
    sig = macd.ewm(span=9, adjust=False).mean()
    out["macd_hist"] = macd - sig
    out["macd_above"] = (macd > sig).astype(int)

    out["ema20"] = close.ewm(span=20, adjust=False).mean()
    out["ema50"] = close.ewm(span=50, adjust=False).mean()
    out["ema_above"] = (out["ema20"] > out["ema50"]).astype(int)

    mid = close.rolling(20).mean()
    std = close.rolling(20).std()
    width = (4 * std).replace(0, np.nan)
    out["bb_b"] = (close - (mid - 2 * std)) / width

    out["vol_ratio"] = vol / vol.rolling(20).mean()
    out["dist52"] = 1 - close / close.rolling(252, min_periods=60).max()
    out["day_chg"] = close.pct_change() * 100
    return out


def tech_score_at(f: pd.DataFrame, i: int) -> float:
    """Technical score for row i — mirrors the live scorer's logic and spirit."""
    if i < 60:
        return 0.5
    row = f.iloc[i]
    price, ema20, ema50 = row["close"], row["ema20"], row["ema50"]

    # Trend (0.28) with cross detection over the last 5 bars
    ema_flips = f["ema_above"].iloc[max(0, i - 5):i + 1].diff()
    if (ema_flips == 1).any():
        trend = 1.0
    elif (ema_flips == -1).any():
        trend = 0.0
    elif ema20 > ema50 and price > ema20:
        trend = 0.9
    elif ema20 > ema50:
        trend = 0.6
    elif price > ema20:
        trend = 0.4
    else:
        trend = 0.1

    # RSI (0.22)
    r = row["rsi"]
    if np.isnan(r):
        rsi_s = 0.5
    elif 45 <= r <= 65:
        rsi_s = 1.0
    elif 30 <= r < 45:
        rsi_s = 0.7
    elif r < 30:
        rsi_s = 0.5
    elif r <= 75:
        rsi_s = 0.4
    else:
        rsi_s = 0.1

    # MACD (0.22) with cross over last 3 bars
    macd_flips = f["macd_above"].iloc[max(0, i - 3):i + 1].diff()
    if (macd_flips == 1).any():
        macd_s = 1.0
    elif (macd_flips == -1).any():
        macd_s = 0.0
    elif row["macd_hist"] > 0:
        macd_s = 0.7
    else:
        macd_s = 0.2

    # Position (0.17)
    b = row["bb_b"]
    if np.isnan(b):
        pos = 0.6
    elif b > 1.0:
        pos = 0.1
    elif b > 0.8:
        pos = 0.4
    elif b < 0.0:
        pos = 0.4
    elif b < 0.25:
        pos = 0.8
    else:
        pos = 0.6
    if row["dist52"] > 0.30:
        pos = max(0.0, pos - 0.2)

    # Volume (0.11)
    v = row["vol_ratio"]
    up_day = row["day_chg"] >= 0
    if not np.isnan(v) and v > 1.2:
        vol_s = 1.0 if up_day else 0.2
    else:
        vol_s = 0.5

    score = round(0.28 * trend + 0.22 * rsi_s + 0.22 * macd_s + 0.17 * pos + 0.11 * vol_s, 3)

    # CHOP GUARD: in a sideways band (20d volatility < 0.5% of price), EMA/MACD
    # crosses are whipsaw noise, not signal. No edge in flat markets — cap below
    # the 0.60 buy threshold.
    chop = float(f["close"].iloc[max(0, i - 20):i + 1].std()) / price if price else 0
    if chop < 0.005:
        score = min(score, 0.55)
    return score
