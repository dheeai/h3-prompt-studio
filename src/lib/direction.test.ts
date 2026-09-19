import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_TERMS, DIRECTION_TEMPLATE, H3_CONTROLLED_CAMERA_TERMS, SINGULARITY_CAMERA_TERMS,
  directionResponseFormat, directionToPromptBlock,
  fillDirectionTemplate, isH3ControlledTerm, offVocabularyMovements, parseDirection,
} from './direction'

const shot = (i: number, movement = 'Push In') => ({
  index: i, whyThisShot: `why ${i}`, viewerGaze: 'her hands',
  cameraStartAngle: 'chest height, her left', cameraEndAngle: 'chest height, closer',
  cameraMovement: movement, optics: '50mm, shallow', backgroundTreatment: 'market falls away',
  initialState: `she stands still, ${i}`, trigger: `a shout, ${i}`,
  action: `something ${i}`, reaction: `she flinches, ${i}`, finalState: `she is turned away, ${i}`,
  environmentalPressure: 'midday heat',
  physicalMicroAction: 'she shifts the satchel strap', thirdConcreteFact: 'a fan ticks overhead',
})

// A pre-change shot, as it would come back out of IndexedDB — no chain
// fields beyond the original `action`.
const legacyShot = (i: number, movement = 'Push In') => ({
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

test('cameraMovement is an ENUM of the widened vocabulary, which is the measured 0%->95% change', () => {
  const fmt = directionResponseFormat() as any
  const movement = fmt.json_schema.schema.properties.shots.items.properties.cameraMovement
  assert.deepEqual(movement.enum, [...CAMERA_TERMS])
  assert.ok(CAMERA_TERMS.includes('Static Shot'))
  assert.ok(CAMERA_TERMS.includes('Push In'))
  assert.equal(H3_CONTROLLED_CAMERA_TERMS.length, 20)
  assert.equal(SINGULARITY_CAMERA_TERMS.length, 5)
  assert.equal(CAMERA_TERMS.length, 25)
})

test('the widened enum still accepts all 20 official H3 terms', () => {
  const fmt = directionResponseFormat() as any
  const movement = fmt.json_schema.schema.properties.shots.items.properties.cameraMovement
  for (const term of H3_CONTROLLED_CAMERA_TERMS) assert.ok(movement.enum.includes(term), `missing ${term}`)
})

test('the 5 Singularity camera terms pass offVocabularyMovements — legal by design, just not H3-controlled', () => {
  const doc = parseDirection(reply(SINGULARITY_CAMERA_TERMS.map((m, i) => shot(i + 1, m))), 1)!
  assert.deepEqual(offVocabularyMovements(doc), [])
})

test('isH3ControlledTerm separates the two tiers', () => {
  for (const term of H3_CONTROLLED_CAMERA_TERMS) assert.equal(isH3ControlledTerm(term), true, term)
  for (const term of SINGULARITY_CAMERA_TERMS) assert.equal(isH3ControlledTerm(term), false, term)
  assert.equal(isH3ControlledTerm('slow push'), false)
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

// ── the action chain (§8) ───────────────────────────────────────────────

test('the five chain fields round-trip through parseDirection, in order, ahead of the environmental details', () => {
  const doc = parseDirection(reply([shot(1)]), 1)!
  const s = doc.shots[0]
  assert.equal(s.initialState, 'she stands still, 1')
  assert.equal(s.trigger, 'a shout, 1')
  assert.equal(s.action, 'something 1')
  assert.equal(s.reaction, 'she flinches, 1')
  assert.equal(s.finalState, 'she is turned away, 1')

  const fmt = directionResponseFormat() as any
  const required = fmt.json_schema.schema.properties.shots.items.required
  const properties = Object.keys(fmt.json_schema.schema.properties.shots.items.properties)
  assert.deepEqual(
    required.slice(required.indexOf('initialState'), required.indexOf('finalState') + 1),
    ['initialState', 'trigger', 'action', 'reaction', 'finalState'],
  )
  assert.deepEqual(
    properties.slice(properties.indexOf('initialState'), properties.indexOf('finalState') + 1),
    ['initialState', 'trigger', 'action', 'reaction', 'finalState'],
  )
})

test('parseDirection tolerates a pre-change reply with no chain fields', () => {
  const legacyReply = JSON.stringify({
    wantRightNow: 'x', obstacle: 'y', geometrySentence: 'z', rhythm: 'r', whyTheseShots: 'w',
    shots: [legacyShot(1)],
  })
  const doc = parseDirection(legacyReply, 1)!
  assert.equal(doc.shots[0].initialState, '')
  assert.equal(doc.shots[0].trigger, '')
  assert.equal(doc.shots[0].action, 'something 1')
  assert.equal(doc.shots[0].reaction, '')
  assert.equal(doc.shots[0].finalState, '')
})

test('a pre-change document (no chain fields on the shot) still renders a clean block', () => {
  // Simulates a DirectionDoc rehydrated from IndexedDB before this change —
  // the four new fields are simply absent from the object, not empty strings.
  const legacyDoc = {
    clipIndex: 1, wantRightNow: 'x', obstacle: 'y', geometrySentence: 'the geometry',
    rhythm: 'the rhythm', whyTheseShots: 'w',
    shots: [{
      index: 1, whyThisShot: 'why', viewerGaze: 'gaze',
      cameraStartAngle: 'start', cameraEndAngle: 'end', cameraMovement: 'Push In',
      optics: '50mm', backgroundTreatment: 'falls away',
      action: 'something legacy',
      environmentalPressure: 'heat', physicalMicroAction: 'shifts', thirdConcreteFact: 'a fan ticks',
    }],
  } as any
  const block = directionToPromptBlock(legacyDoc)
  assert.match(block, /action: something legacy/)
  assert.equal(block.includes('undefined'), false)
  assert.equal(/^\s*initialState:/m.test(block), false)
  assert.equal(/^\s*trigger:/m.test(block), false)
  assert.equal(/^\s*reaction:/m.test(block), false)
  assert.equal(/^\s*finalState:/m.test(block), false)
})

test('directionToPromptBlock renders the chain in causal order', () => {
  const doc = parseDirection(reply([shot(1)]), 1)!
  const block = directionToPromptBlock(doc)
  const order = ['initialState:', 'trigger:', 'action:', 'reaction:', 'finalState:', 'camera:']
  const positions = order.map((label) => block.indexOf(label))
  positions.forEach((p, i) => assert.ok(p >= 0, `${order[i]} missing from block`))
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i - 1] < positions[i], `${order[i - 1]} should precede ${order[i]}: ${block}`)
  }
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
