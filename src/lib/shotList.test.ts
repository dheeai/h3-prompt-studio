import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AllocatedBeat, Beat, Shot, ShotGroup } from './types'
import { dropFromIndex } from './filmEdit'
import {
  BEAT_LIST_TEMPLATE,
  MAX_CLIP_SECONDS,
  MIN_CLIP_SECONDS,
  RUNTIME_MAX_SECONDS,
  RUNTIME_MIN_SECONDS,
  RUNTIME_STEP_SECONDS,
  SHOT_SUBDIVIDE_TEMPLATE,
  TARGET_CLIP_SECONDS,
  allocateBeatSeconds,
  beatListResponseFormat,
  breakdownClipsFromShotGroups,
  breakdownFromShotList,
  checkRuntimeCeiling,
  checkThinBrief,
  clampRuntimeSeconds,
  clipTiming,
  fillBeatListTemplate,
  fillShotSubdivideTemplate,
  formatRuntime,
  groupShotsIntoClips,
  groupsAffectedByCut,
  parseBeatList,
  parsePartialShotList,
  parseSubdividedShots,
  planShotRevision,
  planSubdivisionWindows,
  reviseShotsFromIndex,
  rolesForGroupCount,
  shotSubdivideResponseFormat,
  subdivideAllBeats,
  subdivideBeat,
} from './shotList'
import type { ShotSubdivideCall, SubdivideCallContext } from './shotList'

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

// ── PASS 1 — the beats stage: template + schema + parser ───────────────

test('fillBeatListTemplate: fills the plot, and never asks for a target runtime figure', () => {
  const filled = fillBeatListTemplate(BEAT_LIST_TEMPLATE, 'a woman finds a key')
  assert.ok(filled.includes('a woman finds a key'))
  // "30 seconds or 30 minutes" is deliberately IN the template, as an
  // illustration that beat count doesn't depend on runtime -- what must
  // never appear is an actual runtime figure to hit, i.e. no unfilled
  // template placeholder and no "MAXIMUM RUNTIME" instruction (the old
  // SHOT_LIST_TEMPLATE's hard-constraint line this rework removes).
  assert.ok(!filled.includes('{{'))
  assert.ok(!/maximum runtime/i.test(filled))
})

test('BEAT_LIST_TEMPLATE forbids camera, performance and sound language, and says beat count follows the story', () => {
  assert.ok(/camera/i.test(BEAT_LIST_TEMPLATE))
  assert.ok(/performance/i.test(BEAT_LIST_TEMPLATE))
  assert.ok(/sound/i.test(BEAT_LIST_TEMPLATE))
  assert.ok(/follows the\s+story/i.test(BEAT_LIST_TEMPLATE))
})

test('beatListResponseFormat: flat, strict schema requiring spine and a beats array', () => {
  const rf = beatListResponseFormat() as any
  assert.equal(rf.type, 'json_schema')
  assert.equal(rf.json_schema.strict, true)
  assert.deepEqual(rf.json_schema.schema.required, ['spine', 'beats'])
  assert.equal(rf.json_schema.schema.additionalProperties, false)
  const itemSchema = rf.json_schema.schema.properties.beats.items
  assert.deepEqual(itemSchema.required, ['index', 'covers', 'weight'])
})

test('parseBeatList: a clean reply parses into a BeatList', () => {
  const raw = JSON.stringify({
    spine: 'a woman finds a key',
    beats: [
      { index: 1, covers: 'she searches the house', weight: 2 },
      { index: 2, covers: 'she finds the key', weight: 1 },
    ],
  })
  const parsed = parseBeatList(raw)
  assert.ok(parsed)
  assert.equal(parsed!.spine, 'a woman finds a key')
  assert.equal(parsed!.beats.length, 2)
  assert.equal(parsed!.beats[1].covers, 'she finds the key')
  assert.equal(parsed!.beats[0].weight, 2)
})

test('parseBeatList: strips a fenced reply', () => {
  const raw = '```json\n' + JSON.stringify({ spine: 's', beats: [{ index: 1, covers: 'x', weight: 1 }] }) + '\n```'
  const parsed = parseBeatList(raw)
  assert.ok(parsed)
  assert.equal(parsed!.beats.length, 1)
})

test('parseBeatList: malformed replies return null rather than a half-built plan', () => {
  assert.equal(parseBeatList('not json at all'), null)
  assert.equal(parseBeatList(JSON.stringify({ spine: 's' })), null) // no beats
  assert.equal(parseBeatList(JSON.stringify({ beats: [] })), null) // no spine, empty beats
})

// ── allocation: distributing the runtime across beats ───────────────────

function beats(weights: number[]): Beat[] {
  return weights.map((w, i) => ({ index: i + 1, covers: `beat ${i + 1}`, weight: w }))
}

for (const runtime of [15, 60, 300, 600]) {
  test(`allocateBeatSeconds: sums EXACTLY to ${runtime}s with 1 beat`, () => {
    const allocated = allocateBeatSeconds(beats([1]), runtime)
    assert.equal(allocated.length, 1)
    assert.equal(allocated[0].seconds, runtime)
  })

  test(`allocateBeatSeconds: sums EXACTLY to ${runtime}s with 12 beats of uneven weight`, () => {
    const w = [3, 1, 2, 1, 1, 4, 1, 2, 1, 1, 2, 1]
    const allocated = allocateBeatSeconds(beats(w), runtime)
    assert.equal(allocated.length, 12)
    const total = allocated.reduce((sum, b) => sum + b.seconds, 0)
    assert.ok(Math.abs(total - runtime) < 1e-9, `${total} !== ${runtime}`)
  })
}

test('allocateBeatSeconds: deterministic — same input, same output, across repeated calls', () => {
  const b = beats([3, 1, 2, 5, 1, 1, 2])
  const a = allocateBeatSeconds(b, 187) // an off-grid runtime on purpose
  const c = allocateBeatSeconds(b, 187)
  assert.deepEqual(a, c)
})

test('allocateBeatSeconds: every beat clears BEAT_FLOOR_SECONDS across the slider\'s own range (1-12 beats, 15-600s)', () => {
  for (const runtime of [15, 60, 300, 600]) {
    for (const n of [1, 4, 8, 12]) {
      const allocated = allocateBeatSeconds(beats(Array(n).fill(1)), runtime)
      for (const b of allocated) {
        assert.ok(b.seconds >= 1 - 1e-9, `beat ${b.index} at ${b.seconds}s under the floor (n=${n}, runtime=${runtime})`)
      }
    }
  }
})

test('allocateBeatSeconds: a zero-weight beat still clears the floor, just gets none of the proportional remainder', () => {
  const allocated = allocateBeatSeconds(beats([10, 0]), 60)
  assert.ok(allocated[1].seconds >= 1)
  assert.ok(allocated[0].seconds > allocated[1].seconds)
})

test('allocateBeatSeconds: proportional to weight — a beat twice the weight gets roughly twice the seconds', () => {
  const allocated = allocateBeatSeconds(beats([1, 2]), 90)
  // Both clear the 1s floor with room to spare, so the 2:1 weight ratio
  // should show up almost exactly in the split (30 / 60).
  assert.ok(Math.abs(allocated[1].seconds / allocated[0].seconds - 2) < 0.05)
})

test('allocateBeatSeconds: degenerate case (floors alone exceed the ceiling) still sums exactly, never negative', () => {
  // 20 beats * BEAT_FLOOR_SECONDS(1) = 20s > a 15s ceiling.
  const allocated = allocateBeatSeconds(beats(Array(20).fill(1)), 15)
  const total = allocated.reduce((sum, b) => sum + b.seconds, 0)
  assert.ok(Math.abs(total - 15) < 1e-9)
  for (const b of allocated) assert.ok(b.seconds >= 0)
})

test('allocateBeatSeconds: empty beats list allocates nothing', () => {
  assert.deepEqual(allocateBeatSeconds([], 60), [])
})

test('the beat count does not scale with runtime — only the allocated SECONDS per beat do', () => {
  const b = beats([1, 1, 1, 1, 1, 1, 1, 1])
  const short = allocateBeatSeconds(b, 60)
  const long = allocateBeatSeconds(b, 600)
  assert.equal(short.length, 8)
  assert.equal(long.length, 8) // same 8 beats -- the story didn't get more movements
  // But each beat's own seconds scaled up 10x along with the runtime.
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(long[i].seconds / short[i].seconds - 10) < 0.01)
  }
})

// ── the honest limit: a thin brief padded out to a long runtime ─────────

test('checkThinBrief: a full runtime for the beat count is not thin', () => {
  const check = checkThinBrief(beats([1, 1, 1, 1, 1, 1]), 60)
  assert.equal(check.isThin, false)
})

test('checkThinBrief: a few beats asked to fill a much longer runtime IS thin', () => {
  // 3 beats naturally fill ~60s (NATURAL_SECONDS_PER_BEAT * 3); asking for
  // 600s is 10x that -- comfortably past PADDING_FACTOR.
  const check = checkThinBrief(beats([1, 1, 1]), 600)
  assert.equal(check.isThin, true)
})

// ── PASS 2 — the subdivide stage: template + schema + parser ───────────

test('fillShotSubdivideTemplate: fills every field, and the target is stated in both directions', () => {
  const filled = fillShotSubdivideTemplate(SHOT_SUBDIVIDE_TEMPLATE, {
    spine: 'a woman finds a key',
    beatCovers: 'she searches the house',
    targetSeconds: 12,
    minShotSeconds: 2,
    maxShotSeconds: 20,
    startIndex: 5,
    already: '',
  })
  assert.ok(filled.includes('a woman finds a key'))
  assert.ok(filled.includes('she searches the house'))
  assert.ok(filled.includes('12 SECONDS'))
  assert.ok(/between 2 and\s+20/.test(filled))
  assert.ok(filled.includes('starting at 5'))
  assert.ok(/in either direction/i.test(filled))
})

test('SHOT_SUBDIVIDE_TEMPLATE forbids camera, performance and sound language, and bans inventing new events', () => {
  assert.ok(/camera/i.test(SHOT_SUBDIVIDE_TEMPLATE))
  assert.ok(/performance/i.test(SHOT_SUBDIVIDE_TEMPLATE))
  assert.ok(/sound/i.test(SHOT_SUBDIVIDE_TEMPLATE))
  assert.ok(/never by\s*\n?inventing events/i.test(SHOT_SUBDIVIDE_TEMPLATE.replace(/\s+/g, ' ')))
})

test('shotSubdivideResponseFormat: flat, strict schema requiring only a shots array (no spine)', () => {
  const rf = shotSubdivideResponseFormat() as any
  assert.equal(rf.type, 'json_schema')
  assert.equal(rf.json_schema.strict, true)
  assert.deepEqual(rf.json_schema.schema.required, ['shots'])
  assert.ok(!('spine' in rf.json_schema.schema.properties))
})

test('parseSubdividedShots: a clean reply parses into a bare shots array', () => {
  const raw = JSON.stringify({ shots: [{ index: 5, covers: 'she opens the drawer', seconds: 3 }] })
  const parsed = parseSubdividedShots(raw)
  assert.ok(parsed)
  assert.equal(parsed!.length, 1)
  assert.equal(parsed![0].covers, 'she opens the drawer')
})

test('parseSubdividedShots: malformed replies return null', () => {
  assert.equal(parseSubdividedShots('not json'), null)
  assert.equal(parseSubdividedShots(JSON.stringify({ shots: [] })), null)
})

// ── windowing: keeping any one subdivide call bounded ───────────────────

test('planSubdivisionWindows: a small budget needs only one window', () => {
  const windows = planSubdivisionWindows(20, { minShotSeconds: 2, capShots: 14 })
  assert.equal(windows.length, 1)
  assert.equal(windows[0], 20)
})

test('planSubdivisionWindows: a beat with a large budget splits into multiple bounded windows, never one oversized ask', () => {
  // Worst case (every shot at the 2s floor) a 400s budget would need 200
  // shots -- way past the 14-shot cap, so this must split.
  const windows = planSubdivisionWindows(400, { minShotSeconds: 2, capShots: 14 })
  assert.ok(windows.length > 1, 'a 400s budget must not be asked for in one window')
  for (const w of windows) assert.ok(w <= 14 * 2 + 1e-9, `window of ${w}s could need more than 14 shots at the floor`)
})

test('planSubdivisionWindows: sums EXACTLY to the total, and windows are balanced rather than "N-1 full plus a stub"', () => {
  const windows = planSubdivisionWindows(100, { minShotSeconds: 2, capShots: 14 }) // needs 4 windows (100/28 -> ceil 4)
  const total = windows.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(total - 100) < 1e-9)
  assert.ok(Math.max(...windows) - Math.min(...windows) <= 0.1, 'windows should be nearly equal, not lopsided')
})

test('planSubdivisionWindows: a zero or negative budget produces no windows', () => {
  assert.deepEqual(planSubdivisionWindows(0), [])
  assert.deepEqual(planSubdivisionWindows(-5), [])
})

// ── subdivideBeat / subdivideAllBeats: the windowed, injected-call orchestration ─

/** A fake `ShotSubdivideCall` that authors shots at a fixed length, filling
 * whatever `targetSeconds` the template asked for — deterministic, and lets
 * a test compute the exact expected shot count without a real model. */
function fakeCallAtFixedShotLength(shotSeconds: number): { call: ShotSubdivideCall; calls: SubdivideCallContext[] } {
  const calls: SubdivideCallContext[] = []
  const call: ShotSubdivideCall = async (user, ctx) => {
    calls.push(ctx)
    const m = user.match(/MUST SUM TO ([\d.]+) SECONDS/)
    const target = m ? Number(m[1]) : 0
    const startMatch = user.match(/starting at (\d+)/)
    const startIndex = startMatch ? Number(startMatch[1]) : 1
    const n = Math.max(1, Math.round(target / shotSeconds))
    const shots = Array.from({ length: n }, (_, i) => ({ index: startIndex + i, covers: `shot ${startIndex + i}`, seconds: target / n }))
    return JSON.stringify({ shots })
  }
  return { call, calls }
}

test('subdivideBeat: a beat with a large budget makes multiple bounded calls, never one oversized ask', () => {
  return (async () => {
    const { call, calls } = fakeCallAtFixedShotLength(3)
    const beat: AllocatedBeat = { index: 1, covers: 'a long chase', weight: 1, seconds: 400 }
    const shots = await subdivideBeat(beat, 1, 'the spine', call, { minShotSeconds: 2, capShots: 14 })
    assert.ok(calls.length > 1, 'a 400s beat must not be authored in a single call')
    const total = shots.reduce((sum, s) => sum + s.seconds, 0)
    assert.ok(Math.abs(total - 400) < 1e-6)
  })()
})

test('subdivideBeat: renumbers contiguously from startIndex regardless of what the model echoed', () => {
  return (async () => {
    const call: ShotSubdivideCall = async () =>
      JSON.stringify({ shots: [{ index: 999, covers: 'a', seconds: 5 }, { index: 2, covers: 'b', seconds: 5 }] })
    const beat: AllocatedBeat = { index: 3, covers: 'x', weight: 1, seconds: 10 }
    const shots = await subdivideBeat(beat, 41, 'spine', call)
    assert.deepEqual(shots.map((s) => s.index), [41, 42])
    assert.ok(shots.every((s) => s.beatIndex === 3))
  })()
})

test('subdivideBeat: stamps every shot with the beat\'s own index', () => {
  return (async () => {
    const { call } = fakeCallAtFixedShotLength(4)
    const beat: AllocatedBeat = { index: 7, covers: 'x', weight: 1, seconds: 12 }
    const shots = await subdivideBeat(beat, 1, 'spine', call)
    assert.ok(shots.length > 0)
    assert.ok(shots.every((s) => s.beatIndex === 7))
  })()
})

test('subdivideAllBeats: the same beats at 60s vs 600s yield roughly 10x the shots (SHOT count scales with runtime, beat count does not)', () => {
  return (async () => {
    const b = beats([1, 1, 1, 1, 1, 1, 1, 1])
    const allocatedShort = allocateBeatSeconds(b, 60)
    const allocatedLong = allocateBeatSeconds(b, 600)

    const { call: callShort } = fakeCallAtFixedShotLength(3)
    const { call: callLong } = fakeCallAtFixedShotLength(3)
    const shotsShort = await subdivideAllBeats(allocatedShort, 'spine', callShort)
    const shotsLong = await subdivideAllBeats(allocatedLong, 'spine', callLong)

    assert.equal(allocatedShort.length, allocatedLong.length) // beat count unchanged
    const ratio = shotsLong.length / shotsShort.length
    // "Roughly" 10x, not exactly: at 600s each beat's budget crosses
    // planSubdivisionWindows' per-window cap and gets split into several
    // windows, and the fake call rounds a shot count separately PER window,
    // so some quantization error versus the ideal linear 10x is expected
    // (and would be with a real model too) -- the property under test is
    // "scales substantially with runtime", not "scales with zero rounding
    // error", so the band is wide (6x-14x) rather than tight around 10.
    assert.ok(ratio > 6 && ratio < 14, `expected roughly 10x the shots, got ${ratio}x (${shotsShort.length} -> ${shotsLong.length})`)
  })()
})

test('subdivideAllBeats: assembly renumbers contiguously from 1 across every beat, regardless of what the model echoed', () => {
  return (async () => {
    const call: ShotSubdivideCall = async (_user, ctx) =>
      JSON.stringify({ shots: [{ index: 1, covers: `beat ${ctx.beat.index} shot`, seconds: ctx.beat.seconds }] })
    const b: AllocatedBeat[] = [
      { index: 1, covers: 'a', weight: 1, seconds: 5 },
      { index: 2, covers: 'b', weight: 1, seconds: 5 },
      { index: 3, covers: 'c', weight: 1, seconds: 5 },
    ]
    const shots = await subdivideAllBeats(b, 'spine', call)
    assert.deepEqual(shots.map((s) => s.index), [1, 2, 3])
    assert.deepEqual(shots.map((s) => s.beatIndex), [1, 2, 3])
  })()
})

test('subdivideAllBeats: onBeatDone fires once per beat, with a running total', () => {
  return (async () => {
    const { call } = fakeCallAtFixedShotLength(5)
    const b: AllocatedBeat[] = [
      { index: 1, covers: 'a', weight: 1, seconds: 10 },
      { index: 2, covers: 'b', weight: 1, seconds: 10 },
    ]
    const seen: number[] = []
    await subdivideAllBeats(b, 'spine', call, { onBeatDone: (_beat, _beatShots, allSoFar) => seen.push(allSoFar.length) })
    assert.equal(seen.length, 2)
    assert.ok(seen[0] < seen[1], 'the running total should grow, not reset, between beats')
  })()
})

// ── revision from a cut: re-subdivides only forward, at the BEAT level ──

test('planShotRevision: a cut inside a beat keeps every shot from EARLIER beats untouched', () => {
  const allBeats: AllocatedBeat[] = [
    { index: 1, covers: 'beat 1', weight: 1, seconds: 10 },
    { index: 2, covers: 'beat 2', weight: 1, seconds: 10 },
  ]
  const allShots: Shot[] = [
    { index: 1, covers: 's1', seconds: 5, beatIndex: 1 },
    { index: 2, covers: 's2', seconds: 5, beatIndex: 1 },
    { index: 3, covers: 's3', seconds: 5, beatIndex: 2 },
    { index: 4, covers: 's4', seconds: 5, beatIndex: 2 },
  ]
  const plan = planShotRevision(allShots, allBeats, 4) // cut lands on the last shot, inside beat 2
  assert.deepEqual(plan.keptShots.map((s) => s.index), [1, 2, 3])
  assert.deepEqual(plan.beatsToResubdivide.map((b) => b.index), [2]) // beat 1 never touched
  assert.deepEqual(plan.alreadyForCutBeat.map((s) => s.index), [3]) // the surviving fragment of beat 2
})

test('planShotRevision: a cut exactly at a beat boundary resubdivides that beat and everything after, keeps everything before', () => {
  const allBeats: AllocatedBeat[] = [
    { index: 1, covers: 'beat 1', weight: 1, seconds: 10 },
    { index: 2, covers: 'beat 2', weight: 1, seconds: 10 },
    { index: 3, covers: 'beat 3', weight: 1, seconds: 10 },
  ]
  const allShots: Shot[] = [
    { index: 1, covers: 's1', seconds: 5, beatIndex: 1 },
    { index: 2, covers: 's2', seconds: 5, beatIndex: 1 },
    { index: 3, covers: 's3', seconds: 5, beatIndex: 2 },
    { index: 4, covers: 's4', seconds: 5, beatIndex: 3 },
  ]
  const plan = planShotRevision(allShots, allBeats, 3) // cut at shot 3, the first shot of beat 2
  assert.deepEqual(plan.keptShots.map((s) => s.index), [1, 2])
  assert.deepEqual(plan.beatsToResubdivide.map((b) => b.index), [2, 3])
  assert.deepEqual(plan.alreadyForCutBeat, []) // nothing of beat 2 survives the cut
})

test('planShotRevision: a cut past every existing shot resubdivides nothing', () => {
  const allBeats: AllocatedBeat[] = [{ index: 1, covers: 'beat 1', weight: 1, seconds: 10 }]
  const allShots: Shot[] = [{ index: 1, covers: 's1', seconds: 5, beatIndex: 1 }]
  const plan = planShotRevision(allShots, allBeats, 5)
  assert.deepEqual(plan.keptShots, allShots)
  assert.deepEqual(plan.beatsToResubdivide, [])
})

test('reviseShotsFromIndex + planShotRevision together: a revised beat\'s fresh shots replace only the cut forward', () => {
  return (async () => {
    const allBeats: AllocatedBeat[] = [
      { index: 1, covers: 'beat 1', weight: 1, seconds: 10 },
      { index: 2, covers: 'beat 2', weight: 1, seconds: 10 },
    ]
    const allShots: Shot[] = [
      { index: 1, covers: 's1', seconds: 5, beatIndex: 1 },
      { index: 2, covers: 's2', seconds: 5, beatIndex: 1 },
      { index: 3, covers: 's3', seconds: 5, beatIndex: 2 },
      { index: 4, covers: 's4', seconds: 5, beatIndex: 2 },
    ]
    const plan = planShotRevision(allShots, allBeats, 3) // cut at the start of beat 2 -- nothing of it survives
    assert.equal(plan.beatsToResubdivide.length, 1)

    const call: ShotSubdivideCall = async (_user, ctx) =>
      JSON.stringify({ shots: [{ index: 1, covers: `revised beat ${ctx.beat.index}`, seconds: 10 }] })
    const fresh = await subdivideAllBeats(plan.beatsToResubdivide, 'spine', call, {
      startIndex: 3,
      priorShotsForFirstBeat: plan.alreadyForCutBeat,
    })
    const revised = reviseShotsFromIndex(allShots, 3, fresh)
    // Beat 1's shots (1, 2) are byte-identical to the originals -- never touched.
    assert.deepEqual(revised.slice(0, 2), allShots.slice(0, 2))
    // Beat 2 is wholly replaced by the fresh call's output, renumbered from 3.
    assert.equal(revised.length, 3)
    assert.equal(revised[2].covers, 'revised beat 2')
    assert.equal(revised[2].index, 3)
  })()
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

test('parsePartialShotList: agrees with parseSubdividedShots on a complete document\'s shots, and reads the spine directly', () => {
  const complete = parseSubdividedShots(COMPLETE_DOC)
  const partial = parsePartialShotList(COMPLETE_DOC)
  assert.ok(complete)
  assert.equal(partial.spine, 'a woman finds a key')
  assert.deepEqual(partial.shots, complete!)
})

test('parsePartialShotList: agrees with parseSubdividedShots on a complete, fenced document', () => {
  const fenced = '```json\n' + COMPLETE_DOC + '\n```'
  const complete = parseSubdividedShots(fenced)
  const partial = parsePartialShotList(fenced)
  assert.ok(complete)
  assert.deepEqual(partial.shots, complete!)
  assert.equal(partial.spine, 'a woman finds a key')
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
