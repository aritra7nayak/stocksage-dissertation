"""Baseline headline → company matcher (the pre-dissertation behaviour).

Kept unchanged, in one place, so experiment E3 can compare it with
entity_linker on the same gold set. It takes the first "distinctive" word of
the company name and looks for it as a plain substring of the headline, which
is why "Tata" headlines hit every Tata company and "state" matches
"statement". Do not use it for new features.
"""
from collections.abc import Iterable


def name_key(company: str) -> str:
    """First distinctive word of a company name, for headline matching."""
    for w in (company or "").split():
        w2 = "".join(ch for ch in w if ch.isalnum()).lower()
        if len(w2) >= 4 and w2 not in ("india", "limited", "corp"):
            return w2
    return (company or "").lower()[:6]


class SubstringLinker:
    def __init__(self, companies: Iterable[tuple[str, str]]):
        self._keys = [(symbol, name_key(name or symbol)) for symbol, name in companies]

    def symbols(self, text: str) -> set[str]:
        low = (text or "").lower()
        return {symbol for symbol, key in self._keys if key and key in low}
