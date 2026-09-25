/**
 * Split a chapter into consecutive Master Extender submissions when it
 * needs more than H3's 9 global reference slots — "long chapters vs the 9
 * global ref slots" from the founder's "paste a chapter -> arbitrary-length
 * video" brief. `refs_json` is global to ONE render job (every clip in a
 * submission shares the SAME nine slots — `extender.ts`'s own module
 * comment); a chapter whose ledger names more than nine distinct on-screen
 * entities across its whole runtime cannot be one job at all, so this
 * plans where to cut it instead.
 *
 * A single submission is kept whenever the chapter fits (≤9 distinct
 * entities with a plate, chapter-wide) — this planner is a no-op in the
 * common case, never a second code path the common case has to route
 * through.
 */
import type { ChapterBreakdown } from './chapterBreakdown'

export interface ChapterBatch {
  /** 1-based position among this chapter's own batches. */
  index: number
  /** Inclusive clip-number range this batch covers, by CLIP ORDER — every
   * batch is a consecutive run of clips, never a scattered selection. */
  clipFrom: number
  clipTo: number
  /** Distinct entities (with a resolved plate) on screen anywhere in this
   * batch's clip range — never more than the caller's own `maxRefsPerBatch`
   * (H3's 9, by default), by construction. */
  entityIds: string[]
}

export interface ChapterBatchPlan {
  batches: ChapterBatch[]
  /**
   * Entities that appear in MORE THAN ONE batch — the actual continuity
   * cost of a split, since `refs_json` carries no continuity across two
   * separate Master Extender jobs: an entity split across a boundary gets
   * re-submitted as a fresh reference in every batch that needs it (same
   * plate image, a different, unrelated slot number each time — H3 has no
   * notion that slot 3 in job A and slot 1 in job B are "the same"
   * reference). Empty when the chapter fits in one batch.
   */
  splitEntityIds: string[]
  /**
   * A single clip whose OWN on-screen entity count already exceeds
   * `maxRefsPerBatch` — cannot be resolved by cutting between clips, since
   * a clip is never split. Reported as a fact for the operator (drop a
   * plate's binding for that one clip, or accept fewer references than
   * entities on screen), never silently truncated.
   */
  overflowClips: number[]
}

/**
 * Plan the batches. `hasPlate` decides which ledger entities actually
 * count toward the 9-slot budget — an entity with no resolved plate at all
 * contributes no ref slot in ANY batch, so it never forces a split.
 */
export function planChapterBatches(b: ChapterBreakdown, hasPlate: (entityId: string) => boolean, maxRefsPerBatch = 9): ChapterBatchPlan {
  const clipsSorted = [...b.clips].sort((x, y) => x.clip - y.clip)
  const entitiesByClip = new Map<number, string[]>()
  for (const clip of clipsSorted) {
    const onScreen = b.ledger.entities.filter((e) => e.clipIds.includes(clip.clip) && hasPlate(e.id)).map((e) => e.id)
    entitiesByClip.set(clip.clip, onScreen)
  }

  const batches: ChapterBatch[] = []
  const overflowClips: number[] = []
  let currentClips: number[] = []
  let currentEntities = new Set<string>()

  const closeBatch = () => {
    if (!currentClips.length) return
    batches.push({
      index: batches.length + 1,
      clipFrom: currentClips[0],
      clipTo: currentClips[currentClips.length - 1],
      entityIds: [...currentEntities],
    })
    currentClips = []
    currentEntities = new Set()
  }

  for (const clip of clipsSorted) {
    const thisClipEntities = entitiesByClip.get(clip.clip) ?? []
    if (thisClipEntities.length > maxRefsPerBatch) overflowClips.push(clip.clip)

    const candidate = new Set(currentEntities)
    for (const id of thisClipEntities) candidate.add(id)

    if (currentClips.length && candidate.size > maxRefsPerBatch) {
      closeBatch()
      currentClips.push(clip.clip)
      currentEntities = new Set(thisClipEntities)
    } else {
      currentClips.push(clip.clip)
      currentEntities = candidate
    }
  }
  closeBatch()

  const seenIn = new Map<string, number>()
  for (const batch of batches) for (const id of batch.entityIds) seenIn.set(id, (seenIn.get(id) ?? 0) + 1)
  const splitEntityIds = [...seenIn.entries()].filter(([, count]) => count > 1).map(([id]) => id)

  return { batches, splitEntityIds, overflowClips }
}
