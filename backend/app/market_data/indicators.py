"""Technical indicators computed directly with pandas — no pandas-ta.

Every function takes OHLCV data and returns plain numbers. `compute_all`
assembles the full technical picture for one stock, including a transparent
0–1 technical score with plain-English reasons for every component.
"""
from dataclasses import dataclass, field

import numpy as np
import pandas as pd


# ── Individual indicators ────────────────────────────────────────────────────

def rsi(close: pd.Series, period: int = 14) -> float:
    """Relative Strength Index using Wilder's smoothing."""
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, min_periods=period).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, min_periods=period).mean()
    rs = gain / loss.replace(0, np.nan)
    out = 100 - (100 / (1 + rs))
    # Edge cases: zero losses → RSI 100; zero gains AND losses (flat) → 50
    out = out.where(loss != 0, np.where(gain > 0, 100.0, 50.0))
    val = out.iloc[-1]
    return round(float(val), 2) if not np.isnan(val) else 50.0


def macd(close: pd.Series) -> tuple[float, str]:
    """MACD(12,26,9). Returns (latest histogram, cross signal).

    Cross signal is BULLISH_CROSS / BEARISH_CROSS if the MACD line crossed
    its signal line within the last 3 bars, else NONE.
    """
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    macd_line = ema12 - ema26
    signal_line = macd_line.ewm(span=9, adjust=False).mean()
    hist = macd_line - signal_line

    cross = "NONE"
    above = (macd_line > signal_line).astype(int)
    recent_flips = above.diff().iloc[-3:]
    if (recent_flips == 1).any():
        cross = "BULLISH_CROSS"
    elif (recent_flips == -1).any():
        cross = "BEARISH_CROSS"
    return round(float(hist.iloc[-1]), 4), cross


def ema(close: pd.Series, span: int) -> float:
    """Exponential moving average, latest value."""
    return round(float(close.ewm(span=span, adjust=False).mean().iloc[-1]), 2)


def ema_cross(close: pd.Series) -> str:
    """GOLDEN if EMA20 crossed above EMA50 in last 5 bars, DEATH if below, else NONE."""
    e20 = close.ewm(span=20, adjust=False).mean()
    e50 = close.ewm(span=50, adjust=False).mean()
    above = (e20 > e50).astype(int)
    flips = above.diff().iloc[-5:]
    if (flips == 1).any():
        return "GOLDEN"
    if (flips == -1).any():
        return "DEATH"
    return "NONE"


def bollinger_percent_b(close: pd.Series, period: int = 20, num_std: float = 2.0) -> float:
    """%B: 0 = at lower band, 1 = at upper band. Can exceed [0,1] in extremes."""
    mid = close.rolling(period).mean()
    std = close.rolling(period).std()
    upper, lower = mid + num_std * std, mid - num_std * std
    band_width = (upper - lower).iloc[-1]
    if band_width == 0 or np.isnan(band_width):
        return 0.5
    return round(float((close.iloc[-1] - lower.iloc[-1]) / band_width), 3)


def adx(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> float:
    """Average Directional Index (Wilder). Trend strength, 0–100."""
    up = high.diff()
    down = -low.diff()
    plus_dm = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=high.index)
    minus_dm = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=high.index)

    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs(),
    ], axis=1).max(axis=1)

    atr = tr.ewm(alpha=1 / period, min_periods=period).mean()
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, min_periods=period).mean() / atr
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, min_periods=period).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    out = dx.ewm(alpha=1 / period, min_periods=period).mean()
    val = out.iloc[-1]
    return round(float(val), 2) if not np.isnan(val) else 0.0


def stochastic_k(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> float:
    """Stochastic %K (smoothed over 3)."""
    lowest = low.rolling(period).min()
    highest = high.rolling(period).max()
    rng = (highest - lowest).replace(0, np.nan)
    k = (100 * (close - lowest) / rng).rolling(3).mean()
    val = k.iloc[-1]
    return round(float(val), 2) if not np.isnan(val) else 50.0


def volume_ratio(volume: pd.Series, period: int = 20) -> float:
    """Today's volume vs its 20-day SMA. >1 = above-average interest."""
    sma = volume.rolling(period).mean().iloc[-1]
    if sma == 0 or np.isnan(sma):
        return 1.0
    return round(float(volume.iloc[-1] / sma), 3)


def momentum(close: pd.Series, period: int = 20) -> float:
    """20-day price momentum as a fraction (0.05 = +5%)."""
    if len(close) <= period:
        return 0.0
    return round(float(close.iloc[-1] / close.iloc[-period - 1] - 1), 4)


def dist_from_52w_high(close: pd.Series) -> float:
    """How far below the 52-week high we are (0 = at high, 0.3 = 30% below)."""
    high_52w = close.iloc[-252:].max()
    return round(float(1 - close.iloc[-1] / high_52w), 3)


# ── Assembled snapshot with transparent scoring ──────────────────────────────

@dataclass
class TechnicalSnapshot:
    """Full technical picture for one stock on one day."""

    rsi_14: float = 50.0
    macd_hist: float = 0.0
    macd_signal: str = "NONE"
    ema_20: float = 0.0
    ema_50: float = 0.0
    ema_cross: str = "NONE"
    bb_percent_b: float = 0.5
    adx: float = 0.0
    stoch_k: float = 50.0
    volume_ratio: float = 1.0
    momentum_20d: float = 0.0
    dist_52w_high: float = 0.0
    technical_score: float = 0.5
    reasons: list[str] = field(default_factory=list)


def compute_all(df: pd.DataFrame, last_bar_partial: bool = False) -> TechnicalSnapshot:
    """Compute every indicator plus the weighted technical score.

    Args:
        df: OHLCV DataFrame from yfinance (columns: Open, High, Low, Close, Volume),
            ideally 1 year of daily bars (>= 60 rows minimum).
        last_bar_partial: True when the market is open and the last row is
            today's incomplete bar. Volume comparison then uses the last
            COMPLETED bar — otherwise a 10 AM run sees "today's volume" at a
            fraction of the daily average and wrongly penalizes the stock.

    Score weights (sum to 1.0 — fully transparent):
        trend 0.25 · momentum/RSI 0.20 · MACD 0.20 · position 0.15 ·
        strength/ADX 0.10 · volume 0.10
    """
    if df is None or len(df) < 60:
        return TechnicalSnapshot(reasons=["Insufficient price history (<60 days) — neutral score."])

    close, high, low = df["Close"], df["High"], df["Low"]
    vol = df["Volume"].iloc[:-1] if last_bar_partial and len(df) > 61 else df["Volume"]

    snap = TechnicalSnapshot(
        rsi_14=rsi(close),
        ema_20=ema(close, 20),
        ema_50=ema(close, 50),
        ema_cross=ema_cross(close),
        bb_percent_b=bollinger_percent_b(close),
        adx=adx(high, low, close),
        stoch_k=stochastic_k(high, low, close),
        volume_ratio=volume_ratio(vol),
        momentum_20d=momentum(close),
        dist_52w_high=dist_from_52w_high(close),
    )
    snap.macd_hist, snap.macd_signal = macd(close)

    price = float(close.iloc[-1])
    reasons: list[str] = []

    # 1. Trend (0.25) — EMA alignment
    if snap.ema_cross == "GOLDEN":
        trend = 1.0; reasons.append("Golden cross: EMA20 just crossed above EMA50 — fresh uptrend")
    elif snap.ema_cross == "DEATH":
        trend = 0.0; reasons.append("Death cross: EMA20 just crossed below EMA50 — fresh downtrend")
    elif snap.ema_20 > snap.ema_50 and price > snap.ema_20:
        trend = 0.9; reasons.append("Healthy uptrend: price above EMA20, EMA20 above EMA50")
    elif snap.ema_20 > snap.ema_50:
        trend = 0.6; reasons.append("Uptrend intact but price dipped below EMA20 — possible pullback entry")
    elif price > snap.ema_20:
        trend = 0.4; reasons.append("Price recovering above EMA20 but longer trend still down")
    else:
        trend = 0.1; reasons.append("Downtrend: price below both EMAs")

    # 2. RSI momentum (0.20)
    r = snap.rsi_14
    if 45 <= r <= 65:
        rsi_s = 1.0; reasons.append(f"RSI {r:.0f}: healthy momentum zone, not overbought")
    elif 30 <= r < 45:
        rsi_s = 0.7; reasons.append(f"RSI {r:.0f}: cooling off / early recovery")
    elif r < 30:
        rsi_s = 0.5; reasons.append(f"RSI {r:.0f}: oversold — potential value entry but falling knife risk")
    elif 65 < r <= 75:
        rsi_s = 0.4; reasons.append(f"RSI {r:.0f}: getting overbought — chasing risk")
    else:
        rsi_s = 0.1; reasons.append(f"RSI {r:.0f}: heavily overbought — poor entry")

    # 3. MACD (0.20)
    if snap.macd_signal == "BULLISH_CROSS":
        macd_s = 1.0; reasons.append("MACD bullish crossover within last 3 sessions")
    elif snap.macd_signal == "BEARISH_CROSS":
        macd_s = 0.0; reasons.append("MACD bearish crossover within last 3 sessions")
    elif snap.macd_hist > 0:
        macd_s = 0.7; reasons.append("MACD histogram positive — momentum with the bulls")
    else:
        macd_s = 0.2; reasons.append("MACD histogram negative — momentum with the bears")

    # 4. Position (0.15) — Bollinger %B + distance from 52w high
    b = snap.bb_percent_b
    if b > 1.0:
        pos = 0.1; reasons.append("Price above upper Bollinger band — stretched")
    elif b > 0.8:
        pos = 0.4
    elif b < 0.0:
        pos = 0.4; reasons.append("Price below lower Bollinger band — capitulation zone")
    elif b < 0.25:
        pos = 0.8; reasons.append("Price near lower Bollinger band — favourable entry zone")
    else:
        pos = 0.6
    if snap.dist_52w_high > 0.30:
        pos = max(0.0, pos - 0.2)
        reasons.append(f"Trading {snap.dist_52w_high:.0%} below 52-week high — verify it's not a falling knife")

    # 5. Trend strength (0.10) — ADX in context of direction
    uptrend = snap.ema_20 > snap.ema_50
    if snap.adx > 25 and uptrend:
        adx_s = 1.0; reasons.append(f"ADX {snap.adx:.0f}: strong, confirmed uptrend")
    elif snap.adx > 25:
        adx_s = 0.0; reasons.append(f"ADX {snap.adx:.0f}: strong DOWNtrend — avoid")
    else:
        adx_s = 0.5

    # 6. Volume confirmation (0.10)
    v = snap.volume_ratio
    up_day = float(close.iloc[-1]) >= float(close.iloc[-2])
    if v > 1.2 and up_day:
        vol_s = 1.0; reasons.append(f"Volume {v:.1f}× average on an up day — conviction buying")
    elif v > 1.2:
        vol_s = 0.2; reasons.append(f"Volume {v:.1f}× average on a down day — distribution warning")
    else:
        vol_s = 0.5

    snap.technical_score = round(
        0.25 * trend + 0.20 * rsi_s + 0.20 * macd_s + 0.15 * pos + 0.10 * adx_s + 0.10 * vol_s, 3
    )

    # CHOP GUARD: 20d volatility under 0.5% of price = sideways band where
    # EMA/MACD crosses are whipsaw noise. No edge in flat markets — cap the
    # score below the 0.60 buy threshold.
    chop = float(close.iloc[-21:].std()) / price if price else 0.0
    if chop < 0.005 and snap.technical_score > 0.55:
        snap.technical_score = 0.55
        reasons.append("Sideways chop (20d volatility <0.5%) — cross signals treated as noise, score capped")

    snap.reasons = reasons
    return snap
