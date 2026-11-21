# Promotion gate: sentiment v2 vs baseline

**PASSED** on 450 frozen test headlines (fingerprint `49e54e99b929`, test-set look #1)

| Check | Result |
|---|---|
| macro f1 improves | pass |
| bootstrap ci excludes zero | pass |
| mcnemar significant | pass |
| no class regression | pass |

Macro-F1: 0.6564 -> 0.7451 (delta +0.0887, 95% CI +0.0378 to +0.1408)
McNemar: b=49 c=86 chi2=9.6 p=0.001946
