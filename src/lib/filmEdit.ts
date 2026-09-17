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
 *
 * Also carries the REDO primitives (2026-09-16, "bring back redo a single
 * scene" — see `state.tsx`'s `redoScene`/`redoPlanClip`): redoing scene N is
 * the SAME linear-prefix invalidation as Continue-from-here, aimed at N
 * itself rather than at N+1 — `dropFromIndex(clips, nodeId, N)` is the whole
 * mechanism, no separate redo-specific drop function needed. What redo adds
 * on top is `validatedClipAt` (the one "is this scene still validated?"
 * predicate `renderExtenderPlan` and its own cost preview must never answer
 * differently — see the module comment on `Clip.extender`) and `redoSeed`
 * (a redo must not silently resend the exact seed it already rendered with,
 * or it is a no-op that costs GPU time for an identical clip).
 */

type FilmedClip = { extender?: { nodeId: string; sceneIndex: number } }
type StatedClip = FilmedClip & { state?: string }

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

/**
 * The landed `done` Clip for `nodeId` at `sceneIndex`, if one exists — the
 * single definition of "this scene is validated" shared by
 * `extenderPlanPreview`'s cost/status preview and `renderExtenderPlan`'s
 * actual resubmit (`priorFor`), so the two can never drift apart (they used
 * to be two separately-written copies of the same filter). After a redo
 * drops the Clip records from `sceneIndex` on (`dropFromIndex`), this
 * correctly returns `undefined` for every dropped index and the untouched
 * clip for every index still before it.
 */
export function validatedClipAt<T extends StatedClip>(clips: readonly T[], nodeId: string, sceneIndex: number): T | undefined {
  return clips.find((c) => c.extender?.nodeId === nodeId && c.extender.sceneIndex === sceneIndex && c.state === 'done')
}

/**
 * The seed a redo should submit for one scene. `keepSeed` reuses the scene's
 * own previously-recorded seed exactly — the right choice only when the
 * PROMPT changed and the operator wants to see it against the same noise.
 * Otherwise (the default) a fresh seed, via the injected `randomSeed` —
 * identical prompt + identical seed + identical settings returns a
 * byte-identical clip, so a redo that does not change the seed would cost
 * GPU time for nothing (the 2026-09-16 brief). `randomSeed` is a parameter
 * rather than `Math.random()` inline so this stays deterministic under test.
 */
export function redoSeed(priorSeed: number | undefined, keepSeed: boolean | undefined, randomSeed: () => number): number {
  return keepSeed ? (priorSeed ?? 0) : randomSeed()
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

/**
 * What every clip of a STOPPED submit reverts to (2026-09-17 brief: "no way
 * to cancel a job"). Shared by both render paths — `renderExtenderPlan`'s
 * whole-plan submit and `renderExtender`'s single scene — since the GPU
 * mutex guarantees at most one job, and therefore at most one nodeId's worth
 * of `'rendering'` clips, exists at a time.
 *
 * Never `'failed'`: nothing failed, the operator asked for exactly this.
 * Never left `'rendering'`: the mutex releases in the same breath the job is
 * told to stop, so nothing should still read as in flight. Only a clip
 * actually `'rendering'` for THIS nodeId is touched — a clip of the SAME
 * film that had already landed `'done'` before this submit even started (or
 * one from an unrelated film entirely) is left exactly as it is.
 */
export function clipsAfterStop<T extends StatedClip>(clips: readonly T[], nodeId: string): T[] {
  return clips.map((c) =>
    c.extender?.nodeId === nodeId && c.state === 'rendering' ? ({ ...c, state: 'queued' } as T) : c,
  )
}
