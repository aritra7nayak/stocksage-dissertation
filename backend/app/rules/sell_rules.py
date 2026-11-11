"""Sell-side rules R13–R15 — the discipline the original spec was missing.

Checked in priority order; the first trigger wins:
    R13 stop-loss        → IMMEDIATE  (capital protection beats everything)
    R15 trailing profit  → HIGH       (lock in gains before they evaporate)
    R14 deterioration    → REVIEW     (slow bleed — composite score stayed weak)
"""
from app.config import Settings, get_settings
from app.rules.base import SellEvaluation


def evaluate_sell(symbol: str,
                  avg_buy_price: float,
                  current_price: float,
                  peak_price: float | None = None,
                  low_score_streak: int = 0,
                  s: Settings | None = None) -> SellEvaluation:
    """Run R13→R15→R14 on one holding.

    Args:
        symbol: holding symbol.
        avg_buy_price: average buy price.
        current_price: latest price.
        peak_price: highest price seen since purchase (R15 input). Defaults to
            max(avg_buy_price, current_price) when untracked.
        low_score_streak: consecutive days the composite score has been below
            the deterioration floor (maintained by the daily engine run, R14).
    """
    s = s or get_settings()
    ev = SellEvaluation(symbol=symbol)
    if avg_buy_price <= 0 or current_price <= 0:
        return ev

    peak = max(peak_price or 0.0, avg_buy_price, current_price)
    pnl_pct = current_price / avg_buy_price - 1

    # R13 — stop loss
    if pnl_pct <= -s.stop_loss_pct:
        ev.should_sell = True
        ev.triggered_rule = "R13"
        ev.urgency = "IMMEDIATE"
        ev.reason = (f"STOP LOSS: {symbol} is {pnl_pct:.1%} below your ₹{avg_buy_price:,.2f} "
                     f"average (limit −{s.stop_loss_pct:.0%}). Selling caps the damage; "
                     f"holding and hoping is how small losses become big ones.")
        return ev

    # R15 — trailing profit protection
    peak_gain = peak / avg_buy_price - 1
    giveback = 1 - current_price / peak if peak > 0 else 0.0
    if peak_gain >= s.trailing_profit_trigger and giveback >= s.trailing_profit_giveback:
        ev.should_sell = True
        ev.triggered_rule = "R15"
        ev.urgency = "HIGH"
        ev.reason = (f"PROFIT PROTECT: {symbol} peaked at ₹{peak:,.2f} ({peak_gain:+.0%} on your buy) "
                     f"and has given back {giveback:.1%} from that peak. Locking in the remaining "
                     f"{pnl_pct:+.1%} gain before it erodes further.")
        return ev

    # R14 — sustained deterioration
    if low_score_streak >= s.deterioration_days:
        ev.should_sell = True
        ev.triggered_rule = "R14"
        ev.urgency = "REVIEW"
        ev.reason = (f"DETERIORATION: {symbol}'s composite score has stayed below "
                     f"{s.deterioration_score} for {low_score_streak} straight days — "
                     f"technicals, fundamentals or sentiment have weakened persistently. "
                     f"Current P&L {pnl_pct:+.1%}. Review and consider exiting.")
        return ev

    ev.reason = f"{symbol} healthy: P&L {pnl_pct:+.1%}, no sell rule triggered."
    return ev
