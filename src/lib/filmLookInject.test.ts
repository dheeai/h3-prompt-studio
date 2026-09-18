import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILM_LOOK_PRESETS } from './filmLook'
import { filmLookPromptText, injectFilmLook, styleTargetFor } from './filmLookInject'

const LOOK = { preset: FILM_LOOK_PRESETS[1].id }
const TEXT = FILM_LOOK_PRESETS[1].description

// ── the two modes put the style in DIFFERENT places ─────────────────────

test('styleTargetFor: Ref2VA styles before the marker, the base modes after it', () => {
  assert.deepEqual(styleTargetFor('Ref2VA'), { field: 'detailed_description', placement: 'before-marker' })
  for (const mode of ['T2VA', 'I2VA', 'FL2VA', 'L2VA'] as const) {
    assert.deepEqual(styleTargetFor(mode), {
      field: 'integrated_multimodal_description',
      placement: 'after-marker',
    })
  }
})

test('Ref2VA: the look lands BEFORE [Shot 1], which is where that schema puts style', () => {
  const out = injectFilmLook({ detailed_description: '[Shot 1] A woman crosses a courtyard.' }, 'Ref2VA', LOOK)
  const body = out.detailed_description
  assert.ok(body.includes(TEXT))
  assert.ok(body.indexOf(TEXT) < body.indexOf('[Shot 1]'), body)
})

test('a base mode: the look lands AFTER the [Shot 1] marker, which is where THAT schema puts style', () => {
  const out = injectFilmLook(
    { integrated_multimodal_description: '[Shot 1] A woman crosses a courtyard.' },
    'T2VA',
    LOOK,
  )
  const body = out.integrated_multimodal_description
  assert.ok(body.includes(TEXT))
  assert.ok(body.indexOf('[Shot 1]') < body.indexOf(TEXT), body)
  // And the action still follows the style, not the other way round.
  assert.ok(body.indexOf(TEXT) < body.indexOf('A woman crosses'), body)
})

test('a base mode leaves detailed_description alone, and Ref2VA leaves the base field alone', () => {
  const both = { detailed_description: '[Shot 1] a', integrated_multimodal_description: '[Shot 1] b' }
  assert.equal(injectFilmLook(both, 'T2VA', LOOK).detailed_description, '[Shot 1] a')
  assert.equal(injectFilmLook(both, 'Ref2VA', LOOK).integrated_multimodal_description, '[Shot 1] b')
})

// ── it must be safe to call more than once ──────────────────────────────

test('injecting twice does not stack the look up — a prompt naming a thing twice weights it', () => {
  const once = injectFilmLook({ detailed_description: '[Shot 1] A woman crosses.' }, 'Ref2VA', LOOK)
  const twice = injectFilmLook(once, 'Ref2VA', LOOK)
  assert.deepEqual(twice, once)
  assert.equal(twice.detailed_description.split(TEXT).length - 1, 1)
})

test('a prompt an operator hand-edited but which still carries the look is left alone', () => {
  const edited = { detailed_description: `${TEXT}\n\n[Shot 1] A woman crosses, slower than before.` }
  assert.deepEqual(injectFilmLook(edited, 'Ref2VA', LOOK), edited)
})

// ── the unset case must change nothing at all ───────────────────────────

test('no look set leaves the sections byte-identical', () => {
  const sections = { detailed_description: '[Shot 1] A woman crosses.', summary: 's' }
  assert.equal(injectFilmLook(sections, 'Ref2VA', undefined), sections)
  assert.equal(injectFilmLook(sections, 'Ref2VA', {}), sections)
  assert.equal(filmLookPromptText(undefined), '')
})

// ── degenerate inputs ───────────────────────────────────────────────────

test('an empty section becomes just the look rather than a stray blank line', () => {
  assert.equal(injectFilmLook({ detailed_description: '   ' }, 'Ref2VA', LOOK).detailed_description, TEXT)
  assert.equal(injectFilmLook({}, 'T2VA', LOOK).integrated_multimodal_description, TEXT)
})

test('a body with NO [Shot 1] marker still gets the look, prepended', () => {
  // Dropping it for want of an anchor would lose the operator's own film-wide
  // decision on exactly the malformed prompts that need it most.
  const out = injectFilmLook({ integrated_multimodal_description: 'A woman crosses a courtyard.' }, 'T2VA', LOOK)
  const body = out.integrated_multimodal_description
  assert.ok(body.startsWith(TEXT), body)
  assert.ok(body.includes('A woman crosses a courtyard.'))
})

test('the marker is matched tolerantly on inner spacing, since a model writes it', () => {
  const out = injectFilmLook({ integrated_multimodal_description: '[Shot  1] A woman crosses.' }, 'T2VA', LOOK)
  assert.ok(out.integrated_multimodal_description.indexOf('[Shot  1]') < out.integrated_multimodal_description.indexOf(TEXT))
})

test('free text rides along with the preset, in one paragraph', () => {
  const out = injectFilmLook({ detailed_description: '[Shot 1] x' }, 'Ref2VA', {
    preset: FILM_LOOK_PRESETS[1].id,
    freeText: 'match the reference clip I sent',
  })
  assert.ok(out.detailed_description.includes(TEXT))
  assert.ok(out.detailed_description.includes('match the reference clip I sent'))
})

test('the injected text and the text shown to the model are the SAME string', () => {
  // If these ever drift, one of them is a lie about what the film is shot on.
  for (const preset of FILM_LOOK_PRESETS) {
    const injected = filmLookPromptText({ preset: preset.id })
    assert.ok(injected.includes(preset.description))
  }
})

test('the look names real hardware once it is in the prompt — the whole point of baking it', () => {
  const body = injectFilmLook({ detailed_description: '[Shot 1] x' }, 'Ref2VA', LOOK).detailed_description
  assert.match(body, /ARRI Alexa 35/)
  assert.match(body, /Cooke S4\/i/)
})
