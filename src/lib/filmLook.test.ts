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

test('describeFilmLook: a chosen preset writes its full combination, not a fragment', () => {
  const preset = FILM_LOOK_PRESETS[0]
  const block = describeFilmLook({ preset: preset.id })
  assert.match(block, /FILM-WIDE LOOK/)
  // The preset's NAME is no longer written: it was a `- name: description`
  // label prefix, and a label reads as noise inside prompt prose. Nothing is
  // lost — the description states the same body, glass and support in
  // sentences, which is what this test has always actually been guarding.
  assert.ok(block.includes(preset.description))
  assert.match(block, /ARRI Alexa 65/)
  assert.match(block, /Panavision Sphero 65/)
  assert.match(block, /on a crane/)
  assert.match(block, /not a measured optical guarantee/)
})

test('describeFilmLook tells the model NOT to restate the look — injectFilmLook already wrote it', () => {
  const block = describeFilmLook({ preset: FILM_LOOK_PRESETS[0].id })
  assert.match(block, /ALREADY IN THE PROMPT/)
  assert.match(block, /Do NOT restate/)
  // But it must still SHOW the look: a locked-off film whose director cannot
  // see its own look writes camera moves against it.
  assert.ok(block.includes(FILM_LOOK_PRESETS[0].description))
})

test('describeFilmLook: free text survives ALONGSIDE a preset, not instead of it', () => {
  const preset = FILM_LOOK_PRESETS[1]
  const block = describeFilmLook({ preset: preset.id, freeText: 'match the look of the reference clip I sent' })
  assert.ok(block.includes(preset.description))
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

// ── named camera + lens hardware (2026-09-17 correction) ───────────────────
// The founder's own read: a generative video model has strong learned
// associations with named hardware, so the lever is the camera/lens NAME,
// not an abstract aspect/palette description on its own. Every preset must
// still carry that look grammar, but it now opens on real, specific gear.

test('every preset names a real camera body AND a specific piece of glass — not just an abstract look', () => {
  for (const p of FILM_LOOK_PRESETS) {
    // "shot on a/an <body> with a/an <glass>" — the founder's own sentence shape.
    assert.match(
      p.description,
      /shot on (?:a|an) [A-Za-z0-9./ -]+ with (?:a|an) [A-Za-z0-9./ -]+lens/,
      `${p.id} must open on a named body + named lens, in that sentence shape`,
    )
  }
})

test('every preset names a camera SUPPORT default (tripod, handheld, dolly, Steadicam, crane, shoulder) as the film baseline, not a hard rule', () => {
  const supportWords = /tripod|handheld|dolly|steadicam|crane|shoulder-mounted/i
  for (const p of FILM_LOOK_PRESETS) {
    assert.match(p.description, supportWords, `${p.id} must name a default camera support`)
    // it must read as a DEFAULT a shot can still depart from, never a fixed constraint
    assert.match(p.description, /default camera behaviour|not a rule/i, `${p.id}'s support must read as the film's default, not a fixed constraint`)
  }
})

test('every preset still carries the h3-cinematography look grammar alongside the hardware name: aspect, grain, palette', () => {
  for (const p of FILM_LOOK_PRESETS) {
    assert.match(p.description, /\d+(\.\d+)?:1|16:9/, `${p.id} must state an aspect ratio`)
    assert.match(p.description, /grain/i, `${p.id} must state a grain register`)
    assert.match(p.description, /reduced digital sharpening/i, `${p.id} must suppress sharpening`)
    assert.match(p.description, /no influencer plastic texture/i, `${p.id} must ban the plastic texture`)
    assert.match(p.description, /palette/i, `${p.id} must state a palette`)
  }
})

test('exactly one preset reuses the h3-cinematography skill\'s own worked palette example verbatim', () => {
  const matches = FILM_LOOK_PRESETS.filter((p) =>
    p.description.includes('warm brown, soft gold, matte cream, low-saturation vintage black'),
  )
  assert.equal(matches.length, 1)
})

test('preset copy never promises measured optical accuracy', () => {
  for (const p of FILM_LOOK_PRESETS) {
    assert.doesNotMatch(p.description, /guarantee|measured|accurate|true field of view|true optical/i)
  }
})
