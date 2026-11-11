"""News & sentiment API endpoints."""
from fastapi import APIRouter, Depends
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.database import get_db
from app.db.models import NewsItem
from app.sentiment import finbert
from app.sentiment.pipeline import guard_status, refresh_news, sector_news_scores

router = APIRouter(prefix="/api/news", tags=["news"])


@router.post("/refresh")
async def refresh(db: AsyncSession = Depends(get_db)) -> dict:
    """Fetch all RSS feeds, score new headlines with FinBERT, store them.

    First-ever call downloads the FinBERT model (~440 MB) — takes 2–5 minutes
    once, instant afterwards.
    """
    return await refresh_news(db)


@router.get("/feed")
async def feed(limit: int = 30, only_bad: bool = False,
               db: AsyncSession = Depends(get_db)) -> dict:
    """Latest stored headlines with sentiment + severity tags."""
    q = select(NewsItem).order_by(desc(NewsItem.fetched_at)).limit(min(limit, 100))
    if only_bad:
        q = q.where(NewsItem.is_bad_news.is_(True))
    rows = (await db.execute(q)).scalars().all()
    return {
        "count": len(rows),
        "items": [{
            "headline": r.headline, "source": r.source, "url": r.url,
            "sentiment": r.sentiment, "sentiment_score": float(r.sentiment_score or 0),
            "severity": float(r.severity or 0), "is_bad_news": r.is_bad_news,
            "sectors": r.related_sectors or [],
            "published_at": r.published_at.isoformat() if r.published_at else None,
        } for r in rows],
    }


@router.get("/guard-status")
async def guard(db: AsyncSession = Depends(get_db)) -> dict:
    """R12 verdict: market_stopped, blocked_sectors, overall sentiment."""
    return await guard_status(db)


@router.get("/sector-sentiment")
async def sector_sentiment(db: AsyncSession = Depends(get_db)) -> dict:
    """Average news sentiment per tracked sector (today)."""
    return await sector_news_scores(db)


@router.get("/model-status")
async def model_status() -> dict:
    """Is FinBERT loaded, and on which device?"""
    return finbert.model_status()
