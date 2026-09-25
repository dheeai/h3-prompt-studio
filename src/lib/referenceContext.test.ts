import { test } from 'node:test'
import assert from 'node:assert/strict'
import { referenceContextForClip } from './referenceContext'
import type { ChapterBreakdown, ChapterBreakdownClip, LedgerEntity } from './chapterBreakdown'
import type { Plate } from './types'

function shot(n: number) {
  return { shot: n, seconds: 5, camera: 'medium' as const, subject: 's', action: 'a', dialogue: null }
}

function clip(clipNum: number): ChapterBreakdownClip {
  return { clip: clipNum, beat: `beat ${clipNum}`, shots: [shot(1), shot(2), shot(3)], forwardPull: '', stateChanges: [] }
}

function entity(id: string, clipIds: number[]): LedgerEntity {
  return { id, name: id, kind: 'character', clipIds, axes: [], initial: [] }
}

function plate(id: string, job: string): Plate {
  return { id, name: id, job, kind: 'image', mode: 'carried', addedAt: 0 }
}

function breakdown(clipNums: number[], entities: LedgerEntity[]): ChapterBreakdown {
  return { chapter: 'c', ledger: { entities }, clips: clipNums.map(clip), at: 0 }
}

test('referenceContextForClip: a chapter within the 9-slot cap gets ONE batch, same ref slots for every clip', () => {
  const entities = [entity('a', [1, 2]), entity('b', [2])]
  const b = breakdown([1, 2], entities)
  const resolved = { a: 'pa', b: 'pb' }
  const plates = [plate('pa', 'plate a job'), plate('pb', 'plate b job')]

  const ctx1 = referenceContextForClip(b, 1, resolved, plates)
  const ctx2 = referenceContextForClip(b, 2, resolved, plates)
  assert.deepEqual(ctx1.refSlots, ctx2.refSlots)
  assert.deepEqual(ctx1.refSlots, [{ slot: 1, id: 'a' }, { slot: 2, id: 'b' }])
})

test('referenceContextForClip: the registry description comes from the PLATE\'s own job text, never the entity name/kind alone', () => {
  const entities = [entity('a', [1])]
  const b = breakdown([1], entities)
  const ctx = referenceContextForClip(b, 1, { a: 'pa' }, [plate('pa', 'a woman in a blue cardigan')])
  assert.equal(ctx.registry.a.description, 'a woman in a blue cardigan')
  assert.equal(ctx.registry.a.name, 'a')
  assert.equal(ctx.registry.a.role, 'character')
  assert.deepEqual(ctx.registry.a.clipIds, [1])
})

test('referenceContextForClip: an entity resolved to null (no plate) gets no slot and no registry entry', () => {
  const entities = [entity('a', [1]), entity('b', [1])]
  const b = breakdown([1], entities)
  const ctx = referenceContextForClip(b, 1, { a: 'pa', b: null }, [plate('pa', 'job')])
  assert.deepEqual(ctx.refSlots, [{ slot: 1, id: 'a' }])
  assert.equal(ctx.registry.b, undefined)
})

test('referenceContextForClip: a >9-entity chapter gives DIFFERENT ref slots to clips in different batches', () => {
  const entities = [
    ...Array.from({ length: 9 }, (_, i) => entity(`e${i}`, [1, 2])),
    entity('e9', [3]),
  ]
  const b = breakdown([1, 2, 3], entities)
  const resolved: Record<string, string> = {}
  const plates: Plate[] = []
  for (const e of entities) {
    resolved[e.id] = `p_${e.id}`
    plates.push(plate(`p_${e.id}`, `${e.id} job`))
  }

  const clip1Ctx = referenceContextForClip(b, 1, resolved, plates)
  const clip3Ctx = referenceContextForClip(b, 3, resolved, plates)
  // Clip 1 is in the first batch (e0..e8); clip 3 forces a second batch
  // (e9 alone) — different slot assignments, not a film-wide constant.
  assert.equal(clip1Ctx.refSlots.length, 9)
  assert.ok(!clip1Ctx.refSlots.some((s) => s.id === 'e9'))
  assert.deepEqual(clip3Ctx.refSlots, [{ slot: 1, id: 'e9' }])
})

test('referenceContextForClip: a clip number outside every batch (an empty chapter) gets no slots and an empty registry', () => {
  const b: ChapterBreakdown = { chapter: 'c', ledger: { entities: [] }, clips: [], at: 0 }
  const ctx = referenceContextForClip(b, 1, {}, [])
  assert.deepEqual(ctx.refSlots, [])
  assert.deepEqual(ctx.registry, {})
})
