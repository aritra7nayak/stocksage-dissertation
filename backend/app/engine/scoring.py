"""Composite scoring — the transparent replacement for the opaque ML model.

composite = 0.40·technical + 0.35·fundamental + 0.25·sentiment   (all 0–1)

Thresholds:
    >= 0.60  BUY consideration (rules still gate it)
    <= 0.35  weak — feeds R14 deterioration streaks on holdings
    else     HOLD territory
"""
from app.config import get_settings

settings = get_settings()


def sentiment_to_unit(score: float) -> float:
    """Map FinBERT-style sentiment [−1, 1] → [0, 1]."""
    return round(max(0.0, min(1.0, (score + 1) / 2)), 3)


def composite(technical: float, fundamental: float, sentiment_unit: float) -> float:
    """Weighted composite, 0–1. Weights from config (sum to 1.0)."""
    return round(
        settings.weight_technical * technical
        + settings.weight_fundamental * fundamental
        + settings.weight_sentiment * sentiment_unit, 3)


def recommendation(score: float) -> str:
    """BUY-zone / HOLD / weak label from the composite score alone."""
    if score >= 0.60:
        return "BUY"
    if score <= 0.35:
        return "SELL"
    return "HOLD"


def confidence(score: float) -> str:
    """How far from coin-flip (0.5) the composite sits."""
    d = abs(score - 0.5)
    if d >= 0.20:
        return "HIGH"
    if d >= 0.10:
        return "MEDIUM"
    return "LOW"
