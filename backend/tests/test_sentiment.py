"""Bad-news classifier tests — pure logic, runs without FinBERT or network.

Run:  python tests/test_sentiment.py   (from backend, venv active)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.sentiment.bad_news import (
    classify_headline, combine_with_sentiment, market_guard_from_today, url_hash,
)


def test_severe_sebi_headline():
    c = classify_headline("SEBI bars promoter group from securities market over fraud")
    assert c.is_severe and c.severity >= 8
    assert "sebi bars" in c.matched_keywords


def test_macro_rate_hike_moderate():
    c = classify_headline("RBI hikes repo rate by 50 bps in surprise move")
    assert c.is_bad and not c.severity >= 8
    assert "Banking & Finance" in c.sectors


def test_routine_negative_not_severe():
    c = classify_headline("Infosys Q4 profit falls 3% as margin pressure persists")
    assert c.is_bad and not c.is_severe
    assert "IT" in c.sectors


def test_positive_headline_clean():
    c = classify_headline("Nifty hits record high as banks rally on strong credit growth")
    assert not c.is_bad and c.severity < 4


def test_sector_tagging_multi():
    c = classify_headline("Crude surges past $95; oil marketing companies and aviation stocks slip")
    assert "Oil & Gas" in c.sectors and "Services" in c.sectors


def test_finbert_lifts_borderline_to_bad():
    c = classify_headline("Company announces unexpected leadership exit amid uncertainty")
    assert not c.is_bad
    c = combine_with_sentiment(c, "NEGATIVE", -0.85)
    assert c.is_bad, "Strong FinBERT negative must lift borderline headlines to bad"


def test_finbert_positive_never_downgrades_severe():
    c = classify_headline("SEBI bans brokerage in fraud case")
    before = c.severity
    c = combine_with_sentiment(c, "POSITIVE", 0.9)
    assert c.severity == before and c.is_severe, "Positive sentiment must not erase keyword severity"


def test_market_stopper_threshold():
    # v2: only SYSTEMIC severe headlines count toward the market halt.
    systemic = [classify_headline(h) for h in (
        "War fears grip markets as missile strikes reported",
        "Sensex crashes over 1,200 points in bloodbath",
        "Pandemic lockdown fears return as new variant spreads",
        "Rupee crashes to record low against the dollar",
    )]
    company = [classify_headline(h) for h in (
        "Major NBFC defaults on bond repayments",
        "SEBI bars top fund house over money laundering probe",
    )]
    calm = [classify_headline("IT stocks gain on strong deal pipeline")]
    assert all(c.is_systemic for c in systemic)
    assert not any(c.is_systemic for c in company)

    g = market_guard_from_today(systemic + calm, severe_limit=3)
    assert g["market_stopped"] and g["systemic_count"] == 4

    g2 = market_guard_from_today(systemic[:3] + calm, severe_limit=3)
    assert not g2["market_stopped"], "Exactly at limit must NOT stop (limit is 'more than')"

    g3 = market_guard_from_today(systemic[:3] + company + calm, severe_limit=3)
    assert not g3["market_stopped"], "Company-level severe news must never halt the market"
    assert g3["severe_count"] == 5


def test_sector_block_needs_two_severe():
    one = [classify_headline("RBI restricts major private bank from new credit cards")]
    g = market_guard_from_today(one, severe_limit=3)
    assert g["blocked_sectors"] == []
    two = one + [classify_headline("Another lender faces RBI penalty over npa fraud disclosures")]
    g2 = market_guard_from_today(two, severe_limit=3)
    assert "Banking & Finance" in g2["blocked_sectors"]


def test_url_hash_dedup_stable():
    a = url_hash("https://x.com/1", "Same headline")
    b = url_hash("https://x.com/1", "Same headline")
    c = url_hash("https://x.com/2", "Same headline")
    assert a == b != c and len(a) == 64


def test_feed_time_is_read_as_utc():
    # feedparser's *_parsed tuples are UTC; reading them as local time shifted
    # stored timestamps by the machine's UTC offset (5h30m on an IST machine).
    import time as _time
    from types import SimpleNamespace
    from app.sentiment.scrapers import _parse_time
    entry = SimpleNamespace(published_parsed=_time.strptime("2026-01-05 03:00:00", "%Y-%m-%d %H:%M:%S"))
    assert _parse_time(entry).isoformat() == "2026-01-05T03:00:00+00:00"


def test_feed_summary_cleaned():
    from types import SimpleNamespace
    from app.sentiment.scrapers import _clean_summary
    e = SimpleNamespace(summary="<p>Infosys &amp; TCS   rally</p>")
    assert _clean_summary(e, "Headline") == "Infosys & TCS rally"
    assert _clean_summary(SimpleNamespace(summary="Headline"), "Headline") is None


def test_stale_feed_items_dropped():
    # A dead feed keeps answering 200 with its last items (Moneycontrol served
    # 2016 headlines); those must not enter the corpus with old dates.
    from datetime import datetime, timedelta, timezone
    from types import SimpleNamespace
    from unittest import mock
    from app.sentiment import scrapers

    def rss(*dates):
        items = "".join(f"<item><title>Headline number {i} about the market today</title>"
                        f"<link>http://x/{i}</link><pubDate>{d:%a, %d %b %Y %H:%M:%S} +0000</pubDate></item>"
                        for i, d in enumerate(dates))
        return f"<rss><channel>{items}</channel></rss>".encode()

    now = datetime.now(timezone.utc)
    resp = SimpleNamespace(content=rss(now - timedelta(hours=2), now - timedelta(days=30),
                                       datetime(2016, 10, 5, tzinfo=timezone.utc)),
                           raise_for_status=lambda: None)
    with mock.patch.object(scrapers, "FEEDS", {"Feed": "http://x"}), \
         mock.patch.object(scrapers.httpx, "get", return_value=resp):
        items = scrapers.fetch_all_feeds()
    assert [i.url for i in items] == ["http://x/0"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n✅ All {len(fns)} sentiment tests passed.")
