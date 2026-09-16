import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countFromIndex, dropFromIndex, dropInvalidatedAutoDraft } from './filmEdit'

type FakeClip = { id: string; extender?: { nodeId: string; sceneIndex: number } }

function scene(id: string, nodeId: string, sceneIndex: number): FakeClip {
  return { id, extender: { nodeId, sceneIndex } }
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
