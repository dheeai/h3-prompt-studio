import type { EntryModeId } from './entry'
import type { StageId } from './types'

/** The actions a Studio entry surface may put in front of the operator. */
export type StudioActionId = 'plan' | 'generate-selected' | 'generate-all' | 'generate-clip' | 'revise' | 'rebuild'

export interface StudioAction {
  id: StudioActionId
  label: string
  /** The internal execution sequence; the user sees only the bounded action. */
  stages: readonly StageId[]
}

/**
 * Keep the visible workflow finite and entry-specific. Scene and Clip may use
 * multiple internal quality passes, but those passes are not user-facing
 * stages. Prompt edits are deliberately single calls.
 */
export function studioActions(mode: EntryModeId, hasPlan: boolean): StudioAction[] {
  if (mode === 'story') {
    return hasPlan
      ? [
          { id: 'generate-selected', label: 'Generate selected prompt', stages: ['direct', 'draft'] },
          { id: 'generate-all', label: 'Generate all prompts', stages: ['direct', 'draft'] },
        ]
      : [{ id: 'plan', label: 'Create clip plan', stages: ['breakdown'] }]
  }
  if (mode === 'idea') return [{ id: 'generate-clip', label: 'Generate prompt', stages: ['direct', 'draft'] }]
  return [
    { id: 'revise', label: 'Revise prompt', stages: ['revise'] },
    { id: 'rebuild', label: 'Rebuild prompt', stages: ['rebuild'] },
  ]
}

export function promptOperationStage(operation: 'revise' | 'rebuild'): 'revise' | 'rebuild' {
  return operation
}

export function isSingleRequestStage(stage: StageId): boolean {
  return stage === 'revise' || stage === 'rebuild'
}

export type StudioRunPhase = 'thinking' | 'writing' | 'continuing' | 'thinking-recovery'

/** Human-readable status for a run; avoids presenting long reasoning as calls. */
export function runStatusText(stage: StageId, phase: StudioRunPhase = 'thinking', continuations = 0): string {
  if (phase === 'thinking-recovery') return 'Recovering the answer from model thinking…'
  if (phase === 'continuing') return `Continuing the ${stage} response${continuations ? ` · round ${continuations}` : ''}…`
  if (phase === 'writing') return stage === 'revise' || stage === 'rebuild' ? 'Writing replacement · one request…' : 'Writing answer · one run…'
  return stage === 'revise' || stage === 'rebuild' ? 'Thinking · one request…' : 'Thinking · one run…'
}
