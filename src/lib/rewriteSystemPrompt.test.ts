import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_REWRITE_SYSTEM_PROMPT, rewriteSystemPromptFor } from './rewriteSystemPrompt'

test('rewriteSystemPromptFor: undefined/empty falls back to the shipped default', () => {
  assert.equal(rewriteSystemPromptFor(undefined), DEFAULT_REWRITE_SYSTEM_PROMPT)
  assert.equal(rewriteSystemPromptFor(''), DEFAULT_REWRITE_SYSTEM_PROMPT)
  assert.equal(rewriteSystemPromptFor('   '), DEFAULT_REWRITE_SYSTEM_PROMPT)
})

test('rewriteSystemPromptFor: a non-empty override is returned verbatim, not merged with the default', () => {
  assert.equal(rewriteSystemPromptFor('a custom system prompt'), 'a custom system prompt')
})

test('DEFAULT_REWRITE_SYSTEM_PROMPT: carries the six-section output contract and the ONE RULE', () => {
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('subject_definitions'))
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('detailed_description'))
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('overall_soundscape'))
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('non_diegetic_music'))
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('THE ONE RULE'))
})

test('DEFAULT_REWRITE_SYSTEM_PROMPT: never names an absent modality as a denial — the sentinel rule survives verbatim', () => {
  assert.ok(DEFAULT_REWRITE_SYSTEM_PROMPT.includes('NEVER NAME AN ABSENT MODALITY'))
})
