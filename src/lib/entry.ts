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
    label: 'A story',
    title: 'Your story',
    description: 'Plan several connected clips',
    placeholder: 'Paste a story, beat sheet, or script…',
    action: 'Generate clip plan',
  },
  {
    id: 'prompt',
    label: 'A prompt',
    title: 'Your prompt',
    description: 'Improve what you already have',
    placeholder: 'Paste a rough or finished H3 prompt…',
    action: 'Refine prompt',
  },
  {
    id: 'idea',
    label: 'An idea',
    title: 'Your idea',
    description: 'Turn a thought into one H3 prompt',
    placeholder: 'Describe the moment, image, or effect you want…',
    action: 'Generate H3 prompt',
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

/** Direct then Draft, stopping at the first cancelled or failed pass. */
export async function authorContinuation(
  run: (stage: 'direct' | 'draft') => Promise<unknown | null>,
  isCancelled: () => boolean = () => false,
): Promise<'ready' | 'aborted'> {
  if (isCancelled()) return 'aborted'
  const directed = await run('direct')
  if (isCancelled() || !directed) return 'aborted'
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

/** Append a continuation pass without severing the earlier version lineage. */
export function appendContinuationHistory<T>(history: readonly T[], pass: T): T[] {
  return [...history, pass]
}
