import assert from 'node:assert/strict'
import test from 'node:test'
import { FILM_LOOK_PRESETS, describeFilmLook, isFilmLookSet } from './filmLook'

test('isFilmLookSet: undefined, and an all-empty object, are both unset', () => {
  assert.equal(isFilmLookSet(undefined), false)
  assert.equal(isFilmLookSet({}), false)
  assert.equal(isFilmLookSet({ preset: '', freeText: '   ' }), false)
})

test('isFilmLookSet: a preset alone is enough', () => {
  assert.equal(isFilmLookSet({ preset: FILM_LOOK_PRESETS[0].id }), true)
})

test('isFilmLookSet: free text alone, with no preset, is enough', () => {
  assert.equal(isFilmLookSet({ freeText: 'match the look of a specific reference film' }), true)
})

test('describeFilmLook: nothing set writes nothing', () => {
  assert.equal(describeFilmLook(undefined), '')
  assert.equal(describeFilmLook({}), '')
})

test('describeFilmLook: a chosen preset writes its NAME and its full combination, not a fragment', () => {
  const preset = FILM_LOOK_PRESETS[0]
  const block = describeFilmLook({ preset: preset.id })
  assert.match(block, /FILM-WIDE LOOK/)
  assert.ok(block.includes(preset.name))
  assert.ok(block.includes(preset.description))
  assert.match(block, /not a measured optical guarantee/)
})

test('describeFilmLook: free text survives ALONGSIDE a preset, not instead of it', () => {
  const preset = FILM_LOOK_PRESETS[1]
  const block = describeFilmLook({ preset: preset.id, freeText: 'match the look of the reference clip I sent' })
  assert.ok(block.includes(preset.name))
  assert.match(block, /match the look of the reference clip I sent/)
})

test('describeFilmLook: free text alone works with no preset chosen', () => {
  const block = describeFilmLook({ freeText: 'a look reference, entirely hand-written' })
  assert.match(block, /a look reference, entirely hand-written/)
  for (const p of FILM_LOOK_PRESETS) assert.ok(!block.includes(p.description))
})

test('every preset carries a bestFor suggestion, worded as a suggestion, not a guarantee', () => {
  for (const p of FILM_LOOK_PRESETS) {
    assert.ok(p.bestFor.trim().length > 0)
    assert.doesNotMatch(p.bestFor, /guarantee|accurate|true field of view/i)
  }
})

test('an unrecognised stored preset id still writes something rather than silently vanishing', () => {
  const block = describeFilmLook({ preset: 'a-preset-id-since-removed' })
  assert.match(block, /a-preset-id-since-removed/)
})
