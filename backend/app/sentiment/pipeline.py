"""Sentiment pipeline: RSS → FinBERT → keyword severity → news_items table → R12 guard.

refresh_news()  — the daily ingestion (called by the morning job and on demand)
guard_status()  — R12 inputs computed from today's stored items
sector_news_scores() — average sentiment per tracked sector (feeds sector health)

v2 NOTE: guard_status re-classifies headlines FRESH via bad_news.classify_headline
instead of trusting the severity stored at ingestion time. Classification is
cheap and deterministic, and this makes classifier fixes take effect
immediately over already-stored rows (the old substring matcher had inflated
many stored severities). Stored severity is still written for the news feed
display and self-corrects as new items arrive.
"""
import asyncio
import logging
import time
from datetime import datetime, time as dtime

import pytz
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db.database import AsyncSessionLocal
from app import monitoring
from app.db.models import NewsItem, ShadowPrediction
from app.nlp.service import LINKER_VERSION, get_linker
from app.sentiment import bad_news, finbert
from app.sentiment.scrapers import fetch_all_feeds

logger = logging.getLogger("stocksage.sentiment")
settings = get_settings()


def _today_start_utc() -> datetime:
    ist = pytz.timezone(settings.timezone)
    midnight_ist = datetime.combine(datetime.now(ist).date(), dtime.min, tzinfo=ist)
    return midnight_ist.astimezone(pytz.utc)


_refresh_lock = asyncio.Lock()


async def refresh_news(db: AsyncSession | None = None) -> dict:
    """Fetch feeds, score NEW headlines, classify, persist. Idempotent via url_hash.

    Runs one at a time: the startup poll, the morning job and a manual refresh
    can overlap (the first FinBERT load takes minutes), and overlapping runs
    each scored the same headlines and counted them as new twice."""
    async with _refresh_lock:
        return await _refresh_news(db)


async def _refresh_news(db: AsyncSession | None) -> dict:
    own = db is None
    session = db or AsyncSessionLocal()
    try:
        raw = await asyncio.to_thread(fetch_all_feeds)
        if not raw:
            monitoring.NEWS_POLLS.labels("no_feeds").inc()
            return {"fetched": 0, "new": 0, "note": "All feeds unreachable — using stored news"}

        # Dedup against DB
        hashes = {bad_news.url_hash(r.url, r.headline): r for r in raw}
        existing = set((await session.execute(
            select(NewsItem.url_hash).where(NewsItem.url_hash.in_(list(hashes))))).scalars())
        fresh = {h: r for h, r in hashes.items() if h not in existing}

        if fresh:
            scorer = finbert.champion()
            t0 = time.perf_counter()
            sentiments = await asyncio.to_thread(scorer.score, [r.headline for r in fresh.values()])
            model_version = scorer.version()
            monitoring.observe("champion", model_version, sentiments, time.perf_counter() - t0)
            linker = await get_linker(session)
            for (h, r), s in zip(fresh.items(), sentiments):
                c = bad_news.classify_headline(r.headline)
                c = bad_news.combine_with_sentiment(c, s.sentiment, s.score)
                await session.execute(pg_insert(NewsItem).values(
                    headline=r.headline, url=r.url, source=r.source,
                    sentiment=s.sentiment, sentiment_score=s.score,
                    severity=c.severity, is_bad_news=c.is_bad,
                    related_sectors=c.sectors or None,
                    related_symbols=sorted(linker.symbols(r.headline)) or None,
                    summary=r.summary,
                    sentiment_model=model_version if s.model_used else None,
                    sentiment_confidence=s.confidence if s.model_used else None,
                    linker_version=LINKER_VERSION,
                    published_at=r.published_at, url_hash=h,
                ).on_conflict_do_nothing(index_elements=["url_hash"]))

        if own:
            await session.commit()
        if fresh:
            for r in fresh.values():
                monitoring.HEADLINES_NEW.labels(r.source).inc()
            await _score_shadow(fresh, sentiments, model_version)
        monitoring.HEADLINES_FETCHED.inc(len(raw))
        monitoring.NEWS_POLLS.labels("ok").inc()
        monitoring.LAST_POLL.set_to_current_time()
        shadow = finbert.shadow()
        monitoring.set_serving(finbert.model_version(), shadow.version() if shadow else None)
        model = finbert.model_status()
        scorer = (f"FinBERT on {model['device']}" if model["loaded"]
                  else "keyword fallback" if model["load_failed"] else "nothing to score")
        logger.info("News refresh: %d fetched, %d new (%s)", len(raw), len(fresh), scorer)
        return {"fetched": len(raw), "new": len(fresh), "finbert": model}
    finally:
        if own:
            await session.close()


async def _score_shadow(fresh: dict, champion_results: list, champion_version: str | None) -> None:
    """Score the same new headlines with the shadow model and log them. Runs
    after the champion's rows are stored, in its own session, and swallows
    every error: the shadow can never delay, change or break ingestion."""
    shadow = finbert.shadow()
    if shadow is None:
        return
    try:
        t0 = time.perf_counter()
        results = await asyncio.to_thread(shadow.score, [r.headline for r in fresh.values()])
        version = shadow.version()
        monitoring.observe("shadow", version, results, time.perf_counter() - t0)
        if version is None:
            return                                   # shadow failed to load; counted as fallbacks
        rows = []
        for h, s, c in zip(fresh, results, champion_results):
            if not s.model_used:
                continue
            if c.model_used:
                monitoring.SHADOW_AGREEMENT.labels(str(s.sentiment == c.sentiment).lower()).inc()
            rows.append(dict(url_hash=h, model_version=version, sentiment=s.sentiment,
                             sentiment_score=s.score, confidence=s.confidence,
                             champion_model=champion_version if c.model_used else None,
                             champion_sentiment=c.sentiment if c.model_used else None))
        if rows:
            async with AsyncSessionLocal() as session:
                await session.execute(pg_insert(ShadowPrediction).values(rows)
                                      .on_conflict_do_nothing(index_elements=["url_hash", "model_version"]))
                await session.commit()
    except Exception:
        monitoring.SHADOW_ERRORS.inc()
        logger.exception("Shadow scoring failed (ingestion unaffected)")


async def guard_status(db: AsyncSession | None = None) -> dict:
    """R12 verdict from today's stored headlines (re-classified fresh)."""
    own = db is None
    session = db or AsyncSessionLocal()
    try:
        rows = (await session.execute(
            select(NewsItem.headline, NewsItem.sentiment, NewsItem.sentiment_score)
            .where(NewsItem.fetched_at >= _today_start_utc())
        )).all()

        classifications = []
        for headline, sentiment, score in rows:
            c = bad_news.classify_headline(headline)
            c = bad_news.combine_with_sentiment(c, sentiment or "NEUTRAL", float(score or 0))
            classifications.append(c)

        guard = bad_news.market_guard_from_today(
            classifications, settings.bad_news_headline_limit)

        scores = [float(s or 0) for *_, s in rows if s is not None]
        avg = round(sum(scores) / len(scores), 3) if scores else 0.0
        guard.update({
            "headlines_today": len(rows),
            "avg_sentiment": avg,
            "overall": "NEGATIVE" if avg < -0.15 else "POSITIVE" if avg > 0.15 else "NEUTRAL",
            "rule": "R12",
            "verdict": (
                f"Systemic news event — ALL buying paused (R12). "
                f"{guard['systemic_count']} market-wide severe headlines."
                if guard["market_stopped"]
                else f"Sectors paused by news: {', '.join(guard['blocked_sectors'])}."
                if guard["blocked_sectors"]
                else "No news-based blocks today."
            ),
        })
        return guard
    finally:
        if own:
            await session.close()


async def sector_news_scores(db: AsyncSession | None = None) -> dict[str, float]:
    """Average sentiment per tracked sector over today's tagged headlines."""
    own = db is None
    session = db or AsyncSessionLocal()
    try:
        rows = (await session.execute(
            select(func.unnest(NewsItem.related_sectors).label("sector"),
                   func.avg(NewsItem.sentiment_score))
            .where(NewsItem.fetched_at >= _today_start_utc())
            .where(NewsItem.related_sectors.isnot(None))
            .group_by("sector")
        )).all()
        return {sector: round(float(avg or 0), 3) for sector, avg in rows}
    finally:
        if own:
            await session.close()
