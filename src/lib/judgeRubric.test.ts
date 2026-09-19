import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildFullRubric, buildPerShotQuestions, JUDGE_RUBRIC } from './judgeRubric'
import { buildJudgeRequest, JUDGE_DIMENSIONS } from './judge'
import type { JudgeContext } from './judge'

const PROMPT = [
  'subject_definitions: <Subject 1> is a woman in a workshop.',
  'summary: [reference generation] A woman works at a bench.',
  'retention_analysis: <Subject 1> fully_preserved',
  'detailed_description: [Shot 1] She stands at the bench, tools scattered, in a Static Shot. [Shot 2] At 00:05.000, the shot cuts to a close-up, Push In on her hands. [Shot 3] At 00:08.000, the shot cuts to a wide, Pull Out to reveal the room.',
  'overall_soundscape: a workshop hum, metal clinking.',
  'non_diegetic_music: N/A',
].join('\n\n')

function ctx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    promptText: PROMPT,
    mode: 'Ref2VA',
    approvedShots: [
      { index: 1, summary: 'She stands at the bench', seconds: 3 },
      { index: 2, summary: 'Close-up on her hands', seconds: 2 },
      { index: 3, summary: 'Wide reveal', seconds: 2 },
    ],
    clipSeconds: 7,
    hasDialogue: false,
    ...overrides,
  }
}

// ── the static rubric shape — one reviewable file, as designed ────────────

test('JUDGE_RUBRIC covers all six dimensions, with no empty ones', () => {
  const covered = new Set(JUDGE_RUBRIC.map((q) => q.dimension))
  for (const dim of JUDGE_DIMENSIONS) assert.ok(covered.has(dim), `${dim} has no static questions`)
})

test('JUDGE_RUBRIC has no duplicate ids', () => {
  const ids = JUDGE_RUBRIC.map((q) => q.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('every noul/score question declares a scope, and every score question has at least two criteria levels', () => {
  for (const q of JUDGE_RUBRIC) {
    assert.ok(q.scope === 'prompt' || q.scope === 'shot', `${q.id} has no valid scope`)
    if (q.kind === 'score') assert.ok(q.criteria.length >= 2, `${q.id} has fewer than two levels`)
  }
})

test('every dialogue question (jev or exact) is gated on hasDialogue', () => {
  for (const q of JUDGE_RUBRIC.filter((q) => q.dimension === 'dialogue')) {
    assert.ok(q.appliesWhen, `${q.id} is a dialogue question with no appliesWhen gate`)
    assert.equal(q.appliesWhen!(ctx({ hasDialogue: false })), false)
    assert.equal(q.appliesWhen!(ctx({ hasDialogue: true })), true)
  }
})

test('the static rubric breakdown by kind and dimension matches what is documented', () => {
  const byKind = { noul: 0, score: 0, exact: 0 }
  const byDimension: Record<string, { jev: number; exact: number }> = {}
  for (const q of JUDGE_RUBRIC) {
    byKind[q.kind]++
    byDimension[q.dimension] ??= { jev: 0, exact: 0 }
    if (q.kind === 'exact') byDimension[q.dimension].exact++
    else byDimension[q.dimension].jev++
  }
  assert.deepEqual(byKind, { noul: 14, score: 6, exact: 5 })
  assert.deepEqual(byDimension, {
    direction: { jev: 5, exact: 0 },
    acting: { jev: 4, exact: 0 },
    camera: { jev: 3, exact: 1 },
    shots: { jev: 2, exact: 2 },
    dialogue: { jev: 4, exact: 1 },
    pacing: { jev: 2, exact: 1 },
  })
  assert.equal(JUDGE_RUBRIC.length, 25)
})

// ── the per-shot fan-out — generated, not hand-written ─────────────────────

test('buildPerShotQuestions generates exactly one question per approved shot, with matching ids', () => {
  const questions = buildPerShotQuestions(ctx())
  assert.equal(questions.length, 3)
  assert.deepEqual(
    questions.map((q) => q.id),
    ['shots.chain.1', 'shots.chain.2', 'shots.chain.3'],
  )
  for (const q of questions) {
    assert.equal(q.dimension, 'shots')
    assert.equal(q.scope, 'shot')
    assert.equal(q.kind, 'noul')
    assert.equal(q.expect, true)
  }
  assert.deepEqual(
    questions.map((q) => q.shotIndex),
    [1, 2, 3],
  )
})

test('buildPerShotQuestions tracks whatever shots are actually approved — none, one, or several', () => {
  assert.equal(buildPerShotQuestions(ctx({ approvedShots: [] })).length, 0)
  const one = buildPerShotQuestions(ctx({ approvedShots: [{ index: 5, summary: 'only shot', seconds: 4 }] }))
  assert.deepEqual(
    one.map((q) => q.id),
    ['shots.chain.5'],
  )
})

test('each per-shot question names its own shot by marker, not by another shot\'s number', () => {
  const [q1, q2, q3] = buildPerShotQuestions(ctx())
  assert.match(q1.instructions, /\[Shot 1\]/)
  assert.match(q2.instructions, /\[Shot 2\]/)
  assert.match(q3.instructions, /\[Shot 3\]/)
})

test('buildFullRubric is the static rubric plus that clip\'s own fan-out, nothing shared between clips', () => {
  const full3 = buildFullRubric(ctx())
  assert.equal(full3.length, JUDGE_RUBRIC.length + 3)

  const full0 = buildFullRubric(ctx({ approvedShots: [] }))
  assert.equal(full0.length, JUDGE_RUBRIC.length)
})

// ── end to end: the full rubric builds a real request set against the fixture ─

test('buildJudgeRequest against the full rubric produces one prompt request and one request per shot', () => {
  const c = ctx()
  const requests = buildJudgeRequest(c, buildFullRubric(c))
  assert.equal(requests.filter((r) => r.scope === 'prompt').length, 1)
  const shotRequests = requests.filter((r) => r.scope === 'shot')
  assert.deepEqual(
    shotRequests.map((r) => r.shotIndex).sort(),
    [1, 2, 3],
  )
  // Shot 2's own fan-out question rides only in shot 2's request.
  const shot2 = shotRequests.find((r) => r.shotIndex === 2)!
  assert.ok('shots.chain.2' in shot2.request.questions)
  assert.ok(!('shots.chain.1' in shot2.request.questions))
  assert.ok(!('shots.chain.3' in shot2.request.questions))
  // The generic shot-scoped templates (camera.motivated, etc.) ride in EVERY shot's request.
  for (const r of shotRequests) assert.ok('camera.motivated' in r.request.questions)
})

test('the exact questions never appear in any built request', () => {
  const c = ctx()
  const requests = buildJudgeRequest(c, buildFullRubric(c))
  const exactIds = JUDGE_RUBRIC.filter((q) => q.kind === 'exact').map((q) => q.id)
  for (const r of requests) {
    for (const id of exactIds) assert.ok(!(id in r.request.questions), `${id} leaked into a built request`)
  }
})

// ── the exact questions themselves — reuse existing code, never reimplement ─

test('shots.fragments-match-plan scores 1 when every approved shot has its own fragment and there are no orphans', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'shots.fragments-match-plan')!
  assert.equal(q.kind, 'exact')
  if (q.kind === 'exact') assert.equal(q.check(ctx()), 1)
})

test('shots.fragments-match-plan is null (not zero) with no approved shots', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'shots.fragments-match-plan')!
  if (q.kind === 'exact') assert.equal(q.check(ctx({ approvedShots: [] })), null)
})

test('shots.marker-hygiene scores 1 on a clean body and less than 1 when a shot is missing a timestamp', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'shots.marker-hygiene')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') return
  assert.equal(q.check(ctx()), 1)

  const broken = [
    'subject_definitions: <Subject 1> is a woman.',
    'summary: [reference generation] A woman waits.',
    'retention_analysis: <Subject 1> fully_preserved',
    'detailed_description: [Shot 1] She waits. [Shot 2] The shot cuts to a close-up.',
    'overall_soundscape: room tone.',
    'non_diegetic_music: N/A',
  ].join('\n\n')
  const score = q.check(ctx({ promptText: broken }))
  assert.ok(score !== null && score < 1)
})

test('camera.controlled-vocab-per-shot scores the fraction of shots using the controlled vocabulary verbatim', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'camera.controlled-vocab-per-shot')!
  assert.equal(q.kind, 'exact')
  if (q.kind === 'exact') assert.equal(q.check(ctx()), 1) // Static Shot, Push In, Pull Out are all controlled terms
})

test('dialogue.tags-present is gated by appliesWhen and returns 0/1 by literal <d> presence', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'dialogue.tags-present')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') return
  assert.equal(q.appliesWhen!(ctx({ hasDialogue: false })), false)
  assert.equal(q.check(ctx({ promptText: PROMPT })), 0)
  const withDialogue = PROMPT.replace('overall_soundscape', 'detailed_description: <d>[English] hello</d>\n\noverall_soundscape')
  assert.equal(q.check(ctx({ promptText: withDialogue, hasDialogue: true })), 1)
})

test('pacing.duration-matches-plan is null with no approved shots, 1 within the frame grid, and degrades on a real gap', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'pacing.duration-matches-plan')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') return
  assert.equal(q.check(ctx({ approvedShots: [] })), null)
  assert.equal(q.check(ctx()), 1) // 3+2+2=7s planned, 7s declared
  const mismatched = q.check(ctx({ clipSeconds: 20 }))
  assert.ok(mismatched !== null && mismatched < 1)
})
