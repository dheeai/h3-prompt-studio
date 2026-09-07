import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QWEN_REASONING_BUDGET_MAX, withQwenReasoningBudget } from './thinking'

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
