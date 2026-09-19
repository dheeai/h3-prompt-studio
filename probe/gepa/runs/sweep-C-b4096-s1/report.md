# GEPA run — 2026-09-19T17:02:18.506Z

task model: swift-uncensored-27b · judge: ~typesafe/jev-latest · seed: 42 · iterations requested: 0 · minibatch: 4
seed instruction: probe/gepa/runs/2026-09-19T13-37-05-426Z/preset-c.txt

## Split
Train (12): sakhubai-scene_1, gyantv-scene_2.v5, gyantv-scene_5.v5, sakhubai-scene_3, sakhubai-scene_2, gyantv-scene_8.v7, gyantv-scene_7.v5, veyra-application, veyra-hook, gyantv-scene_10.v8, veyra-discovery, gyantv-scene_1.v5
Held-out (7): sakhubai-scene_4, gyantv-scene_9.v7, gyantv-scene_6.v5, gyantv-scene_4.v5, veyra-proof-payoff, gyantv-scene_3.v5, gyantv-scene_11.v8
Train: 7 multi-shot, 10 with dialogue.
Held-out: 3 multi-shot, 6 with dialogue.

## Seed (preset A)
train mean: 0.789 · held-out mean: 0.755

## Winner (preset C) — chosen by train mean
id: seed (parent chain: seed)
train mean: 0.789 · held-out mean: 0.755
The seed itself won on train mean — no reflection produced an improvement.

## Final Pareto front (held-out evaluated)
A candidate is on this front for winning at least one train case OUTRIGHT, or for being
smaller than every candidate that scores at least as well (the size objective) — see
`qualifiesBySize`. The (train mean, size) columns are what make the knee visible: where
mean stops climbing but size keeps growing is the point a longer instruction stopped paying for itself.
| candidate | parent | train mean | held-out mean | size (chars) |
|---|---|---|---|---|
| seed | — | 0.789 | 0.755 | 4472 |

## Iteration history
| iter | parent | child | outcome | minibatch Δ | child train mean |
|---|---|---|---|---|---|

## Cost
GPU wall-clock (task-model authoring only): 30.2 min (1810412 ms across 19 evaluate() calls, 19 of which authored)
Judge wall-clock (network, not GPU): 0.4 min
Reflection: 0 calls, 0.0 min, $0.0000
Cache hit rate: 0.0% (0/19)
0% is expected here, not a caching bug (defect 3): every candidate instruction is unique text freshly written by the reflection model, so no two evaluate() calls in a run share an (instruction, story) key — except the minibatch cases reappearing in a child's post-accept full-train pass, and those are already short-circuited by evaluateFullSplit's in-memory `reuse` map before they ever reach the disk cache. See the header note in optimise.ts for the full argument; the cache's real payoff is a second run reusing the seed's own baseline authoring, not repeats inside one run.
Winner prompts saved: 19/19 to probe/gepa/runs/sweep-C-b4096-s1/winner-prompts/

## Concurrency
Bound: 4 (must track the llama.cpp server's --parallel slot count)
Pool wall-clock: 8.4 min · summed call time (author + judge): 30.6 min · achieved parallelism: 3.62x
(Reflection is excluded — it is one serial `claude -p` call per iteration, never pooled.)
