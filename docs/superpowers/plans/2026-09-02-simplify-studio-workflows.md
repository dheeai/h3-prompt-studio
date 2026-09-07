# Simplify Studio Workflows Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the user-facing Direct/Draft/Critique/Revise rail with three bounded Studio entry workflows while keeping internal scene/clip quality passes, making Prompt Revise and Prompt Rebuild one-request canonical replacements, and making long thinking/run status explicit.

**Architecture:** Keep the existing `StageId` machinery as an internal execution/history representation, but centralize visible entry actions and run-status wording in a pure workflow helper. Scene uses Breakdown followed by selected/all prompt generation; Clip uses the existing bounded Direct → Draft orchestration; Prompt uses separate one-call Revise and Rebuild stages with two-block prompt/explanation contracts. The state layer owns request-count guarantees and canonical history, while App/ClipPlan only dispatch the entry actions.

**Tech Stack:** React 18, TypeScript, Vite, browser `fetch` streaming client, deterministic `scripts/selftest.mjs` regression suite, production build, and real browser E2E against the configured llama.cpp and ComfyUI endpoints.

**Spec:** Approved parent-task direction for issues #12 and #13 (Prompt simplification and perceived h3-acting loop).

## Global Constraints

- No user-facing Direct/Draft/Critique/Revise rail in any Studio entry mode.
- Scene (Multi-shot) exposes Scene → clip plan → generate selected/all prompts.
- Clip exposes idea → Generate prompt and may retain bounded internal Direct → Draft quality orchestration.
- Prompt exposes an existing prompt → Revise or Rebuild.
- Prompt Revise and Prompt Rebuild each make exactly one LLM request with zero automatic continuations.
- Prompt Rebuild preserves fixed subject/action/outcome/named objects/dialogue/constraints while rethinking performance, blocking, temporal beats, shot design, camera, lighting, sound, and prompt structure.
- Revise and Rebuild return exactly one full canonical replacement prompt plus a concise explanation; the replacement becomes canonical and chat continues from it.
- Critique is explanatory output, never a separate user stage.
- Preserve Skills, Settings, ComfyUI render, history, Stop, retained thinking, Scene multiclip, Clip generation, and continuation-from-current-clip.
- Show explicit thinking/writing/continuation status so long h3-acting reasoning is not described as repeated calls.
- Do not edit `dhee-core` or create GitHub issues.

## File Map

- Create: `src/lib/studio-workflow.ts` — pure visible-action and run-status contracts.
- Modify: `src/lib/entry.ts` — approved entry copy and action labels.
- Modify: `src/lib/types.ts` — internal Prompt Rebuild stage and streaming phase types.
- Modify: `src/lib/stages.ts` — Rebuild label/template and two-block Revise/Rebuild contracts.
- Modify: `src/lib/context.ts` — mode contracts describe bounded entry workflows and explanatory critique.
- Modify: `src/lib/llm.ts` — opt out of 400-limit retries for one-request operations and budget Rebuild at zero continuations.
- Modify: `src/app/state.tsx` — route Prompt Rebuild, enforce one-request stages, expose explicit streaming phase, preserve canonical history.
- Modify: `src/app/App.tsx` — remove the stage rail and replace it with entry-specific actions/status.
- Modify: `src/components/ClipPlan.tsx` — generate a selected clip prompt through bounded Direct → Draft.
- Modify: `src/components/Marginalia.tsx` — make findings explanatory and invoke the Prompt Revise action without a Critique stage label.
- Modify: `scripts/selftest.mjs` — red/green regression tests for visible workflow contracts, prompt replacement contracts, request budgets, statuses, and preserved continuation helpers.

## Test and Verification Matrix

- RED: run `node scripts/selftest.mjs` after adding the tests but before production implementation; record the expected missing-contract failures.
- GREEN unit/regression: run `node scripts/selftest.mjs` and require zero failures.
- Type/build: run `npm run build` and require a successful Vite production build.
- Real E2E: use the browser against default model endpoint `https://YOUR_GATEWAY_HOST/llama/v1` and ComfyUI `https://YOUR_GATEWAY_HOST/comfyui`, using the smallest valid existing recipe/reference/geometry fixture and restoring any temporary settings.
- Scene E2E: source → clip plan → generate selected prompt → generate all prompts → multiclip submission/render; verify canonical prompts, request termination/counts, job acceptance/status/output, and Stop behavior.
- Clip E2E: idea → canonical prompt → ComfyUI render; verify one bounded internal authoring sequence, canonical prompt as submission payload, job acceptance/status/output, and Stop-retained thinking.
- Prompt E2E: existing prompt → Revise and existing prompt → Rebuild; verify each is exactly one LLM request with zero continuations (especially h3-acting), exactly two output blocks, canonical replacement history, then ComfyUI render with that canonical prompt; verify job acceptance/status/output and Stop-retained thinking.
- E2E blocker policy: if endpoint auth, model availability, recipe, reference, geometry, browser permission, or GPU state blocks a path, record the precise blocker and the last successful observable state; do not alter unrelated settings permanently.

---

### Task 1: Add pure workflow contracts and failing regression coverage

**Files:**
- Create: `src/lib/studio-workflow.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**
- Produces `studioActions(mode, hasPlan): StudioAction[]`, `promptOperationStage(operation): 'revise' | 'rebuild'`, and `runStatusText(stage, phase, continuations): string` for UI/state consumers.

- [ ] **Step 1: Write failing tests** for the exact visible action sets (Scene plan/selected/all, Clip Generate prompt, Prompt Revise/Rebuild), no rail stages in those action sets, zero-continuation Prompt operations, and explicit Thinking/Writing/one-request status text.
- [ ] **Step 2: Run `node scripts/selftest.mjs` and record the expected failures** because the helper does not yet exist.
- [ ] **Step 3: Implement the minimal pure helper** with literal action ids/labels and status derivation for thinking, writing, normal continuation, and thinking recovery.
- [ ] **Step 4: Run `node scripts/selftest.mjs` and verify only the new contract tests move green; commit the helper/test checkpoint.**

### Task 2: Define the Prompt Rebuild stage and one-call output contracts

**Files:**
- Modify: `src/lib/types.ts`
- Modify: `src/lib/entry.ts`
- Modify: `src/lib/stages.ts`
- Modify: `src/lib/context.ts`
- Modify: `scripts/selftest.mjs`

**Interfaces:**
- `StageId` includes internal `'rebuild'`; `PROMPT_STAGES` consumers treat it as canonical.
- `DEFAULT_TEMPLATES.revise` and `DEFAULT_TEMPLATES.rebuild` require exactly `<<<PROMPT>>>` followed by `<<<EXPLANATION>>>`, with no `<<<CHANGES>>>` block.

- [ ] **Step 1: Add failing assertions** for approved entry labels/actions, Rebuild stage label/template, fixed/open Rebuild contract language, and Revise/Rebuild exact two-block instructions.
- [ ] **Step 2: Run the focused selftest and capture the RED output.**
- [ ] **Step 3: Add the stage/type/template/context changes** while leaving Scene/Clip internal Direct → Draft orchestration intact.
- [ ] **Step 4: Run the focused selftest and confirm the contract tests pass.**

### Task 3: Enforce exactly one request for Prompt Revise/Rebuild

**Files:**
- Modify: `src/lib/llm.ts`
- Modify: `src/app/state.tsx`
- Modify: `scripts/selftest.mjs`

**Interfaces:**
- `StreamOptions.retryOnLimit?: boolean` defaults to `true`; Prompt replacement stages pass `false` so a 400 output-limit response cannot trigger a hidden second request.
- `continuationBudgetFor('revise') === 0` and `continuationBudgetFor('rebuild') === 0`.

- [ ] **Step 1: Add a fetch-count regression test** around `streamChatComplete` proving Prompt replacement options make one attempt even when the endpoint returns an output-limit 400; add phase assertions for streaming state transitions through the pure status helper.
- [ ] **Step 2: Run the test and capture the RED request-count failure.**
- [ ] **Step 3: Add the retry opt-out and state routing**: Prompt mode Rebuild calls `run('rebuild')`, Revise/Rebuild use zero continuation budget and no limit retry, parse exactly the prompt/explanation blocks, and save each replacement as canonical history.
- [ ] **Step 4: Run unit tests and build; verify existing continuation tests remain green.**

### Task 4: Replace the user-facing rail with entry-specific UI actions

**Files:**
- Modify: `src/app/App.tsx`
- Modify: `src/components/ClipPlan.tsx`
- Modify: `src/components/Marginalia.tsx`
- Modify: `scripts/selftest.mjs`

**Interfaces:**
- App dispatches only entry actions in the Studio surface; internal calls may still use Direct → Draft.
- ClipPlan selected generation calls the bounded app rebuild path and labels the action `Generate prompt`; all generation remains stoppable.

- [ ] **Step 1: Add failing source-level behavior tests through the pure action contract** and update the regression suite to reject visible rail action ids/labels and Critique-stage action copy.
- [ ] **Step 2: Run the test and record RED against the existing rail/action surface.**
- [ ] **Step 3: Remove the stage rail and suggested-stage CTA; render Scene/Clip/Prompt action controls, Prompt Revise/Rebuild controls, generation progress, and explicit thinking/run status.
- [ ] **Step 4: Change ClipPlan and Marginalia labels/actions** without removing history, findings, chat, render, Stop, or continuation controls.
- [ ] **Step 5: Run selftest and `npm run build`; inspect the rendered DOM manually for all three entry modes.**

### Task 5: Full verification and delivery evidence

**Files:**
- Modify: any files required only for verification fixes discovered in Tasks 1–4.

- [ ] **Step 1: Run `node scripts/selftest.mjs` and record the complete zero-failure output summary.**
- [ ] **Step 2: Run `npm run build` and record the exit/output summary.**
- [ ] **Step 3: Run the real three-mode E2E matrix against the exact default llama.cpp and ComfyUI URLs, recording request counts/termination, canonical render payload, job acceptance/status/output, and Stop-retained thinking.**
- [ ] **Step 4: Inspect `git diff`, ensure no unrelated changes, and commit all changes with issue references (`#12`, `#13`).**
- [ ] **Step 5: Report changed paths, commit(s), exact RED evidence, verification commands/output, E2E outcomes/blockers, and concerns to the parent agent.**

## Verification note

Local verification is complete: the self-test suite passes, TypeScript type-checks,
the production build succeeds, and `git diff --check` is clean. The requested
browser E2E is blocked in this environment because the in-app browser runtime
reports `No browser is available` and returns no browser sessions. No ComfyUI
endpoint was called and no GPU render or job submission was attempted.
