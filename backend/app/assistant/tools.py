"""Tools the assistant's language model may call.

Every tool:
  * reuses the app's existing analysis code (deep-dive, options analyser,
    sector health, news pipeline), so the assistant never computes a number
    differently from the screens the user already sees;
  * returns a COMPACT dict (a small model reads a few thousand tokens at most):
    labelled values, short lists, no raw price series;
  * includes "source" and "as_of", so the answer can cite where a number came
    from and how fresh it is;
  * returns {"error": ...} instead of raising, so the model can say what it
    could not find rather than guess.

TOOLS maps a name to (function, JSON-schema description); the schema is what
the model sees when choosing a tool.
"""
from __future__ import annotations

import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

INDICES = {"NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "NIFTYNXT50", "SENSEX"}


@dataclass
class Ctx:
    """What a tool may use: the DB session and, for personal data, the user id."""
    db: AsyncSession
    user_id: int | None = None


def _r(x: Any, nd: int = 2) -> Any:
    if isinstance(x, float):
        return None if math.isnan(x) or math.isinf(x) else round(x, nd)
    return x


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ── Symbol resolution ──────────────────────────────────────────────────────
async def resolve_symbol(ctx: Ctx, query: str) -> dict:
    """Company name or ticker -> NSE symbol. Indices pass through."""
    q = (query or "").strip()
    if not q:
        return {"error": "empty company name or symbol"}
    up = q.upper().replace(" ", "")
    if up in INDICES:
        return {"symbol": up, "kind": "index"}
    if up.endswith(".NS"):
        return {"symbol": up, "kind": "stock"}
    from app.deepdive_router import search_stocks
    res = (await search_stocks(q, ctx.db)).get("results", [])
    if not res:
        # A bare ticker the search does not know (e.g. not in the universe yet)
        return {"symbol": f"{up}.NS", "kind": "stock", "note": "not found by name; assumed NSE ticker"}
    best = res[0]
    return {"symbol": best["symbol"], "name": best.get("name"), "kind": "stock",
            "other_matches": [r["symbol"] for r in res[1:4]]}


async def _sym(ctx: Ctx, query: str) -> tuple[str | None, dict]:
    r = await resolve_symbol(ctx, query)
    return r.get("symbol"), r


# ── Trend analysis (pure; tested without data) ─────────────────────────────
def trend_summary(closes: list[float]) -> dict:
    """Plain-language trend facts from daily closes (oldest first)."""
    c = [float(x) for x in closes if x is not None]
    if len(c) < 30:
        return {"error": f"only {len(c)} days of prices"}
    last = c[-1]

    def ret(n: int) -> float | None:
        return _r((last / c[-1 - n] - 1) * 100, 1) if len(c) > n else None

    def sma(n: int) -> float | None:
        return sum(c[-n:]) / n if len(c) >= n else None

    s20, s50, s200 = sma(20), sma(50), sma(200)
    s50_prev = sum(c[-70:-20]) / 50 if len(c) >= 70 else None
    above = {k: (last > v) for k, v in (("sma20", s20), ("sma50", s50), ("sma200", s200)) if v}
    if s50 and s200:
        trend = ("uptrend" if last > s50 > s200 else "downtrend" if last < s50 < s200 else "mixed/sideways")
    elif s50:
        trend = "uptrend" if last > s50 else "downtrend"
    else:
        trend = "unclear"
    daily = [c[i] / c[i - 1] - 1 for i in range(max(1, len(c) - 20), len(c))]
    mean = sum(daily) / len(daily)
    vol20 = math.sqrt(sum((d - mean) ** 2 for d in daily) / max(1, len(daily) - 1)) * math.sqrt(252) * 100
    peak, mdd = c[0], 0.0
    for x in c:
        peak = max(peak, x)
        mdd = min(mdd, x / peak - 1)
    w52 = c[-252:]
    return {
        "last_close": _r(last), "trend": trend,
        "returns_pct": {"1w": ret(5), "1m": ret(21), "3m": ret(63), "6m": ret(126), "1y": ret(min(250, len(c) - 1))},
        "moving_averages": {"sma20": _r(s20), "sma50": _r(s50), "sma200": _r(s200), "price_above": above,
                            "sma50_rising": (s50 > s50_prev) if s50 and s50_prev else None,
                            "golden_cross": (s50 > s200) if s50 and s200 else None},
        "support_resistance": {"support_20d": _r(min(c[-20:])), "resistance_20d": _r(max(c[-20:])),
                               "support_60d": _r(min(c[-60:])), "resistance_60d": _r(max(c[-60:]))},
        "range_52w": {"low": _r(min(w52)), "high": _r(max(w52)),
                      "pct_below_high": _r((1 - last / max(w52)) * 100, 1)},
        "volatility_20d_annualised_pct": _r(vol20, 1),
        "max_drawdown_pct": _r(mdd * 100, 1),
    }


# ── Stock tools ────────────────────────────────────────────────────────────
async def stock_overview(ctx: Ctx, company: str) -> dict:
    """Price, trend, technicals, fundamentals, scores, news tone and peers for one stock."""
    sym, info = await _sym(ctx, company)
    if not sym or info.get("kind") == "index":
        return {"error": f"'{company}' is an index; use market_overview or options_analysis"} if sym else info
    from fastapi import HTTPException

    from app.deepdive_router import deepdive
    try:
        d = await deepdive(sym, ctx.db)
    except HTTPException as e:
        return {"error": f"no data for {sym}: {e.detail}"}
    closes = [p["close"] for p in d.get("price_series") or []]
    t, f = d.get("technical") or {}, d.get("fundamental") or {}
    return {
        "symbol": sym, "name": d.get("name"), "sector": d.get("sector"), "segment": d.get("segment"),
        "price": d.get("current_price"), "week52": d.get("week52"),
        "relative_strength_vs_nifty_20d_pct": d.get("rs_vs_nifty_20d"), "next_earnings": d.get("next_earnings"),
        "trend": trend_summary(closes) if closes else {"error": "no price history"},
        "technical": {k: _r(t.get(k)) for k in ("rsi_14", "macd_hist", "macd_signal", "ema_cross", "bb_percent_b",
                                                "adx", "stoch_k", "volume_ratio", "momentum_20d") if k in t},
        "fundamental": {k: _r(f.get(k)) for k in ("pe_ratio", "pb_ratio", "roe", "debt_to_equity",
                                                  "revenue_growth", "profit_margin", "dividend_yield") if k in f},
        "fundamental_notes": (f.get("reasons") or [])[:4],
        "scores_0_to_1": d.get("scores"), "app_recommendation": d.get("recommendation"),
        "news_sentiment_avg": d.get("news_sentiment"),
        "recent_news": [{"headline": n["headline"], "sentiment": n.get("sentiment"), "source": n.get("source")}
                        for n in (d.get("related_news") or [])[:5]],
        "peers": [p["symbol"] for p in (d.get("peers") or [])[:6]],
        "source": "StockSage deep-dive (Yahoo Finance prices/fundamentals, app indicators, news pipeline)",
        "as_of": _now(),
    }


async def price_quote(ctx: Ctx, company: str) -> dict:
    """Latest price and day change for a stock or index."""
    sym, info = await _sym(ctx, company)
    if not sym:
        return info
    from app.market_data.router import indices, quote
    if info.get("kind") == "index":
        idx = await indices()
        return {"indices": idx, "source": "app market data", "as_of": _now()}
    q = await quote(sym)
    return q | {"source": "app market data (Yahoo Finance)"}


async def options_analysis(ctx: Ctx, underlying: str, expiry: str | None = None) -> dict:
    """The app's option-buying analysis: verdict, volatility, chain metrics, best strike, risks."""
    raw = (underlying or "").strip().upper().replace(" ", "")
    sym = raw.removesuffix(".NS")
    if sym not in INDICES:
        s, info = await _sym(ctx, underlying)
        if not s:
            return info
        sym = s.removesuffix(".NS")
    from fastapi import HTTPException

    from app.options.router import analyze
    try:
        o = await analyze(sym, expiry, ctx.db)
    except HTTPException as e:
        return {"error": f"no option data for {sym}: {e.detail}"}
    rec = o.get("recommended") or {}
    return {
        "underlying": sym, "spot": o.get("spot"), "change_pct": o.get("change_pct"), "expiry": o.get("expiry"),
        "days_to_expiry": _r(o.get("days_to_expiry"), 1), "lot_size": o.get("lot_size"),
        "verdict": {k: o["verdict"].get(k) for k in ("action", "side", "trade_score", "stance", "reason",
                                                     "direction", "suitability")} if o.get("verdict") else None,
        "volatility": o.get("volatility"),
        "chain": {k: (o.get("chain_metrics") or {}).get(k) for k in (
            "atm_strike", "atm_iv", "expected_move", "expected_move_pct", "range_low", "range_high",
            "pcr_oi", "pcr_volume", "max_pain", "skew")},
        "recommended_contract": {k: rec.get(k) for k in ("strike", "side", "entry", "ltp", "iv", "oi",
                                                         "spread_pct")} if rec else None,
        "supporting": (o.get("narrative") or {}).get("supporting", [])[:4],
        "risks": (o.get("narrative") or {}).get("risks", [])[:4],
        "invalidation": (o.get("narrative") or {}).get("invalidation"),
        "warnings": (o.get("warnings") or [])[:3],
        "other_expiries": (o.get("expiries") or [])[:4],
        "source": f"StockSage options analyser ({o.get('source')}, data {o.get('data_timestamp')})",
        "as_of": o.get("generated_at"),
    }


# ── Market-wide tools ──────────────────────────────────────────────────────
async def market_overview(ctx: Ctx) -> dict:
    """Nifty/Sensex, the market guard verdict, sector health and FII/DII flows."""
    from app.engine.router import sector_health
    from app.insights_router import fii_dii
    from app.market_data.router import indices, nifty_status
    out: dict[str, Any] = {"source": "app market data, sector health, NSE FII/DII", "as_of": _now()}
    out["indices"] = await indices()
    out["nifty_guard"] = await nifty_status()
    sectors = (await sector_health(ctx.db)).get("sectors", [])
    out["sectors"] = [{k: s[k] for k in ("sector", "score", "status", "change_pct", "news_score", "top_gainer",
                                         "is_blocked")} for s in sectors]
    try:
        flows = await fii_dii()
        out["fii_dii"] = flows.get("rows", [])[:3] if flows.get("available") else "unavailable (NSE blocked)"
    except Exception:
        out["fii_dii"] = "unavailable"
    return out


async def sector_view(ctx: Ctx, sector: str) -> dict:
    """Health of one sector and its stocks."""
    from app.deepdive_router import sector_stocks
    from app.engine.router import sector_health
    rows = (await sector_health(ctx.db)).get("sectors", [])
    match = next((s for s in rows if s["sector"].lower() == sector.strip().lower()), None)
    if not match:
        return {"error": f"unknown sector '{sector}'", "known_sectors": [s["sector"] for s in rows]}
    stocks = await sector_stocks(match["sector"], ctx.db)
    return {"sector": match, "stocks": (stocks.get("stocks") or stocks.get("results") or [])[:15],
            "source": "StockSage sector health", "as_of": _now()}


async def news_search(ctx: Ctx, company: str | None = None, sector: str | None = None,
                      days: int = 7, only_bad: bool = False, limit: int = 8) -> dict:
    """Recent headlines classified by the app's sentiment model, for a stock, a sector or the market."""
    from app.db.models import NewsItem
    days = max(1, min(int(days or 7), 90))
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = select(NewsItem).where(NewsItem.published_at >= since)
    label = "market"
    if company:
        sym, info = await _sym(ctx, company)
        if not sym:
            return info
        q = q.where(NewsItem.related_symbols.any(sym))
        label = sym
    elif sector:
        q = q.where(NewsItem.related_sectors.any(sector))
        label = sector
    if only_bad:
        q = q.where(NewsItem.is_bad_news.is_(True))
    rows = (await ctx.db.execute(q.order_by(desc(NewsItem.published_at)).limit(max(1, min(limit, 15))))).scalars().all()
    items = [{"date": r.published_at.date().isoformat() if r.published_at else None, "headline": r.headline,
              "source": r.source, "sentiment": r.sentiment, "score": _r(float(r.sentiment_score or 0)),
              "bad_news": r.is_bad_news, "severity": _r(float(r.severity or 0))} for r in rows]
    counts = {s: sum(1 for i in items if (i["sentiment"] or "").upper() == s) for s in ("POSITIVE", "NEGATIVE", "NEUTRAL")}
    return {"scope": label, "days": days, "count": len(items), "sentiment_counts": counts, "headlines": items,
            "source": "StockSage news pipeline (live feeds; sentiment by the champion model)", "as_of": _now()}


async def my_portfolio(ctx: Ctx) -> dict:
    """The signed-in user's capital, holdings and P&L."""
    if ctx.user_id is None:
        return {"error": "not signed in"}
    from app.auth_router import CurrentUser
    from app.engine.router import portfolio_summary
    try:
        s = await portfolio_summary(ctx.db, CurrentUser(id=ctx.user_id, username="assistant"))
    except Exception as e:                      # no portfolio yet, etc.
        return {"error": f"portfolio unavailable: {e}"}
    return s | {"source": "your StockSage portfolio", "as_of": _now()}


async def knowledge_search(ctx: Ctx, query: str, k: int = 3) -> dict:
    """Concept explanations from the knowledge base (notes and the StockSage guides)."""
    from app.assistant.knowledge import default_kb
    hits = default_kb().search(query, k=max(1, min(int(k or 3), 5)))
    if not hits:
        return {"error": "nothing in the knowledge base matches", "query": query}
    return {"query": query, "results": hits, "source": "StockSage knowledge base"}


# ── Registry ───────────────────────────────────────────────────────────────
@dataclass
class Tool:
    fn: Callable[..., Awaitable[dict]]
    description: str
    parameters: dict


def _p(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


_COMPANY = {"type": "string", "description": "Company name or NSE ticker, e.g. 'HDFC Bank' or 'TCS'"}
TOOLS: dict[str, Tool] = {
    "resolve_symbol": Tool(resolve_symbol, "Find the NSE ticker for a company name.",
                           _p({"query": _COMPANY}, ["query"])),
    "stock_overview": Tool(stock_overview, "Everything about one stock: price, trend (returns, moving averages, "
                           "support/resistance, volatility), technical indicators, fundamentals, app scores, "
                           "news tone, peers. Use for analysis, trend or 'should I buy' questions.",
                           _p({"company": _COMPANY}, ["company"])),
    "price_quote": Tool(price_quote, "Latest price and today's change for a stock or index.",
                        _p({"company": {"type": "string", "description": "Company, ticker, or NIFTY/SENSEX"}},
                           ["company"])),
    "options_analysis": Tool(options_analysis, "Option-buying analysis for an index (NIFTY, BANKNIFTY, ...) or "
                             "F&O stock: verdict, IV vs HV, expected move, PCR, max pain, recommended strike, "
                             "supporting reasons and risks.",
                             _p({"underlying": {"type": "string", "description": "NIFTY, BANKNIFTY or a stock"},
                                 "expiry": {"type": "string", "description": "Optional, e.g. '01-Dec-2026'"}},
                                ["underlying"])),
    "market_overview": Tool(market_overview, "Today's market: Nifty and Sensex, the market guard, sector health "
                            "and FII/DII flows.", _p({}, [])),
    "sector_view": Tool(sector_view, "Health and stocks of one sector (IT, Banking & Finance, Pharma & "
                        "Healthcare, Oil & Gas, Metal, Energy & Power, Manufacturing, FMCG, Services).",
                        _p({"sector": {"type": "string"}}, ["sector"])),
    "news_search": Tool(news_search, "Recent classified headlines for a stock, a sector, or the whole market.",
                        _p({"company": _COMPANY, "sector": {"type": "string"},
                            "days": {"type": "integer", "description": "Look-back, 1-90 days (default 7)"},
                            "only_bad": {"type": "boolean", "description": "Only adverse news"}}, [])),
    "my_portfolio": Tool(my_portfolio, "The user's own holdings, capital and profit/loss.", _p({}, [])),
    "knowledge_search": Tool(knowledge_search, "Explanations of market concepts: options (Greeks, IV, PCR, max "
                             "pain, strategies), technical indicators, fundamental ratios, Indian market rules and "
                             "taxes, risk management, and how every StockSage screen and rule works.",
                             _p({"query": {"type": "string", "description": "The concept to explain"}},
                                ["query"])),
}


def schemas() -> list[dict]:
    """Tool definitions in the common function-calling format."""
    return [{"type": "function", "function": {"name": n, "description": t.description, "parameters": t.parameters}}
            for n, t in TOOLS.items()]


async def call(ctx: Ctx, name: str, args: dict | None) -> dict:
    """Run one tool by name; never raises (errors come back as data)."""
    tool = TOOLS.get(name)
    if tool is None:
        return {"error": f"unknown tool '{name}'", "available": list(TOOLS)}
    allowed = set(tool.parameters["properties"])
    clean = {k: v for k, v in (args or {}).items() if k in allowed and v not in (None, "")}
    missing = [k for k in tool.parameters["required"] if k not in clean]
    if missing:
        return {"error": f"missing arguments {missing} for {name}"}
    try:
        return await tool.fn(ctx, **clean)
    except Exception as e:                      # a data source failing must not crash the chat
        return {"error": f"{name} failed: {type(e).__name__}: {str(e)[:200]}"}
