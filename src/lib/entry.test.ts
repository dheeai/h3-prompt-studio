import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authoringModeForContent,
  migrateBreakIntoScenes,
  promptSourceForAuthoringMode,
} from './entry'

// ── authoringModeForContent — the composer's TEXT decides the contract, ───
// ── never a picked door ─────────────────────────────────────────────────

test('authoringModeForContent: a finished prompt is always the prompt contract, break-into-scenes or not', () => {
  assert.equal(authoringModeForContent('prompt', false), 'prompt')
  assert.equal(authoringModeForContent('prompt', true), 'prompt')
})

test('authoringModeForContent: anything else with break-into-scenes off is the single-clip idea contract', () => {
  assert.equal(authoringModeForContent('idea', false), 'idea')
  assert.equal(authoringModeForContent('story', false), 'idea')
  assert.equal(authoringModeForContent('brief', false), 'idea')
  assert.equal(authoringModeForContent('direction-sheet', false), 'idea')
  assert.equal(authoringModeForContent('rough-prompt', false), 'idea')
  assert.equal(authoringModeForContent('empty', false), 'idea')
})

test('authoringModeForContent: anything else with break-into-scenes on is the multi-shot story contract', () => {
  assert.equal(authoringModeForContent('idea', true), 'story')
  assert.equal(authoringModeForContent('story', true), 'story')
  assert.equal(authoringModeForContent('brief', true), 'story')
})

// ── migrateBreakIntoScenes — an existing profile must never land on a dead ─
// ── door; it collapses onto the one remaining control ───────────────────

test('migrateBreakIntoScenes: the pre-redesign story door becomes break-into-scenes on', () => {
  assert.deepEqual(migrateBreakIntoScenes('story'), { breakIntoScenes: true })
})

test('migrateBreakIntoScenes: story ignores any stale planFirst value already on the profile — it is always turned ON', () => {
  assert.deepEqual(migrateBreakIntoScenes('story', false), { breakIntoScenes: true })
})

test('migrateBreakIntoScenes: the idea door carries its planFirst value through', () => {
  assert.deepEqual(migrateBreakIntoScenes('idea', true), { breakIntoScenes: true })
  assert.deepEqual(migrateBreakIntoScenes('idea', false), { breakIntoScenes: false })
})

test('migrateBreakIntoScenes: the prompt and video doors never meant break-into-scenes, regardless of a stale planFirst', () => {
  assert.deepEqual(migrateBreakIntoScenes('prompt', true), { breakIntoScenes: false })
  assert.deepEqual(migrateBreakIntoScenes('video', true), { breakIntoScenes: false })
})

test('migrateBreakIntoScenes: a fresh profile (nothing stored) lands on break-into-scenes off', () => {
  assert.deepEqual(migrateBreakIntoScenes(undefined), { breakIntoScenes: false })
})

test('migrateBreakIntoScenes: garbage input is treated the same as a fresh profile rather than thrown', () => {
  assert.deepEqual(migrateBreakIntoScenes('something-that-was-never-a-mode'), { breakIntoScenes: false })
  assert.deepEqual(migrateBreakIntoScenes(42), { breakIntoScenes: false })
})

// ── promptSourceForAuthoringMode — retyped to the authoring contract ───────

test('promptSourceForAuthoringMode: an authored prompt always wins, regardless of contract', () => {
  assert.equal(promptSourceForAuthoringMode('idea', 'the source', 'the authored prompt', false), 'the authored prompt')
})

test('promptSourceForAuthoringMode: the prompt contract trusts its pasted source even when it fails the heuristic', () => {
  assert.equal(promptSourceForAuthoringMode('prompt', 'a rough source', '', false), 'a rough source')
})

test('promptSourceForAuthoringMode: the idea/story contracts keep the heuristic', () => {
  assert.equal(promptSourceForAuthoringMode('idea', 'a rough source', '', false), '')
  assert.equal(promptSourceForAuthoringMode('story', 'looks like a prompt', '', true), 'looks like a prompt')
})
