import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TEMPLATES, fillTemplate, platesBlock } from './stages'
import { selectionForStage, H3_STUDIO_SYSTEM_RULES } from './context'
import type { Skill, Selection } from './types'

const skills = [
  { id: 'a', name: 'h3-direction', files: [] },
  { id: 'b', name: 'h3-acting', files: [] },
  { id: 'c', name: 'h3-prompting', files: [] },
  { id: 'd', name: 'my-own-notes', files: [] },
] as unknown as Skill[]
const all: Selection = { a: ['SKILL.md'], b: ['SKILL.md'], c: ['SKILL.md'], d: ['SKILL.md'] }
const namesFor = (stage: Parameters<typeof selectionForStage>[2]) =>
  Object.keys(selectionForStage(skills, all, stage)).map((id) => skills.find((s) => s.id === id)!.name).sort()

/**
 * `draft` DIRECTS and WRITES in one pass, so it legitimately needs all three
 * documents — but once per prompt rather than the old direct→draft pair, which
 * sent the directing skill and then the format skill in two separate calls and
 * round-tripped the direction sheet between them.
 *
 * `direct` survives as its own stage for anyone who wants the sheet itself,
 * and it still gets only what directing needs.
 */
test('selectionForStage: draft directs and writes, so it takes every document', () => {
  assert.deepStrictEqual(namesFor('draft'), ['h3-acting', 'h3-direction', 'h3-prompting', 'my-own-notes'])
})

test('selectionForStage: a standalone direct pass still gets no format document', () => {
  const names = namesFor('direct')
  assert.deepStrictEqual(names, ['h3-acting', 'h3-direction', 'my-own-notes'])
  assert.ok(!names.includes('h3-prompting'), 'directing does not need the field format')
})

test('selectionForStage keeps an unrecognised skill everywhere — we cannot know what it governs', () => {
  for (const stage of ['direct', 'draft', 'breakdown', 'critique'] as const) {
    assert.ok(namesFor(stage).includes('my-own-notes'), `${stage} keeps the operator's own document`)
  }
})

test('critique keeps the whole selection — it audits against everything', () => {
  assert.deepStrictEqual(namesFor('critique'), ['h3-acting', 'h3-direction', 'h3-prompting', 'my-own-notes'])
})

test('the system rules rank the documents, so conflicts are not re-reasoned per call', () => {
  assert.match(H3_STUDIO_SYSTEM_RULES, /h3-prompting decides FORMAT/)
  assert.match(H3_STUDIO_SYSTEM_RULES, /A FORMAT rule always wins/)
})

// ── plates reach the PROMPT, not just the render (2026-09-08) ──────────────
// fillTemplate took story/current/previous/mode/film/notes/findings/critique/
// standing and no plates at all, so the model wrote subject_definitions for
// references it had never seen and whose job it had not been told.

test('platesBlock numbers plates in declaration order and carries each job', () => {
  const out = platesBlock([
    { name: 'Lira — identity', job: 'take her face and build; ignore the wardrobe', kind: 'image' },
    { name: 'porter uniform', job: 'the garment only', kind: 'image' },
  ])
  assert.match(out, /<Subject 1> — Lira — identity \(image\): take her face and build; ignore the wardrobe/)
  assert.match(out, /<Subject 2> — porter uniform \(image\): the garment only/)
  // the swap rule is what `job` exists to inform
  assert.match(out, /attribute_transfer/)
})

test('a video plate gets a <Video N> label, since H3 takes it on a different input', () => {
  const out = platesBlock([{ name: 'source clip', job: 'continue from its last moment', kind: 'video' }])
  assert.match(out, /<Video 1> — source clip \(video\)/)
  assert.doesNotMatch(out, /<Subject 1>/)
})

test('no plates yields an empty block, and fillTemplate says so explicitly', () => {
  assert.equal(platesBlock([]), '')
  assert.equal(platesBlock(undefined), '')
  const filled = fillTemplate('X {{plates}} Y', {})
  assert.match(filled, /no reference plates are wired/)
})

test('a plate with no job written says so rather than going silent', () => {
  const out = platesBlock([{ name: 'mystery', job: '   ', kind: 'image' }])
  assert.match(out, /no job written/)
})

test('the prompt-producing templates all carry the plates block', () => {
  for (const stage of ['draft', 'revise', 'rebuild'] as const) {
    const t = DEFAULT_TEMPLATES[stage]
    if (t.includes('SOURCE')) assert.ok(t.includes('{{plates}}'), `${stage} must show the wired plates`)
  }
})
