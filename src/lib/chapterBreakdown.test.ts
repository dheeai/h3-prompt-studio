import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAMERA_SHOTS,
  CHAPTER_BREAKDOWN_SHOT_MAX,
  CHAPTER_BREAKDOWN_SHOT_MIN,
  CHAPTER_BREAKDOWN_TEMPLATE,
  chapterBreakdownResponseFormat,
  chapterBreakdownRuntimeInstruction,
  chapterBreakdownToBreakdown,
  chapterBreakdownToShotList,
  checkChapterBreakdown,
  checkClipCount,
  checkRawAsksDistinct,
  fillChapterBreakdownTemplate,
  foldLedger,
  formatClipRawAsk,
  formatShotLine,
  formatStateBlocks,
  parseChapterBreakdown,
  rawAskForClipIndex,
} from './chapterBreakdown'
import type { ChapterBreakdown, ChapterBreakdownClip, ChapterBreakdownShot, Ledger, LedgerEntity } from './chapterBreakdown'

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
    stateChanges: [],
    ...partial,
  }
}

const EMPTY_LEDGER: Ledger = { entities: [] }

function breakdown(clips: ChapterBreakdownClip[], ledger: Ledger = EMPTY_LEDGER): ChapterBreakdown {
  return { chapter: 'The switched cloth', ledger, clips, at: 12345 }
}

function entity(partial: Partial<LedgerEntity>): LedgerEntity {
  return {
    id: 'nusrat',
    name: 'Nusrat',
    kind: 'character',
    clipIds: [1, 2, 3],
    axes: [{ axis: 'composure', options: ['composed', 'shaken'], progressive: false, plateVisible: false }],
    initial: [{ axis: 'composure', value: 'composed' }],
    ...partial,
  }
}

// ── template ───────────────────────────────────────────────────────────────

test('fillChapterBreakdownTemplate: fills the one placeholder, trims the chapter', () => {
  const filled = fillChapterBreakdownTemplate('before {{chapter}} after', '  a story  ')
  assert.equal(filled, 'before a story after')
})

test('CHAPTER_BREAKDOWN_TEMPLATE: names every camera term verbatim', () => {
  for (const c of CAMERA_SHOTS) assert.ok(CHAPTER_BREAKDOWN_TEMPLATE.includes(c), `missing ${c}`)
})

// ── runtime modes: Auto vs Target ─────────────────────────────────────────

test('chapterBreakdownRuntimeInstruction: auto mode leaves clip count to the model, one clip per beat', () => {
  const text = chapterBreakdownRuntimeInstruction('auto')
  assert.match(text, /AUTO/)
  assert.match(text, /one clip per distinct dramatic beat/)
  assert.match(text, /Do not compress/)
  assert.match(text, /do not pad/)
})

test('chapterBreakdownRuntimeInstruction: target mode demands EXACTLY N, reached by finer/coarser grain — never invented events', () => {
  const text = chapterBreakdownRuntimeInstruction('target', 4)
  assert.match(text, /EXACTLY 4 clips/)
  assert.match(text, /60s total/)
  assert.match(text, /finer or coarser grain/)
  assert.match(text, /never by inventing events/)
})

test('chapterBreakdownRuntimeInstruction: target mode with exactly 1 clip uses singular phrasing', () => {
  assert.match(chapterBreakdownRuntimeInstruction('target', 1), /EXACTLY 1 clip /)
})

test('chapterBreakdownRuntimeInstruction: target mode with no/zero targetClips falls back to auto wording', () => {
  assert.match(chapterBreakdownRuntimeInstruction('target', undefined), /AUTO/)
  assert.match(chapterBreakdownRuntimeInstruction('target', 0), /AUTO/)
})

test('fillChapterBreakdownTemplate: fills BOTH placeholders — chapter and the mode-specific runtime instruction', () => {
  const filled = fillChapterBreakdownTemplate(CHAPTER_BREAKDOWN_TEMPLATE, 'a story', 'target', 4)
  assert.match(filled, /EXACTLY 4 clips/)
  assert.match(filled, /a story/)
  assert.ok(!filled.includes('{{runtimeInstruction}}'))
  assert.ok(!filled.includes('{{chapter}}'))
})

test('fillChapterBreakdownTemplate: defaults to auto mode when no mode is given, unchanged from before runtime modes existed', () => {
  const filled = fillChapterBreakdownTemplate(CHAPTER_BREAKDOWN_TEMPLATE, 'a story')
  assert.match(filled, /RUNTIME — AUTO/)
})

test('checkClipCount: auto mode never complains, regardless of clip count', () => {
  assert.deepEqual(checkClipCount(breakdown([clip({ clip: 1 })]), 'auto', 4), [])
})

test('checkClipCount: target mode with a matching clip count has no complaint', () => {
  assert.deepEqual(checkClipCount(breakdown([clip({ clip: 1 }), clip({ clip: 2 })]), 'target', 2), [])
})

test('checkClipCount: target mode with a mismatched clip count complains with the actual and target counts', () => {
  const issues = checkClipCount(breakdown([clip({ clip: 1 })]), 'target', 3)
  assert.equal(issues.length, 1)
  assert.match(issues[0], /came back as 1 clip/)
  assert.match(issues[0], /target is EXACTLY 3/)
})

test('checkClipCount: target mode with no targetClips given never complains (nothing to check against)', () => {
  assert.deepEqual(checkClipCount(breakdown([clip({ clip: 1 })]), 'target', undefined), [])
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

test('formatShotLine: a subject that is a SCENE (not a grammatical subject of action) and an action that is its OWN sentence get a period between them, not a run-on', () => {
  // Bug seen live: "Nusrat's tailoring shop in the Surat cloth market The
  // shop is visible: …" — no seam at all between the two. `action` here
  // opens capitalised ("The shop..."), which is the signal this is a
  // separate sentence, not a continuing predicate.
  const line = formatShotLine(shot({
    shot: 1, seconds: 4, camera: 'wide_establishing',
    subject: "Nusrat's tailoring shop in the Surat cloth market",
    action: 'The shop is visible: bolts of cloth on every shelf',
  }))
  assert.equal(line, "Shot 1 – Wide as Nusrat's tailoring shop in the Surat cloth market. The shop is visible: bolts of cloth on every shelf. (4s)")
})

test('formatShotLine: a subject already ending in punctuation never gets a doubled period before a new-sentence action', () => {
  const line = formatShotLine(shot({
    shot: 1, seconds: 4, camera: 'wide_establishing',
    subject: 'The tailoring shop.',
    action: 'Farid stands in the doorway.',
  }))
  assert.equal(line, 'Shot 1 – Wide as The tailoring shop. Farid stands in the doorway. (4s)')
})

test('formatShotLine: only a subject, or only an action, is used bare — no stray punctuation invented', () => {
  assert.equal(formatShotLine(shot({ shot: 1, seconds: 4, camera: 'medium', subject: '', action: 'the door creaks open' })), 'Shot 1 – Medium as the door creaks open. (4s)')
  assert.equal(formatShotLine(shot({ shot: 1, seconds: 4, camera: 'medium', subject: 'A locked door', action: '' })), 'Shot 1 – Medium as A locked door. (4s)')
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

// ── the state ledger — schema, parser, checks, fold, format ─────────────

test('chapterBreakdownResponseFormat: ledger comes BEFORE clips in required[] and properties, matching h3_chapter\'s schema order', () => {
  const fmt = chapterBreakdownResponseFormat() as any
  const schema = fmt.json_schema.schema
  assert.deepEqual(schema.required, ['chapter', 'ledger', 'clips'])
  assert.deepEqual(Object.keys(schema.properties), ['chapter', 'ledger', 'clips'])
  const entity = schema.properties.ledger.properties.entities.items
  assert.deepEqual(entity.required, ['id', 'name', 'kind', 'clip_ids', 'axes', 'initial'])
  const axis = entity.properties.axes.items
  assert.deepEqual(axis.required, ['axis', 'options', 'progressive', 'plate_visible'])
  const change = schema.properties.clips.items.properties.state_changes.items
  assert.deepEqual(change.required, ['entity', 'axis', 'to', 'shot'])
  assert.ok(schema.properties.clips.items.required.includes('state_changes'))
})

function ledgerReply(entities: unknown[]) {
  return { entities }
}

test('parseChapterBreakdown: round-trips a ledger with axes and initial values', () => {
  const raw = JSON.stringify({
    chapter: 'c',
    ledger: ledgerReply([
      {
        id: 'nusrat', name: 'Nusrat', kind: 'character', clip_ids: [1, 2],
        axes: [{ axis: 'composure', options: ['composed', 'shaken'], progressive: false, plate_visible: false }],
        initial: [{ axis: 'composure', value: 'composed' }],
      },
    ]),
    clips: [{ clip: 1, beat: 'b', forward_pull: 'f', state_changes: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 2 }], shots: [{ shot: 1, seconds: 5, camera: 'medium', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }, { shot: 2, seconds: 5, camera: 'close_up', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }, { shot: 3, seconds: 5, camera: 'wide_establishing', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }] }],
  })
  const parsed = parseChapterBreakdown(raw)
  assert.ok(parsed)
  assert.equal(parsed!.ledger.entities.length, 1)
  const e = parsed!.ledger.entities[0]
  assert.equal(e.id, 'nusrat')
  assert.equal(e.kind, 'character')
  assert.deepEqual(e.clipIds, [1, 2])
  assert.equal(e.axes[0].plateVisible, false)
  assert.deepEqual(e.initial, [{ axis: 'composure', value: 'composed' }])
  assert.deepEqual(parsed!.clips[0].stateChanges, [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 2 }])
})

test('parseChapterBreakdown: a missing/malformed ledger defaults to entities: [] rather than failing the whole parse', () => {
  const raw = JSON.stringify({ chapter: 'c', clips: [{ clip: 1, beat: 'b', forward_pull: '', shots: [{ shot: 1, seconds: 5, camera: 'medium', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }, { shot: 2, seconds: 5, camera: 'close_up', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }, { shot: 3, seconds: 5, camera: 'wide_establishing', subject: 's', action: 'a', has_dialogue: false, dialogue_speaker: '', dialogue_line: '' }] }] })
  const parsed = parseChapterBreakdown(raw)
  assert.deepEqual(parsed!.ledger, { entities: [] })
  assert.deepEqual(parsed!.clips[0].stateChanges, [])
})

test('checkChapterBreakdown: flags a state_changes entry citing an unknown entity', () => {
  const c = clip({ stateChanges: [{ entity: 'ghost', axis: 'composure', to: 'shaken', shot: 1 }] })
  const issues = checkChapterBreakdown(breakdown([c], { entities: [entity({})] }))
  assert.ok(issues.some((i) => i.includes("cites entity 'ghost'")))
})

test('checkChapterBreakdown: flags a state_changes entry citing an axis the entity never declared', () => {
  const c = clip({ stateChanges: [{ entity: 'nusrat', axis: 'wardrobe', to: 'torn', shot: 1 }] })
  const issues = checkChapterBreakdown(breakdown([c], { entities: [entity({})] }))
  assert.ok(issues.some((i) => i.includes("no axis 'wardrobe'")))
})

test('checkChapterBreakdown: flags a state_changes value not in the axis\'s own declared options', () => {
  const c = clip({ stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'ecstatic', shot: 1 }] })
  const issues = checkChapterBreakdown(breakdown([c], { entities: [entity({})] }))
  assert.ok(issues.some((i) => i.includes("not one of nusrat.composure's declared options")))
})

test('checkChapterBreakdown: flags a state_changes shot that is not one of this clip\'s own shots', () => {
  const c = clip({ stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 99 }] })
  const issues = checkChapterBreakdown(breakdown([c], { entities: [entity({})] }))
  assert.ok(issues.some((i) => i.includes('cites shot 99')))
})

test('checkChapterBreakdown: a well-formed state_changes entry raises no issue', () => {
  const c = clip({ stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 2 }] })
  const issues = checkChapterBreakdown(breakdown([c], { entities: [entity({})] }))
  assert.deepEqual(issues, [])
})

test('checkChapterBreakdown: a progressive axis moving backwards across clips is flagged', () => {
  const progressiveEntity = entity({ axes: [{ axis: 'condition', options: ['fine', 'hurt', 'unconscious'], progressive: true, plateVisible: false }], initial: [{ axis: 'condition', value: 'fine' }] })
  const c1 = clip({ clip: 1, stateChanges: [{ entity: 'nusrat', axis: 'condition', to: 'unconscious', shot: 1 }] })
  const c2 = clip({ clip: 2, stateChanges: [{ entity: 'nusrat', axis: 'condition', to: 'hurt', shot: 1 }] })
  const issues = checkChapterBreakdown(breakdown([c1, c2], { entities: [progressiveEntity] }))
  assert.ok(issues.some((i) => i.includes('moves backwards at clip 2')))
})

test('checkChapterBreakdown: a NON-progressive axis is free to move back and forth with no complaint', () => {
  const flexEntity = entity({ axes: [{ axis: 'posture', options: ['standing', 'sitting'], progressive: false, plateVisible: false }], initial: [{ axis: 'posture', value: 'standing' }] })
  const c1 = clip({ clip: 1, stateChanges: [{ entity: 'nusrat', axis: 'posture', to: 'sitting', shot: 1 }] })
  const c2 = clip({ clip: 2, stateChanges: [{ entity: 'nusrat', axis: 'posture', to: 'standing', shot: 1 }] })
  const issues = checkChapterBreakdown(breakdown([c1, c2], { entities: [flexEntity] }))
  assert.deepEqual(issues, [])
})

test('checkRawAsksDistinct: two different clips never collide', () => {
  const issues = checkRawAsksDistinct(breakdown([clip({ clip: 1 }), clip({ clip: 2 })]))
  assert.deepEqual(issues, [])
})

test('checkRawAsksDistinct: two clip entries claiming the SAME clip number collide — a real bug class (duplicate clip numbers from the model)', () => {
  // formatClipRawAsk bakes the clip's OWN `.clip` field into its "Clip N:"
  // header, so two DIFFERENT clip numbers can never format identically —
  // the Studio's per-clip lookup (keyed on `.clip`, never a shared walker
  // cache) is structurally safer than the bundle's original bug. What CAN
  // still collide here is two entries that both claim the SAME clip number
  // (a duplicate the model shouldn't have written) — rawAskForClipIndex's
  // `.find()` then returns the SAME formatted text for both positions.
  const c1 = clip({ clip: 1 })
  const c2 = clip({ clip: 1 })
  const issues = checkRawAsksDistinct(breakdown([c1, c2]))
  assert.ok(issues.some((i) => i.includes("clip 1's raw ask is byte-identical to clip 1's")))
})

test('checkChapterBreakdown folds checkRawAsksDistinct\'s own issues in too', () => {
  const c1 = clip({ clip: 1 })
  const c2 = clip({ clip: 1 })
  const issues = checkChapterBreakdown(breakdown([c1, c2]))
  assert.ok(issues.some((i) => i.includes('byte-identical')))
})

test('foldLedger: an entity\'s state as of clip N is initial + every PRIOR clip\'s changes, never this clip\'s own', () => {
  const ledger: Ledger = { entities: [entity({})] }
  const clips = [
    { clip: 1, stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 1 }] },
    { clip: 2, stateChanges: [] },
  ]
  const byClip = foldLedger(ledger, clips)
  assert.equal(byClip.get(1)!.get('nusrat')!.get('composure'), 'composed') // start of clip 1 = initial
  assert.equal(byClip.get(2)!.get('nusrat')!.get('composure'), 'shaken') // start of clip 2 = after clip 1's change
})

test('foldLedger: clips out of array order are folded in CLIP-NUMBER order, not array order', () => {
  const ledger: Ledger = { entities: [entity({})] }
  const clips = [
    { clip: 2, stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 1 }] },
    { clip: 1, stateChanges: [] },
  ]
  const byClip = foldLedger(ledger, clips)
  assert.equal(byClip.get(1)!.get('nusrat')!.get('composure'), 'composed')
  assert.equal(byClip.get(2)!.get('nusrat')!.get('composure'), 'composed') // clip 1 (folded first) made no change
})

test('formatStateBlocks: an on-screen entity shows ALL its axes unconditionally, even at the untouched initial value (2026-09-25 supersession)', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [1, 2] })] }
  const startState = new Map([['nusrat', new Map([['composure', 'composed']])]])
  const text = formatStateBlocks(ledger, startState, [], 1)
  // At initial value, nothing changing this clip — STILL shown, because the
  // writer cannot see the ledger and a permanent non-default state (e.g. a
  // soaked garment never marked "changed") must not be silently dropped.
  assert.equal(text, 'STATE AT THE START OF THIS CLIP:\nNusrat (character): composure=composed')
})

test('formatStateBlocks: an on-screen entity with NO declared axes contributes no start-state line', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [1], axes: [], initial: [] })] }
  const text = formatStateBlocks(ledger, new Map(), [], 1)
  assert.equal(text, '')
})

test('formatStateBlocks: STATE AT THE START block shows a value that has drifted from initial', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [2] })] }
  const startState = new Map([['nusrat', new Map([['composure', 'shaken']])]])
  const text = formatStateBlocks(ledger, startState, [], 2)
  assert.ok(text.startsWith('STATE AT THE START OF THIS CLIP:'))
  assert.ok(text.includes('Nusrat (character): composure=shaken'))
})

test('formatStateBlocks: CHANGES DURING block lists this clip\'s own changes, entity name + arrow + shot', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [1] })] }
  const startState = new Map([['nusrat', new Map([['composure', 'composed']])]])
  const changes = [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 2 }]
  const text = formatStateBlocks(ledger, startState, changes, 1)
  assert.ok(text.includes('CHANGES DURING THIS CLIP:'))
  assert.ok(text.includes('Nusrat.composure -> shaken (shot 2)'))
})

test('formatStateBlocks: an entity not on screen this clip contributes nothing', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [5] })] }
  const startState = new Map([['nusrat', new Map([['composure', 'shaken']])]])
  assert.equal(formatStateBlocks(ledger, startState, [], 1), '')
})

test('rawAskForClipIndex: state blocks are prepended before the "Clip N:" raw ask, separated by a blank line', () => {
  const ledger: Ledger = { entities: [entity({ clipIds: [1] })] }
  const c = clip({ clip: 1, stateChanges: [{ entity: 'nusrat', axis: 'composure', to: 'shaken', shot: 2 }] })
  const raw = rawAskForClipIndex(breakdown([c], ledger), 1)
  assert.ok(raw!.startsWith('STATE AT THE START OF THIS CLIP:'))
  assert.ok(raw!.includes('CHANGES DURING THIS CLIP:'))
  assert.ok(raw!.includes('\n\nClip 1:'))
})

test('rawAskForClipIndex: a breakdown with an empty ledger is byte-identical to formatClipRawAsk alone', () => {
  const c = clip({})
  assert.equal(rawAskForClipIndex(breakdown([c]), 1), formatClipRawAsk(c))
})
