import type { Breakdown, Shot, ShotGroup, ShotList } from './types'
import { breakdownClipsFromShotGroups, groupsAffectedByCut, type RuntimeCeilingCheck } from './shotList'
import { dropFromIndex } from './filmEdit'

/**
 * Pure logic behind Full Story mode's two screens — "Story & shots" and "The
 * clip in hand" — kept apart from `state.tsx`/the components so it is
 * testable without a React harness, same reasoning as `shotList.ts` and
 * `filmEdit.ts`. This file never invents a second grouping or invalidation
 * mechanism: it calls `shotList.ts`'s `groupShotsIntoClips`/
 * `breakdownClipsFromShotGroups`/`groupsAffectedByCut` and `filmEdit.ts`'s
 * `dropFromIndex` exactly as they are, and only adds the small amount of glue
 * a screen needs on top (which sets are already approved, taking N of them at
 * once, and the manual boundary moves the automatic packer cannot express).
 */

// ── render state of one shot group, on Screen 1's bands ─────────────────

export type GroupBandState = 'kept' | 'waiting' | 'unwritten'

/**
 * `kept` — approved AND validated (rendered, sitting in the Master
 * Extender's own cache). `waiting` — approved, not yet validated (a prompt
 * may or may not exist yet; either way it is waiting to render). `unwritten`
 * — never approved; this is the one state Screen 1 offers a tick box for.
 * `approved`/`validated` are handed in already resolved (from
 * `session.breakdown` and the existing `extenderPlanPreview.clips[].validated`
 * — see its module comment in `state.tsx`) rather than re-derived here, so
 * this file never needs to know about a Master Extender node id.
 */
export function groupBandState(approved: boolean, validated: boolean): GroupBandState {
  if (!approved) return 'unwritten'
  return validated ? 'kept' : 'waiting'
}

// ── taking one or several shot groups into the plan ─────────────────────

/**
 * Approve `selectedGroupIndices` — derive a `BreakdownClip` for each (via
 * `breakdownClipsFromShotGroups`, over the WHOLE grouping so every clip's
 * role — opening/rising/closing — is decided against the real total, not
 * just the ones being taken right now) and merge them into `existing`,
 * leaving every other already-approved clip exactly as it was. Taking one
 * set or several is the same call with a longer `selectedGroupIndices` — see
 * the brief's "ticking two or three clips and approving expands each into
 * its own prompt".
 *
 * `existing?.at` is carried through unchanged so the plan's Master Extender
 * node id (`m_${b.at.toString(36)}` in `state.tsx`) stays the SAME across
 * repeated approvals — a fresh timestamp on every take would start a new
 * film each time.
 */
export function takeShotGroups(
  shotList: Pick<ShotList, 'spine' | 'shots'>,
  groups: readonly ShotGroup[],
  selectedGroupIndices: readonly number[],
  existing: Breakdown | null,
): Breakdown {
  const selected = new Set(selectedGroupIndices)
  const derivedAll = breakdownClipsFromShotGroups(shotList.shots, groups)
  const byIndex = new Map((existing?.clips ?? []).map((c) => [c.index, c]))
  for (const c of derivedAll) if (selected.has(c.index)) byIndex.set(c.index, c)
  const clips = [...byIndex.values()].sort((a, b) => a.index - b.index)
  return { spine: existing?.spine || shotList.spine, clips, at: existing?.at ?? Date.now() }
}

// ── the runtime ceiling: a fact, never a block ───────────────────────────

/**
 * The one-line amber-`.alert.warn` fact for an over-ceiling shot list —
 * `null` when there is nothing to say. Deliberately returns a message, never
 * a boolean gate: `checkRuntimeCeiling` "reports rather than refuses, by
 * design" (its own module comment), and nothing in this file adds a
 * "blocked" flag on top of that report — approving or rendering a
 * shot-list-in-progress is never conditioned on this.
 */
export function ceilingAlert(check: RuntimeCeilingCheck): string | null {
  if (check.withinCeiling) return null
  return `${check.totalSeconds.toFixed(1)}s authored — ${check.overBySeconds.toFixed(1)}s over the ${check.maxRuntimeSeconds.toFixed(1)}s ceiling. Trim a shot, or carry on; nothing here blocks it.`
}

// ── revision: wiring the cut into the EXISTING invalidation path ────────

export interface ShotRevisionCut {
  fromGroupIndex: number | undefined
  discardedGroupIndices: number[]
  survivingGroupIndices: number[]
}

/**
 * What a plot revision "from shot N" discards, expressed as the ONE call
 * into `filmEdit.ts`'s existing `dropFromIndex` — never a second
 * invalidation path. `groupsAffectedByCut`'s `fromGroupIndex` is the only new
 * fact a cut produces; this just pairs it with the drop so a caller (and a
 * test) sees the two existing functions used together rather than
 * re-deriving the wiring at each call site.
 */
export function clipsDiscardedByShotRevision<T extends { extender?: { nodeId: string; sceneIndex: number } }>(
  clips: readonly T[],
  nodeId: string,
  groups: readonly ShotGroup[],
  cutShotIndex: number,
): { cut: ShotRevisionCut; remainingClips: T[] } {
  const cut = groupsAffectedByCut(groups, cutShotIndex)
  const remainingClips = cut.fromGroupIndex !== undefined ? dropFromIndex(clips, nodeId, cut.fromGroupIndex) : (clips as T[])
  return { cut, remainingClips }
}

// ── editing "the set you are editing", on Screen 2 ───────────────────────

/** Recompute one group's own `seconds` off the current shots — the only
 * group any single edit below ever needs to touch; every other group's
 * total is left exactly as it was. */
function reseconds(shots: readonly Shot[], group: ShotGroup): ShotGroup {
  const byIndex = new Map(shots.map((s) => [s.index, s]))
  const seconds = +group.shotIndices.reduce((sum, i) => sum + (byIndex.get(i)?.seconds ?? 0), 0).toFixed(3)
  return { ...group, seconds }
}

/** Reword one shot's `covers` — text only, no membership or timing change. */
export function rewordShot(shots: readonly Shot[], shotIndex: number, covers: string): Shot[] {
  return shots.map((s) => (s.index === shotIndex ? { ...s, covers } : s))
}

/** Retime one shot, and recompute ITS group's own total — every other
 * group's `seconds` is untouched. */
export function retimeShot(
  shots: readonly Shot[],
  groups: readonly ShotGroup[],
  shotIndex: number,
  seconds: number,
): { shots: Shot[]; groups: ShotGroup[] } {
  const nextShots = shots.map((s) => (s.index === shotIndex ? { ...s, seconds } : s))
  const nextGroups = groups.map((g) => (g.shotIndices.includes(shotIndex) ? reseconds(nextShots, g) : g))
  return { shots: nextShots, groups: nextGroups }
}

/**
 * Add a new shot at the end of one set. Every later shot's `index` (and
 * every later group's membership) is renumbered up by one so the whole film
 * stays one contiguous 1-based sequence — the same contract
 * `reviseShotsFromIndex` already keeps for a revision's tail.
 */
export function addShotToGroup(
  shots: readonly Shot[],
  groups: readonly ShotGroup[],
  groupIndex: number,
  covers: string,
  seconds: number,
): { shots: Shot[]; groups: ShotGroup[] } {
  const group = groups.find((g) => g.index === groupIndex)
  if (!group || !group.shotIndices.length) return { shots: shots as Shot[], groups: groups as ShotGroup[] }
  const insertAt = Math.max(...group.shotIndices) + 1
  const renumbered = shots.map((s) => (s.index >= insertAt ? { ...s, index: s.index + 1 } : s))
  const newShot: Shot = { index: insertAt, covers, seconds }
  const nextShots = [...renumbered, newShot].sort((a, b) => a.index - b.index)
  const nextGroups = groups.map((g) => {
    const shifted = g.shotIndices.map((i) => (i >= insertAt ? i + 1 : i))
    const withNew = g.index === groupIndex ? [...shifted, insertAt] : shifted
    return reseconds(nextShots, { ...g, shotIndices: withNew })
  })
  return { shots: nextShots, groups: nextGroups }
}

/**
 * Drop one shot. Every later shot/group membership renumbers down by one,
 * the mirror of `addShotToGroup`. Refuses to empty a set to zero shots — a
 * set with nothing in it is not a set — returning the input unchanged.
 */
export function dropShot(
  shots: readonly Shot[],
  groups: readonly ShotGroup[],
  shotIndex: number,
): { shots: Shot[]; groups: ShotGroup[] } {
  const owner = groups.find((g) => g.shotIndices.includes(shotIndex))
  if (!owner || owner.shotIndices.length <= 1) return { shots: shots as Shot[], groups: groups as ShotGroup[] }
  const nextShots = shots.filter((s) => s.index !== shotIndex).map((s) => (s.index > shotIndex ? { ...s, index: s.index - 1 } : s))
  const nextGroups = groups.map((g) => {
    const without = g.shotIndices.filter((i) => i !== shotIndex).map((i) => (i > shotIndex ? i - 1 : i))
    return reseconds(nextShots, { ...g, shotIndices: without })
  })
  return { shots: nextShots, groups: nextGroups }
}

/**
 * Pull the next group's FIRST shot into `groupIndex` — the manual escape
 * hatch from the automatic packer (the brief: "pull a shot in from the next
 * clip"). Refuses to empty the next group, or to act on the last group
 * (there is no "next" to pull from).
 */
export function pullShotFromNext(shots: readonly Shot[], groups: readonly ShotGroup[], groupIndex: number): ShotGroup[] {
  const i = groups.findIndex((g) => g.index === groupIndex)
  if (i === -1 || i + 1 >= groups.length) return groups as ShotGroup[]
  const cur = groups[i]
  const next = groups[i + 1]
  if (next.shotIndices.length <= 1) return groups as ShotGroup[]
  const moved = next.shotIndices[0]
  return groups.map((g, gi) => {
    if (gi === i) return reseconds(shots, { ...cur, shotIndices: [...cur.shotIndices, moved] })
    if (gi === i + 1) return reseconds(shots, { ...next, shotIndices: next.shotIndices.slice(1) })
    return g
  })
}

/**
 * Push `groupIndex`'s LAST shot into the next group — the mirror of
 * `pullShotFromNext` (the brief: "push one out"). Refuses to empty
 * `groupIndex`, or to act on the last group.
 */
export function pushShotToNext(shots: readonly Shot[], groups: readonly ShotGroup[], groupIndex: number): ShotGroup[] {
  const i = groups.findIndex((g) => g.index === groupIndex)
  if (i === -1 || i + 1 >= groups.length) return groups as ShotGroup[]
  const cur = groups[i]
  const next = groups[i + 1]
  if (cur.shotIndices.length <= 1) return groups as ShotGroup[]
  const moved = cur.shotIndices[cur.shotIndices.length - 1]
  return groups.map((g, gi) => {
    if (gi === i) return reseconds(shots, { ...cur, shotIndices: cur.shotIndices.slice(0, -1) })
    if (gi === i + 1) return reseconds(shots, { ...next, shotIndices: [moved, ...next.shotIndices] })
    return g
  })
}
