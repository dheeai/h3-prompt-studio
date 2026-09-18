import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ACTING_TEMPLATE, actingResponseFormat, actingToPromptBlock, fillActingTemplate, parseActing } from './acting'

const reply = (perfs: unknown[]) => JSON.stringify({ performances: perfs })
const perf = (id: string) => ({
  characterId: id,
  objective: `shame ${id} into stepping back`,
  tactic: 'press, then go quiet',
  physicalBehaviour: 'she keeps both hands on the satchel and does not sit down',
  eyeLife: 'holds his gaze, drops to his hands when he reaches',
})

// ── it is four fields per character, per CLIP, on purpose ───────────────

test('four fields per character, not the eleven-per-shot document — that one cost 67.1s a call', () => {
  const fmt = actingResponseFormat() as any
  const keys = Object.keys(fmt.json_schema.schema.properties.performances.items.properties)
  assert.deepEqual(keys, ['characterId', 'objective', 'tactic', 'physicalBehaviour', 'eyeLife'])
})

test('eyeLife is kept SEPARATE from physicalBehaviour — dead eyes are the failure mode it exists for', () => {
  const fmt = actingResponseFormat() as any
  const props = fmt.json_schema.schema.properties.performances.items.properties
  assert.ok(props.eyeLife)
  assert.ok(props.physicalBehaviour)
  assert.notEqual(props.eyeLife.description, props.physicalBehaviour.description)
})

test('physicalBehaviour is ONE field — five accounts of one body is what produced three hands', () => {
  const fmt = actingResponseFormat() as any
  const keys = Object.keys(fmt.json_schema.schema.properties.performances.items.properties)
  for (const gone of ['observableBehavior', 'physicalBusiness', 'bodyState', 'beatChange', 'howItIsShownPhysically']) {
    assert.equal(keys.includes(gone), false, `${gone} must stay collapsed into physicalBehaviour`)
  }
})

test('objective is specified as a verb aimed at the partner, never a state', () => {
  const fmt = actingResponseFormat() as any
  const d = fmt.json_schema.schema.properties.performances.items.properties.objective.description
  assert.match(d, /verb aimed at the partner/i)
  assert.match(d, /[Nn]ever a state/)
  assert.match(ACTING_TEMPLATE, /NEVER a state/)
})

test('the template forbids restating the camera — the director already decided it', () => {
  assert.match(ACTING_TEMPLATE, /may not restate/)
  assert.match(ACTING_TEMPLATE, /not concerned with/)
})

test('the template fills every placeholder', () => {
  const filled = fillActingTemplate(ACTING_TEMPLATE, { covers: 'c', direction: 'd', film: 'f', plates: 'p' })
  assert.equal(filled.includes('{{'), false)
  assert.match(filled, /\bd\b/)
})

// ── parsing is permissive, because nothing is ever gated on this ────────

test('parseActing fills what it can and leaves the rest empty rather than failing the clip', () => {
  const doc = parseActing(reply([{ characterId: 'Ilaa', objective: 'get the satchel' }]), 2)!
  assert.equal(doc.clipIndex, 2)
  assert.equal(doc.performances[0].objective, 'get the satchel')
  assert.equal(doc.performances[0].eyeLife, '')
  assert.equal(doc.performances[0].tactic, '')
})

test('parseActing names an unnamed character rather than dropping the performance', () => {
  const doc = parseActing(reply([{ objective: 'stall him' }]), 1)!
  assert.equal(doc.performances[0].characterId, 'Character 1')
})

test('parseActing returns null only when there is nothing usable at all', () => {
  assert.equal(parseActing('nonsense', 1), null)
  assert.equal(parseActing('{"performances":[]}', 1), null)
})

// ── what the writer is handed ───────────────────────────────────────────

test('actingToPromptBlock hands the writer behaviour, and says not to name the objective', () => {
  const block = actingToPromptBlock(parseActing(reply([perf('Ravi')]), 1)!)
  assert.match(block, /Ravi/)
  assert.match(block, /both hands on the satchel/)
  assert.match(block, /never name an objective or a tactic/)
  assert.match(block, /never state an emotion as a label/)
})

test('a performance with nothing filled in is dropped, not passed on as a blank label', () => {
  // A heading with nothing under it reads to a model as something to invent.
  const doc = parseActing(reply([{ characterId: 'Ghost' }]), 1)!
  assert.equal(actingToPromptBlock(doc), '')
})

test('no acting document yields no block, so preset A is byte-identical', () => {
  assert.equal(actingToPromptBlock(undefined), '')
})
