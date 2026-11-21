"""Assistant knowledge base: note chunking, BM25 ranking, and that real
concept questions find the right section of the shipped notes."""
from app.assistant import knowledge
from app.assistant.knowledge import BM25, Chunk, KnowledgeBase, load_notes


def test_bm25_prefers_rare_matching_terms():
    docs = [["option", "theta", "decay"], ["option", "delta"], ["stock", "dividend"]]
    s = BM25(docs).scores(["theta"])
    assert s[0] > 0 and s[1] == s[2] == 0


def test_notes_split_by_section_with_sources():
    chunks = load_notes()
    titles = {c.title for c in chunks}
    assert {"RSI (Relative Strength Index)", "Bull call spread", "Debt to equity"} <= titles
    assert all(c.text and c.source.startswith("note: ") for c in chunks)


def test_concept_questions_find_the_right_note():
    kb = KnowledgeBase(load_notes())                  # notes only: deterministic, no PDFs needed
    cases = {"what is a golden cross": "Golden cross and death cross",
             "is RSI above 70 overbought": "RSI (Relative Strength Index)",
             "how does a bull call spread work": "Bull call spread",
             "tax on long term capital gains": "Taxes on equity (as of the July 2024 Union Budget)",
             "what is india vix": "India VIX",
             "how big should my position be": "Position sizing"}
    for q, title in cases.items():
        assert kb.search(q, 1)[0]["title"] == title, q


def test_empty_and_unmatched_queries():
    kb = KnowledgeBase([Chunk("a", "Alpha", "note: x", "alpha beta")])
    assert kb.search("") == [] and kb.search("the and of") == []      # stopwords only
    assert kb.search("zzzz") == []


def test_tokens_fold_plurals():
    assert knowledge._tokens("Calls and Options") == ["call", "option"]
