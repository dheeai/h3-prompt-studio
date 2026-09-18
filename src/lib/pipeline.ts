import type { StageId } from './types'

/**
 * PIPELINE PRESETS — the A/B the founder asked for (2026-09-18): "Create a
 * new preset with direction + acting.. and we will test the production
 * against the two.. to see which one is richer and better for h3 prompt
 * writing."
 *
 * A preset is DATA, not branching sprinkled through `state.tsx` — an id, an
 * operator-facing name, a one-line description, the ordered per-clip stages
 * it runs before the writer, and which writer stage produces the final
 * prompt. Adding a third preset later is adding a row here, not touching
 * every call site that authors a clip.
 *
 * Preset A ("Direct and write") is the INCUMBENT, FROZEN exactly as it was:
 * one call (`draft`, `stages.ts`) that directs and writes in the same pass,
 * per that template's own "DECIDE FIRST, IN YOUR HEAD... Do NOT output that
 * working" instruction.
 *
 * Preset B ("Directed") is PURELY ADDITIVE: the same plot/beats/shots/
 * groups/breakdown, then two extra per-clip calls — `direction`
 * (`direction.ts`) and `acting` (`acting.ts`) — that write the camera and
 * performance decisions down as documents, then a DIFFERENT writer stage
 * (`draftDirected`, `stages.ts`) that is given those documents rather than
 * asked to invent them in its head.
 */
export type PipelinePresetId = 'direct-write' | 'directed'

/** The two per-clip calls a preset may run before its writer — always in
 * this order, always sequential (never parallel; see `state.tsx`'s
 * `rebuild`), and always through the same one-model-call-at-a-time GPU lock
 * every other authoring call uses. */
export type PipelineExtraStage = 'direction' | 'acting'

export interface PipelinePreset {
  id: PipelinePresetId
  /** Operator-facing name — shown in the Full Story preset switch. */
  name: string
  /** One line: what this preset does. */
  description: string
  /** One line: what it costs, next to the incumbent. */
  cost: string
  /** Per-clip stages run BEFORE the writer, in order. Empty for preset A. */
  extraStages: readonly PipelineExtraStage[]
  /** Which `stages.ts` template authors the final prompt under this preset. */
  writerStage: StageId
}

export const PIPELINE_PRESETS: readonly PipelinePreset[] = [
  {
    id: 'direct-write',
    name: 'Direct and write',
    description:
      'The incumbent, unchanged. One call per clip decides the shots and the performance in its head and writes the H3 prompt in the same pass.',
    cost: 'one model call per clip',
    extraStages: [],
    writerStage: 'draft',
  },
  {
    id: 'directed',
    name: 'Directed',
    description:
      'Two extra calls per clip — Direction, then Acting — write the camera and performance down as documents. The writer is given those documents and honours them rather than re-deciding them.',
    cost: 'three model calls per clip — two more than Direct and write',
    extraStages: ['direction', 'acting'],
    writerStage: 'draftDirected',
  },
] as const

/** The preset for a stored id, falling back to preset A — an unset or
 * unrecognised id must behave exactly as it always has, for an operator who
 * never touches the switch. */
export function pipelinePreset(id: PipelinePresetId | undefined): PipelinePreset {
  return PIPELINE_PRESETS.find((p) => p.id === id) ?? PIPELINE_PRESETS[0]
}

/** Does this preset run the Direction call? Call sites ask the preset
 * rather than string-comparing ids, so a third preset only has to answer
 * this correctly, not be special-cased everywhere it's checked. */
export function presetRunsDirection(preset: PipelinePreset): boolean {
  return preset.extraStages.includes('direction')
}

/** Does this preset run the Acting call? */
export function presetRunsActing(preset: PipelinePreset): boolean {
  return preset.extraStages.includes('acting')
}

/** One clip's authoring, as an ordered list of calls — a PURE function of
 * the preset alone, so the orchestration in `state.tsx` can be tested
 * without touching React or the network: given a preset, which calls happen
 * in what order. Direction and acting (if the preset runs them) always
 * precede the writer. */
export function clipAuthoringPlan(preset: PipelinePreset): (PipelineExtraStage | StageId)[] {
  return [...preset.extraStages, preset.writerStage]
}
