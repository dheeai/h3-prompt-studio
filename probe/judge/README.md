# Judge probe

Score one rendered H3 prompt against the GEPA rubric (`src/lib/judgeRubric.ts`)
via Jev, TypeSafe's System One model. The only place in this codebase a
request from `src/lib/judge.ts`/`judgeRubric.ts` actually leaves the process —
those two files are pure (no `fetch`, no network, no new dependency); this
script is the network edge.

```sh
npx tsx probe/judge/judge.ts <prompt-file> [--mode Ref2VA] [--plan plan.json]
                             [--via typesafe|openrouter] [--repeat N]
```

`--plan` is `{ clipSeconds, approvedShots: [{ index, summary, seconds }], hasCharacters? }`.
**Pass it whenever one exists.** Without it `approvedShots` is empty, so every
`'shot'`-scoped question and both per-shot fan-outs (action-chain, sound
coverage) have nothing to pair against and are skipped — roughly a third of
the rubric goes quiet. That is `appliesWhen`/`shotIndex` working as designed,
not a failure, but the script prints a `note:` when it happens so it is never
silent.

`hasCharacters` **defaults to `true`** when the plan omits it — most clips
have people in them, so a caller opts OUT deliberately (a landscape
flythrough, an architectural drone shot, a product shot with no hands) by
setting it `false`, which drops every acting question and the two
character-dependent direction questions (`objective-stated`,
`obstacle-concrete`) out of their dimension's denominator rather than scoring
them a manufactured zero.

`--repeat N` re-sends the identical request N times and reports the spread.

## Two transports, one body

Jev is reachable directly or through OpenRouter. The request body is
byte-identical; only the URL, the key and the model id differ — which is why
`buildJudgeRequest` takes the model as a parameter.

| via | endpoint | model | key |
| --- | --- | --- | --- |
| `typesafe` | `POST api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `POST openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `LLM_JUDGE_API_KEY` or `OPENROUTER_API_KEY` |

With no `--via`, whichever key is present wins. A value beginning `local` is
treated as absent: sibling projects set `OPENAI_API_KEY=local-no-key` when
pointed at a llama.cpp gateway, and that is a placeholder, not a key.

**On OpenRouter a decisions model is not a chat model.** It never appears in
`GET /v1/models` (chat only), and `/chat/completions` refuses it with a 400
saying so. Searching the model list, finding nothing and concluding the model
is unavailable is a mistake worth not repeating. OpenRouter also returns
`usage.cost`, which the native endpoint does not.

The script refuses to run without a usable key, with one clear message,
rather than falling back to a fake response — a hand-built `answers` map would
only prove the plumbing works against itself. Everything in
`src/lib/judge.test.ts` and `judgeRubric.test.ts` is verified without network
for exactly that reason.

## Measured, on real prompts

Two third-party MiniMax H3 prompts, judged through this probe:

| prompt | weighted total | requests | input tokens | cost | wall |
| --- | --- | --- | --- | --- | --- |
| a careful 15s parkour one-take | **0.821** | 2 | 4,305 | $0.000181 | ~800ms |
| the same genre written badly | **0.231** | 6 | 5,444 | $0.000229 | ~2.3s |

The rubric separates them by 3.6x, and each read holds up individually: the
bad prompt scores `generic-filler` p=0.94, `camera.vague-language` p≈0.96,
`camera.five-elements` 0.00 on every shot, and `acting.observable-not-labeled`
0.03–0.15 where it names emotions outright.

**Jev is not deterministic.** Per question the spread is about ±0.05
(one question read 0.28 / 0.33 / 0.30 across three runs). Aggregated over a
whole rubric it is far tighter — three runs of the parkour prompt gave
0.819 / 0.821 / 0.823, ±0.002 — because averaging ~17 questions cancels most
of the per-question noise. A GEPA delta smaller than the spread is noise;
`--repeat` is how you measure it on your own rubric.

### Two things this measurement exposed

`shots.fragments-match-plan` scores **1.00 for the bad prompt and 0.20 for the
good one** — the bad one carries all five `[Shot N]` markers and the good one
writes four of its beats as bare `From 00:03.000`. That is correct: an exact
check measures structure, never merit. Do not "fix" it by making it a quality
judgement.

`pacing` does **not** discriminate — 0.697 good against 0.727 bad, i.e. it
scored the worse prompt higher (and 0.857 on a prompt with no shot markers at
all — it ranked the *least* structured prompt highest of the three). Its
exact check was structural and its two model questions were weak.

**RESOLVED.** The two model questions above (`varied-rhythm`, `escalation`)
asked Jev to infer tempo from prose, which is exactly the "Jev cannot count"
failure mode this rubric otherwise guards against everywhere else.
`pacing.varied-rhythm` is deleted; `pacing.escalation` moved to `direction`
(a dramaturgy question, not a pacing one — filed under pacing it was scoring
things like "Dramatic and epic ending" as if that were rhythm) as
`direction.escalation`, wording unchanged. Pacing's replacement is entirely
computed from the prompt's own timeline — `pacing.rhythm-variance` (the
coefficient of variation of segment durations), `pacing.no-flash-frames`
(any segment under a floor), `pacing.no-monolith` (one segment dominating the
clip) — plus one qualitative judgement, `pacing.shot-earns-its-length` (does
a shot's held length earn itself, asked with no numbers in the instruction).
The table above predates this change; these numbers were never re-measured
against the new dimension — do that before trusting it.

The timeline itself is read from whichever notation the prompt actually
used — `[Shot N] At MM:SS.mmm` markers, or (measured: an FPV drone brief with
no shot markers at all) explicit `M:SS-M:SS` ranges written directly in the
prose. A prompt with neither scores these checks **0, not `null`** — a
missing timeline is a real defect in an H3-destined prompt, and letting it
drop out of the denominator would raise the score of the prompt with the
least structure, which is exactly the failure this table documents. See
`PacingTimeline`'s own comment in `judgeRubric.ts` for the full
three-outcome contract.

That same FPV drone brief with no shot markers also exposed a second gap,
fixed alongside this one: with no `[Shot N]` markers, every camera question
(all four were shot-scoped) reported "not applied", 0 of 4 — no matter how
good the camera writing was. `camera.specified-overall` is the one
PROMPT-scoped camera question added to cover this, and `hasCharacters` (see
above) covers a third gap the same brief exposed: it has no people in it, so
every acting question and two character-dependent direction questions used
to score a manufactured near-zero rather than reporting "not applicable".

## Sound — a shot's own claim, not a footnote on the clip

`overall_soundscape` is a clip-level field, so nothing checked it actually
accounted for each shot until this dimension existed. `sound` adds:

- `sound.shot-covered.N` — a per-approved-shot fan-out, one question per shot,
  generated by `buildSoundCoverageQuestions` (parallel to `shots.chain.N`'s
  action-chain fan-out, but a separate family). Asks whether that beat's
  sound — from `overall_soundscape` OR from its own dialogue, since dialogue
  counts as part of a shot's sound — matches what happens in it, or whether
  the prompt explicitly and deliberately states the beat is silent (silence
  that is merely unaddressed does not count). **Scoped `'prompt'`, not
  `'shot'`**, unlike `shots.chain.N`: answering it needs the beat's action
  AND the clip-level soundscape at once, which a single shot fragment does
  not carry. It also names each beat by its **plan summary**
  (`shot.summary`), not a `[Shot N]` marker — sound coverage is a property of
  the beat the plan describes, not of whatever notation the prompt used for
  it (some carry none at all — see the pacing section above).
- `sound.synced-to-events` — is an effect tied to a visible event (a
  footfall, an impact, a latch, a door) rather than generic ambience.
- `sound.every-moment-accounted` — is the whole clip's sound accounted for,
  audibly or by deliberate silence. Phrased unconditionally on purpose — not
  "where there is silence, is it deliberate", which is a vacuously-true
  conditional on a clip with no silence at all, and Jev evaluates questions
  independently.
- `sound.sources-concrete` — exact, wraps `lint()`'s existing `audio/concrete`
  finding rather than re-implementing it. `null` when no `overall_soundscape`
  field exists to check, never 0.

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
