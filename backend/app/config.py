"""Central configuration for StockSage India.

Every rule parameter lives here (sourced from .env) so the rules engine,
backtester, and UI all read the same values. Runtime-editable parameters
are mirrored in the app_settings table; this module provides the defaults.
"""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings, loaded from environment / .env file."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ── Database ────────────────────────────────────────────────────────
    database_url: str = "postgresql+asyncpg://stocksage:stocksage_secret_2026@localhost:5433/stocksage"
    database_url_sync: str = "postgresql://stocksage:stocksage_secret_2026@localhost:5433/stocksage"

    # ── Capital allocation (R1–R5) ──────────────────────────────────────
    total_capital: float = 100_000
    cash_reserve_pct: float = 0.20
    gold_silver_pct: float = 0.20
    nifty50_pct: float = 0.30
    nifty_next100_pct: float = 0.20
    smallcap_pct: float = 0.10

    # ── Purchase bands (R6–R7) ──────────────────────────────────────────
    min_stock_purchase: float = 7_000
    max_stock_purchase: float = 9_000
    min_etf_purchase: float = 5_000
    max_etf_purchase: float = 6_000

    # ── Daily limit (R8) ────────────────────────────────────────────────
    max_daily_invest_pct: float = 0.20

    # ── Sell rules (R13–R15) ────────────────────────────────────────────
    stop_loss_pct: float = 0.08
    deterioration_score: float = 0.35
    deterioration_days: int = 3
    trailing_profit_trigger: float = 0.15
    trailing_profit_giveback: float = 0.05

    # ── Guards (R11–R12) ────────────────────────────────────────────────
    nifty_fall_threshold: float = -0.10
    bad_news_headline_limit: int = 3

    # ── Sentiment ───────────────────────────────────────────────────────
    finbert_model: str = "ProsusAI/finbert"
    # Pinned Hub commit, so a silent upstream change can never alter scores.
    # Set to "" to follow the latest revision (e.g. for a local fine-tuned dir).
    finbert_revision: str = "4556d13015211d73dccd3fdd39d39232506f3e43"
    use_gpu: bool = True
    news_api_key: str = ""
    # Champion/shadow models chosen by research.registry ("" = models/serving.json
    # at the repo root). Without the file the pinned model above serves.
    serving_config: str = ""
    # Score each new headline with the registry's shadow model too (logged to
    # shadow_predictions, never used in a decision).
    shadow_enabled: bool = True

    # ── Monitoring ──────────────────────────────────────────────────────────
    # /metrics (Prometheus). Empty token = open; set one if the API is
    # reachable from the internet (REMOTE_ACCESS.md) and give it to Prometheus.
    metrics_token: str = ""
    # Research tab (annotation): folder holding corpus/sample.jsonl and
    # annotation/prelabels.jsonl ("" = data/ at the repo root).
    research_data_dir: str = ""

    # ── Deployment ──────────────────────────────────────────────────────
    # Comma-separated list of browser origins allowed to call this API.
    # In production set this to your frontend URL, e.g.
    #   CORS_ORIGINS=https://stocksage.pages.dev
    cors_origins: str = "http://localhost:3000,http://localhost:5173"
    # Connection pool — keep small on free managed Postgres (Neon/Supabase),
    # which cap concurrent connections far below a self-hosted server.
    db_pool_size: int = 5
    db_max_overflow: int = 2

    # ── App / scheduling ────────────────────────────────────────────────
    # Scheduler is opt-out: free hosts that sleep can't be trusted with cron,
    # so deployments may disable it and trigger runs via POST /api/engine/run.
    enable_scheduler: bool = True
    # Open registration is fine on localhost, but this app can be published to
    # the public internet (see REMOTE_ACCESS.md), where an open /register lets
    # strangers create accounts and run engine work on your machine. The very
    # first user can always register, so a fresh install still bootstraps;
    # after that, set ALLOW_REGISTRATION=true to invite anyone else.
    allow_registration: bool = False
    # Serve the built React bundle from ./static (single-container deploys).
    serve_frontend: bool = False
    paper_trading: bool = True
    timezone: str = "Asia/Kolkata"
    morning_brief_hour: int = 8
    morning_brief_minute: int = 30
    midday_refresh_hour: int = 12
    midday_refresh_minute: int = 30
    eod_snapshot_hour: int = 16
    eod_snapshot_minute: int = 0
    # News-only collection between engine runs (0 = off). Feeds keep only
    # their latest ~25 items, so polling three times a day misses most headlines.
    news_poll_minutes: int = 30

    # ── Constants ───────────────────────────────────────────────────────
    nifty50_index: str = "^NSEI"
    sensex_index: str = "^BSESN"
    gold_etf: str = "GOLDBEES.NS"
    silver_etf: str = "SILVERBEES.NS"

    # The 9 tracked sectors (R9). NSE/yfinance sector names are normalized
    # onto these by market_data.sector_map.
    tracked_sectors: tuple = (
        "IT", "Banking & Finance", "Manufacturing", "Services",
        "Metal", "Oil & Gas", "Energy & Power", "Pharma & Healthcare", "FMCG",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        """cors_origins parsed into a list; '*' means allow any origin."""
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    # Composite score weights — transparent, sums to 1.0
    weight_technical: float = 0.40
    weight_fundamental: float = 0.35
    weight_sentiment: float = 0.25


@lru_cache
def get_settings() -> Settings:
    """Cached settings accessor used across the app."""
    return Settings()
