import { EXTENDER_SIGNATURE_FIELDS } from './extender'

/**
 * The Master Extender settings panel's own small bookkeeping — kept separate
 * from `extender.ts` because none of this decides whether a build is safe
 * (that stays `buildExtenderGraph`'s guard, the only authority on that); this
 * is purely UI-side: which field to badge as frozen, and how to fold one
 * edit into `Settings.extenderOverrides` without ever storing a no-op copy
 * of the graph's own baked value.
 */

/**
 * Is this field one the node hashes (`EXTENDER_SIGNATURE_FIELDS`) — frozen
 * the instant any clip in the film is validated — or free to change mid-film?
 * The panel must show this BEFORE an edit, per the brief: discovering it from
 * a refusal at submit time is too late to be useful.
 */
export function isExtenderFieldFrozen(field: string): boolean {
  return (EXTENDER_SIGNATURE_FIELDS as readonly string[]).includes(field)
}

/**
 * Merge the graph's own baked master-node inputs with the operator's stored
 * overrides — what every control in the panel actually displays, and what
 * `extenderGeometryFromInputs` reads the topbar's geometry off. `undefined`
 * overrides (nothing customized, or an explicit "reset all") is a no-op
 * merge, so this doubles as "restore the graph's baked value" whenever the
 * overrides are cleared.
 */
export function mergeExtenderInputs(
  baked: Record<string, unknown> | null,
  overrides: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!baked) return null
  return { ...baked, ...overrides }
}

/**
 * Fold one field edit into an overrides record — storing ONLY fields that
 * actually differ from the graph's own baked value, so an untouched install
 * sends nothing and a later graph update is never silently shadowed by a
 * stale copy (the brief's own requirement, 2026-09-16). Setting a field back
 * to its baked value removes the override entirely rather than keeping a
 * no-op duplicate; the return is `undefined` (never `{}`) once every field is
 * back at baked, so a downstream `settings.extenderOverrides` reads as
 * genuinely unset.
 */
export function withExtenderOverride(
  overrides: Record<string, unknown> | undefined,
  baked: Record<string, unknown> | null,
  field: string,
  value: unknown,
): Record<string, unknown> | undefined {
  const next = { ...(overrides ?? {}) }
  const bakedValue = baked?.[field]
  if (JSON.stringify(value) === JSON.stringify(bakedValue)) delete next[field]
  else next[field] = value
  return Object.keys(next).length ? next : undefined
}
