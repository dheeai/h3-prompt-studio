/**
 * Presentation-layer arithmetic for the film UI — everywhere a film's length
 * or a scene's work state is shown on screen. Deliberately separate from
 * `extender.ts` (which builds the graph): nothing here changes what gets
 * submitted to ComfyUI, it only decides how to describe what already
 * happened or is about to.
 *
 * Renamed from `chainDisplay.ts` (2026-09-16, Contex-Loop removed) — the
 * Master Extender is the studio's only render path now, so nothing here
 * should keep describing a "chain" that no longer exists. A Master Extender
 * scene pays no overlap tax (see `extender.ts`'s module comment), so
 * `authored === rendered === delivered` for every `PaddedClip` this file
 * receives — the shape survives because a scene's own accounting still has
 * three names worth showing, even though they are always equal now.
 */

/** One scene's frame accounting, as the film UI shows it — see the module
 * comment above for why `authored`/`rendered`/`delivered` are always equal
 * now that Contex-Loop's overlap tax is gone. */
export interface PaddedClip {
  authored: number
  rendered: number
  delivered: number
}

/**
 * H3's scene-length grid, curated to nine round targets (founder,
 * 2026-09-07). Offered as chips rather than a free-form seconds box because
 * an off-grid value is snapped UP *silently* by the sampler, which
 * desynchronises every `[Shot N]` timecode a prompt was written against.
 */
export const SCENE_LENGTH_CHIPS: readonly number[] = [124, 141, 158, 192, 243, 294, 362, 430, 481]

/** H3's own legal-length test: 124f is the floor (H3's shortest clip), and a
 * clip is only ever 17 frames longer than another legal length. */
export function isOnSceneLengthGrid(frames: number): boolean {
  return frames >= 124 && (frames - 5) % 17 === 0
}

/** One decimal place, the precision every mockup and this codebase's copy
 * already uses for an on-screen duration. */
export function secondsLabel(frames: number, fps = 24): string {
  return `${(frames / fps).toFixed(1)}s`
}

export type SceneWorkLabel = 'checkpointed' | 'restored' | 'sampling' | 'queued' | 'failed'

/**
 * What a landed scene's card says depends on whether ITS film has a render
 * in flight right now — not on the scene's own state alone. A done scene
 * reads "checkpointed" at rest; the exact same scene reads "restored" the
 * moment a later scene in the same film starts sampling, because that is
 * literally what the Master Extender's own validated-clip cache is doing to
 * it (serving it back rather than resampling it).
 */
export function sceneWorkLabel(state: 'queued' | 'rendering' | 'done' | 'failed', filmIsRendering: boolean): SceneWorkLabel {
  if (state === 'failed') return 'failed'
  if (state === 'rendering') return 'sampling'
  if (state === 'queued') return 'queued'
  return filmIsRendering ? 'restored' : 'checkpointed'
}

/** Sum of DELIVERED frames/seconds across a film — what the joined file
 * actually runs. */
export function cumulativeFilm(padded: readonly PaddedClip[], fps = 24): { frames: number; seconds: number } {
  const frames = padded.reduce((n, p) => n + p.delivered, 0)
  return { frames, seconds: +(frames / fps).toFixed(3) }
}

/** Cumulative delivered-seconds offset at the START of each scene — the
 * scrubber's per-scene tick labels ("2 · 10.1s" means scene 2 begins at 10.1s
 * into the joined film). */
export function cumulativeSceneStarts(padded: readonly PaddedClip[], fps = 24): number[] {
  let acc = 0
  return padded.map((p) => {
    const start = acc
    acc += p.delivered
    return +(start / fps).toFixed(3)
  })
}

/** The one-line delivered-vs-asked disclosure. Only worth saying anything
 * beyond the plain length when the two numbers actually differ — the Master
 * Extender path never differs (no overlap tax to pay), so this reads as a
 * plain "asked Nf" for every scene now. */
export function deliveredVsAskedLine(p: PaddedClip): string {
  return p.delivered === p.authored ? `asked ${p.authored}f` : `asked ${p.authored}f · delivered ${p.delivered}f`
}
