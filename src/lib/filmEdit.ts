/**
 * The pure arithmetic behind editing an already-rendered film in place —
 * Continue-from-here (any scene, not just the newest — founder addition
 * 2026-09-07). Kept separate from `state.tsx` so it is testable without a
 * React/IndexedDB harness.
 *
 * Renamed from `chainEdit.ts` (2026-09-16, Contex-Loop removed) — the Master
 * Extender is the studio's only render path now, and its scenes are
 * addressed by `Clip.extender` (`nodeId`/`sceneIndex`), not `Clip.chain`.
 * Continuing from an EARLIER scene, not the newest, still discards every
 * scene after it out of local state: the Master Extender's own
 * validated-clip cache is a linear prefix, so a scene that no longer follows
 * what actually rendered before it can no longer be trusted as "already
 * sampled" either.
 */

type FilmedClip = { extender?: { nodeId: string; sceneIndex: number } }

/** Keep every clip EXCEPT one belonging to `nodeId` at or after `fromIndex` —
 * the local-state half of "a film is a linear prefix": a scene at or after
 * the target is either the one about to be resubmitted, or one that no
 * longer follows a predecessor that still matches what rendered it. Clips
 * outside `nodeId` are untouched. */
export function dropFromIndex<T extends FilmedClip>(clips: readonly T[], nodeId: string, fromIndex: number): T[] {
  return clips.filter((c) => !(c.extender?.nodeId === nodeId && c.extender.sceneIndex >= fromIndex))
}

/** How many scenes of `nodeId`, from `fromIndex` on, currently exist — what
 * a Continue-from-here targeting `fromIndex` would discard. Zero when there
 * is nothing to lose. */
export function countFromIndex(clips: readonly FilmedClip[], nodeId: string, fromIndex: number): number {
  return clips.filter((c) => c.extender?.nodeId === nodeId && c.extender.sceneIndex >= fromIndex).length
}

/** A pipeline-authored draft, not yet rendered, pending at the position it
 * would occupy once submitted — see `dropInvalidatedAutoDraft`. */
export interface PendingAutoDraft {
  versionId: string
  sceneIndex: number
}

/**
 * Discard a pipeline-authored draft once its parent scene is continued-from-
 * early — HAZARD 1 in the 2026-09-16 brief. A pre-authored, not-yet-rendered
 * draft for `pending.sceneIndex` was written against its parent's OLD frame
 * and OLD prompt, so it goes stale the moment something AT OR BEFORE that
 * position gets rewritten — exactly the same condition
 * `dropFromIndex`/`countFromIndex` already apply to RENDERED scenes.
 *
 * `fromIndex` is the scene actually being (re)written right now (a fresh
 * Continue-from-here's own target). Note the boundary is
 * `pending.sceneIndex > fromIndex`, not `>=`: writing AT `pending.sceneIndex`
 * is the ordinary case of rendering the pre-authored draft itself (or
 * overwriting it with something fresh) — that is consumption, not
 * invalidation, so it must never be discarded out from under a render
 * already in flight for it.
 */
export function dropInvalidatedAutoDraft<V extends { id: string }>(
  versions: readonly V[],
  pending: PendingAutoDraft | null | undefined,
  fromIndex: number,
): { versions: V[]; discarded: boolean } {
  if (!pending || pending.sceneIndex <= fromIndex) return { versions: versions as V[], discarded: false }
  return { versions: versions.filter((v) => v.id !== pending.versionId), discarded: true }
}
