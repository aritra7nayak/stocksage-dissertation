"""India-specific bad-news classification — pure logic, no model required.

This is the deterministic half of R12. FinBERT (finbert.py) provides the
sentiment half; this module provides severity and sector attribution that a
US-trained model misses (SEBI actions, RBI surprises, GST shocks, FII flows).

Severity scale 0–10:
    >= 6  SEVERE   — eligible for R12 blocks
    4–5   BAD      — negative, logged, drags sector sentiment
    < 4   ordinary

v2 REDESIGN (fixes the false-positive market halts):
  1. WORD-BOUNDARY matching. The old substring check made "war" match
     'soFTWARe', 'WARns', 'aWARds', 'toWARd' — severity 9 on routine
     headlines, halting the market on perfectly calm days.
  2. SYSTEMIC vs COMPANY keywords. Only *systemic* events (crash, war,
     circuit breaker, sovereign downgrade…) can stop the whole market.
     Company-level damage (fraud, plunges, default…) hurts that stock's
     sector at most — never the entire market.
  3. MARKET-SCOPE promotion. A company-grade word in a clearly market-wide
     headline ("SENSEX plunges 900 points") IS systemic — detected via
     index/market terms, so real crashes still trip the halt.
  4. EVIDENCE. Every guard verdict carries the exact headlines + keywords
     that triggered it, so a RED day is always auditable in the UI.
"""
import hashlib
import re
from dataclasses import dataclass, field

# ── Systemic shocks: eligible to stop the ENTIRE market ─────────────────────
SYSTEMIC_KEYWORDS: dict[str, float] = {
    "circuit breaker": 10, "trading halted": 10, "market crash": 10,
    "market meltdown": 9, "bloodbath on dalal street": 9, "black monday": 9,
    "war": 9, "invasion": 9, "missile": 9, "air strike": 9, "airstrike": 9,
    "terror attack": 10, "nuclear": 9, "emergency declared": 10,
    "pandemic": 9, "lockdown": 9, "curfew": 8,
    "sovereign downgrade": 9, "rupee collapses": 9, "rupee crashes": 9,
    "gdp contracts": 7, "recession": 6, "recession fears": 6,
    "fii sell-off": 6, "fii selloff": 6, "fiis pull out": 6,
    "sanctions": 6, "trade war": 6,
}

# ── Company/sector-level damage: NEVER stops the whole market ────────────────
COMPANY_KEYWORDS: dict[str, float] = {
    # 7–8: serious company/regulatory damage
    "sebi bars": 8, "sebi bans": 8, "sebi crackdown": 8, "sebi probe": 7, "sebi order": 7,
    "fraud": 8, "scam": 8, "money laundering": 8, "ed raids": 7, "cbi probe": 7,
    "default": 8, "defaults": 8, "bankruptcy": 8, "insolvency": 8, "nclt": 7,
    "rating downgrade": 7, "downgraded to junk": 8, "auditor resigns": 8,
    "crashes": 8, "plunges": 7, "plummets": 7, "tanks": 7, "sinks": 7, "nosedives": 7,
    "rbi restricts": 8, "rbi penalty": 7, "license cancelled": 8, "promoter pledge": 6,
    "shuts down": 6, "mass layoffs": 6, "bloodbath": 7,
    # 5–6: macro pressure (sector-level drag, not a halt)
    "rbi hikes": 6, "rate hike": 5, "repo rate raised": 6, "inflation surges": 6,
    "foreign outflows": 5, "tariff": 5, "crude surges": 5, "oil spikes": 5,
    "slowdown deepens": 5, "gst hike": 5, "windfall tax": 5,
    "sell-off": 5, "selloff": 5, "layoffs": 5, "strike": 4,
    # 3–4: routine negative
    "misses estimates": 4, "profit falls": 4, "profit drops": 4, "loss widens": 5,
    "weak guidance": 4, "downgrade": 4, "cuts target": 3, "margin pressure": 3,
    "slips": 3, "declines": 3, "falls": 3, "drops": 3,
}

# Headline is about the MARKET (not one company) if it mentions any of these.
MARKET_SCOPE_TERMS: tuple = (
    "sensex", "nifty", "dalal street", "d-street", "stock market", "equity market",
    "markets", "indices", "benchmark", "broader market", "midcap index", "smallcap index",
)

# Pre-compiled word-boundary patterns (built once at import).
def _compile(words: dict[str, float]) -> list[tuple[re.Pattern, str, float]]:
    out = []
    for kw, sev in words.items():
        out.append((re.compile(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])"), kw, sev))
    return out

_SYSTEMIC = _compile(SYSTEMIC_KEYWORDS)
_COMPANY = _compile(COMPANY_KEYWORDS)
_MARKET_SCOPE = [re.compile(r"(?<![a-z0-9])" + re.escape(t) + r"(?![a-z0-9])")
                 for t in MARKET_SCOPE_TERMS]

SECTOR_KEYWORDS: dict[str, list[str]] = {
    "IT": ["it sector", "software", "infosys", "tcs", "wipro", "hcl", "tech mahindra",
           "it services", "nasscom", "h-1b", "tech stocks", "ltimindtree"],
    "Banking & Finance": ["bank", "banking", "rbi", "nbfc", "hdfc", "icici", "sbi", "axis",
                          "kotak", "lender", "npa", "credit growth", "insurance", "mutual fund",
                          "psu bank", "repo rate", "finance company"],
    "Pharma & Healthcare": ["pharma", "drug", "usfda", "fda", "hospital", "healthcare",
                            "vaccine", "api maker", "sun pharma", "cipla", "biocon"],
    "Oil & Gas": ["crude", "oil", "opec", "brent", "ongc", "refinery", "petroleum",
                  "natural gas", "lng", "reliance industries"],
    "Metal": ["steel", "metal", "copper", "aluminium", "iron ore", "zinc", "tata steel",
              "jsw", "hindalco", "vedanta", "mining"],
    "Energy & Power": ["power", "electricity", "coal", "renewable", "solar", "wind energy",
                       "ntpc", "discom", "grid", "adani power", "thermal"],
    "Manufacturing": ["auto", "automobile", "cement", "manufacturing", "capex", "defence",
                      "maruti", "tata motors", "mahindra", "l&t", "construction", "infra",
                      "chemicals", "ev maker", "two-wheeler"],
    "FMCG": ["fmcg", "consumer goods", "hindustan unilever", "itc", "nestle", "britannia",
             "dabur", "staples", "rural demand"],
    "Services": ["airline", "aviation", "telecom", "airtel", "jio", "retail", "real estate",
                 "realty", "e-commerce", "logistics", "hotel", "railways", "port"],
}
_SECTOR = {sec: [re.compile(r"(?<![a-z0-9])" + re.escape(k) + r"(?![a-z0-9])") for k in kws]
           for sec, kws in SECTOR_KEYWORDS.items()}


@dataclass
class HeadlineClassification:
    headline: str
    severity: float = 0.0
    matched_keywords: list[str] = field(default_factory=list)
    sectors: list[str] = field(default_factory=list)
    is_severe: bool = False     # severity >= 6
    is_bad: bool = False        # severity >= 4
    is_systemic: bool = False   # market-halt eligible (systemic kw, or severe + market-scoped)


# Benign phrases that contain scary words — neutralized before matching so
# "think tanks", "price war", "bidding war" never register as events.
_BENIGN = [
    (re.compile(r"think[- ]tanks?"), "policy institutes"),
    (re.compile(r"price wars?"), "price competition"),
    (re.compile(r"bidding wars?"), "bidding contest"),
    (re.compile(r"war of words"), "spat"),
    (re.compile(r"war chest"), "cash reserves"),
    (re.compile(r"post[- ]war"), "post-conflict-era"),
]


def classify_headline(headline: str) -> HeadlineClassification:
    """Score one headline's severity, scope, and sectors. Pure, deterministic."""
    text = re.sub(r"\s+", " ", headline.lower())
    for pat, repl in _BENIGN:
        text = pat.sub(repl, text)
    c = HeadlineClassification(headline=headline)

    for pat, kw, sev in _SYSTEMIC:
        if pat.search(text):
            c.matched_keywords.append(kw)
            c.severity = max(c.severity, sev)
            c.is_systemic = True

    for pat, kw, sev in _COMPANY:
        if pat.search(text):
            c.matched_keywords.append(kw)
            c.severity = max(c.severity, sev)

    for sector, pats in _SECTOR.items():
        if any(p.search(text) for p in pats):
            c.sectors.append(sector)

    c.is_severe = c.severity >= 6
    c.is_bad = c.severity >= 4

    # Market-scope promotion: a severe company-grade event described at
    # market level ("Sensex plunges 900 points") is systemic.
    if c.is_severe and not c.is_systemic:
        if any(p.search(text) for p in _MARKET_SCOPE):
            c.is_systemic = True
            c.matched_keywords.append("market-scope")

    return c


def combine_with_sentiment(c: HeadlineClassification, sentiment: str,
                           sentiment_score: float) -> HeadlineClassification:
    """Merge FinBERT's verdict into the keyword classification.

    A strongly negative FinBERT score lifts a borderline headline into 'bad'
    (sector-level drag) even when no keyword matched. It can NEVER make a
    headline systemic — language models react to scary words, not scope —
    and positive sentiment never downgrades a keyword-severe headline.
    """
    if sentiment == "NEGATIVE" and sentiment_score <= -0.6 and c.severity < 4:
        c.severity = max(c.severity, 4.0)
        c.is_bad = True
        c.matched_keywords.append("finbert:strong-negative")
    return c


def market_guard_from_today(classifications: list[HeadlineClassification],
                            severe_limit: int) -> dict:
    """R12 aggregation over today's classified headlines.

    market_stopped : more than `severe_limit` SYSTEMIC severe headlines.
                     Company-level bad news can never halt the market.
    blocked_sectors: any sector tagged on >= 2 severe headlines (company-level
                     damage concentrated in one sector pauses that sector).
    evidence       : the exact headlines + keywords behind each decision.
    """
    severe = [c for c in classifications if c.is_severe]
    systemic = [c for c in severe if c.is_systemic]

    sector_severe_counts: dict[str, int] = {}
    for c in severe:
        for sec in c.sectors:
            sector_severe_counts[sec] = sector_severe_counts.get(sec, 0) + 1
    blocked = {sec for sec, n in sector_severe_counts.items() if n >= 2}

    def _ev(c: HeadlineClassification) -> dict:
        return {"headline": c.headline, "severity": c.severity,
                "keywords": c.matched_keywords[:6], "systemic": c.is_systemic,
                "sectors": c.sectors}

    return {
        "severe_count": len(severe),
        "systemic_count": len(systemic),
        "market_stopped": len(systemic) > severe_limit,
        "blocked_sectors": sorted(blocked),
        "severe_headlines": [c.headline for c in severe][:10],
        "evidence": [_ev(c) for c in (systemic if systemic else severe)][:10],
    }


def url_hash(url: str, headline: str) -> str:
    """Stable dedup key — RSS feeds repeat items across fetches."""
    return hashlib.sha256(f"{url}|{headline}".encode()).hexdigest()[:64]
