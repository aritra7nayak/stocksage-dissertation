"""Market data fetcher — yfinance adapter with caching and retries.

Design notes:
- yfinance NSE data is ~15-minute delayed. Every payload carries data freshness.
- In-memory TTL cache (no Redis needed at this scale): 15 min for prices,
  4 h for fundamentals.
- Batch download for the universe to respect Yahoo rate limits.
- All retries use exponential backoff via tenacity.
"""
import logging
import time
from datetime import datetime
from typing import Any

import pandas as pd
import pytz
import yfinance as yf
from tenacity import retry, stop_after_attempt, wait_exponential

from app.config import get_settings

logger = logging.getLogger("stocksage.market")
settings = get_settings()

PRICE_TTL = 15 * 60          # seconds
FUNDAMENTALS_TTL = 4 * 3600
_cache: dict[str, tuple[float, Any]] = {}


def _cache_get(key: str) -> Any | None:
    hit = _cache.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    return None


def _cache_put(key: str, value: Any, ttl: int) -> None:
    _cache[key] = (time.time() + ttl, value)


def is_market_open_ist(now: datetime | None = None) -> bool:
    """NSE hours: 09:15–15:30 IST, Mon–Fri. (Exchange holidays not modeled; a
    holiday simply means data doesn't move, which the engine tolerates.)"""
    ist = pytz.timezone(settings.timezone)
    now = now or datetime.now(ist)
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return (9 * 60 + 15) <= minutes <= (15 * 60 + 30)


def _clean_history(df: pd.DataFrame) -> pd.DataFrame:
    """Drop rows Yahoo returns as placeholders.

    A batch download pads every ticker onto a shared date index, so a symbol
    that has no bar for a day comes back with NaN Close (sometimes alongside a
    0 Volume, which defeats dropna(how="all")). Callers read Close.iloc[-1],
    and a NaN there poisons every derived number downstream — so strip those
    rows here, once, for everyone.
    """
    if df is None or df.empty:
        return df
    df = df.dropna(how="all")
    if "Close" in df.columns:
        df = df[df["Close"].notna()]
    return df


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10), reraise=True)
def _download_history(symbol: str, period: str) -> pd.DataFrame:
    df = _clean_history(yf.Ticker(symbol).history(period=period, auto_adjust=True))
    if df is None or df.empty:
        raise ValueError(f"No price data returned for {symbol}")
    return df


def get_history(symbol: str, period: str = "1y") -> pd.DataFrame:
    """Daily OHLCV for one symbol, cached 15 minutes."""
    key = f"hist:{symbol}:{period}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    df = _download_history(symbol, period)
    _cache_put(key, df, PRICE_TTL)
    return df


def get_quote(symbol: str) -> dict:
    """Latest price, previous close, and change % for one symbol."""
    df = get_history(symbol, period="5d")
    last, prev = float(df["Close"].iloc[-1]), float(df["Close"].iloc[-2])
    return {
        "symbol": symbol,
        "price": round(last, 2),
        "prev_close": round(prev, 2),
        "change_pct": round((last / prev - 1) * 100, 3),
        "as_of": df.index[-1].isoformat(),
        "is_live_session": is_market_open_ist(),
    }


def get_indices() -> dict:
    """Nifty 50 + Sensex with change %."""
    return {
        "nifty50": get_quote(settings.nifty50_index),
        "sensex": get_quote(settings.sensex_index),
    }


def get_gold_silver() -> dict:
    """Gold and Silver ETF quotes (GOLDBEES / SILVERBEES)."""
    return {
        "gold": get_quote(settings.gold_etf),
        "silver": get_quote(settings.silver_etf),
    }


def get_nifty_status() -> dict:
    """Rule R11 input: did the Nifty fall?

    Timing semantics (fixes the original spec's 9-AM paradox):
    - During market hours → compares LIVE price vs yesterday's close (intraday guard).
    - Outside market hours → compares last close vs prior close (previous-session guard).
    """
    q = get_quote(settings.nifty50_index)
    fell = q["change_pct"] <= settings.nifty_fall_threshold
    basis = "live intraday session" if q["is_live_session"] else "previous session close"
    return {
        "nifty_value": q["price"],
        "change_pct": q["change_pct"],
        "nifty_fell": fell,
        "guard_basis": basis,
        "rule": "R11",
        "verdict": (
            f"Nifty {'fell' if fell else 'is steady/up'} ({q['change_pct']:+.2f}%, based on {basis}). "
            + ("Buying is PAUSED today." if fell else "Buying is permitted by R11.")
        ),
    }


@retry(stop=stop_after_attempt(3), wait=wait_exponential(multiplier=1, min=2, max=10), reraise=True)
def get_fundamentals_raw(symbol: str) -> dict:
    """Raw yfinance .info dict, cached 4 hours. Returns {} on failure (handled upstream)."""
    key = f"fund:{symbol}"
    cached = _cache_get(key)
    if cached is not None:
        return cached
    info = yf.Ticker(symbol).info or {}
    _cache_put(key, info, FUNDAMENTALS_TTL)
    return info


def cached_history(symbols: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
    """Cache-only sibling of batch_history — never touches the network.

    Lets a request answer instantly with whatever is already warm and leave the
    rest to be filled in by later, smaller calls.
    """
    out: dict[str, pd.DataFrame] = {}
    for s in symbols:
        df = _cache_get(f"hist:{s}:{period}")
        if df is not None:
            out[s] = df
    return out


def batch_history(symbols: list[str], period: str = "1y") -> dict[str, pd.DataFrame]:
    """Download history for many symbols in one threaded request.

    Returns {symbol: DataFrame}; symbols with no data are silently omitted
    (logged) so one delisted name never breaks the daily run.
    """
    out: dict[str, pd.DataFrame] = {}
    fresh = [s for s in symbols if _cache_get(f"hist:{s}:{period}") is None]
    for s in set(symbols) - set(fresh):
        out[s] = _cache_get(f"hist:{s}:{period}")

    if fresh:
        logger.info("Batch downloading %d symbols…", len(fresh))
        raw = yf.download(fresh, period=period, auto_adjust=True, group_by="ticker",
                          threads=True, progress=False)
        for s in fresh:
            try:
                df = _clean_history(raw[s] if len(fresh) > 1 else raw)
                if not df.empty:
                    _cache_put(f"hist:{s}:{period}", df, PRICE_TTL)
                    out[s] = df
                else:
                    logger.warning("No data for %s — skipped", s)
            except (KeyError, TypeError):
                logger.warning("No data for %s — skipped", s)
    return out
