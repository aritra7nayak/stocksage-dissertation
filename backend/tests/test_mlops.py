"""MLOps lifecycle: frozen test set, registry and promotion gate, serving
config, shadow isolation, metrics, drift and active learning. No model is
loaded and no database is needed."""
import asyncio
import json
import random

import numpy as np
import pytest

from research import active_learning as al
from research import drift, registry, schema


def _rec(i, split, sentiment="neutral", headline=None, source="mint"):
    return {"id": f"r{i}", "headline": headline or f"Headline number {i} about Indian markets",
            "source": source, "published_at": "2026-11-01T03:00:00+00:00", "split": split,
            "sentiment": sentiment, "events": ["other"], "severity": "none", "scope": "none",
            "companies": [], "sectors": [], "annotator": "A"}


# ── frozen test split ──────────────────────────────────────────────────────

def test_test_manifest_detects_changes(tmp_path):
    recs = [_rec(i, "test" if i < 5 else "train") for i in range(10)]
    man = tmp_path / "test_manifest.json"
    schema.write_test_manifest(man, recs, seed=1)
    assert schema.check_test_frozen(recs, man)["complete"] is True
    moved = [dict(r, split="test") if r["id"] == "r7" else r for r in recs]
    with pytest.raises(schema.SchemaError, match="not in the frozen manifest"):
        schema.check_test_frozen(moved, man)
    partial = [r for r in recs if r["id"] != "r0"]
    with pytest.raises(schema.SchemaError, match="not labelled yet"):
        schema.check_test_frozen(partial, man)
    assert schema.check_test_frozen(partial, man, allow_partial=True)["complete"] is False
    assert schema.check_test_frozen(recs, tmp_path / "absent.json")["complete"] is None


def test_build_sample_refuses_to_redraw_test(tmp_path):
    from research.build_sample import build
    raw = tmp_path / "raw.jsonl"
    schema.write_jsonl(raw, [{k: v for k, v in _rec(i, None).items() if k in schema.RAW_FIELDS}
                             for i in range(40)])
    build([str(raw)], 30, 5, 3, tmp_path / "corpus")
    assert (tmp_path / "corpus" / "test_manifest.json").exists()
    with pytest.raises(SystemExit, match="already frozen"):
        build([str(raw)], 30, 5, 3, tmp_path / "corpus")


def test_publisher_names_unified():
    from research.build_sample import publisher
    assert {publisher(s) for s in ("Economic Times Markets", "economictimes.indiatimes.com",
                                   "Economic Times Industry")} == {"economictimes"}
    assert {publisher(s) for s in ("Livemint Companies", "livemint.com")} == {"livemint"}
    assert {publisher(s) for s in ("BusinessLine Markets", "thehindubusinessline.com")} == {"businessline"}
    assert publisher("business-standard.com") == publisher("Business Standard Markets")


def test_story_grouping_keeps_one_copy_per_story():
    from research.build_sample import group_stories
    recs = [{"id": "a", "headline": "Sensex falls 500 points as banks drag the index lower",
             "published_at": "2026-11-02T04:00:00+00:00"},
            {"id": "b", "headline": "Stock market today: Sensex falls 500 points as banks drag the index lower",
             "published_at": "2026-11-02T03:00:00+00:00"},
            {"id": "c", "headline": "Sensex falls 500 points as banks drag the index lower | Mint",
             "published_at": "2026-11-02T05:00:00+00:00"},
            {"id": "d", "headline": "Infosys wins large deal from a European bank",
             "published_at": "2026-11-02T05:00:00+00:00"}]
    groups = sorted(sorted(r["id"] for r in g) for g in group_stories(recs))
    assert groups == [["a", "b", "c"], ["d"]]          # b joins via the last words, c via the first


# ── promotion gate ─────────────────────────────────────────────────────────

def _noisy(gold, acc, seed):
    rng = random.Random(seed)
    labels = list(schema.SENTIMENTS)
    return [g if rng.random() < acc else rng.choice([x for x in labels if x != g]) for g in gold]


def test_gate_decision_rules():
    rng = random.Random(0)
    gold = [rng.choice(schema.SENTIMENTS) for _ in range(400)]
    weak, strong = _noisy(gold, 0.6, 1), _noisy(gold, 0.85, 2)
    assert registry.gate_decision("sentiment", gold, weak, strong)["passed"]
    same = registry.gate_decision("sentiment", gold, weak, weak)
    assert not same["passed"] and "macro_f1_improves" in same["failed"]
    worse = registry.gate_decision("sentiment", gold, strong, weak)
    assert not worse["passed"] and "mcnemar_significant" in worse["failed"]
    # Better overall but one class collapses: blocked by the regression check.
    lopsided = [g if g != "positive" else "neutral" for g in strong]
    lopsided = [g if p == "neutral" and g != "positive" else p for g, p in zip(gold, lopsided)]
    res = registry.gate_decision("sentiment", gold, weak, lopsided)
    assert "no_class_regression" in res["failed"] and "positive" in res["class_drops"]


def _model_dir(path, gold_test, acc, seed, sha_seed):
    path.mkdir(parents=True)
    (path / "model.safetensors").write_bytes(bytes([sha_seed]) * 64)
    (path / "train_log.json").write_text(json.dumps(
        {"task": "sentiment", "model": "ProsusAI/finbert", "best_dev_macro_f1": 0.7,
         "test_fingerprint": None, "gold_sha256": None}), encoding="utf-8")
    preds = _noisy([r["sentiment"] for r in gold_test], acc, seed)
    schema.write_jsonl(path / "predictions_test.jsonl",
                       [{"id": r["id"], "sentiment": p} for r, p in zip(gold_test, preds)])
    return path


def test_registry_lifecycle(tmp_path, monkeypatch):
    monkeypatch.setattr(registry, "MODELS", tmp_path / "models")
    rng = random.Random(5)
    gold = [_rec(i, "test" if i < 300 else "train", rng.choice(schema.SENTIMENTS)) for i in range(330)]
    gold_path, man = tmp_path / "labelled.jsonl", tmp_path / "test_manifest.json"
    schema.write_jsonl(gold_path, gold)
    schema.write_test_manifest(man, gold, seed=1)
    test = [r for r in gold if r["split"] == "test"]
    fp = schema.test_fingerprint(gold)
    base = registry.MODELS / "baseline" / f"predictions_test_{fp[:12]}.jsonl"
    schema.write_jsonl(base, [{"id": r["id"], "sentiment": p}
                              for r, p in zip(test, _noisy([r["sentiment"] for r in test], 0.55, 9))])

    reg = registry.Registry(tmp_path / "registry.json", tmp_path / "serving.json")
    v1 = reg.register(_model_dir(tmp_path / "m1", test, 0.8, 1, 1), "sentiment")["version"]
    with pytest.raises(SystemExit, match="already registered"):
        reg.register(tmp_path / "m1", "sentiment")
    reports = tmp_path / "reports"
    g1 = registry.run_gate(reg, "sentiment", v1, gold_path, man, reports)
    assert g1["passed"] and g1["against"] == "baseline"
    reg.promote("sentiment", v1, g1)
    serving = json.loads((tmp_path / "serving.json").read_text())
    assert serving["champion"]["registry_version"] == v1 and serving["shadow"] is None

    # A worse candidate fails and cannot be promoted, but can still be shadowed.
    v2 = reg.register(_model_dir(tmp_path / "m2", test, 0.6, 2, 2), "sentiment")["version"]
    g2 = registry.run_gate(reg, "sentiment", v2, gold_path, man, reports)
    assert not g2["passed"] and g2["against"] == v1
    with pytest.raises(SystemExit, match="gate failed"):
        reg.promote("sentiment", v2, g2)
    reg.set_shadow("sentiment", v2)
    assert json.loads((tmp_path / "serving.json").read_text())["shadow"]["registry_version"] == v2

    v3 = reg.register(_model_dir(tmp_path / "m3", test, 0.97, 3, 3), "sentiment")["version"]
    g3 = registry.run_gate(reg, "sentiment", v3, gold_path, man, reports)
    assert g3["passed"]
    assert registry.reusable_gate(reg, "sentiment", v3, gold_path)["candidate"] == v3
    reg.promote("sentiment", v3, g3)
    assert registry.reusable_gate(reg, "sentiment", v3, gold_path) is None   # champion changed
    t = reg.task("sentiment")
    assert t["champion"] == v3 and t["test_set_looks"] == 3
    assert reg.get("sentiment", v1)["stage"] == "archived"

    assert reg.rollback("sentiment") == v1
    assert reg.rollback("sentiment") == registry.BASELINE
    assert json.loads((tmp_path / "serving.json").read_text())["champion"] is None
    assert (reports / "gate_sentiment_v3_3.md").exists()


# ── serving config and shadow isolation (backend) ──────────────────────────

def test_serving_config_selects_and_reloads_models(tmp_path, monkeypatch):
    from app.sentiment import finbert
    cfg = tmp_path / "serving.json"
    monkeypatch.setattr(finbert.settings, "serving_config", str(cfg))
    monkeypatch.setattr(finbert, "_champion", None)
    monkeypatch.setattr(finbert, "_shadow", None)
    monkeypatch.setattr(finbert, "_serving_mtime", -1.0)
    assert finbert.champion().model_id == finbert.settings.finbert_model     # no file: pinned model
    assert finbert.shadow() is None

    cfg.write_text(json.dumps({"champion": {"path": str(tmp_path / "m3"), "version": "m3@v3:abc"},
                               "shadow": {"path": str(tmp_path / "m4"), "version": "m4@v4:def"}}))
    assert finbert.champion().model_id == str(tmp_path / "m3")
    assert finbert.shadow()._version == "m4@v4:def"
    monkeypatch.setattr(finbert.settings, "shadow_enabled", False)
    import os
    os.utime(cfg, (1, 1))                       # force a re-read
    assert finbert.shadow() is None


def test_shadow_failure_never_raises(monkeypatch):
    from app import monitoring
    from app.sentiment import finbert, pipeline

    class Broken:
        def score(self, headlines):
            raise RuntimeError("boom")

    monkeypatch.setattr(finbert, "shadow", lambda: Broken())
    before = monitoring.SHADOW_ERRORS._value.get()
    asyncio.run(pipeline._score_shadow({"h": object()}, [], "v"))
    assert monitoring.SHADOW_ERRORS._value.get() == before + 1


def test_metrics_endpoint_and_token(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app import monitoring
    from app.sentiment.finbert import SentimentResult

    monitoring.observe("champion", "m@v1", [SentimentResult("h", "POSITIVE", 0.8, 0.9),
                                            SentimentResult("h", "NEUTRAL", 0.0, 0.0, False)], 0.2)
    app = FastAPI()
    app.include_router(monitoring.router)
    client = TestClient(app)
    body = client.get("/metrics").text
    assert 'stocksage_sentiment_predictions_total{label="POSITIVE",model="m@v1",role="champion"}' in body
    assert "stocksage_scorer_fallback_total" in body
    monkeypatch.setattr(monitoring.settings, "metrics_token", "s3cret")
    assert client.get("/metrics").status_code == 401
    assert client.get("/metrics", headers={"Authorization": "Bearer s3cret"}).status_code == 200


# ── drift ──────────────────────────────────────────────────────────────────

def test_psi_values():
    assert drift.psi([50, 50], [50, 50]) == pytest.approx(0.0)
    assert drift.psi([90, 10], [10, 90]) > 0.25
    assert drift.status(0.05) == "stable" and drift.status(0.2) == "moderate" and drift.status(0.3) == "drift"
    rng = np.random.default_rng(0)
    a, b = rng.normal(0, 1, 2000).tolist(), rng.normal(0, 1, 2000).tolist()
    assert drift.numeric_psi(a, b) < 0.1
    assert drift.numeric_psi(a, (np.array(b) + 1.5).tolist()) > 0.25


def _news(n, sentiment_p, model="m@v1", source="ET", seed=0):
    rng = random.Random(seed)
    words = ["sensex", "nifty", "bank", "rally", "falls", "profit", "rbi", "rate", "crude", "rupee"]
    out = []
    for _ in range(n):
        s = rng.choices(["NEGATIVE", "NEUTRAL", "POSITIVE"], sentiment_p)[0]
        out.append({"headline": " ".join(rng.choices(words, k=rng.randint(6, 12))), "source": source,
                    "sentiment": s, "sentiment_model": model, "related_symbols": None,
                    "sentiment_score": {"NEGATIVE": -0.7, "NEUTRAL": 0.0, "POSITIVE": 0.7}[s],
                    "sentiment_confidence": 0.8})
    return out


def test_drift_compare():
    ref = _news(600, [0.3, 0.4, 0.3], seed=1)
    stable = drift.compare(ref, _news(300, [0.3, 0.4, 0.3], seed=2))
    assert stable["checks"]["prediction.label_mix"]["status"] == "stable"
    shifted = drift.compare(ref, _news(300, [0.75, 0.15, 0.1], seed=3))
    assert shifted["checks"]["prediction.label_mix"]["status"] == "drift" and shifted["overall"] == "drift"
    # A new champion is a model change, not drift: prediction checks are skipped.
    changed = drift.compare(ref, _news(300, [0.75, 0.15, 0.1], model="m@v2", seed=4))
    assert changed["checks"]["prediction"]["status"] == "n/a"


# ── active learning ────────────────────────────────────────────────────────

def test_margin_and_selection_caps():
    u = al.margin_uncertainty(np.array([[0.34, 0.33, 0.33], [0.9, 0.05, 0.05]]))
    assert u[0] > 0.95 and u[1] == pytest.approx(0.15)
    pool = ([{"id": f"a{i}", "headline": f"Alpha story {i} about markets today", "source": "A"} for i in range(10)]
            + [{"id": f"b{i}", "headline": f"Beta story {i} about markets today", "source": "B"} for i in range(10)])
    chosen = al.select(pool, np.linspace(1, 0, 20), n=6, max_source_share=0.5)
    assert len(chosen) == 6 and sum(r["source"] == "A" for r in chosen) == 3
    dup = [{"id": "x", "headline": "Sensex falls 500 points as banks drag the index lower", "source": "A"},
           {"id": "y", "headline": "Sensex falls 500 points as banks drag the index lower today", "source": "B"}]
    assert len(al.select(dup, np.array([1.0, 0.9]), n=2)) == 1


def test_pool_and_merge_protect_test_split(tmp_path):
    sample = [_rec(0, "test", headline="Sensex falls 500 points as banks drag the index lower"),
              _rec(1, "train")]
    raw = tmp_path / "raw.jsonl"
    rows = [{"id": "n1", "headline": "Sensex falls 500 points as banks drag the index lower - Mint",
             "source": "mint", "published_at": "2026-11-02T03:00:00+00:00"},
            {"id": "n2", "headline": "Infosys wins large deal from a European bank",
             "source": "mint", "published_at": "2026-11-02T03:00:00+00:00"}]
    schema.write_jsonl(raw, rows)
    assert [r["id"] for r in al.build_pool([str(raw)], sample)] == ["n2"]

    gold = tmp_path / "labelled.jsonl"
    schema.write_jsonl(gold, sample)
    man = tmp_path / "test_manifest.json"
    schema.write_test_manifest(man, sample, seed=1)
    labels = tmp_path / "al.jsonl"
    schema.write_jsonl(labels, [_rec(9, "train", headline="Infosys wins large deal from a European bank"),
                                _rec(8, "train", headline=sample[0]["headline"] + " sharply")])
    stats = al.merge(labels, gold, man)
    assert stats["added"] == 1 and stats["skipped"] == {"near-duplicate of a test headline": 1}
    schema.write_jsonl(labels, [_rec(7, "test")])
    with pytest.raises(schema.SchemaError, match="split=train"):
        al.merge(labels, gold, man)
