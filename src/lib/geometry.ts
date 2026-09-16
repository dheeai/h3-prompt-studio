/**
 * Frame-grid math, measured render geometries, and H3's reference caps.
 *
 * Salvaged out of the deleted `recipe.ts` (the plain single-clip render path
 * — Recipe/Binding detection — removed 2026-09-16 once the Master Extender
 * became the studio's only render path). None of this is Recipe-specific:
 * `framesForSeconds` is how EVERY render path states a clip's length (the
 * Master Extender's own `clips_json.duration` is sent in seconds and
 * converted by the node itself — see `extender.ts`'s module comment, which
 * is why this file carries no `snapFrames` call for that path — but the
 * Studio still snaps the composer's own length picker and the stage
 * templates' duration line against the same grid), and `oomRisk`/
 * `GEOMETRY_PRESETS`/`REF_CAPS` are facts about the BOX and about H3 itself,
 * never about any one workflow graph.
 */

/** H3 snaps length to a 17k+5 grid. Anything else is rounded DOWN onto it. */
export function snapFrames(frames: number): number {
  const k = Math.max(0, Math.round((frames - 5) / 17))
  return Math.max(5, k * 17 + 5)
}

export function framesForSeconds(seconds: number, fps = 24): number {
  return snapFrames(Math.round(seconds * fps))
}

export function secondsForFrames(frames: number, fps = 24): number {
  return frames / fps
}

/**
 * Measured render geometries — what actually got tested on the box, offered
 * instead of a free-form width/height guess.
 */
export const GEOMETRY_PRESETS: Array<{ width: number; height: number; label: string; aspect: string; note: string }> = [
  { width: 960, height: 544, label: '960×544', aspect: '16:9', note: 'The safe default — carries 481 frames comfortably' },
  { width: 1216, height: 672, label: '1216×672', aspect: '16:9', note: 'Validated — what the 27-clip film of 2026-09-06 shipped on' },
  { width: 1088, height: 608, label: '1088×608', aspect: '16:9', note: 'Larger' },
  { width: 864, height: 480, label: '864×480', aspect: '16:9', note: 'Cheaper' },
  { width: 1344, height: 768, label: '1344×768', aspect: '16:9', note: 'Largest — measured to run out of memory past 362 frames' },
  { width: 576, height: 1024, label: '576×1024', aspect: '9:16', note: 'Portrait' },
  { width: 704, height: 704, label: '704×704', aspect: '1:1', note: 'Square' },
]

/**
 * VRAM binds before quality does, and an OOM is not a normal failure.
 *
 * At 1344x768 the box measured running OUT of memory around 362 frames — and
 * the OOM takes ComfyUI down WITH the render, so a crashed job is
 * indistinguishable from one that was never submitted (`/history` comes back
 * empty either way). Cost scales roughly as pixels^1.3, so this is a WARNING at
 * or above the tier it was measured on, never a hard block: the fix is to trade
 * resolution for length, and that trade is the operator's to make, not ours.
 */
export const OOM_WIDTH = 1344
export const OOM_HEIGHT = 768
export const OOM_FRAMES = 362

export function oomRisk(width: number, height: number, frames: number): boolean {
  return width >= OOM_WIDTH && height >= OOM_HEIGHT && frames > OOM_FRAMES
}

/** H3's own reference-image/video caps. */
export const REF_CAPS = { image: 9, video: 3 } as const
