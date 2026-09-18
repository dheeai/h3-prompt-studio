import type { Breakdown, BreakdownClip, FilmContext, Version } from './types'
import type { Standing } from './lint'
import type { ChatContentPart } from './llm'
import { latestPromptForClip } from './stages'

/**
 * There is no entry-mode picker any more (2026-09-07 redesign — "the system
 * takes TEXT; whether you typed an idea, pasted a rough prompt, pasted a
 * finished H3 prompt, or pasted a whole scene changes nothing about what
 * happens next"). The one composer is always the input. What used to be
 * three doors (idea / prompt / video) is now decided FROM THE TEXT itself,
 * deterministically, via `classifyInput` (`lint.ts`) — never chosen by the
 * operator up front.
 *
 * `AuthoringMode` is the one axis that still matters: which LLM stage
 * contract (`H3_STUDIO_MODE_RULES` in context.ts) a pass runs under. It is
 * derived, not picked — see `authoringModeForContent`.
 */
export type AuthoringMode = 'story' | 'prompt' | 'idea'

/**
 * Which authoring contract the composer's current text resolves to.
 *
 * A pasted FINISHED prompt (`classifyInput` reads `kind: 'prompt'` — the
 * canonical field structure at line start) always gets the surgical prompt
 * contract, regardless of the scene-count toggle: there is nothing to plan,
 * only to audit and correct. Everything else is either the single-clip
 * "idea" contract, or, when the composer's "Break into scenes" control is on,
 * the multi-shot "story" planner — the ONLY variable the operator actually
 * chooses (see the module comment on `EntryModeId`'s removal, above).
 */
export function authoringModeForContent(kind: Standing['kind'], breakIntoScenes: boolean): AuthoringMode {
  if (kind === 'prompt') return 'prompt'
  return breakIntoScenes ? 'story' : 'idea'
}

/**
 * Migrate a profile written by a build before this redesign, when the
 * starting point was an explicit door (`studioMode`: 'idea' | 'prompt' |
 * 'video', or the older 'story') plus a separate `planFirst` toggle. Applied
 * on every settings load — cheap, and a no-op on an already-current profile —
 * so an existing profile boots cleanly onto the one remaining control,
 * "Break into scenes".
 *
 * The old 'story' door and 'idea' + planFirst both meant "plan the whole arc
 * first" — both become `breakIntoScenes: true`. 'prompt' and 'video' never
 * exposed planFirst in a way that changed anything (see the removed
 * `authoringModeFor`), so they land on `false` regardless of a stale value.
 */
export function migrateBreakIntoScenes(rawMode: unknown, rawPlanFirst?: unknown): { breakIntoScenes: boolean } {
  if (rawMode === 'story') return { breakIntoScenes: true }
  if (rawMode === 'idea') return { breakIntoScenes: !!rawPlanFirst }
  return { breakIntoScenes: false }
}

/**
 * Choose the prompt document for a prompt-oriented stage. An authored prompt
 * is authoritative; the 'prompt' contract deliberately treats its pasted
 * source as a prompt even when it is rough enough to fail the structural
 * heuristic. Every other contract keeps the heuristic so a story, idea or
 * video hand-off is not accidentally placed in a prompt-only stage.
 */
export function promptSourceForAuthoringMode(
  mode: AuthoringMode,
  source: string,
  authoredPrompt: string,
  looksLikePrompt: boolean,
): string {
  if (authoredPrompt.trim()) return authoredPrompt
  if (mode === 'prompt') return source
  return looksLikePrompt ? source : ''
}

/** Story mode only advances when the pass actually completed with a value. */
export function shouldContinueStoryLoop(result: { status: 'ok' | 'null' | 'cancelled' | 'error' }): boolean {
  return result.status === 'ok'
}

/**
 * What the next clip's source can be built from once a continuation stops
 * running its own Hand-off call (2026-09-16 — see `authorContinuation`'s
 * module comment for why that call was dropped). There is no fresh paraphrase
 * of the ending state any more; `{{previous}}` already carries the parent's
 * canonical prompt, whose final `[Shot N]` block states that ending state
 * explicitly. What IS still useful and was never available from the parent
 * prompt is what the breakdown already decided the NEXT clip must cover.
 */
export interface ContinuationCarry {
  /** The next clip's own `covers`, from the breakdown plan clip at that index. */
  covers?: string
  /** The film's one-line spine, used when there is no breakdown to be specific with. */
  spine?: string
}

/**
 * Give the Draft pass a useful source even when the operator leaves the
 * optional continuation note empty.
 *
 * This used to fuse a Hand-off paragraph — a whole extra model call that read
 * the parent clip's prompt and wrote its own paraphrase of the ending state.
 * That paraphrase was never new information: the parent prompt's own final
 * `[Shot N]` block already states it, and Draft receives that prompt verbatim
 * as `{{previous}}`. So the source is now built from what the breakdown
 * ALREADY decided this clip must cover, falling back to the film's spine, and
 * finally to a generic instruction that still works because `{{previous}}`
 * carries the real continuity, not this line.
 */
export function continuationSource(note: string | undefined, carry: ContinuationCarry): string {
  const explicit = note?.trim()
  if (explicit) return explicit
  const covers = carry.covers?.trim()
  if (covers) return `COVERS: ${covers}`
  const spine = carry.spine?.trim()
  if (spine) return `Continue the film — it is about: ${spine}. Advance from the previous clip's ending state.`
  return 'Continue from the ending state of the previous clip.'
}

/**
 * Find the latest canonical prompt from an earlier clip in a Scene plan.
 *
 * A Scene plan keeps its continuity facts (precedes/follows) on the film
 * context, but the director also needs the actual prompt that produced the
 * preceding clip. Keep this lookup independent of React state so every entry
 * point (selected clip, generate-all, and the Clip plan card) applies the same
 * rule. A missing intermediate prompt is allowed: use the nearest earlier
 * generated prompt rather than claiming there is no previous clip at all.
 */
export function previousPromptForClip(
  versions: readonly { stage: string; text: string; clipIndex?: number }[],
  clipIndex?: number,
): string | undefined {
  if (clipIndex === undefined || !Number.isFinite(clipIndex) || clipIndex <= 1) return undefined
  const canonical = new Set(['draft', 'revise', 'rebuild', 'freeform'])
  let best: { text: string; clipIndex: number } | undefined
  for (let i = versions.length - 1; i >= 0; i--) {
    const version = versions[i]
    if (!canonical.has(version.stage) || version.clipIndex === undefined || version.clipIndex >= clipIndex) continue
    const text = version.text.trim()
    if (!text) continue
    if (!best || version.clipIndex > best.clipIndex) best = { text, clipIndex: version.clipIndex }
  }
  return best?.text
}

/** The parts of a draft that must never leak into a new standalone entry. */
export interface DraftContextState {
  story: string
  versions: unknown[]
  currentId: string | null
  chat?: unknown[]
  film?: FilmContext
  parentClipId?: string | null
  parentPrompt?: string
  breakdown?: unknown
  /** The continuation's vision frame — see `withContinuationFrame`. Never
   * meaningful outside the one draft call it was fetched for. */
  continuationFrame?: string
  /** A pending pipeline-authored draft — see `dropInvalidatedAutoDraft` in
   * `filmEdit.ts`. Scoped to the draft it came from, same as the frame. */
  pendingAutoDraft?: unknown

  // ── Full Story's own state ────────────────────────────────────────────
  //
  // These were added long after this function was written, and it never
  // learned about them — so "New draft" cleared the single-clip Studio
  // context and left the whole FILM standing: the plot, the shot list, the
  // clip groups, the direction and acting documents, the film's name. The
  // founder's report: "new draft + discard doesnt discard anything afiak -
  // all the old clips etc still stick on."
  //
  // It became visible rather than merely latent when sessions started
  // persisting: before that, a reload wiped everything anyway, so nobody
  // noticed that Discard did not. Persistence removed the accidental reset
  // this was quietly relying on.
  plot?: string
  shotList?: unknown
  shotGroups?: unknown[]
  shotGroupIssues?: string[]
  editingGroupIndex?: number | null
  filmName?: string
  filmLoraStack?: unknown[]
  directionByClip?: Record<number, unknown>
  actingByClip?: Record<number, unknown>
  thinBriefCheck?: unknown
}

/**
 * Start a clean writing context while leaving production/configuration state
 * (clips, plates, recipes, endpoints) to the caller. In particular, a new
 * standalone Clip must not inherit an earlier Scene's film or parent prompt.
 */
export function clearDraftContext<T extends DraftContextState>(session: T): T {
  return {
    ...session,
    story: '',
    versions: [],
    currentId: null,
    chat: [],
    film: undefined,
    parentClipId: null,
    parentPrompt: undefined,
    breakdown: undefined,
    continuationFrame: undefined,
    pendingAutoDraft: undefined,
    // The film itself. `maxRuntimeSeconds` is deliberately NOT cleared: it is
    // a standing preference like the render geometry, not something this
    // film invented, and re-picking a runtime on every new film is friction
    // for no gain. Everything else here IS this film and goes.
    plot: '',
    shotList: undefined,
    shotGroups: undefined,
    shotGroupIssues: undefined,
    editingGroupIndex: null,
    filmName: undefined,
    filmLoraStack: undefined,
    directionByClip: undefined,
    actingByClip: undefined,
    thinBriefCheck: null,
  }
}

/**
 * Run a continuation's one authoring call.
 *
 * Used to run Hand-off, then Direct, then Draft — three model calls per
 * "Continue from here" turn. Hand-off is now skipped entirely (its
 * paraphrase of the ending state was never new information — see
 * `continuationSource`), and Direct is folded away too: the `draft` template
 * already directs-then-drafts in one pass ("Direct this, then write the
 * {{mode}} prompt. One pass, both jobs" — commit ded83fa, "perf: direct and
 * draft become one pass, with the gates kept inside it") for every other
 * entry point through this app. Continuation was simply never brought in
 * line with that change until now. One call, not three.
 */
export async function authorContinuation<T>(
  run: (stage: 'draft') => Promise<T | null>,
  isCancelled: () => boolean = () => false,
): Promise<'ready' | 'aborted'> {
  if (isCancelled()) return 'aborted'
  const drafted = await run('draft')
  return isCancelled() || !drafted ? 'aborted' : 'ready'
}

/** Keep an interrupted model thought separate from a completed-run failure. */
export function interruptedReasoningText(reasoning: string): string | null {
  const text = reasoning.trim()
  return text || null
}

/** A replaced plate may only be reused for the clip whose ending produced it. */
export function continuationPlateIsFresh(plate: { mode: 'carried' | 'replaced'; fromClipId?: string }, clipId: string): boolean {
  return plate.mode !== 'replaced' || plate.fromClipId === clipId
}

/**
 * Add the continuation frame, if any, to the vision content parts already
 * built for a request — after everything else, and only when one is present.
 *
 * This is the one seam the frame passes through on its way into a request,
 * kept as a pure function so it is possible to prove — rather than just
 * assert — that the frame can never end up inside `plates` itself. A
 * previous attempt did exactly that: added the previous clip's last frame as
 * a `replaced` plate, which burned one of H3's nine reference slots on every
 * continuation for something the render node's own motion context already
 * made redundant (see `continueFrom`'s "NO LAST-FRAME PLATE" comment in
 * `state.tsx`). Plates and the continuation frame are two different
 * parameters here, and the frame never touches the array the caller passes
 * in — it is appended to a NEW array, never spliced into the given one.
 */
export function withContinuationFrame(images: ChatContentPart[], frame: string | undefined): ChatContentPart[] {
  return frame ? [...images, { type: 'image_url', image_url: { url: frame } }] : images
}

/**
 * Whether the studio may kick off pipeline (background) authoring right now
 * — "author the next clip while the operator watches the one that just
 * landed" (2026-09-16). Two independent gates, both required:
 *
 * - `enabled` is the operator's own switch (`Settings.autoAuthorNext`,
 *   default on) — an operator on a metered endpoint, or one who wants the
 *   GPU quiet, must be able to turn this off.
 * - `gpuBusy` must be `'idle'`. The gateway single-flights the GPU the same
 *   way every other LLM call in this app already respects (`beginGpuUse`) —
 *   a model call fired while a render is still draining can get ComfyUI
 *   hard-killed, so this must never fire mid-render, and never race a
 *   manual LLM call either.
 */
export function canAutoAuthorNext(opts: { enabled: boolean; gpuBusy: 'idle' | 'llm' | 'render' }): boolean {
  return opts.enabled && opts.gpuBusy === 'idle'
}

/**
 * The plan clip pipeline authoring should write next, once `landedIndex` has
 * just rendered — the next clip BY INDEX, and only when it has no prompt yet
 * (`latestPromptForClip` — the same notion ClipPlan's "ready"/"no prompt yet"
 * badge already uses, so this can never disagree with what the operator sees
 * there). Returns undefined when there is no next clip, or it is already
 * authored — either way there is nothing to do.
 */
export function nextPlanClipToAuthor(
  breakdown: Breakdown | undefined,
  versions: readonly Version[],
  landedIndex: number,
): BreakdownClip | undefined {
  if (!breakdown) return undefined
  const next = breakdown.clips.find((c) => c.index === landedIndex + 1)
  if (!next) return undefined
  return latestPromptForClip(versions, next.index) ? undefined : next
}
