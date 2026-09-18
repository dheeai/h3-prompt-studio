import type { AllocatedBeat, Beat, BeatList, Breakdown, BreakdownClip, ClipRole, Shot, ShotGroup, ShotList } from './types'
import { SCENE_LENGTH_CHIPS } from './filmDisplay'
import { framesForSeconds, secondsForFrames } from './geometry'

/**
 * Full Story mode — the shot-list stage and the pure grouping/revision logic
 * that sits between it and the existing per-clip expansion path.
 *
 * ── Why a TWO-PASS planner (reworked 2026-09-18) ─────────────────────────
 *
 * The original design (2026-09-17) put a plot + a maximum runtime into ONE
 * model call that returned the whole film's `ShotList` directly. That broke
 * the moment the ceiling moved: `SHOT_LIST_TEMPLATE` stated the runtime as a
 * MAXIMUM only ("must sum to no more than N seconds"), so a model handed a
 * complete plot told the whole story at whatever grain it liked and then
 * stopped — 7 clips (~105s) out of a 300s ceiling, measured live. Widening
 * the ceiling never fixes that: nothing in a one-directional instruction
 * asks the model to say MORE about the SAME events. It also cannot scale: a
 * 30-minute film needs 400+ shots in one JSON reply, and `parseShotList`
 * takes from the first `{` to the last `}` and `JSON.parse`s it — a reply
 * that runs out of output budget mid-object returns `null`, not a short
 * list.
 *
 * The fix, per the operator's own diagnosis ("the LLM ended up authoring the
 * full story rather than just what needs to go in 7 clips"): SUBDIVISION,
 * not continuation. The same events, decomposed more finely — the STORY
 * decides how many beats it has; the RUNTIME decides how many shots each
 * beat is worth.
 *
 *   PASS 1 — beats. One bounded call, the whole arc, coarse (`BeatList`,
 *   `BEAT_LIST_TEMPLATE`). A complete story is ~6-12 beats regardless of
 *   runtime — beat count follows the STORY. Each beat carries `covers` (the
 *   same "no camera, no performance, no dialogue wording" discipline as a
 *   shot) and a `weight` (relative screen time, no units).
 *
 *   ALLOCATION — pure, no model. `allocateBeatSeconds` distributes
 *   `maxRuntimeSeconds` across the beats proportional to `weight`, summing
 *   EXACTLY to the ceiling via a largest-remainder apportionment (deterministic,
 *   never float-drifty), with a floor so a low-weight beat is never squeezed
 *   to nothing.
 *
 *   PASS 2 — subdivide, one call per beat (`subdivideBeat`,
 *   `SHOT_SUBDIVIDE_TEMPLATE`): "this beat covers X; decompose it into shots
 *   totalling N seconds, each between MIN and MAX." The budget is a TARGET
 *   stated in both directions — come in short or go over and the template
 *   says so is wrong, not just "over" as the old one-directional wording did.
 *   `planSubdivisionWindows` keeps any one reply bounded: a beat whose budget
 *   would need an unsafe number of shots is split into successive WINDOWS,
 *   each its own call, rather than ever asking for everything at once — this
 *   is what makes 10- and 30-minute films reachable at all: the NUMBER of
 *   calls grows with runtime, the SIZE of any one reply does not.
 *
 * `subdivideAllBeats` assembles the beats' shots in order and renumbers
 * `index` contiguously from 1 — the same defensive renumbering
 * `reviseShotsFromIndex`/`parseShotList` already apply to whatever a model
 * echoed back. Nothing here writes camera, performance or sound, and nothing
 * here builds an H3 prompt — an approved group still goes through the
 * EXISTING per-clip expansion path (`Direct`/`Draft` in `stages.ts`)
 * completely unchanged.
 *
 * ── Breakdown coexistence, decided ──────────────────────────────────────
 *
 * `Breakdown`/`BreakdownClip` (`types.ts`) already model exactly "one clip of
 * a plan, with a role, seconds, and continuity text" — and everything
 * downstream (`filmBlock`, `renderExtenderPlan`'s `sceneIndex`, `ClipPlan`'s
 * UI) is written against that shape. Full Story mode does not replace it or
 * grow a parallel expansion path: it DERIVES a `Breakdown` from grouped shots
 * (`breakdownFromShotList`), so the moment a set of shots is approved it
 * looks, to every existing consumer, exactly like a plan clip that came out
 * of the old single-call `breakdown` stage. The only new surface those
 * consumers see is that `BreakdownClip.precedes`/`.follows` come back empty
 * (the shot list carries no per-clip hand-off text of its own) — `filmBlock`
 * and `fillTemplate` already treat an empty one as absent, not missing.
 *
 * ── Validated / rendered, reused rather than reinvented ─────────────────
 *
 * This file has NO notion of "rendered" or "validated" of its own.
 * `validated` already means "landed in the Master Extender's own disk cache,
 * derived from a `done` render" (`filmEdit.ts`'s `validatedClipAt`), and the
 * cache is a per-film LINEAR PREFIX, which is exactly why
 * `filmEdit.ts` already ships `dropFromIndex(clips, nodeId, fromIndex)` to
 * invalidate it. `groupsAffectedByCut` below computes nothing more than the
 * `fromIndex` that call needs — a cut in the shot list is worthless to a
 * caller until it is expressed as "which group index does the existing
 * invalidation start discarding at", so that is exactly what it returns.
 */

// ── the pack-into-clips constants ──────────────────────────────────────

/** H3's shortest clip (124 frames) — the same floor `filmDisplay.ts`'s
 * `SCENE_LENGTH_CHIPS[0]` already offers as the lowest chip. Read off that
 * grid rather than a second hardcoded 5.2, so a future change to the chip
 * set is never silently out of step with the grouping floor. */
export const MIN_CLIP_SECONDS = secondsForFrames(SCENE_LENGTH_CHIPS[0])

/** The Studio's longest offered scene length (481 frames, `SCENE_LENGTH_CHIPS`'s
 * top chip) — the ceiling a packed group is never intentionally pushed past. */
export const MAX_CLIP_SECONDS = secondsForFrames(SCENE_LENGTH_CHIPS[SCENE_LENGTH_CHIPS.length - 1])

/** What the brief asks grouping to aim for. A soft target: the floor and the
 * ceiling are the hard constraints; this only breaks ties between them. */
export const TARGET_CLIP_SECONDS = 15

/**
 * The operator's runtime ceiling moves in whole clips, not arbitrary seconds.
 *
 * WHY 15s STEPS. `TARGET_CLIP_SECONDS` is 15, so one step of this slider is one
 * more clip in the film. A free-text seconds field invited values the grouping
 * can never honour -- ask for 67s and you get four clips totalling 60 or five
 * totalling 75, because a shot is never split across clips and a group under
 * MIN_CLIP_SECONDS is folded back into its predecessor. Snapping the CEILING to
 * the same grid the grouping already works in removes that whole class of
 * near-miss.
 *
 * The range is 15s (one clip) to 10 minutes. The ceiling is not a promise the
 * box can render that much in one job -- it is what the shot list is allowed to
 * add up to.
 */
export const RUNTIME_MIN_SECONDS = 15
export const RUNTIME_MAX_SECONDS = 600
export const RUNTIME_STEP_SECONDS = 15

/** Snap to the 15s grid and clamp into range. Anything unusable (NaN, a stored
 * off-grid value from before the slider existed) lands on a legal value rather
 * than propagating. */
export function clampRuntimeSeconds(n: number): number {
  if (!Number.isFinite(n)) return RUNTIME_MIN_SECONDS
  const snapped = Math.round(n / RUNTIME_STEP_SECONDS) * RUNTIME_STEP_SECONDS
  return Math.min(RUNTIME_MAX_SECONDS, Math.max(RUNTIME_MIN_SECONDS, snapped))
}

/** "45s" / "2m" / "2m 30s" -- minutes read faster than 150s once past a minute. */
export function formatRuntime(seconds: number): string {
  const n = Math.round(seconds)
  if (n < 60) return `${n}s`
  const m = Math.floor(n / 60)
  const rem = n % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}

// ── the two-pass planner's own constants ────────────────────────────────

/**
 * The seconds `allocateBeatSeconds` guarantees every beat, however small its
 * `weight` — so a barely-there beat is never squeezed to zero seconds and
 * dropped from the film entirely.
 *
 * Deliberately NOT "one shot's own minimum" (`MIN_SHOT_SECONDS` below) — this
 * floor has to stay honourable at the SLIDER's own extremes: a complete story
 * tops out around 12 beats (see `BEAT_LIST_TEMPLATE`), and the slider's own
 * floor is `RUNTIME_MIN_SECONDS` (15s). 12 beats x 1s = 12s already fits
 * inside 15s with room to spare, while 12 x `MIN_SHOT_SECONDS` (2s) = 24s
 * would not — so this is its own, smaller constant rather than reusing that
 * one. `allocateBeatSeconds` still degrades gracefully (scales every floor
 * down by the same factor) on the rare input that beats this constant.
 */
export const BEAT_FLOOR_SECONDS = 1

/**
 * A single shot's own sane bounds for the PASS 2 subdivide call
 * (`SHOT_SUBDIVIDE_TEMPLATE`) — distinct from `MIN_CLIP_SECONDS`/
 * `MAX_CLIP_SECONDS` above, which bound a GROUP of shots once packed into one
 * clip. A shot itself can be shorter than a whole clip (several pack into
 * one), so its floor is looser than a clip's: 2s is short enough to still
 * read as a distinct beat of screen time and no shorter. Its ceiling is
 * capped at `MAX_CLIP_SECONDS` — a single one-shot clip is the longest any
 * one shot plausibly needs to be before it would force its own clip anyway.
 */
export const MIN_SHOT_SECONDS = 2
export const MAX_SHOT_SECONDS = MAX_CLIP_SECONDS

/**
 * How many shots one subdivide call is safely trusted to author in a single
 * reply — mid-point of the brief's own "around 12-15 shots" guidance. This is
 * a defensive PLANNING cap (`planSubdivisionWindows` uses it to decide how
 * many windows a beat's budget needs), not a measured token ceiling for any
 * particular model — there is no such measurement to read off here, so the
 * mid-point of the stated safe range is the honest choice.
 */
export const WINDOW_SHOT_CAP = 14

/**
 * How much screen time one beat can plausibly fill without padding —
 * `MAX_CLIP_SECONDS` (~20s): the longest a single un-padded clip runs, and
 * therefore the longest a single un-padded MOVEMENT of the story plausibly
 * needs before it is really two movements, not one. `beats.length *
 * NATURAL_SECONDS_PER_BEAT` is this many beats' longest natural runtime.
 */
export const NATURAL_SECONDS_PER_BEAT = MAX_CLIP_SECONDS

/**
 * How far past the natural pace counts as "padding" rather than "generous
 * pacing" — 2x: a beat asked to fill twice its most generous natural length
 * is being stretched, not just given room to breathe. See `checkThinBrief`.
 */
export const PADDING_FACTOR = 2

/** Internal precision for the largest-remainder apportionment below — tenths
 * of a second. Real-valued seconds are rounded to this grid before the
 * integer remainder step, so "sums exactly" means exactly on THIS grid, never
 * a raw float sum that can drift by fractions of a millisecond. */
const SECOND_UNITS = 10

/**
 * Turn a list of real-valued "ideal" unit counts into integers that sum to
 * exactly `totalUnits` — the classic largest-remainder / Hamilton
 * apportionment method: take each ideal's integer part, then hand the leftover
 * units one each to the entries with the largest fractional part, ties broken
 * by ascending original position. Deterministic (a stable sort, not
 * insertion-order-dependent) and used by both `allocateBeatSeconds` (seconds
 * per beat) and `planSubdivisionWindows` (seconds per window) so both share
 * one rounding rule rather than two that could drift apart.
 */
function apportionByLargestRemainder(idealUnits: readonly number[], totalUnits: number): number[] {
  const base = idealUnits.map((u) => Math.floor(u))
  const used = base.reduce((a, b) => a + b, 0)
  const remainder = Math.max(0, Math.round(totalUnits - used))
  const order = idealUnits
    .map((u, i) => ({ i, frac: u - Math.floor(u) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i)
  const result = [...base]
  for (let k = 0; k < remainder && k < order.length; k++) result[order[k].i] += 1
  return result
}

/**
 * Distribute `maxRuntimeSeconds` across `beats`, proportional to `weight`,
 * summing EXACTLY to the ceiling.
 *
 * Two branches, both ending in the SAME `apportionByLargestRemainder` call so
 * the "sums exactly" guarantee never depends on which branch ran:
 *
 * - Normal case (floors fit inside the ceiling): every beat gets its floor,
 *   then the REMAINING seconds are split proportional to `weight`.
 * - Degenerate case (floors alone exceed the ceiling — an unusually large
 *   beat count against a very short runtime): nothing here can invent
 *   seconds, so every floor is scaled down by the SAME factor rather than
 *   protecting some beats' floor at another's expense.
 *
 * A beat with `weight <= 0` (malformed model output) is treated as weight 0,
 * not dropped — it still clears the floor, it simply gets none of the
 * proportional remainder.
 */
export function allocateBeatSeconds(
  beats: readonly Beat[],
  maxRuntimeSeconds: number,
  opts: { floorSeconds?: number } = {},
): AllocatedBeat[] {
  const n = beats.length
  if (n === 0) return []
  const floorSeconds = opts.floorSeconds ?? BEAT_FLOOR_SECONDS
  const totalUnits = Math.max(0, Math.round(maxRuntimeSeconds * SECOND_UNITS))
  const floorUnits = Math.round(floorSeconds * SECOND_UNITS)
  const totalFloorUnits = floorUnits * n
  const weights = beats.map((b) => Math.max(0, b.weight) || 0)
  const sumWeights = weights.reduce((a, b) => a + b, 0)

  let idealUnits: number[]
  if (totalFloorUnits <= totalUnits) {
    const remaining = totalUnits - totalFloorUnits
    idealUnits = sumWeights > 0
      ? weights.map((w) => floorUnits + (remaining * w) / sumWeights)
      : beats.map(() => floorUnits + remaining / n) // no signal from weight at all — split the remainder evenly
  } else {
    const scale = totalUnits / totalFloorUnits
    idealUnits = beats.map(() => floorUnits * scale)
  }

  const units = apportionByLargestRemainder(idealUnits, totalUnits)
  return beats.map((b, i) => ({ ...b, seconds: units[i] / SECOND_UNITS }))
}

/**
 * Split `totalSeconds` into as many roughly-equal WINDOWS as it takes to
 * keep every one of them safely under `capShots` shots, worst case (every
 * shot in it authored at `minShotSeconds`, the shortest legal length) — the
 * mechanism that keeps ANY one subdivide call bounded regardless of how much
 * runtime a beat was allocated. A 600s beat does not become one 600s ask; it
 * becomes several calls whose sizes this function decides.
 *
 * Windows are split as evenly as the tenths grid allows (largest-remainder
 * again), not "N-1 full windows plus a small stub" — a stub window still
 * costs a full model round trip for very little shot list, so spreading the
 * total evenly is strictly better use of the same number of calls.
 */
export function planSubdivisionWindows(
  totalSeconds: number,
  opts: { minShotSeconds?: number; capShots?: number } = {},
): number[] {
  if (totalSeconds <= 0) return []
  const minShotSeconds = opts.minShotSeconds ?? MIN_SHOT_SECONDS
  const capShots = opts.capShots ?? WINDOW_SHOT_CAP
  const maxWindowSeconds = capShots * minShotSeconds
  const windowCount = Math.max(1, Math.ceil(totalSeconds / maxWindowSeconds))
  const totalUnits = Math.round(totalSeconds * SECOND_UNITS)
  const idealUnits = Array.from({ length: windowCount }, () => totalUnits / windowCount)
  const units = apportionByLargestRemainder(idealUnits, totalUnits)
  return units.map((u) => u / SECOND_UNITS)
}

// ── the honest limit: a thin brief padded out to a long runtime ─────────

export interface ThinBriefCheck {
  /** The longest runtime this many beats can fill without padding — see
   * `NATURAL_SECONDS_PER_BEAT`. */
  naturalSeconds: number
  maxRuntimeSeconds: number
  /** True once the operator's ceiling asks for more than `PADDING_FACTOR`
   * times what the beats can naturally fill. REPORTED, same contract as
   * `RuntimeCeilingCheck` — see `checkRuntimeCeiling`'s own module comment —
   * never a block on continuing. */
  isThin: boolean
}

/**
 * Whether this many beats, at this runtime, would need padding to fill —
 * checked right after PASS 1 lands, before any PASS 2 call is made, so the
 * operator sees this BEFORE any of pass 2's GPU time is spent, not after a
 * long subdivide run produces a padded film. See `state.tsx`'s
 * `continueSubdivision` for why this pauses the flow rather than merely
 * annotating a result the operator has to notice.
 */
export function checkThinBrief(beats: readonly Beat[], maxRuntimeSeconds: number): ThinBriefCheck {
  const naturalSeconds = beats.length * NATURAL_SECONDS_PER_BEAT
  return { naturalSeconds, maxRuntimeSeconds, isThin: maxRuntimeSeconds > naturalSeconds * PADDING_FACTOR }
}

function sumSeconds(shots: readonly Shot[], indices: readonly number[]): number {
  const byIndex = new Map(shots.map((s) => [s.index, s.seconds]))
  return indices.reduce((sum, i) => sum + (byIndex.get(i) ?? 0), 0)
}

export interface ShotGroupingResult {
  groups: ShotGroup[]
  /** Problems the grouping could not avoid — a single shot alone over the
   * ceiling (it can't be split further), or a trailing group under the floor
   * with nothing left to merge into. Never thrown: same disclosure shape as
   * `geometry.ts`'s `oomRisk` — a real hazard, reported for the operator to
   * fix (trim or move a shot), never a hard block that decides for them. */
  issues: string[]
}

/**
 * Pack consecutive shots into clip-sized groups.
 *
 * Greedy, in shot order: keep adding the next shot to the current group
 * while doing so stays within the ceiling AND gets no further from the
 * target than stopping would; otherwise close the group and start a new one.
 * A shot is only ever appended whole — there is no partial membership, so a
 * group's `shotIndices` is always a contiguous run and no shot is ever split.
 *
 * After the greedy pass, a trailing group under the floor is merged
 * backward into its predecessor when that does not itself breach the
 * ceiling — "prefer a grouping that keeps clips near 15s over one that
 * leaves a stub at the end" (the brief) is exactly this: a short last group
 * is worse than one slightly over target, so it is folded in rather than
 * left standing alone.
 */
export function groupShotsIntoClips(
  shots: readonly Shot[],
  opts: { targetSeconds?: number; minSeconds?: number; maxSeconds?: number } = {},
): ShotGroupingResult {
  const target = opts.targetSeconds ?? TARGET_CLIP_SECONDS
  const min = opts.minSeconds ?? MIN_CLIP_SECONDS
  const max = opts.maxSeconds ?? MAX_CLIP_SECONDS
  const issues: string[] = []
  if (!shots.length) return { groups: [], issues }

  const ordered = [...shots].sort((a, b) => a.index - b.index)

  const buckets: number[][] = []
  let current: number[] = []
  let currentSeconds = 0

  const closeCurrent = () => {
    if (current.length) buckets.push(current)
  }

  for (const shot of ordered) {
    if (!current.length) {
      current = [shot.index]
      currentSeconds = shot.seconds
      continue
    }
    const withShot = currentSeconds + shot.seconds
    const worthAdding = withShot <= target || Math.abs(target - withShot) <= Math.abs(target - currentSeconds)
    if (withShot <= max && worthAdding) {
      current.push(shot.index)
      currentSeconds = withShot
    } else {
      closeCurrent()
      current = [shot.index]
      currentSeconds = shot.seconds
    }
  }
  closeCurrent()

  // Fold a too-short trailing group into its predecessor when that stays
  // within the ceiling — see the module comment above.
  while (buckets.length >= 2) {
    const last = buckets[buckets.length - 1]
    if (sumSeconds(ordered, last) >= min) break
    const prev = buckets[buckets.length - 2]
    if (sumSeconds(ordered, prev) + sumSeconds(ordered, last) > max) break
    buckets[buckets.length - 2] = [...prev, ...last]
    buckets.pop()
  }

  const groups: ShotGroup[] = buckets.map((shotIndices, i) => ({
    index: i + 1,
    shotIndices,
    seconds: +sumSeconds(ordered, shotIndices).toFixed(3),
  }))

  for (const g of groups) {
    const shotWord = g.shotIndices.length > 1 ? 'shots' : 'shot'
    if (g.seconds > max) {
      issues.push(
        `clip ${g.index} (${shotWord} ${g.shotIndices.join(',')}) is ${g.seconds.toFixed(1)}s — over the ${max.toFixed(1)}s ceiling; a shot can't be split, so shorten it.`,
      )
    }
    if (g.seconds < min) {
      issues.push(
        `clip ${g.index} (${shotWord} ${g.shotIndices.join(',')}) is ${g.seconds.toFixed(1)}s — under the ${min.toFixed(1)}s floor, with nowhere left to merge it.`,
      )
    }
  }

  return { groups, issues }
}

// ── what the film is called ─────────────────────────────────────────────

/**
 * A default project name from the film's own spine — the opening few words,
 * so an operator who never names a film still finds
 * `video/A_lighthouse_keeper_loses_the_light_00001_.mp4` on the box rather
 * than `video/Untitled_00001_.mp4`.
 *
 * Deliberately NOT slugified here: this returns a human name, and
 * `filmOutputPrefix` (`extender.ts`) owns every decision about what is safe
 * in a path. Keeping the two apart means the name shown in the UI and the
 * name on disk can never drift into two different sanitising rules.
 */
export function deriveFilmName(spine: string | undefined): string {
  if (!spine) return ''
  return spine.trim().split(/\s+/).slice(0, 8).join(' ')
}

// ── the runtime ceiling, as a checkable fact ────────────────────────────

/** How far under the ceiling counts as a real shortfall rather than
 * rounding noise — a FRACTION of the ceiling, not a flat number of seconds,
 * since "a few seconds short" means something different at 15s than at
 * 600s. 15%: the bug this exists to catch undershot by two-thirds (105s of
 * a 300s ceiling), and this codebase's own idea of "noise" is a couple of
 * seconds on a 300s ceiling (under 1%) — 15% sits with a wide margin on
 * both sides of that gap. */
const SIGNIFICANT_UNDERRUN_FRACTION = 0.15

export interface RuntimeCeilingCheck {
  totalSeconds: number
  maxRuntimeSeconds: number
  withinCeiling: boolean
  overBySeconds: number
  /** How far short of the ceiling the authored total sits — 0 once it meets
   * or passes the ceiling. Always the complement of `overBySeconds`: exactly
   * one of the two is non-zero (or both are zero, exactly on the ceiling). */
  underBySeconds: number
  /**
   * True once `underBySeconds` clears `SIGNIFICANT_UNDERRUN_FRACTION` of the
   * ceiling — the fact `ceilingAlert` surfaces for the "5 minutes asked for,
   * 7 clips (~105s) delivered" bug, which `withinCeiling` alone stayed
   * silent about (0 overshoot IS within ceiling; it says nothing about how
   * far short of it the total landed).
   */
  significantlyUnder: boolean
}

/**
 * Authored total vs. the operator's ceiling — REPORTED, never refused, in
 * BOTH directions.
 *
 * The template states the ceiling as a two-directional TARGET now (see
 * `SHOT_SUBDIVIDE_TEMPLATE`'s "land ON it, in either direction"), but nothing
 * stops the model missing it either way, and refusing the whole shot list
 * over a miss would throw away an otherwise-usable plan the operator can fix
 * by hand. `geometry.ts`'s `oomRisk` is this codebase's own precedent for the
 * shape: a real hazard disclosed as a fact the operator acts on, never a
 * block that decides for them. `withinCeiling` keeps its EXACT original
 * meaning (`overBySeconds === 0`) — this only adds fields, it never changes
 * what a caller already reading `withinCeiling` sees.
 */
export function checkRuntimeCeiling(shots: readonly Shot[], maxRuntimeSeconds: number): RuntimeCeilingCheck {
  const totalSeconds = +shots.reduce((sum, s) => sum + s.seconds, 0).toFixed(3)
  const overBySeconds = Math.max(0, +(totalSeconds - maxRuntimeSeconds).toFixed(3))
  const underBySeconds = Math.max(0, +(maxRuntimeSeconds - totalSeconds).toFixed(3))
  const significantlyUnder = maxRuntimeSeconds > 0 && underBySeconds / maxRuntimeSeconds > SIGNIFICANT_UNDERRUN_FRACTION
  return { totalSeconds, maxRuntimeSeconds, withinCeiling: overBySeconds === 0, overBySeconds, underBySeconds, significantlyUnder }
}

// ── revising the shot list from a cut ───────────────────────────────────

/**
 * Keep every shot before `cutIndex`; replace everything from it on with a
 * freshly authored tail — "changing the plot from shot N onward regenerates
 * the unexpanded shot list from N forward only" (the brief).
 *
 * `freshShots` is whatever the next `shots` model call returns for the tail;
 * its own `index` values are ignored and overwritten here so the merged list
 * stays one clean, contiguous 1-based sequence regardless of what the model
 * echoed (the same defensive coercion `parseBreakdown`/`parseShotList`
 * already apply to a model's numbering).
 */
export function reviseShotsFromIndex(shots: readonly Shot[], cutIndex: number, freshShots: readonly Shot[]): Shot[] {
  const kept = shots.filter((s) => s.index < cutIndex)
  const tail = freshShots.map((s, i) => ({ ...s, index: cutIndex + i }))
  return [...kept, ...tail]
}

/** Which beat (`Beat.index`) covers `shotIndex` — read off the shot AT or
 * AFTER `shotIndex` that sits closest to it, so a cut landing in a gap (past
 * the last authored shot) still resolves sensibly. `undefined` when no shot
 * at or after `shotIndex` exists (the cut is past everything authored so
 * far — nothing to re-subdivide). */
export function beatOfShotIndex(shots: readonly Shot[], shotIndex: number): number | undefined {
  const candidates = shots.filter((s) => s.index >= shotIndex).sort((a, b) => a.index - b.index)
  return candidates[0]?.beatIndex
}

export interface ReviseSubdivisionPlan {
  /** Shots before the cut, untouched — same array `reviseShotsFromIndex`
   * would keep. */
  keptShots: Shot[]
  /**
   * The beats PASS 2 must re-run: the beat the cut lands inside (if any) and
   * every beat after it. A beat entirely before the cut is never touched —
   * "re-subdivide only the beats at or after the cut" (the brief) — so this
   * never regenerates a beat whose shots the operator already approved of.
   */
  beatsToResubdivide: AllocatedBeat[]
  /**
   * The kept shots that belong to the SAME beat as the cut — not a whole
   * extra beat, just the fragment of it the operator is keeping. Handed back
   * to `subdivideBeat` as `priorShots` so its "already decided, don't
   * repeat" hint covers them, and its target seconds for that one beat
   * should be reduced by their total (the caller's job — see
   * `state.tsx`'s `reviseShotsFrom`).
   */
  alreadyForCutBeat: Shot[]
}

/**
 * Plan a plot revision "from shot N" at the BEAT granularity the two-pass
 * planner now works in — DECIDED HERE, not left ambiguous: cutting still
 * happens at the exact SHOT index the operator chose (`keptShots` keeps
 * everything before it, same as `reviseShotsFromIndex` always has), never
 * rounded up to the start of whatever beat that shot sits in. Rounding up
 * would discard already-good shots earlier in the same beat purely because
 * they share a beat with the one being cut — strictly more destructive than
 * necessary, and less operator control than the shot-level cut already
 * offered before beats existed. What DOES move to beat granularity is which
 * PASS 2 calls get re-run: the beat containing the cut is resumed (its
 * pre-cut shots passed back as `alreadyForCutBeat`, its budget reduced by
 * their seconds), and every beat after it is redone in full — PASS 1 itself
 * never re-runs, so beats the operator has not touched keep their `covers`
 * and their allocated seconds exactly as authored.
 */
export function planShotRevision(
  shots: readonly Shot[],
  beats: readonly AllocatedBeat[],
  cutShotIndex: number,
): ReviseSubdivisionPlan {
  const keptShots = shots.filter((s) => s.index < cutShotIndex)
  const cutBeatIndex = beatOfShotIndex(shots, cutShotIndex)
  if (cutBeatIndex === undefined) return { keptShots, beatsToResubdivide: [], alreadyForCutBeat: [] }
  return {
    keptShots,
    beatsToResubdivide: beats.filter((b) => b.index >= cutBeatIndex),
    alreadyForCutBeat: keptShots.filter((s) => s.beatIndex === cutBeatIndex),
  }
}

// ── invalidation: which already-rendered clips survive a cut ───────────

export interface ShotGroupCutResult {
  /** Groups entirely before the cut — untouched: same shots, same prompt,
   * same rendered clip. */
  survivingGroupIndices: number[]
  /** Groups that touch or follow the cut — discarded WHOLE, even the shots
   * of a straddled group that sit before the cut. */
  discardedGroupIndices: number[]
  /**
   * The lowest discarded group's own `index` — pass this straight to
   * `dropFromIndex(clips, nodeId, fromIndex)` (`filmEdit.ts`) to invalidate
   * exactly the rendered clips this cut can no longer trust. `undefined`
   * when the cut lands after every existing group (nothing to discard).
   */
  fromGroupIndex: number | undefined
}

/**
 * Which groups a cut at `cutShotIndex` (first shot NOT kept — see
 * `reviseShotsFromIndex`) leaves standing.
 *
 * A group survives only if every one of its shots is before the cut. A group
 * that straddles the cut (some shots before it, some at or after) is
 * discarded WHOLE, shots-before-the-cut included: the Master Extender's
 * validated-clip cache is a linear prefix per film (`filmEdit.ts`'s
 * `dropFromIndex`/`validatedClipAt`), so it cannot keep half of one clip
 * cached and re-render the other half — the founder has accepted this rule.
 * The shot-list layer and the clip layer therefore disagree on purpose:
 * `reviseShotsFromIndex` keeps a straddled group's early shots as authored
 * TEXT, while this function still discards that group's PROMPT and RENDER,
 * because those were built from the whole group, which no longer exists in
 * that shape.
 */
export function groupsAffectedByCut(groups: readonly ShotGroup[], cutShotIndex: number): ShotGroupCutResult {
  const surviving: number[] = []
  const discarded: number[] = []
  for (const g of groups) {
    const lastShotIndex = Math.max(...g.shotIndices)
    if (lastShotIndex < cutShotIndex) surviving.push(g.index)
    else discarded.push(g.index)
  }
  return {
    survivingGroupIndices: surviving,
    discardedGroupIndices: discarded,
    fromGroupIndex: discarded.length ? Math.min(...discarded) : undefined,
  }
}

// ── deriving a Breakdown from grouped shots ─────────────────────────────

/**
 * First/last/middle roles for `n` auto-derived groups. Never assigns
 * `'turn'`: `stages.ts`'s `nextRole` deliberately holds a chained clip at
 * `'rising'` until the operator advances it by hand, because "deciding that
 * a clip is the TURN is the one judgement a director must not have made for
 * them" — a batch derivation from shot groups has no more standing to make
 * that call than a hand-advanced chain does. The operator can still promote
 * one clip to `'turn'` by hand afterward, same as any other `BreakdownClip`
 * field.
 */
export function rolesForGroupCount(n: number): ClipRole[] {
  if (n <= 0) return []
  if (n === 1) return ['standalone']
  if (n === 2) return ['opening', 'closing']
  return ['opening', ...(Array(n - 2).fill('rising') as ClipRole[]), 'closing']
}

/**
 * One `BreakdownClip` per group — the shape every existing consumer
 * (`filmBlock`, `renderExtenderPlan`, `ClipPlan`) already expects, so a
 * derived plan clip is indistinguishable from one the old single-call
 * `breakdown` stage produced. `precedes`/`follows` are left empty: the shot
 * list carries no per-clip hand-off text, and `fillTemplate` already reads
 * an empty one as "no continuity fact stated" rather than "missing" (see
 * `filmBlock`'s optional `f.precedes ? ... : ''` branches).
 */
export function breakdownClipsFromShotGroups(shots: readonly Shot[], groups: readonly ShotGroup[]): BreakdownClip[] {
  const byIndex = new Map(shots.map((s) => [s.index, s]))
  const roles = rolesForGroupCount(groups.length)
  return groups.map((g, i) => {
    const covers = g.shotIndices
      .map((si) => byIndex.get(si)?.covers.trim())
      .filter((c): c is string => !!c)
      .join(' ')
    return {
      index: g.index,
      title: `Clip ${g.index}`,
      role: roles[i] ?? 'rising',
      seconds: g.seconds,
      covers,
      precedes: '',
      follows: '',
    }
  })
}

/** `breakdownClipsFromShotGroups` plus the film-level facts (`spine`, `at`)
 * a `Breakdown` also carries — the one call site a caller actually needs. */
export function breakdownFromShotList(shotList: ShotList, groups: readonly ShotGroup[]): Breakdown {
  return { spine: shotList.spine, clips: breakdownClipsFromShotGroups(shotList.shots, groups), at: shotList.at }
}

// ── asked vs. delivered ──────────────────────────────────────────────────

export interface ClipTiming {
  askedSeconds: number
  frames: number
  deliveredSeconds: number
}

/**
 * What a group's authored seconds actually deliver once H3 snaps to its
 * 17k+5 frame grid — reuses `geometry.ts`'s own grid math
 * (`framesForSeconds`/`secondsForFrames`) rather than re-deriving it: a
 * 15.2s ask came back 15.08s in a real render, and a UI needs both numbers
 * to show that honestly rather than just the round figure the operator typed.
 */
export function clipTiming(askedSeconds: number, fps = 24): ClipTiming {
  const frames = framesForSeconds(askedSeconds, fps)
  return { askedSeconds, frames, deliveredSeconds: secondsForFrames(frames, fps) }
}

// ── PASS 1 — the beats stage: template, schema, parser ─────────────────

/**
 * Pass 1's prompt template — the whole arc, coarse. Kept independent of
 * `stages.ts`'s `StageId`/`DEFAULT_TEMPLATES`/`fillTemplate` machinery on
 * purpose, same reasoning as the old single-call `shots` stage this
 * replaces (see the module comment): that machinery is wired to the
 * per-CLIP authoring chain (Direct/Draft/Critique/Revise, one call per
 * already-approved clip), and this is a whole-FILM, pre-grouping call that
 * isn't part of that chain at all.
 *
 * Deliberately says NOTHING about seconds or runtime — that is the whole
 * fix: a beat's length is `allocateBeatSeconds`'s job, decided AFTER this
 * call returns, off the operator's own ceiling. Asking this call to reason
 * about runtime at all would reopen the exact hole the two-pass rework
 * closes (a model bending beat COUNT to a duration it was never supposed to
 * see).
 */
export const BEAT_LIST_TEMPLATE = `Read the plot below and break it into BEATS for the whole film.

A beat is a distinct movement of the story — not a shot, and not every
fixed detail of a scene. A complete story is usually 6 to 12 beats, whether
the finished film runs 30 seconds or 30 minutes: the beat count follows the
STORY, never the runtime. Do not invent filler beats to make more of them,
and do not compress two distinct movements into one beat to make fewer.

DO NOT WRITE, at this stage:
- camera, lens, framing, or any shot-size vocabulary (close-up, wide, dolly, pan...)
- performance direction (gaze, breath, hands, timing, delivery)
- sound, music, or dialogue wording
- how long anything takes, in seconds — that is decided separately, after
  the beats exist, and is not this call's job

For each beat, decide:
- index (1-based, contiguous from 1)
- covers — what happens, in fixed elements only (see above)
- weight — a small positive number for how much SCREEN TIME this beat
  deserves relative to the others (not seconds, not a percentage — only its
  size next to the rest; a beat twice as consequential as another gets
  roughly twice the weight)

Also give the whole film's spine in one line.

Output ONLY a JSON object, no fences, no prose outside it, in exactly this
shape:

{
  "spine": "...",
  "beats": [
    { "index": 1, "covers": "...", "weight": 1 }
  ]
}

PLOT
{{plot}}`

export function fillBeatListTemplate(template: string, plot: string): string {
  return template.replace(/\{\{plot\}\}/g, plot).trim()
}

/** Pass 1's `response_format` — same flat, `strict: true` shape as
 * `schema.ts`'s `h3ResponseFormat`, so an endpoint that compiles JSON Schema
 * into a sampling grammar (llama.cpp) makes a malformed beat list
 * unreachable the same way it already does for the six H3 sections. */
export function beatListResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'beat_list',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['spine', 'beats'],
        properties: {
          spine: { type: 'string', description: "The whole film's spine, in one line." },
          beats: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'covers', 'weight'],
              properties: {
                index: { type: 'integer', description: '1-based position in the whole arc.' },
                covers: {
                  type: 'string',
                  description: 'What happens — who, where, what happens, how it ends. No camera, no performance, no sound, no seconds.',
                },
                weight: { type: 'number', description: 'Relative screen time next to the other beats — no units.' },
              },
            },
          },
        },
      },
    },
  }
}

/** Strip a ```json fence (or a bare ``` fence) around a reply, if present —
 * the same tolerant unwrap `stages.ts`'s `stripFence`/`parseBreakdown` apply,
 * duplicated locally rather than imported since neither is exported from
 * there. Shared by every parser in this file (beats, shots, and the
 * incremental parser below). */
function stripFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

/** Take from the first `{` to the last `}` of a (possibly fenced) reply and
 * `JSON.parse` it — the one substring-then-parse step every parser below
 * shares, so a truncated or chatty reply fails the same way everywhere. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripFence(raw.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1))
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Parse a `BeatList` out of a pass-1 reply — mirrors `stages.ts`'s
 * `parseBreakdown` (and the old `parseShotList` this supersedes) exactly:
 * validate and coerce the shape rather than trusting it, never throw.
 */
export function parseBeatList(raw: string): BeatList | null {
  const o = extractJsonObject(raw) as { spine?: unknown; beats?: unknown } | null
  if (!o) return null
  if (typeof o.spine !== 'string' || !Array.isArray(o.beats) || !o.beats.length) return null

  const beats: Beat[] = o.beats.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    return {
      index: Number(c.index) || i + 1,
      covers: typeof c.covers === 'string' ? c.covers.trim() : '',
      weight: Number(c.weight) || 0,
    }
  })

  return { spine: o.spine.trim(), beats, at: Date.now() }
}

// ── PASS 2 — the subdivide stage: template, schema, parser, windowed calls ─

/**
 * Pass 2's prompt template — one beat, decomposed into shots. Filled once
 * per WINDOW (see `planSubdivisionWindows`/`subdivideBeat`), never once per
 * whole beat, so `{{targetSeconds}}` is always one window's own share, not
 * the beat's full budget.
 *
 * The runtime line is deliberately two-directional ("as close as you can
 * get… in either direction") — the old `SHOT_LIST_TEMPLATE`'s one-directional
 * "no more than N seconds" is exactly what let a model stop early with no
 * instruction telling it that was wrong. And it is explicit that hitting the
 * target means a FINER OR COARSER grain of the SAME events, never new
 * events — the operator's own diagnosis of the bug this rework fixes.
 */
export const SHOT_SUBDIVIDE_TEMPLATE = `Read the beat below and decompose it into a SHOT LIST — covering exactly
what this beat covers, no more of the plot than that.

A shot is the smallest fixed unit of what happens — who, where, what
happens, how it ends. Nothing else.

DO NOT WRITE, at this stage:
- camera, lens, framing, or any shot-size vocabulary (close-up, wide, dolly, pan...)
- performance direction (gaze, breath, hands, timing, delivery)
- sound, music, or dialogue wording

Those all belong to the LATER per-clip expansion step, once shots are
grouped into clips and directed one clip at a time. Writing them here gets
overwritten, or drifts out of sync with what that step decides — leave them
out entirely.

THIS BEAT'S SHOTS MUST SUM TO {{targetSeconds}} SECONDS — AS CLOSE AS YOU
CAN GET. This is a TARGET, not a ceiling and not a floor: come in noticeably
short and you are skipping past events this beat should show; go noticeably
over and you are stealing screen time from the rest of the film. Land ON
it, in either direction.

Reach the target by showing the SAME events at a finer or coarser grain —
more or fewer shots, longer or shorter holds on each moment — never by
inventing events the plot does not contain.

Each shot's own length must be between {{minShotSeconds}} and
{{maxShotSeconds}} seconds.

For each shot, decide:
- index (1-based, starting at {{startIndex}}, contiguous from there)
- covers — what happens, in fixed elements only (see above)
- seconds — its own length

Output ONLY a JSON object, no fences, no prose outside it, in exactly this
shape:

{
  "shots": [
    { "index": {{startIndex}}, "covers": "...", "seconds": 4 }
  ]
}

THE FILM'S SPINE
{{spine}}

THIS BEAT
{{beatCovers}}{{already}}`

export interface ShotSubdivideTemplateParams {
  spine: string
  beatCovers: string
  targetSeconds: number
  minShotSeconds: number
  maxShotSeconds: number
  startIndex: number
  /** The "ALREADY DECIDED…" block (or `''`) — built by `subdivideBeat`, not
   * this function, since it needs the running list of shots already landed
   * for this beat, which this pure filler has no reason to know about. */
  already: string
}

export function fillShotSubdivideTemplate(template: string, p: ShotSubdivideTemplateParams): string {
  return template
    .replace(/\{\{spine\}\}/g, p.spine)
    .replace(/\{\{beatCovers\}\}/g, p.beatCovers)
    .replace(/\{\{targetSeconds\}\}/g, String(p.targetSeconds))
    .replace(/\{\{minShotSeconds\}\}/g, String(p.minShotSeconds))
    .replace(/\{\{maxShotSeconds\}\}/g, String(p.maxShotSeconds))
    .replace(/\{\{startIndex\}\}/g, String(p.startIndex))
    .replace(/\{\{already\}\}/g, p.already)
    .trim()
}

/** Pass 2's `response_format` — no `spine` (the caller already has it; this
 * call is scoped to one beat), otherwise the same flat, `strict: true` shape
 * as `beatListResponseFormat`/`schema.ts`'s `h3ResponseFormat`. */
export function shotSubdivideResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'subdivided_shots',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['shots'],
        properties: {
          shots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['index', 'covers', 'seconds'],
              properties: {
                index: { type: 'integer', description: '1-based position in the whole film.' },
                covers: {
                  type: 'string',
                  description: 'What happens — who, where, what happens, how it ends. No camera, no performance, no sound.',
                },
                seconds: { type: 'number', description: "This shot's own length, in seconds." },
              },
            },
          },
        },
      },
    },
  }
}

/**
 * Parse the shots out of a pass-2 reply. Same discipline as `parseBeatList`
 * — validate and coerce, never throw — but requires no `spine` field, and
 * returns a bare array rather than a wrapper object: this call's ENTIRE
 * output is its shots. `index`/`beatIndex` are both overwritten by the
 * caller (`subdivideBeat`) regardless of what comes back here, the same
 * defensive renumbering `reviseShotsFromIndex` already applies elsewhere —
 * so this parser's own `index` coercion only has to be non-throwing, not
 * correct.
 */
export function parseSubdividedShots(raw: string): Shot[] | null {
  const o = extractJsonObject(raw) as { shots?: unknown } | null
  if (!o) return null
  if (!Array.isArray(o.shots) || !o.shots.length) return null

  return o.shots.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    return {
      index: Number(c.index) || i + 1,
      covers: typeof c.covers === 'string' ? c.covers.trim() : '',
      seconds: Number(c.seconds) || 0,
    }
  })
}

/** One subdivide call's own identity, for progress reporting — everything a
 * caller (`state.tsx`'s `DraftingStatus` wiring) needs to show "beat 3 of 8,
 * window 1 of 2" without threading four separate numbers through its own
 * closures. */
export interface SubdivideCallContext {
  beat: AllocatedBeat
  /** 1-based position among the beats THIS RUN is processing — not
   * necessarily `beat.index` itself, since a revision only resubdivides a
   * suffix of the full beat list (see `planShotRevision`). */
  beatOrdinal: number
  /** How many beats this run is processing — same caveat as `beatOrdinal`. */
  beatCount: number
  /** 0-based position among this ONE beat's windows. */
  windowIndex: number
  windowCount: number
}

/** The model call itself, injected — `subdivideBeat`/`subdivideAllBeats`
 * never import `llm.ts`/`providers.ts`: they hand back the fully-filled
 * prompt text and a `SubdivideCallContext` and expect the raw reply text
 * back, so every model-specific concern (which provider, streaming
 * callbacks, abort signals, GPU locking) stays in `state.tsx`, and this file
 * stays testable with a synchronous fake. */
export type ShotSubdivideCall = (user: string, ctx: SubdivideCallContext) => Promise<string>

/** Render the "ALREADY DECIDED FOR THIS BEAT" block `subdivideBeat` inserts
 * once a beat has any shots (from a previous window, or handed in as
 * `priorShots` when resuming a beat after a cut) — same idea as
 * `state.tsx`'s old `reviseShotsFrom`'s "SHOTS 1-N ARE ALREADY DECIDED"
 * block, generalised to any list of already-authored shots. */
function alreadyDecidedBlock(decided: readonly Shot[], nextIndex: number): string {
  if (!decided.length) return ''
  const lines = decided.map((s) => `${s.index}. ${s.covers} (${s.seconds}s)`).join('\n')
  return `\n\nALREADY DECIDED FOR THIS BEAT — do not repeat them; continue with fresh shots from index ${nextIndex} on:\n${lines}`
}

export interface SubdivideBeatOptions {
  minShotSeconds?: number
  maxShotSeconds?: number
  capShots?: number
  template?: string
  /** Shots already decided for this beat BEFORE this call runs — a revision
   * resuming a partially-cut beat (`planShotRevision`'s `alreadyForCutBeat`)
   * passes these so they show up in the "already decided" hint even though
   * this call itself produced none of them yet. Empty for a fresh beat. */
  priorShots?: readonly Shot[]
  /** Passthrough only, for `SubdivideCallContext` — see its own module
   * comment. Default 1/1 so calling this directly (a test, or
   * `planShotRevision`'s resumed beat) never has to invent numbers that mean
   * nothing to a single-beat call. */
  beatOrdinal?: number
  beatCount?: number
}

/**
 * Decompose ONE beat into shots — pass 2's whole job for that beat.
 *
 * Splits `beat.seconds` into bounded windows (`planSubdivisionWindows`) and
 * calls `call` once per window, IN ORDER (never in parallel — the caller's
 * GPU is single-flighted, same discipline `state.tsx`'s existing per-clip
 * chain already keeps), feeding each window everything decided so far for
 * this beat (`priorShots` plus every earlier window's own shots) as the
 * "already decided" hint. `index` is renumbered contiguously from
 * `startIndex` regardless of what the model echoed, and every returned shot
 * is stamped with `beatIndex: beat.index` so a later revision
 * (`planShotRevision`) can find its way back to the beat it came from.
 */
export async function subdivideBeat(
  beat: AllocatedBeat,
  startIndex: number,
  spine: string,
  call: ShotSubdivideCall,
  opts: SubdivideBeatOptions = {},
): Promise<Shot[]> {
  const minShotSeconds = opts.minShotSeconds ?? MIN_SHOT_SECONDS
  const maxShotSeconds = opts.maxShotSeconds ?? MAX_SHOT_SECONDS
  const template = opts.template ?? SHOT_SUBDIVIDE_TEMPLATE
  const priorShots = opts.priorShots ?? []
  const windows = planSubdivisionWindows(beat.seconds, { minShotSeconds, capShots: opts.capShots })

  const shots: Shot[] = []
  let nextIndex = startIndex
  for (let w = 0; w < windows.length; w++) {
    const decidedSoFar = [...priorShots, ...shots]
    const user = fillShotSubdivideTemplate(template, {
      spine,
      beatCovers: beat.covers,
      targetSeconds: windows[w],
      minShotSeconds,
      maxShotSeconds,
      startIndex: nextIndex,
      already: alreadyDecidedBlock(decidedSoFar, nextIndex),
    })
    const raw = await call(user, {
      beat,
      beatOrdinal: opts.beatOrdinal ?? 1,
      beatCount: opts.beatCount ?? 1,
      windowIndex: w,
      windowCount: windows.length,
    })
    const won = parseSubdividedShots(raw)
    if (!won || !won.length) {
      throw new Error(`Beat ${beat.index}, window ${w + 1} of ${windows.length}: could not parse shots from the reply.`)
    }
    const renumbered = won.map((s, i) => ({ ...s, index: nextIndex + i, beatIndex: beat.index }))
    shots.push(...renumbered)
    nextIndex += renumbered.length
  }
  return shots
}

export interface SubdivideAllBeatsOptions extends Omit<SubdivideBeatOptions, 'beatOrdinal' | 'beatCount' | 'priorShots'> {
  /** First shot index to assign — 1 for a fresh film, `cutShotIndex` when
   * resuming after a revision. */
  startIndex?: number
  /** `priorShots` for the FIRST beat only (`beats[0]`) — a revision resuming
   * a partially-cut beat. Every later beat in `beats` is fresh. */
  priorShotsForFirstBeat?: readonly Shot[]
  /** Fired once a beat's shots have all landed — `state.tsx` uses this to
   * grow the operator-visible "shots authored so far" list one beat at a
   * time, which is the concrete fix for "shows no progress state" (the
   * founder's own complaint about the single-call version): every beat that
   * finishes is visible immediately, not just the film as a whole once
   * every beat is done. */
  onBeatDone?: (beat: AllocatedBeat, beatShots: readonly Shot[], allShotsSoFar: readonly Shot[]) => void
}

/**
 * Run `subdivideBeat` over every beat in order, threading `startIndex`
 * through so the whole film's shots come back contiguously numbered with no
 * further renumbering needed. This is the ONE function `state.tsx` calls for
 * both a fresh `makeShotList` (all beats) and a revision's re-subdivide
 * (`planShotRevision`'s `beatsToResubdivide` — a suffix of the beats, with
 * `priorShotsForFirstBeat` covering the fragment already kept from the cut
 * beat).
 */
export async function subdivideAllBeats(
  beats: readonly AllocatedBeat[],
  spine: string,
  call: ShotSubdivideCall,
  opts: SubdivideAllBeatsOptions = {},
): Promise<Shot[]> {
  let nextIndex = opts.startIndex ?? 1
  const shots: Shot[] = []
  for (let i = 0; i < beats.length; i++) {
    const beat = beats[i]
    const priorShots = i === 0 ? opts.priorShotsForFirstBeat : undefined
    const beatShots = await subdivideBeat(beat, nextIndex, spine, call, {
      minShotSeconds: opts.minShotSeconds,
      maxShotSeconds: opts.maxShotSeconds,
      capShots: opts.capShots,
      template: opts.template,
      priorShots,
      beatOrdinal: i + 1,
      beatCount: beats.length,
    })
    shots.push(...beatShots)
    nextIndex += beatShots.length
    opts.onBeatDone?.(beat, beatShots, shots)
  }
  return shots
}

// ── incremental parsing, for a shot list still arriving ─────────────────

/**
 * Find the end (exclusive) of the balanced `{...}` object starting at
 * `text[from]` (which must be `'{'`), respecting string literals (so a brace
 * inside a `covers` string is never mistaken for structure) and backslash
 * escapes inside them. Returns `null` when the object never closes within
 * `text` — the caller's signal that this is the trailing, still-arriving
 * object, not a complete one.
 */
function balancedObjectEnd(text: string, from: number): number | null {
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return null
}

/** JSON's own escape-sequence meanings, for `partialSpine`'s char-by-char
 * unescape (a `\uXXXX` escape is passed through raw rather than decoded —
 * a spine has no real use for one, and decoding it right would need its own
 * four-digit lookahead for no practical gain here). */
const JSON_ESCAPES: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', n: '\n', t: '\t', r: '\r', b: '\b', f: '\f' }

/** The complete `"spine": "..."` value, or `''` while it is still arriving
 * (an unterminated string) or absent (a pass-2 reply carries no `spine` at
 * all — see `shotSubdivideResponseFormat`). Deliberately narrow: it only
 * reads a plain JSON string value, same as `parseBeatList` trusts the model
 * for. */
function partialSpine(text: string): string {
  const m = text.match(/"spine"\s*:\s*"/)
  if (!m || m.index === undefined) return ''
  let out = ''
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      const next = text[i + 1]
      if (next === undefined) break // escape cut off mid-stream — still arriving
      out += JSON_ESCAPES[next] ?? next
      i++
      continue
    }
    if (ch === '"') return out // closed
    out += ch
  }
  return '' // never closed — still arriving
}

/**
 * Read `{ spine, shots }` out of a reply that may still be streaming in —
 * shared by BOTH passes' live progress display (`shotStreaming.text` in
 * `state.tsx`): a pass-1 reply's `"beats"` key never matches the `"shots"`
 * scan below, so this simply shows no shots yet while beats are still being
 * authored (`partialSpine` alone still lights up, since pass 1 carries a
 * `spine` too); a pass-2 reply has `"shots"` but no `"spine"`, so `spine`
 * comes back `''`, which every caller already treats as "not shown yet".
 *
 * Pure and total: never throws, on anything from an empty string to raw
 * garbage. Scans for `"shots": [` and then walks the array taking only
 * OBJECTS THAT HAVE FULLY CLOSED — via `balancedObjectEnd` — parsing each one
 * on its own with a plain `JSON.parse` (a single small, complete object, so
 * this never needs a second schema). The first object that has not closed
 * yet (the trailing, still-arriving one) stops the scan; it is not returned
 * half-built, matching the brief's "a partial trailing object is simply not
 * shown yet."
 *
 * On a COMPLETE pass-2 reply this returns exactly what `parseSubdividedShots`
 * would, wrapped with whatever `spine` (if any) the text carries.
 */
export function parsePartialShotList(raw: string): { spine: string; shots: Shot[] } {
  const text = stripFence(raw)
  const spine = partialSpine(text)

  const shotsKey = text.match(/"shots"\s*:\s*\[/)
  if (!shotsKey || shotsKey.index === undefined) return { spine, shots: [] }

  const shots: Shot[] = []
  let i = shotsKey.index + shotsKey[0].length
  let nextIndex = 1
  for (;;) {
    while (i < text.length && /[\s,]/.test(text[i])) i++
    if (i >= text.length || text[i] !== '{') break
    const end = balancedObjectEnd(text, i)
    if (end === null) break // the trailing, still-arriving object — stop here
    const objText = text.slice(i, end)
    try {
      const parsed = JSON.parse(objText) as Record<string, unknown>
      shots.push({
        index: Number(parsed.index) || nextIndex,
        covers: typeof parsed.covers === 'string' ? parsed.covers.trim() : '',
        seconds: Number(parsed.seconds) || 0,
      })
    } catch {
      // A complete-looking object that still didn't parse (stray control
      // character, etc.) — skip it rather than aborting the whole scan.
    }
    nextIndex++
    i = end
  }
  return { spine, shots }
}
