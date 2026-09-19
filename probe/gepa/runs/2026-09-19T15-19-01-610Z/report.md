# GEPA run — 2026-09-19T15:49:33.831Z

task model: swift-uncensored-27b · judge: ~typesafe/jev-latest · seed: 42 · iterations requested: 12 · minibatch: 4
seed instruction: probe/gepa/runs/2026-09-19T13-37-05-426Z/preset-c.txt

## Split
Train (12): sakhubai-scene_1, gyantv-scene_2.v5, gyantv-scene_5.v5, sakhubai-scene_3, sakhubai-scene_2, gyantv-scene_8.v7, gyantv-scene_7.v5, veyra-application, veyra-hook, gyantv-scene_10.v8, veyra-discovery, gyantv-scene_1.v5
Held-out (7): sakhubai-scene_4, gyantv-scene_9.v7, gyantv-scene_6.v5, gyantv-scene_4.v5, veyra-proof-payoff, gyantv-scene_3.v5, gyantv-scene_11.v8
Train: 7 multi-shot, 10 with dialogue.
Held-out: 3 multi-shot, 6 with dialogue.

## Seed (preset A)
train mean: 0.799 · held-out mean: 0.761

## Winner (preset C) — chosen by train mean
id: seed (parent chain: seed)
train mean: 0.799 · held-out mean: 0.761
The seed itself won on train mean — no reflection produced an improvement.

## Final Pareto front (held-out evaluated)
A candidate is on this front for winning at least one train case OUTRIGHT, or for being
smaller than every candidate that scores at least as well (the size objective) — see
`qualifiesBySize`. The (train mean, size) columns are what make the knee visible: where
mean stops climbing but size keeps growing is the point a longer instruction stopped paying for itself.
| candidate | parent | train mean | held-out mean | size (chars) |
|---|---|---|---|---|
| c2 | seed | 0.795 | 0.791 | 5616 |
| seed | — | 0.799 | 0.761 | 4472 |

## Iteration history
| iter | parent | child | outcome | minibatch Δ | child train mean |
|---|---|---|---|---|---|
| 1 | seed | c1 | rejected (minibatch regression) | -0.029 | — |
| 2 | seed | c2 | accepted | +0.039 | 0.795 |
| 3 | c2 | c3 | rejected (minibatch regression) | -0.014 | — |
| 4 | c2 | c4 | rejected (minibatch regression) | -0.028 | — |
| 5 | seed | c5 | rejected (minibatch regression) | -0.013 | — |
| 6 | c2 | c6 | rejected (minibatch regression) | -0.034 | — |
| 7 | seed | c7 | rejected (minibatch regression) | -0.002 | — |
| 8 | c2 | c8 | rejected (minibatch regression) | -0.004 | — |
| 9 | seed | c9 | rejected (minibatch regression) | -0.023 | — |
| 10 | c2 | c10 | rejected (minibatch regression) | -0.005 | — |
| 11 | seed | c11 | rejected (minibatch regression) | -0.030 | — |
| 12 | c2 | c12 | rejected (minibatch regression) | -0.029 | — |

## Cost
GPU wall-clock (task-model authoring only): 22.5 min (1350642 ms across 82 evaluate() calls, 63 of which authored)
Judge wall-clock (network, not GPU): 1.8 min
Reflection: 12 calls, 6.2 min, $1.4205
Cache hit rate: 23.2% (19/82)
Winner prompts saved: 19/19 to probe/gepa/runs/2026-09-19T15-19-01-610Z/winner-prompts/

## Concurrency
Bound: 1 (must track the llama.cpp server's --parallel slot count)
Pool wall-clock: 24.4 min · summed call time (author + judge): 24.4 min · achieved parallelism: 1.00x
(Reflection is excluded — it is one serial `claude -p` call per iteration, never pooled.)
