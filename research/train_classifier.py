"""Fine-tune a transformer on the labelled corpus (Module B, experiments E1/E2).

    # sentiment, FinBERT start point
    python -m research.train_classifier --task sentiment \
        --model ProsusAI/finbert --gold data/corpus/labelled.jsonl --out models/finbert-in
    # sentiment, DeBERTa-v3
    python -m research.train_classifier --task sentiment \
        --model microsoft/deberta-v3-base --gold data/corpus/labelled.jsonl --out models/deberta-in
    # multi-label events
    python -m research.train_classifier --task events \
        --model microsoft/deberta-v3-base --gold data/corpus/labelled.jsonl --out models/events-in

Trains on split=train, selects the epoch with the best dev macro-F1, then
writes predictions for split=test to <out>/predictions_test.jsonl (the input
for research.evaluate --pred). The test split is never used for selection.

A sentiment model is saved with POSITIVE/NEGATIVE/NEUTRAL labels, so the API
can serve it with FINBERT_MODEL=<out> and FINBERT_REVISION= (empty).

Sized for a 4 GB GPU: headlines are short (max 64 tokens), batch 16, bf16
autocast where supported. DeBERTa-v3 is unstable in fp16, which is why fp16
is never used. MLflow logging happens when mlflow is installed and
MLFLOW_TRACKING_URI is set; otherwise metrics go to <out>/train_log.json.
"""
import argparse
import json
import os
import random
import time
from pathlib import Path

import numpy as np

from research import ROOT, metrics, schema

SENT_LABELS = ["NEGATIVE", "NEUTRAL", "POSITIVE"]     # model-side names
EVENT_LABELS = list(schema.EVENT_TYPES)


def set_seed(seed: int) -> None:
    import torch
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


def _targets(recs, task, labels):
    if task == "sentiment":
        return [labels.index(r["sentiment"].upper()) for r in recs]
    return [[1.0 if e in r["events"] else 0.0 for e in EVENT_LABELS] for r in recs]


def _decode(task, logits, labels):
    """Model output -> schema labels (lists for events)."""
    if task == "sentiment":
        return [labels[i].lower() for i in logits.argmax(-1).tolist()]
    probs = 1 / (1 + np.exp(-logits))
    out = []
    for row in probs:
        evs = [EVENT_LABELS[i] for i, p in enumerate(row) if p >= 0.5 and EVENT_LABELS[i] != "other"]
        out.append(evs or ["other"])
    return out


def _score(task, recs, preds) -> float:
    if task == "sentiment":
        return metrics.macro_f1([r["sentiment"] for r in recs], preds, list(schema.SENTIMENTS))
    return metrics.multilabel_f1([set(r["events"]) for r in recs], [set(p) for p in preds],
                                 EVENT_LABELS)["macro_f1"]


def train(a) -> dict:
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, \
        get_linear_schedule_with_warmup

    set_seed(a.seed)
    recs = schema.load_valid(a.gold)
    frozen = schema.check_test_frozen(recs, a.manifest, allow_partial=True)
    split = {s: [r for r in recs if r.get("split") == s] for s in schema.SPLITS}
    if not split["train"] or not split["dev"]:
        raise SystemExit("need records in both the train and dev splits")

    device = "cuda" if torch.cuda.is_available() and not a.cpu else "cpu"
    use_bf16 = device == "cuda" and torch.cuda.is_bf16_supported()
    labels = SENT_LABELS if a.task == "sentiment" else EVENT_LABELS
    if a.task == "sentiment":
        # Keep a sentiment model's own head order (FinBERT: positive, negative,
        # neutral) so its pretrained classifier is reused, not scrambled.
        from transformers import AutoConfig
        base = AutoConfig.from_pretrained(a.model, revision=a.revision)
        names = [str(base.id2label[i]).upper() for i in range(len(base.id2label))]
        if sorted(names) == sorted(SENT_LABELS):
            labels = names
    tok = AutoTokenizer.from_pretrained(a.model, revision=a.revision)
    model = AutoModelForSequenceClassification.from_pretrained(
        a.model, revision=a.revision, num_labels=len(labels),
        id2label=dict(enumerate(labels)), label2id={lab: i for i, lab in enumerate(labels)},
        problem_type="single_label_classification" if a.task == "sentiment"
        else "multi_label_classification",
        ignore_mismatched_sizes=True).to(device)

    def batches(rs, shuffle):
        order = list(range(len(rs)))
        if shuffle:
            random.shuffle(order)
        for i in range(0, len(order), a.batch):
            chunk = [rs[j] for j in order[i:i + a.batch]]
            enc = tok([r["headline"] for r in chunk], padding=True, truncation=True,
                      max_length=a.max_len, return_tensors="pt").to(device)
            y = torch.tensor(_targets(chunk, a.task, labels),
                             dtype=torch.long if a.task == "sentiment" else torch.float).to(device)
            yield enc, y

    def predict(rs):
        model.eval()
        outs = []
        with torch.inference_mode(), torch.autocast(device, dtype=torch.bfloat16, enabled=use_bf16):
            for enc, _ in batches(rs, False):
                outs.append(model(**enc).logits.float().cpu().numpy())
        return _decode(a.task, np.concatenate(outs), labels)

    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.01)
    steps = a.epochs * ((len(split["train"]) + a.batch - 1) // a.batch)
    sched = get_linear_schedule_with_warmup(opt, int(0.1 * steps), steps)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    log = {"task": a.task, "model": a.model, "revision": a.revision, "seed": a.seed,
           "lr": a.lr, "epochs": a.epochs, "batch": a.batch, "device": device,
           "bf16": use_bf16, "n": {s: len(v) for s, v in split.items()},
           "gold": str(a.gold), "gold_sha256": schema.file_sha256(a.gold),
           "test_fingerprint": frozen["fingerprint"], "test_complete": frozen["complete"],
           "max_len": a.max_len, "history": []}
    best, t0 = -1.0, time.time()
    for epoch in range(1, a.epochs + 1):
        model.train()
        total = 0.0
        for enc, y in batches(split["train"], True):
            with torch.autocast(device, dtype=torch.bfloat16, enabled=use_bf16):
                loss = model(**enc, labels=y).loss
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            total += float(loss.detach())
        dev_score = _score(a.task, split["dev"], predict(split["dev"]))
        log["history"].append({"epoch": epoch, "train_loss": round(total, 4),
                               "dev_macro_f1": round(dev_score, 4)})
        print(f"epoch {epoch}: loss {total:.3f}  dev macro-F1 {dev_score:.4f}")
        if dev_score > best:
            best = dev_score
            model.save_pretrained(out)
            tok.save_pretrained(out)
    log["best_dev_macro_f1"] = round(best, 4)
    log["train_seconds"] = round(time.time() - t0, 1)

    # Reload the selected checkpoint before predicting the test split.
    model = AutoModelForSequenceClassification.from_pretrained(out).to(device)
    if split["test"]:
        preds = predict(split["test"])
        key = "sentiment" if a.task == "sentiment" else "events"
        schema.write_jsonl(out / "predictions_test.jsonl",
                           [{"id": r["id"], key: p} for r, p in zip(split["test"], preds)])
    log["weights_sha256"] = weights_sha256(out)
    log["mlflow_run_id"] = _mlflow(log, out)
    (out / "train_log.json").write_text(json.dumps(log, indent=2), encoding="utf-8")
    return log


def weights_sha256(model_dir: Path) -> str:
    """Hash of the saved weights: the model's identity in the registry."""
    files = sorted(model_dir.glob("*.safetensors")) or sorted(model_dir.glob("*.bin"))
    if not files:
        raise FileNotFoundError(f"no weights in {model_dir}")
    import hashlib
    h = hashlib.sha256()
    for f in files:
        h.update(schema.file_sha256(f).encode())
    return h.hexdigest()


# Small files only: the weights (~440 MB a run) stay in models/ under DVC and
# are identified in MLflow by weights_sha256, so the tracking store stays small.
_MLFLOW_ARTIFACTS = ("predictions_test.jsonl", "config.json")


def _mlflow(log: dict, out: Path) -> str | None:
    """Log the run to MLflow when MLFLOW_TRACKING_URI is set. Returns the run id."""
    if not os.environ.get("MLFLOW_TRACKING_URI"):
        return None
    try:
        import mlflow
    except ImportError:
        print("MLFLOW_TRACKING_URI is set but mlflow is not installed; skipped "
              "(pip install -r research/requirements-mlops.txt)")
        return None
    mlflow.set_experiment(f"stocksage-{log['task']}")
    with mlflow.start_run() as run:
        mlflow.log_params({k: log[k] for k in ("task", "model", "revision", "seed", "lr",
                                               "epochs", "batch", "max_len", "device", "bf16")})
        mlflow.log_params({f"n_{s}": n for s, n in log["n"].items()})
        mlflow.set_tags({"gold_sha256": log["gold_sha256"],
                         "test_fingerprint": log["test_fingerprint"],
                         "weights_sha256": log["weights_sha256"], "model_dir": str(out)})
        for h in log["history"]:
            mlflow.log_metrics({"train_loss": h["train_loss"],
                                "dev_macro_f1": h["dev_macro_f1"]}, step=h["epoch"])
        mlflow.log_metric("best_dev_macro_f1", log["best_dev_macro_f1"])
        mlflow.log_dict(log, "train_log.json")
        for name in _MLFLOW_ARTIFACTS:
            if (out / name).exists():
                mlflow.log_artifact(str(out / name))
        return run.info.run_id


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--task", choices=("sentiment", "events"), required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--revision", default=None)
    ap.add_argument("--gold", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--batch", type=int, default=16)
    ap.add_argument("--max-len", dest="max_len", type=int, default=64)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--cpu", action="store_true")
    ap.add_argument("--manifest", default=str(ROOT / "data" / "corpus" / "test_manifest.json"))
    train(ap.parse_args())
