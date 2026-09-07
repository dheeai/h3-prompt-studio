import type { FilmContext } from './types'
import type { Standing } from './lint'

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

export interface ContinuationHandoff {
  precedes: string
  follows: string
  open: string
}

/** Explicit input override for hand-off authoring from a selected clip. */
export function continuationContextOverride(clip: { prompt: string; film?: FilmContext; index?: number }): { current: string; film?: FilmContext; clipIndex?: number } {
  return { current: clip.prompt, film: clip.film, clipIndex: clip.film?.clipIndex ?? clip.index }
}

/**
 * Give the next Direct pass a useful source even when the operator leaves the
 * optional continuation note empty. The hand-off is deliberately ordered from
 * what remains open, through the next beat, back to the state just inherited.
 */
export function continuationSource(note: string | undefined, handoff: ContinuationHandoff): string {
  const explicit = note?.trim()
  if (explicit) return explicit
  return [
    handoff.open.trim() && `OPEN: ${handoff.open.trim()}`,
    handoff.follows.trim() && `FOLLOWS: ${handoff.follows.trim()}`,
    handoff.precedes.trim() && `PRECEDES: ${handoff.precedes.trim()}`,
  ].filter(Boolean).join('\n') || 'Continue from the ending state of the previous clip.'
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
  externalVideo?: unknown
}

/**
 * Start a clean writing context while leaving production/configuration state
 * (clips, plates, recipes, endpoints) to the caller. In particular, a new
 * standalone Clip must not inherit an earlier Scene's film or parent prompt —
 * nor an earlier chain's "continue from this video" choice, which only ever
 * means something for the fresh scene-1 chain it was picked for.
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
    externalVideo: null,
  }
}

/** Direct then Draft, stopping at the first cancelled or failed pass. */
export async function authorContinuation<T>(
  run: (stage: 'direct' | 'draft', previous?: T) => Promise<T | null>,
  isCancelled: () => boolean = () => false,
): Promise<'ready' | 'aborted'> {
  if (isCancelled()) return 'aborted'
  const directed = await run('direct')
  if (isCancelled() || !directed) return 'aborted'
  const drafted = await run('draft', directed)
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

/** Append a continuation pass without severing the earlier version lineage. */
export function appendContinuationHistory<T>(history: readonly T[], pass: T): T[] {
  return [...history, pass]
}
