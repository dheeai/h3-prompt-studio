import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countFromIndex, dropFromIndex, externalVideoForReplace, scenesBefore, sceneRangeFor } from './chainEdit'
import type { ClipChainInfo } from './types'

type FakeClip = { id: string; prompt: string; frames: number; steps?: number; seed?: number; chain?: ClipChainInfo }

function scene(id: string, runName: string, sceneIndex: number, extra: Partial<FakeClip> = {}): FakeClip {
  return { id, prompt: `prompt ${id}`, frames: 124, seed: 1000 + sceneIndex, chain: { runName, sceneIndex }, ...extra }
}

// ── sceneRangeFor — the "N:N" scheduler syntax for resampling one scene ────

test('sceneRangeFor: a bare index becomes N:N, never a plain N', () => {
  assert.equal(sceneRangeFor(1), '1:1')
  assert.equal(sceneRangeFor(4), '4:4')
})

// ── scenesBefore — what a Replace/Continue must resend byte-identically ───

test('scenesBefore: only scenes strictly before the target, in scene order, same runName', () => {
  const clips = [scene('c3', 'run-a', 3), scene('c1', 'run-a', 1), scene('c2', 'run-a', 2), scene('other', 'run-b', 1)]
  const before = scenesBefore(clips as (FakeClip & { chain: ClipChainInfo })[], 'run-a', 3)
  assert.deepEqual(before.map((c) => c.id), ['c1', 'c2'])
})

test('scenesBefore: continuing from an EARLIER scene never resends a later scene that is about to be discarded', () => {
  // A 5-scene chain; continuing from scene 2 targets scene 3 — scenes 3-5
  // must never appear in what gets resent, even though they still exist in
  // local state at the moment this is computed (dropFromIndex removes them
  // separately, afterward).
  const clips = [1, 2, 3, 4, 5].map((n) => scene(`c${n}`, 'run-a', n))
  const before = scenesBefore(clips as (FakeClip & { chain: ClipChainInfo })[], 'run-a', 3)
  assert.deepEqual(before.map((c) => c.id), ['c1', 'c2'])
})

test('scenesBefore: a fresh scene 1 (target 1) has nothing before it', () => {
  const clips = [scene('c1', 'run-a', 1)]
  assert.deepEqual(scenesBefore(clips as (FakeClip & { chain: ClipChainInfo })[], 'run-a', 1), [])
})

// ── dropFromIndex / countFromIndex — the append-only invalidation ─────────

test('dropFromIndex: keeps everything before the target and everything in a different chain', () => {
  const clips = [1, 2, 3, 4].map((n) => scene(`c${n}`, 'run-a', n))
  const other = scene('other', 'run-b', 4)
  const kept = dropFromIndex([...clips, other], 'run-a', 3)
  assert.deepEqual(kept.map((c) => c.id), ['c1', 'c2', 'other'])
})

test('dropFromIndex: a fresh continuation (nothing yet at the target) is a no-op', () => {
  const clips = [1, 2].map((n) => scene(`c${n}`, 'run-a', n))
  assert.deepEqual(dropFromIndex(clips, 'run-a', 3), clips)
})

test('countFromIndex: replacing scene 3 of a 5-scene chain discards scenes 4 and 5, not scene 3 itself', () => {
  const clips = [1, 2, 3, 4, 5].map((n) => scene(`c${n}`, 'run-a', n))
  // Scene 3 itself is being overwritten, not "discarded" — the invalidation
  // count a caller shows before a Replace is scenesFrom(target+1).
  assert.equal(countFromIndex(clips, 'run-a', 4), 2)
})

test('countFromIndex: continuing from scene 2 of a 5-scene chain (writing scene 3) discards scenes 4 and 5', () => {
  const clips = [1, 2, 3, 4, 5].map((n) => scene(`c${n}`, 'run-a', n))
  assert.equal(countFromIndex(clips, 'run-a', 4), 2)
})

test('countFromIndex: replacing the newest scene discards nothing', () => {
  const clips = [1, 2, 3].map((n) => scene(`c${n}`, 'run-a', n))
  assert.equal(countFromIndex(clips, 'run-a', 4), 0)
})

test('countFromIndex: zero for an unknown runName', () => {
  const clips = [1, 2].map((n) => scene(`c${n}`, 'run-a', n))
  assert.equal(countFromIndex(clips, 'run-nonexistent', 1), 0)
})

// ── externalVideoForReplace — a scene-1 Replace re-passes the original ────
// ── footage; nothing else ever can ─────────────────────────────────────────

test('externalVideoForReplace: scene 1 with a recorded external video re-passes it, endpoint included', () => {
  const target = scene('c1', 'run-a', 1, {
    chain: { runName: 'run-a', sceneIndex: 1, continuesExternalVideo: true, externalVideo: { filename: 'src.mp4', prependOriginal: true, endpointId: 'ep1' } },
  })
  assert.deepEqual(externalVideoForReplace(target), { filename: 'src.mp4', prependOriginal: true, endpointId: 'ep1' })
})

test('externalVideoForReplace: scene 1 with no recorded external video re-passes nothing', () => {
  const target = scene('c1', 'run-a', 1)
  assert.equal(externalVideoForReplace(target), null)
})

test('externalVideoForReplace: any scene other than 1 never re-passes one, even if somehow recorded', () => {
  const target = scene('c2', 'run-a', 2, {
    chain: { runName: 'run-a', sceneIndex: 2, continuesExternalVideo: true, externalVideo: { filename: 'src.mp4', prependOriginal: true, endpointId: 'ep1' } },
  })
  assert.equal(externalVideoForReplace(target), null)
})

test('externalVideoForReplace: a clip with no chain at all re-passes nothing', () => {
  assert.equal(externalVideoForReplace({ chain: undefined }), null)
})
