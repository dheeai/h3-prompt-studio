import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Breakdown, Shot, ShotGroup, ShotList } from './types'
import { checkRuntimeCeiling, groupShotsIntoClips, groupsAffectedByCut } from './shotList'
import { dropFromIndex } from './filmEdit'
import {
  addShotToGroup,
  ceilingAlert,
  clipsDiscardedByShotRevision,
  dropShot,
  groupBandState,
  pullShotFromNext,
  pushShotToNext,
  retimeShot,
  rewordShot,
  takeShotGroups,
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

test('ceilingAlert: within the ceiling says nothing', () => {
  const check = checkRuntimeCeiling(shots([5, 5, 5]), 60)
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
