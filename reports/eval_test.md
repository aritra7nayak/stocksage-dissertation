# Evaluation — split `test` (123 headlines)

## E1 Sentiment

| Model | Macro-F1 (95% CI) | Accuracy |
|---|---|---|
| keyword | 0.295 (0.220–0.369) | 0.480 |
| finbert_generic | 0.705 (0.614–0.786) | 0.715 |
| finbert_in | 0.735 (0.649–0.816) | 0.748 |
| deberta_in | 0.825 (0.752–0.889) | 0.821 |

## E2 Events

| Model | Micro-F1 | Macro-F1 |
|---|---|---|
| keyword | 0.361 | 0.142 |
| deberta_events | 0.715 | 0.443 |

## E3 Entity linking

| Linker | Precision | Recall | F1 | Misattribution rate |
|---|---|---|---|---|
| substring | 0.197 | 0.429 | 0.270 | 0.285 |
| entity_linker | 0.800 | 0.571 | 0.667 | 0.065 |
