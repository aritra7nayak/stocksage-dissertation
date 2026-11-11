"""SQLAlchemy ORM models — mirrors database/init.sql exactly."""
from datetime import date, datetime

from sqlalchemy import (
    ARRAY, Boolean, Date, DateTime, ForeignKey, Integer, Numeric, String, Text, UniqueConstraint, func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(48), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(80))
    password_hash: Mapped[str] = mapped_column(Text)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Portfolio(Base):
    __tablename__ = "portfolios"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100), default="My Portfolio")
    total_capital: Mapped[float] = mapped_column(Numeric(14, 2), default=100000)
    cash_balance: Mapped[float] = mapped_column(Numeric(14, 2), default=100000)
    is_paper: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class StockUniverse(Base):
    __tablename__ = "stock_universe"

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(24), unique=True)
    company_name: Mapped[str | None] = mapped_column(String(200))
    sector: Mapped[str | None] = mapped_column(String(100))
    industry: Mapped[str | None] = mapped_column(String(150))
    segment: Mapped[str] = mapped_column(String(20))
    market_cap: Mapped[float | None] = mapped_column(Numeric(20, 2))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    unbuyable_reason: Mapped[str | None] = mapped_column(Text)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Holding(Base):
    __tablename__ = "holdings"
    __table_args__ = (UniqueConstraint("portfolio_id", "symbol"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(ForeignKey("portfolios.id", ondelete="CASCADE"))
    symbol: Mapped[str] = mapped_column(String(24))
    company_name: Mapped[str | None] = mapped_column(String(200))
    quantity: Mapped[int] = mapped_column(Integer)
    avg_buy_price: Mapped[float] = mapped_column(Numeric(12, 2))
    current_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    peak_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    segment: Mapped[str | None] = mapped_column(String(20))
    sector: Mapped[str | None] = mapped_column(String(100))
    low_score_streak: Mapped[int] = mapped_column(Integer, default=0)
    bought_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    portfolio_id: Mapped[int] = mapped_column(ForeignKey("portfolios.id", ondelete="CASCADE"))
    symbol: Mapped[str] = mapped_column(String(24))
    action: Mapped[str] = mapped_column(String(6))
    quantity: Mapped[int] = mapped_column(Integer)
    price: Mapped[float] = mapped_column(Numeric(12, 2))
    total_value: Mapped[float] = mapped_column(Numeric(14, 2))
    is_paper: Mapped[bool] = mapped_column(Boolean, default=True)
    suggestion_id: Mapped[int | None] = mapped_column(Integer)
    reason: Mapped[str | None] = mapped_column(Text)
    executed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MarketSnapshot(Base):
    __tablename__ = "market_snapshots"

    id: Mapped[int] = mapped_column(primary_key=True)
    snapshot_date: Mapped[date] = mapped_column(Date, unique=True)
    nifty50_open: Mapped[float | None] = mapped_column(Numeric(12, 2))
    nifty50_close: Mapped[float | None] = mapped_column(Numeric(12, 2))
    nifty50_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 3))
    sensex_open: Mapped[float | None] = mapped_column(Numeric(12, 2))
    sensex_close: Mapped[float | None] = mapped_column(Numeric(12, 2))
    sensex_change_pct: Mapped[float | None] = mapped_column(Numeric(7, 3))
    gold_etf_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    silver_etf_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    market_status: Mapped[str | None] = mapped_column(String(12))
    nifty_fell: Mapped[bool] = mapped_column(Boolean, default=False)
    is_intraday: Mapped[bool] = mapped_column(Boolean, default=False)
    data_age_minutes: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StockAnalysis(Base):
    __tablename__ = "stock_analysis"
    __table_args__ = (UniqueConstraint("symbol", "analysis_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    symbol: Mapped[str] = mapped_column(String(24))
    analysis_date: Mapped[date] = mapped_column(Date)
    current_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    rsi_14: Mapped[float | None] = mapped_column(Numeric(6, 2))
    macd_hist: Mapped[float | None] = mapped_column(Numeric(12, 4))
    macd_signal: Mapped[str | None] = mapped_column(String(16))
    ema_20: Mapped[float | None] = mapped_column(Numeric(12, 2))
    ema_50: Mapped[float | None] = mapped_column(Numeric(12, 2))
    ema_cross: Mapped[str | None] = mapped_column(String(12))
    bb_percent_b: Mapped[float | None] = mapped_column(Numeric(6, 3))
    adx: Mapped[float | None] = mapped_column(Numeric(6, 2))
    stoch_k: Mapped[float | None] = mapped_column(Numeric(6, 2))
    volume_ratio: Mapped[float | None] = mapped_column(Numeric(8, 3))
    momentum_20d: Mapped[float | None] = mapped_column(Numeric(8, 4))
    dist_52w_high: Mapped[float | None] = mapped_column(Numeric(6, 3))
    pe_ratio: Mapped[float | None] = mapped_column(Numeric(10, 2))
    pb_ratio: Mapped[float | None] = mapped_column(Numeric(10, 2))
    roe: Mapped[float | None] = mapped_column(Numeric(8, 2))
    debt_to_equity: Mapped[float | None] = mapped_column(Numeric(10, 2))
    revenue_growth: Mapped[float | None] = mapped_column(Numeric(8, 2))
    profit_margin: Mapped[float | None] = mapped_column(Numeric(8, 2))
    dividend_yield: Mapped[float | None] = mapped_column(Numeric(6, 3))
    news_sentiment: Mapped[float | None] = mapped_column(Numeric(5, 3))
    sector_sentiment: Mapped[float | None] = mapped_column(Numeric(5, 3))
    technical_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    fundamental_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    sentiment_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    composite_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    recommendation: Mapped[str | None] = mapped_column(String(6))
    confidence: Mapped[str | None] = mapped_column(String(8))
    top_reasons: Mapped[dict | None] = mapped_column(JSONB)


class SectorHealth(Base):
    __tablename__ = "sector_health"
    __table_args__ = (UniqueConstraint("sector", "health_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    sector: Mapped[str] = mapped_column(String(100))
    health_date: Mapped[date] = mapped_column(Date)
    score: Mapped[float | None] = mapped_column(Numeric(5, 1))
    status: Mapped[str | None] = mapped_column(String(10))
    change_pct: Mapped[float | None] = mapped_column(Numeric(7, 3))
    avg_rsi: Mapped[float | None] = mapped_column(Numeric(6, 2))
    news_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    top_gainer: Mapped[str | None] = mapped_column(String(24))
    is_blocked: Mapped[bool] = mapped_column(Boolean, default=False)
    block_reason: Mapped[str | None] = mapped_column(Text)


class NewsItem(Base):
    __tablename__ = "news_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    headline: Mapped[str] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str | None] = mapped_column(String(100))
    sentiment: Mapped[str | None] = mapped_column(String(10))
    sentiment_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    severity: Mapped[float] = mapped_column(Numeric(4, 1), default=0)
    is_bad_news: Mapped[bool] = mapped_column(Boolean, default=False)
    related_symbols: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    related_sectors: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    url_hash: Mapped[str | None] = mapped_column(String(64), unique=True)
    # database/nlp_v1.sql
    summary: Mapped[str | None] = mapped_column(Text)
    sentiment_model: Mapped[str | None] = mapped_column(String(160))
    linker_version: Mapped[str | None] = mapped_column(String(40))
    # database/mlops_v1.sql
    sentiment_confidence: Mapped[float | None] = mapped_column(Numeric(4, 3))


class ShadowPrediction(Base):
    """Shadow-model output per headline (database/mlops_v1.sql). Never read
    by the engine: it exists to compare a candidate with the champion live."""
    __tablename__ = "shadow_predictions"
    __table_args__ = (UniqueConstraint("url_hash", "model_version"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    url_hash: Mapped[str] = mapped_column(String(64))
    model_version: Mapped[str] = mapped_column(String(160))
    sentiment: Mapped[str] = mapped_column(String(10))
    sentiment_score: Mapped[float] = mapped_column(Numeric(5, 3))
    confidence: Mapped[float] = mapped_column(Numeric(4, 3))
    champion_model: Mapped[str | None] = mapped_column(String(160))
    champion_sentiment: Mapped[str | None] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SuggestionLog(Base):
    __tablename__ = "suggestions_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    suggestion_date: Mapped[date] = mapped_column(Date)
    run_type: Mapped[str] = mapped_column(String(10), default="MORNING")
    portfolio_id: Mapped[int | None] = mapped_column(ForeignKey("portfolios.id"))
    symbol: Mapped[str | None] = mapped_column(String(24))
    action: Mapped[str] = mapped_column(String(6))
    segment: Mapped[str | None] = mapped_column(String(20))
    sector: Mapped[str | None] = mapped_column(String(100))
    suggested_quantity: Mapped[int | None] = mapped_column(Integer)
    suggested_price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    total_value: Mapped[float | None] = mapped_column(Numeric(14, 2))
    composite_score: Mapped[float | None] = mapped_column(Numeric(5, 3))
    confidence: Mapped[str | None] = mapped_column(String(8))
    rules_passed: Mapped[dict | None] = mapped_column(JSONB)
    rules_failed: Mapped[dict | None] = mapped_column(JSONB)
    reasoning: Mapped[dict | None] = mapped_column(JSONB)
    was_acted_on: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class BacktestRun(Base):
    __tablename__ = "backtest_runs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str | None] = mapped_column(String(120))
    start_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date] = mapped_column(Date)
    initial_capital: Mapped[float] = mapped_column(Numeric(14, 2))
    final_value: Mapped[float | None] = mapped_column(Numeric(14, 2))
    total_return_pct: Mapped[float | None] = mapped_column(Numeric(8, 3))
    nifty_return_pct: Mapped[float | None] = mapped_column(Numeric(8, 3))
    max_drawdown_pct: Mapped[float | None] = mapped_column(Numeric(8, 3))
    win_rate: Mapped[float | None] = mapped_column(Numeric(5, 3))
    total_trades: Mapped[int | None] = mapped_column(Integer)
    rule_config: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(12), default="PENDING")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class BacktestTrade(Base):
    __tablename__ = "backtest_trades"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("backtest_runs.id", ondelete="CASCADE"))
    symbol: Mapped[str] = mapped_column(String(24))
    action: Mapped[str] = mapped_column(String(6))
    trade_date: Mapped[date] = mapped_column(Date)
    quantity: Mapped[int | None] = mapped_column(Integer)
    price: Mapped[float | None] = mapped_column(Numeric(12, 2))
    pnl: Mapped[float | None] = mapped_column(Numeric(14, 2))
    triggered_rule: Mapped[str | None] = mapped_column(String(8))
    reason: Mapped[str | None] = mapped_column(Text)


class AppSetting(Base):
    __tablename__ = "app_settings"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(String(60))
    value: Mapped[str] = mapped_column(Text)
    value_type: Mapped[str] = mapped_column(String(10), default="str")
    description: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
