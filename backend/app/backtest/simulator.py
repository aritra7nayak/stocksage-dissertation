"""Backtest simulator — replays the EXACT live rule engine over history.

What's identical to live: plan_buys (all 12 buy rules with provisional state),
evaluate_sell (R13/R15/R14), purchase bands, daily caps, bucket targets,
sector concentration, weak-sector blocks, the R11 Nifty guard semantics
(today's buys gated by the PREVIOUS session's Nifty change — exactly like the
8:30 AM live run).

What differs (stated honestly in every result):
- Without `news`, composite score = technical score (sentiment/fundamentals
  neutral). With `news` (a NewsSignals built from time-aligned historical
  headlines, see news_signals.py), composite = technical + sentiment with the
  live weights re-normalised (no point-in-time fundamentals exist), and R12
  market/sector blocks fire from that day's headlines.
- fill="close" (default): signals and fills on the same close, as before.
  fill="next_open": decisions at today's close are filled at the next
  session's open, which removes same-bar look-ahead.
- Costs: 0.12% per side (brokerage + STT + slippage approximation).

Sells are NEVER gated by R11/R12 — capital protection always runs.
"""
import logging
from dataclasses import dataclass, field
from datetime import date

import pandas as pd

from app.backtest import metrics
from app.backtest.series import indicator_frame, tech_score_at
from app.config import Settings, get_settings
from app.engine.scoring import sentiment_to_unit
from app.engine.sector_health import compute_sector_health
from app.rules.base import BuyCandidate, MarketState, PortfolioState
from app.rules.buy_rules import evaluate_buy  # noqa: F401  (re-export for tests)
from app.engine.planner import plan_buys
from app.rules.sell_rules import evaluate_sell

logger = logging.getLogger("stocksage.backtest")

COST_PCT = 0.0012  # per side
FILL_MODES = ("close", "next_open")


@dataclass
class NewsSignals:
    """Point-in-time news inputs, keyed by the session they may first be used
    on (the caller has already lagged them; see news_signals.build)."""
    symbol_sentiment: dict[date, dict[str, float]] = field(default_factory=dict)  # [-1, 1]
    sector_sentiment: dict[date, dict[str, float]] = field(default_factory=dict)
    market_stopped: dict[date, bool] = field(default_factory=dict)
    blocked_sectors: dict[date, set[str]] = field(default_factory=dict)
    label: str = "news"


@dataclass
class SimHolding:
    symbol: str
    segment: str
    sector: str
    quantity: int
    avg_buy_price: float
    cost_paid: float            # includes buy-side cost
    peak_price: float
    low_score_streak: int = 0


@dataclass
class SimTrade:
    symbol: str
    action: str                 # BUY | SELL
    trade_date: date
    quantity: int
    price: float
    pnl: float | None = None
    triggered_rule: str | None = None
    reason: str = ""


@dataclass
class BacktestResult:
    start_date: date
    end_date: date
    initial_capital: float
    final_value: float = 0.0
    total_return_pct: float = 0.0
    nifty_return_pct: float = 0.0
    max_drawdown_pct: float = 0.0
    win_rate: float = 0.0
    total_trades: int = 0
    open_positions: int = 0
    fill_mode: str = "close"
    metrics: dict = field(default_factory=dict)          # strategy: CAGR, Sharpe, Sortino...
    nifty_metrics: dict = field(default_factory=dict)    # same, Nifty buy-and-hold
    news_blocked_days: int = 0
    trades: list[SimTrade] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


class BacktestSimulator:
    """Inject price data + metadata; .run() walks the calendar."""

    def __init__(self,
                 prices: dict[str, pd.DataFrame],            # symbol → OHLCV (DatetimeIndex)
                 meta: dict[str, tuple[str, str]],            # symbol → (segment, sector)
                 nifty: pd.DataFrame,                         # ^NSEI OHLCV
                 settings: Settings | None = None,
                 news: NewsSignals | None = None,
                 fill: str = "close"):
        if fill not in FILL_MODES:
            raise ValueError(f"fill must be one of {FILL_MODES}")
        self.s = settings or get_settings()
        self.news = news
        self.fill = fill
        self.meta = meta
        self.nifty_close = nifty["Close"]
        self.frames = {sym: indicator_frame(df) for sym, df in prices.items()
                       if df is not None and len(df) >= 80}
        # date → integer row index per symbol, for O(1) lookups
        self.idx = {sym: {d.date(): i for i, d in enumerate(f.index)}
                    for sym, f in self.frames.items()}

    # ── internals ──────────────────────────────────────────────────────
    def _price(self, sym: str, d: date, col: str = "close") -> float | None:
        i = self.idx[sym].get(d)
        return float(self.frames[sym][col].iloc[i]) if i is not None else None

    def _composite(self, tech: float, sym: str, sector: str,
                   sym_sent: dict[str, float], sec_sent: dict[str, float]) -> float:
        """Live weights for technical + sentiment, re-normalised (fundamentals
        have no point-in-time history)."""
        wt, ws = self.s.weight_technical, self.s.weight_sentiment
        unit = sentiment_to_unit(sym_sent.get(sym, sec_sent.get(sector, 0.0)))
        return round((wt * tech + ws * unit) / (wt + ws), 3)

    def _calendar(self, start: date, end: date) -> list[date]:
        return [d.date() for d in self.nifty_close.index
                if start <= d.date() <= end]

    def run(self, start: date, end: date,
            initial_capital: float | None = None) -> BacktestResult:
        s = self.s
        capital = float(initial_capital or s.total_capital)
        res = BacktestResult(start, end, capital, fill_mode=self.fill)
        if self.news is None:
            res.notes.append("Composite = technical score only (no historical news/fundamentals). "
                             "This validates technical signals + rule discipline, not sentiment.")
        else:
            res.notes.append(f"Composite = technical + news sentiment ({self.news.label}); "
                             "R12 news blocks active. Fundamentals neutral (no history).")
        res.notes.append("Fills at the signal day's close." if self.fill == "close" else
                         "Fills at the next session's open (no same-bar look-ahead).")
        cash = capital
        pending_sells: dict[str, SimTrade] = {}     # next_open mode only
        pending_buys: list = []
        holdings: dict[str, SimHolding] = {}
        days = self._calendar(start, end)
        if len(days) < 30:
            res.notes.append("Window too short / no trading days — aborted.")
            return res

        nifty_dates = {d.date(): i for i, d in enumerate(self.nifty_close.index)}
        peak_equity, max_dd = capital, 0.0
        wins, sell_count = 0, 0

        for d in days:
            ni = nifty_dates.get(d)
            # R11 with morning semantics: previous session's change gates today
            if ni is None or ni < 1:
                continue
            prev_chg = float(self.nifty_close.iloc[ni - 1] / self.nifty_close.iloc[ni - 2] - 1) * 100 \
                if ni >= 2 else 0.0
            nifty_fell = prev_chg <= s.nifty_fall_threshold

            # ── yesterday's decisions fill at today's open ─────────────
            if self.fill == "next_open":
                for sym in list(pending_sells):
                    p = self._price(sym, d, "open")
                    if p is None or sym not in holdings:
                        continue                    # no bar today: retry tomorrow
                    h, t = holdings.pop(sym), pending_sells.pop(sym)
                    proceeds = h.quantity * p * (1 - COST_PCT)
                    pnl = round(proceeds - h.cost_paid, 2)
                    cash += proceeds
                    res.trades.append(SimTrade(sym, "SELL", d, h.quantity, round(p, 2), pnl,
                                               t.triggered_rule, t.reason))
                    sell_count += 1
                    wins += pnl > 0
                for ev in pending_buys:
                    c = ev.candidate
                    p = self._price(c.symbol, d, "open")
                    if p is None or c.symbol in holdings:
                        continue                    # stale order: dropped
                    cost = ev.quantity * p * (1 + COST_PCT)
                    if cost > cash:
                        continue
                    cash -= cost
                    holdings[c.symbol] = SimHolding(c.symbol, c.segment, c.sector,
                                                    ev.quantity, p, cost, p)
                    res.trades.append(SimTrade(c.symbol, "BUY", d, ev.quantity, round(p, 2),
                                               reason=f"score {c.composite_score} (next open)"))
                pending_buys = []

            sym_sent = self.news.symbol_sentiment.get(d, {}) if self.news else {}
            sec_sent = self.news.sector_sentiment.get(d, {}) if self.news else {}

            # ── mark to market, peaks, streaks ─────────────────────────
            scores_today: dict[str, float] = {}
            day_chg: dict[str, float] = {}
            rsi_today: dict[str, float] = {}
            for sym, f in self.frames.items():
                i = self.idx[sym].get(d)
                if i is None or i < 60:
                    continue
                sc = tech_score_at(f, i)
                if self.news is not None:
                    sc = self._composite(sc, sym, self.meta[sym][1], sym_sent, sec_sent)
                scores_today[sym] = sc
                day_chg[sym] = float(f["day_chg"].iloc[i] or 0)
                r = f["rsi"].iloc[i]
                rsi_today[sym] = float(r) if pd.notna(r) else 50.0

            for h in holdings.values():
                p = self._price(h.symbol, d)
                if p is None:
                    continue
                h.peak_price = max(h.peak_price, p)
                sc = scores_today.get(h.symbol)
                if sc is not None:
                    h.low_score_streak = h.low_score_streak + 1 if sc < s.deterioration_score else 0

            # ── SELLS first (never gated by market guards) ─────────────
            for sym in list(holdings):
                h = holdings[sym]
                p = self._price(sym, d)
                if p is None:
                    continue
                ev = evaluate_sell(sym, h.avg_buy_price, p, h.peak_price, h.low_score_streak, s)
                if ev.should_sell and self.fill == "next_open":
                    pending_sells.setdefault(sym, SimTrade(sym, "SELL", d, h.quantity, p, None,
                                                           ev.triggered_rule, ev.reason[:160]))
                elif ev.should_sell:
                    proceeds = h.quantity * p * (1 - COST_PCT)
                    pnl = round(proceeds - h.cost_paid, 2)
                    cash += proceeds
                    res.trades.append(SimTrade(sym, "SELL", d, h.quantity, round(p, 2),
                                               pnl, ev.triggered_rule, ev.reason[:160]))
                    sell_count += 1
                    wins += pnl > 0
                    del holdings[sym]

            # ── BUYS through the real planner ──────────────────────────
            equity_syms = {sym: self.meta[sym][1] for sym in scores_today
                           if self.meta[sym][0] in ("NIFTY50", "NEXT100", "SMALLCAP")}
            health = compute_sector_health(equity_syms, day_chg, rsi_today,
                                           sec_sent, s.tracked_sectors)
            market = MarketState(nifty_fell=nifty_fell, nifty_change_pct=prev_chg,
                                 guard_basis="previous session (backtest)",
                                 weak_sectors={h.sector for h in health if h.status == "WEAK"})
            if self.news is not None:
                market.market_stopped = self.news.market_stopped.get(d, False)
                market.blocked_sectors = set(self.news.blocked_sectors.get(d, set()))
                res.news_blocked_days += bool(market.market_stopped or market.blocked_sectors)

            bucket_dep: dict[str, float] = {}
            sector_dep: dict[str, float] = {}
            mkt_value = 0.0
            for h in holdings.values():
                p = self._price(h.symbol, d) or h.avg_buy_price
                mkt_value += h.quantity * p
                cost = h.quantity * h.avg_buy_price
                bucket_dep[h.segment] = bucket_dep.get(h.segment, 0.0) + cost
                if h.segment in ("NIFTY50", "NEXT100", "SMALLCAP"):
                    sector_dep[h.sector] = sector_dep.get(h.sector, 0.0) + cost

            pstate = PortfolioState(
                total_capital=cash + mkt_value, cash_balance=cash,
                invested_today=0.0, bucket_deployed=bucket_dep,
                sector_deployed=sector_dep, held_symbols=set(holdings))

            candidates = [BuyCandidate(sym, self.meta[sym][0], self.meta[sym][1],
                                       float(self.frames[sym]["close"].iloc[self.idx[sym][d]]),
                                       composite_score=sc,
                                       is_etf=self.meta[sym][0] in ("GOLD_ETF", "SILVER_ETF"))
                          for sym, sc in scores_today.items()]
            buys, _, _ = plan_buys(candidates, pstate, market, s)
            if self.fill == "next_open":
                pending_buys = list(buys)
                buys = []
            for ev in buys:
                c = ev.candidate
                cost = ev.total_cost * (1 + COST_PCT)
                if cost > cash:
                    continue
                cash -= cost
                holdings[c.symbol] = SimHolding(c.symbol, c.segment, c.sector,
                                                ev.quantity, c.price, cost, c.price)
                res.trades.append(SimTrade(c.symbol, "BUY", d, ev.quantity,
                                           round(c.price, 2),
                                           reason=f"score {c.composite_score}"))

            # ── equity curve / drawdown ───────────────────────────────
            equity = cash + sum((self._price(h.symbol, d) or h.avg_buy_price) * h.quantity
                                for h in holdings.values())
            peak_equity = max(peak_equity, equity)
            max_dd = max(max_dd, (peak_equity - equity) / peak_equity)
            res.equity_curve.append({"date": str(d), "equity": round(equity, 2)})

        # ── final metrics ──────────────────────────────────────────────
        final = res.equity_curve[-1]["equity"] if res.equity_curve else capital
        res.final_value = final
        res.total_return_pct = round((final / capital - 1) * 100, 3)
        n0 = self.nifty_close[self.nifty_close.index.map(lambda x: x.date() >= days[0])].iloc[0]
        n1 = self.nifty_close[self.nifty_close.index.map(lambda x: x.date() <= days[-1])].iloc[-1]
        res.nifty_return_pct = round((float(n1) / float(n0) - 1) * 100, 3)
        res.max_drawdown_pct = round(max_dd * 100, 3)
        res.metrics = metrics.summarize([e["equity"] for e in res.equity_curve])
        nifty_window = [float(v) for i, v in zip(self.nifty_close.index, self.nifty_close)
                        if days[0] <= i.date() <= days[-1]]
        res.nifty_metrics = metrics.summarize(nifty_window)
        res.total_trades = len(res.trades)
        res.open_positions = len(holdings)
        res.win_rate = round(wins / sell_count, 3) if sell_count else 0.0
        logger.info("Backtest %s→%s: %.2f%% vs Nifty %.2f%% | DD %.2f%% | %d trades",
                    start, end, res.total_return_pct, res.nifty_return_pct,
                    res.max_drawdown_pct, res.total_trades)
        return res
