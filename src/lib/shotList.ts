import type { Breakdown, BreakdownClip, ClipRole, Shot, ShotGroup, ShotList } from './types'
import { SCENE_LENGTH_CHIPS } from './filmDisplay'
import { framesForSeconds, secondsForFrames } from './geometry'

/**
 * Full Story mode — the shot-list stage and the pure grouping/revision logic
 * that sits between it and the existing per-clip expansion path.
 *
 * The flow (founder-approved design, 2026-09-17): a plot + a maximum runtime
 * go into ONE model call that returns a `ShotList` — per shot, bare "what
 * happens" and a duration, no camera/performance/sound. Shots are then
 * PACKED into `ShotGroup`s targeting ~15s each, by pure arithmetic here, not
 * a second model call. One approved group becomes one `BreakdownClip`, which
 * then goes through the EXISTING per-clip expansion path (`Direct`/`Draft` in
 * `stages.ts`) completely unchanged — this file never writes camera,
 * performance or sound itself, and never builds an H3 prompt.
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

export interface RuntimeCeilingCheck {
  totalSeconds: number
  maxRuntimeSeconds: number
  withinCeiling: boolean
  overBySeconds: number
}

/**
 * Authored total vs. the operator's ceiling — REPORTED, never refused.
 *
 * The template states the ceiling as a hard constraint (see
 * `SHOT_LIST_TEMPLATE`), but nothing stops the model overshooting it, and
 * refusing the whole shot list over a few seconds of overshoot would throw
 * away an otherwise-usable plan the operator can fix in seconds by trimming
 * one shot's `seconds`. `geometry.ts`'s `oomRisk` is this codebase's own
 * precedent for the shape: a real hazard disclosed as a fact the operator
 * acts on, never a block that decides for them.
 */
export function checkRuntimeCeiling(shots: readonly Shot[], maxRuntimeSeconds: number): RuntimeCeilingCheck {
  const totalSeconds = +shots.reduce((sum, s) => sum + s.seconds, 0).toFixed(3)
  const overBySeconds = Math.max(0, +(totalSeconds - maxRuntimeSeconds).toFixed(3))
  return { totalSeconds, maxRuntimeSeconds, withinCeiling: overBySeconds === 0, overBySeconds }
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

// ── the shots authoring stage: template, schema, parser ────────────────

/**
 * The shots stage's prompt template. Kept independent of `stages.ts`'s
 * `StageId`/`DEFAULT_TEMPLATES`/`fillTemplate` machinery on purpose: that
 * machinery is wired to the per-CLIP authoring chain (Direct/Draft/Critique/
 * Revise, one call per already-approved clip), and folding a whole-FILM,
 * pre-grouping call into the same `Record<StageId, ...>` tables would force
 * every one of those tables (and the UI that reads them, e.g.
 * `SettingsPanel`'s editable-stage list) to grow a case for a stage that
 * isn't part of that chain at all. Wiring `shots` into the operator-facing
 * UI is the later screens task's job; this is the plain template + schema
 * it will call `fillShotListTemplate`/`shotListResponseFormat` with.
 */
export const SHOT_LIST_TEMPLATE = `Read the plot below and break it into a SHOT LIST for the whole film.

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

THE RUNTIME CEILING IS A HARD CONSTRAINT: the shots' seconds must sum to no
more than {{maxRuntimeSeconds}} seconds, total, for the whole film. If the
plot cannot fit, cut or compress events — do not quietly go over.

For each shot, decide:
- index (1-based, contiguous from 1)
- covers — what happens, in fixed elements only (see above)
- seconds — its own target length

Also give the whole film's spine in one line.

Output ONLY a JSON object, no fences, no prose outside it, in exactly this
shape:

{
  "spine": "...",
  "shots": [
    { "index": 1, "covers": "...", "seconds": 4 }
  ]
}

MAXIMUM RUNTIME: {{maxRuntimeSeconds}} seconds

PLOT
{{plot}}`

export function fillShotListTemplate(template: string, plot: string, maxRuntimeSeconds: number): string {
  return template
    .replace(/\{\{plot\}\}/g, plot)
    .replace(/\{\{maxRuntimeSeconds\}\}/g, String(maxRuntimeSeconds))
    .trim()
}

/** The shots stage's `response_format` — same flat, `strict: true` shape as
 * `schema.ts`'s `h3ResponseFormat`, so an endpoint that compiles JSON Schema
 * into a sampling grammar (llama.cpp) makes a malformed shot list
 * unreachable the same way it already does for the six H3 sections. */
export function shotListResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'shot_list',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['spine', 'shots'],
        properties: {
          spine: { type: 'string', description: "The whole film's spine, in one line." },
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
                seconds: { type: 'number', description: "This shot's own target length, in seconds." },
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
 * there. */
function stripFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

/**
 * Parse a `ShotList` out of a reply — strip any fence, take from the first
 * `{` to the last `}`, then validate and coerce the shape rather than
 * trusting it. Mirrors `stages.ts`'s `parseBreakdown` exactly, one grain
 * finer. `maxRuntimeSeconds` is the OPERATOR's own figure, carried in rather
 * than read back out of the reply — the ceiling is a fact this app already
 * knows before the call is made, never something to trust the model to echo
 * correctly.
 */
export function parseShotList(raw: string, maxRuntimeSeconds: number): ShotList | null {
  const text = stripFence(raw.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as { spine?: unknown; shots?: unknown }
  if (typeof o.spine !== 'string' || !Array.isArray(o.shots) || !o.shots.length) return null

  const shots: Shot[] = o.shots.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    return {
      index: Number(c.index) || i + 1,
      covers: typeof c.covers === 'string' ? c.covers.trim() : '',
      seconds: Number(c.seconds) || 0,
    }
  })

  return { spine: o.spine.trim(), maxRuntimeSeconds, shots, at: Date.now() }
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
 * (an unterminated string) or absent. Deliberately narrow: it only reads a
 * plain JSON string value, same as `parseShotList` trusts the model for. */
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
 * `parseShotList`, run against a shot list that may still be streaming in.
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
 * On a COMPLETE document this returns exactly the same `{ spine, shots }`
 * `parseShotList` would (modulo the fields — `maxRuntimeSeconds` and `at` —
 * that come from the caller/clock rather than the text, so they are not this
 * function's to produce).
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
