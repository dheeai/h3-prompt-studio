import type { FilmContext } from './types'

/**
 * The three STARTING POINTS a new operator can enter the studio from.
 *
 * These describe the starting MATERIAL, not the output shape — with
 * Contex-Loop as the only render path, every render is scene 1 of a chain, so
 * an output-shaped split (the old "Scene (Multi-shot)" / "Clip" / "Prompt")
 * no longer differs in anything the operator cares about. What differs is
 * what they already have in hand: an idea, a prompt, or footage. See
 * `AuthoringMode` for the separate axis this is not — the LLM contract a
 * starting point resolves to.
 */
export type EntryModeId = 'idea' | 'prompt' | 'video'

export interface EntryMode {
  id: EntryModeId
  label: string
  title: string
  description: string
  placeholder: string
  action: string
}

/**
 * The LLM authoring CONTRACT (`H3_STUDIO_MODE_RULES` in context.ts) — a
 * different axis from `EntryModeId`, and NOT shown to the operator as a
 * choice of its own.
 *
 * 'story' is the narrative multi-shot planner: it used to be its own door
 * ("Scene (Multi-shot)") and is now reached from the 'idea' door by turning
 * `planFirst` on ("plan the whole arc" rather than "just scene 1") — the
 * planning capability is unchanged, only its framing moved. 'video' has no
 * rules of its own: continuing footage authors scene 1 exactly the way an
 * idea does (see `authoringModeFor`), it just starts from a different
 * material.
 */
export type AuthoringMode = 'story' | 'prompt' | 'idea'

export const ENTRY_MODES: readonly EntryMode[] = [
  {
    id: 'idea',
    label: 'An idea',
    title: 'An idea',
    description: 'A sentence, a beat, a situation',
    placeholder: 'Describe the clip you want…',
    action: 'Write the prompt',
  },
  {
    id: 'prompt',
    label: 'A prompt',
    title: 'A prompt',
    description: 'You already have an H3 prompt',
    placeholder: 'Paste a rough or finished H3 prompt…',
    action: 'Audit and correct',
  },
  {
    id: 'video',
    label: 'A video',
    title: 'A video',
    description: 'Footage you already have',
    placeholder: 'Describe what happens after your footage ends…',
    action: 'Write the prompt',
  },
]

export function entryMode(id: EntryModeId): EntryMode {
  return ENTRY_MODES.find((mode) => mode.id === id) ?? ENTRY_MODES[0]
}

export function entryLabel(id: EntryModeId): string {
  return entryMode(id).label
}

export function entryAction(id: EntryModeId): string {
  return entryMode(id).action
}

/** Empty-state copy kept in the same order as the visible entry tabs. */
export function entryStartCopy(): string {
  const [first, second, third] = ENTRY_MODES
  return `Start with ${first.label}, ${second.label}, or ${third.label}.`
}

/**
 * Which LLM authoring contract a starting point resolves to.
 *
 * Only the 'idea' door has a second axis worth asking about — `planFirst`
 * ("just scene 1" vs "plan the whole arc"). Every other door maps onto one
 * contract regardless of `planFirst`, so passing it for 'prompt'/'video' is
 * harmless rather than meaningful.
 */
export function authoringModeFor(door: EntryModeId, planFirst: boolean): AuthoringMode {
  if (door === 'prompt') return 'prompt'
  if (door === 'idea' && planFirst) return 'story'
  return 'idea'
}

export type EntryWorkflow = 'story-plan' | 'prompt-revise' | 'idea-prompt'

/** The canonical action behind both the visible CTA and Cmd/Ctrl+Enter. */
export function entryWorkflow(door: EntryModeId, planFirst: boolean): EntryWorkflow {
  if (door === 'prompt') return 'prompt-revise'
  if (door === 'idea' && planFirst) return 'story-plan'
  return 'idea-prompt'
}

/**
 * Migrate a starting-point preference written by a build before this
 * redesign, when 'story' was itself a door rather than an option inside
 * 'idea'. Applied on every settings load — cheap and a no-op on an
 * already-current value — so a profile that persisted the old value never
 * lands on a door that no longer exists.
 */
export function migrateEntryMode(rawMode: unknown, rawPlanFirst?: unknown): { studioMode: EntryModeId; planFirst: boolean } {
  if (rawMode === 'story') return { studioMode: 'idea', planFirst: true }
  if (rawMode === 'idea' || rawMode === 'prompt' || rawMode === 'video') {
    return { studioMode: rawMode, planFirst: !!rawPlanFirst }
  }
  return { studioMode: 'idea', planFirst: !!rawPlanFirst }
}

/**
 * Choose the prompt document for a prompt-oriented stage. An authored prompt
 * is authoritative; the 'prompt' contract deliberately treats its pasted
 * source as a prompt even when it is rough enough to fail the structural
 * heuristic. Every other contract keeps the heuristic so a story, idea or
 * video hand-off is not accidentally placed in a prompt-only stage.
 */
export function promptSourceForEntryMode(
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
