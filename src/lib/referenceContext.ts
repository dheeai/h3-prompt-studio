/**
 * Glue between the state ledger (`chapterBreakdown.ts`), the plate registry
 * (`plateMatching.ts`) and the >9-slot batch planner (`chapterBatching.ts`)
 * — resolves what ONE clip's own ref slots and reference registry are,
 * batch-aware, so both the authoring call (preset D, `state.tsx`'s
 * `rebuild()`) and the render submission (`renderExtenderPlan`) read the
 * SAME slot assignment for a given clip, computed the SAME way.
 *
 * A chapter's ref slots are NOT film-wide when it needed a >9-slot split —
 * they are per-BATCH (`ChapterBatch.entityIds`), so this always resolves
 * "which batch is this clip in" first (`planChapterBatches`, cheap enough
 * to recompute per clip at chapter sizes this planner produces — a few
 * hundred operations, not worth caching for a ~20-30 clip chapter).
 */
import { assignRefSlots, type ChapterBreakdown, type ReferencePlateInfo, type RefSlot } from './chapterBreakdown'
import { planChapterBatches } from './chapterBatching'
import type { Plate } from './types'

export interface ClipReferenceContext {
  refSlots: RefSlot[]
  registry: Record<string, ReferencePlateInfo>
}

/**
 * `resolvedPlates` is `plateMatching.ts`'s `resolveEntityPlates` output —
 * entityId -> plateId | null. An entity resolved to `null` contributes no
 * ref slot and is absent from the registry (nothing to cite it with).
 */
export function referenceContextForClip(
  b: ChapterBreakdown,
  clipIndex: number,
  resolvedPlates: Readonly<Record<string, string | null>>,
  plates: readonly Plate[],
): ClipReferenceContext {
  const hasPlate = (entityId: string) => !!resolvedPlates[entityId]
  const batchPlan = planChapterBatches(b, hasPlate)
  const batch = batchPlan.batches.find((x) => clipIndex >= x.clipFrom && clipIndex <= x.clipTo)
  const batchEntityIds = new Set(batch?.entityIds ?? [])
  const { refSlots } = assignRefSlots(b.ledger, (id) => batchEntityIds.has(id))

  const plateById = new Map(plates.map((p) => [p.id, p]))
  const registry: Record<string, ReferencePlateInfo> = {}
  for (const entity of b.ledger.entities) {
    if (!batchEntityIds.has(entity.id)) continue
    const plateId = resolvedPlates[entity.id]
    const plate = plateId ? plateById.get(plateId) : undefined
    registry[entity.id] = {
      name: entity.name,
      role: entity.kind,
      // The plate's OWN analysis (`Plate.job`, `analyzeSubjectImage`'s
      // "what's in the picture" text) — NEVER the ledger's narrative arc
      // language. `formatReferencesBlock` also defensively strips
      // plate-artifact vocabulary, so this is belt and suspenders, not the
      // only guard.
      description: plate?.job ?? '',
      clipIds: entity.clipIds,
    }
  }
  return { refSlots, registry }
}
