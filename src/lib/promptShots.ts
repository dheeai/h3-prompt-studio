/**
 * Split an authored prompt back onto its shots.
 *
 * THIS IS THE LOAD-BEARING PIECE OF THE STORY-TO-VIDEO REDESIGN (founder,
 * 2026-09-18): "prompt is for video model.. for humans we need better
 * presentation. Only show prompt if it needs editing / raw output to human",
 * and "not just film.. the shot prompts too. but shot prompts doesnt have to
 * be the whole prompt."
 *
 * A six-section Ref2VA prompt is a wall of text, and reading it is not how a
 * person judges a film. But it is not opaque either: `schema.ts` already
 * REQUIRES its body to be marked up per shot —
 *
 *   "[Shot 1] carries no timestamp; later shots are
 *    '[Shot N] At MM:SS.mmm, …', strictly increasing."
 *
 * — so the body can be cut back into per-shot fragments deterministically,
 * and each fragment is the REAL text the model was given for that shot, never
 * a paraphrase of it. That is what lets the UI show a shot's own two lines
 * instead of the whole prompt, and what puts each fragment at a known
 * position on a timeline.
 *
 * WHAT THIS DOES NOT DO. It never rewrites, reflows or normalises the text —
 * a fragment is a verbatim slice, so editing one and reassembling round-trips
 * byte-for-byte (`joinPromptShots` asserts it). And it takes no view on the
 * four sections that are not per-shot (`subject_definitions`,
 * `retention_analysis`, `overall_soundscape`, `non_diegetic_music`): those
 * belong to the clip and are shown once, not repeated under every shot.
 */

/** One shot's slice of the body. */
export interface PromptShot {
  /** The number as WRITTEN in the marker — not a position. A prompt that
   * numbers its shots 1, 2, 4 reports 4, because silently renumbering would
   * hide exactly the defect worth seeing. */
  n: number
  /** Milliseconds from the clip's start, from `At MM:SS.mmm`. `null` for a
   * shot with no timestamp — which is CORRECT and expected for `[Shot 1]`,
   * whose marker carries none by rule. */
  atMs: number | null
  /** The marker itself, verbatim (`[Shot 3] At 00:09.800,`). Kept separate so
   * a fragment can be re-rendered with the marker styled differently from the
   * prose, and so reassembly needs no reconstruction. */
  marker: string
  /** Everything after the marker, up to the next one. Verbatim, including its
   * original leading and trailing whitespace. */
  text: string
}

export interface SplitPrompt {
  /** Everything before the first marker. In Ref2VA this is the style
   * sentences the schema asks for BEFORE `[Shot 1]` — including the film's
   * baked-in camera paragraph. Empty string when the body opens on a marker. */
  preamble: string
  shots: PromptShot[]
}

/**
 * The marker, matched as tolerantly as a model's output deserves and no more.
 *
 * `\[Shot\s+(\d+)\]` allows the inner spacing to drift (`[Shot  3]`) because
 * that is a whitespace slip, not a different thing. The timestamp is OPTIONAL
 * and captured separately: `[Shot 1]` legitimately has none, and a later shot
 * that lost its timestamp is a real defect the UI should be able to show
 * rather than a parse failure. The trailing comma is optional too — the
 * schema writes one, models sometimes do not, and refusing the fragment over
 * a comma would throw away the whole shot.
 */
// The whitespace between the number and `At` lives INSIDE the optional
// timestamp group, not before it. Outside, a bare `[Shot 1]` marker would
// absorb the space that separates it from its prose while a timestamped one
// stopped at its comma — two forms behaving differently, so a fragment
// sometimes began with a space and sometimes did not.
const MARKER_RE = /\[Shot\s+(\d+)\](?:\s*At\s+(\d{1,3}):(\d{2})(?:\.(\d{1,3}))?\s*,?)?/g

/** `MM:SS.mmm` to milliseconds. Minutes are not capped at 59: a long clip is
 * not this function's business to police, and clamping would silently move a
 * timestamp. */
function toMs(mm: string, ss: string, ms: string | undefined): number {
  const millis = ms ? Number(ms.padEnd(3, '0')) : 0
  return Number(mm) * 60_000 + Number(ss) * 1000 + millis
}

/**
 * Cut a prompt body into its preamble and per-shot fragments.
 *
 * A body with NO markers at all comes back as pure preamble with no shots —
 * never as one synthetic shot holding everything. The caller can then say
 * "this prompt has no shot markers", which is a real and reportable state,
 * where a fabricated `[Shot 1]` would have hidden it.
 */
export function splitPromptShots(body: string): SplitPrompt {
  if (!body) return { preamble: '', shots: [] }

  const matches = [...body.matchAll(MARKER_RE)]
  if (!matches.length) return { preamble: body, shots: [] }

  const shots: PromptShot[] = matches.map((m, i) => {
    const start = m.index ?? 0
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? body.length) : body.length
    return {
      n: Number(m[1]),
      atMs: m[2] !== undefined ? toMs(m[2], m[3], m[4]) : null,
      marker: m[0],
      text: body.slice(start + m[0].length, end),
    }
  })

  return { preamble: body.slice(0, matches[0].index ?? 0), shots }
}

/**
 * Reassemble. Exact inverse of `splitPromptShots` on unedited input, so a UI
 * can hand a person one fragment to edit and put the body back together
 * without touching anything else — the reason fragments keep their own
 * whitespace and markers rather than being trimmed.
 */
export function joinPromptShots(split: SplitPrompt): string {
  return split.preamble + split.shots.map((s) => s.marker + s.text).join('')
}

/** Replace ONE shot's prose, by the `n` it declares, leaving every other byte
 * of the body alone. Returns the body unchanged when no shot declares that
 * `n` — a caller editing a shot that is not there is a bug upstream, and
 * appending a shot here would be a worse answer than doing nothing. */
export function replacePromptShotText(body: string, n: number, text: string): string {
  const split = splitPromptShots(body)
  if (!split.shots.some((s) => s.n === n)) return body
  return joinPromptShots({
    ...split,
    shots: split.shots.map((s) => (s.n === n ? { ...s, text } : s)),
  })
}

// ── what is wrong with a body, as facts rather than a refusal ───────────

export interface PromptShotIssues {
  /** No `[Shot N]` markers at all — the body cannot be shown per shot. */
  noMarkers: boolean
  /** Declared numbers that are not 1..N contiguous, in the order written. */
  numbering: number[]
  /** Shots after the first whose timestamp is missing, by declared `n`. */
  missingTimestamps: number[]
  /** Shots whose timestamp is not strictly after the previous one, by
   * declared `n`. The schema requires strictly increasing; out of order means
   * the film's own clock disagrees with its text. */
  outOfOrder: number[]
  /** `[Shot 1]` carrying a timestamp, which the schema forbids. */
  firstShotTimestamped: boolean
}

/**
 * Everything checkable about a body's shot markup — REPORTED, never
 * corrected. This file has no business renumbering a model's shots or
 * inventing a timestamp: a wrong number is a visible defect the operator can
 * act on, and a silently fixed one is a defect that ships. Same shape as
 * `checkRuntimeCeiling` and `offVocabularyMovements` elsewhere in this
 * codebase, and the same reason.
 */
export function promptShotIssues(split: SplitPrompt): PromptShotIssues {
  const numbering = split.shots.filter((s, i) => s.n !== i + 1).map((s) => s.n)
  const missingTimestamps = split.shots.slice(1).filter((s) => s.atMs === null).map((s) => s.n)

  const outOfOrder: number[] = []
  let prev = -1
  for (const s of split.shots) {
    if (s.atMs === null) continue
    if (s.atMs <= prev) outOfOrder.push(s.n)
    else prev = s.atMs
  }

  return {
    noMarkers: split.shots.length === 0,
    numbering,
    missingTimestamps,
    outOfOrder,
    firstShotTimestamped: split.shots.length > 0 && split.shots[0].atMs !== null,
  }
}

/** Whether anything at all is wrong — so a caller can skip rendering a
 * "problems" affordance without re-deriving the five checks. */
export function hasPromptShotIssues(issues: PromptShotIssues): boolean {
  return (
    issues.noMarkers ||
    issues.numbering.length > 0 ||
    issues.missingTimestamps.length > 0 ||
    issues.outOfOrder.length > 0 ||
    issues.firstShotTimestamped
  )
}

/**
 * Pair each planned shot with the prompt fragment that belongs to it.
 *
 * Matched by POSITION, not by the declared `n`: the plan's shots are the
 * truth about what the clip contains (they were approved), while `n` is
 * whatever the model typed. A prompt that numbered its shots 1, 2, 4 still
 * has three fragments in playback order, and pairing them positionally puts
 * the right prose against the right shot — while `promptShotIssues` still
 * reports the numbering, so the mismatch is visible rather than papered over.
 *
 * Extra fragments beyond the planned shots come back in `orphans`, and
 * planned shots with no fragment get `fragment: null`. Both are states the UI
 * must be able to show: they mean the prompt and the plan have drifted.
 */
export function pairShotsWithPrompt<T>(
  plannedShots: readonly T[],
  split: SplitPrompt,
): { pairs: Array<{ shot: T; fragment: PromptShot | null }>; orphans: PromptShot[] } {
  return {
    pairs: plannedShots.map((shot, i) => ({ shot, fragment: split.shots[i] ?? null })),
    orphans: split.shots.slice(plannedShots.length),
  }
}
