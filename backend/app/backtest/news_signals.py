"""Turn time-stamped historical headlines into point-in-time NewsSignals.

Alignment rule (look-ahead guard): a headline may first influence session d
only if it was published at or before the cut-off on d (09:00 IST by default,
before the 09:15 open, which mirrors the 08:30 live morning run). It counts
for exactly one session: the first one whose cut-off it precedes. Headlines
on weekends and holidays roll forward to the next session.

The sentiment scorer and the entity linker are inputs, not choices made here.
That is what lets experiment E4 swap a generic model for a domain-adapted one
while everything else stays fixed.
"""
from bisect import bisect_left
from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta

import pytz

from app.backtest.simulator import NewsSignals
from app.sentiment import bad_news

IST = pytz.timezone("Asia/Kolkata")
DEFAULT_CUTOFF = time(9, 0)


@dataclass(frozen=True)
class HistoricalHeadline:
    published_at: datetime          # timezone-aware
    headline: str
    sentiment: str                  # POSITIVE | NEGATIVE | NEUTRAL, from the model under test
    score: float                    # [-1, 1]


def session_for(ts: datetime, sessions: Sequence[date], cutoff: time = DEFAULT_CUTOFF) -> date | None:
    """First session whose IST cut-off is at or after `ts` (None if past the end)."""
    if ts.tzinfo is None:
        raise ValueError("published_at must be timezone-aware")
    local = ts.astimezone(IST)
    target = local.date() if local.time() <= cutoff else local.date() + timedelta(days=1)
    i = bisect_left(sessions, target)
    return sessions[i] if i < len(sessions) else None


def build(headlines: Iterable[HistoricalHeadline],
          sessions: Sequence[date],
          link: Callable[[str], set[str]],
          severe_limit: int = 3,
          label: str = "news",
          cutoff: time = DEFAULT_CUTOFF) -> NewsSignals:
    """Aggregate headlines per session into the simulator's inputs.

    sessions: sorted trading dates (e.g. the Nifty index dates).
    link:     headline -> NSE symbols (EntityLinker.symbols or the baseline).
    """
    sessions = sorted(sessions)
    by_session: dict[date, list[tuple[HistoricalHeadline, bad_news.HeadlineClassification]]] = \
        defaultdict(list)
    for h in headlines:
        d = session_for(h.published_at, sessions, cutoff)
        if d is None:
            continue
        c = bad_news.combine_with_sentiment(
            bad_news.classify_headline(h.headline), h.sentiment, h.score)
        by_session[d].append((h, c))

    out = NewsSignals(label=label)
    for d, items in by_session.items():
        sym_scores: dict[str, list[float]] = defaultdict(list)
        sec_scores: dict[str, list[float]] = defaultdict(list)
        for h, c in items:
            for sym in link(h.headline):
                sym_scores[sym].append(h.score)
            for sec in c.sectors:
                sec_scores[sec].append(h.score)
        out.symbol_sentiment[d] = {s: round(sum(v) / len(v), 3) for s, v in sym_scores.items()}
        out.sector_sentiment[d] = {s: round(sum(v) / len(v), 3) for s, v in sec_scores.items()}
        guard = bad_news.market_guard_from_today([c for _, c in items], severe_limit)
        out.market_stopped[d] = bool(guard["market_stopped"])
        out.blocked_sectors[d] = set(guard["blocked_sectors"])
    return out
