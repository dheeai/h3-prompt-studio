# GEPA run — 2026-09-19T14:44:33.041Z

task model: swift-uncensored-27b · judge: ~typesafe/jev-latest · seed: 42 · iterations requested: 10 · minibatch: 4

## Split
Train (12): sakhubai-scene_1, gyantv-scene_2.v5, gyantv-scene_5.v5, sakhubai-scene_3, sakhubai-scene_2, gyantv-scene_8.v7, gyantv-scene_7.v5, veyra-application, veyra-hook, gyantv-scene_10.v8, veyra-discovery, gyantv-scene_1.v5
Held-out (7): sakhubai-scene_4, gyantv-scene_9.v7, gyantv-scene_6.v5, gyantv-scene_4.v5, veyra-proof-payoff, gyantv-scene_3.v5, gyantv-scene_11.v8
Train: 7 multi-shot, 10 with dialogue.
Held-out: 3 multi-shot, 6 with dialogue.

## Seed (preset A)
train mean: 0.698 · held-out mean: 0.668

## Winner (preset C) — chosen by train mean
id: c9 (parent chain: seed -> c1 -> c9)
train mean: 0.798 · held-out mean: 0.760
Held-out improved along with train — the gain generalises past the 12 train cases.

## Final Pareto front (held-out evaluated)
| candidate | parent | train mean | held-out mean |
|---|---|---|---|
| c10 | c6 | 0.753 | 0.752 |
| c2 | seed | 0.723 | 0.675 |
| c3 | seed | 0.677 | 0.732 |
| c5 | seed | 0.741 | 0.705 |
| c6 | seed | 0.744 | 0.721 |
| c7 | seed | 0.722 | 0.702 |
| c9 | c1 | 0.798 | 0.760 |

## Iteration history
| iter | parent | child | outcome | minibatch Δ | child train mean |
|---|---|---|---|---|---|
| 1 | seed | c1 | accepted | +0.058 | 0.672 |
| 2 | seed | c2 | accepted | +0.056 | 0.723 |
| 3 | seed | c3 | accepted | +0.054 | 0.677 |
| 4 | seed | c4 | accepted | +0.038 | 0.734 |
| 5 | seed | c5 | accepted | +0.090 | 0.741 |
| 6 | seed | c6 | accepted | +0.091 | 0.744 |
| 7 | seed | c7 | accepted | +0.075 | 0.722 |
| 8 | c1 | c8 | accepted | +0.218 | 0.748 |
| 9 | c1 | c9 | accepted | +0.295 | 0.798 |
| 10 | c6 | c10 | accepted | +0.040 | 0.753 |

## Cost
GPU wall-clock (task-model authoring only): 60.1 min (3607232 ms across 188 evaluate() calls, 188 of which authored)
Judge wall-clock (network, not GPU): 3.9 min
Reflection: 10 calls, 3.4 min, $1.2224
Cache hit rate: 0.0% (0/188)
