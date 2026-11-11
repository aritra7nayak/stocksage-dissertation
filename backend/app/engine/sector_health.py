"""Sector health (R10 input) — score 0–100 per tracked sector.

    score = 40·price_component + 30·rsi_component + 30·news_component

price_component : avg day-change of the sector's stocks, −2%→0 … +2%→1
rsi_component   : avg RSI mapped (20→0 … 80→1) — persistent weakness shows here
news_component  : today's sector news sentiment, −1→0 … +1→1

WEAK   < 40  → R10 blocks new buys in this sector
STRONG > 60
"""
from dataclasses import dataclass


def _clamp(x: float) -> float:
    return max(0.0, min(1.0, x))


@dataclass
class SectorHealthRow:
    sector: str
    score: float
    status: str
    change_pct: float
    avg_rsi: float
    news_score: float
    top_gainer: str | None


def compute_sector_health(
    stock_sectors: dict[str, str],          # symbol → sector (equities only)
    day_change: dict[str, float],           # symbol → today's % change
    rsi: dict[str, float],                  # symbol → RSI14
    sector_news: dict[str, float],          # sector → avg sentiment [−1, 1]
    tracked_sectors: tuple,
) -> list[SectorHealthRow]:
    """Aggregate per-stock data into per-sector health rows."""
    rows: list[SectorHealthRow] = []
    for sector in tracked_sectors:
        symbols = [s for s, sec in stock_sectors.items() if sec == sector and s in day_change]
        if not symbols:
            rows.append(SectorHealthRow(sector, 50.0, "NEUTRAL", 0.0, 50.0,
                                        sector_news.get(sector, 0.0), None))
            continue

        changes = [day_change[s] for s in symbols]
        rsis = [rsi.get(s, 50.0) for s in symbols]
        avg_chg = sum(changes) / len(changes)
        avg_rsi = sum(rsis) / len(rsis)
        news = sector_news.get(sector, 0.0)

        price_c = _clamp((avg_chg + 2.0) / 4.0)
        rsi_c = _clamp((avg_rsi - 20.0) / 60.0)
        news_c = _clamp((news + 1.0) / 2.0)
        score = round(100 * (0.40 * price_c + 0.30 * rsi_c + 0.30 * news_c), 1)

        status = "WEAK" if score < 40 else "STRONG" if score > 60 else "NEUTRAL"
        top = max(symbols, key=lambda s: day_change[s])
        rows.append(SectorHealthRow(sector, score, status, round(avg_chg, 3),
                                    round(avg_rsi, 1), round(news, 3), top))
    return rows
