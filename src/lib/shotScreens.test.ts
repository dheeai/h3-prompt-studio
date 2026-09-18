import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Breakdown, Shot, ShotGroup, ShotList, Version } from './types'
import { checkRuntimeCeiling, groupShotsIntoClips, groupsAffectedByCut } from './shotList'
import { dropFromIndex } from './filmEdit'
import { extenderCostEstimate } from './extender'
import {
  addShotToGroup,
  ceilingAlert,
  clipsDiscardedByShotRevision,
  discardBreakdownFromIndex,
  dropShot,
  groupBandState,
  nextUnwrittenGroupIndex,
  planForTickedSubmission,
  promptIsStale,
  pullShotFromNext,
  pushShotToNext,
  retimeShot,
  rewordShot,
  shotsForGroup,
  takeShotGroups,
  toggledSet,
} from './shotScreens'

function shots(seconds: number[]): Shot[] {
  return seconds.map((s, i) => ({ index: i + 1, covers: `shot ${i + 1}`, seconds: s }))
}

// ── the shots call producing a grouped list the screens render ──────────

test('a parsed shot list groups into clip-sized sets the screens can render', () => {
  const shotList: ShotList = { spine: 'a spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups, issues } = groupShotsIntoClips(shotList.shots)
  assert.equal(issues.length, 0)
  assert.equal(groups.length, 2)
  assert.deepEqual(groups.map((g) => g.shotIndices), [[1, 2, 3], [4, 5, 6]])
  // Every group is renderable by the band logic, unapproved to start.
  for (const _g of groups) assert.equal(groupBandState(false, false), 'unwritten')
})

// ── band state ────────────────────────────────────────────────────────

test('groupBandState: unwritten before approval, waiting once approved, kept once validated', () => {
  assert.equal(groupBandState(false, false), 'unwritten')
  assert.equal(groupBandState(true, false), 'waiting')
  assert.equal(groupBandState(true, true), 'kept')
})

// ── taking one set versus several ────────────────────────────────────────

test('takeShotGroups: taking ONE set adds exactly one approved clip', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots)
  assert.equal(groups.length, 3)
  const taken = takeShotGroups(shotList, groups, [2], null)
  assert.equal(taken.clips.length, 1)
  assert.equal(taken.clips[0].index, 2)
  // Role is decided against the WHOLE grouping (3 groups -> opening/rising/closing),
  // not as if group 2 were the only one that existed.
  assert.equal(taken.clips[0].role, 'rising')
})

test('takeShotGroups: taking SEVERAL sets at once adds one approved clip per set, each its own', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots)
  const taken = takeShotGroups(shotList, groups, [1, 2, 3], null)
  assert.equal(taken.clips.length, 3)
  assert.deepEqual(taken.clips.map((c) => c.index), [1, 2, 3])
  assert.deepEqual(taken.clips.map((c) => c.role), ['opening', 'rising', 'closing'])
})

test('takeShotGroups: an already-approved clip not in this take is left exactly as it was', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots)
  const existing: Breakdown = {
    spine: 'spine',
    at: 42,
    clips: [{ index: 1, title: 'Clip 1 (hand-edited)', role: 'opening', seconds: 15, covers: 'edited', precedes: '', follows: '' }],
  }
  const taken = takeShotGroups(shotList, groups, [2], existing)
  assert.equal(taken.clips.length, 2)
  assert.equal(taken.clips[0].title, 'Clip 1 (hand-edited)')
  // The plan's own timestamp — and therefore its Master Extender node id —
  // never changes just because another set was taken.
  assert.equal(taken.at, 42)
})

// ── a revision from shot N, fed into the EXISTING drop path ─────────────

test('clipsDiscardedByShotRevision: a cut mid-group discards that group and everything after it, via the existing dropFromIndex', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots) // [[1,2,3],[4,5,6]]
  const nodeId = 'm_x'
  const clips = [
    { id: 'a', extender: { nodeId, sceneIndex: 1 } },
    { id: 'b', extender: { nodeId, sceneIndex: 2 } },
    { id: 'c', extender: { nodeId: 'other', sceneIndex: 1 } },
  ]
  // Cut at shot 5 — inside group 2 (shots 4,5,6) — discards group 2 whole.
  const { cut, remainingClips } = clipsDiscardedByShotRevision(clips, nodeId, groups, 5)
  const direct = groupsAffectedByCut(groups, 5)
  assert.deepEqual(cut, direct)
  assert.equal(cut.fromGroupIndex, 2)
  assert.deepEqual(remainingClips, dropFromIndex(clips, nodeId, 2))
  assert.deepEqual(remainingClips.map((c) => c.id), ['a', 'c'])
})

test('clipsDiscardedByShotRevision: a cut after every group discards nothing', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots)
  const nodeId = 'm_x'
  const clips = [{ id: 'a', extender: { nodeId, sceneIndex: 1 } }, { id: 'b', extender: { nodeId, sceneIndex: 2 } }]
  const { cut, remainingClips } = clipsDiscardedByShotRevision(clips, nodeId, groups, 999)
  assert.equal(cut.fromGroupIndex, undefined)
  assert.deepEqual(remainingClips, clips)
})

// ── the ceiling check surfaces without blocking ──────────────────────────

test('ceilingAlert: close to the ceiling, neither over nor significantly under, says nothing', () => {
  // 57 of 60 -- 5% short, comfortably inside the noise the significant-underrun
  // check is meant to ignore (see shotList.ts's SIGNIFICANT_UNDERRUN_FRACTION).
  const check = checkRuntimeCeiling(shots([19, 19, 19]), 60)
  assert.equal(ceilingAlert(check), null)
})

test('ceilingAlert: a significant under-run (the "5 minutes asked for, 7 clips delivered" bug) states the fact', () => {
  // 105s of a 300s ceiling -- the exact numbers from the measured bug.
  const check = checkRuntimeCeiling(shots(Array(21).fill(5)), 300)
  assert.equal(check.totalSeconds, 105)
  assert.equal(check.withinCeiling, true) // 0 overshoot -- this is what stayed silent before
  assert.equal(check.significantlyUnder, true)
  const alert = ceilingAlert(check)
  assert.ok(alert && /105\.0s.*under the 300\.0s ceiling/.test(alert))
})

test('ceilingAlert: 298 of 300 (noise) stays quiet', () => {
  const check = checkRuntimeCeiling(shots([298]), 300)
  assert.equal(check.significantlyUnder, false)
  assert.equal(ceilingAlert(check), null)
})

test('ceilingAlert: over the ceiling states the fact — and takeShotGroups still works over it (never a block)', () => {
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 10, shots: shots([9, 9]), at: 1 }
  const check = checkRuntimeCeiling(shotList.shots, shotList.maxRuntimeSeconds)
  assert.equal(check.withinCeiling, false)
  const alert = ceilingAlert(check)
  assert.ok(alert && /over the 10\.0s ceiling/.test(alert))
  const { groups } = groupShotsIntoClips(shotList.shots)
  const taken = takeShotGroups(shotList, groups, [1], null) // over-ceiling shot list is still approvable
  assert.equal(taken.clips.length, 1)
})

// ── editing the set in hand ──────────────────────────────────────────────

test('rewordShot: changes only the one shot’s covers', () => {
  const s = shots([5, 5])
  const next = rewordShot(s, 2, 'new covers')
  assert.equal(next.find((x) => x.index === 2)?.covers, 'new covers')
  assert.equal(next.find((x) => x.index === 1)?.covers, 'shot 1')
})

test('retimeShot: changes the shot and recomputes only ITS group’s seconds', () => {
  const s = shots([5, 5, 5, 5, 5, 5])
  const { groups } = groupShotsIntoClips(s) // [[1,2,3],[4,5,6]] at 15s each
  const { shots: nextShots, groups: nextGroups } = retimeShot(s, groups, 2, 10)
  assert.equal(nextShots.find((x) => x.index === 2)?.seconds, 10)
  assert.equal(nextGroups[0].seconds, 20) // 5 + 10 + 5
  assert.equal(nextGroups[1].seconds, 15) // untouched
})

test('addShotToGroup: inserts a shot at the end of the set and renumbers everything after it', () => {
  const s = shots([5, 5, 5, 5])
  const { groups } = groupShotsIntoClips(s, { targetSeconds: 10, maxSeconds: 12 }) // forces [[1,2],[3,4]]
  const { shots: nextShots, groups: nextGroups } = addShotToGroup(s, groups, 1, 'new shot', 3)
  assert.equal(nextShots.length, 5)
  assert.deepEqual(nextShots.map((x) => x.index), [1, 2, 3, 4, 5])
  assert.equal(nextShots.find((x) => x.covers === 'new shot')?.index, 3)
  assert.deepEqual(nextGroups[0].shotIndices, [1, 2, 3])
  assert.deepEqual(nextGroups[1].shotIndices, [4, 5])
  assert.equal(nextGroups[0].seconds, 13)
})

test('dropShot: removes a shot and renumbers everything after it, and refuses to empty a set', () => {
  const s = shots([5, 5, 5, 5])
  const { groups } = groupShotsIntoClips(s, { targetSeconds: 10, maxSeconds: 12 }) // [[1,2],[3,4]]
  const { shots: nextShots, groups: nextGroups } = dropShot(s, groups, 1)
  assert.deepEqual(nextShots.map((x) => x.index), [1, 2, 3])
  assert.deepEqual(nextGroups[0].shotIndices, [1])
  assert.deepEqual(nextGroups[1].shotIndices, [2, 3])

  // Refuses to drop the last shot of a one-shot set.
  const oneShotGroups: ShotGroup[] = [{ index: 1, shotIndices: [1], seconds: 5 }]
  const refused = dropShot(shots([5]), oneShotGroups, 1)
  assert.equal(refused.shots.length, 1)
})

test('pullShotFromNext / pushShotToNext: move exactly one shot across the boundary between adjacent sets', () => {
  const s = shots([5, 5, 5, 5])
  const groups: ShotGroup[] = [
    { index: 1, shotIndices: [1, 2], seconds: 10 },
    { index: 2, shotIndices: [3, 4], seconds: 10 },
  ]
  const pulled = pullShotFromNext(s, groups, 1)
  assert.deepEqual(pulled[0].shotIndices, [1, 2, 3])
  assert.deepEqual(pulled[1].shotIndices, [4])
  assert.equal(pulled[0].seconds, 15)
  assert.equal(pulled[1].seconds, 5)

  const pushed = pushShotToNext(s, groups, 1)
  assert.deepEqual(pushed[0].shotIndices, [1])
  assert.deepEqual(pushed[1].shotIndices, [2, 3, 4])

  // Refuses to act on the last group (nothing to pull from / push to).
  assert.deepEqual(pullShotFromNext(s, groups, 2), groups)
  assert.deepEqual(pushShotToNext(s, groups, 2), groups)

  // Refuses to empty the donor set.
  const singleGroups: ShotGroup[] = [
    { index: 1, shotIndices: [1], seconds: 5 },
    { index: 2, shotIndices: [2, 3, 4], seconds: 15 },
  ]
  assert.deepEqual(pushShotToNext(s, singleGroups, 1), singleGroups)
})

// ── the hole: a revision must reconcile the breakdown + prompt layer too ──

function versionForClip(clipIndex: number | undefined, id: string): Version {
  return { id, stage: 'draft', label: 'Draft', text: `prompt for ${clipIndex}`, model: 'm', providerId: 'p', at: 1, ms: 1, clipIndex }
}

test('discardBreakdownFromIndex: drops the BreakdownClip and its authored prompt(s) at or after the cut, keeps everything before it', () => {
  const breakdown: Breakdown = {
    spine: 'spine',
    at: 1,
    clips: [1, 2, 3].map((i) => ({ index: i, title: `Clip ${i}`, role: 'rising', seconds: 15, covers: `c${i}`, precedes: '', follows: '' })),
  }
  const versions: Version[] = [versionForClip(1, 'v1'), versionForClip(2, 'v2'), versionForClip(3, 'v3'), versionForClip(undefined, 'v-composer')]

  const { breakdown: nextBreakdown, versions: nextVersions } = discardBreakdownFromIndex(breakdown, versions, 2)

  assert.deepEqual(nextBreakdown.clips.map((c) => c.index), [1])
  // Group 2's prompt AND group 3's (never authored past the cut) are gone;
  // a version with no clipIndex (a plain composer pass) is never touched.
  assert.deepEqual(nextVersions.map((v) => v.id), ['v1', 'v-composer'])
})

test('discardBreakdownFromIndex: a cut past every approved group discards nothing', () => {
  const breakdown: Breakdown = { spine: 'spine', at: 1, clips: [{ index: 1, title: 'Clip 1', role: 'standalone', seconds: 15, covers: '', precedes: '', follows: '' }] }
  const versions: Version[] = [versionForClip(1, 'v1')]
  const { breakdown: nextBreakdown, versions: nextVersions } = discardBreakdownFromIndex(breakdown, versions, 5)
  assert.deepEqual(nextBreakdown, breakdown)
  assert.deepEqual(nextVersions, versions)
})

test('a shot-list revision reconciles ALL THREE layers with the SAME cut — bare shots, breakdown+prompt, and render', () => {
  // 9 shots, packed into 3 groups of 15s each; approve+author all three,
  // and render (validate) group 1 only.
  const shotList: ShotList = { spine: 'spine', maxRuntimeSeconds: 60, shots: shots([5, 5, 5, 5, 5, 5, 5, 5, 5]), at: 1 }
  const { groups } = groupShotsIntoClips(shotList.shots) // [[1,2,3],[4,5,6],[7,8,9]]
  const breakdown: Breakdown = { spine: 'spine', at: 1, clips: groups.map((g) => ({ index: g.index, title: `Clip ${g.index}`, role: 'rising', seconds: g.seconds, covers: '', precedes: '', follows: '' })) }
  const versions: Version[] = [versionForClip(1, 'v1'), versionForClip(2, 'v2'), versionForClip(3, 'v3')]
  const nodeId = 'm_x'
  const clips = [{ id: 'a', extender: { nodeId, sceneIndex: 1 } }, { id: 'b', extender: { nodeId, sceneIndex: 2 } }]

  // A cut at shot 5 lands inside group 2 (shots 4,5,6).
  const { cut, remainingClips } = clipsDiscardedByShotRevision(clips, nodeId, groups, 5)
  assert.equal(cut.fromGroupIndex, 2)
  assert.deepEqual(remainingClips.map((c) => c.id), ['a']) // scene 2's render discarded

  const { breakdown: nextBreakdown, versions: nextVersions } = discardBreakdownFromIndex(breakdown, versions, cut.fromGroupIndex!)
  assert.deepEqual(nextBreakdown.clips.map((c) => c.index), [1]) // group 2 & 3's plan clip gone too
  assert.deepEqual(nextVersions.map((v) => v.id), ['v1']) // and their authored prompts
})

// ── Gate A: ticking a subset, and the cost estimate that matches it ──────

test('planForTickedSubmission: a validated clip always rides along; only a PENDING one needs a tick', () => {
  const plan = [
    { index: 1, seconds: 15, validated: true },
    { index: 2, seconds: 15, validated: false },
    { index: 3, seconds: 15, validated: false },
  ]
  const { toSubmit, heldBack } = planForTickedSubmission(plan, new Set([2]))
  assert.deepEqual(toSubmit.map((c) => c.index), [1, 2])
  assert.deepEqual(heldBack.map((c) => c.index), [3])
})

test('planForTickedSubmission: the cost estimate over toSubmit matches exactly what would be sent', () => {
  const plan = [
    { index: 1, seconds: 10, validated: true },
    { index: 2, seconds: 12, validated: false },
    { index: 3, seconds: 14, validated: false },
  ]
  // Tick only clip 2 — hold clip 3 back.
  const { toSubmit } = planForTickedSubmission(plan, new Set([2]))
  const cost = extenderCostEstimate(toSubmit)
  assert.equal(cost.clipCount, 2)
  assert.equal(cost.toSample, 1) // clip 2 only
  assert.equal(cost.fromCache, 1) // clip 1, validated
  assert.equal(cost.totalSeconds, 22) // 10 + 12, NOT clip 3's 14
})

test('planForTickedSubmission: ticking every pending clip submits the whole plan, holding nothing back', () => {
  const plan = [{ index: 1, seconds: 5, validated: false }, { index: 2, seconds: 5, validated: false }]
  const { toSubmit, heldBack } = planForTickedSubmission(plan, new Set([1, 2]))
  assert.equal(toSubmit.length, 2)
  assert.equal(heldBack.length, 0)
})

// ── Gate B: keeping a clip is what brings up the next shots ─────────────

test('nextUnwrittenGroupIndex: the first group with no BreakdownClip yet', () => {
  const groups: ShotGroup[] = [
    { index: 1, shotIndices: [1], seconds: 5 },
    { index: 2, shotIndices: [2], seconds: 5 },
    { index: 3, shotIndices: [3], seconds: 5 },
  ]
  const breakdown: Breakdown = { spine: '', at: 1, clips: [{ index: 1, title: 'Clip 1', role: 'opening', seconds: 5, covers: '', precedes: '', follows: '' }] }
  assert.equal(nextUnwrittenGroupIndex(groups, breakdown), 2)
})

test('nextUnwrittenGroupIndex: undefined once every group is approved', () => {
  const groups: ShotGroup[] = [{ index: 1, shotIndices: [1], seconds: 5 }]
  const breakdown: Breakdown = { spine: '', at: 1, clips: [{ index: 1, title: 'Clip 1', role: 'standalone', seconds: 5, covers: '', precedes: '', follows: '' }] }
  assert.equal(nextUnwrittenGroupIndex(groups, breakdown), undefined)
})

test('nextUnwrittenGroupIndex: with no breakdown at all, the first group is next', () => {
  const groups: ShotGroup[] = [{ index: 1, shotIndices: [1], seconds: 5 }]
  assert.equal(nextUnwrittenGroupIndex(groups, null), 1)
})

// ── Gate A rework (issue #32): lead with the shots, prompt on demand ────

test('shotsForGroup: exactly this group\'s shots, in shotIndices order — never another group\'s, regardless of array order', () => {
  const s: Shot[] = [
    { index: 3, covers: 'third', seconds: 5 },
    { index: 1, covers: 'first', seconds: 5 },
    { index: 2, covers: 'second', seconds: 5 },
    { index: 4, covers: 'fourth', seconds: 5 },
  ]
  const group: ShotGroup = { index: 1, shotIndices: [1, 2, 3], seconds: 15 }
  const result = shotsForGroup(s, group)
  assert.deepEqual(result.map((x) => x.index), [1, 2, 3])
  assert.deepEqual(result.map((x) => x.covers), ['first', 'second', 'third'])
})

test('shotsForGroup: a shot the group references but that no longer exists is skipped, not thrown', () => {
  const s: Shot[] = [{ index: 1, covers: 'first', seconds: 5 }]
  const group: ShotGroup = { index: 1, shotIndices: [1, 2], seconds: 10 }
  assert.deepEqual(shotsForGroup(s, group).map((x) => x.index), [1])
})

test('toggledSet: toggling one item adds/removes only that item, others untouched — per-item, never global', () => {
  const held = new Set([2, 5])
  const added = toggledSet(held, 3)
  assert.deepEqual([...added].sort(), [2, 3, 5])
  assert.deepEqual([...held].sort(), [2, 5]) // input untouched
  const removed = toggledSet(added, 3)
  assert.deepEqual([...removed].sort(), [2, 5])
})

test('promptIsStale: false right after the group was derived from the current shots', () => {
  const s = shots([5, 5, 5])
  const group: ShotGroup = { index: 1, shotIndices: [1, 2, 3], seconds: 15 }
  const bc = { index: 1, title: 'Clip 1', role: 'standalone' as const, seconds: 15, covers: 'shot 1 shot 2 shot 3', precedes: '', follows: '' }
  assert.equal(promptIsStale(bc, s, group), false)
})

test('promptIsStale: true once a shot INSIDE the group is reworded after approval', () => {
  const s = shots([5, 5, 5])
  const group: ShotGroup = { index: 1, shotIndices: [1, 2, 3], seconds: 15 }
  const bc = { index: 1, title: 'Clip 1', role: 'standalone' as const, seconds: 15, covers: 'shot 1 shot 2 shot 3', precedes: '', follows: '' }
  const reworded = rewordShot(s, 2, 'a rewritten shot 2')
  assert.equal(promptIsStale(bc, reworded, group), true)
})

test('promptIsStale: true once a shot INSIDE the group is retimed after approval', () => {
  const s = shots([5, 5, 5])
  const group: ShotGroup = { index: 1, shotIndices: [1, 2, 3], seconds: 15 }
  const bc = { index: 1, title: 'Clip 1', role: 'standalone' as const, seconds: 15, covers: 'shot 1 shot 2 shot 3', precedes: '', follows: '' }
  const { shots: retimed, groups: retimedGroups } = retimeShot(s, [group], 2, 10)
  assert.equal(promptIsStale(bc, retimed, retimedGroups[0]), true)
})

test('promptIsStale: editing a DIFFERENT group\'s shot never marks this one stale', () => {
  const s = shots([5, 5, 5, 5, 5, 5])
  const groupA: ShotGroup = { index: 1, shotIndices: [1, 2, 3], seconds: 15 }
  const groupB: ShotGroup = { index: 2, shotIndices: [4, 5, 6], seconds: 15 }
  const bcA = { index: 1, title: 'Clip 1', role: 'standalone' as const, seconds: 15, covers: 'shot 1 shot 2 shot 3', precedes: '', follows: '' }
  const reworded = rewordShot(s, 5, 'a rewritten shot 5') // inside groupB, not groupA
  assert.equal(promptIsStale(bcA, reworded, groupA), false)
})
