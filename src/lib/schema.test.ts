import { test } from 'node:test'
import assert from 'node:assert/strict'
import { h3ResponseFormat, joinH3Sections, REF_SECTIONS, BASE_SECTIONS } from './schema'

test('the ref schema requires all six sections plus an explanation, in order', () => {
  const rf = h3ResponseFormat('Ref2VA') as any
  assert.equal(rf.type, 'json_schema')
  assert.equal(rf.json_schema.strict, true)
  assert.deepEqual(rf.json_schema.schema.required, [...REF_SECTIONS, 'explanation'])
  assert.equal(rf.json_schema.schema.additionalProperties, false)
})

test('a base-mode schema asks for the three core fields, not the six', () => {
  const rf = h3ResponseFormat('T2VA') as any
  assert.deepEqual(rf.json_schema.schema.required, [...BASE_SECTIONS, 'explanation'])
})

test('a complete object joins into the canonical six-section prompt', () => {
  const obj: Record<string, string> = { explanation: 'why' }
  for (const f of REF_SECTIONS) obj[f] = `${f} body`
  const out = joinH3Sections(JSON.stringify(obj), 'Ref2VA')
  assert.ok(out)
  assert.equal(out!.explanation, 'why')
  // canonical order, one labelled block each
  assert.equal(out!.prompt.split('\n\n').length, REF_SECTIONS.length)
  assert.ok(out!.prompt.startsWith('subject_definitions: '))
  assert.ok(out!.prompt.includes('non_diegetic_music: non_diegetic_music body'))
})

test('a partial object is refused rather than becoming a fragmentary prompt', () => {
  const obj: Record<string, string> = { explanation: 'why' }
  for (const f of REF_SECTIONS) obj[f] = 'x'
  obj.overall_soundscape = '   '
  assert.equal(joinH3Sections(JSON.stringify(obj), 'Ref2VA'), null)
})

test('prose that is not an object at all falls back rather than throwing', () => {
  assert.equal(joinH3Sections('subject_definitions: <Subject 1> is a woman…', 'Ref2VA'), null)
  assert.equal(joinH3Sections('', 'Ref2VA'), null)
})

test('a fenced object still parses, since a model may fence despite the grammar', () => {
  const obj: Record<string, string> = { explanation: 'e' }
  for (const f of REF_SECTIONS) obj[f] = 'v'
  const out = joinH3Sections('```json\n' + JSON.stringify(obj) + '\n```', 'Ref2VA')
  assert.ok(out)
})

test('an explanation is optional — its absence must not void a good prompt', () => {
  const obj: Record<string, string> = {}
  for (const f of REF_SECTIONS) obj[f] = 'v'
  const out = joinH3Sections(JSON.stringify(obj), 'Ref2VA')
  assert.ok(out)
  assert.equal(out!.explanation, '')
})

test('only the prompt-producing stages ask for a schema', async () => {
  const { SCHEMA_STAGES } = await import('./stages')
  // The deliverable IS the canonical prompt for these three.
  for (const s of ['draft', 'revise', 'rebuild']) assert.ok(SCHEMA_STAGES.has(s as never), s)
  // These produce a document or their own shape, and must stay free text.
  for (const s of ['direct', 'critique', 'handoff', 'breakdown', 'freeform'])
    assert.ok(!SCHEMA_STAGES.has(s as never), s)
})
