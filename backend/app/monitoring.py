"""Prometheus metrics for the news pipeline and the served models.

GET /metrics (text exposition format) is scraped by the Prometheus service in
docker-compose (profile "monitoring"); Grafana reads Prometheus. Optional
bearer token: METRICS_TOKEN.

Model-quality signals that need labels (macro-F1) are measured offline by the
promotion gate; what can be watched live is the prediction distribution,
confidence, the shadow's agreement with the champion and the pipeline's
health. research/drift.py turns the stored predictions into drift reports.
"""
import hmac

from fastapi import APIRouter, Header, HTTPException, Response
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest

from app.config import get_settings

settings = get_settings()

NEWS_POLLS = Counter("stocksage_news_polls_total", "News refresh runs", ["outcome"])
HEADLINES_FETCHED = Counter("stocksage_headlines_fetched_total", "Feed items fetched")
HEADLINES_NEW = Counter("stocksage_headlines_new_total", "New headlines stored", ["source"])
LAST_POLL = Gauge("stocksage_last_news_poll_timestamp_seconds", "Unix time of the last successful poll")
FEED_ERRORS = Counter("stocksage_feed_errors_total", "Feed fetch or parse failures", ["feed"])
FEED_STALE = Counter("stocksage_feed_stale_items_total", "Feed items dropped as too old", ["feed"])

PREDICTIONS = Counter("stocksage_sentiment_predictions_total", "Sentiment predictions",
                      ["role", "model", "label"])
CONFIDENCE = Histogram("stocksage_sentiment_confidence", "Top-class probability", ["role"],
                       buckets=(0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99, 1.0))
SCORE = Histogram("stocksage_sentiment_score", "P(positive) - P(negative)", ["role"],
                  buckets=(-0.9, -0.6, -0.3, -0.1, 0.1, 0.3, 0.6, 0.9, 1.0))
SCORING_SECONDS = Histogram("stocksage_scoring_seconds", "Time to score one batch of new headlines",
                            ["role"], buckets=(0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60))
FALLBACKS = Counter("stocksage_scorer_fallback_total",
                    "Headlines that got the neutral fallback (model not loaded or failed)", ["role"])
SHADOW_AGREEMENT = Counter("stocksage_shadow_agreement_total",
                           "Champion vs shadow label agreement per headline", ["agree"])
SHADOW_ERRORS = Counter("stocksage_shadow_errors_total", "Shadow scoring or logging failures")
SERVING = Gauge("stocksage_model_info", "Currently served models (value 1)", ["role", "version"])


def observe(role: str, version: str | None, results, seconds: float) -> None:
    SCORING_SECONDS.labels(role).observe(seconds)
    for r in results:
        if not r.model_used:
            FALLBACKS.labels(role).inc()
            continue
        PREDICTIONS.labels(role, version or "unknown", r.sentiment).inc()
        CONFIDENCE.labels(role).observe(r.confidence)
        SCORE.labels(role).observe(r.score)


def set_serving(champion: str | None, shadow: str | None) -> None:
    SERVING.clear()
    if champion:
        SERVING.labels("champion", champion).set(1)
    if shadow:
        SERVING.labels("shadow", shadow).set(1)


router = APIRouter(tags=["monitoring"])


@router.get("/metrics", include_in_schema=False)
async def metrics(authorization: str | None = Header(default=None)) -> Response:
    if settings.metrics_token:
        expected = f"Bearer {settings.metrics_token}"
        if not authorization or not hmac.compare_digest(authorization, expected):
            raise HTTPException(status_code=401, detail="metrics token required")
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
