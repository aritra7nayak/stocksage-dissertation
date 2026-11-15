"""Research tab (annotation API): label rules, blindness for annotator B,
which rows show a pre-label, and export of saved labels to the corpus format.
No database: the endpoints' SQL is exercised in the live smoke test only."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from app import research_router as rr  # noqa: E402
from research import build_sample, prelabel, schema  # noqa: E402


def test_label_values_match_research_schema():
    assert rr.SENTIMENTS == schema.SENTIMENTS and rr.EVENT_TYPES == schema.EVENT_TYPES
    assert rr.SEVERITIES == schema.SEVERITIES and rr.SCOPES == schema.SCOPES
    assert rr.SECTORS == schema.SECTORS
    assert rr.PRELABEL_FIELDS == prelabel.FIELDS + ("companies", "sectors")
    for rec in ({"split": "train"}, {"split": "dev", "double_annotate": True}, {"split": "test"}):
        assert rr.eligible(rec) == prelabel.eligible(rec)


def _lab(**kw):
    base = dict(sentiment="Positive", events=["corporate_action"], severity="none", scope="company",
                companies=["tcs", "TCS.NS"], sectors=["IT"])
    return rr.LabelIn(**(base | kw))


def test_normalise_rules():
    lab, errs = rr.normalise(_lab())
    assert not errs and lab["companies"] == ["TCS.NS"] and lab["sentiment"] == "positive"
    assert rr.normalise(_lab(events=["other", "flows"]))[1]
    assert any("unlisted or foreign" in e for e in rr.normalise(_lab(companies=[]))[1])
    assert not rr.normalise(_lab(companies=[], scope="none"))[1]
    assert rr.normalise(_lab(sectors=["Auto"]))[1]
    assert rr.normalise(_lab(sentiment=""))[1]
    assert rr.normalise(_lab(companies=["none"]))[1]                   # "no company" is not a symbol
    assert rr.normalise(_lab(severity="medium"))[1]                    # good news has no severity
    assert not rr.normalise(_lab(sentiment="negative", severity="medium"))[1]


@pytest.fixture
def data(tmp_path, monkeypatch):
    recs = [{"id": f"h{i}", "headline": f"Company {i} wins a large order", "source": "s",
             "published_at": "2026-01-01T03:30:00+00:00",
             "split": "test" if i < 2 else "train", "double_annotate": i in (1, 2)} for i in range(5)]
    (tmp_path / "corpus").mkdir()
    (tmp_path / "annotation").mkdir()
    schema.write_jsonl(tmp_path / "corpus" / "sample.jsonl", recs)
    pre = [{"id": f"h{i}", "sentiment": "positive", "events": ["corporate_action"], "severity": "none",
            "scope": "company", "companies": ["TCS.NS"], "sectors": ["IT"], "model": "m"}
           for i in range(4)] + [{"id": "h4", "sentiment": "neutral", "events": ["other"],   # old 4-field row
                                  "severity": "none", "scope": "none", "model": "gemini"}]
    schema.write_jsonl(tmp_path / "annotation" / "prelabels.jsonl", pre)
    monkeypatch.setattr(rr.get_settings(), "research_data_dir", str(tmp_path))
    rr._cache.clear()
    return tmp_path


def test_queues_and_prefill(data):
    a, b = rr.queue("A"), rr.queue("B")
    assert len(a) == 5 and [r["id"] for r in b] == ["h1", "h2"]
    assert all(rr._prefill_for("A", r) for r in a)                 # v1.2: every row, both roles
    assert all(rr._prefill_for("B", r) for r in b)
    full = rr._prefill_for("A", a[0])
    assert full["companies"] == ["TCS.NS"] and full["sectors"] == ["IT"] and full["model"] == "m"
    old = rr._prefill_for("A", a[4])                               # 4-field Gemini row
    assert old["companies"] == [] and old["sectors"] == []
    assert "split" not in rr._public(a[0])           # annotators do not see the split


def test_needs_review_is_test_for_a_and_double_for_b(data):
    a, b = rr.queue("A"), rr.queue("B")
    assert [r["id"] for r in a if rr.needs_review("A", r)] == ["h0", "h1"]      # the test split
    assert all(rr.needs_review("B", r) for r in b)                               # all of B's rows


def test_b_subset_replaces_double_subset(data):
    sample, out = data / "corpus" / "sample.jsonl", data / "annotation" / "b_subset.json"
    doc = build_sample.draw_b_subset(sample, out, n=1, seed=3)
    assert doc["ids"][0] in {"h0", "h1"} and doc["split"] == "test"          # only test rows
    assert build_sample.draw_b_subset.__doc__ and out.exists()
    with pytest.raises(SystemExit, match="exists"):
        build_sample.draw_b_subset(sample, out, n=1, seed=3)                  # never redrawn silently
    rr._cache.clear()
    assert [r["id"] for r in rr.queue("B")] == doc["ids"]
    row = {"sentiment": "neutral", "events": ["other"], "severity": "none", "scope": "none",
           "companies": [], "sectors": [], "notes": None, "prelabel": None}
    assert build_sample.labels_to_records([row | {"item_id": doc["ids"][0]}], "B", sample)
    with pytest.raises(schema.SchemaError, match="outside"):
        build_sample.labels_to_records([row | {"item_id": "h2"}], "B", sample)   # old double row


def test_item_payload_and_cached_table(data):
    rows, table = rr.queue("A"), rr._prelabels()
    assert rr._prelabels() is table                  # parsed once, reused until the file changes
    done = {"h1": {"prelabel": None, "sentiment": "neutral", "events": ["other"], "severity": "none",
                   "scope": "none", "companies": [], "sectors": [], "notes": None}}
    p = rr._item_payload("A", rows, 0, done, table)
    assert p["item"]["id"] == "h0" and p["next_todo_id"] == "h2"     # h1 is done
    assert p["prelabel"]["companies"] == ["TCS.NS"] and p["label"] is None
    saved = rr._item_payload("A", rows, 1, done, table)
    assert saved["label"]["sentiment"] == "neutral" and saved["prelabel"] is None


def test_assemble_gold_silver_never_in_test(data, capsys):
    sample = data / "corpus" / "sample.jsonl"
    pre_path = data / "annotation" / "prelabels.jsonl"
    human = [{"id": "h3", "split": "train", "headline": "Company 3 wins a large order", "origin": "human_verified",
              "sentiment": "neutral"}]
    gold = {r["id"]: r for r in build_sample.assemble_gold(human, sample, pre_path)}
    assert "h0" not in gold and "h1" not in gold                 # test rows: human only
    assert gold["h3"]["sentiment"] == "neutral"                  # human beats silver
    assert gold["h2"]["origin"] == "llm_prelabel" and gold["h2"]["annotator"] == "LLM"
    assert set(build_sample.assemble_gold(human, sample, pre_path, silver=False)[0]) == set(human[0])
    assert '"llm_prelabel"' in capsys.readouterr().out


def test_labels_to_records(data):
    sample = data / "corpus" / "sample.jsonl"
    row = {"sentiment": "positive", "events": ["corporate_action"], "severity": "none",
           "scope": "company", "companies": ["TCS.NS"], "sectors": ["IT"], "notes": None}
    pre = {"sentiment": "neutral", "events": ["corporate_action"], "severity": "none", "scope": "company"}
    recs = build_sample.labels_to_records(
        [row | {"item_id": "h0", "prelabel": None}, row | {"item_id": "h3", "prelabel": pre}], "A", sample)
    by = {r["id"]: r for r in recs}
    assert by["h0"]["origin"] == "human" and by["h3"]["origin"] == "human_verified"
    assert by["h0"]["split"] == "test" and not schema.validate(by["h3"])
    with pytest.raises(schema.SchemaError, match="outside the double subset"):
        build_sample.labels_to_records([row | {"item_id": "h4", "prelabel": None}], "B", sample)
    b = build_sample.labels_to_records([row | {"item_id": "h1", "prelabel": pre}], "B", sample)
    assert b[0]["origin"] == "human_verified" and b[0]["split"] == "test"   # pre-filled test row (v1.2)
    with pytest.raises(schema.SchemaError, match="unknown sectors"):
        build_sample.labels_to_records([row | {"item_id": "h3", "prelabel": None, "sectors": ["Auto"]}],
                                       "A", sample)
    assert json.dumps(recs)                          # serialisable as written to JSONL
