# Research workflow

Offline code for the dissertation. It covers the corpus (Module A), fine-tuning (Module B), and evaluation for experiments E1–E3. The API never imports it. Run everything from the repository root with the backend venv active:

```powershell
backend\.venv\Scripts\Activate.ps1
python -m research.<script> --help
```

## Pipeline

```
live feed (news_items) ─┐
                        ├─► data/raw/*.jsonl ─► build_sample ─► sheets (CSV) ─► annotators
GDELT GKG backfill ─────┘                          │                              │
                                                   ▼                              ▼
                                       data/corpus/sample.jsonl     build_sample import
                                       (fixed train/dev/test)               │
                                                                            ▼
                                                     data/annotation/annotator_{a,b}.jsonl
                                                         │                 │
                                                agreement (kappa)   labelled.jsonl ─► train_classifier
                                                                            │              │
                                                                            ▼              ▼
                                                                    evaluate (E1–E3) ◄─ predictions
```

| Step | Command |
|---|---|
| 1. Export the live feed | `python -m research.export_news` |
| 2. Estimate the backfill cost, then run it | `python -m research.gdelt_backfill --start 2023-01-01 --end 2026-10-31 --dry-run` (then run again without `--dry-run`) |
| 3. Draw the sample and splits | `python -m research.build_sample sample data/raw/live_feed.jsonl data/raw/gdelt.jsonl` |
| 3a. Optional LLM pre-labels (train/dev only) | `python -m research.prelabel --dry-run`, then `python -m research.prelabel` daily until done (the free tier has a daily limit). The Research tab shows new pre-labels at once |
| 4. Annotate | In the app's **Research** tab, following [annotation/GUIDELINES.md](annotation/GUIDELINES.md). The admin assigns annotators A and B there. (Fallback: fill `data/corpus/sheet_annotator_{a,b}.csv`) |
| 5. Export the labels | `python -m research.build_sample import-db --annotator A --to data/annotation/annotator_a.jsonl` (and `--annotator B`). For CSV sheets: `build_sample import <sheet> --annotator A --to ...` |
| 6. Measure agreement | `python -m research.agreement data/annotation/annotator_a.jsonl data/annotation/annotator_b.jsonl` |
| 7. Fine-tune | `python -m research.train_classifier --task sentiment --model ProsusAI/finbert --gold data/corpus/labelled.jsonl --out models/finbert-in` |
| 8. Evaluate | `python -m research.evaluate --gold data/corpus/labelled.jsonl --finbert --pred finbert_in=models/finbert-in/predictions_test.jsonl` |
| 9. Register, gate, serve | `python -m research.registry register models/finbert-in`, then `shadow 1`, then `promote 1` (see [MLOps lifecycle](#mlops-lifecycle)) |

`labelled.jsonl` is the adjudicated gold file: annotator A's labels with the double-annotated rows replaced by the agreed labels.

## Rules that protect the results

- **The test split is frozen** by `build_sample` (seed `20261108`), which also writes `data/corpus/test_manifest.json` (the sorted test ids and their SHA-256). `train_classifier`, `evaluate`, the promotion gate and `active_learning merge` all check it and stop if a test row was added, moved or dropped. `build_sample sample` refuses to run again while the manifest exists. Models are selected on `dev` only.
- **Gold company links are never pre-filled by the entity linker**, because E3 scores that linker.
- **Backtest alignment:** a headline affects a session only if it is timestamped before 09:00 IST that day (`backend/app/backtest/news_signals.py`). GDELT timestamps are crawl times, so they can only delay a headline, never leak it early.
- **E4 control arm:** neutral sentiment pulls every composite score toward 0.5, which reduces the number of buys. Compare news-driven runs against `NewsSignals()` (neutral news), not against the technical-only run, so that this dilution is not mistaken for information.

## MLOps lifecycle

```
train_classifier ─► registry register ─► registry gate ─► registry shadow ─► registry promote
      │  (MLflow run)        (candidate)     (frozen test)   (live, logged)      (champion)
      ▼                                                          │                  │
 models/<dir>                                     shadow_predictions table     models/serving.json
                                                                 │                  │ (API reloads it)
  active_learning batch ◄── drift (exit 2) ◄── Prometheus/Grafana ◄── /metrics ◄─────┘
          │
   label sheet ─► build_sample import ─► active_learning merge ─► retrain (loop)
```

| Stage | What it does | Command |
|---|---|---|
| Experiment tracking | Each training run logs its parameters, dev curve, gold-file hash, test fingerprint and weights hash to MLflow (`MLFLOW_TRACKING_URI`); without it, `train_log.json` holds the same | `docker compose --profile mlops up -d`, then `$env:MLFLOW_TRACKING_URI="http://127.0.0.1:5000"` (UI on port 5000) |
| Data and model versioning | DVC for `data/` and `models/` (below). The weights SHA-256 is each model's identity in the registry | `dvc add ...` |
| Model registry | `models/registry.json` records the versions and their stages (candidate, shadow, champion, archived, rolled_back). It is mirrored to the MLflow Model Registry (aliases `champion` and `shadow`) | `python -m research.registry list` |
| Evaluation-gated promotion | The candidate is compared with the champion (or the pinned FinBERT) on the frozen test set. All four checks must pass: macro-F1 improves, the paired-bootstrap 95% CI excludes 0, McNemar p < 0.05, and no class loses more than 0.05 F1. Each gate run counts as one look at the test set (`test_set_looks`), and `promote` reuses a passing gate instead of looking again | `python -m research.registry gate 2`, then `promote 2` |
| Shadow deployment | The shadow scores every new headline beside the champion. Its rows go to `shadow_predictions` and never into a decision. A shadow failure cannot affect ingestion | `python -m research.registry shadow 2`, `shadow --clear` |
| Serving and rollback | The API reads `models/serving.json` and swaps models at the next poll, with no restart. `rollback` returns to the previous champion without a gate, and the rollback is recorded | `python -m research.registry rollback` |
| Monitoring | `/metrics` exposes polls, headlines per publisher, the label mix and confidence per model, latency, neutral fallbacks, shadow agreement and feed errors. Grafana has a provisioned dashboard; Prometheus has 5 alert rules (`deploy/monitoring/alerts.yml`) | `docker compose --profile monitoring up -d`, Grafana on http://localhost:3001 |
| Drift detection | Compares the last 7 days with the 28 before, using PSI on the label mix, score and confidence (same model version only), headline length, publisher mix and linked share, plus the unseen-word rate and shadow disagreement. Exits with code 2 on drift | `python -m research.drift` |
| Active learning | Picks the headlines with the highest margin uncertainty (with a bonus where champion and shadow disagree), with one row per near-duplicate and a per-publisher cap. Rows go to train only, and near-duplicates of test headlines are excluded | `python -m research.active_learning batch data/raw/*.jsonl`, then `merge` |
| Retraining | Train, then register, then gate, then shadow, in one command. Promotion is a separate step after the shadow period | `python -m research.retrain --model ProsusAI/finbert --out models/finbert-in-r2` |

Install the MLflow client with `pip install -r research/requirements-mlops.txt`. The API and CI don't need it.

Drift and monitoring are implemented with numpy and prometheus_client, not Evidently, for the same reason `metrics.py` avoids scikit-learn: the reported numbers must not change with a library version. PSI thresholds: below 0.10 is stable, 0.10–0.25 moderate, 0.25 or above drift.

## Data versioning

DVC is set up. Git holds only small pointers; the files themselves are in the DVC store (default remote `local` = `C:\Users\aritr\dvc-store`, see `.dvc/config`).

| What | How it is tracked |
|---|---|
| `data/raw`, `data/corpus`, `data/annotation` | `dvc add` → `data/*.dvc` |
| `models/finbert-in`, `models/deberta-sentiment`, `models/deberta-events` | outputs of the `dvc.yaml` stages → `dvc.lock` |
| Training settings | `params.yaml` |
| `reports/eval_test.json` (metrics), `reports/eval_test.md` | `dvc.yaml` evaluate stage, kept in git |
| `models/registry.json`, `models/serving.json` | git (the registry's history is part of the record) |

```powershell
pip install -r research/requirements-mlops.txt      # dvc, sentencepiece, mlflow client
dvc pull                                            # fetch data and models on a new machine
python -m research.build_sample gold                # after more labelling: rebuild labelled.jsonl
dvc add data/corpus                                 # record the new dataset version
dvc repro                                           # retrain/re-evaluate only what changed
dvc metrics show; dvc params diff                   # compare with the last commit
dvc push; git commit -am "..."                      # store files, then commit the pointers
```

To move the store off this machine later: `dvc remote add -d gdrive gdrive://<folder-id>` (or S3), then `dvc push`. Each experiment report also records the SHA-256 of the gold file it used, so every result traces to a dataset version.
