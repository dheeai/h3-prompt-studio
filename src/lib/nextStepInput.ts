import type { NextStepInput } from './nextStep'
import type { Timeline } from './timeline'
import type { ThinBriefCheck } from './shotList'
import { thinBriefAlert } from './shotScreens'
import { extenderCostEstimate } from './extender'

/**
 * The seam between the app's actual state and `nextStep()`'s pure contract
 * — the one place that can silently disagree with what the buttons do (see
 * `nextStep.ts`'s own module comment for why that gap is the whole bug this
 * exists to close). Kept as its own pure function, off `state.tsx`, so a
 * test can hand it a `Timeline`/`ThinBriefCheck` fixture directly rather
 * than standing up a React harness to find out what the sticky bar would
 * say for a given film.
 *
 * Reads `Timeline` (`lib/timeline.ts`) for every per-clip fact rather than
 * re-deriving clip state from `shotGroups`/`breakdown`/`clips` a second
 * time — `FilmTimeline`'s own bands and this bar must never be able to
 * disagree about which state a clip is in.
 */
export interface NextStepSource {
  plot: string
  /** Pass 1 has landed — `!!shotList`, not `shotList.shots.length` (beats
   * exist the instant pass 1 returns, before pass 2 has subdivided them). */
  hasShotList: boolean
  awaitingSubdivision: boolean
  thinBriefCheck: ThinBriefCheck | null
  /** Every shot group pass 2 produced, approved or not. */
  groupCount: number
  /** Groups actually taken into the plan (`Breakdown.clips.length`). */
  approvedClipCount: number
  /** Approved clips with no prompt authored yet — `studio-workflow.ts`'s
   * `clipsNeedingPrompt(breakdown, versions).length`, the exact set a
   * retry-the-write bulk action would author. */
  clipsNeedingPromptCount: number
  timeline: Timeline
  rendering: boolean
  /** 1 for "Direct and write", 3 for "Directed" — `pipeline.ts`'s own
   * `1 + preset.extraStages.length`. */
  callsPerClip: number
}

export function deriveNextStepInput(src: NextStepSource): NextStepInput {
  const writtenClips = src.timeline.clips.filter((c) => c.state === 'written')
  // `extenderCostEstimate` wants a validated flag per clip to split
  // to-sample from from-cache; every clip counted here is unvalidated by
  // definition (that's what `'written'` means), so this is simpler than
  // routing through `extenderPlanPreview` just to get the same number back.
  const cost = extenderCostEstimate(writtenClips.map((c) => ({ seconds: c.deliveredSeconds, validated: false })))

  return {
    plot: src.plot,
    hasShotList: src.hasShotList,
    awaitingSubdivision: src.awaitingSubdivision,
    thinBriefAlert: src.thinBriefCheck ? thinBriefAlert(src.thinBriefCheck) : null,
    groupCount: src.groupCount,
    approvedClipCount: src.approvedClipCount,
    clipsNeedingPrompt: src.clipsNeedingPromptCount,
    clipsNeedingRender: src.timeline.clips.filter((c) => c.state === 'written').length,
    secondsToRender: cost.totalSeconds,
    rendering: src.rendering,
    clipsAwaitingJudgement: src.timeline.clips.filter((c) => c.state === 'rendered').length,
    keptClipCount: src.timeline.clips.filter((c) => c.state === 'kept').length,
    callsPerClip: src.callsPerClip,
    deliveredSeconds: src.timeline.runtimeBar.keptSeconds,
  }
}
