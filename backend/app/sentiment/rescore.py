"""Re-score stored headlines that have no model version (sentiment_model IS NULL).

Those rows got the neutral fallback because FinBERT was unavailable when they
were ingested, or they predate model versioning. refresh_news never touches a
stored row again, so without this they would stay neutral.

    cd backend
    python -m app.sentiment.rescore --since 2026-11-01   # only rows fetched since then
    python -m app.sentiment.rescore --all                # every unversioned row

Re-runs the same steps as ingestion (FinBERT, then keyword severity combined
with sentiment) and writes sentiment, severity, is_bad_news and sentiment_model.
"""
import argparse
import asyncio
import logging
from datetime import date, datetime, time, timezone

from sqlalchemy import select, update

from app.db.database import AsyncSessionLocal
from app.db.models import NewsItem
from app.sentiment import bad_news, finbert

logger = logging.getLogger("stocksage.rescore")


async def rescore(since: date | None) -> int:
    async with AsyncSessionLocal() as db:
        q = select(NewsItem.id, NewsItem.headline).where(NewsItem.sentiment_model.is_(None))
        if since:
            q = q.where(NewsItem.fetched_at >= datetime.combine(since, time.min, timezone.utc))
        rows = (await db.execute(q)).all()
        if not rows:
            return 0
        scores = await asyncio.to_thread(finbert.score_headlines, [h for _, h in rows])
        version = finbert.model_version()
        if version is None:
            raise SystemExit("FinBERT did not load; nothing was changed")
        n = 0
        for (row_id, headline), s in zip(rows, scores):
            if not s.model_used:
                continue
            c = bad_news.combine_with_sentiment(bad_news.classify_headline(headline),
                                                s.sentiment, s.score)
            await db.execute(update(NewsItem).where(NewsItem.id == row_id).values(
                sentiment=s.sentiment, sentiment_score=s.score, severity=c.severity,
                is_bad_news=c.is_bad, sentiment_model=version,
                sentiment_confidence=s.confidence))
            n += 1
        await db.commit()
        return n


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--since", type=date.fromisoformat)
    g.add_argument("--all", action="store_true")
    a = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        n = asyncio.run(rescore(None if a.all else a.since))
    except OSError as e:                      # ConnectionRefusedError and friends
        raise SystemExit(f"Cannot reach the database ({e}). Start it first: run start.bat, "
                         "or `docker compose up -d postgres`.") from None
    print(f"re-scored {n} headlines")


if __name__ == "__main__":
    main()
