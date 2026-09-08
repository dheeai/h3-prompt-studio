import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lint } from './lint'

// ── music/sentinel: a denial word inside a real score is not a denial ────────
// Both lint ERRORs across 50 measured prompts (2026-09-08) were this false
// positive: DENIAL matched a musical descriptor. Neither prompt described the
// absence of music; both wrote real scores.

const wrap = (music: string) =>
  [
    'subject_definitions: <Subject 1> is a woman.',
    'summary: [reference generation] A woman waits.',
    'retention_analysis: <Subject 1> (appears in [Shot 1]): fully_preserved - retained.',
    'detailed_description: Warm light. [Shot 1] She waits. The camera holds a Static Shot.',
    'overall_soundscape: room tone. a chair creaks',
    `non_diegetic_music: ${music}`,
  ].join('\n\n')

const sentinel = (t: string) => lint(wrap(t), 'Ref2VA').find((f) => f.id === 'music/sentinel')

test('a real score containing the word silence is NOT a denial', () => {
  const f = sentinel('A spare solo-piano score at a slow tempo, sparse notes with long silence between them.')
  assert.equal(f?.severity, 'pass')
})

test('a real score containing "no melody" is NOT a denial', () => {
  const f = sentinel('A restrained solo-cello drone at a slow tempo, sustained and low, with no melody.')
  assert.equal(f?.severity, 'pass')
})

test('a genuine denial is still an error', () => {
  assert.equal(sentinel('None. There is no music of any kind in this video.')?.severity, 'error')
  assert.equal(sentinel('Silence.')?.severity, 'error')
})

test('the bare sentinel passes', () => {
  const f = sentinel('N/A')
  assert.equal(f?.severity, 'pass')
  assert.equal(f?.metric, 'N/A')
})

test('a score is surfaced as scored, so an operator can confirm it was wanted', () => {
  assert.equal(sentinel('A slow piano motif at 60 bpm, building in dynamics.')?.metric, 'scored')
})
