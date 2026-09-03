# Direct Thinking-Toggle Model Evaluation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an eval-only harness that sends the direct llama request with `chat_template_kwargs.enable_thinking` on and off across eight isolated H3 stage-contract cases and three exact local model IDs, producing 48 one-request records and a blinded report.

**Architecture:** Keep the production app untouched. Reuse its existing pure prompt/context assembly functions as read-only imports, define all upstream fixtures in `eval/cases.ts`, capture one streamed response in a side-effect-free parser, and run/scorer code directly against the 5090 llama endpoint. The CLI defaults to both thinking arms while `--thinking on` or `--thinking off` narrows targeted smoke runs.

**Tech Stack:** TypeScript executed with `npx tsx`, Node `fetch` and filesystem streams, the existing pure `src/lib/context.ts`, `src/lib/stages.ts`, `src/lib/lint.ts`, and `scripts/selftest.mjs`. No React, browser UI, Pi Agent, ComfyUI, or GPU integration is added.

**Spec:** `docs/superpowers/specs/2026-09-03-thinking-toggle-model-eval-design.md`

## Global Constraints

- This plan changes only eval files, deterministic self-tests, captured eval artifacts, and the dated report; it does not implement an app Settings/Provider/Studio/Pi thinking feature.
- Use exactly `default`, `thinkingcap-27b`, and `qwen38-heretic-27b-fast`.
- Use exactly eight isolated cases and both thinking arms for a full matrix: `8 × 3 × 2 = 48` POSTs.
- Use `https://5090.tail3cca41.ts.net/llama/v1`, temperature `0.2`, `max_tokens: 8192`, and `stream: true`.
- Every variant sends `chat_template_kwargs: { enable_thinking: true|false }` directly to `/chat/completions`.
- One variant makes one POST: no retry, continuation, thinking recovery, output-limit fallback, or hidden UI call.
- `--thinking on` runs only true; `--thinking off` runs only false; omitting the option runs true then false for every case.
- Capture complete streamed reasoning/content, finish reason, usage, elapsed time, TTFT when available, request count, errors, and deterministic findings without secrets.
- Do not call ComfyUI or modify/inspect GPU render state.

## File Map

- Create: `eval/types.ts` — shared model/family/case/response/raw-record interfaces.
- Create: `eval/cases.ts` — eight concrete fixtures, fixed skill loader, and app-compatible message construction.
- Create: `eval/stream.ts` — pure SSE parser and streamed response capture.
- Create: `eval/run-thinking-eval.ts` — CLI argument parsing, one-POST runner, sequential 48-variant loop, and JSONL writer.
- Create: `eval/score-thinking-eval.ts` — deterministic validators, summary CSV/JSON writer, and report data extraction.
- Modify: `scripts/selftest.mjs` — offline red/green coverage for fixtures, CLI arms, SSE edge cases, one-request body, validators, and artifact shape.
- Create after the authorized run: `eval/out/2026-09-03-thinking-toggle/raw.jsonl`.
- Create after scoring: `eval/out/2026-09-03-thinking-toggle/summary.csv` and `summary.json`.
- Create after review: `docs/evals/2026-09-03-thinking-on-off-model-eval.md`.

No `src/app`, `src/components`, `src/lib/types.ts`, `src/lib/providers.ts`, `src/lib/llm.ts`, `src/lib/agent.ts`, or UI files are implementation targets.

---

### Task 1: Define the isolated fixtures and app-compatible messages

**Files:**
- Create: `eval/types.ts`
- Create: `eval/cases.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export type EvalModel = 'default' | 'thinkingcap-27b' | 'qwen38-heretic-27b-fast'
export type EvalFamily = 'scene' | 'clip' | 'prompt' | 'continuation'
export type EvalValidatorId =
  | 'breakdown-json' | 'required-h3-fields' | 'prompt-replacement-blocks'
  | 'handoff-blocks' | 'fixed-facts' | 'neighboring-states'
  | 'continuity' | 'dialogue-acting'

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

export interface ParsedEvalResponse {
  content: string
  reasoning: string
  finishReason: string | null
  usage: { prompt?: number; completion?: number } | null
  elapsedMs: number
  timeToFirstTokenMs: number | null
  unterminatedThink: boolean
}

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
  response: ParsedEvalResponse & { requestCount: 1; continuations: 0 }
  deterministic: { passed: boolean; findings: { id: string; passed: boolean; detail: string }[] }
  qualitative: null
  errors: string[]
}

export const EVAL_MODELS: readonly EvalModel[]
export const EVAL_CASES: readonly ThinkingEvalCase[]
export const EVAL_ARMS: readonly boolean[] // [true, false]
export function evalVariants(): { caseId: string; model: EvalModel; enableThinking: boolean }[]
export async function buildEvalMessages(testCase: ThinkingEvalCase): Promise<ChatMessage[]>
```

- [ ] **Step 1: Write the failing fixture contract tests.** Add self-test assertions that `EVAL_CASES` contains exactly, in order, `scene-breakdown`, `scene-middle-closing-direction`, `clip-direction-acting-heavy-two-hander`, `clip-t2va-draft-from-direction-sheet`, `prompt-revise`, `prompt-rebuild`, `continuation-planning`, and `continuation-prompt-authoring`; `EVAL_MODELS` equals `['default', 'thinkingcap-27b', 'qwen38-heretic-27b-fast']`; `EVAL_ARMS` equals `[true, false]`; and `evalVariants().length === 48`.

- [ ] **Step 2: Run the focused suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`. The new import/count assertions must fail because the eval types and fixtures do not yet exist.

- [ ] **Step 3: Implement the concrete eight fixtures.** Copy the exact source/current/previous/film requirements from the spec table. Set stages/modes exactly: breakdown/story; direct/story; direct/idea; draft/idea; revise/prompt; rebuild/prompt; handoff/story; draft/story. Use `Ref2VA` for seven cases and `T2VA` only for `clip-t2va-draft-from-direction-sheet`.

- [ ] **Step 4: Implement read-only skill loading and message construction.** Read `dist/skills/index.json` and the three `SKILL.md` files named in the spec, build the existing `Skill` shape, call `buildContext`, and construct exactly two messages:

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

`buildEvalMessages` must be pure with respect to case data: it must not read React state, IndexedDB, another case, or a network response.

- [ ] **Step 5: Run the green fixture tests.** Run `npx tsx scripts/selftest.mjs` and `npx tsc --noEmit`. Expected: the eight-case order, 48-variant count, message roles, and exact mode/stage assertions pass; TypeScript exits 0.

- [ ] **Step 6: Commit the fixture checkpoint.** Run:

```bash
git add eval/types.ts eval/cases.ts scripts/selftest.mjs
git commit -m "test: define direct thinking evaluation fixtures"
```

### Task 2: Capture one streamed response and run the direct 48-variant matrix

**Files:**
- Create: `eval/stream.ts`
- Create: `eval/run-thinking-eval.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export function parseEvalSse(frameText: string): ParsedEvalResponse
export async function streamOneResponse(response: Response, onFirstToken: () => void): Promise<ParsedEvalResponse>

export type ThinkingArm = 'on' | 'off'
export interface RunOptions {
  baseUrl: string
  outputDir: string
  thinking: ThinkingArm | undefined
  model: EvalModel | undefined
  caseId: string | undefined
}
export async function runOneVariant(baseUrl: string, testCase: ThinkingEvalCase, model: EvalModel, enableThinking: boolean): Promise<RawEvalRecord>
export async function runThinkingEval(options: RunOptions): Promise<{ planned: number; written: number; failures: number }>
export function parseCli(argv: string[]): RunOptions
```

- [ ] **Step 1: Write failing stream, CLI, and one-request tests.** Add a synthetic SSE test whose last `data:` line has no blank-line terminator and assert the final content, finish reason, and reasoning are retained. Add `parseCli([])` arms `[true, false]`, `parseCli(['--thinking', 'on'])` arm `[true]`, and `parseCli(['--thinking', 'off'])` arm `[false]` assertions. Stub `globalThis.fetch`, count calls, capture the JSON body, and assert one `runOneVariant` call sends `temperature: 0.2`, `max_tokens: 8192`, `stream: true`, the selected model, and the exact boolean field.

- [ ] **Step 2: Run the focused suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`. The parser, CLI, and runner exports must fail before implementation.

- [ ] **Step 3: Implement the terminal-safe SSE parser.** Parse `data:` frames, `[DONE]`, `delta.content`, `delta.reasoning`, `delta.reasoning_content`, inline `<think>` blocks, usage, and finish reason. Measure TTFT at the first content or reasoning token. Consume the final non-empty buffer after the reader closes. Never invoke a second read request from the parser.

- [ ] **Step 4: Implement the one-POST variant runner.** Build messages once, then call `${baseUrl}/chat/completions` exactly once with:

```json
{
  "model": "default",
  "messages": [],
  "temperature": 0.2,
  "max_tokens": 8192,
  "stream": true,
  "chat_template_kwargs": { "enable_thinking": false }
}
```

Use no Authorization header. On an HTTP/network error, return one record with the error and `requestCount: 1`; do not retry. On `finish_reason: "length"`, record the response and do not continue or recover it.

- [ ] **Step 5: Implement CLI filtering and full ordering.** Default `parseCli` to all models, all cases, and arms `[true, false]`. `--thinking on` selects `[true]`; `--thinking off` selects `[false]`; `--model` accepts one exact model ID; `--case` accepts one exact case ID. The unfiltered command must iterate model outermost, cases in spec order, and true immediately before false, producing planned count 48. Write one flushed JSONL line for every planned variant, including failures.

- [ ] **Step 6: Run offline runner tests.** Run `npx tsx scripts/selftest.mjs` and `npx tsc --noEmit`. Expected: synthetic fetch count is one, parser edge cases pass, CLI arm filtering passes, and no gateway call occurs.

- [ ] **Step 7: Commit the runner checkpoint.** Run:

```bash
git add eval/stream.ts eval/run-thinking-eval.ts scripts/selftest.mjs
git commit -m "test: add direct single-attempt thinking eval runner"
```

### Task 3: Add deterministic validators, summaries, and report generation

**Files:**
- Create: `eval/score-thinking-eval.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**

```ts
export interface DeterministicFinding { id: string; passed: boolean; detail: string }
export function scoreRecord(testCase: ThinkingEvalCase, record: RawEvalRecord): { passed: boolean; findings: DeterministicFinding[] }
export function repetitionLoop(text: string): string[]
export async function scoreFile(rawPath: string): Promise<{ records: number; failures: number; summaryCsv: string; summaryJson: string }>
```

- [ ] **Step 1: Write failing validator tests.** Add self-tests for valid/invalid breakdown JSON, exact two-block Prompt replacement, valid/invalid handoff fields, wrong duration, missing neighboring state, continuation re-establishment, changed fixed dialogue, repeated paragraphs, and “I will continue” loop language. Add a raw-record shape assertion requiring `requestCount === 1`, `continuations === 0`, and `qualitative === null`.

- [ ] **Step 2: Run the focused suite and confirm RED.** Run `npx tsx scripts/selftest.mjs`; validator exports and expected findings must fail before implementation.

- [ ] **Step 3: Implement deterministic scoring.** Run the case-declared validators plus protocol, thinking-format, unterminated-think, empty-answer, repetition/loop, H3 field/order, time/duration, continuity, fixed-fact, dialogue/acting, sound/music, and no-premature-resolution checks. Use existing pure parsers/lint helpers where they match the contract; return one named finding per check rather than collapsing detail into one score.

- [ ] **Step 4: Implement summaries.** Read JSONL, preserve failed records, write `summary.csv` and `summary.json` beside the raw file with one row per case/model/arm, content/reasoning tokens, latency, TTFT, contract pass, validator findings, and paired true/false deltas. Keep raw `qualitative: null` and never derive qualitative scores from deterministic findings.

- [ ] **Step 5: Implement report data and run offline checks.** Ensure the report data contains planned count, written count, failed count, per-case failures, arm/model comparisons, limitations, and the blinded six-dimension rubric. Run `npx tsx scripts/selftest.mjs` and `npx tsc --noEmit`; expected: zero failures and no network calls.

- [ ] **Step 6: Commit the scorer checkpoint.** Run:

```bash
git add eval/score-thinking-eval.ts scripts/selftest.mjs
git commit -m "test: score direct thinking evaluation contracts"
```

### Task 4: Execute the explicitly authorized matrix and produce artifacts

**Files:**
- Create: `eval/out/2026-09-03-thinking-toggle/raw.jsonl`
- Create: `eval/out/2026-09-03-thinking-toggle/summary.csv`
- Create: `eval/out/2026-09-03-thinking-toggle/summary.json`
- Create: `docs/evals/2026-09-03-thinking-on-off-model-eval.md`

- [ ] **Step 1: Verify model inventory without generating.** Run:

```bash
curl -fsS --max-time 30 https://5090.tail3cca41.ts.net/llama/v1/models
```

Expected: the response lists `default`, `thinkingcap-27b`, and `qwen38-heretic-27b-fast`. Do not call ComfyUI.

- [ ] **Step 2: Run the full direct matrix.** Run:

```bash
npx tsx eval/run-thinking-eval.ts --out eval/out/2026-09-03-thinking-toggle
```

With no `--thinking`, `--model`, or `--case` filter this must print `planned=48`, write 48 JSONL records, and report integer written/failure counts. It must issue exactly one llama POST per record and no other generation request.

- [ ] **Step 3: Run the scorer.** Run:

```bash
npx tsx eval/score-thinking-eval.ts eval/out/2026-09-03-thinking-toggle/raw.jsonl
```

Expected: 48 arm rows and paired on/off deltas in the summary files. Any failed response remains represented with its error.

- [ ] **Step 4: Verify targeted smoke arm behavior without a full matrix.** After the full run, use the CLI filters for one case/model only:

```bash
npx tsx eval/run-thinking-eval.ts --case prompt-revise --model thinkingcap-27b --thinking on --out eval/out/2026-09-03-thinking-toggle-smoke-on
npx tsx eval/run-thinking-eval.ts --case prompt-revise --model thinkingcap-27b --thinking off --out eval/out/2026-09-03-thinking-toggle-smoke-off
```

Each command must report `planned=1`, write one record, and show the matching true/false request field in its redacted body. Do not call ComfyUI.

- [ ] **Step 5: Write the dated report.** Include exact endpoint/settings/order, 48 planned and actual counts, per-case deterministic findings, reasoning/content/latency/TTFT summaries, blinded 1–5 rubric instructions/results if reviewed, failures, and limitations. State explicitly that qualitative scores are subjective structured review, not objective quality.

- [ ] **Step 6: Verify artifact completeness.** Run:

```bash
node -e "const fs=require('node:fs'); const p='eval/out/2026-09-03-thinking-toggle/raw.jsonl'; const rows=fs.readFileSync(p,'utf8').trim().split(/\\n/).filter(Boolean).map(JSON.parse); if(rows.length!==48) throw new Error('expected 48 records'); if(rows.some(r=>r.response.requestCount!==1||r.response.continuations!==0)) throw new Error('one-request budget violated'); console.log('48 records; one request and zero continuations per record')"
```

Expected: the success line above. If records failed at the provider, the report must retain and enumerate those failures rather than rerunning them.

### Task 5: Full verification and delivery

**Files:**
- Modify only files listed in Tasks 1–4 if a scoped verification failure requires a correction.

- [ ] **Step 1: Run deterministic tests.** Run `npx tsx scripts/selftest.mjs`. Expected: zero failures.

- [ ] **Step 2: Run type-check and build.** Run `npx tsc --noEmit && npm run build`. Expected: both commands exit 0; no app Settings/Provider/Studio/Pi implementation is present.

- [ ] **Step 3: Run whitespace and scope checks.** Run `git diff --check`, `git status --short`, and `rg -n "chat_template_kwargs|enable_thinking|planned=48|requestCount|continuations|qualitative" eval docs`. Expected: only planned eval/docs paths are changed and the direct contract appears in runner/tests/report.

- [ ] **Step 4: Commit eval artifacts and report.** Run:

```bash
git add eval/out docs/evals
git commit -m "docs: record direct thinking model evaluation (Fixes #23)"
```

- [ ] **Step 5: Report delivery evidence.** Include changed paths, #23, the production revert commit IDs, eval/report commit ID, exact commands/results, actual 48-record completion or explicit failures, and confirmation that no ComfyUI/GPU operation occurred.

## Self-review checklist

- [ ] The corrected spec contains no in-app Settings/Provider/Studio/Pi implementation requirement.
- [ ] The plan’s file map contains only eval/test/artifact/report files; production app files are explicitly read-only dependencies.
- [ ] The exact eight case IDs, three models, ordering, and 48-call arithmetic are consistent across spec and plan.
- [ ] `--thinking on` and `--thinking off` are supported, while the unfiltered command runs both arms.
- [ ] Direct requests include the boolean field and make one POST with no recovery path.
- [ ] Stream capture retains reasoning/content and a terminal llama frame without a blank-line separator.
- [ ] Deterministic validators, blinded six-dimension review, redacted artifacts, limitations, and explicit failures are covered.
- [ ] No model generation or ComfyUI call is performed during documentation/self-review; those commands are listed only for the explicitly authorized future eval execution.
