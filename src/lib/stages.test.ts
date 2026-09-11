import assert from 'node:assert/strict'
import test from 'node:test'
import { durationBlock, fillTemplate, fillTemplateWithDuration } from './stages'
import { framesForSeconds } from './recipe'

test('durationBlock states the ACTUAL grid-snapped length, not the chosen one', () => {
  // 5s -> snapFrames(120) = 124 frames = 5.167s. The prompt must carry 5.167s, because
  // cut timecodes have to fit inside it and a snapped clip runs slightly long.
  const b = durationBlock(5, framesForSeconds(5))
  assert.match(b, /124 frames at 24fps = 5\.167s/)
  assert.match(b, /must fit inside 5\.167s/)
  assert.match(b, /operator selected 5s/)
  assert.match(b, /use it, not 5s/)
})

test('durationBlock omits the reconciliation when chosen equals actual', () => {
  const frames = framesForSeconds(5)
  const actual = +(frames / 24).toFixed(3)
  const b = durationBlock(actual, frames)
  assert.match(b, /5\.167s/)
  assert.doesNotMatch(b, /operator selected/)
})

test('a 20s selection carries 20s, not the templates\' 6-15 hint', () => {
  const frames = framesForSeconds(20)          // snapFrames(480) = 481
  const b = durationBlock(20, frames)
  assert.match(b, new RegExp(`${frames} frames`))
  assert.match(b, /20\.042s/)
})

test('fillTemplateWithDuration PREPENDS when the template has no placeholder', () => {
  // Stage templates are persisted per browser, so an operator carrying a customised one
  // must still receive the duration — otherwise the fix reaches nobody who has used the app.
  const out = fillTemplateWithDuration('WRITE THE CLIP.\n{{story}}', { story: 'a man waits', duration: 'DURATION — 124 frames' })
  assert.match(out, /^DURATION — 124 frames/)
  assert.match(out, /WRITE THE CLIP/)
})

test('fillTemplateWithDuration PLACES it when the template names it', () => {
  const out = fillTemplateWithDuration('{{story}}\n\n{{duration}}\n\nGO.', { story: 's', duration: 'DUR' })
  assert.doesNotMatch(out, /^DUR/)
  assert.match(out, /s\n\nDUR\n\nGO\./)
})

test('no duration supplied leaves the template untouched', () => {
  assert.equal(fillTemplateWithDuration('{{story}}', { story: 'x' }), 'x')
})

test('fillTemplate still strips an unused {{duration}} placeholder', () => {
  assert.equal(fillTemplate('{{story}}{{duration}}', { story: 'x' }), 'x')
})
