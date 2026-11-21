# Evaluation — split `test` (450 headlines)

## E1 Sentiment

| Model | Macro-F1 (95% CI) | Accuracy |
|---|---|---|
| keyword | 0.302 (0.262–0.342) | 0.438 |
| finbert_generic | 0.656 (0.610–0.700) | 0.658 |
| finbert_in | 0.698 (0.652–0.740) | 0.704 |
| deberta_in | 0.745 (0.701–0.786) | 0.740 |

## E2 Events

| Model | Micro-F1 | Macro-F1 |
|---|---|---|
| keyword | 0.307 | 0.148 |
| deberta_events | 0.735 | 0.470 |

## E3 Entity linking

| Linker | Precision | Recall | F1 | Misattribution rate |
|---|---|---|---|---|
| substring | 0.167 | 0.432 | 0.241 | 0.316 |
| entity_linker | 0.793 | 0.523 | 0.630 | 0.049 |
