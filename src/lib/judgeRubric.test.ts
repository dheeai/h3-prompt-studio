import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFullRubric,
  buildPerShotQuestions,
  buildSoundCoverageQuestions,
  JUDGE_RUBRIC,
  PACING_FLASH_FLOOR_MS,
  PACING_MIN_SEGMENTS_FOR_VARIANCE,
  PACING_MONOLITH_MAX_SHARE,
  PACING_RHYTHM_CV_FLOOR,
  PACING_RHYTHM_CV_HEALTHY,
} from './judgeRubric'
import { buildJudgeRequest, JUDGE_DIMENSIONS, scoreJudge } from './judge'
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
    hasCharacters: true,
    ...overrides,
  }
}

/** A minimal Ref2VA-shaped prompt whose `detailed_description` body is
 * exactly what the caller passes — for the pacing/sound fixtures below,
 * which need to control the shot markup (or its absence) precisely. */
function promptWithBody(body: string, soundscape = 'a workshop hum, metal clinking.'): string {
  return [
    'subject_definitions: <Subject 1> is a woman in a workshop.',
    'summary: [reference generation] A woman works at a bench.',
    'retention_analysis: <Subject 1> fully_preserved',
    `detailed_description: ${body}`,
    `overall_soundscape: ${soundscape}`,
    'non_diegetic_music: N/A',
  ].join('\n\n')
}

// ── the static rubric shape — one reviewable file, as designed ────────────

test('JUDGE_RUBRIC covers all seven dimensions, with no empty ones', () => {
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
  assert.deepEqual(byKind, { noul: 17, score: 6, exact: 9 })
  assert.deepEqual(byDimension, {
    direction: { jev: 6, exact: 0 }, // +1: direction.escalation, moved in from pacing
    acting: { jev: 4, exact: 0 },
    camera: { jev: 4, exact: 1 }, // +1: camera.specified-overall
    shots: { jev: 2, exact: 2 },
    dialogue: { jev: 4, exact: 1 },
    pacing: { jev: 1, exact: 4 }, // varied-rhythm deleted, escalation moved out; +3 exact, +1 noul (shot-earns-its-length)
    sound: { jev: 2, exact: 1 }, // new dimension
  })
  assert.equal(JUDGE_RUBRIC.length, 32)
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

test('buildFullRubric is the static rubric plus that clip\'s own two fan-outs, nothing shared between clips', () => {
  // Three approved shots -> three action-chain questions AND three sound-coverage questions.
  const full3 = buildFullRubric(ctx())
  assert.equal(full3.length, JUDGE_RUBRIC.length + 3 + 3)

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

// ── pacing rework — timeline extraction, and its three kept-distinct outcomes ─

function rhythmVariance(ctx: JudgeContext) {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'pacing.rhythm-variance')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') throw new Error('unreachable')
  return q.check(ctx)
}
function noFlashFrames(ctx: JudgeContext) {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'pacing.no-flash-frames')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') throw new Error('unreachable')
  return q.check(ctx)
}
function noMonolith(ctx: JudgeContext) {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'pacing.no-monolith')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') throw new Error('unreachable')
  return q.check(ctx)
}

test('pacing.rhythm-variance is null (not 0) for a one-take / two-beat clip — too few segments to vary against', () => {
  const twoShots = promptWithBody('[Shot 1] She stands. [Shot 2] At 00:03.000, she turns.')
  assert.equal(rhythmVariance(ctx({ promptText: twoShots, clipSeconds: 5, approvedShots: [] })), null)
  assert.equal(noMonolith(ctx({ promptText: twoShots, clipSeconds: 5, approvedShots: [] })), null)
})

test('pacing.rhythm-variance scores 0 on a uniformly-paced multi-shot clip', () => {
  const uniform = promptWithBody('[Shot 1] A. [Shot 2] At 00:02.000, B. [Shot 3] At 00:04.000, C.')
  assert.equal(rhythmVariance(ctx({ promptText: uniform, clipSeconds: 6, approvedShots: [] })), 0)
})

test('pacing.rhythm-variance scores high on a varied clip, and pacing.no-monolith catches the shot that dominates it', () => {
  const varied = promptWithBody('[Shot 1] A. [Shot 2] At 00:01.000, B. [Shot 3] At 00:02.000, C.')
  const c = ctx({ promptText: varied, clipSeconds: 10, approvedShots: [] })
  const score = rhythmVariance(c)
  assert.ok(score !== null && score > 0.9)
  // durations 1s, 1s, 8s of 10s total -> the 8s shot is 80% of the clip, over
  // PACING_MONOLITH_MAX_SHARE (0.6) -> 1 - (0.8-0.6)/(1-0.6) = 0.5.
  assert.ok(Math.abs(noMonolith(c)! - 0.5) < 1e-9)
  assert.ok(PACING_MONOLITH_MAX_SHARE < 0.8)
})

test('pacing.no-flash-frames trips on a sub-floor shot', () => {
  const flash = promptWithBody('[Shot 1] A. [Shot 2] At 00:03.000, B. [Shot 3] At 00:06.000, C.')
  // durations 3000ms, 3000ms, 300ms — the last is under PACING_FLASH_FLOOR_MS (1000ms).
  const score = noFlashFrames(ctx({ promptText: flash, clipSeconds: 6.3, approvedShots: [] }))
  assert.ok(score !== null && score < 1)
  assert.ok(PACING_FLASH_FLOOR_MS > 300)
})

test('pacing.no-flash-frames computes on only two segments, unlike its two siblings which require PACING_MIN_SEGMENTS_FOR_VARIANCE', () => {
  assert.equal(PACING_MIN_SEGMENTS_FOR_VARIANCE, 3)
  const twoShots = promptWithBody('[Shot 1] A. [Shot 2] At 00:00.300, B.')
  // shot 1: 0-300ms (flash); shot 2: 300ms-2000ms (fine). 1 of 2 within floor.
  const score = noFlashFrames(ctx({ promptText: twoShots, clipSeconds: 2, approvedShots: [] }))
  assert.equal(score, 0.5)
  // Its two siblings DO require 3+ and return null here instead.
  assert.equal(rhythmVariance(ctx({ promptText: twoShots, clipSeconds: 2, approvedShots: [] })), null)
  assert.equal(noMonolith(ctx({ promptText: twoShots, clipSeconds: 2, approvedShots: [] })), null)
})

test('all three pacing timeline checks are null (context-insufficient), not 0, when shot markers exist but clipSeconds is missing', () => {
  const c = ctx({ clipSeconds: 0 }) // the fixture PROMPT has 3 [Shot N] markers
  assert.equal(rhythmVariance(c), null)
  assert.equal(noFlashFrames(c), null)
  assert.equal(noMonolith(c), null)
})

test('all three pacing timeline checks score 0 — never null — when a prompt has no legible timeline at all', () => {
  // No [Shot N] markers and no M:SS-M:SS ranges either: a real defect, not a
  // structural exemption. Scoring this null would drop it from the
  // denominator and RAISE the prompt's score for having the least structure
  // — exactly the bug this whole rework exists to fix.
  const noTimeline = promptWithBody('She walks calmly through the workshop, adjusting tools without urgency.')
  const c = ctx({ promptText: noTimeline, approvedShots: [] })
  assert.equal(rhythmVariance(c), 0)
  assert.equal(noFlashFrames(c), 0)
  assert.equal(noMonolith(c), 0)
})

test('a marker-less prompt falls back to explicit M:SS-M:SS time ranges in the prose — measured six-segment FPV timeline', () => {
  // The exact drone-brief timeline that exposed the marker-only gap: no
  // [Shot N] markers anywhere, six explicit ranges, durations 3,3,3,2,2,2s.
  const rangeBody = [
    '0:00-0:03 Start low near the left feeder ramp.',
    '0:03-0:06 Follow the path upward.',
    '0:06-0:09 Sweep along the right-side city edge.',
    '0:09-0:11 Reach the upper skyline cluster.',
    '0:11-0:13 Curve around the large circular flyover loop.',
    '0:13-0:15 Exit the spiral and descend.',
  ].join(' ')
  const c = ctx({ promptText: promptWithBody(rangeBody), approvedShots: [] })
  // CV = stddev(500) / mean(2500) = 0.2 exactly.
  assert.equal(rhythmVariance(c), (0.2 - PACING_RHYTHM_CV_FLOOR) / (PACING_RHYTHM_CV_HEALTHY - PACING_RHYTHM_CV_FLOOR))
  // 3000ms of 15000ms total = 20% — nowhere near PACING_MONOLITH_MAX_SHARE.
  assert.equal(noMonolith(c), 1)
})

test('pacing.shot-earns-its-length is a generic shot-scoped noul with no numbers in its instructions', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'pacing.shot-earns-its-length')!
  assert.equal(q.kind, 'noul')
  assert.equal(q.dimension, 'pacing')
  assert.equal(q.scope, 'shot')
  assert.equal(q.shotIndex, undefined)
  if (q.kind === 'noul') {
    assert.equal(q.expect, true)
    assert.ok(!/\d/.test(q.instructions), 'instructions must carry no numbers/durations — Jev cannot do arithmetic')
  }
})

// ── direction.escalation — moved in from pacing, wording unchanged ─────────

test('direction.escalation exists (moved from pacing.escalation) and pacing.varied-rhythm/pacing.escalation no longer do', () => {
  const moved = JUDGE_RUBRIC.find((q) => q.id === 'direction.escalation')!
  assert.equal(moved.dimension, 'direction')
  assert.equal(moved.kind, 'score')
  assert.ok(!JUDGE_RUBRIC.some((q) => q.id === 'pacing.escalation'))
  assert.ok(!JUDGE_RUBRIC.some((q) => q.id === 'pacing.varied-rhythm'))
})

// ── hasCharacters — acting, and the two character-dependent direction questions ─

test('every acting question, plus direction.objective-stated/obstacle-concrete, is gated on hasCharacters', () => {
  const gated = [
    ...JUDGE_RUBRIC.filter((q) => q.dimension === 'acting'),
    JUDGE_RUBRIC.find((q) => q.id === 'direction.objective-stated')!,
    JUDGE_RUBRIC.find((q) => q.id === 'direction.obstacle-concrete')!,
  ]
  for (const q of gated) {
    assert.ok(q.appliesWhen, `${q.id} has no appliesWhen gate`)
    assert.equal(q.appliesWhen!(ctx({ hasCharacters: false })), false, `${q.id} should be gated off`)
    assert.equal(q.appliesWhen!(ctx({ hasCharacters: true })), true, `${q.id} should apply`)
  }
})

test('hasCharacters: false removes the whole acting dimension from the denominator, never as a manufactured zero', () => {
  const actingOnly = JUDGE_RUBRIC.filter((q) => q.dimension === 'acting')
  const score = scoreJudge(ctx({ hasCharacters: false }), actingOnly, [])
  assert.equal(score.dimensions.acting.score, null)
  assert.equal(score.dimensions.acting.appliedCount, 0)
})

// ── camera.specified-overall — the one prompt-scoped camera question ──────

test('camera.specified-overall is a prompt-scoped noul, so a clip with no [Shot N] markers still gets a camera request', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'camera.specified-overall')!
  assert.equal(q.kind, 'noul')
  assert.equal(q.dimension, 'camera')
  assert.equal(q.scope, 'prompt')
  if (q.kind === 'noul') assert.equal(q.expect, true)

  const markerless = promptWithBody('Realistic banking turns, believable acceleration and inertia, motion blur from speed.')
  const requests = buildJudgeRequest(ctx({ promptText: markerless, approvedShots: [] }), [q])
  assert.equal(requests.length, 1)
  assert.equal(requests[0].scope, 'prompt')
  assert.ok('camera.specified-overall' in requests[0].request.questions)
})

// ── sound — shot coverage fan-out, and the two other sound questions ──────

test('buildSoundCoverageQuestions generates one prompt-scoped question per approved shot, named by plan summary not by marker', () => {
  const c = ctx()
  const questions = buildSoundCoverageQuestions(c)
  assert.equal(questions.length, 3)
  assert.deepEqual(
    questions.map((q) => q.id),
    ['sound.shot-covered.1', 'sound.shot-covered.2', 'sound.shot-covered.3'],
  )
  for (const q of questions) {
    assert.equal(q.dimension, 'sound')
    assert.equal(q.scope, 'prompt') // NOT 'shot' — needs the soundscape alongside the beat
    assert.equal(q.kind, 'noul')
    assert.equal(q.expect, true)
  }
  // Named by the plan's own summary, not a [Shot N] marker.
  assert.match(questions[1].instructions, /Close-up on her hands/)
  assert.doesNotMatch(questions[1].instructions, /\[Shot/)
  // Dialogue-counts-as-covered and deliberate-silence-counts-as-covered are
  // both load-bearing distinctions and must live in the criteria the model
  // actually reads, not just in this file's comments.
  assert.match(questions[0].criteria!.true!, /dialogue/i)
  assert.match(questions[0].criteria!.true!, /silent|silence/i)
  assert.match(questions[0].criteria!.false!, /unaddressed/i)
})

test('buildSoundCoverageQuestions tracks whatever shots are actually approved — none or several', () => {
  assert.equal(buildSoundCoverageQuestions(ctx({ approvedShots: [] })).length, 0)
})

test('sound.synced-to-events and sound.every-moment-accounted are prompt-scoped nouls with no vacuous conditional', () => {
  const synced = JUDGE_RUBRIC.find((q) => q.id === 'sound.synced-to-events')!
  const accounted = JUDGE_RUBRIC.find((q) => q.id === 'sound.every-moment-accounted')!
  for (const q of [synced, accounted]) {
    assert.equal(q.kind, 'noul')
    assert.equal(q.dimension, 'sound')
    assert.equal(q.scope, 'prompt')
    if (q.kind === 'noul') assert.equal(q.expect, true)
  }
  // "where there is silence, is it deliberate" would be a vacuously-true
  // conditional on a clip with no silence at all — must be phrased directly.
  if (accounted.kind !== 'exact') assert.doesNotMatch(accounted.instructions, /where (there|it)/i)
})

test('sound.sources-concrete wraps lint()\'s audio/concrete finding: 1 for concrete sources, 0 for mood-only, null when absent', () => {
  const q = JUDGE_RUBRIC.find((q) => q.id === 'sound.sources-concrete')!
  assert.equal(q.kind, 'exact')
  if (q.kind !== 'exact') return

  // Concrete: three comma-separated elements -> lint's own `clauses >= 3` pass path.
  assert.equal(q.check(ctx({ promptText: promptWithBody('[Shot 1] A.', 'a workshop hum, metal clinking, a kettle whistling.') })), 1)
  // Mood-only -> lint's warn path.
  assert.equal(q.check(ctx({ promptText: promptWithBody('[Shot 1] A.', 'a tense, uneasy atmosphere.') })), 0)
  // No overall_soundscape field at all -> the rule never fires -> null, not 0.
  const noSoundscape = [
    'subject_definitions: <Subject 1> is a woman in a workshop.',
    'summary: [reference generation] A woman works at a bench.',
    'retention_analysis: <Subject 1> fully_preserved',
    'detailed_description: [Shot 1] She stands at the bench.',
    'non_diegetic_music: N/A',
  ].join('\n\n')
  assert.equal(q.check(ctx({ promptText: noSoundscape })), null)
})
