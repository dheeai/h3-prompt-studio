import type { Clip } from './types'

/**
 * What a rehydrated `Clip` left mid-render becomes on load (issue #35's own
 * "decide deliberately" ask).
 *
 * A `Clip` at `state: 'rendering'` with a `promptId` is NOT still rendering
 * the moment this loads: the poll loop that was tracking it lived in a
 * closure in the tab that just went away, and `renderingId` (the ref to
 * "the job THIS tab is watching") always comes back `null` on a fresh boot,
 * regardless of what a persisted `Clip` record says. Two wrong answers were
 * available and both were rejected:
 *
 *   - Trust it (leave `state: 'rendering'`): the UI would show a spinner
 *     for a job nothing is polling, forever — indistinguishable from a
 *     real render, but it will never resolve.
 *   - Silently drop it (delete the `Clip`, or reset it to `queued`): loses
 *     the one thing that lets an operator actually find out what happened
 *     — the `promptId`, ComfyUI's own `/history` key.
 *
 * `pollExtender` (`comfy.ts`) already knows how to read a history entry by
 * `promptId` and could re-poll it, but doing that automatically on load is
 * a network call the operator never asked for — refused per the brief.
 * Instead this makes the clip VISIBLY stale: `state: 'failed'` (the
 * existing terminal state every render path and every UI card already
 * knows how to show), with an `error` that names the `promptId` so a
 * manual check against the box is still possible, and the operator decides
 * what to do next. `redoScene`/`redoPlanClip` both key off `clip.extender`
 * (nodeId/sceneIndex), never off `clip.state`, so Redo keeps working on a
 * clip reconciled this way exactly as it would on a genuine failure.
 */
export function reconcileRehydratedClips(clips: Clip[]): Clip[] {
  return clips.map((c) =>
    c.state === 'rendering'
      ? {
          ...c,
          state: 'failed',
          error: `Interrupted by a reload before this render finished${
            c.promptId ? ` (ComfyUI prompt id ${c.promptId})` : ''
          } — check the box's own queue/history if you need the result, or Redo this clip to render again.`,
        }
      : c,
  )
}
