"""Core types for the rules engine.

Every rule returns a RuleResult — pass/fail, a plain-English reason, and a
severity. The engine and the UI's rule checklist both consume these directly,
so what you see on screen is literally what the engine decided on.

Severity levels:
    BLOCKER — stops ALL buying today (market-level guards R11/R12)
    FAIL    — this candidate is rejected, others may proceed
    WARNING — allowed but flagged
    PASS    — rule satisfied
"""
from dataclasses import dataclass, field
from enum import Enum


class Severity(str, Enum):
    BLOCKER = "BLOCKER"
    FAIL = "FAIL"
    WARNING = "WARNING"
    PASS = "PASS"


@dataclass
class RuleResult:
    rule_id: str          # "R6", "R11", "DUP", ...
    name: str
    passed: bool
    reason: str
    severity: Severity

    def to_dict(self) -> dict:
        return {
            "rule_id": self.rule_id, "name": self.name,
            "passed": self.passed, "reason": self.reason,
            "severity": self.severity.value,
        }


@dataclass
class BuyCandidate:
    """A stock/ETF the engine is considering buying today."""

    symbol: str
    segment: str              # NIFTY50 | NEXT100 | SMALLCAP | GOLD_ETF | SILVER_ETF
    sector: str
    price: float
    composite_score: float = 0.5
    is_etf: bool = False


@dataclass
class PortfolioState:
    """Snapshot of the portfolio at evaluation time. All values in ₹."""

    total_capital: float
    cash_balance: float
    invested_today: float = 0.0
    bucket_deployed: dict[str, float] = field(default_factory=dict)   # per segment
    sector_deployed: dict[str, float] = field(default_factory=dict)   # equity only
    held_symbols: set[str] = field(default_factory=set)

    @property
    def equity_deployed(self) -> float:
        """Total ₹ in stock buckets (excludes ETFs and cash)."""
        return sum(v for k, v in self.bucket_deployed.items()
                   if k in ("NIFTY50", "NEXT100", "SMALLCAP"))


@dataclass
class MarketState:
    """Today's market-level guard inputs."""

    nifty_fell: bool = False
    nifty_change_pct: float = 0.0
    guard_basis: str = "previous session close"
    market_stopped: bool = False          # R12 market-wide bad news
    bad_headline_count: int = 0
    blocked_sectors: set[str] = field(default_factory=set)   # R12 sector-specific
    weak_sectors: set[str] = field(default_factory=set)      # R10


@dataclass
class BuyEvaluation:
    """Outcome of running all buy-side rules on one candidate."""

    candidate: BuyCandidate
    approved: bool = False
    quantity: int = 0
    total_cost: float = 0.0
    results: list[RuleResult] = field(default_factory=list)

    @property
    def rules_passed(self) -> list[dict]:
        return [r.to_dict() for r in self.results if r.passed]

    @property
    def rules_failed(self) -> list[dict]:
        return [r.to_dict() for r in self.results if not r.passed]


@dataclass
class SellEvaluation:
    """Outcome of running sell rules on one holding."""

    symbol: str
    should_sell: bool = False
    triggered_rule: str | None = None
    reason: str = ""
    urgency: str = "NONE"     # IMMEDIATE (R13) | HIGH (R15) | REVIEW (R14) | NONE
