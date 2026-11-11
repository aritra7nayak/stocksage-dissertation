"""Buy-side rules R1–R12, evaluated in a strict order.

Pure functions: no I/O, no database, no network — given the same inputs they
always produce the same verdicts, which is what makes them unit-testable and
backtestable with zero behavioural drift.

Evaluation order (cheapest blockers first):
    R11 Nifty guard → R12 market news → R12 sector news → R10 weak sector →
    DUP duplicate check → R6/R7 purchase band (computes quantity) →
    R8 daily limit → R2–R5 bucket capacity → R1 cash reserve → R9 concentration
"""
import math

from app.config import Settings, get_settings
from app.rules.base import (
    BuyCandidate, BuyEvaluation, MarketState, PortfolioState, RuleResult, Severity,
)

# Max share of deployed EQUITY a single sector may hold (R9 interpretation)
SECTOR_CONCENTRATION_CAP = 0.35
# Concentration cap only applies once the portfolio has this many equity ₹ deployed
CONCENTRATION_MIN_DEPLOYED = 25_000


def bucket_target(segment: str, total_capital: float, s: Settings) -> float:
    """Target ₹ for a segment bucket per R2–R5."""
    pct = {
        "NIFTY50": s.nifty50_pct,
        "NEXT100": s.nifty_next100_pct,
        "SMALLCAP": s.smallcap_pct,
        "GOLD_ETF": s.gold_silver_pct / 2,
        "SILVER_ETF": s.gold_silver_pct / 2,
    }.get(segment, 0.0)
    return round(total_capital * pct, 2)


# ── Individual rules ─────────────────────────────────────────────────────────

def rule_r11_nifty_guard(market: MarketState) -> RuleResult:
    """R11: if the Nifty fell, no buying at all today."""
    if market.nifty_fell:
        return RuleResult("R11", "Nifty guard", False,
                          f"Nifty is down {market.nifty_change_pct:+.2f}% ({market.guard_basis}) — "
                          "all buying paused today", Severity.BLOCKER)
    return RuleResult("R11", "Nifty guard", True,
                      f"Nifty {market.nifty_change_pct:+.2f}% ({market.guard_basis}) — buying permitted",
                      Severity.PASS)


def rule_r12_market_news(market: MarketState, s: Settings) -> RuleResult:
    """R12 (market-wide): too many severe headlines pauses everything."""
    if market.market_stopped:
        return RuleResult("R12", "Bad-news guard (market)", False,
                          f"{market.bad_headline_count} severe headlines today "
                          f"(limit {s.bad_news_headline_limit}) — market paused, capital preserved",
                          Severity.BLOCKER)
    return RuleResult("R12", "Bad-news guard (market)", True,
                      f"{market.bad_headline_count} severe headlines — below pause threshold",
                      Severity.PASS)


def rule_r12_sector_news(c: BuyCandidate, market: MarketState) -> RuleResult:
    """R12 (sector): bad news in the candidate's sector pauses that sector. ETFs exempt."""
    if not c.is_etf and c.sector in market.blocked_sectors:
        return RuleResult("R12s", "Bad-news guard (sector)", False,
                          f"{c.sector} sector paused today due to severe negative news", Severity.FAIL)
    return RuleResult("R12s", "Bad-news guard (sector)", True,
                      f"No news block on {c.sector if not c.is_etf else 'ETFs'}", Severity.PASS)


def rule_r10_weak_sector(c: BuyCandidate, market: MarketState) -> RuleResult:
    """R10: do not buy into weak sectors (health score < 40). ETFs exempt."""
    if not c.is_etf and c.sector in market.weak_sectors:
        return RuleResult("R10", "Sector health", False,
                          f"{c.sector} is currently WEAK (negative momentum / sentiment) — skipping",
                          Severity.FAIL)
    return RuleResult("R10", "Sector health", True,
                      f"{c.sector} sector health acceptable" if not c.is_etf else "ETF — sector health N/A",
                      Severity.PASS)


def rule_dup_already_held(c: BuyCandidate, p: PortfolioState) -> RuleResult:
    """Position discipline: don't re-buy a symbol already held (avoids creeping concentration)."""
    if c.symbol in p.held_symbols:
        return RuleResult("DUP", "Position discipline", False,
                          f"Already holding {c.symbol} — not adding to avoid single-stock concentration",
                          Severity.FAIL)
    return RuleResult("DUP", "Position discipline", True, "New position", Severity.PASS)


def rule_r6_r7_purchase_band(c: BuyCandidate, s: Settings) -> tuple[RuleResult, int, float]:
    """R6/R7: purchase value must fit the band. Returns (result, quantity, cost).

    Stocks: ₹7,000–₹9,000. ETFs: ₹5,000–₹6,000.
    Quantity = the largest whole-share count whose cost stays ≤ band max.
    A single share above band max makes the stock unbuyable (e.g. MRF, Page).
    """
    lo, hi = (s.min_etf_purchase, s.max_etf_purchase) if c.is_etf else (s.min_stock_purchase, s.max_stock_purchase)
    rid, name = ("R7", "ETF purchase band") if c.is_etf else ("R6", "Stock purchase band")

    if c.price is None or not math.isfinite(c.price) or c.price <= 0:
        return RuleResult(rid, name, False, f"No valid price for {c.symbol}", Severity.FAIL), 0, 0.0
    if c.price > hi:
        return RuleResult(rid, name, False,
                          f"One share costs ₹{c.price:,.0f} — exceeds band max ₹{hi:,.0f}; unbuyable under this rule",
                          Severity.FAIL), 0, 0.0
    
    qty = math.floor(hi / c.price)
    cost = round(qty * c.price, 2)
    if cost < lo:
        return RuleResult(rid, name, False,
                          f"Best fit is {qty} share(s) = ₹{cost:,.0f}, below band min ₹{lo:,.0f}",
                          Severity.FAIL), 0, 0.0
    return RuleResult(rid, name, True,
                      f"{qty} share(s) × ₹{c.price:,.2f} = ₹{cost:,.0f} — inside ₹{lo:,.0f}–₹{hi:,.0f} band",
                      Severity.PASS), qty, cost


def rule_r8_daily_limit(cost: float, p: PortfolioState, s: Settings) -> RuleResult:
    """R8: total invested today must not exceed 20% of total capital."""
    cap = p.total_capital * s.max_daily_invest_pct
    after = p.invested_today + cost
    if after > cap + 0.01:
        return RuleResult("R8", "Daily investment limit", False,
                          f"₹{p.invested_today:,.0f} already deployed today; adding ₹{cost:,.0f} "
                          f"would exceed the daily cap of ₹{cap:,.0f}", Severity.FAIL)
    return RuleResult("R8", "Daily investment limit", True,
                      f"₹{after:,.0f} of ₹{cap:,.0f} daily cap after this buy", Severity.PASS)


def rule_bucket_capacity(c: BuyCandidate, cost: float, p: PortfolioState, s: Settings) -> RuleResult:
    """R2–R5: the buy must fit inside its segment's target bucket."""
    target = bucket_target(c.segment, p.total_capital, s)
    deployed = p.bucket_deployed.get(c.segment, 0.0)
    available = target - deployed
    rid = {"NIFTY50": "R3", "NEXT100": "R4", "SMALLCAP": "R5",
           "GOLD_ETF": "R2", "SILVER_ETF": "R2"}.get(c.segment, "R?")
    if cost > available + 0.01:
        return RuleResult(rid, f"{c.segment} bucket capacity", False,
                          f"Bucket has ₹{available:,.0f} room (target ₹{target:,.0f}, "
                          f"deployed ₹{deployed:,.0f}) — ₹{cost:,.0f} doesn't fit", Severity.FAIL)
    return RuleResult(rid, f"{c.segment} bucket capacity", True,
                      f"₹{cost:,.0f} fits — ₹{available - cost:,.0f} will remain in this bucket",
                      Severity.PASS)


def rule_r1_cash_reserve(cost: float, p: PortfolioState, s: Settings) -> RuleResult:
    """R1: after the buy, cash must stay at/above the 20% reserve."""
    reserve = p.total_capital * s.cash_reserve_pct
    cash_after = p.cash_balance - cost
    if cash_after < reserve - 0.01:
        return RuleResult("R1", "Cash reserve", False,
                          f"Buy would leave ₹{cash_after:,.0f} cash, below the ₹{reserve:,.0f} "
                          f"(20%) untouchable reserve", Severity.FAIL)
    return RuleResult("R1", "Cash reserve", True,
                      f"₹{cash_after:,.0f} cash remains after buy — reserve of ₹{reserve:,.0f} intact",
                      Severity.PASS)


def rule_r9_concentration(c: BuyCandidate, cost: float, p: PortfolioState) -> RuleResult:
    """R9: sector diversification — one sector may not exceed 35% of deployed equity.

    Skipped (auto-pass) while equity deployment is small, otherwise the very
    first purchases would always violate it. ETFs exempt.
    """
    if c.is_etf:
        return RuleResult("R9", "Sector diversification", True, "ETF — exempt", Severity.PASS)
    equity_after = p.equity_deployed + cost
    if equity_after < CONCENTRATION_MIN_DEPLOYED:
        return RuleResult("R9", "Sector diversification", True,
                          "Portfolio still small — concentration cap not yet active", Severity.PASS)
    sector_after = p.sector_deployed.get(c.sector, 0.0) + cost
    share = sector_after / equity_after
    if share > SECTOR_CONCENTRATION_CAP:
        return RuleResult("R9", "Sector diversification", False,
                          f"{c.sector} would become {share:.0%} of equity (cap {SECTOR_CONCENTRATION_CAP:.0%})",
                          Severity.FAIL)
    return RuleResult("R9", "Sector diversification", True,
                      f"{c.sector} at {share:.0%} of equity after buy — within {SECTOR_CONCENTRATION_CAP:.0%} cap",
                      Severity.PASS)


# ── Full evaluation pipeline ─────────────────────────────────────────────────

def evaluate_buy(c: BuyCandidate, p: PortfolioState, market: MarketState,
                 s: Settings | None = None) -> BuyEvaluation:
    """Run every buy-side rule on one candidate, in order, short-circuiting on failure.

    All rules evaluated up to and including the first failure are recorded, so
    the UI checklist can show exactly which rule killed a candidate and why.
    """
    s = s or get_settings()
    ev = BuyEvaluation(candidate=c)

    # Market-level blockers
    for result in (rule_r11_nifty_guard(market), rule_r12_market_news(market, s)):
        ev.results.append(result)
        if not result.passed:
            return ev

    # Candidate-level gates
    for result in (rule_r12_sector_news(c, market),
                   rule_r10_weak_sector(c, market),
                   rule_dup_already_held(c, p)):
        ev.results.append(result)
        if not result.passed:
            return ev

    # Sizing
    band_result, qty, cost = rule_r6_r7_purchase_band(c, s)
    ev.results.append(band_result)
    if not band_result.passed:
        return ev

    # Capital constraints
    for result in (rule_r8_daily_limit(cost, p, s),
                   rule_bucket_capacity(c, cost, p, s),
                   rule_r1_cash_reserve(cost, p, s),
                   rule_r9_concentration(c, cost, p)):
        ev.results.append(result)
        if not result.passed:
            return ev

    ev.approved, ev.quantity, ev.total_cost = True, qty, cost
    return ev
