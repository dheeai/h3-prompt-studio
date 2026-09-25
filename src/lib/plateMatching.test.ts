import { test } from 'node:test'
import assert from 'node:assert/strict'
import { autoMatchPlateForEntity, entitiesNeedingGeneratedPlates, normalizePlateName, resolveEntityPlates } from './plateMatching'
import type { LedgerEntity } from './chapterBreakdown'
import type { Plate } from './types'

function plate(partial: Partial<Plate>): Plate {
  return { id: 'p1', name: 'Nusrat', job: 'her identity', kind: 'image', mode: 'carried', addedAt: 0, ...partial }
}

function entity(partial: Partial<LedgerEntity>): LedgerEntity {
  return { id: 'nusrat', name: 'Nusrat', kind: 'character', clipIds: [1], axes: [], initial: [], ...partial }
}

test('normalizePlateName: lowercases, strips punctuation to spaces, trims', () => {
  assert.equal(normalizePlateName('Nusrat — identity plate'), 'nusrat identity plate')
  assert.equal(normalizePlateName('  Nusrat  '), 'nusrat')
})

test('autoMatchPlateForEntity: an exact name match (after normalisation)', () => {
  const plates = [plate({ id: 'p1', name: 'Nusrat' })]
  assert.equal(autoMatchPlateForEntity('Nusrat', plates), 'p1')
})

test('autoMatchPlateForEntity: a founder-typed label containing the entity name still matches', () => {
  const plates = [plate({ id: 'p1', name: 'Nusrat — identity plate' })]
  assert.equal(autoMatchPlateForEntity('Nusrat', plates), 'p1')
})

test('autoMatchPlateForEntity: an entity name containing the plate\'s (shorter) name still matches', () => {
  const plates = [plate({ id: 'p1', name: 'shop' })]
  assert.equal(autoMatchPlateForEntity('the tailoring shop', plates), 'p1')
})

test('autoMatchPlateForEntity: no match at all is null', () => {
  const plates = [plate({ id: 'p1', name: 'Farid' })]
  assert.equal(autoMatchPlateForEntity('Nusrat', plates), null)
})

test('autoMatchPlateForEntity: an empty plate list is null, never throws', () => {
  assert.equal(autoMatchPlateForEntity('Nusrat', []), null)
})

test('resolveEntityPlates: auto-matches by name when no manual assignment exists', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' }), entity({ id: 'farid', name: 'Farid' })]
  const plates = [plate({ id: 'p1', name: 'Nusrat' })]
  const resolved = resolveEntityPlates(entities, plates)
  assert.equal(resolved.nusrat, 'p1')
  assert.equal(resolved.farid, null)
})

test('resolveEntityPlates: a manual assignment always wins over the auto-match', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' })]
  const plates = [plate({ id: 'p1', name: 'Nusrat' }), plate({ id: 'p2', name: 'some other plate' })]
  const resolved = resolveEntityPlates(entities, plates, { nusrat: 'p2' })
  assert.equal(resolved.nusrat, 'p2')
})

test('resolveEntityPlates: a manual assignment naming a deleted plate id reads as null, not a dangling reference', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' })]
  const plates = [plate({ id: 'p1', name: 'Nusrat' })]
  const resolved = resolveEntityPlates(entities, plates, { nusrat: 'p999' })
  assert.equal(resolved.nusrat, null)
})

test('resolveEntityPlates: an explicit empty-string manual assignment means "no plate", even if an auto-match exists', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' })]
  const plates = [plate({ id: 'p1', name: 'Nusrat' })]
  const resolved = resolveEntityPlates(entities, plates, { nusrat: '' })
  assert.equal(resolved.nusrat, null)
})

test('entitiesNeedingGeneratedPlates: exactly the entities resolved to null', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' }), entity({ id: 'farid', name: 'Farid' })]
  const resolved = { nusrat: 'p1', farid: null }
  const missing = entitiesNeedingGeneratedPlates(entities, resolved)
  assert.deepEqual(missing.map((e) => e.id), ['farid'])
})

test('entitiesNeedingGeneratedPlates: every entity resolved is an empty list', () => {
  const entities = [entity({ id: 'nusrat', name: 'Nusrat' })]
  assert.deepEqual(entitiesNeedingGeneratedPlates(entities, { nusrat: 'p1' }), [])
})
