import type { PipelinePresetId } from './pipeline'

/**
 * Which strategy Full Story mode uses to turn a plot/chapter into a
 * `ShotList`/`ShotGroup[]` — modelled on `pipeline.ts`'s `PipelinePresetId`
 * pattern (an id + operator-facing metadata + a lookup function), since
 * that is the one existing "pick a strategy, keep the incumbent frozen"
 * switch in this codebase. This is a DIFFERENT axis from `pipeline.ts`'s
 * presets: that one picks how a CLIP's PROMPT gets written once a plan
 * already exists; this one picks how the PLAN itself gets produced.
 *
 * `beats-subdivide` is the INCUMBENT, FROZEN exactly as it was: `state.tsx`'s
 * `makeShotList` — pass 1 (`BEAT_LIST_TEMPLATE`) then pass 2
 * (`subdivideAllBeats`) then `groupShotsIntoClips`'s greedy pack. It stays
 * DEFAULT until the founder says otherwise, per the brief.
 *
 * `structured-json` is `chapterBreakdown.ts`'s one-call planner: the whole
 * chapter, fixed 15s clips, 3-6 named-camera shots each, decided in a
 * single schema-constrained call rather than two passes plus a packer.
 */
export type BreakdownPlannerId = 'beats-subdivide' | 'structured-json'

export interface BreakdownPlannerInfo {
  id: BreakdownPlannerId
  /** Operator-facing name — shown in Full Story mode's planner switch. */
  name: string
  /** One line: what this planner does. */
  description: string
  /** One line: what it costs, next to the incumbent. */
  cost: string
  /**
   * The `pipeline.ts` writer preset the UI switches to the MOMENT this
   * planner is chosen — a starting default, never a lock: the operator can
   * still pick any other preset from `PipelinePresetRow` right afterward
   * (`StoryAndShots.tsx` wires both switches to patch `settings` together).
   * `structured-json`'s clips already carry a named camera per shot and are
   * meant to be handed to preset D ("Raw ask") — pairing them with preset A
   * would ask a SECOND call to re-decide the shots the planner already
   * decided.
   */
  defaultPipelinePreset: PipelinePresetId
}

export const BREAKDOWN_PLANNERS: readonly BreakdownPlannerInfo[] = [
  {
    id: 'beats-subdivide',
    name: 'Beats → shots (default)',
    description:
      'The incumbent, unchanged. One call decides the whole arc\'s beats, then one call per beat decides its shots — camera and performance are left for the per-clip writer.',
    cost: 'one call for beats, one call per beat for shots',
    defaultPipelinePreset: 'direct-write',
  },
  {
    id: 'structured-json',
    name: 'Clip / shot breakdown',
    description:
      'One schema-constrained call turns the whole chapter into fixed 15-second clips of 3-6 shots each — camera named per shot, dialogue in its own shot, a forward pull closing every clip.',
    cost: 'one model call for the whole chapter',
    defaultPipelinePreset: 'raw-ask',
  },
] as const

/** The planner for a stored id, falling back to the incumbent — an unset or
 * unrecognised id must behave exactly as it always has, for an operator who
 * never touches the switch. */
export function breakdownPlanner(id: BreakdownPlannerId | undefined): BreakdownPlannerInfo {
  return BREAKDOWN_PLANNERS.find((p) => p.id === id) ?? BREAKDOWN_PLANNERS[0]
}
