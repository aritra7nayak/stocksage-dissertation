"""LLM pre-labelling: which rows are eligible, validation of model output,
resume after a quota stop, and prefill -> review -> import on synthetic data.
No network: the model is a fake callable."""
import csv
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "backend"))

from research import build_sample, prelabel, schema


def _sample(tmp_path):
    recs = []
    for i in range(12):
        recs.append({"id": f"h{i}", "headline": f"Company {i} reports quarterly profit growth",
                     "source": "src", "published_at": "2026-10-01T09:00:00+05:30",
                     "split": "test" if i < 3 else "dev" if i < 5 else "train",
                     "double_annotate": i in (5, 6)})
    path = tmp_path / "sample.jsonl"
    schema.write_jsonl(path, recs)
    build_sample.write_sheet(tmp_path / "sheet_a.csv", recs)
    return path


def _fake(calls, fail_after=None):
    def call(system, user):
        if fail_after is not None and len(calls) >= fail_after:
            raise prelabel.QuotaExhausted("per day")
        items = json.loads(user)
        calls.append([it["id"] for it in items])
        out = [{"id": it["id"], "sentiment": "positive", "events": ["earnings_guidance"],
                "severity": "none", "scope": "company"} for it in items]
        out[0]["sentiment"] = "bullish"                     # invalid -> rejected
        return json.dumps(out), "fake-model-001"
    return call


def test_eligible_is_every_row():                       # guidelines v1.2
    for rec in ({"split": "train"}, {"split": "dev", "double_annotate": True}, {"split": "test"}):
        assert prelabel.eligible(rec)
    assert not prelabel.eligible({"split": None})


def test_clean_validates_and_normalises():
    ok = prelabel.clean({"sentiment": "Negative", "events": "fraud_default",
                         "severity": "HIGH", "scope": "company"})
    assert ok == {"sentiment": "negative", "events": ["fraud_default"],
                  "severity": "high", "scope": "company"}
    mixed = prelabel.clean({"sentiment": "neutral", "events": ["other", "flows"],
                            "severity": "none", "scope": "market"})
    assert mixed["events"] == ["flows"]
    assert prelabel.clean({"sentiment": "bullish", "events": ["other"],
                           "severity": "none", "scope": "market"}) is None


def test_prompt_is_the_guidelines():
    p = prelabel.build_prompt()
    assert "Use the holder's view, not the verb" in p
    assert "## 5. Companies" not in p and "regulatory_action" in p


def test_run_resumes_after_quota_stop(tmp_path):
    sample, out = _sample(tmp_path), tmp_path / "pre.jsonl"
    calls = []
    s1 = prelabel.run(sample, out, _fake(calls, fail_after=1), batch=3, rpm=1e9, limit=None)
    assert s1["todo"] == 12 and "stopped" in s1               # every row is eligible
    s2 = prelabel.run(sample, out, _fake(calls), batch=3, rpm=1e9, limit=None)
    ids = [r["id"] for r in schema.read_jsonl(out)]
    sent = [i for c in calls for i in c]
    # run 1 stored h1, h2 (h0 rejected); run 2 retried h0 and stored two of each later batch
    assert len(ids) == len(set(ids)) == 8 and "h0" not in ids
    assert sent.count("h0") == 2                              # rejected rows are retried
    assert s2["todo"] == 12 - 2                               # resumed: first batch's 2 kept
    rows = list(schema.read_jsonl(out))
    assert {r["model"] for r in rows} == {"fake-model-001"}
    assert all(r["origin"] == "llm_prelabel" and r["prompt_sha"] for r in rows)


def test_prefill_review_import(tmp_path, capsys):
    sample, pre = _sample(tmp_path), tmp_path / "pre.jsonl"
    prelabel.run(sample, pre, _fake([]), batch=50, rpm=1e9, limit=None)
    sheet = tmp_path / "sheet_a.csv"
    assert build_sample.prefill(sheet, sample, pre)["prefilled"] == 11
    with open(sheet, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    by = {r["id"]: r for r in rows}
    assert by["h0"]["sentiment"] == ""                    # the model's answer was rejected
    assert by["h5"]["sentiment"] == "positive"            # double rows are pre-filled too (v1.2)
    assert all(r["companies"] == "" for r in rows)
    # annotator: reviews h8 (changes sentiment) and h9 (keeps), leaves h10 unchecked,
    # labels test row h0 from scratch
    by["h8"].update(sentiment="neutral", companies="TCS", checked="y")
    by["h9"].update(companies="INFY", checked="y")
    by["h0"].update(sentiment="negative", events="other", severity="low", scope="company",
                    companies="WIPRO")
    with open(sheet, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, build_sample.SHEET_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    recs = {r["id"]: r for r in build_sample.read_sheet(sheet, "A", sample, pre)}
    assert set(recs) == {"h0", "h8", "h9"}
    assert recs["h0"]["origin"] == "human"
    assert recs["h8"]["origin"] == recs["h9"]["origin"] == "human_verified"
    out = capsys.readouterr().out
    assert "skipped 9 pre-filled rows" in out and '"sentiment": "50.0%"' in out
    # Re-running prefill (more pre-labels arrived) never overwrites a row.
    assert build_sample.prefill(sheet, sample, pre)["prefilled"] == 0
    with open(sheet, encoding="utf-8-sig", newline="") as fh:
        again = {r["id"]: r for r in csv.DictReader(fh)}
    assert again["h8"]["sentiment"] == "neutral" and again["h0"]["companies"] == "WIPRO"


def test_prefill_incremental_and_hand_labels_win(tmp_path):
    sample, pre = _sample(tmp_path), tmp_path / "pre.jsonl"
    sheet = tmp_path / "sheet_a.csv"
    full = tmp_path / "full.jsonl"                    # which rows the fake labeller accepts at all
    prelabel.run(sample, full, _fake([]), batch=50, rpm=1e9, limit=None)
    will_get_label = {r["id"] for r in schema.read_jsonl(full)}
    prelabel.run(sample, pre, _fake([]), batch=50, rpm=1e9, limit=3)       # first day: a few rows
    first = build_sample.prefill(sheet, sample, pre)["prefilled"]
    assert first >= 1
    with open(sheet, encoding="utf-8-sig", newline="") as fh:
        rows = list(csv.DictReader(fh))
    filled = {r["id"] for r in rows if r["sentiment"]}
    # a row whose pre-label arrives only later, labelled by hand in the meantime
    hand = next(r for r in rows if not r["sentiment"] and r["id"] in will_get_label)
    hand.update(sentiment="positive", events="other", severity="none", scope="none")   # labelled by hand
    with open(sheet, "w", encoding="utf-8-sig", newline="") as fh:
        w = csv.DictWriter(fh, build_sample.SHEET_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    prelabel.run(sample, pre, _fake([]), batch=50, rpm=1e9, limit=None)    # next day: the rest
    res = build_sample.prefill(sheet, sample, pre)
    assert res["total_prefilled"] == first + res["prefilled"] == len(will_get_label) - 1  # hand row skipped
    assert hand["id"] not in set(json.loads(build_sample.prefill_record(sheet).read_text()))
    recs = {r["id"]: r for r in build_sample.read_sheet(sheet, "A", sample, pre)}
    assert recs[hand["id"]]["origin"] == "human"          # its later pre-label was never shown
    assert hand["id"] not in filled
