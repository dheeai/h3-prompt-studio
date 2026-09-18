/**
 * What to do next — as ONE computed answer, never a thing to work out.
 *
 * WHY THIS EXISTS. Founder, 2026-09-18: "The whole flow is super confusing.. We
 * go to tab 2 first, then the user needs to know to go to tab 1 for timeline?
 * Now that I have got shots and direction what now? There is no option to
 * select all and render in 1 shot? I dont even know what to do!"
 *
 * All three complaints are one defect. Full Story was a row of tabs named after
 * SCREENS, so the operator had to hold the pipeline's order in their own head
 * and navigate it by hand — and the order was not even the tab order, since
 * the plot lives on the second tab and the timeline on the first. The redesign
 * board this came from said it outright, "the tabs are not the flow", and then
 * a fifth tab was added anyway.
 *
 * The fix is not better labels. It is that the app knows exactly where a film
 * is and can therefore say the one next thing, with its cost, at all times.
 * This module is that knowledge, as a pure function, so it is testable and
 * cannot drift from what the buttons actually do.
 *
 * DESIGN RULES, in priority order:
 *  - ONE primary action. Never two. A screen offering two next steps has not
 *    decided, and the operator pays for that.
 *  - Say the COST before it is spent: how many model calls, or how many
 *    seconds of GPU. `geometry.ts`'s `oomRisk` and `checkRuntimeCeiling` are
 *    this codebase's precedent — disclose, never decide for them.
 *  - BULK BY DEFAULT past the plan. "Write prompts for 4 clips" and "Render 4
 *    clips" are single actions, because doing them one at a time was the
 *    founder's "no option to select all and render in 1 shot".
 *  - Never block. Every step has a way onward even when something is wrong
 *    (an over-run ceiling, a thin brief, a failed clip).
 */

/** The kinds of next step, in pipeline order. The order of this union IS the
 * order of the film's life, and `nextStep` resolves the FIRST one that
 * applies — so a film with an unwritten clip 3 and an unrendered clip 1 is
 * told to write, because writing is free and rendering is not. */
export type NextStepKind =
  | 'write-plot'
  | 'make-shot-list'
  | 'resolve-thin-brief'
  | 'approve-groups'
  | 'write-prompts'
  | 'render-clips'
  | 'stop-or-wait'
  | 'watch-and-keep'
  | 'film-done'

export interface NextStep {
  kind: NextStepKind
  /** The button's own words. An imperative naming the object, never "Continue". */
  action: string
  /** What this will do, in one sentence the operator can act on. */
  detail: string
  /** The price, stated before it is paid. `null` when free. */
  cost: string | null
  /** Whether the primary action can be pressed right now. A step that needs
   * typing (the plot) has nothing to press, and that is not a failure state. */
  actionable: boolean
  /** True when the GPU is about to be spent. The one place a confirm is worth
   * its friction. */
  spendsGpu: boolean
}

export interface NextStepInput {
  plot: string
  /** Has a shot list been authored at all. */
  hasShotList: boolean
  /** Beats landed but subdividing has not run — the thin-brief pause. */
  awaitingSubdivision: boolean
  /** The thin-brief warning, when one is standing. */
  thinBriefAlert: string | null
  /** Clip groups the planner produced. */
  groupCount: number
  /** Groups the operator has approved into the plan. */
  approvedClipCount: number
  /** Approved clips with no prompt authored yet. */
  clipsNeedingPrompt: number
  /** Clips with a prompt and no render. */
  clipsNeedingRender: number
  /** Seconds those unrendered clips will sample. */
  secondsToRender: number
  /** A render is in flight. */
  rendering: boolean
  /** Clips rendered but not yet kept. */
  clipsAwaitingJudgement: number
  /** Clips locked in. */
  keptClipCount: number
  /** Extra model calls each clip costs under the active preset: 1 for
   * "Direct and write", 3 for "Directed". */
  callsPerClip: number
  /** The film's delivered length so far, for the finished message. */
  deliveredSeconds: number
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function nextStep(i: NextStepInput): NextStep {
  if (!i.plot.trim()) {
    return {
      kind: 'write-plot',
      action: 'Write the plot',
      detail: 'What happens, start to finish, in your own words. Everything else is derived from it.',
      cost: null,
      actionable: false,
      spendsGpu: false,
    }
  }

  if (!i.hasShotList) {
    return {
      kind: 'make-shot-list',
      action: 'Make the shot list',
      detail: 'Breaks the plot into beats, then decomposes each beat into shots that fill its share of the runtime.',
      cost: 'one call for the beats, then one per beat',
      actionable: true,
      spendsGpu: false,
    }
  }

  // The thin-brief pause is deliberately BEFORE subdividing, so the warning
  // lands before the calls are spent rather than after.
  if (i.awaitingSubdivision) {
    return {
      kind: 'resolve-thin-brief',
      action: 'Subdivide anyway',
      detail: i.thinBriefAlert
        ? `${i.thinBriefAlert} Lower the runtime for a tighter film, or carry on and accept the padding.`
        : 'Decompose each beat into shots.',
      cost: 'one call per beat',
      actionable: true,
      spendsGpu: false,
    }
  }

  if (i.approvedClipCount === 0 && i.groupCount > 0) {
    return {
      kind: 'approve-groups',
      action: `Approve ${plural(i.groupCount, 'clip')}`,
      detail: 'Locks the shot grouping in so prompts can be written against it. Regrouping before this costs nothing.',
      cost: null,
      actionable: true,
      spendsGpu: false,
    }
  }

  // Writing is free and rendering is not, so an unwritten clip always comes
  // first even when an earlier clip is already waiting to render.
  if (i.clipsNeedingPrompt > 0) {
    const calls = i.clipsNeedingPrompt * i.callsPerClip
    return {
      kind: 'write-prompts',
      action: `Write prompts for ${plural(i.clipsNeedingPrompt, 'clip')}`,
      detail:
        i.callsPerClip > 1
          ? 'Each clip is directed, then performed, then written. Nothing is rendered yet, so this is still free to redo.'
          : 'Each clip is directed and written in one pass. Nothing is rendered yet, so this is still free to redo.',
      cost: `${plural(calls, 'model call')}`,
      actionable: true,
      spendsGpu: false,
    }
  }

  if (i.rendering) {
    return {
      kind: 'stop-or-wait',
      action: 'Stop rendering',
      detail: 'Anything already finished stays cached and is never resampled. The clip in flight will not exist.',
      cost: null,
      actionable: true,
      spendsGpu: false,
    }
  }

  if (i.clipsNeedingRender > 0) {
    return {
      kind: 'render-clips',
      action: `Render ${plural(i.clipsNeedingRender, 'clip')}`,
      detail: 'All of them, in one job. Clips you have already kept come back from cache and are never resampled.',
      cost: `${i.secondsToRender.toFixed(1)}s of sampling`,
      actionable: true,
      spendsGpu: true,
    }
  }

  if (i.clipsAwaitingJudgement > 0) {
    return {
      kind: 'watch-and-keep',
      action: `Watch ${plural(i.clipsAwaitingJudgement, 'clip')}`,
      detail: 'Keep it to lock it in, or redo it. Keeping is what lets the next clip render against it.',
      cost: null,
      actionable: true,
      spendsGpu: false,
    }
  }

  return {
    kind: 'film-done',
    action: 'Save the film',
    detail:
      i.keptClipCount > 0
        ? `${plural(i.keptClipCount, 'clip')} kept, ${i.deliveredSeconds.toFixed(1)}s delivered. Add to the plot and remake the shot list to carry on.`
        : 'Nothing kept yet.',
    cost: null,
    actionable: true,
    spendsGpu: false,
  }
}
