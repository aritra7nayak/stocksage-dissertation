"""Rules engine tests — every rule's pass AND fail path, plus full-pipeline cases.

Run:  python tests/test_rules.py   (from backend, venv active)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/ on path

from app.config import Settings
from app.rules.base import BuyCandidate, MarketState, PortfolioState, Severity
from app.rules.buy_rules import evaluate_buy, bucket_target
from app.rules.sell_rules import evaluate_sell

S = Settings()  # defaults: ₹1,00,000 capital, 20/20/30/20/10, bands 7–9k / 5–6k


def fresh_portfolio(**kw) -> PortfolioState:
    d = dict(total_capital=100_000, cash_balance=100_000)
    d.update(kw)
    return PortfolioState(**d)


def calm_market(**kw) -> MarketState:
    return MarketState(nifty_fell=False, nifty_change_pct=0.5, **kw)


def stock(price=1500.0, **kw) -> BuyCandidate:
    d = dict(symbol="INFY.NS", segment="NIFTY50", sector="IT", price=price,
             composite_score=0.7, is_etf=False)
    d.update(kw)
    return BuyCandidate(**d)


# ── Happy path ───────────────────────────────────────────────────────────────

def test_clean_buy_approved():
    ev = evaluate_buy(stock(price=1500), fresh_portfolio(), calm_market(), S)
    assert ev.approved
    assert ev.quantity == 6                      # floor(9000/1500)
    assert ev.total_cost == 9000.0
    assert all(r.passed for r in ev.results)
    assert len(ev.results) == 10                 # every rule was checked and recorded


def test_etf_uses_etf_band_and_skips_sector_rules():
    gold = BuyCandidate("GOLDBEES.NS", "GOLD_ETF", "Metal", 121.30, 0.6, is_etf=True)
    ev = evaluate_buy(gold, fresh_portfolio(), calm_market(weak_sectors={"Metal"}), S)
    assert ev.approved, "ETF must be exempt from weak-sector rule"
    assert 5000 <= ev.total_cost <= 6000


# ── R11 / R12 blockers ───────────────────────────────────────────────────────

def test_r11_nifty_fell_blocks_everything():
    ev = evaluate_buy(stock(), fresh_portfolio(),
                      MarketState(nifty_fell=True, nifty_change_pct=-0.8), S)
    assert not ev.approved
    assert ev.results[-1].rule_id == "R11"
    assert ev.results[-1].severity == Severity.BLOCKER
    assert len(ev.results) == 1, "Must short-circuit immediately"


def test_r12_market_stop_blocks_everything():
    ev = evaluate_buy(stock(), fresh_portfolio(),
                      calm_market(market_stopped=True, bad_headline_count=5), S)
    assert not ev.approved
    assert ev.results[-1].rule_id == "R12"


def test_r12_sector_block_kills_only_that_sector():
    blocked = calm_market(blocked_sectors={"IT"})
    assert not evaluate_buy(stock(sector="IT"), fresh_portfolio(), blocked, S).approved
    assert evaluate_buy(stock(symbol="SBIN.NS", sector="Banking & Finance"),
                        fresh_portfolio(), blocked, S).approved


# ── R10 / DUP ────────────────────────────────────────────────────────────────

def test_r10_weak_sector_rejected():
    ev = evaluate_buy(stock(sector="Metal", symbol="TATASTEEL.NS"),
                      fresh_portfolio(), calm_market(weak_sectors={"Metal"}), S)
    assert not ev.approved and ev.results[-1].rule_id == "R10"


def test_dup_already_held_rejected():
    p = fresh_portfolio(held_symbols={"INFY.NS"})
    ev = evaluate_buy(stock(), p, calm_market(), S)
    assert not ev.approved and ev.results[-1].rule_id == "DUP"


# ── R6 / R7 purchase band ────────────────────────────────────────────────────

def test_r6_expensive_share_unbuyable():
    """MRF-style: one share above ₹9,000 → unbuyable, with the reason saying so."""
    ev = evaluate_buy(stock(symbol="MRF.NS", price=120_000), fresh_portfolio(), calm_market(), S)
    assert not ev.approved
    assert ev.results[-1].rule_id == "R6"
    assert "unbuyable" in ev.results[-1].reason


def test_r6_quantity_maximises_within_band():
    ev = evaluate_buy(stock(price=2950), fresh_portfolio(), calm_market(), S)
    assert ev.quantity == 3 and ev.total_cost == 8850.0   # 3×2950 fits; 4 would breach


def test_r6_cheap_stock_many_shares():
    ev = evaluate_buy(stock(price=43.0), fresh_portfolio(), calm_market(), S)
    assert ev.approved and 7000 <= ev.total_cost <= 9000


def test_r6_awkward_price_below_min():
    """Price 8,500: 1 share = 8,500 ✓ in band... actually fits. Use 6,500: 1 share
    = 6,500 < min 7,000 and 2 = 13,000 > max → unbuyable gap."""
    ev = evaluate_buy(stock(price=6500), fresh_portfolio(), calm_market(), S)
    assert not ev.approved and ev.results[-1].rule_id == "R6"


# ── R8 daily limit ───────────────────────────────────────────────────────────

def test_r8_daily_cap_enforced():
    p = fresh_portfolio(invested_today=18_000)   # cap is 20,000; a ~9k buy busts it
    ev = evaluate_buy(stock(price=1500), p, calm_market(), S)
    assert not ev.approved and ev.results[-1].rule_id == "R8"


def test_r8_exactly_at_cap_allowed():
    p = fresh_portfolio(invested_today=11_000)   # 11k + 9k = 20k exactly
    ev = evaluate_buy(stock(price=1500), p, calm_market(), S)
    assert ev.approved


# ── Bucket capacity R2–R5 ────────────────────────────────────────────────────

def test_bucket_full_rejects():
    p = fresh_portfolio(bucket_deployed={"NIFTY50": 28_000})   # target 30k, room 2k
    ev = evaluate_buy(stock(price=1500), p, calm_market(), S)
    assert not ev.approved and ev.results[-1].rule_id == "R3"


def test_bucket_targets_match_rules():
    assert bucket_target("NIFTY50", 100_000, S) == 30_000
    assert bucket_target("NEXT100", 100_000, S) == 20_000
    assert bucket_target("SMALLCAP", 100_000, S) == 10_000
    assert bucket_target("GOLD_ETF", 100_000, S) == 10_000
    assert bucket_target("SILVER_ETF", 100_000, S) == 10_000


# ── R1 cash reserve ──────────────────────────────────────────────────────────

def test_r1_reserve_protected():
    p = fresh_portfolio(cash_balance=27_000)     # reserve 20k; 9k buy → 18k < 20k
    ev = evaluate_buy(stock(price=1500), p, calm_market(), S)
    assert not ev.approved and ev.results[-1].rule_id == "R1"


# ── R9 concentration ─────────────────────────────────────────────────────────

def test_r9_concentration_cap():
    p = fresh_portfolio(
        bucket_deployed={"NIFTY50": 27_000},
        sector_deployed={"IT": 18_000, "Banking & Finance": 9_000},
        cash_balance=73_000,
    )
    ev = evaluate_buy(stock(symbol="TCS.NS", segment="NEXT100", price=1500), p, calm_market(), S)
    # equity after = 36k, IT after = 27k → 75% > 35% cap
    assert not ev.approved and ev.results[-1].rule_id == "R9"


def test_r9_inactive_when_small():
    p = fresh_portfolio(bucket_deployed={"NIFTY50": 9_000}, sector_deployed={"IT": 9_000},
                        cash_balance=91_000)
    ev = evaluate_buy(stock(symbol="TCS.NS", segment="NEXT100", price=1500), p, calm_market(), S)
    assert ev.approved, "Concentration cap must not strangle a brand-new portfolio"


# ── Sell rules R13–R15 ───────────────────────────────────────────────────────

def test_r13_stop_loss_fires():
    ev = evaluate_sell("INFY.NS", avg_buy_price=1500, current_price=1370, s=S)  # −8.7%
    assert ev.should_sell and ev.triggered_rule == "R13" and ev.urgency == "IMMEDIATE"


def test_r13_not_at_minus_7pct():
    ev = evaluate_sell("INFY.NS", avg_buy_price=1500, current_price=1396, s=S)  # −6.9%
    assert not ev.should_sell


def test_r15_trailing_profit_fires():
    # bought 1000, peaked 1200 (+20%), now 1130 (gave back 5.8% from peak)
    ev = evaluate_sell("TITAN.NS", 1000, 1130, peak_price=1200, s=S)
    assert ev.should_sell and ev.triggered_rule == "R15"


def test_r15_not_armed_below_trigger():
    # peaked only +10% → trailing not armed even with giveback
    ev = evaluate_sell("TITAN.NS", 1000, 1040, peak_price=1100, s=S)
    assert not ev.should_sell


def test_r14_deterioration_fires_after_streak():
    ev = evaluate_sell("WIPRO.NS", 500, 505, low_score_streak=3, s=S)
    assert ev.should_sell and ev.triggered_rule == "R14" and ev.urgency == "REVIEW"


def test_r14_streak_too_short():
    ev = evaluate_sell("WIPRO.NS", 500, 505, low_score_streak=2, s=S)
    assert not ev.should_sell


def test_r13_beats_r14_priority():
    ev = evaluate_sell("X.NS", 1000, 900, low_score_streak=5, s=S)  # −10% AND deteriorated
    assert ev.triggered_rule == "R13", "Stop loss must take priority over deterioration"


def test_healthy_holding_no_sell():
    ev = evaluate_sell("HDFC.NS", 1000, 1080, peak_price=1090, low_score_streak=0, s=S)
    assert not ev.should_sell and "healthy" in ev.reason


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  ✓ {fn.__name__}")
    print(f"\n✅ All {len(fns)} rule tests passed — R1–R15 behave exactly as specified.")
