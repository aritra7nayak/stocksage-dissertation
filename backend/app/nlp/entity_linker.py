"""Headline → NSE company linking with an alias table and explicit ambiguity.

Replaces the substring matcher (see substring_linker.py). Three ideas:

1. Every alias is matched on word boundaries, longest first, without
   overlaps, so "HDFC Bank" is consumed before "HDFC" is ever considered and
   "ITC" can no longer match inside "switch".
2. Aliases come from three places, in decreasing confidence:
   - a curated table (CURATED_ALIASES): short forms the press actually uses
     ("SBI", "L&T", "RIL", "HUL");
   - the normalised full company name ("tata consultancy services");
   - the bare ticker root and the first word of the name, but only when that
     word belongs to exactly one company in the catalogue and is not a common
     English or market word (BLOCKED_ALIASES).
3. A word shared by several companies ("Tata", "Adani", "HDFC", "Bajaj") is a
   group mention. It is reported in `groups`, never attributed to a company.
   Attributing group news to every member was the baseline's main error.

The linker is pure (no I/O). `service.get_linker` builds it from the database.
A learned disambiguation step can later re-rank `candidates()`; `link()` is
the rule-based decision used today.
"""
import re
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass

# Confidence by alias origin; also the tie-break when one symbol has several hits.
CONF_CURATED = 1.0
CONF_FULL_NAME = 0.95
CONF_TICKER = 0.9
CONF_FIRST_WORD = 0.8

_SUFFIXES = {"limited", "ltd", "corp", "corporation", "company", "co", "inc", "plc"}

# Words that must never become an alias on their own, even when only one
# company uses them: they are ordinary English, market vocabulary, places, or
# names of a better-known non-listed entity (Oracle Corp, Reliance Jio, LIC).
BLOCKED_ALIASES = {
    "amber", "angel", "apollo", "asian", "avenue", "bank", "bharat", "bse", "central",
    "city", "coal", "container", "cub", "federal", "fine", "first", "granules", "gujarat",
    "happiest", "hero", "hindustan", "india", "indian", "info", "intellect", "jio", "lic",
    "mankind", "max", "mcx", "multi", "national", "natural", "nippon", "oil", "one",
    "oracle", "page", "persistent", "power", "punjab", "rites", "sail", "shree", "state",
    "steel", "supreme", "tech", "torrent", "union", "united",
}

# Short forms used by the Indian financial press. Keys are NSE symbols.
CURATED_ALIASES: dict[str, list[str]] = {
    "RELIANCE.NS": ["reliance", "ril", "reliance industries"],
    "TCS.NS": ["tcs", "tata consultancy"],
    "HDFCBANK.NS": ["hdfc bank"],
    "INFY.NS": ["infosys", "infy"],
    "BHARTIARTL.NS": ["airtel", "bharti airtel"],
    "SBIN.NS": ["sbi", "state bank", "state bank of india"],
    "LT.NS": ["l&t", "larsen", "larsen and toubro"],
    "HCLTECH.NS": ["hcl tech", "hcl technologies", "hcl"],
    "BAJFINANCE.NS": ["bajaj finance"],
    "BAJAJFINSV.NS": ["bajaj finserv"],
    "BAJAJ-AUTO.NS": ["bajaj auto"],
    "KOTAKBANK.NS": ["kotak", "kotak bank", "kotak mahindra bank"],
    "MARUTI.NS": ["maruti", "maruti suzuki"],
    "SUNPHARMA.NS": ["sun pharma", "sun pharmaceutical"],
    "ULTRACEMCO.NS": ["ultratech"],
    "ONGC.NS": ["ongc", "oil and natural gas"],
    "TATAMOTORS.NS": ["tata motors"],
    "TATASTEEL.NS": ["tata steel"],
    "TATAPOWER.NS": ["tata power"],
    "TATACONSUM.NS": ["tata consumer"],
    "TATACOMM.NS": ["tata communications", "tata comm"],
    "TATAELXSI.NS": ["tata elxsi"],
    "M&M.NS": ["m&m", "mahindra and mahindra"],
    "TECHM.NS": ["tech mahindra", "techm"],
    "POWERGRID.NS": ["power grid corp", "power grid corporation", "powergrid"],
    "ADANIENT.NS": ["adani enterprises"],
    "ADANIPORTS.NS": ["adani ports", "apsez"],
    "ADANIPOWER.NS": ["adani power"],
    "ADANIGREEN.NS": ["adani green"],
    "ADANIENSOL.NS": ["adani energy solutions", "adani transmission"],
    "COALINDIA.NS": ["coal india"],
    "DRREDDY.NS": ["dr reddy", "dr reddys"],
    "DIVISLAB.NS": ["divis", "divis labs", "divis laboratories"],
    "HINDUNILVR.NS": ["hul", "hindustan unilever"],
    "BPCL.NS": ["bpcl", "bharat petroleum"],
    "HINDPETRO.NS": ["hpcl", "hindustan petroleum"],
    "IOC.NS": ["ioc", "indian oil corp", "indian oil corporation", "indianoil"],
    "BEL.NS": ["bel", "bharat electronics"],
    "BHEL.NS": ["bhel", "bharat heavy electricals"],
    "HAL.NS": ["hal", "hindustan aeronautics"],
    "SAIL.NS": ["steel authority of india"],
    "LTIM.NS": ["ltimindtree", "lti mindtree"],
    "LTTS.NS": ["ltts", "l&t technology services", "l&t tech"],
    "JIOFIN.NS": ["jio financial", "jio financial services", "jfsl"],
    "PNB.NS": ["pnb", "punjab national bank"],
    "BANKBARODA.NS": ["bank of baroda"],
    "UNIONBANK.NS": ["union bank", "union bank of india"],
    "FEDERALBNK.NS": ["federal bank"],
    "IDFCFIRSTB.NS": ["idfc first", "idfc first bank"],
    "AUBANK.NS": ["au small finance", "au bank"],
    "ICICIBANK.NS": ["icici bank"],
    "ICICIPRULI.NS": ["icici prudential", "icici pru"],
    "ICICIGI.NS": ["icici lombard"],
    "SBICARD.NS": ["sbi card", "sbi cards"],
    "SBILIFE.NS": ["sbi life"],
    "HDFCLIFE.NS": ["hdfc life"],
    "HDFCAMC.NS": ["hdfc amc", "hdfc asset management"],
    "PFC.NS": ["pfc", "power finance corp", "power finance corporation"],
    "RECLTD.NS": ["rec", "rec ltd", "rec limited"],
    "BSE.NS": ["bse ltd", "bse limited", "bse shares"],
    "MCX.NS": ["multi commodity exchange", "mcx shares"],
    "LICHSGFIN.NS": ["lic housing", "lic housing finance"],
    "INDIGO.NS": ["indigo", "interglobe"],
    "DMART.NS": ["dmart", "d mart", "avenue supermarts"],
    "NAUKRI.NS": ["info edge", "naukri"],
    "POLICYBZR.NS": ["policybazaar", "pb fintech"],
    "PAYTM.NS": ["paytm", "one97"],
    "CONCOR.NS": ["concor", "container corporation"],
    "HEROMOTOCO.NS": ["hero motocorp", "hero moto"],
    "COLPAL.NS": ["colgate", "colgate palmolive"],
    "UNITDSPR.NS": ["united spirits", "diageo india"],
    "VBL.NS": ["varun beverages"],
    "GODREJCP.NS": ["godrej consumer"],
    "GODREJPROP.NS": ["godrej properties"],
    "LODHA.NS": ["lodha", "macrotech"],
    "MOTHERSON.NS": ["motherson", "samvardhana motherson"],
    "JINDALSTEL.NS": ["jindal steel"],
    "JSWSTEEL.NS": ["jsw steel"],
    "JSWENERGY.NS": ["jsw energy"],
    "MAPMYINDIA.NS": ["mapmyindia", "ce info systems"],
    "OFSS.NS": ["oracle financial services", "ofss"],
    "APOLLOHOSP.NS": ["apollo hospitals"],
    "APLAPOLLO.NS": ["apl apollo"],
    "MAXHEALTH.NS": ["max healthcare"],
    "CHOLAFIN.NS": ["chola", "cholamandalam"],
    "CGPOWER.NS": ["cg power"],
    "JBCHEPHARM.NS": ["jb chemicals", "jb pharma"],
    "CAPLIPOINT.NS": ["caplin point"],
    "CREDITACC.NS": ["creditaccess", "creditaccess grameen"],
    "TVSMOTOR.NS": ["tvs motor"],
    "ASHOKLEY.NS": ["ashok leyland"],
    "EICHERMOT.NS": ["eicher", "royal enfield"],
    "NESTLEIND.NS": ["nestle india"],
    "ASIANPAINT.NS": ["asian paints"],
    "CUB.NS": ["city union bank"],
    "RITES.NS": ["rites ltd", "rites limited"],
    "TORNTPHARM.NS": ["torrent pharma", "torrent pharmaceuticals"],
    "GRANULES.NS": ["granules india"],
    "PERSISTENT.NS": ["persistent systems"],
    "INTELLECT.NS": ["intellect design"],
    "HAPPSTMNDS.NS": ["happiest minds"],
    "MANKIND.NS": ["mankind pharma"],
    "AMBER.NS": ["amber enterprises"],
}

_APOSTROPHE_S = re.compile(r"['’]s\b")
_NON_WORD = re.compile(r"[^a-z0-9&]+")


def normalize(text: str) -> str:
    """Lower-case, drop possessive 's, keep '&' (L&T, M&M), collapse the rest."""
    low = _APOSTROPHE_S.sub("", (text or "").lower())
    low = low.replace("'", "").replace("’", "")
    return " ".join(_NON_WORD.sub(" ", low).split())


def _name_tokens(company: str) -> list[str]:
    tokens = normalize(company).split()
    while tokens and tokens[-1] in _SUFFIXES:
        tokens.pop()
    return tokens


@dataclass(frozen=True)
class EntityLink:
    symbol: str
    alias: str          # the alias that matched (normalised form)
    start: int          # character offsets in the normalised headline
    end: int
    confidence: float
    origin: str         # curated | full_name | ticker | first_word


@dataclass(frozen=True)
class LinkResult:
    links: list[EntityLink]
    groups: list[str]   # ambiguous group words seen in the headline ("tata")

    @property
    def symbols(self) -> set[str]:
        return {link.symbol for link in self.links}


class EntityLinker:
    def __init__(self, companies: Iterable[tuple[str, str]],
                 extra_catalogue: Iterable[tuple[str, str]] = (),
                 curated: dict[str, list[str]] | None = None,
                 blocked: set[str] | None = None):
        """companies: (symbol, name) pairs that can be linked to.
        extra_catalogue: further (symbol, name) pairs, e.g. the full NSE list,
        used only to decide which words are ambiguous."""
        curated = CURATED_ALIASES if curated is None else curated
        blocked = BLOCKED_ALIASES if blocked is None else blocked
        companies = [(s, n or s.replace(".NS", "")) for s, n in companies]
        linkable = {s for s, _ in companies}

        # Which symbols use each first word, across the whole catalogue.
        first_word_users: dict[str, set[str]] = defaultdict(set)
        for symbol, name in [*companies, *extra_catalogue]:
            tokens = _name_tokens(name or "")
            if tokens:
                first_word_users[tokens[0]].add(symbol)

        # alias -> {symbol: (confidence, origin)}
        table: dict[str, dict[str, tuple[float, str]]] = defaultdict(dict)

        def add(alias: str, symbol: str, conf: float, origin: str) -> None:
            alias = normalize(alias)
            if not alias:
                return
            prev = table[alias].get(symbol)
            if prev is None or conf > prev[0]:
                table[alias][symbol] = (conf, origin)

        for symbol, name in companies:
            tokens = _name_tokens(name)
            if len(tokens) >= 2:
                add(" ".join(tokens), symbol, CONF_FULL_NAME, "full_name")
            root = normalize(symbol.removesuffix(".NS").replace("-", " "))
            if len(root.replace(" ", "")) >= 3 and root not in blocked:
                add(root, symbol, CONF_TICKER, "ticker")
            if tokens:
                first = tokens[0]
                if (len(first) >= 4 and first not in blocked
                        and first_word_users[first] == {symbol}):
                    add(first, symbol, CONF_FIRST_WORD, "first_word")
        for symbol, aliases in curated.items():
            if symbol in linkable:
                for alias in aliases:
                    add(alias, symbol, CONF_CURATED, "curated")

        # Curated entries settle ambiguity; any other alias shared by two
        # symbols is dropped.
        self._alias_to: dict[str, tuple[str, float, str]] = {}
        for alias, owners in table.items():
            curated_owners = [s for s, (_, o) in owners.items() if o == "curated"]
            if len(curated_owners) == 1:
                s = curated_owners[0]
                self._alias_to[alias] = (s, *owners[s])
            elif len(owners) == 1:
                s, (conf, origin) = next(iter(owners.items()))
                self._alias_to[alias] = (s, conf, origin)

        self._groups = {w for w, users in first_word_users.items()
                        if len(users) > 1 and len(w) >= 3 and w not in blocked
                        and w not in self._alias_to}

        alternation = "|".join(re.escape(a) for a in
                               sorted(self._alias_to, key=len, reverse=True))
        self._pattern = re.compile(rf"(?<![a-z0-9&])(?:{alternation})(?![a-z0-9&])") \
            if alternation else None
        self._group_pattern = re.compile(
            r"(?<![a-z0-9&])(?:" + "|".join(re.escape(g) for g in sorted(self._groups)) +
            r")(?![a-z0-9&])") if self._groups else None

    @property
    def aliases(self) -> dict[str, tuple[str, float, str]]:
        return dict(self._alias_to)

    def candidates(self, text: str) -> list[EntityLink]:
        """Every alias occurrence, in headline order (a symbol may repeat)."""
        norm = normalize(text)
        if not self._pattern:
            return []
        out = []
        for m in self._pattern.finditer(norm):
            symbol, conf, origin = self._alias_to[m.group(0)]
            out.append(EntityLink(symbol, m.group(0), m.start(), m.end(), conf, origin))
        return out

    def link(self, text: str) -> LinkResult:
        best: dict[str, EntityLink] = {}
        for c in self.candidates(text):
            if c.symbol not in best or c.confidence > best[c.symbol].confidence:
                best[c.symbol] = c
        norm = normalize(text)
        linked_spans = [(c.start, c.end) for c in best.values()]
        groups = []
        if self._group_pattern:
            for m in self._group_pattern.finditer(norm):
                inside = any(s <= m.start() and m.end() <= e for s, e in linked_spans)
                if not inside and m.group(0) not in groups:
                    groups.append(m.group(0))
        return LinkResult(sorted(best.values(), key=lambda link: link.start), groups)

    def symbols(self, text: str) -> set[str]:
        return self.link(text).symbols
