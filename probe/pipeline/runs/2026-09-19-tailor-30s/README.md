# 2026-09-19 · tailor · 30s · preset A vs preset B

Both arms authored the SAME two clips from ONE shared plan, so they differ by
exactly preset B's two extra calls. Model `swift-qwen38-27b` on the local box,
reasoning budget applied. Plot is the Surat tailor brief in `probe/pipeline/ab.ts`.

## Authoring spend

| arm | calls | wall | completion tokens |
| --- | --- | --- | --- |
| shared plan | 7 | 55.6s | 6,689 |
| A | 2 | 39.7s | 3,977 |
| B | 6 | 158.2s | 16,881 |

B is ~4x the wall-clock and ~4.2x the tokens of A for the same two clips.

## Shot-fragment fidelity — the by-eye finding, reproduced

| clip | planned shots | A wrote | B wrote |
| --- | --- | --- | --- |
| 1 | 7 | **3** | **7** |
| 2 | 6 | 5 | 6 |

Preset B's direction pass also produced ZERO off-vocabulary camera terms.

## Judge scores — NOT YET A VALID COMPARISON

Recorded for the record, but see the caveat: the per-shot fan-out lets a prompt
that writes FEWER shots be judged on FEWER questions, so under-delivery inflates
the score. Clip 1 arm A was judged on 11 camera questions to arm B's 23, and its
four missing shots cost it exactly one question (`fragments-match-plan` 0.43).
Re-judge once that is fixed.

| | clip 1 | clip 2 |
| --- | --- | --- |
| A | 0.801 | 0.809 |
| B | 0.741 | 0.693 |

These numbers are kept because they are the evidence for the bug, not because
they settle the A/B.
