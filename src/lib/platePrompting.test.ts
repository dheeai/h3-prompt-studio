import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LOCATION_PLATE_SIZE_LARGE,
  PLATE_SIZES,
  fillCharacterPlateBrief,
  fillLocationPlateBrief,
  fillPlateBrief,
  fillPropPlateBrief,
  parsePlatePromptRewrite,
  platePromptKindForLedgerKind,
} from './platePrompting'

const INPUT = { name: 'Nusrat', description: 'A woman in a blue cardigan, dark hair.', chapter: 'The switched cloth chapter text.' }

test('PLATE_SIZES: the founder\'s exact per-kind sizes', () => {
  assert.deepEqual(PLATE_SIZES.location, { width: 1408, height: 1408 })
  assert.deepEqual(PLATE_SIZES.character, { width: 1024, height: 1536 })
  assert.deepEqual(PLATE_SIZES.prop, { width: 1216, height: 1216 })
})

test('LOCATION_PLATE_SIZE_LARGE: the optional 2048x2048 alternative', () => {
  assert.deepEqual(LOCATION_PLATE_SIZE_LARGE, { width: 2048, height: 2048 })
})

test('fillLocationPlateBrief: carries the entity\'s own name/description/chapter, and the 6-panel structure', () => {
  const brief = fillLocationPlateBrief(INPUT)
  assert.ok(brief.includes('Nusrat'))
  assert.ok(brief.includes('A woman in a blue cardigan, dark hair.'))
  assert.ok(brief.includes('The switched cloth chapter text.'))
  assert.ok(brief.includes('3-row x 2-column grid of six panels'))
  assert.ok(brief.includes('Panel 6'))
})

test('fillLocationPlateBrief: forbids artifact vocabulary in the model\'s own description', () => {
  const brief = fillLocationPlateBrief(INPUT)
  assert.match(brief, /Do not describe this image as a "contact sheet"/)
})

test('fillCharacterPlateBrief: neutral identity-sheet rules, no artifact vocabulary allowed', () => {
  const brief = fillCharacterPlateBrief(INPUT)
  assert.ok(brief.includes('neutral pose, neutral expression'))
  assert.ok(brief.includes('This is a REFERENCE image, not a scene.'))
  assert.match(brief, /Do not describe this image as a "contact sheet"/)
})

test('fillPropPlateBrief: product-style plate rules, no artifact vocabulary allowed', () => {
  const brief = fillPropPlateBrief(INPUT)
  assert.ok(brief.includes('the object alone, centered, plain neutral background'))
  assert.match(brief, /Do not describe this image as a "contact sheet"/)
})

test('fillPlateBrief: dispatches to the right template by kind', () => {
  assert.ok(fillPlateBrief('location', INPUT).includes('Panel 6'))
  assert.ok(fillPlateBrief('character', INPUT).includes('REFERENCE image, not a scene'))
  assert.ok(fillPlateBrief('prop', INPUT).includes('product-style image'))
})

test('parsePlatePromptRewrite: extracts rewritten_prompt only, discards wh_ratio', () => {
  const raw = '{"rewritten_prompt": "A vertical realistic photograph of a woman.", "wh_ratio": "2:3"}'
  assert.equal(parsePlatePromptRewrite(raw), 'A vertical realistic photograph of a woman.')
})

test('parsePlatePromptRewrite: tolerates a code fence and surrounding prose', () => {
  const raw = 'Here you go:\n```json\n{"rewritten_prompt": "A room.", "wh_ratio": "1:1"}\n```\nhope that helps'
  assert.equal(parsePlatePromptRewrite(raw), 'A room.')
})

test('parsePlatePromptRewrite: garbage returns null, never throws', () => {
  assert.equal(parsePlatePromptRewrite('not json at all'), null)
  assert.equal(parsePlatePromptRewrite('{"wh_ratio": "1:1"}'), null)
  assert.equal(parsePlatePromptRewrite('{"rewritten_prompt": ""}'), null)
})

test('platePromptKindForLedgerKind: character and prop map to themselves', () => {
  assert.equal(platePromptKindForLedgerKind('character'), 'character')
  assert.equal(platePromptKindForLedgerKind('prop'), 'prop')
})

test('platePromptKindForLedgerKind: a creature gets the identity-sheet (character) treatment', () => {
  assert.equal(platePromptKindForLedgerKind('creature'), 'character')
})

test('platePromptKindForLedgerKind: an environment entity is the location it belongs to', () => {
  assert.equal(platePromptKindForLedgerKind('environment'), 'location')
})
