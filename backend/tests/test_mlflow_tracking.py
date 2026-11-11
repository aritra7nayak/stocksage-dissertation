"""MLflow mirroring against a throwaway file-based tracking store (never the real
server): registry sync-mlflow backfills a run, a model version and the shadow
alias; evaluation flattens E1-E3 into metric names."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

mlflow = pytest.importorskip("mlflow")

from research import evaluate, registry  # noqa: E402


def _model_dir(tmp_path: Path) -> Path:
    d = tmp_path / "models" / "tiny-sentiment"
    d.mkdir(parents=True)
    (d / "model.safetensors").write_bytes(b"not really weights")
    (d / "config.json").write_text("{}", encoding="utf-8")
    log = {"task": "sentiment", "model": "org/tiny", "revision": None, "seed": 1, "lr": 2e-5,
           "epochs": 2, "batch": 4, "max_len": 32, "device": "cpu", "bf16": False,
           "n": {"train": 10, "dev": 4, "test": 4}, "gold_sha256": "g" * 64, "test_fingerprint": "f" * 64,
           "test_complete": False, "history": [{"epoch": 1, "train_loss": 2.0, "dev_macro_f1": 0.5},
                                               {"epoch": 2, "train_loss": 1.0, "dev_macro_f1": 0.6}],
           "best_dev_macro_f1": 0.6, "mlflow_run_id": None}
    (d / "train_log.json").write_text(json.dumps(log), encoding="utf-8")
    return d


def test_sync_mlflow_backfills_runs_versions_and_aliases(tmp_path, monkeypatch):
    uri = (tmp_path / "mlruns").as_uri()
    monkeypatch.setenv("MLFLOW_TRACKING_URI", uri)
    mlflow.set_tracking_uri(uri)
    reg = registry.Registry(tmp_path / "registry.json", tmp_path / "serving.json")
    reg.register(_model_dir(tmp_path), "sentiment")
    reg.set_shadow("sentiment", 1)
    assert reg.get("sentiment", 1)["mlflow_run_id"] is None          # trained before tracking

    stats = registry.sync_mlflow(reg)
    assert stats == {"runs_backfilled": 1, "versions_registered": 1}
    v = registry.Registry(tmp_path / "registry.json", tmp_path / "serving.json").get("sentiment", 1)
    client = mlflow.tracking.MlflowClient()
    run = client.get_run(v["mlflow_run_id"])
    assert run.data.tags["backfilled"] == "true" and run.data.metrics["best_dev_macro_f1"] == 0.6
    assert client.get_model_version_by_alias("stocksage-sentiment", "shadow").version == v["mlflow_version"]
    assert registry.sync_mlflow(reg) == {"runs_backfilled": 0, "versions_registered": 0}   # idempotent


def test_evaluation_metric_names():
    rep = {"E1": {"m": {"macro_f1": {"point": 0.8, "low": 0.7, "high": 0.9}, "accuracy": 0.81,
                        "vs_finbert_generic": {"mcnemar": {"p_value": 0.04},
                                               "paired_bootstrap_macro_f1": {"delta": 0.1}}}},
           "E2": {"k": {"micro_f1": 0.3, "macro_f1": 0.1, "per_label": {}}},
           "E3": {"l": {"precision": 0.8, "recall": 0.5, "f1": 0.6, "misattribution_rate": 0.06}}}
    m = evaluate._flat_metrics(rep)
    assert m["E1.m.vs_finbert_generic.mcnemar_p"] == 0.04 and m["E1.m.macro_f1_low"] == 0.7
    assert m["E2.k.micro_f1"] == 0.3 and m["E3.l.misattribution_rate"] == 0.06
    assert all(isinstance(v, float) for v in m.values())
