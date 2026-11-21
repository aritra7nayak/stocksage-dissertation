# Promotion gate: events v1 vs keyword

**FAILED** on 450 frozen test headlines (fingerprint `49e54e99b929`, test-set look #1)

| Check | Result |
|---|---|
| macro f1 improves | pass |
| bootstrap ci excludes zero | pass |
| mcnemar significant | pass |
| no class regression | FAIL |

Macro-F1: 0.1485 -> 0.4697 (delta +0.3212, 95% CI +0.2643 to +0.3824)
McNemar: b=25 c=214 chi2=147.8828 p=0.0
Class F1 drops above threshold: {'fraud_default': 0.3333}
