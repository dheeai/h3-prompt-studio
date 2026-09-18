import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_TERMS, DIRECTION_TEMPLATE, directionResponseFormat, directionToPromptBlock,
  fillDirectionTemplate, offVocabularyMovements, parseDirection,
} from './direction'

const shot = (i: number, movement = 'Push In') => ({
  index: i, whyThisShot: `why ${i}`, viewerGaze: 'her hands',
  cameraStartAngle: 'chest height, her left', cameraEndAngle: 'chest height, closer',
  cameraMovement: movement, optics: '50mm, shallow', backgroundTreatment: 'market falls away',
  action: `something ${i}`, environmentalPressure: 'midday heat',
  physicalMicroAction: 'she shifts the satchel strap', thirdConcreteFact: 'a fan ticks overhead',
})
const reply = (shots: unknown[]) =>
  JSON.stringify({
    wantRightNow: 'the letter handed over', obstacle: 'he will not take it',
    geometrySentence: 'she stands to his left, facing him; the camera is behind his shoulder',
    rhythm: 'slow, then one hard beat', whyTheseShots: 'two shots so the refusal lands alone',
    shots,
  })

// ── the controlled vocabulary ───────────────────────────────────────────

test('cameraMovement is an ENUM of the controlled vocabulary, which is the measured 0%->95% change', () => {
  const fmt = directionResponseFormat() as any
  const movement = fmt.json_schema.schema.properties.shots.items.properties.cameraMovement
  assert.deepEqual(movement.enum, [...CAMERA_TERMS])
  assert.ok(CAMERA_TERMS.includes('Static Shot'))
  assert.ok(CAMERA_TERMS.includes('Push In'))
  assert.equal(CAMERA_TERMS.length, 20)
})

test('the template lists every controlled term verbatim, so a model with no grammar still has the list', () => {
  const filled = fillDirectionTemplate(DIRECTION_TEMPLATE, { covers: 'c', shots: 's', film: 'f', plates: 'p' })
  for (const term of CAMERA_TERMS) assert.ok(filled.includes(term), `missing ${term}`)
  assert.equal(filled.includes('{{'), false, 'every placeholder is filled')
})

test('the template forbids performance — a separate pass owns it', () => {
  assert.match(DIRECTION_TEMPLATE, /DO NOT WRITE performance/)
  assert.match(DIRECTION_TEMPLATE, /You own the camera and the frame/)
})

// ── property order is the feature ───────────────────────────────────────

test('every justification is declared BEFORE the decision it justifies', () => {
  const fmt = directionResponseFormat() as any
  const top = Object.keys(fmt.json_schema.schema.properties)
  // The clip interrogates itself, THEN explains the set, THEN lists it.
  assert.ok(top.indexOf('whyTheseShots') < top.indexOf('shots'), top.join(','))
  assert.ok(top.indexOf('wantRightNow') < top.indexOf('whyTheseShots'), top.join(','))

  const perShot = Object.keys(fmt.json_schema.schema.properties.shots.items.properties)
  assert.ok(perShot.indexOf('whyThisShot') < perShot.indexOf('cameraStartAngle'), perShot.join(','))
  assert.ok(perShot.indexOf('viewerGaze') < perShot.indexOf('cameraMovement'), perShot.join(','))
})

test('the call is bounded — one clip, an order of magnitude under the 169 leaves that failed', () => {
  const fmt = directionResponseFormat() as any
  const perShot = Object.keys(fmt.json_schema.schema.properties.shots.items.properties).length
  const top = Object.keys(fmt.json_schema.schema.properties).length - 1
  // A clip is about four shots.
  assert.ok(top + perShot * 4 < 80, `${top} + ${perShot}*4`)
})

// ── parsing ─────────────────────────────────────────────────────────────

test('parseDirection carries clipIndex IN and renumbers shots contiguously', () => {
  // The model echoed 7 and 9; the studio knows better than to trust either.
  const doc = parseDirection(reply([shot(7), shot(9)]), 3)!
  assert.equal(doc.clipIndex, 3)
  assert.deepEqual(doc.shots.map((s) => s.index), [1, 2])
})

test('parseDirection returns null on junk rather than a half-built document', () => {
  assert.equal(parseDirection('not json at all', 1), null)
  assert.equal(parseDirection('{ "shots": [] }', 1), null)
  assert.equal(parseDirection('{ oh dear', 1), null)
})

test('parseDirection tolerates a ```json fence', () => {
  const doc = parseDirection('```json\n' + reply([shot(1)]) + '\n```', 1)
  assert.ok(doc)
  assert.equal(doc!.shots.length, 1)
})

test('parseDirection keeps an off-vocabulary camera term as written rather than dropping it', () => {
  // An empty field tells the writer nothing; "slow push" it can still use.
  const doc = parseDirection(reply([shot(1, 'slow push')]), 1)!
  assert.equal(doc.shots[0].cameraMovement, 'slow push')
  assert.deepEqual(offVocabularyMovements(doc), [1])
})

test('offVocabularyMovements is silent when every term is legal — the number the A/B wants', () => {
  const doc = parseDirection(reply([shot(1, 'Static Shot'), shot(2, 'Arc Shot')]), 1)!
  assert.deepEqual(offVocabularyMovements(doc), [])
})

// ── what the prompt writer is handed ────────────────────────────────────

test('directionToPromptBlock passes the DECISIONS on and withholds the reasoning', () => {
  const doc = parseDirection(reply([shot(1), shot(2)]), 1)!
  const block = directionToPromptBlock(doc)
  // decisions
  assert.match(block, /\[Shot 1\]/)
  assert.match(block, /\[Shot 2\]/)
  assert.match(block, /Push In/)
  assert.match(block, /50mm, shallow/)
  assert.match(block, /she shifts the satchel strap/)
  assert.match(block, /she stands to his left/)
  // reasoning withheld — it did its job by making the model commit in order,
  // and passing it on invites the writer to argue with settled decisions.
  assert.equal(block.includes('why 1'), false)
  assert.equal(block.includes('her hands'), false)
  assert.equal(block.includes('two shots so the refusal lands alone'), false)
})

test('directionToPromptBlock tells the writer these are decided, not suggestions', () => {
  const block = directionToPromptBlock(parseDirection(reply([shot(1)]), 1)!)
  assert.match(block, /already decided/)
  assert.match(block, /do not add a shot/)
  assert.match(block, /verbatim/)
})

test('no direction yields no block, so preset A is byte-identical', () => {
  assert.equal(directionToPromptBlock(undefined), '')
  assert.equal(directionToPromptBlock({ clipIndex: 1, wantRightNow: '', obstacle: '', geometrySentence: '', rhythm: '', whyTheseShots: '', shots: [] }), '')
})
