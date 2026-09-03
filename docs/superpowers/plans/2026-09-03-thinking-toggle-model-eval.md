# Thinking Toggle and Local-Model Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one persisted thinking toggle shared by Studio and Pi Agent, gate its Qwen request field to explicitly compatible providers, and add a finite 48-call evaluation harness comparing the three selected local models with thinking enabled and disabled.

**Architecture:** Keep prompt assembly and canonical state in the existing Studio paths. Add provider capability metadata at the OpenAI-compatible boundary, pass a boolean through the existing streaming client, and configure Pi’s local model adapter with `qwen-chat-template`. Keep evaluation pure at the fixture/validator boundary and use one raw streaming POST per case arm so retries and continuations cannot hide failures.

**Tech Stack:** React 18, TypeScript, Vite, browser `fetch` streaming, `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`, Node via `tsx`, the existing deterministic `scripts/selftest.mjs` suite, and the 5090 llama gateway for the explicitly authorized evaluation run.

**Spec:** `docs/superpowers/specs/2026-09-03-thinking-toggle-model-eval-design.md`

## Global Constraints

- `Settings.thinkingEnabled` is a boolean with a default of `true` and is persisted with the existing browser settings record.
- Add `chat_template_kwargs: { enable_thinking: boolean }` only when `Provider.supportsThinkingToggle === true`; missing capability means the field is omitted.
- `DEFAULT_PROVIDERS.llamacpp` supports the toggle; other built-ins and unmarked custom providers do not.
- Pi Agent uses `thinkingFormat: 'qwen-chat-template'` only for a capable provider and maps enabled to a non-`off` level and disabled to `off`.
- Preserve selected skills, settings, Scene/Clip/Prompt contracts, bounded continuations, canonical prompt history, ComfyUI payloads, Stop behavior, and visible partial reasoning.
- Evaluation uses exactly eight isolated cases × `default`, `thinkingcap-27b`, `qwen38-heretic-27b-fast` × thinking true/false = 48 single-request POSTs.
- Evaluation settings are endpoint `https://5090.tail3cca41.ts.net/llama/v1`, temperature `0.2`, `max_tokens: 8192`, and `stream: true`.
- Evaluation makes no retry, continuation, thinking recovery, output-limit fallback, ComfyUI request, or GPU render.
- Evaluation artifacts redact authorization and environment secrets, and qualitative scores are blinded human judgment rather than objective measurements.
- Do not modify `dhee-core`, ComfyUI workflows, or the GPU host.

## File Map

- Create: `src/lib/settings.ts` — pure default/migration helper for the new persisted boolean.
- Modify: `src/lib/types.ts` — `Provider.supportsThinkingToggle`, `Settings.thinkingEnabled`, and the `StreamOptions` transport type in `src/lib/llm.ts`.
- Modify: `src/lib/providers.ts` — built-in capability metadata and provider capability normalization.
- Modify: `src/lib/llm.ts` — conditional `chat_template_kwargs` request field.
- Modify: `src/app/state.tsx` — schema migration and pass the saved boolean to every Studio request.
- Modify: `src/components/SettingsPanel.tsx` — global Thinking control and unsupported-provider status copy.
- Modify: `src/components/ConnectPanel.tsx` — explicit capability choice for custom providers.
- Modify: `src/lib/agent.ts` — Pi Qwen compatibility and exact model-builder interface.
- Modify: `src/components/AgentPanel.tsx` — map the shared toggle to Pi’s thinking level.
- Modify: `scripts/selftest.mjs` — red/green regressions for persistence, provider gating, request bodies, Pi mapping, fixture count, stream parsing, and validators.
- Create: `eval/cases.ts` — eight fixed case definitions, skill loader, and app-compatible message assembly.
- Create: `eval/stream.ts` — pure SSE frame parser and one-response capture helper.
- Create: `eval/run-thinking-eval.ts` — sequential 48-variant runner and redacted JSONL writer.
- Create: `eval/score-thinking-eval.ts` — deterministic validators, CSV/JSON summary writer, and report data.
- Create: `docs/evals/2026-09-03-thinking-on-off-model-eval.md` — generated human report after the authorized evaluation run.

---

### Task 1: Add the persisted setting and provider-gated Studio request field

**Files:**
- Create: `src/lib/settings.ts`
- Modify: `src/lib/types.ts`
- Modify: `src/lib/providers.ts`
- Modify: `src/lib/llm.ts`
- Modify: `src/app/state.tsx`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
// src/lib/settings.ts
export const SETTINGS_SCHEMA = 5
export const DEFAULT_THINKING_ENABLED = true
export function thinkingEnabledFromSaved(saved: { thinkingEnabled?: unknown } | null | undefined): boolean
```

```ts
// src/lib/types.ts
export interface Provider {
  // existing fields
  supportsThinkingToggle?: boolean
}

export interface Settings {
  // existing fields
  thinkingEnabled: boolean
}
```

```ts
// src/lib/llm.ts
export interface StreamOptions {
  // existing fields
  thinkingEnabled?: boolean
}
```

- [ ] **Step 1: Write failing request-shape and migration assertions.** Add to `scripts/selftest.mjs` a `fetch` stub that records `init.body`, returns a complete two-frame SSE response, and calls `streamChat` twice: once with `{ supportsThinkingToggle: true, thinkingEnabled: false }`, expecting `body.chat_template_kwargs.enable_thinking === false`, and once with `{ supportsThinkingToggle: false, thinkingEnabled: true }`, expecting no `chat_template_kwargs` key. Add `thinkingEnabledFromSaved({}) === true`, `thinkingEnabledFromSaved({ thinkingEnabled: false }) === false`, and `thinkingEnabledFromSaved({ thinkingEnabled: 'false' }) === true` assertions.

- [ ] **Step 2: Run the focused regression and confirm RED.** Run `npx tsx scripts/selftest.mjs`. It must fail because the new field/helper/request merge do not exist yet; do not call a network endpoint.

- [ ] **Step 3: Implement the minimum data and transport changes.** Add the optional provider capability and required setting type fields. Add `src/lib/settings.ts` with:

```ts
export const SETTINGS_SCHEMA = 5
export const DEFAULT_THINKING_ENABLED = true

export function thinkingEnabledFromSaved(saved: { thinkingEnabled?: unknown } | null | undefined): boolean {
  return typeof saved?.thinkingEnabled === 'boolean' ? saved.thinkingEnabled : DEFAULT_THINKING_ENABLED
}
```

Set `supportsThinkingToggle: true` only on the built-in `llamacpp` provider. In `streamChat`, after constructing the existing body, merge exactly `{ chat_template_kwargs: { enable_thinking: opts.thinkingEnabled } }` when the provider capability is true and the option is boolean. Keep all existing fields, cache behavior, and stream parser behavior unchanged.

- [ ] **Step 4: Wire migration and Studio calls without changing stage budgets.** In `src/app/state.tsx`, use `SETTINGS_SCHEMA`, initialize `DEFAULT_SETTINGS.thinkingEnabled` from `DEFAULT_THINKING_ENABLED`, preserve an existing boolean, and use `thinkingEnabledFromSaved(savedSettings)` when the persisted value is absent or malformed. Pass `thinkingEnabled: settings.thinkingEnabled` into the existing `streamChatComplete` options. Leave `retryOnLimit: !isSingleRequestStage(stage)` and `maxContinuations: continuationBudgetFor(stage)` untouched.

- [ ] **Step 5: Run the green unit/type checks.** Run `npx tsx scripts/selftest.mjs` and `npx tsc --noEmit`. Expected: all self-tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit the transport checkpoint.** Run:

```bash
git add src/lib/settings.ts src/lib/types.ts src/lib/providers.ts src/lib/llm.ts src/app/state.tsx scripts/selftest.mjs
git commit -m "feat: add provider-gated thinking transport (Fixes #22)"
```

### Task 2: Expose and persist the shared toggle in Settings and custom providers

**Files:**
- Modify: `src/components/SettingsPanel.tsx`
- Modify: `src/components/ConnectPanel.tsx`
- Modify: `src/lib/providers.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

- `ProviderCard` renders a capability checkbox only when `provider.builtIn === false` and persists `{ supportsThinkingToggle: boolean }` through `setProviders`.
- `ConnectPanel` creates a custom provider with `supportsThinkingToggle: draft.supportsThinkingToggle`.
- `SettingsPanel` toggles with `patchSettings({ thinkingEnabled: !settings.thinkingEnabled })`.

- [ ] **Step 1: Add failing pure assertions for capability defaults and copy.** Extend `scripts/selftest.mjs` to import `DEFAULT_PROVIDERS` and assert `llamacpp.supportsThinkingToggle === true`, every other built-in has a false/undefined capability, and the source of `SettingsPanel.tsx` contains `thinkingEnabled`, `patchSettings`, and the visible `Thinking` label. Assert a custom provider fixture defaults to false before the implementation is present.

- [ ] **Step 2: Run the focused suite and confirm the UI assertions are RED.** Run `npx tsx scripts/selftest.mjs` and record the missing setting-control/capability failures.

- [ ] **Step 3: Add the global Output-tab control.** Under Model parameters, render a single chip/button labeled `Thinking` with on copy `On — model reasoning is streamed before the answer` and off copy `Off — request an answer without model reasoning`. Its click handler must call exactly `patchSettings({ thinkingEnabled: !settings.thinkingEnabled })`. When the active provider lacks capability, keep the control visible and add the status text `Provider does not expose the thinking switch; request field omitted.`

- [ ] **Step 4: Add explicit custom-provider capability selection.** Extend the custom-provider draft state with `supportsThinkingToggle: false`. Add a checkbox labeled `This endpoint supports Qwen chat-template thinking` and helper text naming `chat_template_kwargs.enable_thinking`. Persist that boolean when adding the endpoint. Existing saved custom providers remain false when the optional property is absent. Built-in llama.cpp displays the capability as fixed rather than editable.

- [ ] **Step 5: Run tests and verify settings behavior.** Run `npx tsx scripts/selftest.mjs`, `npx tsc --noEmit`, and `git diff --check`. Expected: zero self-test failures, zero TypeScript errors, and no whitespace errors.

- [ ] **Step 6: Commit the UI checkpoint.** Run:

```bash
git add src/components/SettingsPanel.tsx src/components/ConnectPanel.tsx src/lib/providers.ts scripts/selftest.mjs
git commit -m "feat: expose the shared thinking setting"
```

### Task 3: Map the same boolean into Pi Agent

**Files:**
- Modify: `src/lib/agent.ts`
- Modify: `src/components/AgentPanel.tsx`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export function buildAgentModel(
  provider: { id: string; baseUrl: string; supportsThinkingToggle?: boolean },
  modelId: string,
  thinkingEnabled: boolean,
): Model
```

- For a capable provider, `compat.thinkingFormat` is exactly `'qwen-chat-template'` and the returned model has `reasoning: true`.
- For an incapable provider, the returned compatibility object has no Qwen thinking format and `reasoning` is `false`.
- `AgentPanel` passes `settings.thinkingEnabled` when building the model and initializes `thinkingLevel` to `'high'` for enabled/capable and `'off'` otherwise.

- [ ] **Step 1: Add failing Agent mapping assertions.** In `scripts/selftest.mjs`, call `buildAgentModel` with a capable provider and `false`, asserting the Qwen format exists and the model’s reasoning transport is available; call it with an incapable provider and `true`, asserting the Qwen format is absent and reasoning is disabled. Read `AgentPanel.tsx` and assert its initial state and model memo reference `thinkingEnabled`.

- [ ] **Step 2: Run the suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`. The new signature/compatibility assertions must fail before the implementation.

- [ ] **Step 3: Implement provider-aware Pi compatibility.** Extend `buildAgentModel` with the exact signature above. Add `thinkingFormat: 'qwen-chat-template'` only for a capable provider; set the returned `reasoning` field to the capability boolean. Preserve the existing OpenAI fields and harmless local API key behavior.

- [ ] **Step 4: Wire AgentPanel to the shared setting.** Include `app.settings.thinkingEnabled` in the model memo dependencies. Pass it to `buildAgentModel`. Set `thinkingLevel: provider?.supportsThinkingToggle && app.settings.thinkingEnabled ? 'high' : 'off'` in the initial state and keep the current refs/effect so a setting change does not erase the transcript or interrupt unrelated state.

- [ ] **Step 5: Run Agent regressions and build checks.** Run `npx tsx scripts/selftest.mjs`, `npx tsc --noEmit`, and `npm run build`. Expected: all tests pass, TypeScript exits 0, and Vite produces a successful production build.

- [ ] **Step 6: Commit the Agent checkpoint.** Run:

```bash
git add src/lib/agent.ts src/components/AgentPanel.tsx scripts/selftest.mjs
git commit -m "feat: share thinking transport with the Pi Agent"
```

### Task 4: Define the eight isolated evaluation cases and app-compatible requests

**Files:**
- Create: `eval/cases.ts`
- Create: `eval/stream.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export type EvalModel = 'default' | 'thinkingcap-27b' | 'qwen38-heretic-27b-fast'
export type EvalFamily = 'scene' | 'clip' | 'prompt' | 'continuation'
export type EvalValidatorId =
  | 'breakdown-json'
  | 'required-h3-fields'
  | 'prompt-replacement-blocks'
  | 'handoff-blocks'
  | 'fixed-facts'
  | 'neighboring-states'
  | 'continuity'
  | 'dialogue-acting'

export interface ThinkingEvalCase {
  id: string
  family: EvalFamily
  stage: StageId
  studioMode: EntryModeId
  h3Mode: H3Mode
  story: string
  current: string
  previous: string
  film: FilmContext
  notes: string
  findings: string
  standing: string
  validators: readonly EvalValidatorId[]
}

export const THINKING_EVAL_CASES: readonly ThinkingEvalCase[]
export const EVAL_MODELS: readonly EvalModel[]
export const EVAL_ARMS: readonly boolean[] // [true, false]
export async function buildEvalMessages(testCase: ThinkingEvalCase): Promise<ChatMessage[]>
export function evalVariants(): { caseId: string; model: EvalModel; thinkingEnabled: boolean }[]
```

`THINKING_EVAL_CASES` must contain exactly these IDs, stages, and modes: `scene-breakdown` (`breakdown`, `story`), `scene-middle-closing-direction` (`direct`, `story`), `clip-direction-acting-heavy-two-hander` (`direct`, `idea`), `clip-t2va-draft-from-direction-sheet` (`draft`, `idea`), `prompt-revise` (`revise`, `prompt`), `prompt-rebuild` (`rebuild`, `prompt`), `continuation-planning` (`handoff`, `story`), and `continuation-prompt-authoring` (`draft`, `story`). Their concrete source/current/previous/film requirements are defined in the spec’s eight-case table and must be copied into the fixture, not synthesized from another case’s output.

- [ ] **Step 1: Write failing fixture/count assertions.** Add self-tests asserting the eight IDs in order, `EVAL_MODELS` equals `['default', 'thinkingcap-27b', 'qwen38-heretic-27b-fast']`, `EVAL_ARMS` equals `[true, false]`, and `evalVariants().length === 48`. Assert every variant has one of the eight case IDs and exactly one boolean arm.

- [ ] **Step 2: Run the suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`; the new eval imports/count assertions must fail because the files do not exist.

- [ ] **Step 3: Implement fixed case definitions and skill loading.** Read `dist/skills/index.json`, load only `h3-acting/SKILL.md`, `h3-direction/SKILL.md`, and `h3-prompting/SKILL.md`, construct `Skill` values with the existing token estimator, and call `buildContext`. `buildEvalMessages` must build:

```ts
[
  { role: 'system', content: buildStudioSystemPrompt(context, testCase.studioMode) },
  { role: 'user', content: fillTemplate(templateFor({}, testCase.stage), {
      story: testCase.story,
      current: testCase.current,
      previous: testCase.previous,
      film: filmBlock(testCase.film),
      notes: testCase.notes,
      findings: testCase.findings,
      standing: testCase.standing,
      mode: testCase.h3Mode,
    }) },
]
```

The function must never read a response from another case. For the T2VA case set `h3Mode: 'T2VA'`; use `Ref2VA` for the other seven.

- [ ] **Step 4: Implement the pure streamed-response parser.** In `eval/stream.ts`, export `parseEvalSse(text: string)` and `streamOneResponse(response: Response, onFirstToken: () => void)`. Preserve separate `reasoning`/`reasoning_content`, inline `<think>` blocks, usage, finish reason, TTFT, and the final `data:` frame even when llama closes without a trailing blank line. The parser must return `{ content, reasoning, finishReason, usage, timeToFirstTokenMs, unterminatedThink }` and never make a network call.

- [ ] **Step 5: Run the fixture/parser tests.** Run `npx tsx scripts/selftest.mjs`. Expected: all fixture count tests and synthetic SSE cases pass, including a final explanation frame without a blank-line terminator.

- [ ] **Step 6: Commit the fixture checkpoint.** Run:

```bash
git add eval/cases.ts eval/stream.ts scripts/selftest.mjs
git commit -m "test: define isolated thinking evaluation matrix"
```

### Task 5: Implement the single-attempt runner and deterministic scorer

**Files:**
- Create: `eval/run-thinking-eval.ts`
- Create: `eval/score-thinking-eval.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export interface RawEvalRecord {
  eval: 'studio-thinking-v1'
  caseId: string
  family: EvalFamily
  stage: StageId
  studioMode: EntryModeId
  model: EvalModel
  chatTemplateKwargs: { enable_thinking: boolean }
  settings: { temperature: 0.2; maxTokens: 8192; h3Mode: H3Mode; selectedSkills: string[]; inputHash: string; systemHash: string }
  request: { url: string; body: Record<string, unknown> }
  response: { content: string; reasoning: string; finishReason: string | null; usage: { prompt?: number; completion?: number } | null; requestCount: 1; continuations: 0; elapsedMs: number; timeToFirstTokenMs: number | null }
  deterministic: { passed: boolean; findings: { id: string; passed: boolean; detail: string }[] }
  qualitative: null
  errors: string[]
}

export async function runThinkingEval(baseUrl: string, outputDir: string): Promise<{ planned: 48; written: number; failures: number }>
export function scoreRecord(testCase: ThinkingEvalCase, response: ParsedEvalResponse): RawEvalRecord['deterministic']
```

- [ ] **Step 1: Add failing runner/scorer contract assertions.** Extend selftest with a stubbed `fetch` counter and call an exported `runOneVariant` helper with a synthetic completion. Assert exactly one POST, `max_tokens: 8192`, `temperature: 0.2`, `stream: true`, the correct model, the matching boolean field, no Authorization header, and no continuation/retry fields. Add validator examples for valid/invalid replacement blocks, repeated paragraphs, wrong duration, and a continuation that re-establishes the previous action.

- [ ] **Step 2: Run the suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`; the runner/scorer exports and validators must be absent or fail before implementation.

- [ ] **Step 3: Implement the runner with a fixed 48-variant loop.** `runThinkingEval` must iterate models outermost, cases in fixture order, and `[true, false]` adjacent. For each variant, build messages once, POST exactly once to `${baseUrl}/chat/completions` with:

```json
{
  "model": "default",
  "messages": [],
  "temperature": 0.2,
  "max_tokens": 8192,
  "stream": true,
  "chat_template_kwargs": { "enable_thinking": true }
}
```

Replace only `model`, `messages`, and the boolean for each variant. Do not call `streamChatComplete`, do not retry a non-2xx response, and do not issue a second POST after a length finish. Write one redacted JSON line for every planned variant, including HTTP/network failures, and flush the file after each line. Fail the process only after all 48 records are written if the planned count is not 48.

- [ ] **Step 4: Implement deterministic validators and summary outputs.** `scoreRecord` must run the validator IDs declared by the case and add protocol, thinking-format, unterminated-think, repetition/loop, required-field/order, duration/timecode, neighboring-state, continuity, dialogue/acting, and fixed-fact findings. `score-thinking-eval.ts` reads JSONL and writes `summary.csv` and `summary.json` with one row per case/model/arm and paired on/off deltas. Use `qualitative: null` in raw output; do not infer qualitative scores from deterministic findings.

- [ ] **Step 5: Add explicit CLI entry points.** `eval/run-thinking-eval.ts` accepts `H3_EVAL_BASE_URL` (defaulting to `https://5090.tail3cca41.ts.net/llama/v1`) and `--out eval/out/2026-09-03-thinking-toggle`, creates a UTC-named run directory under `eval/out` when `--out` is omitted, and prints one line containing `planned=48` plus integer `written` and `failures` counts. `eval/score-thinking-eval.ts` accepts one raw JSONL path and writes summary files beside it. Neither file runs on import.

- [ ] **Step 6: Run offline runner/scorer tests.** Run `npx tsx scripts/selftest.mjs` and `npx tsc --noEmit`. Expected: all synthetic runner/scorer tests pass without contacting the gateway.

- [ ] **Step 7: Commit the runner checkpoint.** Run:

```bash
git add eval/run-thinking-eval.ts eval/score-thinking-eval.ts scripts/selftest.mjs
git commit -m "test: add finite thinking model evaluator (Fixes #23)"
```

### Task 6: Run the authorized evaluation and produce the report

**Files:**
- Create: `eval/out/2026-09-03-thinking-toggle/raw.jsonl`
- Create: `eval/out/2026-09-03-thinking-toggle/summary.csv`
- Create: `eval/out/2026-09-03-thinking-toggle/summary.json`
- Create: `docs/evals/2026-09-03-thinking-on-off-model-eval.md`

- [ ] **Step 1: Check the endpoint without generating.** Run:

```bash
curl -fsS --max-time 30 https://5090.tail3cca41.ts.net/llama/v1/models
```

Expected: the response lists `default`, `thinkingcap-27b`, and `qwen38-heretic-27b-fast`. Do not call ComfyUI.

- [ ] **Step 2: Run exactly the 48-call evaluation.** Run:

```bash
npx tsx eval/run-thinking-eval.ts --out eval/out/2026-09-03-thinking-toggle
```

Expected: `planned=48`; `written=48` even when individual records contain errors; `failures` is reported explicitly. The command must not issue any request other than the 48 llama `/chat/completions` POSTs.

- [ ] **Step 3: Score the captured output.** Run:

```bash
npx tsx eval/score-thinking-eval.ts eval/out/2026-09-03-thinking-toggle/raw.jsonl
```

Expected: `summary.csv` and `summary.json` are written beside the raw file, with 48 arm rows and paired on/off deltas.

- [ ] **Step 4: Write the dated report from captured artifacts.** The report must include endpoint/model inventory, exact matrix/order, completed and failed counts, per-case deterministic failures, reasoning/content/latency summaries, blinded 1–5 rubric instructions and results if reviewed, limitations, and the statement that qualitative scores are not objective. It must not include API keys, raw Authorization headers, or claims that one arm/model is objectively superior.

- [ ] **Step 5: Verify artifact completeness offline.** Run:

```bash
node -e "const fs=require('node:fs'); const p='eval/out/2026-09-03-thinking-toggle/raw.jsonl'; const rows=fs.readFileSync(p,'utf8').trim().split(/\\n/).filter(Boolean).map(JSON.parse); if(rows.length!==48) throw new Error('expected 48 records'); if(rows.some(r=>r.response.requestCount!==1||r.response.continuations!==0)) throw new Error('hidden call budget violated'); console.log('48 records; one request and zero continuations per record')"
```

Expected: the exact success line above, or a thrown error that is copied into the report’s failures section.

### Task 7: Full verification and delivery checkpoint

**Files:**
- Modify: files from Tasks 1–6 only if a verification failure requires a scoped fix.

- [ ] **Step 1: Run deterministic self-tests.** Run `npx tsx scripts/selftest.mjs`. Expected: zero failures.

- [ ] **Step 2: Run type-check and production build.** Run `npx tsc --noEmit && npm run build`. Expected: both commands exit 0.

- [ ] **Step 3: Check whitespace and diff scope.** Run `git diff --check` and `git status --short`. Expected: no whitespace errors and only the planned app/eval/docs paths.

- [ ] **Step 4: Inspect the final request contract.** Run `rg -n "chat_template_kwargs|thinkingEnabled|thinkingFormat|planned=48|qualitative" src eval docs`. Confirm the field is provider-gated, the global setting is used by Studio and Agent, and the report documents any failed records.

- [ ] **Step 5: Commit the report and verification evidence.** Run:

```bash
git add eval/out docs/evals
git commit -m "docs: record thinking toggle model evaluation"
```

- [ ] **Step 6: Report the delivery evidence.** Include changed paths, issue IDs #22/#23, commit IDs, exact commands/results, whether all 48 records completed, every explicit failure, and confirmation that no ComfyUI/GPU operation was performed.

## Self-review checklist

- [ ] The spec’s single global/default-on setting is covered by Tasks 1–2 and the Agent mapping in Task 3.
- [ ] Provider gating is covered for built-in llama.cpp, unmarked custom endpoints, and explicitly marked custom endpoints.
- [ ] All eight specified cases and all three exact model IDs appear in Task 4; the matrix is exactly 48, not 30 or 60.
- [ ] Both streamed reasoning/content, finish reason, usage, elapsed time, TTFT, request count, and errors are captured in Task 5.
- [ ] Deterministic validators and the blinded non-objective qualitative rubric are covered by Tasks 5–6.
- [ ] Stop retention, canonical prompt behavior, bounded continuation behavior, and existing ComfyUI paths are explicitly preserved and verified.
- [ ] No step uses placeholder markers, an unbounded retry, an unspecified model, a hidden second call, or a ComfyUI/GPU operation.
