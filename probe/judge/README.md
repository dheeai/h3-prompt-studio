# Judge probe

Score one rendered H3 prompt against the GEPA rubric (`src/lib/judgeRubric.ts`)
via Jev, TypeSafe's System One model. The only place in this codebase a
request from `src/lib/judge.ts`/`judgeRubric.ts` actually leaves the process —
those two files are pure (no `fetch`, no network, no new dependency); this
script is the network edge.

```sh
TYPESAFE_API_KEY=... npx tsx probe/judge/judge.ts <prompt-file> [mode]
```

`mode` is any `H3Mode` (default `Ref2VA`). This probe has no plan file, so it
judges the prompt alone — `approvedShots` is empty and `clipSeconds` is `0`,
which means every `'shot'`-scoped question and the whole per-shot
action-chain fan-out have nothing to pair against and are skipped. A real
caller (GEPA's own harness) has the plan and builds a fuller `JudgeContext`.

**There is no API key on this machine.** The script refuses to run without
`TYPESAFE_API_KEY` set, with one clear message, rather than falling back to a
fake response — a hand-built `answers` map would only prove the plumbing
works against itself. Everything in `src/lib/judge.test.ts` and
`judgeRubric.test.ts` is verified without network for exactly this reason.

## The endpoint

```
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <TYPESAFE_API_KEY>
```

One call per **scope** the rubric produced — see "scope" below — each with
its own `{ state, model, questions }` body and its own `answers` map back.
`model` is `jev-latest`, an alias that **moves**: it currently resolves to
`jev-1.13.0`, but a later release can change what answers it. Pin the
versioned id instead of the alias if a confidence threshold is ever tuned
against one specific model. `GET /v1/models` lists what an account may send.

## Budget and pricing (jev-1.13.0)

| | |
|---|---|
| Context | 64k tokens per request; 32k for `state` plus the single longest question |
| Price | $42 / Btok input ($0.042 / Mtok) — **output tokens are free** |
| Rate limits | 250,000 tokens/sec, 1,200 requests/min — adjusting dynamically, can tighten without notice |

An H3 clip prompt runs ~2,500–3,000 tokens, comfortably inside Jev's budget as
whole-clip `state`. That headroom is Jev-specific, not a property of every
System One model — see "scope" below.

## Jev cannot count, and cannot see video

Both are why this rubric looks the way it does:

- **No counting, no arithmetic, no date/duration reasoning.** Shot counts,
  marker/timestamp hygiene, and frame-grid duration checks
  (`shots.fragments-match-plan`, `shots.marker-hygiene`,
  `pacing.duration-matches-plan` in `judgeRubric.ts`) are `kind: 'exact'`
  questions that run in THIS process against existing code
  (`src/lib/promptShots.ts`, `src/lib/geometry.ts`) and never reach Jev at
  all. `buildJudgeRequest` drops every Exact question before building a
  request body. Full failure-mode writeup:
  `model-jaggedness_jev-1.13.md` §"Math and Numbers".
- **Text only — no image, audio, or video input.** Jev cannot look at the
  rendered clip, only the prompt text that describes it. Judging the actual
  RENDER (does the video look right, did the camera move the way the prompt
  said) is `xiaomi/mimo-v2.5`'s job (the `video-review`/`video-audit` skills),
  never Jev's. This probe and the rubric it drives only ever see text.

## Scope — why some questions ask about one shot, not the whole clip

Every rubric question declares `scope: 'prompt'` or `scope: 'shot'`
(`src/lib/judge.ts`'s `QuestionScope`). `buildJudgeRequest` partitions on it:
one `'prompt'`-scoped request carrying the whole clip as `state`, plus one
`'shot'`-scoped request per approved shot, each carrying only that shot's own
`[Shot N]` fragment (`splitPromptShots`) as `state`.

This exists because Jev is not the only System One model in play. A
self-hosted Laya (`convaiinnovations/laya`, Apache-2.0) exposes the identical
three primitives over the identical `{type, instructions, criteria}` shape —
but its English checkpoint's ENTIRE budget is **512 tokens** (question +
criteria + `state` combined; 1024 for its multilingual and typed-decisions
checkpoints). A ~2,500–3,000-token H3 clip prompt does not fit that budget as
a single `state` at all. Feeding Laya one shot's fragment at a time is the
only way it can judge an H3 clip, so any question that CAN be answered from
one shot alone (does this shot's action read as a chain, is this shot's
camera move motivated, does this shot's emotion read as behaviour rather than
a label) is scoped `'shot'` — portable to either vendor. A question that has
to compare shots to each other, or asks whether something is true ANYWHERE in
the clip ("does at least one shot..."), cannot be answered from a single
fragment under any budget and stays `'prompt'`.

Running this probe against Jev, scope changes nothing observable — Jev's 64k
budget has room to spare either way, and `buildJudgeRequest`/`scoreJudge`
handle the multi-request bookkeeping regardless of vendor. The split only
starts to matter the day a `'shot'`-only rubric run is pointed at a local
Laya service instead — same rubric, same scoring, a different `model` string
and a different `fetch` target in a script like this one.

## Everything else Jev cannot do

See `model-jaggedness_jev-1.13.md` for the full list (literal reading,
indirection, large irrelevant state, contradictory criteria, generation).
The rubric's own header comment (`judgeRubric.ts`) explains how each failure
mode shaped a specific question.
