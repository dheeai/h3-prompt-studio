import type { AuthoringMode } from './entry'
import type { Breakdown, BreakdownClip, StageId, Version } from './types'
import { latestPromptForClip } from './stages'

// The parser lives with the stage templates, but re-exporting the strict
// replacement contract here keeps the Studio workflow helpers as one small
// public surface for callers and tests.
export { splitPromptReplacement } from './stages'

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
export function studioActions(mode: AuthoringMode, hasPlan: boolean): StudioAction[] {
  if (mode === 'story') {
    return hasPlan
      ? [
          { id: 'generate-selected', label: 'Generate selected prompt', stages: ['draft'] },
          { id: 'generate-all', label: 'Generate all prompts', stages: ['draft'] },
        ]
      : [{ id: 'plan', label: 'Create clip plan', stages: ['breakdown'] }]
  }
  // SINGLE CLIP RUNS PRESET C. `idea` is the one-prompt door — "Break into
  // scenes" off, one clip, one call — and `draftOptimised` is the GEPA-tuned
  // writer measured over 3 samples x 7 held-out cases the optimiser never saw:
  //
  //     preset C  0.751   one call      wins 6/7
  //     preset B  0.708   three calls   (0.675 counting a hard failure)
  //
  // Full Story (`story`) deliberately keeps `draft`, so the preset switch in
  // settings still governs multi-clip authoring and preset B stays reachable
  // there — B writes direction and acting as inspectable ARTIFACTS, which is
  // worth more across a whole film than on a single clip.
  //
  // Do NOT "align" these two by giving story the same stage. They are
  // different jobs and the measurement above is single-clip only.
  if (mode === 'idea') return [{ id: 'generate-clip', label: 'Generate prompt', stages: ['draftOptimised'] }]
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

/** Prompt-producing passes whose output is the canonical render payload.
 *
 * `draftDirected` is one of them — it is preset B's writer, and its output is
 * the clip's prompt in exactly the way `draft`'s is. It was missing here, so
 * even a successful directed write would not have been recognised as the
 * clip's prompt. `draftOptimised` (preset C's writer) is the same case.
 * Keep this in step with `PROMPT_STAGES` in `stages.ts`. */
export function isCanonicalPromptStage(stage: StageId): boolean {
  return (
    stage === 'draft' ||
    stage === 'draftDirected' ||
    stage === 'draftOptimised' ||
    stage === 'revise' ||
    stage === 'rebuild' ||
    stage === 'freeform'
  )
}

interface DisplayedStudioPass {
  stage: StageId
  text: string
}

/**
 * Keep the document label and document body in lockstep while a new pass is
 * still thinking. A stream starts empty, so showing the saved body under the
 * new stage label briefly misrepresents which pass produced it.
 */
export function displayedStudioPass(
  streaming: DisplayedStudioPass | null | undefined,
  current: DisplayedStudioPass | null | undefined,
  fallbackStage: StageId,
): DisplayedStudioPass {
  if (streaming?.text.trim()) return { stage: streaming.stage, text: streaming.text }
  if (streaming) return { stage: current?.stage ?? fallbackStage, text: '' }
  return { stage: current?.stage ?? fallbackStage, text: current?.text ?? '' }
}

/**
 * Every plan clip that still needs a prompt authored, in index order — the
 * gate behind "Generate the rest" (Task 2, 2026-09-16): skip any clip
 * `latestPromptForClip` already covers, so a resume never re-authors — and
 * re-spends — a clip that already has one.
 */
export function clipsNeedingPrompt(breakdown: Breakdown, versions: readonly Version[]): BreakdownClip[] {
  return breakdown.clips.filter((c) => !latestPromptForClip(versions, c.index))
}

export type StudioRunPhase = 'thinking' | 'writing' | 'continuing' | 'thinking-recovery'

/**
 * What `DraftingStatus` needs to render progress for one in-flight call.
 *
 * `run()`'s own `streaming` state already carries exactly these fields, keyed
 * to a `StageId`. This is that same shape with `stage` widened to `string` —
 * the one change needed for a caller with no `StageId` of its own (the shots
 * stage; see `shotList.ts`'s module comment on why it stays off that chain on
 * purpose) to drive the identical component from its own state slot, instead
 * of either forcing a fake `StageId` into that enum or building a second
 * progress indicator that could drift out of step with the real one.
 */
/**
 * Where this call's output belongs on screen — which beat or clip band
 * should render it IN PLACE, rather than a fixed panel somewhere else
 * (founder, 2026-09-18: "the streaming text.. should come exactly where it
 * is working.. not in some random place"). Optional so an untargeted call
 * (pass 1's beat list, which is about the whole plot rather than one beat)
 * simply has nowhere narrower to render than the section that started it.
 */
export type DraftingTarget = { kind: 'beat'; beatIndex: number } | { kind: 'clip'; clipIndex: number }

export interface DraftingProgress {
  stage: string
  text: string
  reasoning: string
  startedAt: number
  continuations: number
  phase?: StudioRunPhase
  auto?: boolean
  target?: DraftingTarget
}

/** Human-readable status for a run; avoids presenting long reasoning as calls. */
export function runStatusText(stage: StageId, phase: StudioRunPhase = 'thinking', continuations = 0): string {
  if (phase === 'thinking-recovery') return 'Recovering the answer from model thinking…'
  if (phase === 'continuing') return `Continuing the ${stage} response${continuations ? ` · round ${continuations}` : ''}…`
  if (phase === 'writing') return stage === 'revise' || stage === 'rebuild' ? 'Writing replacement · one request…' : 'Writing answer · one run…'
  return stage === 'revise' || stage === 'rebuild' ? 'Thinking · one request…' : 'Thinking · one run…'
}
