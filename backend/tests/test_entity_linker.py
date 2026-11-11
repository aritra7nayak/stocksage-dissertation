"""Entity linker vs. the substring baseline on the known failure cases.

These are the misattributions recorded in docs/DISSERTATION_AUDIT.md §3.3.
They form a regression set, not the E3 evaluation, which uses the annotated
corpus (research/eval_linking.py).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.nlp.entity_linker import EntityLinker, normalize
from app.nlp.substring_linker import SubstringLinker, name_key

COMPANIES = [
    ("TCS.NS", "Tata Consultancy Services"), ("TATASTEEL.NS", "Tata Steel"),
    ("TATAMOTORS.NS", "Tata Motors"), ("HDFCBANK.NS", "HDFC Bank"),
    ("HDFCLIFE.NS", "HDFC Life Insurance"), ("ADANIPORTS.NS", "Adani Ports & SEZ"),
    ("ADANIENT.NS", "Adani Enterprises"), ("BAJFINANCE.NS", "Bajaj Finance"),
    ("BAJAJFINSV.NS", "Bajaj Finserv"), ("SBIN.NS", "State Bank of India"),
    ("SBILIFE.NS", "SBI Life Insurance"), ("IOC.NS", "Indian Oil Corp"),
    ("POWERGRID.NS", "Power Grid Corp"), ("ITC.NS", "ITC"),
    ("SUNPHARMA.NS", "Sun Pharmaceutical"), ("INFY.NS", "Infosys"),
    ("LT.NS", "Larsen & Toubro"), ("DRREDDY.NS", "Dr. Reddy's Laboratories"),
    ("WIPRO.NS", "Wipro"), ("BSE.NS", "BSE Limited"),
]
LINKER = EntityLinker(COMPANIES)
BASE = SubstringLinker(COMPANIES)


def links(text):
    return LINKER.symbols(text)


def test_group_mention_is_not_attributed():
    r = LINKER.link("Tata group to invest Rs 1 lakh crore in semiconductors")
    assert r.symbols == set() and r.groups == ["tata"]
    assert len(BASE.symbols("Tata group to invest Rs 1 lakh crore")) == 3, "baseline over-links"


def test_specific_group_company():
    assert links("Tata Steel shares fall 3% after Q2 miss") == {"TATASTEEL.NS"}
    assert links("HDFC Bank, HDFC Life lead gains") == {"HDFCBANK.NS", "HDFCLIFE.NS"}
    assert links("Bajaj Finance slips after RBI action") == {"BAJFINANCE.NS"}
    assert links("Adani Ports traffic rises 8%") == {"ADANIPORTS.NS"}


def test_common_words_do_not_link():
    assert links("State elections: markets brace for volatility") == set()
    assert links("Purchasing power improves as inflation cools") == set()
    assert links("Indian equities extend rally") == set()
    assert "SBIN.NS" in BASE.symbols("State elections loom"), "baseline false match"


def test_word_boundaries():
    assert links("Switch to EVs gathers pace") == set()
    assert BASE.symbols("Switch to EVs gathers pace") == {"ITC.NS"}, "baseline substring hit"
    assert links("ITC hotels demerger approved") == {"ITC.NS"}


def test_press_short_forms():
    assert links("SBI hikes lending rates") == {"SBIN.NS"}
    assert links("SBI Life premiums jump") == {"SBILIFE.NS"}, "longest alias wins"
    assert links("L&T's order book crosses Rs 5 lakh crore") == {"LT.NS"}
    assert links("Sun Pharma gets USFDA nod") == {"SUNPHARMA.NS"}
    assert links("Dr Reddy's recalls bottles in US") == {"DRREDDY.NS"}
    assert links("TCS, Infosys and Wipro to report Q3") == {"TCS.NS", "INFY.NS", "WIPRO.NS"}


def test_exchange_name_is_not_the_listed_company():
    assert links("Sensex falls 500 points; BSE midcap index down 1%") == set()


def test_link_result_details():
    r = LINKER.link("Infosys and infosys again")
    assert len(r.links) == 1 and r.links[0].symbol == "INFY.NS"
    assert len(LINKER.candidates("Infosys and infosys again")) == 2


def test_normalize():
    assert normalize("L&T's Q2: profit UP 10%!") == "l&t q2 profit up 10"
    assert normalize("Dr. Reddy’s") == "dr reddy"


def test_baseline_unchanged():
    assert name_key("Tata Consultancy Services") == "tata"
    assert name_key("ITC") == "itc"
    assert name_key("State Bank of India") == "state"
