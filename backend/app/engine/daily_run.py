"""The daily engine run — StockSage's heartbeat.

Pipeline (one run, ~1–4 min depending on cache warmth):
 1. Refresh news → R12 guard status
 2. Nifty status → R11 guard
 3. Batch-download 1y history for the whole active universe (one threaded call)
 4. Technicals for every symbol (partial-bar aware)
 5. Sector health → weak sectors (R10)
 6. Fundamentals — ONLY for top-12-by-technicals per equity segment + all
    holdings (full-universe Yahoo fundamentals would take ~5 min and add
    nothing: low-technical names can't reach the buy threshold anyway)
 7. Per-symbol news sentiment (company-name matching + sector fallback)
 8. Composite scores → upsert stock_analysis
 9. Portfolio state: prices, peaks (R15), low-score streaks (R14), capital
10. plan_sells → R13/R15/R14 alerts;  plan_buys → rule-gated suggestions
11. Persist suggestions_log, assemble the Daily Brief
"""
import asyncio
import logging
from datetime import date, datetime

import pytz
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.config import get_settings
from app.db.database import AsyncSessionLocal
from app.db.models import (
    Holding, NewsItem, Portfolio, SectorHealth, StockAnalysis, SuggestionLog, Transaction,
)
from app.engine import scoring
from app.engine.planner import plan_buys, plan_sells
from app.engine.sector_health import compute_sector_health
from app.market_data import fetcher
from app.market_data.fundamentals import score_fundamentals
from app.market_data.indicators import compute_all
from app.nlp.service import get_linker
from app.rules.base import BuyCandidate, MarketState, PortfolioState
from app.sentiment.pipeline import guard_status, refresh_news, sector_news_scores

logger = logging.getLogger("stocksage.engine")
settings = get_settings()

# Per-user brief cache: {user_id (or 0 for legacy): brief}
_last_brief: dict[int, dict] = {}
FUNDAMENTALS_TOP_N = 12


def _today() -> date:
    return datetime.now(pytz.timezone(settings.timezone)).date()


async def run_daily_engine(run_type: str = "MANUAL", user_id: int | None = None) -> dict:
    """Execute the full pipeline for ONE user's portfolio and return their Daily Brief.

    Market intelligence (news, technicals, sector health, stock_analysis) is
    shared and idempotent; capital, holdings, buy sizing and suggestions are
    computed against the given user's portfolio and live settings.
    """
    t0 = datetime.now()
    from app.settings_router import get_live_settings
    live_cfg = await get_live_settings(user_id)
    async with AsyncSessionLocal() as db:
        # ── 1–2. Guards ─────────────────────────────────────────────────
        news_summary = await refresh_news(db)
        guard = await guard_status(db)
        nifty = await asyncio.to_thread(fetcher.get_nifty_status)
        market = MarketState(
            nifty_fell=nifty["nifty_fell"],
            nifty_change_pct=nifty["change_pct"],
            guard_basis=nifty["guard_basis"],
            market_stopped=guard["market_stopped"],
            bad_headline_count=guard["severe_count"],
            blocked_sectors=set(guard["blocked_sectors"]),
        )

        # ── 3–4. Universe data + technicals ────────────────────────────
        from app.db.models import StockUniverse
        uni = (await db.execute(select(StockUniverse).where(StockUniverse.is_active.is_(True)))).scalars().all()
        symbols = [u.symbol for u in uni]
        info = {u.symbol: u for u in uni}

        hist = await asyncio.to_thread(fetcher.batch_history, symbols, "1y")
        live = fetcher.is_market_open_ist()
        tech, day_change = {}, {}
        for sym, df in hist.items():
            if df is None or len(df) < 60:
                continue
            tech[sym] = compute_all(df, last_bar_partial=live)
            day_change[sym] = round(float(df["Close"].iloc[-1] / df["Close"].iloc[-2] - 1) * 100, 3)
        logger.info("Technicals computed for %d/%d symbols", len(tech), len(symbols))

        # ── 5. Sector health (R10) ──────────────────────────────────────
        snews = await sector_news_scores(db)
        equity_sectors = {s: info[s].sector for s in tech
                          if info[s].segment in ("NIFTY50", "NEXT100", "SMALLCAP")}
        health = compute_sector_health(
            equity_sectors, day_change, {s: t.rsi_14 for s, t in tech.items()},
            snews, settings.tracked_sectors)
        market.weak_sectors = {h.sector for h in health if h.status == "WEAK"}
        for h in health:
            await db.execute(pg_insert(SectorHealth).values(
                sector=h.sector, health_date=_today(), score=h.score, status=h.status,
                change_pct=h.change_pct, avg_rsi=h.avg_rsi, news_score=h.news_score,
                top_gainer=h.top_gainer, is_blocked=h.sector in market.blocked_sectors,
                block_reason="Severe sector news (R12)" if h.sector in market.blocked_sectors else None,
            ).on_conflict_do_update(
                index_elements=["sector", "health_date"],
                set_={"score": h.score, "status": h.status, "change_pct": h.change_pct,
                      "avg_rsi": h.avg_rsi, "news_score": h.news_score,
                      "top_gainer": h.top_gainer,
                      "is_blocked": h.sector in market.blocked_sectors}))

        # ── 6. Targeted fundamentals (user's holdings only) ───────────
        pf_q = select(Portfolio)
        if user_id is not None:
            pf_q = pf_q.where(Portfolio.user_id == user_id)
        pf = (await db.execute(pf_q.limit(1))).scalar_one_or_none()
        if pf is None:
            raise RuntimeError("No portfolio found for this user")
        holdings = (await db.execute(select(Holding)
                                     .where(Holding.portfolio_id == pf.id))).scalars().all()
        held = {h.symbol for h in holdings}
        fund_targets = set(held)
        for seg in ("NIFTY50", "NEXT100", "SMALLCAP"):
            ranked = sorted((s for s in tech if info[s].segment == seg),
                            key=lambda s: tech[s].technical_score, reverse=True)
            fund_targets.update(ranked[:FUNDAMENTALS_TOP_N])
        funds = {}
        for sym in fund_targets:
            funds[sym] = await asyncio.to_thread(
                score_fundamentals, sym, info[sym].segment in ("GOLD_ETF", "SILVER_ETF"))
        logger.info("Fundamentals fetched for %d targeted symbols", len(funds))

        # ── 7. Per-symbol news sentiment ───────────────────────────────
        rows = (await db.execute(select(NewsItem.headline, NewsItem.sentiment_score)
                                 .where(func.date(NewsItem.fetched_at) >= _today()))).all()
        linker = await get_linker(db)
        by_symbol: dict[str, list[float]] = {}
        for h, s in rows:
            for sym in linker.symbols(h):
                by_symbol.setdefault(sym, []).append(float(s or 0))
        sym_sent: dict[str, float] = {}
        for sym in tech:
            matches = by_symbol.get(sym)
            if matches:
                sym_sent[sym] = sum(matches) / len(matches)
            else:
                sym_sent[sym] = snews.get(info[sym].sector, 0.0)

        # ── 8. Composite scores → stock_analysis ──────────────────────
        composites: dict[str, float] = {}
        for sym, t in tech.items():
            f = funds.get(sym)
            f_score = f.fundamental_score if f else 0.5
            s_unit = scoring.sentiment_to_unit(sym_sent.get(sym, 0.0))
            comp = scoring.composite(t.technical_score, f_score, s_unit)
            composites[sym] = comp
            price = float(hist[sym]["Close"].iloc[-1])
            await db.execute(pg_insert(StockAnalysis).values(
                symbol=sym, analysis_date=_today(), current_price=price,
                rsi_14=t.rsi_14, macd_hist=t.macd_hist, macd_signal=t.macd_signal,
                ema_20=t.ema_20, ema_50=t.ema_50, ema_cross=t.ema_cross,
                bb_percent_b=t.bb_percent_b, adx=t.adx, stoch_k=t.stoch_k,
                volume_ratio=t.volume_ratio, momentum_20d=t.momentum_20d,
                dist_52w_high=t.dist_52w_high,
                pe_ratio=f.pe_ratio if f else None, pb_ratio=f.pb_ratio if f else None,
                roe=f.roe if f else None, debt_to_equity=f.debt_to_equity if f else None,
                revenue_growth=f.revenue_growth if f else None,
                profit_margin=f.profit_margin if f else None,
                dividend_yield=f.dividend_yield if f else None,
                news_sentiment=round(sym_sent.get(sym, 0.0), 3),
                sector_sentiment=round(snews.get(info[sym].sector, 0.0), 3),
                technical_score=t.technical_score, fundamental_score=f_score,
                sentiment_score=s_unit, composite_score=comp,
                recommendation=scoring.recommendation(comp),
                confidence=scoring.confidence(comp),
                top_reasons={"technical": t.reasons[:4],
                             "fundamental": (f.reasons[:3] if f else [])},
            ).on_conflict_do_update(
                index_elements=["symbol", "analysis_date"],
                set_={"composite_score": comp, "current_price": price,
                      "technical_score": t.technical_score, "fundamental_score": f_score,
                      "sentiment_score": s_unit,
                      "recommendation": scoring.recommendation(comp),
                      "confidence": scoring.confidence(comp)}))

        # ── 9. Portfolio state ─────────────────────────────────────────
        bucket_dep, sector_dep, mkt_value = {}, {}, 0.0
        for h in holdings:
            sym = h.symbol
            price = float(hist[sym]["Close"].iloc[-1]) if sym in hist else float(h.current_price or h.avg_buy_price)
            h.current_price = price
            h.peak_price = max(float(h.peak_price or 0), price)
            comp = composites.get(sym)
            if comp is not None:
                h.low_score_streak = h.low_score_streak + 1 if comp < live_cfg.deterioration_score else 0
            cost = float(h.avg_buy_price) * h.quantity
            mkt_value += price * h.quantity
            bucket_dep[h.segment] = bucket_dep.get(h.segment, 0.0) + cost
            if h.segment in ("NIFTY50", "NEXT100", "SMALLCAP"):
                sector_dep[h.sector] = sector_dep.get(h.sector, 0.0) + cost
        pf.total_capital = round(float(pf.cash_balance) + mkt_value, 2)

        invested_today = float((await db.execute(
            select(func.coalesce(func.sum(Transaction.total_value), 0))
            .where(Transaction.action == "BUY")
            .where(Transaction.portfolio_id == pf.id)
            .where(func.date(Transaction.executed_at) == _today()))).scalar())

        pstate = PortfolioState(
            total_capital=float(pf.total_capital), cash_balance=float(pf.cash_balance),
            invested_today=invested_today, bucket_deployed=bucket_dep,
            sector_deployed=sector_dep, held_symbols=held)

        # ── 10. Plan ───────────────────────────────────────────────────
        sells, holds = plan_sells([{
            "symbol": h.symbol, "avg_buy_price": h.avg_buy_price,
            "current_price": h.current_price, "peak_price": h.peak_price,
            "low_score_streak": h.low_score_streak} for h in holdings], live_cfg)

        candidates = [BuyCandidate(
            symbol=sym, segment=info[sym].segment, sector=info[sym].sector or "Services",
            price=float(hist[sym]["Close"].iloc[-1]), composite_score=composites[sym],
            is_etf=info[sym].segment in ("GOLD_ETF", "SILVER_ETF"),
        ) for sym in composites]
        buys, skips, _ = plan_buys(candidates, pstate, market, live_cfg)

        # ── 11. Persist + brief ────────────────────────────────────────
        def _suggestion_row(ev, action):
            c = ev.candidate
            return dict(suggestion_date=_today(), run_type=run_type, portfolio_id=pf.id,
                        symbol=c.symbol, action=action, segment=c.segment, sector=c.sector,
                        suggested_quantity=ev.quantity or None,
                        suggested_price=c.price, total_value=ev.total_cost or None,
                        composite_score=c.composite_score,
                        confidence=scoring.confidence(c.composite_score),
                        rules_passed=ev.rules_passed, rules_failed=ev.rules_failed,
                        reasoning={"rules": [r.reason for r in ev.results]})

        for ev in buys:
            await db.execute(pg_insert(SuggestionLog).values(**_suggestion_row(ev, "BUY")))
        for ev in skips[:10]:
            await db.execute(pg_insert(SuggestionLog).values(**_suggestion_row(ev, "SKIP")))
        for sev in sells:
            await db.execute(pg_insert(SuggestionLog).values(
                suggestion_date=_today(), run_type=run_type, portfolio_id=pf.id,
                symbol=sev.symbol, action="SELL",
                reasoning={"rules": [sev.reason], "urgency": sev.urgency},
                rules_failed=[{"rule_id": sev.triggered_rule}]))
        await db.commit()

        go = "RED" if (market.nifty_fell or market.market_stopped) else \
             "AMBER" if (market.blocked_sectors or market.weak_sectors) else "GREEN"
        daily_cap = float(pf.total_capital) * live_cfg.max_daily_invest_pct
        brief = {
            "date": str(_today()), "run_type": run_type,
            "generated_at": datetime.now(pytz.timezone(settings.timezone)).isoformat(),
            "duration_seconds": round((datetime.now() - t0).total_seconds(), 1),
            "market_guard": {
                "go_status": go,
                "nifty_fell": market.nifty_fell,
                "nifty_change_pct": market.nifty_change_pct,
                "guard_basis": market.guard_basis,
                "bad_news_detected": market.market_stopped,
                "blocked_sectors": sorted(market.blocked_sectors),
                "weak_sectors": sorted(market.weak_sectors),
                "go_message": (
                    "Nifty fell — NO buying today (R11). Capital preserved." if market.nifty_fell
                    else "Severe news flow — ALL buying paused (R12)." if market.market_stopped
                    else f"Proceed with caution — avoid: {', '.join(sorted(market.weak_sectors | market.blocked_sectors))}."
                    if (market.weak_sectors or market.blocked_sectors)
                    else "Market is healthy. Conditions are good to invest today."),
            },
            "capital_status": {
                "total": float(pf.total_capital), "cash": float(pf.cash_balance),
                "invested_today": invested_today,
                "available_today": round(max(0.0, daily_cap - invested_today), 2),
                "by_bucket": {
                    seg: {"target": round(float(pf.total_capital) * pct, 2),
                          "deployed": round(bucket_dep.get(seg, 0.0), 2)}
                    for seg, pct in (("NIFTY50", live_cfg.nifty50_pct),
                                     ("NEXT100", live_cfg.nifty_next100_pct),
                                     ("SMALLCAP", live_cfg.smallcap_pct),
                                     ("GOLD_ETF", live_cfg.gold_silver_pct / 2),
                                     ("SILVER_ETF", live_cfg.gold_silver_pct / 2))},
            },
            "sector_health": [vars(h) for h in health],
            "buy_suggestions": [{
                "symbol": ev.candidate.symbol,
                "name": info[ev.candidate.symbol].company_name,
                "segment": ev.candidate.segment, "sector": ev.candidate.sector,
                "price": ev.candidate.price, "quantity": ev.quantity,
                "total_value": ev.total_cost,
                "composite_score": ev.candidate.composite_score,
                "confidence": scoring.confidence(ev.candidate.composite_score),
                "scores": {"technical": tech[ev.candidate.symbol].technical_score,
                           "fundamental": funds[ev.candidate.symbol].fundamental_score
                           if ev.candidate.symbol in funds else 0.5,
                           "sentiment": scoring.sentiment_to_unit(sym_sent.get(ev.candidate.symbol, 0))},
                "reasons": (tech[ev.candidate.symbol].reasons[:3]
                            + (funds[ev.candidate.symbol].reasons[:2] if ev.candidate.symbol in funds else [])),
                "rules_passed": [r["rule_id"] for r in ev.rules_passed],
            } for ev in buys],
            "sell_alerts": [{"symbol": s.symbol, "rule": s.triggered_rule,
                             "urgency": s.urgency, "reason": s.reason} for s in sells],
            "hold": [{"symbol": h.symbol, "note": h.reason} for h in holds],
            "skipped": [{
                "symbol": ev.candidate.symbol, "score": ev.candidate.composite_score,
                "killed_by": ev.results[-1].rule_id, "reason": ev.results[-1].reason,
            } for ev in skips[:10]],
            "news": {"overall": guard["overall"], "avg_sentiment": guard["avg_sentiment"],
                     "headlines_today": guard["headlines_today"],
                     "finbert": news_summary.get("finbert", {})},
        }
        _last_brief[user_id or 0] = brief
        logger.info("Engine run complete in %.1fs for user %s — %d buys, %d sells, %d skips, status %s",
                    brief["duration_seconds"], user_id, len(buys), len(sells), len(skips), go)
        return brief


def get_cached_brief(user_id: int | None = None) -> dict | None:
    """Today's brief for this user, if already computed this process."""
    b = _last_brief.get(user_id or 0)
    if b and b["date"] == str(_today()):
        return b
    return None
