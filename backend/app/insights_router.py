"""Insights — the app's self-knowledge layer.

equity-curve : daily snapshots of YOUR paper portfolio vs the Nifty
journal      : every closed trade graded with hindsight
risk         : concentration, beta, worst-day estimate
dividends    : what your holdings have paid since you bought them
watch        : per-holding flags (bad news, volume spikes, earnings, ex-div)
health       : data-quality monitor (coverage, benched symbols, staleness)
guard-diary  : every RED day vs what the market actually did next
fii-dii      : institutional flows (best-effort from NSE; may be unavailable)

Snapshots are LAZY: fetching the equity curve upserts today's snapshot first,
so the history builds itself as long as the app is opened on trading days.
Uses raw SQL for the two new tables (no model changes needed).
"""
import asyncio
import logging
from datetime import datetime, timedelta

import pytz
from fastapi import APIRouter, Depends
from sqlalchemy import desc, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import get_db, AsyncSessionLocal
from app.db.models import (Holding, NewsItem, Portfolio, StockAnalysis,
                           StockUniverse, SuggestionLog, Transaction)
from app.market_data import fetcher
from app.nlp.service import get_linker
from app.auth_router import CurrentUser, get_current_user

logger = logging.getLogger("stocksage.insights")
settings = get_settings()
router = APIRouter(prefix="/api/insights", tags=["insights"])

IST = pytz.timezone(settings.timezone)


async def _user_pf(db, user_id: int):
    pf = (await db.execute(select(Portfolio)
                           .where(Portfolio.user_id == user_id).limit(1))).scalar_one_or_none()
    return pf


def _today():
    return datetime.now(IST).date()


async def _live_holdings_value(holdings) -> tuple[float, dict]:
    """Fresh close for each holding (one small batch); falls back to stored."""
    if not holdings:
        return 0.0, {}
    symbols = [h.symbol for h in holdings]
    prices: dict = {}
    try:
        data = await asyncio.to_thread(fetcher.batch_history, symbols, "5d")
        for s, df in (data or {}).items():
            if df is not None and len(df):
                prices[s] = float(df["Close"].iloc[-1])
    except Exception:
        logger.warning("Live price refresh failed — using stored prices")
    total = 0.0
    for h in holdings:
        px = prices.get(h.symbol, float(h.current_price or h.avg_buy_price))
        total += px * h.quantity
    return round(total, 2), prices


@router.get("/equity-curve")
async def equity_curve(db: AsyncSession = Depends(get_db),
                       user: CurrentUser = Depends(get_current_user)) -> dict:
    """Upsert today's snapshot, then return the whole series vs Nifty."""
    pf = await _user_pf(db, user.id)
    if not pf:
        return {"points": [], "note": "No portfolio yet."}
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all()
    hv, _ = await _live_holdings_value(holdings)
    cash = float(pf.cash_balance)
    total = round(cash + hv, 2)

    nifty_close = None
    try:
        ndf = await asyncio.to_thread(fetcher.get_history, settings.nifty50_index, "5d")
        nifty_close = round(float(ndf["Close"].iloc[-1]), 2)
    except Exception:
        pass

    guard_status, guard_verdict = "OK", None
    try:
        from app.sentiment.pipeline import guard_status as g
        gv = await g(db)
        guard_status = "RED" if gv.get("market_stopped") else "OK"
        guard_verdict = gv.get("verdict")
    except Exception:
        pass

    await db.execute(text("""
        INSERT INTO portfolio_snapshots
            (snapshot_date, total_value, cash, holdings_value, nifty_close, guard_status, guard_verdict, user_id)
        VALUES (:d, :t, :c, :h, :n, :gs, :gvd, :uid)
        ON CONFLICT (user_id, snapshot_date) DO UPDATE SET
            total_value=:t, cash=:c, holdings_value=:h,
            nifty_close=COALESCE(:n, portfolio_snapshots.nifty_close),
            guard_status=:gs, guard_verdict=:gvd
    """), {"d": _today(), "t": total, "c": cash, "h": hv,
           "n": nifty_close, "gs": guard_status, "gvd": guard_verdict, "uid": user.id})
    await db.commit()

    rows = (await db.execute(text(
        "SELECT snapshot_date, total_value, nifty_close FROM portfolio_snapshots "
        "WHERE user_id = :uid ORDER BY snapshot_date"), {"uid": user.id})).all()
    points, base_v, base_n = [], None, None
    for d, v, n in rows:
        v = float(v); n = float(n) if n is not None else None
        if base_v is None:
            base_v = v
        if base_n is None and n:
            base_n = n
        points.append({
            "date": str(d),
            "value": v,
            "portfolio_pct": round((v / base_v - 1) * 100, 2) if base_v else 0,
            "nifty_pct": round((n / base_n - 1) * 100, 2) if (n and base_n) else None,
        })
    ret = points[-1]["portfolio_pct"] if points else 0
    nret = points[-1]["nifty_pct"] if points and points[-1]["nifty_pct"] is not None else None
    return {"points": points, "days_tracked": len(points), "current_value": total,
            "return_pct": ret, "nifty_return_pct": nret,
            "alpha_pct": round(ret - nret, 2) if nret is not None else None}


@router.get("/journal")
async def journal(db: AsyncSession = Depends(get_db),
                  user: CurrentUser = Depends(get_current_user)) -> dict:
    """Closed trades graded with hindsight; open positions with their entry score."""
    pf = await _user_pf(db, user.id)
    if not pf:
        return {"closed": [], "open": []}
    txns = (await db.execute(select(Transaction)
                             .where(Transaction.portfolio_id == pf.id)
                             .order_by(desc(Transaction.executed_at)).limit(200))).scalars().all()
    sells = [t for t in txns if t.action == "SELL"]

    # price history for graded sells (one batch)
    hist = {}
    if sells:
        try:
            hist = await asyncio.to_thread(fetcher.batch_history, list({t.symbol for t in sells}), "1y")
        except Exception:
            hist = {}

    def price_after(sym, when, days=30):
        df = hist.get(sym)
        if df is None or not len(df):
            return None
        target = (when + timedelta(days=days)).date() if hasattr(when, "date") else when
        try:
            idx = df.index.date
            after = [i for i, d in enumerate(idx) if d >= target]
            pos = after[0] if after else len(df) - 1
            return float(df["Close"].iloc[pos])
        except Exception:
            return None

    closed = []
    for t in sells:
        exit_px = float(t.price)
        later = price_after(t.symbol, t.executed_at) if t.executed_at else None
        grade, note = "—", "Not enough data yet"
        if later:
            move = (later / exit_px - 1) * 100
            if move <= -3:
                grade, note = "GOOD EXIT", f"Fell another {abs(move):.1f}% after you sold"
            elif move >= 5:
                grade, note = "SOLD EARLY", f"Rose {move:.1f}% after you sold"
            else:
                grade, note = "NEUTRAL", f"Moved {move:+.1f}% in the 30 days after"
        closed.append({"symbol": t.symbol, "date": str(t.executed_at)[:10] if t.executed_at else None,
                       "qty": t.quantity, "exit_price": exit_px,
                       "pnl_text": t.reason, "grade": grade, "note": note})

    # open positions + their entry suggestion score
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all()
    sug_scores = {}
    if holdings:
        sids = [t.suggestion_id for t in txns if t.action == "BUY" and t.suggestion_id]
        if sids:
            rows = (await db.execute(select(SuggestionLog)
                                     .where(SuggestionLog.id.in_(sids)))).scalars().all()
            for r in rows:
                sug_scores[r.symbol] = float(r.composite_score or 0)
    open_pos = [{"symbol": h.symbol, "qty": h.quantity,
                 "avg_buy": float(h.avg_buy_price),
                 "current": float(h.current_price or h.avg_buy_price),
                 "entry_score": sug_scores.get(h.symbol)} for h in holdings]
    return {"closed": closed, "open": open_pos}


@router.get("/risk")
async def risk(db: AsyncSession = Depends(get_db),
               user: CurrentUser = Depends(get_current_user)) -> dict:
    """Concentration, beta, and what a bad day costs in rupees."""
    pf = await _user_pf(db, user.id)
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all() if pf else []
    if not pf or not holdings:
        return {"has_holdings": False}
    hv, prices = await _live_holdings_value(holdings)
    total = hv + float(pf.cash_balance)

    by_sector: dict[str, float] = {}
    largest = {"symbol": None, "pct": 0.0}
    values = {}
    for h in holdings:
        px = prices.get(h.symbol, float(h.current_price or h.avg_buy_price))
        v = px * h.quantity
        values[h.symbol] = v
        if h.segment not in ("GOLD_ETF", "SILVER_ETF"):
            by_sector[h.sector] = by_sector.get(h.sector, 0) + v
        pct = v / total * 100 if total else 0
        if pct > largest["pct"]:
            largest = {"symbol": h.symbol, "pct": round(pct, 1)}

    sectors = [{"sector": s, "pct": round(v / total * 100, 1),
                "breach": (v / total) > 0.35}
               for s, v in sorted(by_sector.items(), key=lambda x: -x[1])]

    # Portfolio beta: value-weighted 6-month beta vs Nifty
    beta = None
    try:
        symbols = [h.symbol for h in holdings]
        data = await asyncio.to_thread(fetcher.batch_history, symbols, "6mo")
        ndf = await asyncio.to_thread(fetcher.get_history, settings.nifty50_index, "6mo")
        nret = ndf["Close"].pct_change().dropna()
        num = 0.0
        var = float(nret.var())
        for h in holdings:
            df = data.get(h.symbol)
            if df is None or len(df) < 30 or var == 0:
                continue
            sret = df["Close"].pct_change().dropna()
            joined = sret.align(nret, join="inner")
            if len(joined[0]) < 30:
                continue
            cov = float(joined[0].cov(joined[1]))
            w = values.get(h.symbol, 0) / hv if hv else 0
            num += w * (cov / var)
        beta = round(num, 2) if num else None
    except Exception:
        logger.warning("Beta computation failed", exc_info=True)

    bad_day = round(hv * 0.05 * (beta if beta else 1.0), 0)
    return {"has_holdings": True, "total_value": round(total, 2),
            "holdings_value": hv, "cash_pct": round(float(pf.cash_balance) / total * 100, 1) if total else 0,
            "sectors": sectors, "sector_cap_pct": 35,
            "largest_position": largest, "portfolio_beta": beta,
            "bad_day_estimate": bad_day,
            "bad_day_note": f"A −5% market day would cost roughly ₹{bad_day:,.0f} at current beta."}


@router.get("/dividends")
async def dividends(db: AsyncSession = Depends(get_db),
                    user: CurrentUser = Depends(get_current_user)) -> dict:
    """Dividends each holding has paid since your first buy of it."""
    pf = await _user_pf(db, user.id)
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all() if pf else []
    if not holdings:
        return {"items": [], "total": 0.0}
    first_buy = {}
    txns = (await db.execute(select(Transaction)
                             .where(Transaction.portfolio_id == pf.id)
                             .where(Transaction.action == "BUY"))).scalars().all()
    for t in txns:
        d = t.executed_at
        if d and (t.symbol not in first_buy or d < first_buy[t.symbol]):
            first_buy[t.symbol] = d

    def fetch_divs():
        import yfinance as yf
        out = []
        for h in holdings:
            since = first_buy.get(h.symbol)
            try:
                s = yf.Ticker(h.symbol).dividends
                if s is None or s.empty:
                    continue
                if since is not None:
                    s = s[s.index.tz_localize(None) >= since.replace(tzinfo=None)]
                amt = float(s.sum()) * h.quantity
                if amt > 0:
                    out.append({"symbol": h.symbol, "per_share": round(float(s.sum()), 2),
                                "qty": h.quantity, "earned": round(amt, 2),
                                "payouts": len(s)})
            except Exception:
                continue
        return out

    items = await asyncio.to_thread(fetch_divs)
    return {"items": items, "total": round(sum(i["earned"] for i in items), 2),
            "note": "Informational — not auto-credited to cash."}


@router.get("/watch")
async def watch(db: AsyncSession = Depends(get_db),
                user: CurrentUser = Depends(get_current_user)) -> dict:
    """Per-holding attention flags: bad news, volume spikes, earnings, ex-dividend."""
    pf = await _user_pf(db, user.id)
    holdings = (await db.execute(select(Holding)
                                 .where(Holding.portfolio_id == pf.id))).scalars().all() if pf else []
    if not holdings:
        return {"flags": []}

    # bad news today, linked to holdings by the entity linker
    start = datetime.combine(_today(), datetime.min.time(), tzinfo=IST).astimezone(pytz.utc)
    news = (await db.execute(select(NewsItem)
                             .where(NewsItem.fetched_at >= start)
                             .where(NewsItem.is_bad_news.is_(True)))).scalars().all()
    flags: dict[str, list] = {h.symbol: [] for h in holdings}
    linker = await get_linker(db)
    linked = [(n.headline, linker.symbols(n.headline)) for n in news]
    for h in holdings:
        hits = [headline for headline, syms in linked if h.symbol in syms][:2]
        for hh in hits:
            flags[h.symbol].append({"type": "BAD_NEWS", "detail": hh})

    def market_checks():
        import yfinance as yf
        out: dict[str, list] = {h.symbol: [] for h in holdings}
        try:
            data = fetcher.batch_history([h.symbol for h in holdings], "3mo")
        except Exception:
            data = {}
        soon = _today() + timedelta(days=7)
        for h in holdings:
            df = (data or {}).get(h.symbol)
            if df is not None and len(df) >= 21 and "Volume" in df:
                v = df["Volume"]
                avg = float(v.iloc[-21:-1].mean())
                today_v = float(v.iloc[-1])
                if avg > 0 and today_v / avg >= 2.5:
                    out[h.symbol].append({"type": "VOLUME",
                                          "detail": f"Volume {today_v/avg:.1f}× the 20-day average"})
            try:
                cal = yf.Ticker(h.symbol).calendar
                if cal is not None:
                    ed = None
                    if isinstance(cal, dict):
                        ed = cal.get("Earnings Date")
                        ed = ed[0] if isinstance(ed, (list, tuple)) and ed else ed
                        xd = cal.get("Ex-Dividend Date")
                    else:
                        ed = xd = None
                    if ed is not None and hasattr(ed, "year") and _today() <= ed <= soon:
                        out[h.symbol].append({"type": "EARNINGS",
                                              "detail": f"Results expected {ed} — avoid adding just before"})
                    if 'xd' in dir() and xd is not None and hasattr(xd, "year") and _today() <= xd <= soon:
                        out[h.symbol].append({"type": "EX_DIVIDEND",
                                              "detail": f"Ex-dividend {xd} — a dip that day isn't a real fall"})
            except Exception:
                continue
        return out

    mkt = await asyncio.to_thread(market_checks)
    for sym, fl in mkt.items():
        flags[sym].extend(fl)
    return {"flags": [{"symbol": s, "items": f} for s, f in flags.items() if f]}


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db),
                 user: CurrentUser = Depends(get_current_user)) -> dict:
    """Data-quality monitor: coverage, benched symbols, news volume, freshness."""
    active = (await db.execute(select(StockUniverse)
                               .where(StockUniverse.is_active.is_(True)))).scalars().all()
    benched = (await db.execute(select(StockUniverse)
                                .where(StockUniverse.is_active.is_(False)))).scalars().all()
    analyzed_today = (await db.execute(
        select(StockAnalysis.symbol).where(StockAnalysis.analysis_date == _today())
    )).scalars().all()
    last_run = (await db.execute(
        select(SuggestionLog.suggestion_date).order_by(desc(SuggestionLog.suggestion_date)).limit(1)
    )).scalar_one_or_none()
    start = datetime.combine(_today(), datetime.min.time(), tzinfo=IST).astimezone(pytz.utc)
    news_today = (await db.execute(
        select(NewsItem.id).where(NewsItem.fetched_at >= start))).scalars().all()

    analyzed = set(analyzed_today)
    missing = sorted([u.symbol for u in active if u.symbol not in analyzed])[:15]
    return {
        "universe_active": len(active), "universe_benched": len(benched),
        "benched": [{"symbol": b.symbol, "reason": b.unbuyable_reason} for b in benched][:10],
        "analyzed_today": len(analyzed), "missing_today": missing,
        "coverage_pct": round(len(analyzed) / len(active) * 100, 1) if active else 0,
        "news_today": len(news_today),
        "last_engine_run": str(last_run) if last_run else None,
        "engine_ran_today": str(last_run) == str(_today()) if last_run else False,
    }


@router.get("/guard-diary")
async def guard_diary(db: AsyncSession = Depends(get_db),
                      user: CurrentUser = Depends(get_current_user)) -> dict:
    """Every snapshotted RED day vs what the Nifty did the NEXT tracked day."""
    rows = (await db.execute(text(
        "SELECT snapshot_date, nifty_close, guard_status, guard_verdict "
        "FROM portfolio_snapshots WHERE user_id = :uid ORDER BY snapshot_date"),
        {"uid": user.id})).all()
    diary, justified, total_red = [], 0, 0
    for i, (d, n, gs, gv) in enumerate(rows):
        if gs != "RED":
            continue
        total_red += 1
        nxt = None
        if n is not None:
            for d2, n2, *_ in rows[i + 1:]:
                if n2 is not None:
                    nxt = round((float(n2) / float(n) - 1) * 100, 2)
                    break
        was_justified = nxt is not None and nxt < -0.3
        if was_justified:
            justified += 1
        diary.append({"date": str(d), "verdict": gv, "next_day_nifty_pct": nxt,
                      "justified": was_justified if nxt is not None else None})
    return {"red_days": diary, "total_red": total_red, "justified": justified,
            "note": "A RED day counts as justified if the Nifty fell >0.3% on the next tracked day. "
                    "Builds up as daily snapshots accumulate — this is the honest forward measurement "
                    "of R12 (historical news doesn't exist, so it can't be backtested)."}


@router.get("/fii-dii")
async def fii_dii() -> dict:
    """Institutional flows from NSE. Best-effort — NSE blocks aggressively."""
    def fetch():
        import requests
        s = requests.Session()
        headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                   "Accept": "application/json", "Referer": "https://www.nseindia.com/"}
        try:
            s.get("https://www.nseindia.com", headers=headers, timeout=8)
            r = s.get("https://www.nseindia.com/api/fiidiiTradeReact", headers=headers, timeout=8)
            if r.status_code == 200:
                return r.json()
        except Exception:
            return None
        return None

    data = await asyncio.to_thread(fetch)
    if not data:
        return {"available": False,
                "note": "NSE flows unavailable right now (their API rate-limits aggressively). Try later."}
    rows = []
    for d in data if isinstance(data, list) else []:
        try:
            rows.append({"category": d.get("category"), "date": d.get("date"),
                         "buy": float(d.get("buyValue", 0)), "sell": float(d.get("sellValue", 0)),
                         "net": float(d.get("netValue", 0))})
        except Exception:
            continue
    return {"available": bool(rows), "rows": rows}
