import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  authoringModeForContent,
  authorContinuation,
  clearDraftContext,
  continuationSource,
  migrateBreakIntoScenes,
  promptSourceForAuthoringMode,
  withContinuationFrame,
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

// ── authorContinuation — ONE model call per continuation (2026-09-16), ────
// ── not Hand-off then Direct then Draft ────────────────────────────────

test('authorContinuation: a single draft call reaches ready', async () => {
  const calls: string[] = []
  const ready = await authorContinuation(async (stage) => { calls.push(stage); return { stage } })
  assert.equal(ready, 'ready')
  assert.deepEqual(calls, ['draft'])
})

test('authorContinuation: never calls run more than once, even when it succeeds', async () => {
  let callCount = 0
  await authorContinuation(async () => { callCount++; return { ok: true } })
  assert.equal(callCount, 1)
})

test('authorContinuation: a failed draft aborts, and nothing is retried', async () => {
  const calls: string[] = []
  const result = await authorContinuation(async (stage) => { calls.push(stage); return null })
  assert.equal(result, 'aborted')
  assert.deepEqual(calls, ['draft'])
})

test('authorContinuation: cancelled before the call prevents it entirely', async () => {
  const calls: string[] = []
  const result = await authorContinuation(async (stage) => { calls.push(stage); return { stage } }, () => true)
  assert.equal(result, 'aborted')
  assert.deepEqual(calls, [])
})

test('authorContinuation: cancelled after a successful call still reports aborted', async () => {
  let cancelled = false
  const result = await authorContinuation(async () => { cancelled = true; return { ok: true } }, () => cancelled)
  assert.equal(result, 'aborted')
})

// ── continuationSource — composed from the breakdown's covers / the film's ─
// ── spine now, never a Hand-off paraphrase ────────────────────────────────

test('continuationSource: an explicit note always wins', () => {
  assert.equal(continuationSource('Make the next beat quieter', { covers: 'she opens the hatch', spine: 'a rescue' }), 'Make the next beat quieter')
})

test('continuationSource: falls back to the breakdown clip\'s own covers', () => {
  assert.equal(continuationSource(undefined, { covers: 'she opens the hatch and steps through' }), 'COVERS: she opens the hatch and steps through')
  assert.equal(continuationSource('', { covers: 'she opens the hatch' }), 'COVERS: she opens the hatch')
})

test('continuationSource: no covers falls back to the film\'s spine', () => {
  assert.equal(
    continuationSource(undefined, { spine: 'a woman escapes a sinking ship' }),
    'Continue the film — it is about: a woman escapes a sinking ship. Advance from the previous clip\'s ending state.',
  )
})

test('continuationSource: nothing at all falls back to a generic instruction', () => {
  assert.equal(continuationSource(undefined, {}), 'Continue from the ending state of the previous clip.')
  assert.equal(continuationSource('   ', { covers: '  ', spine: '  ' }), 'Continue from the ending state of the previous clip.')
})

// ── clearDraftContext — the continuation frame is part of what a fresh ────
// ── entry must never inherit ──────────────────────────────────────────────

test('clearDraftContext: clears the continuation frame along with the rest of a draft context', () => {
  const previous = {
    story: 'old scene', versions: [{ id: 'v1' }], currentId: 'v1', chat: [{ role: 'user', text: 'old note' }],
    film: { role: 'rising' as const, spine: 'old film', precedes: '', follows: '', clipIndex: 2 },
    parentClipId: 'clip-1', parentPrompt: 'old prompt', breakdown: { spine: 'old film', clips: [] },
    continuationFrame: 'data:image/png;base64,STALE_FRAME',
    keep: 'configuration',
  }
  const next = clearDraftContext(previous)
  assert.equal(next.continuationFrame, undefined)
  assert.equal(next.keep, 'configuration')
})

// ── withContinuationFrame — the ONE seam the frame passes through, and the ─
// ── proof it can never land in the caller's own plate-image array ────────

test('withContinuationFrame: no frame leaves the plate images untouched', () => {
  const plateImages = [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,PLATE' } }]
  assert.equal(withContinuationFrame(plateImages, undefined), plateImages)
})

test('withContinuationFrame: a frame is appended to a NEW array, never spliced into the one passed in', () => {
  const plateImages = [{ type: 'image_url' as const, image_url: { url: 'data:image/png;base64,PLATE' } }]
  const withFrame = withContinuationFrame(plateImages, 'data:image/png;base64,FRAME')
  assert.equal(plateImages.length, 1, 'the caller\'s own plate array must never be mutated')
  assert.equal(withFrame.length, 2)
  assert.deepEqual(withFrame[0], plateImages[0])
  assert.deepEqual(withFrame[1], { type: 'image_url', image_url: { url: 'data:image/png;base64,FRAME' } })
})
