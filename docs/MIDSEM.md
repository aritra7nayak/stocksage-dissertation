# StockSage: mid-semester status

**Dissertation:** Domain-Adapted Financial NLP and a Grounded Conversational Assistant for Explainable Indian Equity Decision Support
**Author:** Aritra Nayak · BITS WILP M.Tech AIML (AIMLCZG628T) · Mid-semester viva: 18 December 2026
**Repository:** https://github.com/aritra7nayak/stocksage-dissertation, git tag **`mid-sem`** (this state). Later work is on branch `module-d-assistant`.

Every number below is reproducible from the tagged commit: data and models are versioned with DVC, runs are logged in MLflow, and the frozen test split is guarded by a fingerprint.

---

## 1. Results at a glance

All model results are on the **full frozen test split: 450 headlines, every one reviewed by a human.**

| Experiment | Result |
|---|---|
| **Corpus (Module A)** | 3,000 headlines sampled from ~564k (GDELT 2023–2026 + 8 live feeds), split 2,100 / 450 / 450 (train / dev / test) |
| **Inter-annotator agreement** | 120 seeded test rows, annotator A vs B: **sentiment κ = 0.809** (95% CI 0.712–0.887), severity κ = 0.926, scope κ = 0.964 |
| **E1 Sentiment** (macro-F1) | keyword 0.302 · generic FinBERT 0.656 · FinBERT fine-tuned 0.698 · **DeBERTa-v3 fine-tuned 0.745** |
| E1 significance, DeBERTa vs generic FinBERT | McNemar **p = 0.0019**; paired bootstrap Δ = **+0.089** (95% CI 0.038–0.141) |
| E1 significance, FinBERT-IN vs generic FinBERT | p = 0.062, Δ = +0.042 (CI −0.007–0.090): **not significant** |
| **E2 Events** (preliminary) | micro-F1: keyword 0.307 → **DeBERTa 0.735**; macro-F1 0.148 → 0.470 |
| **E3 Entity linking** | wrong-company rate: substring 31.6% → **entity linker 4.9%**; F1 0.241 → 0.630 |
| **MLOps** | DeBERTa sentiment passed all 4 promotion-gate checks and is the serving **champion**; the events model **failed** the gate (fraud F1 regression) and was held back |

---

## 2. Module A: corpus and annotation

### What was done
- **Collection:** GDELT GKG backfill 2023–2026 (~564k Indian business headlines) plus 8 live RSS feeds polled every 30 minutes.
- **Sample:** 3,000 headlines, publisher-balanced, near-duplicates grouped so a story never crosses splits; split 70/15/15. The test split is **frozen**: `data/corpus/test_manifest.json` holds its fingerprint, and training, evaluation and the promotion gate refuse to run if the test ids change.
- **Guidelines:** `research/annotation/GUIDELINES.md` (v1.4): six fields (sentiment, events, severity, scope, companies, sectors), with a decisions log recording every methodology change.
- **Annotation tool:** the **Research** tab in the app: buttons and search instead of free text, server-side validation of every rule, annotator roles A/B, time per row recorded.
- **Labelling design** (decisions log v1.2–v1.4):
  - All rows were pre-filled by an LLM (Claude), with company symbols verified against the NSE list.
  - **Test split (450):** reviewed by annotator A (Aritra Nayak). This is the answer key.
  - **Agreement subset (120 seeded test rows):** reviewed independently by annotator B (Alok Nayak).
  - **Train and dev:** LLM labels used as silver training data (`origin = llm_prelabel`), never used for evaluation.

### Where to check
| What | Where |
|---|---|
| Labelling UI | App → **Research** (sign in; admin sees *Annotators*) |
| Guidelines and decisions log | `research/annotation/GUIDELINES.md` |
| Labelled corpus | `data/corpus/labelled.jsonl` (via `dvc pull`) |
| Agreement report | `reports/agreement.json`; MLflow experiment `stocksage-annotation` |
| Annotator exports | `data/annotation/annotator_a.jsonl`, `annotator_b.jsonl` |

### How to reproduce
```powershell
backend\.venv\Scripts\Activate.ps1
python -m research.build_sample import-db --annotator A --to data/annotation/annotator_a.jsonl
python -m research.build_sample import-db --annotator B --to data/annotation/annotator_b.jsonl
python -m research.agreement data/annotation/annotator_a.jsonl data/annotation/annotator_b.jsonl --out reports/agreement.json
python -m research.build_sample gold        # rebuilds data/corpus/labelled.jsonl
```

---

## 3. Module B: models (E1, E2, E3)

### What was done
| Model | Task | Base | Dev macro-F1 |
|---|---|---|---|
| FinBERT-IN | sentiment | ProsusAI/finbert | 0.729 |
| **DeBERTa-IN** | sentiment | microsoft/deberta-v3-base | **0.785** |
| DeBERTa-events | events (multi-label) | microsoft/deberta-v3-base | 0.478 |

Training: 4 epochs, lr 2e-5, batch 16, max length 64, bf16 on an RTX 2050 (4 GB). Best epoch chosen on dev; **the test split is never used for model selection.** Retraining reproduces identical weights (same SHA-256).

Evaluation compares every model against the strongest baseline with **McNemar's test** (per-headline correctness) and a **paired bootstrap** (2,000 resamples) on the macro-F1 difference.

### Where to check
| What | Where |
|---|---|
| Full E1–E3 report | `reports/eval_test.md` (readable), `reports/eval_test.json` (every number) |
| Training curves | MLflow → `stocksage-sentiment`, `stocksage-events` |
| All evaluation runs | MLflow → `stocksage-evaluation` (the 123-row interim run is tagged `interim=true`) |
| Code | `research/train_classifier.py`, `research/evaluate.py`, `research/metrics.py`, `research/baselines.py` |

### How to reproduce
```powershell
dvc pull          # data and models
dvc repro         # retrains only what is out of date, then evaluates
dvc metrics show
```

---

## 4. MLOps lifecycle

| Component | What it does | Where to check |
|---|---|---|
| **DVC** | Versions `data/raw`, `data/corpus`, `data/annotation` and the three models; `dvc.yaml` defines train/evaluate stages, `params.yaml` the settings; `dvc.lock` pins the data, settings and weights behind each model | `dvc status`, `dvc dag`, `dvc metrics show`; store `C:\Users\aritr\dvc-store` |
| **MLflow** | Experiment tracking for training, evaluation, annotation agreement and drift; Model Registry with `champion`/`shadow` aliases | http://127.0.0.1:5000 |
| **Registry** | `models/registry.json` is the source of truth (versions, stages, gate history, test-set looks); mirrored to MLflow | `python -m research.registry list` |
| **Promotion gate** | Candidate vs champion on the frozen test split; all four must pass: macro-F1 improves, bootstrap CI excludes 0, McNemar p < 0.05, no class drops > 0.05 F1 | `reports/gate_sentiment_v2_1.md` (passed), `reports/gate_events_v1_1.md` (failed: fraud_default F1 −0.33 vs keyword) |
| **Shadow deployment** | A candidate scores live headlines beside the champion; logged only, never used in decisions | `/metrics` → `role="shadow"` series; DB table `shadow_predictions` |
| **Serving** | The API reads `models/serving.json` and swaps models without a restart | `/metrics` → `stocksage_sentiment_predictions_total{role="champion"}` shows `deberta-sentiment@v2` |
| **Monitoring** | Prometheus metrics (polls, headlines per source, label mix, confidence, latency, shadow agreement, feed errors), 5 alert rules, Grafana dashboard | Prometheus http://127.0.0.1:9090 · Grafana http://127.0.0.1:3001 → *StockSage: news pipeline and models* |
| **Drift** | PSI on label mix, confidence, headline length, publisher mix and more, last 7 days vs 28 before; logged to MLflow `stocksage-monitoring` | `python -m research.drift` → `reports/drift_<date>.md` |
| **Active learning / retraining** | Margin-uncertainty batch selection; one-command train → register → gate → shadow | `python -m research.active_learning batch ...`, `python -m research.retrain ...` |

### Start everything
```powershell
start.bat                                          # database, API, frontend
docker compose --profile mlops up -d mlflow        # MLflow
docker compose --profile monitoring up -d          # Prometheus + Grafana
```

### Suggested demo order (about 10 minutes)
1. **Research tab:** the labelling tool and a validation message.
2. **MLflow:** compare FinBERT vs DeBERTa training curves; open the final evaluation run; Models → `champion` alias.
3. **`reports/gate_sentiment_v2_1.md`** and **`gate_events_v1_1.md`:** one pass, one principled failure.
4. **`/metrics`:** the same headlines scored by champion and shadow; the switch to DeBERTa.
5. **Grafana:** the live dashboard.
6. **`dvc dag`** and **`dvc.lock`:** every result traces to a dataset and weights hash.

---

## 5. Engineering quality

- **144 automated tests** (`backend/tests`), including statistics checked against hand-computed values, the label schema, annotation rules, the corpus pipeline end to end, the registry and gate, and MLflow mirroring against a throwaway store. Run: `cd backend; python -m pytest`.
- Lint: `ruff`. CI: GitHub Actions.
- The research code never imports into the API; the API never imports research code.

---

## 6. Limitations to state in the report

1. **Pre-filled annotation.** Every row was pre-filled by an LLM. Kappa is therefore *pre-label-assisted* agreement and higher than blank-sheet agreement would be. Sentiment is the informative figure: both annotators changed it (A 9.7%, B 14.2% of rows). Events, scope and companies were almost never changed by either annotator, so their near-1.0 kappas mostly reflect the shared draft.
2. **The gold test labels are human-corrected LLM drafts,** not independent human labels. Change rates per field are reported by `import-db`.
3. **Silver training data.** Train/dev labels are LLM-generated; a human-only ablation (`build_sample gold --no-silver`) is available but not yet run.
4. **Rare event classes** (fraud, monetary policy, flows) have very few test examples; their per-class F1 has wide uncertainty, and the events model is not yet deployable (gate failure).
5. **Single domain and period:** Indian English-language business headlines, 2023–2026.

---

## 7. After mid-sem (branch `module-d-assistant`)

| Item | Plan |
|---|---|
| **Module D: assistant** | A domain-adapted small language model (free, runs locally and on Android) that answers through tools over the app's data (prices, indicators, options, fundamentals, news, sectors, flows, portfolio) plus a searchable knowledge base for concepts; refuses when data is missing |
| **E5** | Fixed question set; base small model vs fine-tuned model; correctness, grounding, refusal |
| **E2 follow-up** | Class weighting / keyword fallback for fraud, then re-gate |
| **E4** | Backtest: news signals from the new models vs keyword rules |
| **E6** | Single server vs k3s/Helm |
| Data | GDELT 2020–2022 backfill (December) |
