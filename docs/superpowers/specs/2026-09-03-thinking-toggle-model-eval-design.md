# Thinking toggle and local-model evaluation design

**Status:** Approved for implementation planning

**Tracking:** [#22](https://github.com/dheeai/h3-prompt-studio/issues/22) tracks the persisted thinking setting and request transport. [#23](https://github.com/dheeai/h3-prompt-studio/issues/23) tracks the reproducible model evaluation and report.

## Goal

Give the operator one global, persisted thinking switch that controls both Studio and the browser Pi Agent, then measure the switch across the three local models that are actually exposed by the 5090 llama gateway. The evaluation must compare identical prepared requests, keep every run finite, and produce evidence that distinguishes request/contract failures from subjective prompt-quality differences.

## Non-negotiable behavior

- `Settings.thinkingEnabled` is a boolean with a default of `true`. It is persisted with the existing browser settings record and is shared by Studio and Agent.
- Studio sends `chat_template_kwargs: { enable_thinking: settings.thinkingEnabled }` only when the selected Provider explicitly advertises `supportsThinkingToggle: true`. Providers without that capability receive the existing request shape and no unknown field.
- The built-in llama.cpp provider advertises the capability. A custom provider has an explicit “supports Qwen chat-template thinking” capability choice; URL matching alone never opts an arbitrary provider into an unknown request field.
- Pi Agent uses `thinkingFormat: 'qwen-chat-template'` for a provider with that capability and maps the same boolean to its reasoning level: enabled is a non-`off` level, disabled is `off`. Unsupported providers use Pi’s ordinary OpenAI compatibility and do not receive the Qwen field.
- The switch changes only thinking transport. It does not change selected skills, Studio mode, stage templates, continuation context, canonical prompt storage, ComfyUI payloads, or the stop/partial-thinking retention behavior.
- The evaluation never invokes the app continuation loop, output-limit retry, recovery request, or another hidden call. One case variant means one HTTP POST.
- No ComfyUI request or GPU render is part of this feature or evaluation.

## Current system and boundary

The browser already has one OpenAI-compatible streaming client in `src/lib/llm.ts`, one persisted `Settings` object in `src/app/state.tsx`, and a Pi Agent model adapter in `src/lib/agent.ts`. `buildH3SystemPrompt`, `templateFor`, and `fillTemplate` already provide the system/stage/context assembly needed by Studio. The new capability belongs at the provider boundary, not in stage prompts: prompt text cannot reliably turn Qwen-style reasoning on or off.

The evaluation is a separate Node/TypeScript harness. It imports pure prompt assembly and validator helpers from `src/lib`, reads the shipped skill files from `dist/skills`, and uses a single raw streaming `fetch` per variant. It does not import React state, IndexedDB, ComfyUI clients, or the app continuation helper.

## Data model

The implementation adds these exact fields:

```ts
// src/lib/types.ts
export interface Provider {
  // existing fields remain unchanged
  supportsThinkingToggle?: boolean
}

export interface Settings {
  // existing fields remain unchanged
  thinkingEnabled: boolean
}
```

`supportsThinkingToggle` is optional for backwards-compatible persisted providers. Missing means `false`. `DEFAULT_PROVIDERS.llamacpp` sets it to `true`; the other built-ins set it to `false`. The custom-provider form writes the field from the explicit capability control.

`DEFAULT_SETTINGS.thinkingEnabled` is `true`. The settings schema increments from `4` to `5`; migration preserves an existing explicit boolean and supplies `true` when the field is absent or malformed. The migration does not alter model, temperature, output length, stage overrides, skills, recipes, endpoints, or draft state.

## Studio request contract

`StreamOptions` gains one optional transport flag derived by the caller:

```ts
export interface StreamOptions {
  // existing fields remain unchanged
  thinkingEnabled?: boolean
}
```

`streamChat` constructs its existing body first. When and only when `provider.supportsThinkingToggle === true` and `thinkingEnabled` is a boolean, it adds:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": true
  }
}
```

The value is `false` when the switch is off. The body retains `model`, `messages`, `temperature`, `stream`, the configured `max_tokens` shape, and the existing opt-in `cache_prompt` behavior. It does not add this field to OpenRouter, Ollama, LM Studio, or an unmarked custom provider. Existing `retryOnLimit` remains available to ordinary Studio stages, but the evaluation calls the lower-level one-request path with retries disabled.

`src/app/state.tsx` passes `thinkingEnabled: settings.thinkingEnabled` to `streamChatComplete`. Prompt Revise/Rebuild continue to pass `retryOnLimit: false` and `maxContinuations: 0`; Scene, Clip, and continuation keep their current bounded internal orchestration. Thinking deltas continue to update the visible stream and stopped/failed reasoning remains in the existing retention fields.

## Agent request contract

`buildAgentModel(provider, modelId, thinkingEnabled)` returns the existing Pi model shape with these exact compatibility rules:

```ts
const localCompat = {
  supportsStore: false,
  supportsDeveloperRole: false,
  supportsReasoningEffort: false,
  maxTokensField: 'max_tokens' as const,
  supportsUsageInStreaming: true,
  supportsStrictMode: false,
  thinkingFormat: 'qwen-chat-template' as const,
}
```

The Qwen compatibility is selected only when `provider.supportsThinkingToggle === true`; otherwise `thinkingFormat` remains the ordinary OpenAI value. `AgentPanel` initializes Pi with `thinkingLevel: settings.thinkingEnabled ? 'high' : 'off'` for the capable provider, and `off` for an incapable provider. The selected setting/model/provider remain refs so changing a setting does not discard an active transcript. The Agent’s deterministic tools, confirmation gates, and no-recursive-stage contract remain unchanged.

## Settings UI and persistence

The Output tab in `src/components/SettingsPanel.tsx` adds one control under Model parameters:

- Label: `Thinking`
- On state: `On — model reasoning is streamed before the answer`
- Off state: `Off — request an answer without model reasoning`
- Action: `patchSettings({ thinkingEnabled: !settings.thinkingEnabled })`

When the active provider does not support the transport, the control remains visible (so the global preference is not hidden) and displays `Provider does not expose the thinking switch; request field omitted.` The setting is still saved and takes effect automatically when the operator selects a capable provider. The custom-provider editor exposes the matching capability checkbox and explains that it is for llama.cpp/Qwen chat-template-compatible servers.

## System-prompt policy

No stage prompt will contain instructions such as “think forever,” “repeat until perfect,” or a fake thinking mode. The existing mode-specific contracts stay distinct:

- Scene (Multi-shot): breakdown, neighboring states, and continuity-safe clip direction.
- Clip: one standalone prompt, including acting specificity when the selected skills require it.
- Prompt: one Revise or Rebuild replacement plus explanation.
- Continuation: explicit previous canonical prompt and ending state, without re-establishing the preceding action.

The switch is transport-level state and is not included in the user message. This keeps the app’s skill/context prefix and stage contracts identical between paired runs.

## Evaluation scope

The harness runs exactly eight isolated cases. Each case has a prepared upstream fixture containing the story/idea, current document, film context, previous canonical prompt when relevant, notes, deterministic findings, selected skills, Studio mode, H3 mode, and stage. A case never consumes another case’s response.

Every case runs against exactly these three model IDs:

1. `default` — the loaded Ornith alias exposed by the gateway, context window 262,144.
2. `thinkingcap-27b` — ThinkingCap, context window 262,144.
3. `qwen38-heretic-27b-fast` — Qwen Heretic Fast, context window 32,768.

Each model runs twice, adjacent in this order: `enable_thinking: true`, then `enable_thinking: false`. The total is `8 × 3 × 2 = 48` POSTs. `ornith-35b` is not a fourth primary model because the gateway reports it as the same underlying Ornith weights as `default`.

### Fixed request settings

- Base URL: `https://5090.tail3cca41.ts.net/llama/v1`, overridable only through an explicitly recorded `H3_EVAL_BASE_URL` environment variable.
- `temperature: 0.2`.
- `max_tokens: 8192`.
- `stream: true`.
- Provider capability: `supportsThinkingToggle: true`, so every variant contains the boolean request field.
- No API key is written to artifacts or logs.
- One POST, one streamed response, no retry, no continuation, no thinking recovery, and no output-limit fallback.
- Runs are sequentially grouped by model, with thinking on/off adjacent for each case.

### Shared skill fixture

Every case uses the same selected primary files, loaded in the app’s stable order:

```ts
{
  'h3-acting': ['SKILL.md'],
  'h3-direction': ['SKILL.md'],
  'h3-prompting': ['SKILL.md'],
}
```

The evaluator reads these exact files from `dist/skills`, calls `buildContext`, then constructs the system message with `buildStudioSystemPrompt`. It constructs the user message with `templateFor({}, stage)` and `fillTemplate` using the fixture’s exact `story`, `current`, `filmBlock`, `previous`, `standing`, `findings`, and `notes` values. This makes the paired request messages and only the model ID/boolean differ.

### The eight isolated cases

| ID | Stage and mode | Prepared fixture and hard checks |
|---|---|---|
| `scene-breakdown` | `breakdown`, Scene (Multi-shot), Ref2VA | Story: “At dawn, Maya crosses an empty railway platform carrying a red paper lantern. She hears a train that never arrives, finds a child’s drawing pinned to the bench, and leaves the lantern lit beside it as first light reaches the tracks. No dialogue. Divide it into exactly three clips of 3 seconds.” Require valid breakdown JSON, exactly three clips, 3-second durations, ordered actions, and a handoff state for each boundary. |
| `scene-middle-closing-direction` | `direct`, Scene (Multi-shot), Ref2VA | Story and film spine are the lantern story. Clip index 1 is the middle clip; `precedes` is “Maya has found the drawing and is holding the unlit lantern beside the bench.” `covers` is “She listens for the absent train, unfolds the drawing, and understands it.” `follows` is “She carries the lantern to the end of the platform and leaves it lit.” Require explicit neighboring states, no re-establishment of the platform/discovery, and no premature lantern placement. |
| `clip-direction-acting-heavy-two-hander` | `direct`, Clip, Ref2VA | Idea: “In a quiet kitchen after their father’s funeral, two adult sisters argue over who will take his worn blue coat. The older sister says, verbatim, ‘You only want it because he forgave you.’ The younger sister takes the coat, cannot put it on, and sets it back down. One continuous 7-second shot.” Require the dialogue verbatim, two distinct observable performances, one continuous action, and no added characters or resolution. |
| `clip-t2va-draft-from-direction-sheet` | `draft`, Clip, T2VA | Current direction sheet for a street magician hiding a coin from a skeptical child; no reference images; duration 6 seconds; the child must remain skeptical and the coin must end in the magician’s closed fist. Require canonical H3 fields in the app’s expected order, `T2VA` compatibility, visible temporal beats, and no reference-only fields. |
| `prompt-revise` | `revise`, Prompt, Ref2VA | Current canonical prompt fixes a woman opening a greenhouse door at night, a moth landing on her wrist, and the ending on her hand turning the latch. Note: “Make the reaction readable in the middle beat; preserve the action, ending, and all named objects.” Require exactly one non-empty `<<<PROMPT>>>` block followed by one non-empty `<<<EXPLANATION>>>` block, preserved fixed facts, and no `<<<CHANGES>>>` block. |
| `prompt-rebuild` | `rebuild`, Prompt, Ref2VA | The same canonical greenhouse prompt and note: “Rebuild the direction for stronger acting and camera motivation, but keep the woman, greenhouse, night, moth, wrist landing, latch ending, and no dialogue.” Require the same two-block contract, preserved fixed facts, materially rethought directing, and no new event or ending. |
| `continuation-planning` | `handoff`, Scene (Multi-shot), Ref2VA | Previous canonical prompt ends with Maya’s lantern placed beside the drawing; film context says the next clip opens on the lantern flame bending in the wind, with the train still absent. Require a bounded handoff containing `precedes`, `follows`, and an open beat, no recreation of the previous clip, no new film spine, and no resolved train arrival. |
| `continuation-prompt-authoring` | `draft`, Scene (Multi-shot), Ref2VA | Previous canonical prompt sentinel: “PREVIOUS_CANONICAL_SENTINEL: Maya leaves the lantern lit beside the drawing.” Film context: opening state is the bending flame; current action is Maya walking away while the flame remains visible. Require a canonical prompt that includes the inherited opening state, does not repeat the previous placement action, preserves the absent train, and ends at the stated next handoff. |

## Capture format

`eval/run-thinking-eval.ts` writes one JSON object per line to `eval/out/2026-09-03-thinking-toggle/raw.jsonl` for the documented run. The request body is recorded after removing authorization headers and any environment-derived secret. Each record has this shape:

```ts
interface RawEvalRecord {
  eval: 'studio-thinking-v1'
  caseId: string
  family: 'scene' | 'clip' | 'prompt' | 'continuation'
  stage: StageId
  studioMode: 'story' | 'idea' | 'prompt'
  model: 'default' | 'thinkingcap-27b' | 'qwen38-heretic-27b-fast'
  chatTemplateKwargs: { enable_thinking: boolean }
  settings: { temperature: 0.2; maxTokens: 8192; h3Mode: H3Mode; selectedSkills: string[]; inputHash: string; systemHash: string }
  request: { url: string; body: Record<string, unknown> }
  response: { content: string; reasoning: string; finishReason: string | null; usage: { prompt?: number; completion?: number } | null; requestCount: 1; continuations: 0; elapsedMs: number; timeToFirstTokenMs: number | null }
  deterministic: { passed: boolean; findings: { id: string; passed: boolean; detail: string }[] }
  qualitative: null
  errors: string[]
}
```

The raw record deliberately stores `qualitative: null`; the blinded reviewer enters scores later without seeing model, toggle, or run order. The runner must flush each line after the response so an interrupted run retains completed evidence.

`eval/score-thinking-eval.ts` reads `raw.jsonl` and writes `summary.csv` and `summary.json`. Each summary row contains case, model, toggle, protocol/contract pass, validator findings, reasoning/content token counts, latency, and the paired on/off delta. `docs/evals/2026-09-03-thinking-on-off-model-eval.md` is the human report and must state the run timestamp, 48 planned calls, completed/failed count, per-case failures, limitations, and that qualitative scores are not objective measurements.

## Deterministic validators

The scorer assigns hard pass/fail findings rather than a single quality number:

- Protocol: exactly one POST, no retry/continuation/recovery, valid SSE termination, and a non-empty answer unless the response explicitly records a provider error.
- Thinking transport: `chat_template_kwargs.enable_thinking` matches the arm; thinking-on may contain reasoning; thinking-off must not be marked as a contract failure merely because a provider emits incidental reasoning, but unterminated `<think>` and empty answer are failures for both arms.
- Output contract: breakdown JSON parses; canonical prompt stages have required fields/order; Revise/Rebuild have exactly the two non-empty markers and no legacy changes block; handoff has its three required fields.
- Scene/time: breakdown clip count and seconds equal the fixture; direction and continuation include explicit neighboring states and do not invent a new time span.
- Continuity: continuation opens from the supplied ending, does not re-establish a prior action, does not repeat the previous prompt sentinel as a full scene, and does not resolve an event reserved for a later clip.
- Acting/dialogue: the two-hander keeps both roles observable, preserves verbatim dialogue, and does not add dialogue where the fixture forbids it.
- Sound/music: `overall_soundscape` is present; dialogue/music rules from the selected prompting skill are not contradicted.
- Repetition/loop heuristics: fail on repeated identical paragraphs/markers, three or more adjacent repeated sentences, repeated stage-contract headers, or output that says it will continue/retry instead of completing its contract.
- H3 usability: required prompt fields are non-empty and contain observable action, temporal progression, camera/framing, performance, lighting/texture, and sound where the selected mode requires them.

## Blinded qualitative rubric

The reviewer receives anonymized output IDs, not model names, toggle values, or ordering. Each output is scored 1–5 for instruction following, directing, acting specificity, H3 usability, continuity, and concision. The report presents distributions and paired observations, never an objective “best model” claim. A reviewer may mark `unscorable` with a reason when a hard contract failure makes a dimension impossible to judge.

## Acceptance criteria

Implementation is ready when:

1. Existing self-tests still pass and new tests prove default-on migration, provider gating, exact true/false request bodies, Agent mapping, and no hidden call behavior.
2. Type-check and production build pass with no changes to ComfyUI code or GPU state.
3. The evaluator has eight case definitions, emits exactly 48 planned variants, makes at most one POST per variant, and records explicit failures instead of retrying.
4. A completed report contains raw JSONL, summary CSV/JSON, all six qualitative dimensions, deterministic validator results, limitations, and the actual completed/failed count.
5. Stop still leaves streamed reasoning visible, and the canonical prompt remains the only prompt used by the existing render path.

## Limitations

The models may be nondeterministic at temperature 0.2 unless the server itself fixes a seed; the harness therefore treats the paired run as a controlled sample, not a reproducible exact-token test. `default` and `ornith-35b` are aliases of the same underlying model and are intentionally not counted as independent model families. The deterministic validators measure contract and continuity properties, not cinematic taste. The blinded 1–5 rubric is structured human judgment, not an objective quality metric.
