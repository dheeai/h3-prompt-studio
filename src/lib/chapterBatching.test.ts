import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planChapterBatches } from './chapterBatching'
import type { ChapterBreakdown, ChapterBreakdownClip, LedgerEntity } from './chapterBreakdown'

function shot(n: number) {
  return { shot: n, seconds: 5, camera: 'medium' as const, subject: 's', action: 'a', dialogue: null }
}

function clip(clipNum: number): ChapterBreakdownClip {
  return { clip: clipNum, beat: `beat ${clipNum}`, shots: [shot(1), shot(2), shot(3)], forwardPull: '', stateChanges: [] }
}

function entity(id: string, clipIds: number[]): LedgerEntity {
  return { id, name: id, kind: 'character', clipIds, axes: [], initial: [] }
}

function breakdown(clipNums: number[], entities: LedgerEntity[]): ChapterBreakdown {
  return { chapter: 'c', ledger: { entities }, clips: clipNums.map(clip), at: 0 }
}

const alwaysHasPlate = () => true

test('planChapterBatches: a chapter with 9 or fewer distinct entities is ONE batch — the common case', () => {
  const entities = Array.from({ length: 9 }, (_, i) => entity(`e${i}`, [1, 2, 3]))
  const b = breakdown([1, 2, 3], entities)
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.equal(plan.batches.length, 1)
  assert.equal(plan.batches[0].clipFrom, 1)
  assert.equal(plan.batches[0].clipTo, 3)
  assert.equal(plan.batches[0].entityIds.length, 9)
  assert.deepEqual(plan.splitEntityIds, [])
  assert.deepEqual(plan.overflowClips, [])
})

test('planChapterBatches: an entity with no plate at all never counts toward the 9-slot budget', () => {
  const entities = [...Array.from({ length: 9 }, (_, i) => entity(`e${i}`, [1])), entity('no_plate', [1])]
  const b = breakdown([1], entities)
  const plan = planChapterBatches(b, (id) => id !== 'no_plate')
  assert.equal(plan.batches.length, 1)
  assert.equal(plan.batches[0].entityIds.length, 9)
  assert.ok(!plan.batches[0].entityIds.includes('no_plate'))
})

test('planChapterBatches: cuts a NEW batch the moment the running distinct-entity count would exceed 9', () => {
  // Clips 1-3 introduce entities e0..e8 (9 total, exactly at the cap).
  // Clip 4 introduces a 10th entity, e9 — must start a new batch.
  const entities = [
    ...Array.from({ length: 9 }, (_, i) => entity(`e${i}`, [1, 2, 3])),
    entity('e9', [4]),
  ]
  const b = breakdown([1, 2, 3, 4], entities)
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.equal(plan.batches.length, 2)
  assert.deepEqual([plan.batches[0].clipFrom, plan.batches[0].clipTo], [1, 3])
  assert.deepEqual([plan.batches[1].clipFrom, plan.batches[1].clipTo], [4, 4])
  assert.deepEqual(plan.overflowClips, [])
})

test('planChapterBatches: batches are always consecutive clip RANGES, never a scattered selection', () => {
  const entities = [entity('a', [1, 3]), entity('b', [2])]
  const b = breakdown([1, 2, 3], entities)
  const plan = planChapterBatches(b, alwaysHasPlate, 1)
  // With a cap of 1, clip 1 (entity a) starts batch 1; clip 2 (entity b,
  // different entity) forces batch 2; clip 3 (entity a again) forces batch 3
  // — 'a' reappearing after a gap is exactly the split-entity case, not a
  // reason to merge batch 1 and batch 3 back together (clip ranges never
  // reorder or merge non-adjacent runs).
  assert.equal(plan.batches.length, 3)
  assert.deepEqual(plan.batches.map((x) => [x.clipFrom, x.clipTo]), [[1, 1], [2, 2], [3, 3]])
  assert.deepEqual(plan.splitEntityIds, ['a'])
})

test('planChapterBatches: splitEntityIds names exactly the entities appearing in MORE THAN ONE batch', () => {
  const entities = [
    ...Array.from({ length: 9 }, (_, i) => entity(`e${i}`, [1, 2])),
    entity('carries_over', [2, 3]),
  ]
  const b = breakdown([1, 2, 3], entities)
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.ok(plan.batches.length >= 2)
  assert.ok(plan.splitEntityIds.includes('carries_over'))
})

test('planChapterBatches: a single clip whose own on-screen entity count exceeds the cap is reported as overflowClips, never silently truncated', () => {
  const entities = Array.from({ length: 10 }, (_, i) => entity(`e${i}`, [1]))
  const b = breakdown([1], entities)
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.deepEqual(plan.overflowClips, [1])
  // Still produces exactly one batch (a clip can't be split) — the operator
  // is told about the overflow, not blocked from proceeding.
  assert.equal(plan.batches.length, 1)
})

test('planChapterBatches: clips out of array order are planned in CLIP-NUMBER order, not array order', () => {
  const b: ChapterBreakdown = { chapter: 'c', ledger: { entities: [entity('a', [1, 2])] }, clips: [clip(2), clip(1)], at: 0 }
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.deepEqual([plan.batches[0].clipFrom, plan.batches[0].clipTo], [1, 2])
})

test('planChapterBatches: an empty chapter (no clips) produces no batches', () => {
  const b: ChapterBreakdown = { chapter: 'c', ledger: { entities: [] }, clips: [], at: 0 }
  const plan = planChapterBatches(b, alwaysHasPlate)
  assert.deepEqual(plan.batches, [])
})
