import type { Clip, ClipChainInfo } from './types'

/**
 * The pure arithmetic behind editing an already-rendered chain in place —
 * Replace and Continue-from-here (any scene, not just the newest — founder
 * addition 2026-09-07). Kept separate from `state.tsx` so it is testable
 * without a React/IndexedDB harness; `state.tsx`'s `renderChain`/`replaceScene`
 * are the only callers.
 *
 * Both operations reduce to the same shape: submit `sceneRange: "N:N"`,
 * resend every scene BEFORE N byte-identically from what actually rendered
 * it, and drop every scene FROM N on out of local state — Contex-Loop is
 * append-only, so a scene after the target can no longer verify its resume
 * hash against a predecessor that no longer matches what rendered it.
 */

type ChainedClip = Pick<Clip, 'prompt' | 'frames' | 'steps' | 'seed'> & { chain: ClipChainInfo }

/** ComfyUI's scene-range scheduler syntax for resampling exactly one scene. */
export function sceneRangeFor(index: number): string {
  return `${index}:${index}`
}

/** Every scene of `runName` strictly BEFORE `targetIndex`, in scene order —
 * what must be resent byte-identically so Contex-Loop's `verify_resume_history`
 * matches what actually rendered them. Scoped to `sceneIndex < targetIndex`
 * (not merely "same runName") so replacing or continuing from an EARLIER
 * scene never resends a later one that `dropFromIndex` is about to discard. */
export function scenesBefore<T extends ChainedClip>(clips: readonly T[], runName: string, targetIndex: number): T[] {
  return clips
    .filter((c) => c.chain.runName === runName && c.chain.sceneIndex < targetIndex)
    .sort((a, b) => a.chain.sceneIndex - b.chain.sceneIndex)
}

/** Keep every clip EXCEPT one belonging to `runName` at or after `fromIndex` —
 * the local-state half of "append-only": a scene at or after the target is
 * either the one about to be resubmitted (a Replace overwriting it in place)
 * or one that no longer resumes against a predecessor that still matches what
 * rendered it (everything after). Clips outside `runName` are untouched. */
export function dropFromIndex<T extends { chain?: ClipChainInfo }>(clips: readonly T[], runName: string, fromIndex: number): T[] {
  return clips.filter((c) => !(c.chain?.runName === runName && c.chain.sceneIndex >= fromIndex))
}

/** How many scenes of `runName`, from `fromIndex` on, currently exist — what
 * a Replace or a Continue-from-here targeting `fromIndex` would discard.
 * Zero when there is nothing to lose. */
export function countFromIndex(clips: readonly { chain?: ClipChainInfo }[], runName: string, fromIndex: number): number {
  return clips.filter((c) => c.chain?.runName === runName && c.chain.sceneIndex >= fromIndex).length
}

/**
 * What a Replace of `target` should re-pass as scene 1's external-video
 * predecessor, if anything — see `ClipChainInfo.externalVideo`'s module
 * comment. Only scene 1 can have one (Contex-Loop's `_initial_state` only
 * reads `external_context` when the range starts there), so any other scene
 * always gets `null` regardless of what is recorded on it.
 */
export function externalVideoForReplace(target: Pick<Clip, 'chain'>): ClipChainInfo['externalVideo'] | null {
  if (!target.chain || target.chain.sceneIndex !== 1 || !target.chain.externalVideo) return null
  return { ...target.chain.externalVideo }
}
