/**
 * H3's frame grid and the Contex-Loop overlap tax — the two pure, unit-tested
 * pieces that used to live in `multiclip.ts` alongside the (now removed) Long
 * Media multiclip path. `chain.ts` is their only consumer; kept as their own
 * module rather than folded into chain.ts so the grid math stays testable
 * independent of any one render path.
 */

/** H3 snaps continuation clips up onto its 17k+5 grid, never down — a clip is
 * never shorter than the prose it was authored for. The excess lands as at
 * most 16 frames of tail. */
export function snapUp(frames: number): number {
  let n = Math.max(124, frames)
  while ((n - 5) % 17 !== 0) n += 1
  return n
}

export interface PaddedClip {
  /** What the operator asked for. */
  authored: number
  /** What gets SAMPLED — bumped by the overlap tax and re-snapped to the grid. */
  rendered: number
  /** What survives the trim — this is what the film actually runs. */
  delivered: number
}

/**
 * The overlap tax, paid explicitly.
 *
 * With head anchors, every clip after the first REPEATS the previous clip's
 * last `overlap` frames at its head and the trim removes them — so it
 * DELIVERS `overlap` fewer frames than it RENDERS. Left unpaid, this is a real
 * loss: h3-shots measured 4 shots authored at 1176f/49.000s land at
 * 1110f/46.250s when submitted at their authored lengths unpadded — short by
 * exactly 66f, 3 boundaries x 22. `padForOverlap` asks for `authored+overlap`
 * on every clip but the first, so the trim has something to remove without
 * eating into the prose the clip was written for.
 */
export function padForOverlap(clips: Array<{ frames: number }>, overlap: number): PaddedClip[] {
  return clips.map((c, i) => {
    const authored = c.frames
    // The FIRST clip is snapped too, which h3-shots does not need to do: there
    // the frame count comes from a project file already authored onto the grid,
    // whereas here it is derived from a plan's seconds and carries no floor.
    // `snapFrames` rounds onto 17k+5 but bottoms out at 5, so a short plan clip
    // could ask clip 1 for 73 frames while every clip after it got at least
    // 124 — snapUp is identity on an on-grid count of 124 or more, so this
    // matches h3-shots wherever h3-shots applies and only bites the short case.
    const rendered = i === 0 ? snapUp(authored) : snapUp(authored + overlap)
    const delivered = i === 0 ? rendered : rendered - overlap
    return { authored, rendered, delivered }
  })
}
