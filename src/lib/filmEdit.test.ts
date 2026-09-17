import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipsAfterStop, countFromIndex, dropFromIndex, dropInvalidatedAutoDraft, redoSeed, validatedClipAt } from './filmEdit'

type FakeClip = { id: string; state?: string; extender?: { nodeId: string; sceneIndex: number } }

function scene(id: string, nodeId: string, sceneIndex: number, state: string = 'done'): FakeClip {
  return { id, state, extender: { nodeId, sceneIndex } }
}

// ── dropFromIndex / countFromIndex — the linear-prefix invalidation ────────

test('dropFromIndex: keeps everything before the target and everything in a different film', () => {
  const clips = [1, 2, 3, 4].map((n) => scene(`c${n}`, 'film-a', n))
  const other = scene('other', 'film-b', 4)
  const kept = dropFromIndex([...clips, other], 'film-a', 3)
  assert.deepEqual(kept.map((c) => c.id), ['c1', 'c2', 'other'])
})

test('dropFromIndex: a fresh continuation (nothing yet at the target) is a no-op', () => {
  const clips = [1, 2].map((n) => scene(`c${n}`, 'film-a', n))
  assert.deepEqual(dropFromIndex(clips, 'film-a', 3), clips)
})

test('countFromIndex: continuing from scene 2 of a 5-scene film (writing scene 3) discards scenes 4 and 5', () => {
  const clips = [1, 2, 3, 4, 5].map((n) => scene(`c${n}`, 'film-a', n))
  assert.equal(countFromIndex(clips, 'film-a', 4), 2)
})

test('countFromIndex: continuing from the newest scene discards nothing', () => {
  const clips = [1, 2, 3].map((n) => scene(`c${n}`, 'film-a', n))
  assert.equal(countFromIndex(clips, 'film-a', 4), 0)
})

test('countFromIndex: zero for an unknown nodeId', () => {
  const clips = [1, 2].map((n) => scene(`c${n}`, 'film-a', n))
  assert.equal(countFromIndex(clips, 'film-nonexistent', 1), 0)
})

// ── dropInvalidatedAutoDraft — HAZARD 1: a pre-authored draft goes stale ───
// ── the moment its parent is continued-from-early ─────────────────────────

test('dropInvalidatedAutoDraft: no pending draft is a no-op', () => {
  const versions = [{ id: 'v1' }, { id: 'v2' }]
  const result = dropInvalidatedAutoDraft(versions, null, 2)
  assert.equal(result.discarded, false)
  assert.deepEqual(result.versions, versions)
})

test('dropInvalidatedAutoDraft: writing the draft\'s parent scene discards it', () => {
  // Scene 2 landed, a draft for scene 3 was pre-authored, then the operator
  // continues from scene 2 again — the draft assumed scene 2's old frame/prompt.
  const versions = [{ id: 'v1' }, { id: 'v-draft-3' }]
  const result = dropInvalidatedAutoDraft(versions, { versionId: 'v-draft-3', sceneIndex: 3 }, 2)
  assert.equal(result.discarded, true)
  assert.deepEqual(result.versions.map((v) => v.id), ['v1'])
})

test('dropInvalidatedAutoDraft: continuing from an EARLIER scene than the draft\'s parent also discards it', () => {
  // Draft pre-authored for scene 4 (parent: scene 3). Operator continues from
  // scene 1 instead, which will (re)write scene 2 next — scene 4's draft no
  // longer has a valid scene 3 to follow.
  const versions = [{ id: 'v-draft-4' }]
  const result = dropInvalidatedAutoDraft(versions, { versionId: 'v-draft-4', sceneIndex: 4 }, 2)
  assert.equal(result.discarded, true)
})

test('dropInvalidatedAutoDraft: rendering the draft itself, at its own position, is consumption — never a discard', () => {
  const versions = [{ id: 'v-draft-3' }]
  const result = dropInvalidatedAutoDraft(versions, { versionId: 'v-draft-3', sceneIndex: 3 }, 3)
  assert.equal(result.discarded, false)
  assert.deepEqual(result.versions, versions)
})

test('dropInvalidatedAutoDraft: writing an EARLIER, unrelated scene leaves a later draft alone', () => {
  const versions = [{ id: 'v-draft-3' }]
  const result = dropInvalidatedAutoDraft(versions, { versionId: 'v-draft-3', sceneIndex: 3 }, 4)
  assert.equal(result.discarded, false)
})

// ── redo a single scene — validatedClipAt / redoSeed ───────────────────────

test('redoing scene 3 of a 5-scene film: dropFromIndex + validatedClipAt marks 3..5 unvalidated, leaves 1..2 validated', () => {
  const clips = [1, 2, 3, 4, 5].map((n) => scene(`c${n}`, 'film-a', n))
  const after = dropFromIndex(clips, 'film-a', 3)

  assert.ok(validatedClipAt(after, 'film-a', 1))
  assert.ok(validatedClipAt(after, 'film-a', 2))
  assert.equal(validatedClipAt(after, 'film-a', 3), undefined)
  assert.equal(validatedClipAt(after, 'film-a', 4), undefined)
  assert.equal(validatedClipAt(after, 'film-a', 5), undefined)
})

test('validatedClipAt ignores a clip that exists at that index but never landed (queued/failed)', () => {
  const clips = [scene('c1', 'film-a', 1, 'done'), scene('c2', 'film-a', 2, 'failed')]
  assert.ok(validatedClipAt(clips, 'film-a', 1))
  assert.equal(validatedClipAt(clips, 'film-a', 2), undefined)
})

test('validatedClipAt is unaffected by a different film sharing the same scene index', () => {
  const clips = [scene('c1', 'film-a', 1), scene('c2', 'film-b', 1)]
  assert.equal(validatedClipAt(clips, 'film-nonexistent', 1), undefined)
  assert.ok(validatedClipAt(clips, 'film-b', 1))
})

test('redoSeed: default (no keepSeed) draws a fresh seed and ignores the prior one', () => {
  assert.equal(redoSeed(42, false, () => 999), 999)
  assert.equal(redoSeed(42, undefined, () => 999), 999)
})

test('redoSeed: keepSeed reuses the prior seed exactly, never drawing a fresh one', () => {
  let drawn = false
  const seed = redoSeed(42, true, () => {
    drawn = true
    return 999
  })
  assert.equal(seed, 42)
  assert.equal(drawn, false)
})

test('redoSeed: keepSeed with no prior seed on record falls back to 0, same default buildExtenderClipsJson elsewhere applies', () => {
  assert.equal(redoSeed(undefined, true, () => 999), 0)
})

// ── clipsAfterStop — what a STOPPED render leaves behind (2026-09-17 brief:
// ── "no way to cancel a job") ────────────────────────────────────────────

test('clipsAfterStop: a rendering clip of the stopped job reverts to queued, never failed', () => {
  const clips = [scene('c1', 'film-a', 1, 'rendering')]
  const after = clipsAfterStop(clips, 'film-a')
  assert.equal(after[0].state, 'queued')
})

test('clipsAfterStop: every rendering clip of the whole batch reverts, not just one', () => {
  const clips = [scene('c1', 'film-a', 1, 'rendering'), scene('c2', 'film-a', 2, 'rendering'), scene('c3', 'film-a', 3, 'rendering')]
  const after = clipsAfterStop(clips, 'film-a')
  assert.deepEqual(after.map((c) => c.state), ['queued', 'queued', 'queued'])
})

test('clipsAfterStop: a clip already done before this submit is left alone — a stop cannot un-finish it', () => {
  const clips = [scene('c1', 'film-a', 1, 'done'), scene('c2', 'film-a', 2, 'rendering')]
  const after = clipsAfterStop(clips, 'film-a')
  assert.equal(after[0].state, 'done')
  assert.equal(after[1].state, 'queued')
})

test('clipsAfterStop: a clip of an unrelated film is untouched, even mid-render', () => {
  const clips = [scene('c1', 'film-a', 1, 'rendering'), scene('other', 'film-b', 1, 'rendering')]
  const after = clipsAfterStop(clips, 'film-a')
  assert.equal(after[0].state, 'queued')
  assert.equal(after[1].state, 'rendering')
})

test('clipsAfterStop: nothing rendering is a no-op', () => {
  const clips = [scene('c1', 'film-a', 1, 'done'), scene('c2', 'film-a', 2, 'queued')]
  assert.deepEqual(clipsAfterStop(clips, 'film-a'), clips)
})
