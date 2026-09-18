import type { Breakdown, Clip, ClipState, ShotGroup, ShotList, Version } from './types'
import type { DirectionDoc } from './direction'
import { latestPromptForClip } from './stages'
import { shotsForGroup } from './shotScreens'
import { clipTiming } from './shotList'
import { cumulativeFilm, cumulativeSceneStarts } from './filmDisplay'
import type { PaddedClip } from './filmDisplay'

/**
 * The film start-to-finish, as one flat structure a timeline UI can walk
 * without re-deriving any of the arithmetic the founder got wrong on the
 * first pass of this design (his own words): clip starts that silently mix
 * asked and delivered seconds, and a shot's film-wide number conflated with
 * its position inside its own clip's prompt.
 *
 * This file invents NO new accounting of its own. It is glue over three
 * already-existing pieces:
 *   - `shotScreens.ts`'s `shotsForGroup` for which shots belong to which clip
 *   - `shotList.ts`'s `clipTiming` for what a clip's asked seconds actually
 *     deliver once H3 snaps to its frame grid (already written, unused until
 *     now — see its own module comment)
 *   - `filmDisplay.ts`'s `cumulativeSceneStarts`/`cumulativeFilm` for turning
 *     a per-clip frame count into where the film's clock actually is
 * A second accumulator, a second grid-snap, or a second "what shot is this"
 * lookup here would be exactly the duplication that let the original bug
 * (start times computed from ASKED seconds instead of DELIVERED) exist
 * unnoticed next to the correct arithmetic in `filmDisplay.ts`.
 */

/**
 * One clip's work state, derived from exactly three facts and nothing else
 * (Clip.state, whether a prompt exists, and whether the render is
 * validated) — never a seventh state invented on top of these six.
 *
 * `clipState === undefined` (no render record yet for this scene) splits on
 * whether a prompt has been authored. `'queued'` reads as `'written'`: a
 * job has been prompted and submitted but nothing has come back yet, which
 * is exactly "prompt, not rendered". `'done'` splits on `validated` — in
 * today's actual data this is always true the moment a render lands (see
 * `filmEdit.ts`'s `validatedClipAt`, which this file's caller mirrors), so
 * `'rendered'` (rendered, not kept) is reachable today only by passing a
 * `validated: false` alongside a `'done'` state directly to this function —
 * kept as its own branch rather than folded into `'kept'` because nothing
 * in the six-state contract says the two must always coincide, and a
 * caller with a real "confirm before keeping" step should not need a
 * seventh state added to express it.
 */
export type ClipTimelineState = 'planned' | 'written' | 'rendering' | 'rendered' | 'kept' | 'failed'

export function deriveClipTimelineState(clipState: ClipState | undefined, hasPrompt: boolean, validated: boolean): ClipTimelineState {
  if (clipState === undefined) return hasPrompt ? 'written' : 'planned'
  if (clipState === 'rendering') return 'rendering'
  if (clipState === 'failed') return 'failed'
  if (clipState === 'queued') return 'written'
  return validated ? 'kept' : 'rendered'
}

/** One shot, positioned twice: once in the whole film's numbering, once in
 * its own clip's — see this file's module comment for why conflating the
 * two was the bug worth naming. */
export interface TimelineShot {
  /** `Shot.index` — the film-wide number, stable across revisions. */
  shotIndex: number
  /** 1-based position among ONLY this clip's shots — what the clip's own
   * prompt calls "[Shot N]". Film shot 8 as clip 2's second shot reports
   * `shotIndex: 8, clipPosition: 2`. */
  clipPosition: number
  covers: string
  /** This shot's own authored length, in seconds — never grid-snapped; the
   * frame grid is a whole-CLIP fact (`clipTiming`), not a per-shot one. */
  seconds: number
  /** Cumulative from the CLIP's own start, in seconds. */
  clipStartSeconds: number
  /** Cumulative from the FILM's start — this clip's own `filmStartSeconds`
   * plus `clipStartSeconds`. */
  filmStartSeconds: number
  /** From this clip's `DirectionDoc`, when preset B directed it — matched
   * by `clipPosition`, since `DirectedShot.index` is itself 1-based within
   * the clip. Absent for an undirected clip, or a shot the direction call
   * didn't cover. */
  cameraMovement?: string
}

export interface TimelineClip {
  /** The clip/group's own 1-based position in the film. */
  index: number
  title: string
  state: ClipTimelineState
  shots: TimelineShot[]
  /** Sum of this clip's shots' own seconds (or the group/breakdown's
   * recorded `seconds` when there are no shots to sum — a clip with no
   * group, or a group with no shots). Never grid-snapped. */
  askedSeconds: number
  /** Frame accounting in `filmDisplay.ts`'s own shape, so a caller can hand
   * this straight to `deliveredVsAskedLine`/`secondsLabel` rather than
   * re-deriving either. `authored` is the raw (unsnapped) ask; `rendered`
   * and `delivered` are equal (an Extender scene pays no overlap tax) and
   * are the grid-snapped figure ONLY once this clip has actually rendered —
   * see `isEstimate`. */
  padded: PaddedClip
  /** `padded.delivered` in seconds, for a caller that wants the number
   * without doing the division. */
  deliveredSeconds: number
  /** True when this clip has not actually rendered, so `deliveredSeconds`
   * is `askedSeconds` standing in for a figure that does not exist yet —
   * never silently presented as a real delivered length. */
  isEstimate: boolean
  /** Cumulative DELIVERED (or, before rendering, estimated) seconds at the
   * START of this clip — from `filmDisplay.ts`'s `cumulativeSceneStarts`,
   * not a second accumulator. */
  filmStartSeconds: number
  /** The actual render record for this scene of this film, if one exists —
   * whatever state it is currently in (queued/rendering/done/failed). */
  clip?: Clip
}

export interface RuntimeBar {
  /** Total delivered seconds of every `'kept'` clip. */
  keptSeconds: number
  /** Total delivered seconds of every `'rendered'` (not kept) clip. */
  renderedSeconds: number
  /** Everything else — planned, written, rendering, failed — as a residual
   * of the film's total so the three always sum exactly to it, never as a
   * second, independently-rounded sum that could drift from the total by a
   * rounding hair. */
  remainingSeconds: number
}

export interface Timeline {
  clips: TimelineClip[]
  /** The film's total length, delivered where known and estimated (from
   * asked seconds) where not — see `TimelineClip.isEstimate`. */
  totalSeconds: number
  /** True the moment any clip's length is still an estimate. */
  isEstimate: boolean
  runtimeBar: RuntimeBar
}

export interface TimelineInput {
  /** Full Story mode's shot list — only `shots` is read. */
  shotList: Pick<ShotList, 'shots'> | null
  shotGroups: readonly ShotGroup[]
  breakdown: Breakdown | null
  /** Every render record in the session — filtered to this film's `nodeId`
   * internally, exactly as `filmEdit.ts`'s `validatedClipAt` does. */
  clips: readonly Clip[]
  versions: readonly Version[]
  /** This film's own stable Master Extender node id (`ExtenderPlanPreview.nodeId`
   * / `FilmInfo.runName`) — `undefined` before any clip has ever been
   * approved, in which case every clip in this timeline reads as having no
   * render record at all. */
  nodeId: string | undefined
  /** Preset B's per-clip direction documents, keyed by clip/group index —
   * `Session.directionByClip` verbatim. Omitted (or missing an entry)
   * simply means that clip's shots carry no `cameraMovement`. */
  directionByClip?: Record<number, DirectionDoc>
  fps?: number
}

function toPadded(authored: number, delivered: number): PaddedClip {
  return { authored, rendered: delivered, delivered }
}

/**
 * Build the whole film's timeline. Walks the UNION of `shotGroups` and
 * `breakdown.clips` indices — not just one or the other — because a group
 * not yet approved (no `BreakdownClip`) is exactly the `'planned'` state,
 * and a `BreakdownClip` whose group has since gone missing (the "a clip
 * with no group" edge case) still needs a row, just with no shots under it.
 */
export function buildTimeline(input: TimelineInput): Timeline {
  const fps = input.fps ?? 24
  const shots = input.shotList?.shots ?? []
  const groupByIndex = new Map(input.shotGroups.map((g) => [g.index, g]))
  const breakdownByIndex = new Map((input.breakdown?.clips ?? []).map((c) => [c.index, c]))
  const indices = [...new Set([...groupByIndex.keys(), ...breakdownByIndex.keys()])].sort((a, b) => a - b)

  const rows = indices.map((index) => {
    const group = groupByIndex.get(index)
    const bc = breakdownByIndex.get(index)
    const clipShots = group ? shotsForGroup(shots, group) : []
    const askedSeconds = clipShots.length
      ? +clipShots.reduce((sum, s) => sum + s.seconds, 0).toFixed(3)
      : bc?.seconds ?? group?.seconds ?? 0

    // The most recent render record for this scene of THIS film. A redo
    // drops the stale one (`filmEdit.ts`'s `dropFromIndex`) before appending
    // its replacement, so in practice there is at most one match — `reverse`
    // is the same "newest wins" rule the rest of the codebase uses when that
    // invariant is ever momentarily untrue.
    const clipRecord = input.nodeId
      ? [...input.clips].reverse().find((c) => c.extender?.nodeId === input.nodeId && c.extender?.sceneIndex === index)
      : undefined
    const hasPrompt = !!latestPromptForClip(input.versions, index)?.text.trim()
    const validated = clipRecord?.state === 'done'
    const state = deriveClipTimelineState(clipRecord?.state, hasPrompt, validated)
    const isRendered = state === 'kept' || state === 'rendered'

    const authoredFrames = Math.round(askedSeconds * fps)
    const deliveredFrames = isRendered ? clipTiming(askedSeconds, fps).frames : authoredFrames
    const direction = input.directionByClip?.[index]

    let cursor = 0
    const timelineShots = clipShots.map((s, i) => {
      const clipStartSeconds = +cursor.toFixed(3)
      cursor += s.seconds
      const cameraMovement = direction?.shots.find((d) => d.index === i + 1)?.cameraMovement
      return {
        shotIndex: s.index,
        clipPosition: i + 1,
        covers: s.covers,
        seconds: s.seconds,
        clipStartSeconds,
        cameraMovement: cameraMovement || undefined,
      }
    })

    return {
      index,
      title: bc?.title || `clip ${index}`,
      state,
      askedSeconds,
      padded: toPadded(authoredFrames, deliveredFrames),
      isEstimate: !isRendered,
      shots: timelineShots,
      clip: clipRecord,
    }
  })

  const padded = rows.map((r) => r.padded)
  const starts = cumulativeSceneStarts(padded, fps)
  const totals = cumulativeFilm(padded, fps)

  const clips: TimelineClip[] = rows.map((r, i) => ({
    index: r.index,
    title: r.title,
    state: r.state,
    askedSeconds: r.askedSeconds,
    padded: r.padded,
    deliveredSeconds: +(r.padded.delivered / fps).toFixed(3),
    isEstimate: r.isEstimate,
    filmStartSeconds: starts[i],
    shots: r.shots.map((s) => ({ ...s, filmStartSeconds: +(starts[i] + s.clipStartSeconds).toFixed(3) })),
    clip: r.clip,
  }))

  const keptSeconds = +clips.filter((c) => c.state === 'kept').reduce((sum, c) => sum + c.deliveredSeconds, 0).toFixed(3)
  const renderedSeconds = +clips.filter((c) => c.state === 'rendered').reduce((sum, c) => sum + c.deliveredSeconds, 0).toFixed(3)
  // The residual, not a third independent sum — see `RuntimeBar.remainingSeconds`.
  const remainingSeconds = +(totals.seconds - keptSeconds - renderedSeconds).toFixed(3)

  return {
    clips,
    totalSeconds: totals.seconds,
    isEstimate: clips.some((c) => c.isEstimate),
    runtimeBar: { keptSeconds, renderedSeconds, remainingSeconds },
  }
}

// ── bulk selection: the founder's "select all and render in 1 shot" ────

export interface BulkSelectionPlan {
  /** Selected clips a "write" action would author — `'planned'` only (never
   * approved, or approved with the prompt cleared by a discard); never a
   * clip that already has a prompt. */
  toWrite: number[]
  /** Selected clips a "render" action would submit — `'written'` (never
   * rendered) AND `'failed'` (a render attempt that needs retrying; it
   * already has its prompt, so retrying is a render, not a write). A
   * `'kept'`/`'rendered'` clip is never resampled, and a clip with no
   * prompt yet (`'planned'`) is never submitted to render — both asserted
   * by this function's own tests, not left for a caller to get right by
   * construction. */
  toRender: number[]
}

/**
 * What a bulk "write" or "render" action over a SELECTION would actually do
 * — the pure seam behind the timeline's select-all/select-one checkboxes,
 * so the checkbox's own visual meaning ("checked = will act on this clip")
 * can never quietly invert into "checked = held back" the way the render
 * submission's own `ticked` state once did (2026-09-18).
 */
export function bulkSelectionPlan(
  clips: readonly Pick<TimelineClip, 'index' | 'state'>[],
  selected: ReadonlySet<number>,
): BulkSelectionPlan {
  const toWrite: number[] = []
  const toRender: number[] = []
  for (const c of clips) {
    if (!selected.has(c.index)) continue
    if (c.state === 'planned') toWrite.push(c.index)
    else if (c.state === 'written' || c.state === 'failed') toRender.push(c.index)
  }
  return { toWrite, toRender }
}
