import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QWEN_REASONING_BUDGET_MAX, withQwenReasoningBudget, reasoningBudgetSupported } from './thinking'

/**
 * Founder, 2026-09-07: thinking must be bounded to 8k "even if the provider is
 * openrouter". Before this, only local Qwen-FAMILY models got a budget — a
 * hosted reasoning model, and even the local `huihui-thinkingcap-27b` slug,
 * were sent no ceiling at all.
 */
test('a reasoning budget is applied to local llama.cpp AND OpenRouter, and clamped to 8k', () => {
  const local = { id: 'localbox', baseUrl: 'https://gateway.example.ts.net/llama/v1' }
  const router = { id: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' }
  const other = { id: 'x', baseUrl: 'https://example.com/v1' }

  const overBudget = 32000
  const l = withQwenReasoningBudget(local, 'huihui-thinkingcap-27b', { model: 'm' }, overBudget) as Record<string, unknown>
  assert.equal(l.reasoning_budget_tokens, QWEN_REASONING_BUDGET_MAX, 'a non-Qwen local slug is still bounded')

  const o = withQwenReasoningBudget(router, 'deepseek/deepseek-v4-pro', { model: 'm' }, overBudget) as {
    reasoning?: { max_tokens?: number }
  }
  assert.equal(o.reasoning?.max_tokens, QWEN_REASONING_BUDGET_MAX, 'OpenRouter gets its unified reasoning cap')

  const u = withQwenReasoningBudget(other, 'some-model', { model: 'm' }, overBudget) as Record<string, unknown>
  assert.equal(u.reasoning, undefined, 'an unknown server is left untouched — no portable field to send')
  assert.equal(u.reasoning_budget_tokens, undefined)
})

// ── reasoningBudgetSupported: never claim a ceiling the server ignores ───────
// Measured 2026-09-08: ninfer accepts `reasoning_budget_tokens` and ignores it
// (128 requested -> 786 reasoning chars vs an 834 baseline; and
// `thinking_budget_tokens: 128` -> 1162, MORE than baseline).

test('a /ninfer path on the local host is refused a budget, despite being local', () => {
  const ninfer = { id: 'box', baseUrl: 'https://box.example.ts.net/ninfer/v1' }
  assert.equal(reasoningBudgetSupported(ninfer, 'qwen3_8_27b_huihui'), false)
  // and the payload must come back untouched, not merely unenforced
  const body = { model: 'qwen3_8_27b_huihui', messages: [] }
  const out = withQwenReasoningBudget(ninfer, 'qwen3_8_27b_huihui', body, 4096) as Record<string, unknown>
  assert.equal(out.reasoning_budget_tokens, undefined)
  assert.equal(out.reasoning_budget_message, undefined)
})

test('the same host on /llama DOES get the budget', () => {
  const llama = { id: 'box', baseUrl: 'https://box.example.ts.net/llama/v1' }
  assert.equal(reasoningBudgetSupported(llama, 'qwen38-heretic-27b'), true)
  const out = withQwenReasoningBudget(llama, 'qwen38-heretic-27b', { messages: [] }, 4096) as Record<string, unknown>
  assert.equal(out.reasoning_budget_tokens, 4096)
  assert.equal(out.reasoning_budget_message, 'Time to stop thinking. Give the final answer.')
})

test('an explicit false wins over every inference', () => {
  const p = { id: 'x', baseUrl: 'http://localhost:8080/v1', supportsReasoningBudget: false }
  assert.equal(reasoningBudgetSupported(p, 'qwen3'), false)
  const out = withQwenReasoningBudget(p, 'qwen3', { messages: [] }, 4096) as Record<string, unknown>
  assert.equal(out.reasoning_budget_tokens, undefined)
})
