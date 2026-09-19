# GEPA probe

Optimising ONE instruction — preset A's `DEFAULT_TEMPLATES.draft` — against the
judge in `src/lib/judgeRubric.ts`, so the single-call path can be compared with
preset B's three calls.

## Three models, three places

| role | model | where | notes |
| --- | --- | --- | --- |
| **task** | `swift-uncensored-27b` | local 5090 | the prompt is optimised FOR this model |
| **reflection** | `claude -p` | Claude subscription | rewrites the instruction; never ships |
| **judge** | `~typesafe/jev-latest` | OpenRouter `/api/alpha/decisions` | `probe/judge/` |

The task model is not interchangeable. Prompt optimisation learns a specific
model's failure modes, so tuning against a different one keeps only the
generic half of the improvement, with no way to tell which half you got.
Founder directive 2026-09-19: swift-uncensored-27b is the default going
forward.

The reflection model is called roughly once per iteration and never touches
production, so it can be the strongest model available.

## `claude -p` as a text function

`reflect()` locks it down three ways, and the third is the one that bites:

```
--allowedTools ""     deny tools
--max-turns 1         one turn
--system-prompt ...   REPLACE the agentic system prompt   <-- load-bearing
```

The first two alone do not work. `--allowedTools ""` denies tools without
removing them, so the model still reaches for one, the denial consumes its
single turn, and `claude -p` exits 1 with **empty stderr** and
`"stop_reason":"tool_use"` in the JSON on stdout. Short prompts succeed and
real ones fail, which reads like a prompt-length or working-directory problem
and is neither.

## Cost

Each call carries ~31k tokens of Claude Code scaffolding regardless of prompt
size, and replacing the system prompt does not shrink it. Caching is what makes
it affordable:

```
first call   $0.32   (cache_creation ~31k)
later calls  $0.02   (cache_read     ~31k)    ~19x cheaper
```

A 20-iteration run is roughly $0.35–0.65 **provided it stays inside the cache
TTL (1 hour)**. Iterations spread thinly across hours pay creation repeatedly.

## Budget

Not 300 rollouts. For one module against 19 examples:

```
baseline eval on the trainset      ~12 rollouts
20 iterations x minibatch of 4      ~80
final eval of the Pareto front      ~36
                                   ~130  ≈ 65 min GPU
```

Rollouts cache (same instruction + same example), and with ~12 training
examples the statistics cap the useful budget before compute does. Start at 10
iterations and extend only if the curve is still climbing.

## Why this is worth doing

Measured on 19 prompts from three older projects (`probe/pipeline/runs/`):

```
old 0.643    preset A 0.649    preset B 0.698
```

Preset B wins 13/19 against A and 15/19 against old. **Preset A does not beat
the old pipeline at all** — 10/19, a coin flip. So the question is not merely
"can GEPA close A→B"; it is whether the one-call path is worth having, given B
costs ~4x the wall clock (39.7s vs 158.2s for two clips).

What GEPA can plausibly fix: A's failures are omissions — 3 of 7 shots on one
clip, camera 0.23 on another — and omissions respond to instruction changes.
What it probably cannot: B's direction call is JSON-schema'd, so the model
literally cannot omit `cameraMovement` for shot 3, and no wording makes a
requirement unskippable inside free prose.

Output is **preset C**. Preset A stays frozen as the control.
