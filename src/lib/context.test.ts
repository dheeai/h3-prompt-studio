import { test } from 'node:test'
import assert from 'node:assert/strict'
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
 * Every stage used to get every document, so `draft` carried the whole
 * directing skill (~5.7k tokens) to RENDER a sheet it had already been
 * directed with — paid twice per prompt, and with no prompt cache on a hosted
 * provider.
 */
test('selectionForStage gives draft the format document, not the directing one', () => {
  assert.deepStrictEqual(namesFor('draft'), ['h3-prompting', 'my-own-notes'])
  assert.deepStrictEqual(namesFor('direct'), ['h3-acting', 'h3-direction', 'my-own-notes'])
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
