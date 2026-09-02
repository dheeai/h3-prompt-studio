import type { FilmContext } from './types'

/** The three ways a new operator can enter the studio. */
export type EntryModeId = 'story' | 'prompt' | 'idea'

export interface EntryMode {
  id: EntryModeId
  label: string
  title: string
  description: string
  placeholder: string
  action: string
}

export type EntryWorkflow = 'story-plan' | 'prompt-revise' | 'idea-prompt'

export const ENTRY_MODES: readonly EntryMode[] = [
  {
    id: 'story',
    label: 'Scene (Multi-shot)',
    title: 'Scene (Multi-shot)',
    description: 'Plan several connected shots',
    placeholder: 'Paste a scene, beat sheet, or script…',
    action: 'Create clip plan',
  },
  {
    id: 'idea',
    label: 'Clip',
    title: 'Clip',
    description: 'Turn an idea into one H3 clip',
    placeholder: 'Describe the clip you want…',
    action: 'Generate prompt',
  },
  {
    id: 'prompt',
    label: 'Prompt',
    title: 'Prompt',
    description: 'Improve an existing prompt',
    placeholder: 'Paste a rough or finished H3 prompt…',
    action: 'Revise prompt',
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
  return `Start with a ${first.label}, ${second.label}, or ${third.label}.`
}

/** The canonical action behind both the visible CTA and Cmd/Ctrl+Enter. */
export function entryWorkflow(id: EntryModeId): EntryWorkflow {
  if (id === 'story') return 'story-plan'
  if (id === 'prompt') return 'prompt-revise'
  return 'idea-prompt'
}

/**
 * Choose the prompt document for a prompt-oriented stage. An authored prompt
 * is authoritative; Prompt entry mode deliberately treats its pasted source
 * as a prompt even when it is rough enough to fail the structural heuristic.
 * Other entry modes keep the heuristic so a story or idea is not accidentally
 * placed in a prompt-only stage.
 */
export function promptSourceForEntryMode(
  mode: EntryModeId,
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
