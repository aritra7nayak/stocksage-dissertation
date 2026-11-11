"""NSE option-chain adapter — live chain, expiries and lot sizes, no API key.

NSE's JSON endpoints only answer a client that first loaded the website and
holds its cookies, so one shared httpx session warms itself on the
option-chain page and re-warms on any 401/403. Responses are cached briefly
(chain 60 s, expiries 10 min, lot sizes 12 h) to stay polite to NSE.

If NSE is unreachable (blocked datacenter IP, maintenance, rate limit), the
caller falls back to `modeled_chain` — Black-Scholes prices from realised
volatility, flagged source="MODELED" so the UI never passes it off as live.
"""
import calendar
import csv
import io
import logging
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any
from urllib.parse import quote

import httpx
import pytz

from app.config import get_settings
from app.options import pricing

logger = logging.getLogger("stocksage.options.nse")
settings = get_settings()
IST = pytz.timezone(settings.timezone)

BASE = "https://www.nseindia.com"
_HEADERS = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": f"{BASE}/option-chain",
}

# Index underlyings we can analyse. FINNIFTY / MIDCPNIFTY have option chains
# but no usable price history on Yahoo, and the engine needs ≥60 daily bars.
INDICES: dict[str, dict] = {
    "NIFTY": {"name": "Nifty 50", "yf": "^NSEI", "step": 50, "lot": 65, "sector": None},
    "BANKNIFTY": {"name": "Nifty Bank", "yf": "^NSEBANK", "step": 100, "lot": 30,
                  "sector": "Banking & Finance"},
}


class NSEUnavailable(Exception):
    """NSE did not return usable data; callers switch to the modeled chain."""


_cache: dict[str, tuple[float, Any]] = {}
_lock = threading.Lock()
_client: httpx.Client | None = None
_warmed_at = 0.0


def _cached(key: str) -> Any | None:
    hit = _cache.get(key)
    return hit[1] if hit and hit[0] > time.time() else None


def _put(key: str, value: Any, ttl: int) -> None:
    _cache[key] = (time.time() + ttl, value)


def _session(force: bool = False) -> httpx.Client:
    global _client, _warmed_at
    if _client is None:
        _client = httpx.Client(headers=_HEADERS, follow_redirects=True, timeout=12)
    if force or time.time() - _warmed_at > 300:
        _client.cookies.clear()
        _client.get(f"{BASE}/option-chain")
        _warmed_at = time.time()
    return _client


def _get(url: str) -> httpx.Response:
    """GET with the warmed session; one re-warm + retry on auth/blocks."""
    with _lock:   # NSE dislikes parallel bursts from one cookie jar
        try:
            r = _session().get(url)
            if r.status_code in (401, 403):
                r = _session(force=True).get(url)
        except httpx.HTTPError as exc:
            raise NSEUnavailable(f"NSE request failed: {exc}") from exc
    if r.status_code != 200:
        raise NSEUnavailable(f"NSE returned HTTP {r.status_code}")
    return r


def _json(url: str) -> dict:
    try:
        data = _get(url).json()
    except ValueError as exc:
        raise NSEUnavailable("NSE returned non-JSON (likely a bot challenge)") from exc
    if not data:
        raise NSEUnavailable("NSE returned an empty payload")
    return data


# ── Lot sizes / F&O universe ─────────────────────────────────────────────────

def lot_sizes() -> dict[str, dict]:
    """{SYMBOL: {"name", "lot"}} for every F&O underlying. Falls back to indices."""
    hit = _cached("lots")
    if hit is not None:
        return hit
    out = {k: {"name": v["name"], "lot": v["lot"]} for k, v in INDICES.items()}
    try:
        text = _get("https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv").text
        for row in csv.reader(io.StringIO(text)):
            if len(row) < 3:
                continue
            name, sym = row[0].strip(), row[1].strip()
            lot = next((c.strip() for c in row[2:] if c.strip().isdigit()), None)
            if not sym or sym.upper() == "SYMBOL" or lot is None:
                continue
            out[sym] = {"name": name.title(), "lot": int(lot)}
        _put("lots", out, 12 * 3600)
    except NSEUnavailable as exc:
        logger.warning("Lot-size file unavailable (%s) — index lots only", exc)
        _put("lots", out, 600)
    return out


# ── Expiries ─────────────────────────────────────────────────────────────────

def parse_expiry(s: str) -> date:
    return datetime.strptime(s, "%d-%b-%Y").date()


def fmt_expiry(d: date) -> str:
    return d.strftime("%d-%b-%Y")


def _last_tuesday(year: int, month: int) -> date:
    last = date(year, month, calendar.monthrange(year, month)[1])
    return last - timedelta(days=(last.weekday() - 1) % 7)


def modeled_expiries(symbol: str, today: date | None = None) -> list[date]:
    """Calendar-rule expiries (holidays not modeled): NIFTY weekly Tuesdays,
    everything else the last Tuesday of the month."""
    today = today or datetime.now(IST).date()
    out: list[date] = []
    if symbol == "NIFTY":
        d = today + timedelta(days=(1 - today.weekday()) % 7)
        out = [d + timedelta(weeks=i) for i in range(5)]
    y, m = today.year, today.month
    for _ in range(3):
        lt = _last_tuesday(y, m)
        if lt >= today and lt not in out:
            out.append(lt)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    if len(out) < 3:
        lt = _last_tuesday(y, m)
        out.append(lt)
    return sorted(out)


def expiries(symbol: str) -> list[date]:
    """Live expiries from NSE (cached 10 min). Raises NSEUnavailable."""
    key = f"exp:{symbol}"
    hit = _cached(key)
    if hit is not None:
        return hit
    data = _json(f"{BASE}/api/option-chain-contract-info?symbol={quote(symbol)}")
    today = datetime.now(IST).date()
    out = sorted(d for d in (parse_expiry(s) for s in data.get("expiryDates", [])) if d >= today)
    if not out:
        raise NSEUnavailable("NSE listed no future expiries")
    _put(key, out, 600)
    return out


# ── Option chain ─────────────────────────────────────────────────────────────

def _leg(raw: dict | None) -> dict | None:
    if not raw or not raw.get("strikePrice"):
        return None
    iv = float(raw.get("impliedVolatility") or 0)
    return {
        "ltp": float(raw.get("lastPrice") or 0),
        "bid": float(raw.get("buyPrice1") or 0),
        "ask": float(raw.get("sellPrice1") or 0),
        "iv": iv / 100 if iv > 0 else None,
        "oi": int(raw.get("openInterest") or 0),
        "chg_oi": int(raw.get("changeinOpenInterest") or 0),
        "volume": int(raw.get("totalTradedVolume") or 0),
        "chg_pct": round(float(raw.get("pChange") or 0), 2),
    }


def chain(symbol: str, expiry: date) -> dict:
    """Live chain for one expiry: {source, spot, timestamp, rows[]}. Raises NSEUnavailable."""
    key = f"chain:{symbol}:{expiry}"
    hit = _cached(key)
    if hit is not None:
        return hit
    kind = "Indices" if symbol in INDICES else "Equity"
    data = _json(f"{BASE}/api/option-chain-v3?type={kind}&symbol={quote(symbol)}&expiry={fmt_expiry(expiry)}")
    rec = data.get("records") or {}
    rows = []
    for d in rec.get("data") or []:
        ce, pe = _leg(d.get("CE")), _leg(d.get("PE"))
        if ce or pe:
            rows.append({"strike": float(d["strikePrice"]), "ce": ce, "pe": pe})
    spot = rec.get("underlyingValue")
    if not rows or not spot:
        raise NSEUnavailable(f"Empty option chain for {symbol} {fmt_expiry(expiry)}")
    out = {
        "source": "NSE",
        "spot": float(spot),
        "timestamp": rec.get("timestamp"),
        "rows": sorted(rows, key=lambda r: r["strike"]),
    }
    _put(key, out, 60)
    return out


def strike_step(symbol: str, spot: float) -> float:
    if symbol in INDICES:
        return INDICES[symbol]["step"]
    for limit, step in ((100, 1), (250, 2.5), (500, 5), (1000, 10), (2500, 20), (5000, 50)):
        if spot < limit:
            return step
    return 100


def modeled_chain(symbol: str, spot: float, sigma: float, T: float, n_each_side: int = 15) -> dict:
    """Synthetic chain from Black-Scholes at `sigma`. No OI, no bid/ask — every
    consumer must treat OI-derived signals as unavailable."""
    step = strike_step(symbol, spot)
    atm = round(spot / step) * step
    rows = []
    for i in range(-n_each_side, n_each_side + 1):
        k = atm + i * step
        if k <= 0:
            continue
        leg = lambda kind: {  # noqa: E731
            "ltp": round(pricing.bs_price(spot, k, T, sigma, kind), 2),
            "bid": 0.0, "ask": 0.0, "iv": sigma, "oi": 0, "chg_oi": 0, "volume": 0, "chg_pct": 0.0,
        }
        rows.append({"strike": float(k), "ce": leg("CE"), "pe": leg("PE")})
    return {"source": "MODELED", "spot": spot,
            "timestamp": datetime.now(IST).strftime("%d-%b-%Y %H:%M:%S"), "rows": rows}
