"""Buy/sell planning — pure logic, fully testable and backtest-safe.

The crucial detail: PROVISIONAL STATE UPDATES. When the planner approves a buy,
it immediately applies that buy to its working copy of the portfolio (cash,
invested_today, bucket, sector, held set) before evaluating the next candidate.
Without this, the engine would happily approve five ₹9,000 buys on the same
morning and blow straight through the R8 daily cap.
"""
from dataclasses import replace

from app.config import Settings, get_settings
from app.rules.base import BuyCandidate, BuyEvaluation, MarketState, PortfolioState, SellEvaluation
from app.rules.buy_rules import evaluate_buy
from app.rules.sell_rules import evaluate_sell

MIN_BUY_SCORE = 0.60

DEFAULT_MAX_PER_SEGMENT = {
    "NIFTY50": 3, "NEXT100": 2, "SMALLCAP": 1, "GOLD_ETF": 1, "SILVER_ETF": 1,
}
SEGMENT_ORDER = ["NIFTY50", "NEXT100", "SMALLCAP", "GOLD_ETF", "SILVER_ETF"]


def _apply_buy(p: PortfolioState, ev: BuyEvaluation) -> PortfolioState:
    """Return a new PortfolioState with the approved buy applied."""
    c = ev.candidate
    bucket = dict(p.bucket_deployed)
    bucket[c.segment] = bucket.get(c.segment, 0.0) + ev.total_cost
    sector = dict(p.sector_deployed)
    if not c.is_etf:
        sector[c.sector] = sector.get(c.sector, 0.0) + ev.total_cost
    return replace(
        p,
        cash_balance=p.cash_balance - ev.total_cost,
        invested_today=p.invested_today + ev.total_cost,
        bucket_deployed=bucket,
        sector_deployed=sector,
        held_symbols=p.held_symbols | {c.symbol},
    )


def plan_buys(candidates: list[BuyCandidate],
              portfolio: PortfolioState,
              market: MarketState,
              s: Settings | None = None,
              max_per_segment: dict[str, int] | None = None,
              ) -> tuple[list[BuyEvaluation], list[BuyEvaluation], PortfolioState]:
    """Rank candidates per segment and approve buys under live rule evaluation.

    Returns (approved, skipped, final_portfolio_state). `skipped` contains only
    candidates that scored >= MIN_BUY_SCORE but were killed by a rule — those
    are the interesting rejections worth showing the user. Low-score names
    aren't "skipped", they simply weren't buy material today.
    """
    s = s or get_settings()
    limits = max_per_segment or DEFAULT_MAX_PER_SEGMENT
    approved: list[BuyEvaluation] = []
    skipped: list[BuyEvaluation] = []
    state = portfolio

    by_segment: dict[str, list[BuyCandidate]] = {}
    for c in candidates:
        if c.composite_score >= MIN_BUY_SCORE:
            by_segment.setdefault(c.segment, []).append(c)

    for segment in SEGMENT_ORDER:
        pool = sorted(by_segment.get(segment, []), key=lambda c: c.composite_score, reverse=True)
        taken = 0
        for cand in pool:
            if taken >= limits.get(segment, 0):
                break
            ev = evaluate_buy(cand, state, market, s)
            if ev.approved:
                approved.append(ev)
                state = _apply_buy(state, ev)
                taken += 1
            else:
                last = ev.results[-1]
                # A market-wide blocker means nothing else can pass — stop entirely.
                if last.severity.value == "BLOCKER":
                    skipped.append(ev)
                    return approved, skipped, state
                skipped.append(ev)
    return approved, skipped, state


def plan_sells(holdings: list[dict], s: Settings | None = None) -> tuple[list[SellEvaluation], list[SellEvaluation]]:
    """Evaluate R13–R15 on every holding.

    Each holding dict needs: symbol, avg_buy_price, current_price, peak_price,
    low_score_streak. Returns (sell_alerts, healthy_holds).
    """
    s = s or get_settings()
    sells, holds = [], []
    for h in holdings:
        ev = evaluate_sell(
            symbol=h["symbol"],
            avg_buy_price=float(h["avg_buy_price"]),
            current_price=float(h["current_price"] or 0),
            peak_price=float(h.get("peak_price") or 0),
            low_score_streak=int(h.get("low_score_streak") or 0),
            s=s,
        )
        (sells if ev.should_sell else holds).append(ev)
    return sells, holds
