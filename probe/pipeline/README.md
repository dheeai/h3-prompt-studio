# Pipeline smoke probe

One live run of the whole authoring pipeline against a local llama.cpp model.
No video, no ComfyUI — the point is to prove the templates, grammars and
parsers work against a real model, which 606 unit tests cannot.

```sh
U=$(grep -o 'VITE_LOCAL_LLM_URL=.*' .env.local | cut -d= -f2-)
LLM_URL="$U" LLM_MODEL=swift-uncensored-27b npx tsx probe/pipeline/smoke.ts
```

It exercises: beats -> allocation -> per-beat subdivision -> grouping ->
direction -> acting -> directed draft -> film-look injection -> splitting the
prompt back onto its shots.

## Two things it must keep doing, because getting either wrong invalidates the run

**Send the reasoning budget.** It goes through the app's own
`withQwenReasoningBudget`, so the run matches what the app sends
(`reasoning_budget_tokens: 1024` plus a stop-thinking message, for any model on
a local llama.cpp endpoint). The first version of this script omitted it, and
the difference is not marginal:

| call | unbounded | budgeted |
|---|---|---|
| direction | 127.6s, 14,127 completion tokens | 34.1s, 2,958 |
| directed draft | 147.0s, 20,005 | 21.7s, 1,995 |
| whole run | 482.6s | 195.6s |

Without the budget, preset B looked 3.8x over the render budget. That was the
harness.

**Send each stage's skill corpus**, mirroring `context.ts`'s `STAGE_SKILLS`:
`direction` -> h3-direction, `acting` -> h3-acting, the draft -> h3-prompting.
The beats and subdivide calls deliberately get NOTHING, per `shotList.ts`'s own
comment. With no corpus, the draft emitted **no `[Shot N]` markers at all**, so
the prompt could not be split onto its shots and the whole shot-level
presentation got nothing. With h3-prompting attached it split 5 fragments for 5
planned shots with zero marker issues. The format document is load-bearing, not
optional.
