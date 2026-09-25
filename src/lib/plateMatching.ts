/**
 * Match the state ledger's characters/locations/props against the plates
 * already sitting in PlatesPanel, by name — the "use supplied, generate
 * missing" half of the founder's "paste a chapter -> arbitrary-length
 * video, with plates he may pre-provide and the rest generated" ask.
 *
 * A manual override always wins (the operator assigning a plate to an
 * entity when names don't line up); the auto-match is a fuzzy-normalised
 * name comparison, never exact-string, since a founder-typed plate name
 * ("Nusrat — identity plate") will rarely match a model-proposed ledger
 * entity name ("Nusrat") byte for byte.
 */
import type { LedgerEntity } from './chapterBreakdown'
import type { Plate } from './types'

/** Lowercase, strip everything but letters/digits to single spaces, trim —
 * "Nusrat — identity plate" and "nusrat" both normalise toward
 * "nusrat identity plate" / "nusrat", so a substring match still finds it. */
export function normalizePlateName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function namesMatch(entityName: string, plateName: string): boolean {
  const e = normalizePlateName(entityName)
  const p = normalizePlateName(plateName)
  if (!e || !p) return false
  return e === p || p.includes(e) || e.includes(p)
}

/** One entity's own best-guess plate match by name alone — `null` when
 * nothing in `plates` looks like a match at all (this entity needs a
 * generated plate, or a manual assignment). Ties broken by PLATE ORDER
 * (first match wins), never by anything about the entity itself. */
export function autoMatchPlateForEntity(entityName: string, plates: readonly Plate[]): string | null {
  const match = plates.find((p) => namesMatch(entityName, p.name))
  return match?.id ?? null
}

/**
 * Resolve every ledger entity to a plate id (or `null`, meaning "needs a
 * generated plate"), for the whole ledger at once. `manualAssignments`
 * (entityId -> plateId, or entityId -> '' for "explicitly no plate — do
 * not auto-match this one") always overrides the name-based guess for that
 * entity; an entity absent from `manualAssignments` falls through to
 * `autoMatchPlateForEntity`. A manual assignment naming a plate id that no
 * longer exists (the plate was deleted) reads as `null`, same as no match
 * at all, rather than silently keeping a dangling reference.
 */
export function resolveEntityPlates(
  entities: readonly LedgerEntity[],
  plates: readonly Plate[],
  manualAssignments: Readonly<Record<string, string>> = {},
): Record<string, string | null> {
  const plateIds = new Set(plates.map((p) => p.id))
  const out: Record<string, string | null> = {}
  for (const entity of entities) {
    const manual = manualAssignments[entity.id]
    if (manual !== undefined) {
      out[entity.id] = manual && plateIds.has(manual) ? manual : null
      continue
    }
    out[entity.id] = autoMatchPlateForEntity(entity.name, plates)
  }
  return out
}

/** Every ledger entity with no resolved plate at all — exactly the set
 * `platesOrchestration.ts`'s "generate missing plates" action must author
 * and render a plate for. */
export function entitiesNeedingGeneratedPlates(
  entities: readonly LedgerEntity[],
  resolved: Readonly<Record<string, string | null>>,
): LedgerEntity[] {
  return entities.filter((e) => !resolved[e.id])
}
