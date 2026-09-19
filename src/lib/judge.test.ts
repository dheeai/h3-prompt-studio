import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJudgeRequest, judgeFeedback, scoreJudge, weightedTotal, JUDGE_DIMENSIONS } from './judge'
import type { ExactQuestion, JudgeContext, JudgeQuestion, NoulQuestion, ScopedAnswers, ScoreQuestion } from './judge'
import type { Finding } from './types'

// ── a small, realistic two-shot Ref2VA fixture ─────────────────────────────

const PROMPT = [
  'subject_definitions: <Subject 1> is a woman in a workshop.',
  'summary: [reference generation] A woman works at a bench.',
  'retention_analysis: <Subject 1> fully_preserved',
  'detailed_description: [Shot 1] She stands at the bench, tools scattered, in a Static Shot. [Shot 2] At 00:05.000, the shot cuts to a close-up, Push In on her hands.',
  'overall_soundscape: a workshop hum, metal clinking.',
  'non_diegetic_music: N/A',
].join('\n\n')

function baseCtx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return {
    promptText: PROMPT,
    mode: 'Ref2VA',
    approvedShots: [
      { index: 1, summary: 'She stands at the bench', seconds: 3 },
      { index: 2, summary: 'Close-up on her hands', seconds: 2 },
    ],
    clipSeconds: 5,
    hasDialogue: false,
    hasCharacters: true,
    ...overrides,
  }
}

// ── expect:true|false — the sign-error class ───────────────────────────────

test('a Noul with expect:true contributes its raw probability', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.2 } } }]
  const score = scoreJudge(baseCtx(), [q], responses)
  const row = score.questions.find((r) => r.id === 'q1')!
  assert.equal(row.probability, 0.2)
  assert.equal(row.contribution, 0.2)
})

test('a Noul with expect:false inverts the contribution, never the probability', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: false }
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.2 } } }]
  const score = scoreJudge(baseCtx(), [q], responses)
  const row = score.questions.find((r) => r.id === 'q1')!
  // The raw read is untouched — only the contribution is inverted.
  assert.equal(row.probability, 0.2)
  assert.equal(row.contribution, 0.8)
})

test('flipping expect on an otherwise-identical rubric flips the dimension score', () => {
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.9 } } }]
  const good: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'camera', scope: 'prompt', instructions: 'x', expect: true }
  const flipped: NoulQuestion = { ...good, expect: false }
  const a = scoreJudge(baseCtx(), [good], responses).dimensions.camera.score
  const b = scoreJudge(baseCtx(), [flipped], responses).dimensions.camera.score
  assert.ok(a !== null && b !== null)
  assert.ok(Math.abs((a as number) - (1 - (b as number))) < 1e-9)
})

// ── inapplicable questions leave the denominator, never score zero ─────────

test('appliesWhen:false removes a question from its dimension entirely, not as a zero', () => {
  const skipped: NoulQuestion = {
    kind: 'noul',
    id: 'dlg',
    dimension: 'dialogue',
    scope: 'prompt',
    instructions: 'x',
    expect: true,
    appliesWhen: (ctx) => ctx.hasDialogue,
  }
  const score = scoreJudge(baseCtx({ hasDialogue: false }), [skipped], [])
  assert.equal(score.dimensions.dialogue.score, null)
  assert.equal(score.dimensions.dialogue.appliedCount, 0)
  assert.equal(score.dimensions.dialogue.weight, 0)
  const row = score.questions.find((r) => r.id === 'dlg')!
  assert.equal(row.applied, false)
  assert.equal(row.contribution, undefined)
})

test('an applied question next to a skipped one is scored on its own, not diluted by the skip', () => {
  const applies: NoulQuestion = { kind: 'noul', id: 'always', dimension: 'pacing', scope: 'prompt', instructions: 'x', expect: true }
  const skipped: NoulQuestion = {
    kind: 'noul',
    id: 'never',
    dimension: 'pacing',
    scope: 'prompt',
    instructions: 'x',
    expect: true,
    appliesWhen: () => false,
  }
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { always: { type: 'noul', noul: 0.7 } } }]
  const score = scoreJudge(baseCtx(), [applies, skipped], responses)
  assert.equal(score.dimensions.pacing.score, 0.7)
  assert.equal(score.dimensions.pacing.appliedCount, 1)
  assert.equal(score.dimensions.pacing.questionCount, 2)
})

test('an Exact question returning null is left out of the denominator', () => {
  const notApplicable: ExactQuestion = { kind: 'exact', id: 'e1', dimension: 'shots', scope: 'prompt', check: () => null }
  const score = scoreJudge(baseCtx({ approvedShots: [] }), [notApplicable], [])
  assert.equal(score.dimensions.shots.score, null)
  assert.equal(score.dimensions.shots.appliedCount, 0)
})

// ── score questions sum probability mass, never read `.score` ─────────────

test('a Score question sums the good-level probability mass, ignoring the API `.score` field', () => {
  const q: ScoreQuestion = {
    kind: 'score',
    id: 'sc',
    dimension: 'camera',
    scope: 'prompt',
    instructions: 'x',
    criteria: ['bad', 'ok', 'good'],
    goodLevels: [2],
  }
  const responses: ScopedAnswers[] = [
    {
      scope: 'prompt',
      answers: {
        // A deliberately misleading `.score` (an interpolated 0.1, as if
        // mostly "bad") next to probabilities that actually put most mass on
        // level 2 ("good"). scoreJudge must read probabilities, not `.score`.
        sc: { type: 'score', score: 0.1, legend: { '0': 'bad', '1': 'ok', '2': 'good' }, probabilities: { '0': 0.05, '1': 0.15, '2': 0.8 }, confidence: 0.9 },
      },
    },
  ]
  const score = scoreJudge(baseCtx(), [q], responses)
  assert.equal(score.dimensions.camera.score, 0.8)
})

test('a Score question can sum mass across several good levels', () => {
  const q: ScoreQuestion = {
    kind: 'score',
    id: 'sc',
    dimension: 'camera',
    scope: 'prompt',
    instructions: 'x',
    criteria: ['bad', 'ok', 'good'],
    goodLevels: [1, 2],
  }
  const responses: ScopedAnswers[] = [
    { scope: 'prompt', answers: { sc: { type: 'score', score: 1, legend: {}, probabilities: { '0': 0.2, '1': 0.3, '2': 0.5 }, confidence: 0.9 } } },
  ]
  const score = scoreJudge(baseCtx(), [q], responses)
  assert.equal(score.dimensions.camera.score, 0.8)
})

// ── missing/malformed answers are defensive, never crash, never a zero ────

test('a missing answer for a sent question is not applied, not a zero', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'ghost', dimension: 'acting', scope: 'prompt', instructions: 'x', expect: true }
  const score = scoreJudge(baseCtx(), [q], [{ scope: 'prompt', answers: {} }])
  assert.equal(score.dimensions.acting.score, null)
  const row = score.questions.find((r) => r.id === 'ghost')!
  assert.equal(row.applied, false)
})

test('an answer of the wrong shape (e.g. a choice answer for a noul question) is not applied', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'acting', scope: 'prompt', instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { q1: { type: 'choice', choice: 'x', probabilities: { x: 1 }, confidence: 1 } } }]
  const score = scoreJudge(baseCtx(), [q], responses)
  assert.equal(score.dimensions.acting.appliedCount, 0)
})

test('no responses at all does not throw, and every question reads as not applied', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'acting', scope: 'prompt', instructions: 'x', expect: true }
  assert.doesNotThrow(() => scoreJudge(baseCtx(), [q], []))
  const score = scoreJudge(baseCtx(), [q], [])
  assert.equal(score.dimensions.acting.score, null)
})

// ── buildJudgeRequest — exact wire shape, exact drops out ───────────────────

test('buildJudgeRequest emits no exact question, and defaults model to jev-latest', () => {
  const rubric: JudgeQuestion[] = [
    { kind: 'noul', id: 'n1', dimension: 'direction', scope: 'prompt', instructions: 'Does X hold?', criteria: { true: 'yes case', false: 'no case' }, expect: true },
    { kind: 'score', id: 's1', dimension: 'direction', scope: 'prompt', instructions: 'How Y?', criteria: ['low', 'high'], goodLevels: [1] },
    { kind: 'exact', id: 'e1', dimension: 'direction', scope: 'prompt', check: () => 1 },
  ]
  const requests = buildJudgeRequest(baseCtx(), rubric)
  assert.equal(requests.length, 1)
  const [{ scope, shotIndex, request }] = requests
  assert.equal(scope, 'prompt')
  assert.equal(shotIndex, undefined)
  assert.equal(request.model, 'jev-latest')
  assert.equal(request.state, PROMPT)
  assert.deepEqual(Object.keys(request.questions).sort(), ['n1', 's1'])
  assert.deepEqual(request.questions.n1, { type: 'noul', instructions: 'Does X hold?', criteria: { true: 'yes case', false: 'no case' } })
  assert.deepEqual(request.questions.s1, { type: 'score', instructions: 'How Y?', criteria: ['low', 'high'] })
})

test('buildJudgeRequest omits an appliesWhen:false question and takes a custom model id', () => {
  const rubric: JudgeQuestion[] = [
    { kind: 'noul', id: 'dlg', dimension: 'dialogue', scope: 'prompt', instructions: 'x', expect: true, appliesWhen: (ctx) => ctx.hasDialogue },
  ]
  const requests = buildJudgeRequest(baseCtx({ hasDialogue: false }), rubric, 'laya-en-v1')
  assert.equal(requests.length, 0)

  const withDialogue = buildJudgeRequest(baseCtx({ hasDialogue: true }), rubric, 'laya-en-v1')
  assert.equal(withDialogue.length, 1)
  assert.equal(withDialogue[0].request.model, 'laya-en-v1')
})

test('a noul question with no criteria omits the criteria key entirely, rather than sending it empty', () => {
  const rubric: JudgeQuestion[] = [{ kind: 'noul', id: 'n1', dimension: 'pacing', scope: 'prompt', instructions: 'x', expect: true }]
  const requests = buildJudgeRequest(baseCtx(), rubric)
  assert.deepEqual(requests[0].request.questions.n1, { type: 'noul', instructions: 'x' })
  assert.ok(!('criteria' in requests[0].request.questions.n1))
})

// ── scope partitioning — 'shot' questions get one request per approved shot ─

test("a 'shot'-scoped question produces one request per approved shot, state limited to that shot's own fragment", () => {
  const rubric: JudgeQuestion[] = [{ kind: 'noul', id: 'motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }]
  const requests = buildJudgeRequest(baseCtx(), rubric)
  assert.equal(requests.length, 2)
  assert.deepEqual(
    requests.map((r) => r.scope),
    ['shot', 'shot'],
  )
  assert.deepEqual(
    requests.map((r) => r.shotIndex),
    [1, 2],
  )
  // Shot 1's state carries only its own text — never shot 2's.
  assert.ok(requests[0].request.state.includes('tools scattered'))
  assert.ok(!requests[0].request.state.includes('close-up'))
  assert.ok(requests[1].request.state.includes('close-up'))
  assert.ok(!requests[1].request.state.includes('tools scattered'))
})

test('a question pinned to one shot via shotIndex is only sent in that shot\'s own request', () => {
  const rubric: JudgeQuestion[] = [{ kind: 'noul', id: 'chain2', dimension: 'shots', scope: 'shot', shotIndex: 2, instructions: 'x', expect: true }]
  const requests = buildJudgeRequest(baseCtx(), rubric)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].shotIndex, 2)
  assert.deepEqual(Object.keys(requests[0].request.questions), ['chain2'])
})

test('a mixed prompt+shot rubric produces one prompt request plus one request per shot, never combined', () => {
  const rubric: JudgeQuestion[] = [
    { kind: 'noul', id: 'p1', dimension: 'direction', scope: 'prompt', instructions: 'x', expect: true },
    { kind: 'noul', id: 's1', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true },
  ]
  const requests = buildJudgeRequest(baseCtx(), rubric)
  assert.equal(requests.length, 3)
  assert.equal(requests.filter((r) => r.scope === 'prompt').length, 1)
  assert.equal(requests.filter((r) => r.scope === 'shot').length, 2)
})

test('a generic shot-scoped template with no approved shots produces no requests at all', () => {
  const rubric: JudgeQuestion[] = [{ kind: 'noul', id: 'motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }]
  const requests = buildJudgeRequest(baseCtx({ approvedShots: [] }), rubric)
  assert.equal(requests.length, 0)
})

// ── scoreJudge on the shot scope — instantiation and pinning ───────────────

test('scoreJudge instantiates a generic shot-scoped template once per shot, with #shot ids', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [
    { scope: 'shot', shotIndex: 1, answers: { motivated: { type: 'noul', noul: 0.9 } } },
    { scope: 'shot', shotIndex: 2, answers: { motivated: { type: 'noul', noul: 0.3 } } },
  ]
  const score = scoreJudge(baseCtx(), [q], responses)
  const ids = score.questions.map((r) => r.id).sort()
  assert.deepEqual(ids, ['motivated#shot1', 'motivated#shot2'])
  assert.equal(score.dimensions.camera.appliedCount, 2)
  // Weight-normalised average of 0.9 and 0.3.
  assert.equal(score.dimensions.camera.score, 0.6)
})

test('a pinned shot question (shotIndex set) only reads its own shot\'s response', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'chain1', dimension: 'shots', scope: 'shot', shotIndex: 1, instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [
    { scope: 'shot', shotIndex: 1, answers: { chain1: { type: 'noul', noul: 0.8 } } },
    { scope: 'shot', shotIndex: 2, answers: { chain1: { type: 'noul', noul: 0.1 } } }, // must be ignored
  ]
  const score = scoreJudge(baseCtx(), [q], responses)
  const row = score.questions.find((r) => r.id === 'chain1')!
  assert.equal(row.contribution, 0.8)
})

test('a generic shot-scoped template that never reached any shot is not applied, not a zero', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }
  const score = scoreJudge(baseCtx(), [q], [])
  assert.equal(score.dimensions.camera.score, null)
  const row = score.questions.find((r) => r.id === 'motivated')!
  assert.equal(row.applied, false)
})

// ── UNDELIVERED — a planned shot the prompt never wrote a fragment for ─────
//
// The measured A/B bug this fix addresses: a plan of 7 approved shots, a
// prompt that only wrote fragments for the first 3. Shots 4-7 have no
// `[Shot N]` fragment at all, so `buildJudgeRequest` never built a request
// to ask about them. Before the fix, `scoreJudge` read that as "no answer
// ever reached this shot" and dropped it out of the denominator — exactly
// the same shape of bug already fixed once for `pacingTimeline`. After the
// fix, an UNDELIVERED shot scores 0 and stays IN the denominator.

const SEVEN_SHOT_PLAN = Array.from({ length: 7 }, (_, i) => ({ index: i + 1, summary: `Shot ${i + 1}`, seconds: 2 }))

/** Three `[Shot N]` fragments only — shots 4-7 were never written. */
const THREE_OF_SEVEN_PROMPT = [
  'subject_definitions: <Subject 1> is a woman in a workshop.',
  'summary: [reference generation] A woman works at a bench.',
  'retention_analysis: <Subject 1> fully_preserved',
  [
    'detailed_description:',
    '[Shot 1] She stands at the bench, tools scattered, in a Static Shot.',
    '[Shot 2] At 00:02.000, she reaches for a wrench, Push In.',
    '[Shot 3] At 00:04.000, she tightens a bolt, Static Shot.',
  ].join(' '),
  'overall_soundscape: a workshop hum, metal clinking.',
  'non_diegetic_music: N/A',
].join('\n\n')

function sevenShotCtx(overrides: Partial<JudgeContext> = {}): JudgeContext {
  return baseCtx({ promptText: THREE_OF_SEVEN_PROMPT, approvedShots: SEVEN_SHOT_PLAN, clipSeconds: 14, ...overrides })
}

test('a pinned per-shot question for an undelivered shot scores 0 with applied:true, in the denominator', () => {
  // shots.chain.N shape: one question per approved shot, pinned via shotIndex.
  const rubric: NoulQuestion[] = SEVEN_SHOT_PLAN.map((shot) => ({
    kind: 'noul',
    id: `shots.chain.${shot.index}`,
    dimension: 'shots',
    scope: 'shot',
    shotIndex: shot.index,
    instructions: 'x',
    expect: true,
  }))
  // Only the 3 delivered shots get a response at all — nothing was ever sent
  // for shots 4-7, since no fragment existed to build a request from.
  const responses: ScopedAnswers[] = [1, 2, 3].map((shotIndex) => ({
    scope: 'shot' as const,
    shotIndex,
    answers: { [`shots.chain.${shotIndex}`]: { type: 'noul' as const, noul: 1 } },
  }))
  const score = scoreJudge(sevenShotCtx(), rubric, responses)

  for (const missing of [4, 5, 6, 7]) {
    const row = score.questions.find((r) => r.id === `shots.chain.${missing}`)!
    assert.equal(row.applied, true, `shots.chain.${missing} must be applied:true (undelivered, not unevaluable)`)
    assert.equal(row.contribution, 0)
    assert.equal(row.probability, 0)
  }
  for (const present of [1, 2, 3]) {
    const row = score.questions.find((r) => r.id === `shots.chain.${present}`)!
    assert.equal(row.applied, true)
    assert.equal(row.contribution, 1)
  }

  // The dimension's denominator includes all 7 — the 4 missing shots pull
  // the average down instead of quietly leaving it.
  assert.equal(score.dimensions.shots.appliedCount, 7)
  assert.equal(score.dimensions.shots.questionCount, 7)
  assert.ok(Math.abs((score.dimensions.shots.score as number) - 3 / 7) < 1e-9)
})

test('a generic shot-scoped template scores each undelivered shot 0, applied:true, alongside delivered shots answered normally', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'camera.motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [1, 2, 3].map((shotIndex) => ({
    scope: 'shot' as const,
    shotIndex,
    answers: { 'camera.motivated': { type: 'noul' as const, noul: 0.9 } },
  }))
  const score = scoreJudge(sevenShotCtx(), [q], responses)

  for (const missing of [4, 5, 6, 7]) {
    const row = score.questions.find((r) => r.id === `camera.motivated#shot${missing}`)!
    assert.equal(row.applied, true)
    assert.equal(row.contribution, 0)
  }
  for (const present of [1, 2, 3]) {
    const row = score.questions.find((r) => r.id === `camera.motivated#shot${present}`)!
    assert.equal(row.contribution, 0.9)
  }
  assert.equal(score.dimensions.camera.questionCount, 7)
  assert.equal(score.dimensions.camera.appliedCount, 7)
  assert.ok(Math.abs((score.dimensions.camera.score as number) - (3 * 0.9) / 7) < 1e-9)
})

test('with ctx.approvedShots empty, shot-scoped questions still skip entirely — no plan, no claim', () => {
  const pinned: NoulQuestion = {
    kind: 'noul',
    id: 'shots.chain.1',
    dimension: 'shots',
    scope: 'shot',
    shotIndex: 1,
    instructions: 'x',
    expect: true,
  }
  const generic: NoulQuestion = { kind: 'noul', id: 'camera.motivated', dimension: 'camera', scope: 'shot', instructions: 'x', expect: true }
  const score = scoreJudge(baseCtx({ approvedShots: [] }), [pinned, generic], [])

  assert.equal(score.dimensions.shots.score, null)
  assert.equal(score.dimensions.shots.appliedCount, 0)
  const pinnedRow = score.questions.find((r) => r.id === 'shots.chain.1')!
  assert.equal(pinnedRow.applied, false)
  assert.equal(pinnedRow.contribution, undefined)

  assert.equal(score.dimensions.camera.score, null)
  assert.equal(score.dimensions.camera.appliedCount, 0)
  const genericRow = score.questions.find((r) => r.id === 'camera.motivated')!
  assert.equal(genericRow.applied, false)
  assert.equal(genericRow.contribution, undefined)
})

test('appliesWhen:false still wins over an undelivered shot — a genuinely exempt question never scores a manufactured zero', () => {
  const q: NoulQuestion = {
    kind: 'noul',
    id: 'acting.observable-not-labeled',
    dimension: 'acting',
    scope: 'shot',
    instructions: 'x',
    expect: true,
    appliesWhen: (ctx) => ctx.hasCharacters,
  }
  const score = scoreJudge(sevenShotCtx({ hasCharacters: false }), [q], [])
  const row = score.questions.find((r) => r.id === 'acting.observable-not-labeled')!
  assert.equal(row.applied, false)
  assert.equal(row.contribution, undefined)
  assert.equal(score.dimensions.acting.appliedCount, 0)
})

test('a sent question for a DELIVERED shot whose answer never came back is still applied:false — not caught by the undelivered rule', () => {
  // shot 1 has a real fragment (delivered), but its answer is simply absent
  // from the response — a network/API failure, not a missing shot.
  const q: NoulQuestion = { kind: 'noul', id: 'shots.chain.1', dimension: 'shots', scope: 'shot', shotIndex: 1, instructions: 'x', expect: true }
  const score = scoreJudge(sevenShotCtx(), [q], [{ scope: 'shot', shotIndex: 1, answers: {} }])
  const row = score.questions.find((r) => r.id === 'shots.chain.1')!
  assert.equal(row.applied, false)
  assert.equal(row.contribution, undefined)
  assert.equal(score.dimensions.shots.appliedCount, 0)
})

test('regression: a prompt that delivers every planned shot scores exactly as before this fix', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'shots.chain.1', dimension: 'shots', scope: 'shot', shotIndex: 1, instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [{ scope: 'shot', shotIndex: 1, answers: { 'shots.chain.1': { type: 'noul', noul: 0.75 } } }]
  const score = scoreJudge(baseCtx(), [q], responses)
  const row = score.questions.find((r) => r.id === 'shots.chain.1')!
  assert.equal(row.applied, true)
  assert.equal(row.contribution, 0.75)
  assert.equal(score.dimensions.shots.score, 0.75)
})

// ── judgeFeedback — deterministic and bounded ──────────────────────────────

const NO_FINDINGS: Finding[] = []

test('judgeFeedback is deterministic — same input, same output, byte for byte', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: true }
  const responses: ScopedAnswers[] = [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.4 } } }]
  const score = scoreJudge(baseCtx(), [q], responses)
  const a = judgeFeedback(score, NO_FINDINGS)
  const b = judgeFeedback(score, NO_FINDINGS)
  assert.equal(a, b)
})

test('judgeFeedback caps the number of dimensions and questions it names', () => {
  const rubric: JudgeQuestion[] = JUDGE_DIMENSIONS.flatMap((dim, i) => [
    { kind: 'noul' as const, id: `${dim}.a`, dimension: dim, scope: 'prompt' as const, instructions: 'x', expect: true },
    { kind: 'noul' as const, id: `${dim}.b`, dimension: dim, scope: 'prompt' as const, instructions: 'x', expect: true },
  ])
  const responses: ScopedAnswers[] = [
    {
      scope: 'prompt',
      answers: Object.fromEntries(rubric.map((q, i) => [q.id, { type: 'noul' as const, noul: (i % 10) / 10 }])),
    },
  ]
  const score = scoreJudge(baseCtx(), rubric, responses)
  const feedback = judgeFeedback(score, NO_FINDINGS)
  const dimensionLines = feedback.split('\n').filter((l) => /^  [a-z]+: /.test(l))
  const questionLines = feedback.split('\n').filter((l) => /^  \[/.test(l))
  assert.ok(dimensionLines.length <= 3)
  assert.ok(questionLines.length <= 5)
})

test('judgeFeedback includes findingsToText output verbatim', () => {
  const finding: Finding = {
    id: 'music/sentinel',
    severity: 'error',
    title: 'non_diegetic_music must be exactly N/A',
    detail: 'Anything that describes the absence of music is a specification of a score.',
    matches: ['None. No music.'],
  }
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: true }
  const score = scoreJudge(baseCtx(), [q], [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.5 } } }])
  const feedback = judgeFeedback(score, [finding])
  assert.ok(feedback.includes('non_diegetic_music must be exactly N/A'))
  assert.ok(feedback.includes('None. No music.'))
})

// ── weightedTotal — opt-in, and NOT part of scoreJudge's own return shape ──

test('weightedTotal is a separate helper, not a field scoreJudge returns', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: true }
  const score = scoreJudge(baseCtx(), [q], [{ scope: 'prompt', answers: { q1: { type: 'noul', noul: 0.5 } } }])
  assert.deepEqual(Object.keys(score).sort(), ['dimensions', 'questions'])
  assert.equal(weightedTotal(score), 0.5)
})

test('weightedTotal returns null when nothing applied anywhere', () => {
  const q: NoulQuestion = { kind: 'noul', id: 'q1', dimension: 'shots', scope: 'prompt', instructions: 'x', expect: true, appliesWhen: () => false }
  const score = scoreJudge(baseCtx(), [q], [])
  assert.equal(weightedTotal(score), null)
})

test('weightedTotal weights each dimension by its applied weight, not a plain average', () => {
  const heavy: NoulQuestion[] = Array.from({ length: 3 }, (_, i) => ({
    kind: 'noul' as const,
    id: `heavy${i}`,
    dimension: 'camera' as const,
    scope: 'prompt' as const,
    instructions: 'x',
    expect: true,
  }))
  const light: NoulQuestion = { kind: 'noul', id: 'light', dimension: 'pacing', scope: 'prompt', instructions: 'x', expect: true }
  const rubric = [...heavy, light]
  const responses: ScopedAnswers[] = [
    {
      scope: 'prompt',
      answers: {
        heavy0: { type: 'noul', noul: 1 },
        heavy1: { type: 'noul', noul: 1 },
        heavy2: { type: 'noul', noul: 1 },
        light: { type: 'noul', noul: 0 },
      },
    },
  ]
  const score = scoreJudge(baseCtx(), rubric, responses)
  // camera=1 (weight 3), pacing=0 (weight 1) -> weighted mean 0.75, not the
  // 0.5 a naive per-dimension average would give.
  assert.equal(weightedTotal(score), 0.75)
})
