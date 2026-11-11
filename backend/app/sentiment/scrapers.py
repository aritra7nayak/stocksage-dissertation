"""RSS scrapers for Indian financial news. No API keys needed.

Each feed is independent — one source going down never breaks the run.
feedparser handles malformed XML gracefully; we additionally cap per-feed
items and normalize timestamps.
"""
import calendar
import html
import logging
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import feedparser
import httpx

from app.monitoring import FEED_ERRORS, FEED_STALE

logger = logging.getLogger("stocksage.scrapers")

# Moneycontrol's RSS feeds were dropped in Nov 2026: they still answer 200 but
# serve frozen items from 2016 and 2024.
FEEDS: dict[str, str] = {
    "Economic Times Markets": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
    "Economic Times Industry": "https://economictimes.indiatimes.com/industry/rssfeeds/13352306.cms",
    "Livemint Markets": "https://www.livemint.com/rss/markets",
    "Livemint Companies": "https://www.livemint.com/rss/companies",
    "Business Standard Markets": "https://www.business-standard.com/rss/markets-106.rss",
    "Business Standard Companies": "https://www.business-standard.com/rss/companies-101.rss",
    "BusinessLine Markets": "https://www.thehindubusinessline.com/markets/feeder/default.rss",
    "BusinessLine Companies": "https://www.thehindubusinessline.com/companies/feeder/default.rss",
}

MAX_PER_FEED = 100
# Items published longer ago than this are dropped: a feed that stops updating
# keeps serving its last items, which would enter the corpus with old dates.
MAX_ITEM_AGE = timedelta(days=3)
FEED_TIMEOUT_S = 15.0          # one hanging feed must not stall the engine run
MAX_SUMMARY_CHARS = 1000
_TAG = re.compile(r"<[^>]+>")
_UA = {"User-Agent": "Mozilla/5.0 (StockSage India news reader)"}


@dataclass
class RawNewsItem:
    headline: str
    url: str
    source: str
    published_at: datetime | None
    summary: str | None = None


def _parse_time(entry) -> datetime | None:
    # feedparser normalises *_parsed to UTC; calendar.timegm reads it as UTC.
    # (time.mktime would read it as local time and shift IST rows by 5h30m.)
    for attr in ("published_parsed", "updated_parsed"):
        t = getattr(entry, attr, None)
        if t:
            try:
                return datetime.fromtimestamp(calendar.timegm(t), tz=timezone.utc)
            except (OverflowError, ValueError):
                continue
    return None


def _clean_summary(entry, headline: str) -> str | None:
    raw = getattr(entry, "summary", "") or getattr(entry, "description", "") or ""
    text = " ".join(html.unescape(_TAG.sub(" ", raw)).split())
    if not text or text.lower() == headline.lower():
        return None
    return text[:MAX_SUMMARY_CHARS]


def fetch_all_feeds() -> list[RawNewsItem]:
    """Pull every configured feed. Per-feed failures are logged and skipped."""
    items: list[RawNewsItem] = []
    cutoff = datetime.now(timezone.utc) - MAX_ITEM_AGE
    for source, url in FEEDS.items():
        try:
            resp = httpx.get(url, timeout=FEED_TIMEOUT_S, headers=_UA, follow_redirects=True)
            resp.raise_for_status()
            parsed = feedparser.parse(resp.content)
            count = stale = 0
            for entry in parsed.entries[:MAX_PER_FEED]:
                title = html.unescape((getattr(entry, "title", "") or "").strip())
                link = (getattr(entry, "link", "") or "").strip()
                if len(title) < 15:
                    continue
                published = _parse_time(entry)
                if published is not None and published < cutoff:
                    stale += 1
                    continue
                items.append(RawNewsItem(title, link, source, published,
                                         _clean_summary(entry, title)))
                count += 1
            if stale:
                FEED_STALE.labels(source).inc(stale)
            if stale and not count:
                logger.warning("%s: all %d items are older than %s, feed looks dead",
                               source, stale, MAX_ITEM_AGE)
            else:
                logger.info("%s: %d items%s", source, count,
                            f" ({stale} stale dropped)" if stale else "")
        except Exception as exc:
            FEED_ERRORS.labels(source).inc()
            logger.warning("%s failed (%s) — skipped", source, exc)
    return items
