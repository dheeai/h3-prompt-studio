# Direct thinking-toggle model evaluation design

**Status:** Scope-corrected and approved for implementation planning

**Tracking:** [#23](https://github.com/dheeai/h3-prompt-studio/issues/23) tracks this eval. [#22](https://github.com/dheeai/h3-prompt-studio/issues/22) is closed as not planned because an in-app thinking setting is outside this scope.

## Goal

Measure the effect of the llama-compatible `chat_template_kwargs.enable_thinking` request flag on the three selected local models for the H3 Prompt Studio’s eight important stage contracts. The evaluation must use fixed prepared inputs, exactly one direct HTTP request per case arm, deterministic validators, and a blinded qualitative review without claiming that subjective scores are objective.

## Scope correction

This work is an evaluation harness only. It does not add or modify an app Settings control, Provider type, Studio request client, Pi Agent adapter, system prompt, stage template, UI component, persistence migration, or ComfyUI integration. No production app file is changed for the thinking flag.

The harness may import existing pure prompt-assembly functions—`buildContext`, `buildStudioSystemPrompt`, `templateFor`, `fillTemplate`, `filmBlock`, and the existing lint/parsing helpers—so that requests resemble the current app. These are read-only dependencies. The harness itself sends the request directly to the configured llama endpoint and never routes through the browser UI, `streamChatComplete`, React state, IndexedDB, the Agent, or ComfyUI.

## Direct request contract

Each variant makes one POST to:

`https://YOUR_GATEWAY_HOST/llama/v1/chat/completions`

The request body is exactly the normal OpenAI-compatible fields needed by the eval plus the thinking arm:

```json
{
  "model": "thinkingcap-27b",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "temperature": 0.2,
  "max_tokens": 8192,
  "stream": true,
  "chat_template_kwargs": { "enable_thinking": true }
}
```

The boolean is `false` for the off arm. The evaluator sends no Authorization header, does not retry a non-2xx response, does not continue a `length` response, and does not recover an answer from a thinking-only response. A failed response is one recorded failure, not a reason to issue another request.

## Models and matrix

Run exactly these model IDs, in this outer order:

1. `default` — the gateway’s loaded Ornith alias.
2. `thinkingcap-27b` — the selected ThinkingCap model.
3. `qwen38-heretic-27b-fast` — the selected Qwen Heretic Fast model.

For each model, iterate the eight cases in fixture order and run `enable_thinking: true` immediately followed by `enable_thinking: false`. The full matrix is exactly `8 × 3 × 2 = 48` POSTs. `ornith-35b` is not included because the gateway reports it as the same underlying Ornith weights as `default`.

Fixed request settings are `temperature: 0.2`, `max_tokens: 8192`, and `stream: true`. The server may remain nondeterministic at temperature 0.2; the controlled comparison is the identical fixture, message assembly, order, and request shape, not exact-token reproducibility.

## Prepared context and message assembly

Every case selects the same shipped primary skill files:

```ts
{
  'h3-acting': ['SKILL.md'],
  'h3-direction': ['SKILL.md'],
  'h3-prompting': ['SKILL.md'],
}
```

The evaluator loads those files from `dist/skills`, constructs the existing `Skill` values, calls `buildContext`, and uses `buildStudioSystemPrompt(context, studioMode)`. It creates the user message with the existing `templateFor({}, stage)` and `fillTemplate`, passing the fixture’s `story`, `current`, `previous`, `filmBlock`, `notes`, `findings`, `standing`, and H3 mode. No case consumes another case’s output.

## Eight isolated cases

Each case definition includes a concrete source/current document, film context, previous canonical prompt where relevant, expected H3 mode, and named deterministic validators.

| ID | Stage and entry mode | Fixture and hard checks |
|---|---|---|
| `scene-breakdown` | `breakdown`, Scene (Multi-shot), Ref2VA | “At dawn, Maya crosses an empty railway platform carrying a red paper lantern. She hears a train that never arrives, finds a child’s drawing pinned to the bench, and leaves the lantern lit beside it as first light reaches the tracks. No dialogue. Divide it into exactly three clips of 3 seconds.” Require valid breakdown JSON, exactly three 3-second clips, ordered actions, and a handoff state at each boundary. |
| `scene-middle-closing-direction` | `direct`, Scene (Multi-shot), Ref2VA | Lantern-film spine. Clip index 1 `precedes`: “Maya has found the drawing and is holding the unlit lantern beside the bench.” `covers`: “She listens for the absent train, unfolds the drawing, and understands it.” `follows`: “She carries the lantern to the end of the platform and leaves it lit.” Require neighboring states, no re-establishment of the platform/discovery, and no premature lantern placement. |
| `clip-direction-acting-heavy-two-hander` | `direct`, Clip, Ref2VA | “In a quiet kitchen after their father’s funeral, two adult sisters argue over who will take his worn blue coat. The older sister says, verbatim, ‘You only want it because he forgave you.’ The younger sister takes the coat, cannot put it on, and sets it back down. One continuous 7-second shot.” Require verbatim dialogue, two observable performances, one continuous action, and no added characters/resolution. |
| `clip-t2va-draft-from-direction-sheet` | `draft`, Clip, T2VA | Direction sheet for a street magician hiding a coin from a skeptical child; no references; 6 seconds; the child stays skeptical and the coin ends in the magician’s closed fist. Require canonical H3 fields in the expected order, T2VA-compatible content, temporal beats, and no reference-only fields. |
| `prompt-revise` | `revise`, Prompt, Ref2VA | Canonical prompt fixes a woman opening a greenhouse door at night, a moth landing on her wrist, and the ending on her hand turning the latch. Note: “Make the reaction readable in the middle beat; preserve the action, ending, and all named objects.” Require exactly one non-empty `<<<PROMPT>>>` block followed by one non-empty `<<<EXPLANATION>>>` block, preserved fixed facts, and no `<<<CHANGES>>>` block. |
| `prompt-rebuild` | `rebuild`, Prompt, Ref2VA | Same greenhouse prompt. Note: “Rebuild the direction for stronger acting and camera motivation, but keep the woman, greenhouse, night, moth, wrist landing, latch ending, and no dialogue.” Require the same two-block contract, preserved fixed facts, materially rethought directing, and no new event or ending. |
| `continuation-planning` | `handoff`, Scene (Multi-shot), Ref2VA | Previous canonical prompt ends with Maya’s lantern beside the drawing. Next clip opens on the flame bending in the wind while the train remains absent. Require bounded `precedes`, `follows`, and open-beat fields, no recreation of the previous clip, no new spine, and no resolved train arrival. |
| `continuation-prompt-authoring` | `draft`, Scene (Multi-shot), Ref2VA | Previous canonical sentinel: “PREVIOUS_CANONICAL_SENTINEL: Maya leaves the lantern lit beside the drawing.” Film context opens on the bending flame; Maya walks away while the flame remains visible. Require inherited opening state, no repeated placement action, absent train preserved, and the stated next handoff. |

## Stream capture

The pure stream reader preserves separate `reasoning`/`reasoning_content` deltas, inline `<think>…</think>` blocks, final `finish_reason`, usage when supplied, elapsed time, and time-to-first-token. It consumes a terminal `data:` frame even when llama closes without the optional blank-line separator. It records `unterminatedThink` but never starts a recovery request.

Raw artifacts use one JSON object per line at `eval/out/2026-09-03-thinking-toggle/raw.jsonl`. A record contains case ID, family, stage, entry mode, model, thinking boolean, hashes of fixture/system messages, redacted request body, complete content/reasoning, finish reason, usage, elapsed time, TTFT, `requestCount: 1`, `continuations: 0`, deterministic findings, `qualitative: null`, and errors. Authorization headers and environment-derived secrets never enter the file.

## Deterministic scoring

The scorer emits hard findings for:

- one-request protocol, valid SSE termination, and explicit HTTP/network errors;
- request boolean matching the arm, unterminated thinking, empty answer, and finish reason;
- breakdown JSON or handoff/prompt replacement marker contracts;
- required H3 fields and field order;
- clip count, seconds, timecodes, and neighboring states;
- continuation opening state, no re-establishment, no repeated prior action, and no premature resolution;
- fixed facts, verbatim dialogue, two-hander acting, sound/music constraints;
- repeated paragraphs, repeated markers, repeated stage-contract headers, and “I will continue/retry” loop language.

`summary.csv` and `summary.json` contain one row per case/model/arm and paired on/off deltas. They include content/reasoning token counts, latency, TTFT, contract pass/fail, and each validator result. A full matrix is complete only when 48 rows exist; partial failures remain explicit rows.

## Blinded qualitative review

The reviewer sees anonymized output IDs and not model names, thinking values, or execution order. Each output receives a 1–5 score for instruction following, directing, acting specificity, H3 usability, continuity, and concision. The report presents distributions and observations while stating that these are structured human judgments, not objective quality measurements. A dimension can be marked `unscorable` with a reason when a hard contract failure prevents review.

## Acceptance criteria

1. The repository adds only the eval harness, deterministic test coverage, captured eval artifacts, and the dated report; no app Settings/Provider/Studio/Pi/ComfyUI implementation is added.
2. The full runner expands to exactly 48 variants, sends the direct `chat_template_kwargs.enable_thinking` boolean, and issues at most one POST per variant.
3. `--thinking on` and `--thinking off` each run only the requested arm for targeted smoke runs; omitting the flag runs both arms. The full command therefore runs both arms without requiring an unsupported `both` value.
4. Raw JSONL, summary CSV/JSON, deterministic findings, and the dated Markdown report are written without secrets.
5. Existing self-tests, type-check, production build, and whitespace checks remain green.
6. No ComfyUI endpoint or GPU operation is called by the harness.

## Limitations

The three model IDs do not represent three independent weight families because `default` and `ornith-35b` are aliases of the same Ornith weights, and temperature 0.2 may vary outputs. Deterministic validators measure contract and continuity properties, not cinematic taste. The qualitative rubric is blinded and structured but remains subjective. A request failure is recorded and not retried, so the report reflects the exact one-attempt reliability observed.
