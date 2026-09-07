import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENTRY_MODES,
  authoringModeFor,
  entryWorkflow,
  migrateEntryMode,
  promptSourceForEntryMode,
} from './entry'

// ── the three starting points ──────────────────────────────────────────────

test('ENTRY_MODES: exactly the three starting points, in the mockup order', () => {
  assert.deepEqual(ENTRY_MODES.map((m) => m.id), ['idea', 'prompt', 'video'])
})

test('ENTRY_MODES: story is not one of them any more', () => {
  assert.ok(!ENTRY_MODES.some((m) => (m.id as string) === 'story'))
})

// ── authoringModeFor — the door -> LLM contract mapping ────────────────────

test('authoringModeFor: the idea door with planFirst off is the idea contract', () => {
  assert.equal(authoringModeFor('idea', false), 'idea')
})

test('authoringModeFor: the idea door with planFirst on is the story (multi-shot planner) contract', () => {
  assert.equal(authoringModeFor('idea', true), 'story')
})

test('authoringModeFor: the prompt door is always the prompt contract, regardless of planFirst', () => {
  assert.equal(authoringModeFor('prompt', false), 'prompt')
  assert.equal(authoringModeFor('prompt', true), 'prompt')
})

test('authoringModeFor: the video door is the idea contract — continuing footage authors scene 1 the same way', () => {
  assert.equal(authoringModeFor('video', false), 'idea')
  assert.equal(authoringModeFor('video', true), 'idea')
})

// ── entryWorkflow — the CTA/Cmd+Enter dispatch ─────────────────────────────

test('entryWorkflow: idea + planFirst is the plan-the-whole-arc workflow', () => {
  assert.equal(entryWorkflow('idea', true), 'story-plan')
})

test('entryWorkflow: idea without planFirst is the single-clip workflow', () => {
  assert.equal(entryWorkflow('idea', false), 'idea-prompt')
})

test('entryWorkflow: prompt is always prompt-revise', () => {
  assert.equal(entryWorkflow('prompt', false), 'prompt-revise')
  assert.equal(entryWorkflow('prompt', true), 'prompt-revise')
})

test('entryWorkflow: video is the single-clip workflow, same as idea without planFirst', () => {
  assert.equal(entryWorkflow('video', false), 'idea-prompt')
  assert.equal(entryWorkflow('video', true), 'idea-prompt')
})

// ── migrateEntryMode — an existing profile must never land on a dead mode ──

test('migrateEntryMode: a profile carrying the pre-redesign story door lands on idea + plan-first', () => {
  const migrated = migrateEntryMode('story')
  assert.deepEqual(migrated, { studioMode: 'idea', planFirst: true })
})

test('migrateEntryMode: story ignores any stale planFirst value already on the profile — it is always turned ON', () => {
  const migrated = migrateEntryMode('story', false)
  assert.deepEqual(migrated, { studioMode: 'idea', planFirst: true })
})

test('migrateEntryMode: a current door value passes through unchanged, idempotent on every load', () => {
  assert.deepEqual(migrateEntryMode('idea', true), { studioMode: 'idea', planFirst: true })
  assert.deepEqual(migrateEntryMode('idea', false), { studioMode: 'idea', planFirst: false })
  assert.deepEqual(migrateEntryMode('prompt'), { studioMode: 'prompt', planFirst: false })
  assert.deepEqual(migrateEntryMode('video'), { studioMode: 'video', planFirst: false })
})

test('migrateEntryMode: a fresh profile (nothing stored) lands on the idea door, plan-first off', () => {
  assert.deepEqual(migrateEntryMode(undefined), { studioMode: 'idea', planFirst: false })
})

test('migrateEntryMode: garbage input is treated the same as a fresh profile rather than thrown', () => {
  assert.deepEqual(migrateEntryMode('something-that-was-never-a-mode'), { studioMode: 'idea', planFirst: false })
  assert.deepEqual(migrateEntryMode(42), { studioMode: 'idea', planFirst: false })
})

// ── promptSourceForEntryMode — retyped to the authoring contract ───────────

test('promptSourceForEntryMode: an authored prompt always wins, regardless of contract', () => {
  assert.equal(promptSourceForEntryMode('idea', 'the source', 'the authored prompt', false), 'the authored prompt')
})

test('promptSourceForEntryMode: the prompt contract trusts its pasted source even when it fails the heuristic', () => {
  assert.equal(promptSourceForEntryMode('prompt', 'a rough source', '', false), 'a rough source')
})

test('promptSourceForEntryMode: the idea/story contracts keep the heuristic', () => {
  assert.equal(promptSourceForEntryMode('idea', 'a rough source', '', false), '')
  assert.equal(promptSourceForEntryMode('story', 'looks like a prompt', '', true), 'looks like a prompt')
})
