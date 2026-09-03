# SDD ledger — plan: docs/superpowers/plans/2026-09-03-thinking-toggle-model-eval.md

Preflight: Tasks 1–3 share Settings, Provider, and selftest interfaces and will be implemented as one cohesive transport/UI/Agent batch. Tasks 4–5 share eval fixture/parser/runner/scorer interfaces and will be implemented as one eval-harness batch. Task 6 consumes Task 5 artifacts. Task 7 verifies the full result.

Ruling: Use the current checkout rather than a new worktree — the user explicitly asked to continue and commit this ongoing Prompt Studio work in-place; creating a detached worktree would disconnect it from the active local app. Cost if wrong: branch isolation is weaker, mitigated by clean checkpoints and scoped commits.

Ruling: `thinkingcap-27b` is the selected ThinkingCap model — it exactly matches the user's name; the Huihui variant is excluded. Cost if wrong: one model family would need a follow-up eval.

Task 1: fix round 1/5 (2 addressed, 0 open; commits 80817d8..7f48ac5)
Task 1: complete (commits b74135e..7f48ac5, review clean)

Ruling: Production UI/transport changes were scope creep and were reverted; the eval calls llama directly as the user requested. Cost if wrong: a separate product toggle can be added later without contaminating benchmark results.
Task 1 (eval-only plan): fix round 1/5 (1 addressed, 0 open; commits f2a21ac..7b0171d)
Task 1 (eval-only plan): complete (commits b31ae1f..7b0171d, review clean)

Task 2 (eval-only plan): complete (commits 14283d0, f2f3308, 3c69440; review clean)
Task 2 verification: `npx tsx scripts/selftest.mjs` — 106 passed, 0 failed;
`npx tsc --noEmit` — pass; direct strict eval type-check for
`eval/types.ts`, `eval/cases.ts`, `eval/stream.ts`, and
`eval/run-thinking-eval.ts` — pass; `git diff --check` — pass. The 48-row
matrix ordering, exact model/case filters, one-request HTTP/network failure
behavior, terminal-safe SSE, `reasoning_content`, split inline thinking, and
raw-token TTFT behavior are covered offline. No network, model, browser,
ComfyUI, or GPU operation was used.
