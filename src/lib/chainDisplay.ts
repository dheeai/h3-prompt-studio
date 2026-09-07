/**
 * Presentation-layer arithmetic for the chain-flow UI — everywhere a chain's
 * length or a scene's work state is shown on screen. Deliberately separate
 * from `chain.ts` (which builds the graph) and `frames.ts` (which owns the
 * frame-grid math): nothing here changes what gets submitted to ComfyUI, it
 * only decides how to describe what already happened or is about to.
 */
import { padForOverlap } from './frames'
import type { PaddedClip } from './frames'

/**
 * H3's Contex-Loop scene-length grid, curated to nine round targets (founder,
 * 2026-09-07) — every value satisfies `isOnSceneLengthGrid`. Offered as chips
 * rather than a free-form seconds box because an off-grid value is snapped UP
 * *silently* by the sampler, which desynchronises every `[Shot N]` timecode a
 * prompt was written against.
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
 * What a landed scene's card says depends on whether ITS chain has a render
 * in flight right now — not on the scene's own state alone. A done scene
 * reads "checkpointed" at rest; the exact same scene reads "restored" the
 * moment a later scene in the same chain starts sampling, because that is
 * literally what ComfyUI is doing to it (loading it back from disk rather
 * than resampling it) — see the Contex-Loop work-ledger design note.
 */
export function sceneWorkLabel(state: 'queued' | 'rendering' | 'done' | 'failed', chainIsRendering: boolean): SceneWorkLabel {
  if (state === 'failed') return 'failed'
  if (state === 'rendering') return 'sampling'
  if (state === 'queued') return 'queued'
  return chainIsRendering ? 'restored' : 'checkpointed'
}

/** Sum of DELIVERED frames/seconds across a chain — what the joined file
 * actually runs. Never sum `authored`: the overlap tax means a chain of N
 * continued scenes always delivers more than it was asked for. */
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
 * beyond the plain length when the two numbers actually differ — a first
 * scene with no overlap to pay for has nothing to disclose. */
export function deliveredVsAskedLine(p: PaddedClip): string {
  return p.delivered === p.authored ? `asked ${p.authored}f` : `asked ${p.authored}f · delivered ${p.delivered}f`
}

/** The "what you will get" numbers for the video door (`FromVideo.dc.html`). */
export interface VideoDoorEstimate {
  sourceSeconds: number
  askedFrames: number
  deliveredFrames: number
  deliveredSeconds: number
  filmSeconds: number
}

/**
 * What continuing a video actually lands as: the source's own length, plus
 * scene 1 once it has paid the join's overlap tax — see `padForOverlap`'s
 * `firstHasPredecessor`, which is what makes this differ from treating scene 1
 * as an unoverlapped first clip. Measured live 2026-09-07: a 56.928s source
 * plus a 124f (5.2s) scene asked for landed at 61.167s — this predicts
 * 61.178s, matching within encoding rounding.
 */
export function videoDoorEstimate(sourceSeconds: number, askedFrames: number, overlap: number, fps = 24): VideoDoorEstimate {
  const [scene1] = padForOverlap([{ frames: askedFrames }], overlap, { firstHasPredecessor: true })
  return {
    sourceSeconds,
    askedFrames: scene1.authored,
    deliveredFrames: scene1.delivered,
    deliveredSeconds: +(scene1.delivered / fps).toFixed(3),
    filmSeconds: +(sourceSeconds + scene1.delivered / fps).toFixed(3),
  }
}
