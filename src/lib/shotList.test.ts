import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Shot, ShotGroup } from './types'
import { dropFromIndex } from './filmEdit'
import {
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  RUNTIME_MAX_SECONDS,
  RUNTIME_MIN_SECONDS,
  RUNTIME_STEP_SECONDS,
  SHOT_LIST_TEMPLATE,
  TARGET_CLIP_SECONDS,
  breakdownClipsFromShotGroups,
  breakdownFromShotList,
  checkRuntimeCeiling,
  clampRuntimeSeconds,
  clipTiming,
  fillShotListTemplate,
  formatRuntime,
  groupShotsIntoClips,
  groupsAffectedByCut,
  parsePartialShotList,
  parseShotList,
  reviseShotsFromIndex,
  rolesForGroupCount,
  shotListResponseFormat,
} from './shotList'

function shots(seconds: number[]): Shot[] {
  return seconds.map((s, i) => ({ index: i + 1, covers: `shot ${i + 1}`, seconds: s }))
}

// ── grouping ────────────────────────────────────────────────────────────

test('groupShotsIntoClips: 3 shots of 5s each pack into one ~15s group', () => {
  const { groups, issues } = groupShotsIntoClips(shots([5, 5, 5]))
  assert.equal(issues.length, 0)
  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].shotIndices, [1, 2, 3])
  assert.equal(groups[0].seconds, 15)
})

test('groupShotsIntoClips: 6 shots of 5s each split into two ~15s groups, not one 30s group', () => {
  const { groups, issues } = groupShotsIntoClips(shots([5, 5, 5, 5, 5, 5]))
  assert.equal(issues.length, 0)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.shotIndices), [
    [1, 2, 3],
    [4, 5, 6],
  ])
  assert.deepEqual(groups.map((g) => g.seconds), [15, 15])
})

test('groupShotsIntoClips: never splits a shot — every original shot index appears in exactly one group, in order', () => {
  const input = shots([3, 4, 2, 6, 5, 1, 7])
  const { groups } = groupShotsIntoClips(input)
  const seen = groups.flatMap((g) => g.shotIndices)
  assert.deepEqual(seen, input.map((s) => s.index))
  for (const g of groups) {
    for (let i = 1; i < g.shotIndices.length; i++) {
      assert.equal(g.shotIndices[i], g.shotIndices[i - 1] + 1, 'group shot indices must be contiguous')
    }
  }
})

test('groupShotsIntoClips: a trailing stub under the floor merges backward rather than standing alone', () => {
  // 3x5s (=15, on target) then a lone 5s shot — 5s alone is under the 5.1667s floor.
  const { groups, issues } = groupShotsIntoClips(shots([5, 5, 5, 5]))
  assert.equal(issues.length, 0)
  // Merged into one 20s group rather than [15][5] with the second under floor.
  assert.equal(groups.length, 1)
  assert.equal(groups[0].seconds, 20)
})

test('groupShotsIntoClips: never produces a group under the floor when merging can avoid it', () => {
  const { groups } = groupShotsIntoClips(shots([6, 6, 6, 6, 6]))
  for (const g of groups) assert.ok(g.seconds >= MIN_CLIP_SECONDS, `group ${g.index} at ${g.seconds}s is under the floor`)
})

test('groupShotsIntoClips: a single shot longer than the ceiling cannot be split, and is reported as an issue', () => {
  const { groups, issues } = groupShotsIntoClips(shots([2, 30]))
  assert.equal(groups.length, 2)
  assert.equal(groups[1].seconds, 30)
  assert.ok(issues.some((i) => i.includes('ceiling')))
})

test('groupShotsIntoClips: an unavoidable trailing floor violation (nothing to merge into) is reported, not silently accepted', () => {
  const { groups, issues } = groupShotsIntoClips(shots([1]))
  assert.equal(groups.length, 1)
  assert.equal(groups[0].seconds, 1)
  assert.ok(issues.some((i) => i.includes('floor')))
})

test('groupShotsIntoClips: empty input produces no groups and no issues', () => {
  const { groups, issues } = groupShotsIntoClips([])
  assert.deepEqual(groups, [])
  assert.deepEqual(issues, [])
})

test('MIN/MAX/TARGET_CLIP_SECONDS match the Studio\'s own measured grid (5.2s floor, 20.0s ceiling)', () => {
  assert.ok(Math.abs(MIN_CLIP_SECONDS - 5.1667) < 0.001)
  assert.ok(Math.abs(MAX_CLIP_SECONDS - 20.0417) < 0.001)
  assert.equal(TARGET_CLIP_SECONDS, 15)
})

// ── runtime ceiling ─────────────────────────────────────────────────────

test('checkRuntimeCeiling: under the ceiling reports withinCeiling with zero overshoot', () => {
  const check = checkRuntimeCeiling(shots([10, 10, 10]), 60)
  assert.equal(check.totalSeconds, 30)
  assert.equal(check.withinCeiling, true)
  assert.equal(check.overBySeconds, 0)
})

test('checkRuntimeCeiling: an overshoot is REPORTED, not thrown', () => {
  assert.doesNotThrow(() => checkRuntimeCeiling(shots([40, 40]), 60))
  const check = checkRuntimeCeiling(shots([40, 40]), 60)
  assert.equal(check.totalSeconds, 80)
  assert.equal(check.withinCeiling, false)
  assert.equal(check.overBySeconds, 20)
})

test('checkRuntimeCeiling: exactly at the ceiling counts as within it', () => {
  const check = checkRuntimeCeiling(shots([30, 30]), 60)
  assert.equal(check.withinCeiling, true)
  assert.equal(check.overBySeconds, 0)
})

// ── revision from a shot index ──────────────────────────────────────────

test('reviseShotsFromIndex: keeps everything before the cut untouched, replaces from the cut on', () => {
  const original = shots([5, 5, 5, 5, 5]) // indices 1..5
  const fresh = [
    { index: 999, covers: 'new thing A', seconds: 8 },
    { index: 999, covers: 'new thing B', seconds: 6 },
  ]
  const result = reviseShotsFromIndex(original, 3, fresh)
  // shots 1,2 kept exactly
  assert.deepEqual(result.slice(0, 2), original.slice(0, 2))
  // fresh shots renumbered starting at the cut index, in order
  assert.deepEqual(
    result.slice(2).map((s) => [s.index, s.covers, s.seconds]),
    [
      [3, 'new thing A', 8],
      [4, 'new thing B', 6],
    ],
  )
})

test('reviseShotsFromIndex: a cut at index 1 discards the whole original list', () => {
  const original = shots([5, 5, 5])
  const fresh = [{ index: 1, covers: 'restart', seconds: 10 }]
  const result = reviseShotsFromIndex(original, 1, fresh)
  assert.deepEqual(result.map((s) => s.covers), ['restart'])
})

test('reviseShotsFromIndex: a cut past the end keeps everything and appends nothing new before it', () => {
  const original = shots([5, 5, 5])
  const result = reviseShotsFromIndex(original, 4, [])
  assert.deepEqual(result, original)
})

// ── invalidation: which rendered clips survive a cut ───────────────────

function makeGroups(sizes: number[][]): ShotGroup[] {
  return sizes.map((shotIndices, i) => ({ index: i + 1, shotIndices, seconds: shotIndices.length * 5 }))
}

test('groupsAffectedByCut: a group entirely before the cut survives untouched', () => {
  const groups = makeGroups([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
  const result = groupsAffectedByCut(groups, 7) // cut lands exactly on group 3's first shot
  assert.deepEqual(result.survivingGroupIndices, [1, 2])
  assert.deepEqual(result.discardedGroupIndices, [3])
  assert.equal(result.fromGroupIndex, 3)
})

test('groupsAffectedByCut: a cut landing INSIDE a rendered clip discards that whole clip, not just the shots after the cut', () => {
  const groups = makeGroups([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
  // cut at shot 5 — strictly inside group 2 (shots 4,5,6). Shot 4 is "before
  // the cut" at the shot-list layer, but group 2's clip must still go.
  const result = groupsAffectedByCut(groups, 5)
  assert.deepEqual(result.survivingGroupIndices, [1])
  assert.deepEqual(result.discardedGroupIndices, [2, 3])
  assert.equal(result.fromGroupIndex, 2)
})

test('groupsAffectedByCut: a cut after every existing group discards nothing', () => {
  const groups = makeGroups([[1, 2, 3], [4, 5, 6]])
  const result = groupsAffectedByCut(groups, 100)
  assert.deepEqual(result.survivingGroupIndices, [1, 2])
  assert.deepEqual(result.discardedGroupIndices, [])
  assert.equal(result.fromGroupIndex, undefined)
})

test('groupsAffectedByCut feeds directly into filmEdit.ts\'s dropFromIndex — no second invalidation mechanism', () => {
  const groups = makeGroups([[1, 2, 3], [4, 5, 6], [7, 8, 9]])
  const cut = groupsAffectedByCut(groups, 5) // straddles group 2
  assert.ok(cut.fromGroupIndex !== undefined)

  const nodeId = 'm_test'
  const clips = [
    { extender: { nodeId, sceneIndex: 1 }, state: 'done' },
    { extender: { nodeId, sceneIndex: 2 }, state: 'done' },
    { extender: { nodeId, sceneIndex: 3 }, state: 'done' },
  ]
  const remaining = dropFromIndex(clips, nodeId, cut.fromGroupIndex!)
  assert.deepEqual(
    remaining.map((c) => c.extender.sceneIndex),
    [1],
  )
})

// ── deriving a Breakdown (coexistence, not replacement) ─────────────────

test('rolesForGroupCount: never assigns "turn" automatically', () => {
  assert.deepEqual(rolesForGroupCount(0), [])
  assert.deepEqual(rolesForGroupCount(1), ['standalone'])
  assert.deepEqual(rolesForGroupCount(2), ['opening', 'closing'])
  assert.deepEqual(rolesForGroupCount(4), ['opening', 'rising', 'rising', 'closing'])
  for (const n of [1, 2, 3, 4, 5, 9]) assert.ok(!rolesForGroupCount(n).includes('turn'))
})

test('breakdownClipsFromShotGroups: joins each group\'s shots into one covers line, carries seconds and index', () => {
  const s = shots([5, 5, 5, 5, 5, 5])
  const { groups } = groupShotsIntoClips(s)
  const clips = breakdownClipsFromShotGroups(s, groups)
  assert.equal(clips.length, 2)
  assert.equal(clips[0].index, 1)
  assert.equal(clips[0].covers, 'shot 1 shot 2 shot 3')
  assert.equal(clips[0].seconds, 15)
  assert.equal(clips[0].role, 'opening')
  assert.equal(clips[1].role, 'closing')
  assert.equal(clips[0].precedes, '')
  assert.equal(clips[0].follows, '')
})

test('breakdownFromShotList: carries the shot list\'s own spine and timestamp', () => {
  const s = shots([5, 5, 5])
  const { groups } = groupShotsIntoClips(s)
  const shotList = { spine: 'a woman finds a key', maxRuntimeSeconds: 60, shots: s, at: 12345 }
  const breakdown = breakdownFromShotList(shotList, groups)
  assert.equal(breakdown.spine, 'a woman finds a key')
  assert.equal(breakdown.at, 12345)
  assert.equal(breakdown.clips.length, 1)
})

// ── asked vs. delivered ──────────────────────────────────────────────────

test('clipTiming: reuses geometry.ts\'s frame grid, and exposes both figures', () => {
  const t = clipTiming(15.2)
  assert.equal(t.askedSeconds, 15.2)
  assert.ok(t.frames > 0)
  assert.notEqual(t.deliveredSeconds, 15.2) // grid-snapped, off the round ask
  assert.ok(Math.abs(t.deliveredSeconds - 15.083) < 0.01)
})

test('clipTiming: a group whose seconds already sit exactly on the grid delivers what was asked', () => {
  const t = clipTiming(124 / 24)
  assert.ok(Math.abs(t.askedSeconds - t.deliveredSeconds) < 0.001)
})

// ── the shots authoring stage: template + schema + parser ──────────────

test('fillShotListTemplate: fills the plot and the ceiling, and the ceiling is stated as a hard constraint', () => {
  const filled = fillShotListTemplate(SHOT_LIST_TEMPLATE, 'a woman finds a key', 45)
  assert.ok(filled.includes('a woman finds a key'))
  assert.ok(filled.includes('45'))
  assert.ok(/hard constraint/i.test(filled))
})

test('SHOT_LIST_TEMPLATE forbids camera, performance and sound language', () => {
  assert.ok(/camera/i.test(SHOT_LIST_TEMPLATE))
  assert.ok(/performance/i.test(SHOT_LIST_TEMPLATE))
  assert.ok(/sound/i.test(SHOT_LIST_TEMPLATE))
})

test('shotListResponseFormat: flat, strict schema requiring spine and a shots array', () => {
  const rf = shotListResponseFormat() as any
  assert.equal(rf.type, 'json_schema')
  assert.equal(rf.json_schema.strict, true)
  assert.deepEqual(rf.json_schema.schema.required, ['spine', 'shots'])
  assert.equal(rf.json_schema.schema.additionalProperties, false)
  const itemSchema = rf.json_schema.schema.properties.shots.items
  assert.deepEqual(itemSchema.required, ['index', 'covers', 'seconds'])
})

test('parseShotList: a clean reply parses into a ShotList carrying the operator\'s ceiling', () => {
  const raw = JSON.stringify({
    spine: 'a woman finds a key',
    shots: [
      { index: 1, covers: 'she enters the room', seconds: 4 },
      { index: 2, covers: 'she sees the key', seconds: 3 },
    ],
  })
  const parsed = parseShotList(raw, 60)
  assert.ok(parsed)
  assert.equal(parsed!.spine, 'a woman finds a key')
  assert.equal(parsed!.maxRuntimeSeconds, 60)
  assert.equal(parsed!.shots.length, 2)
  assert.equal(parsed!.shots[1].covers, 'she sees the key')
})

test('parseShotList: strips a fenced reply', () => {
  const raw = '```json\n' + JSON.stringify({ spine: 's', shots: [{ index: 1, covers: 'x', seconds: 2 }] }) + '\n```'
  const parsed = parseShotList(raw, 30)
  assert.ok(parsed)
  assert.equal(parsed!.shots.length, 1)
})

test('parseShotList: malformed replies return null rather than a half-built plan', () => {
  assert.equal(parseShotList('not json at all', 30), null)
  assert.equal(parseShotList(JSON.stringify({ spine: 's' }), 30), null) // no shots
  assert.equal(parseShotList(JSON.stringify({ shots: [] }), 30), null) // no spine, empty shots
})

// ── parsePartialShotList: reading a shot list still arriving ────────────

const COMPLETE_DOC = JSON.stringify({
  spine: 'a woman finds a key',
  shots: [
    { index: 1, covers: 'she enters the room', seconds: 4 },
    { index: 2, covers: 'she sees the key on the table', seconds: 3 },
    { index: 3, covers: 'she picks it up', seconds: 2 },
  ],
})

test('parsePartialShotList: agrees with parseShotList on a complete document', () => {
  const complete = parseShotList(COMPLETE_DOC, 60)
  const partial = parsePartialShotList(COMPLETE_DOC)
  assert.ok(complete)
  assert.equal(partial.spine, complete!.spine)
  assert.deepEqual(partial.shots, complete!.shots)
})

test('parsePartialShotList: agrees with parseShotList on a complete, fenced document', () => {
  const fenced = '```json\n' + COMPLETE_DOC + '\n```'
  const complete = parseShotList(fenced, 60)
  const partial = parsePartialShotList(fenced)
  assert.ok(complete)
  assert.deepEqual(partial.shots, complete!.shots)
  assert.equal(partial.spine, complete!.spine)
})

test('parsePartialShotList: truncated mid-object shows only the shots that fully closed', () => {
  // Cut partway through shot 3's object — after shot 2 has closed, before shot 3 has.
  const cut = COMPLETE_DOC.indexOf('"she picks')
  const partial = parsePartialShotList(COMPLETE_DOC.slice(0, cut))
  assert.equal(partial.shots.length, 2)
  assert.equal(partial.shots[0].covers, 'she enters the room')
  assert.equal(partial.shots[1].covers, 'she sees the key on the table')
})

test('parsePartialShotList: truncated mid-string (inside an open "covers" value) shows nothing for that shot', () => {
  // Cut inside shot 2's "covers" string, before its closing quote.
  const cut = COMPLETE_DOC.indexOf('sees the key')
  const partial = parsePartialShotList(COMPLETE_DOC.slice(0, cut))
  assert.equal(partial.shots.length, 1)
  assert.equal(partial.shots[0].covers, 'she enters the room')
})

test('parsePartialShotList: truncated right after "shots": [ with nothing closed yet shows an empty list, not a throw', () => {
  const cut = COMPLETE_DOC.indexOf('[', COMPLETE_DOC.indexOf('"shots"')) + 1
  assert.doesNotThrow(() => parsePartialShotList(COMPLETE_DOC.slice(0, cut)))
  const partial = parsePartialShotList(COMPLETE_DOC.slice(0, cut))
  assert.deepEqual(partial.shots, [])
})

test('parsePartialShotList: truncated before "shots" even appears shows the spine alone, or nothing', () => {
  const cut = COMPLETE_DOC.indexOf('"shots"')
  const partial = parsePartialShotList(COMPLETE_DOC.slice(0, cut))
  assert.deepEqual(partial.shots, [])
  assert.equal(partial.spine, 'a woman finds a key')
})

test('parsePartialShotList: truncated mid-spine string returns an empty spine rather than a mangled one', () => {
  const cut = COMPLETE_DOC.indexOf('woman finds')
  const partial = parsePartialShotList(COMPLETE_DOC.slice(0, cut))
  assert.equal(partial.spine, '')
  assert.deepEqual(partial.shots, [])
})

test('parsePartialShotList: an empty string never throws and returns nothing', () => {
  assert.doesNotThrow(() => parsePartialShotList(''))
  assert.deepEqual(parsePartialShotList(''), { spine: '', shots: [] })
})

test('parsePartialShotList: raw garbage never throws', () => {
  for (const garbage of ['not json at all', '{{{{', '"shots": [', '{"shots": [{{{', '  garbled ', '{"spine": "unterminated']) {
    assert.doesNotThrow(() => parsePartialShotList(garbage))
  }
  assert.deepEqual(parsePartialShotList('not json at all'), { spine: '', shots: [] })
})

test('parsePartialShotList: a brace inside a covers string is not mistaken for object structure', () => {
  const doc = JSON.stringify({ spine: 's', shots: [{ index: 1, covers: 'a sign reading "CLOSED {for now}"', seconds: 2 }] })
  const partial = parsePartialShotList(doc)
  assert.equal(partial.shots.length, 1)
  assert.equal(partial.shots[0].covers, 'a sign reading "CLOSED {for now}"')
})

test('parsePartialShotList: shots accumulate one at a time as more of the stream arrives (never shrinks, never jitters)', () => {
  let prevCount = 0
  for (let end = 1; end <= COMPLETE_DOC.length; end++) {
    const { shots } = parsePartialShotList(COMPLETE_DOC.slice(0, end))
    assert.ok(shots.length >= prevCount, `shot count went backward at cut ${end}`)
    prevCount = shots.length
  }
  assert.equal(prevCount, 3)
})

// ── the runtime ceiling's 15s grid ──────────────────────────────────────
// The slider moves in whole clips, so the CEILING lives on the same grid the
// grouping already works in (TARGET_CLIP_SECONDS). An off-grid ceiling is what
// produced near-misses the grouping could never honour.

test('clampRuntimeSeconds snaps to the 15s grid', () => {
  assert.equal(clampRuntimeSeconds(60), 60)
  assert.equal(clampRuntimeSeconds(67), 60)   // nearer 60 than 75
  assert.equal(clampRuntimeSeconds(68), 75)   // and 68 tips the other way
  assert.equal(clampRuntimeSeconds(52), 45)
})

test('clampRuntimeSeconds holds the 15s..10m range at both ends', () => {
  assert.equal(clampRuntimeSeconds(0), RUNTIME_MIN_SECONDS)
  assert.equal(clampRuntimeSeconds(-99), RUNTIME_MIN_SECONDS)
  assert.equal(clampRuntimeSeconds(99999), RUNTIME_MAX_SECONDS)
  assert.equal(RUNTIME_MIN_SECONDS, 15)
  assert.equal(RUNTIME_MAX_SECONDS, 600)
})

test('clampRuntimeSeconds rescues an unusable stored value rather than propagating it', () => {
  // A profile saved before the slider existed can hold anything at all.
  // Anything non-finite is unusable rather than "very large", so it lands on
  // the safe floor -- silently starting a film at a 10-minute ceiling because a
  // stored value was corrupt would be the worse failure.
  assert.equal(clampRuntimeSeconds(Number.NaN), RUNTIME_MIN_SECONDS)
  assert.equal(clampRuntimeSeconds(Number.POSITIVE_INFINITY), RUNTIME_MIN_SECONDS)
})

test('every slider position is a whole number of 15s clips', () => {
  for (let v = RUNTIME_MIN_SECONDS; v <= RUNTIME_MAX_SECONDS; v += RUNTIME_STEP_SECONDS) {
    assert.equal(clampRuntimeSeconds(v), v, `${v}s should already be on the grid`)
    assert.equal(v % TARGET_CLIP_SECONDS, 0, `${v}s should be a whole number of clips`)
  }
})

test('formatRuntime reads as minutes past a minute', () => {
  assert.equal(formatRuntime(15), '15s')
  assert.equal(formatRuntime(45), '45s')
  assert.equal(formatRuntime(60), '1m')
  assert.equal(formatRuntime(150), '2m 30s')
  assert.equal(formatRuntime(600), '10m')
})
