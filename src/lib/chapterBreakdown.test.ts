import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_SHOTS,
  CHAPTER_BREAKDOWN_SHOT_MAX,
  CHAPTER_BREAKDOWN_SHOT_MIN,
  CHAPTER_BREAKDOWN_TEMPLATE,
  chapterBreakdownResponseFormat,
  chapterBreakdownToBreakdown,
  chapterBreakdownToShotList,
  checkChapterBreakdown,
  fillChapterBreakdownTemplate,
  formatClipRawAsk,
  formatShotLine,
  parseChapterBreakdown,
  rawAskForClipIndex,
} from './chapterBreakdown'
import type { ChapterBreakdown, ChapterBreakdownClip, ChapterBreakdownShot } from './chapterBreakdown'

function shot(partial: Partial<ChapterBreakdownShot>): ChapterBreakdownShot {
  return {
    shot: 1,
    seconds: 5,
    camera: 'medium',
    subject: 'Nusrat',
    action: 'unrolls the bolt of silk',
    dialogue: null,
    ...partial,
  }
}

function clip(partial: Partial<ChapterBreakdownClip>): ChapterBreakdownClip {
  return {
    clip: 1,
    beat: 'Nusrat discovers the switched cloth.',
    shots: [
      shot({ shot: 1, seconds: 5, camera: 'wide_establishing' }),
      shot({ shot: 2, seconds: 5, camera: 'close_up', action: "her thumb presses the weave" }),
      shot({ shot: 3, seconds: 5, camera: 'medium_close', action: 'looks up at Farid', dialogue: { speaker: 'Nusrat', line: 'This is not what I chose.' } }),
    ],
    forwardPull: 'Farid does not move from the doorway.',
    ...partial,
  }
}

function breakdown(clips: ChapterBreakdownClip[]): ChapterBreakdown {
  return { chapter: 'The switched cloth', clips, at: 12345 }
}

// ── template ───────────────────────────────────────────────────────────────

test('fillChapterBreakdownTemplate: fills the one placeholder, trims the chapter', () => {
  const filled = fillChapterBreakdownTemplate('before {{chapter}} after', '  a story  ')
  assert.equal(filled, 'before a story after')
})

test('CHAPTER_BREAKDOWN_TEMPLATE: names every camera term verbatim', () => {
  for (const c of CAMERA_SHOTS) assert.ok(CHAPTER_BREAKDOWN_TEMPLATE.includes(c), `missing ${c}`)
})

// ── schema ─────────────────────────────────────────────────────────────────

test('chapterBreakdownResponseFormat: strict json_schema, no pattern, no maxLength anywhere', () => {
  const fmt = chapterBreakdownResponseFormat()
  const json = JSON.stringify(fmt)
  assert.equal((fmt as any).type, 'json_schema')
  assert.equal((fmt as any).json_schema.strict, true)
  assert.ok(!json.includes('"pattern"'), 'no regex pattern — GBNF cannot compile shorthand classes')
  assert.ok(!json.includes('maxLength'), 'no maxLength — GBNF fails to compile above ~1000')
  const shotsSchema = (fmt as any).json_schema.schema.properties.clips.items.properties.shots
  assert.equal(shotsSchema.minItems, CHAPTER_BREAKDOWN_SHOT_MIN)
  assert.equal(shotsSchema.maxItems, CHAPTER_BREAKDOWN_SHOT_MAX)
  assert.deepEqual(shotsSchema.items.properties.camera.enum, [...CAMERA_SHOTS])
  // dialogue is flattened, never a nullable object/oneOf — see the module comment.
  assert.ok(!json.includes('"null"'))
  assert.ok(!json.includes('oneOf'))
})

// ── parser ─────────────────────────────────────────────────────────────────

test('parseChapterBreakdown: round-trips a well-formed reply', () => {
  const b = breakdown([clip({})])
  const raw = JSON.stringify({
    chapter: b.chapter,
    clips: b.clips.map((c) => ({
      clip: c.clip,
      beat: c.beat,
      forward_pull: c.forwardPull,
      shots: c.shots.map((s) => ({
        shot: s.shot,
        seconds: s.seconds,
        camera: s.camera,
        subject: s.subject,
        action: s.action,
        has_dialogue: !!s.dialogue,
        dialogue_speaker: s.dialogue?.speaker ?? '',
        dialogue_line: s.dialogue?.line ?? '',
      })),
    })),
  })
  const parsed = parseChapterBreakdown(raw)
  assert.ok(parsed)
  assert.equal(parsed!.chapter, b.chapter)
  assert.equal(parsed!.clips.length, 1)
  assert.equal(parsed!.clips[0].shots.length, 3)
  assert.deepEqual(parsed!.clips[0].shots[2].dialogue, { speaker: 'Nusrat', line: 'This is not what I chose.' })
  assert.equal(parsed!.clips[0].shots[0].dialogue, null)
})

test('parseChapterBreakdown: strips a code fence and surrounding prose', () => {
  const raw = 'Here you go:\n```json\n{"chapter":"c","clips":[{"clip":1,"beat":"b","forward_pull":"f","shots":[{"shot":1,"seconds":5,"camera":"medium","subject":"s","action":"a","has_dialogue":false,"dialogue_speaker":"","dialogue_line":""}]}]}\n```\nhope that helps'
  const parsed = parseChapterBreakdown(raw)
  assert.ok(parsed)
  assert.equal(parsed!.chapter, 'c')
})

test('parseChapterBreakdown: garbage returns null, never throws', () => {
  assert.equal(parseChapterBreakdown('not json at all'), null)
  assert.equal(parseChapterBreakdown('{"chapter":"c","clips":[]}'), null)
})

test('parseChapterBreakdown: an unrecognised camera term falls back to "medium" rather than discarding the shot', () => {
  const raw = JSON.stringify({ chapter: 'c', clips: [{ clip: 1, beat: 'b', forward_pull: '', shots: [{ shot: 1, seconds: 5, camera: 'dutch_tilt', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }] }] })
  const parsed = parseChapterBreakdown(raw)
  assert.equal(parsed!.clips[0].shots[0].camera, 'medium')
})

// ── deterministic checks ────────────────────────────────────────────────────

test('checkChapterBreakdown: a well-formed clip has no issues', () => {
  assert.deepEqual(checkChapterBreakdown(breakdown([clip({})])), [])
})

test('checkChapterBreakdown: flags shots outside the 3-6 range', () => {
  const twoShots = clip({ shots: [shot({ shot: 1, seconds: 8, camera: 'wide_establishing' }), shot({ shot: 2, seconds: 7, camera: 'close_up' })] })
  const issues = checkChapterBreakdown(breakdown([twoShots]))
  assert.ok(issues.some((i) => i.includes('2 shots') && i.includes('range')))
})

test('checkChapterBreakdown: flags seconds drifting off the 15s target beyond tolerance', () => {
  const c = clip({ shots: [shot({ shot: 1, seconds: 3, camera: 'wide_establishing' }), shot({ shot: 2, seconds: 3, camera: 'close_up' }), shot({ shot: 3, seconds: 3, camera: 'medium' })] })
  const issues = checkChapterBreakdown(breakdown([c]))
  assert.ok(issues.some((i) => i.includes('sum to 9.0s')))
})

test('checkChapterBreakdown: does not flag a sum within the 0.5s tolerance', () => {
  const c = clip({ shots: [shot({ shot: 1, seconds: 5.2, camera: 'wide_establishing' }), shot({ shot: 2, seconds: 4.9, camera: 'close_up' }), shot({ shot: 3, seconds: 5.2, camera: 'medium' })] })
  assert.deepEqual(checkChapterBreakdown(breakdown([c])), [])
})

test('checkChapterBreakdown: flags two consecutive shots with the same camera', () => {
  const c = clip({ shots: [shot({ shot: 1, seconds: 5, camera: 'wide_establishing' }), shot({ shot: 2, seconds: 5, camera: 'wide_establishing' }), shot({ shot: 3, seconds: 5, camera: 'close_up' })] })
  const issues = checkChapterBreakdown(breakdown([c]))
  assert.ok(issues.some((i) => i.includes('repeat the same camera')))
})

test('checkChapterBreakdown: flags a dialogue line over the words/second ceiling', () => {
  const line = Array(20).fill('word').join(' ') // 20 words in 3s = 6.7 wps
  const c = clip({
    shots: [
      shot({ shot: 1, seconds: 5, camera: 'wide_establishing' }),
      shot({ shot: 2, seconds: 7, camera: 'close_up' }),
      shot({ shot: 3, seconds: 3, camera: 'medium_close', dialogue: { speaker: 'Nusrat', line } }),
    ],
  })
  const issues = checkChapterBreakdown(breakdown([c]))
  assert.ok(issues.some((i) => i.includes('words/s')))
})

// ── raw-ask formatter ────────────────────────────────────────────────────

test('formatShotLine: camera, subject, action and duration in the skill\'s own form', () => {
  const line = formatShotLine(shot({ shot: 2, seconds: 4, camera: 'close_up', subject: "Nusrat's thumb", action: 'presses against the weave' }))
  assert.equal(line, "Shot 2 – Close Up as Nusrat's thumb presses against the weave. (4s)")
})

test('formatShotLine: quotes dialogue verbatim, attributed to the speaker', () => {
  const line = formatShotLine(shot({ shot: 4, seconds: 5, camera: 'medium', subject: 'Nusrat', action: 'looks up', dialogue: { speaker: 'Nusrat', line: 'Same price will not fix what changed.' } }))
  assert.ok(line.includes('Nusrat says "Same price will not fix what changed."'))
  assert.ok(line.startsWith('Shot 4 – Medium as'))
})

test('formatShotLine: a non-integer duration renders with one decimal', () => {
  const line = formatShotLine(shot({ shot: 1, seconds: 3.5, camera: 'medium' }))
  assert.ok(line.endsWith('(3.5s)'))
})

test('formatClipRawAsk: "Clip N:" header, one line per shot in order, forward pull last', () => {
  const text = formatClipRawAsk(clip({}))
  const lines = text.split('\n')
  assert.equal(lines[0], 'Clip 1:')
  assert.equal(lines[1], '')
  assert.ok(lines[2].startsWith('Shot 1 –'))
  assert.ok(lines[3].startsWith('Shot 2 –'))
  assert.ok(lines[4].startsWith('Shot 3 –'))
  assert.ok(text.trim().endsWith('Farid does not move from the doorway.'))
})

test('formatClipRawAsk: omits the trailing blank/forward-pull lines when there is no forward pull', () => {
  const text = formatClipRawAsk(clip({ forwardPull: '' }))
  assert.ok(!text.endsWith('\n\n'))
  assert.ok(text.trim().endsWith('s)') || /\)\.?$/.test(text.trim()))
})

// ── mapping into Full Story mode ────────────────────────────────────────

test('chapterBreakdownToShotList: one shot per skill shot, one group per skill clip, already clip-sized', () => {
  const b = breakdown([clip({ clip: 1 }), clip({ clip: 2 })])
  const { shotList, groups } = chapterBreakdownToShotList(b)
  assert.equal(shotList.shots.length, 6)
  assert.equal(shotList.shots[0].index, 1)
  assert.equal(shotList.shots[5].index, 6)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups[0].shotIndices, [1, 2, 3])
  assert.deepEqual(groups[1].shotIndices, [4, 5, 6])
  assert.equal(groups[0].seconds, 15)
  assert.equal(shotList.maxRuntimeSeconds, 30)
  assert.equal(shotList.spine, b.chapter)
})

test('chapterBreakdownToShotList: a shot\'s covers carries the camera (unlike the beats/subdivide planner)', () => {
  const { shotList } = chapterBreakdownToShotList(breakdown([clip({})]))
  assert.ok(shotList.shots[0].covers.startsWith('Shot 1 –'))
})

test('chapterBreakdownToBreakdown: roles are opening/rising/closing by position, forward pull becomes follows', () => {
  const b = chapterBreakdownToBreakdown(breakdown([clip({ clip: 1 }), clip({ clip: 2 }), clip({ clip: 3 })]))
  assert.equal(b.clips[0].role, 'opening')
  assert.equal(b.clips[1].role, 'rising')
  assert.equal(b.clips[2].role, 'closing')
  assert.equal(b.clips[0].follows, 'Farid does not move from the doorway.')
  assert.equal(b.clips[0].seconds, 15)
  assert.ok(b.clips[0].covers.startsWith('Clip 1:'))
})

test('chapterBreakdownToBreakdown: a single clip is standalone', () => {
  const b = chapterBreakdownToBreakdown(breakdown([clip({ clip: 1 })]))
  assert.equal(b.clips[0].role, 'standalone')
})

test('rawAskForClipIndex: finds the clip by BreakdownClip.index and formats it', () => {
  const b = breakdown([clip({ clip: 1 }), clip({ clip: 2 })])
  const raw = rawAskForClipIndex(b, 2)
  assert.ok(raw?.startsWith('Clip 2:'))
})

test('rawAskForClipIndex: undefined when the breakdown is absent or the clip is not in it', () => {
  assert.equal(rawAskForClipIndex(undefined, 1), undefined)
  assert.equal(rawAskForClipIndex(breakdown([clip({ clip: 1 })]), 9), undefined)
})
