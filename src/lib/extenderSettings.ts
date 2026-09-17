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

/**
 * Fold a PATCH of several fields at once into the overrides record — what
 * the panel's two remaining controls actually produce (each one moves more
 * than one node field together: engine+steps is `accel_mode`/`turbo_lora`/
 * `pdd_nfe`, quality is `pass1_resolution`/`pass2_resolution`). Applies
 * `withExtenderOverride` field by field so a patch that happens to match the
 * baked value on ONE of its fields (e.g. picking "PDD 8-step" when the graph
 * is already baked to it) never leaves a spurious no-op override behind,
 * while the fields that actually changed still get stored.
 */
export function withExtenderOverrides(
  overrides: Record<string, unknown> | undefined,
  baked: Record<string, unknown> | null,
  patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
  let next = overrides
  for (const [field, value] of Object.entries(patch)) next = withExtenderOverride(next, baked, field, value)
  return next
}

// ── Control 1: engine + steps ────────────────────────────────────────────
//
// `accel_mode` ("PDD 8-step" / "Turbo LoRA") and the step count are not
// independent — read straight off the node's own Python on the box
// (`ComfyUI_MiniMax_H3_Master_Extender/pdd_pure_engine.py`, 2026-09-17):
//
//   - PDD 8-step: `nfe = self.pdd_nfe if self.pdd_nfe in ("4", "6", "8") else "8"`
//     (line ~211) — the engine itself CLAMPS any other value to 8 and logs a
//     warning. So PDD mode only ever actually runs at 4, 6 or 8, whatever the
//     raw `pdd_nfe` combo (`["8","4","6","5","10","12","16","20"]`) offers.
//   - Turbo LoRA: `steps = int(self.pdd_nfe)` (line 339) — sent to the
//     sampler AS-IS, no clamp, no cross-check against the turbo LoRA's own
//     step count. A turbo LoRA filename carries its own trained step count
//     (`..._turbo_4step_...`, `..._8step_...`); running a 4-step LoRA at
//     `pdd_nfe=8` (or vice versa) is a silent misconfiguration, not a refused
//     one — nothing in the node catches it.
//
// So this control keeps the two coherent by CONSTRUCTION: picking a turbo
// LoRA always derives `pdd_nfe` from its own filename (never taken as a
// separate input), and PDD mode only offers the three values the engine
// itself honours.

/** PDD mode's only real step counts (see the module comment) — the raw
 * `pdd_nfe` combo carries five more values the engine silently clamps away,
 * so those are never offered here. */
export const EXTENDER_PDD_STEPS = ['4', '6', '8'] as const
export type ExtenderPddSteps = (typeof EXTENDER_PDD_STEPS)[number]

export type ExtenderEngineChoice = { mode: 'pdd'; steps: ExtenderPddSteps } | { mode: 'turbo'; lora: string }

/** Pull a turbo LoRA's own trained step count out of its filename —
 * `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` -> `"4"`.
 * `null` when the filename does not encode one, so the caller can fall back
 * to the graph's own baked `pdd_nfe` rather than inventing a number. */
export function turboLoraStepCount(filename: string): string | null {
  const m = /(\d+)\s*-?step/i.exec(filename)
  return m ? m[1] : null
}

/**
 * Build the override patch for one engine+steps choice. Turbo mode NEVER
 * takes `steps` from the caller — it is always derived from `choice.lora`'s
 * own filename (falling back to `bakedPddNfe` only when that filename does
 * not encode a step count at all, e.g. an oddly-named file) — so a turbo
 * LoRA and `pdd_nfe` can never disagree: there is no code path that sets one
 * without the other.
 */
export function extenderEngineOverride(choice: ExtenderEngineChoice, bakedPddNfe: string): Record<string, unknown> {
  if (choice.mode === 'pdd') return { accel_mode: 'PDD 8-step', pdd_nfe: choice.steps }
  const steps = turboLoraStepCount(choice.lora) ?? bakedPddNfe
  return { accel_mode: 'Turbo LoRA', turbo_lora: choice.lora, pdd_nfe: steps }
}

/** Read the current engine+steps choice off the effective (baked + override)
 * inputs — what the panel seeds its control from. `null` only when there are
 * no inputs at all (the graph hasn't loaded). */
export function extenderEngineChoiceFromInputs(inputs: Record<string, unknown> | null): ExtenderEngineChoice | null {
  if (!inputs) return null
  if (inputs.accel_mode === 'Turbo LoRA') return { mode: 'turbo', lora: String(inputs.turbo_lora ?? 'none') }
  const nfe = String(inputs.pdd_nfe ?? '8')
  const steps = (EXTENDER_PDD_STEPS as readonly string[]).includes(nfe) ? (nfe as ExtenderPddSteps) : '8'
  return { mode: 'pdd', steps }
}

// ── Control 2: quality ───────────────────────────────────────────────────
//
// `pass1_resolution` moves WITH `pass2_resolution` (founder directive,
// 2026-09-17) — the node's own code does not encode a fixed ratio between
// them (`MinimaxH3LatentUpscaler3D` runs in its "target dimensions" mode,
// taking `pass2`'s exact pixel size with no arithmetic tying it to `pass1`;
// `parse_resolution` parses each field independently), so the pairing below
// is NOT derived from source. It is the founder's own measured production
// values (2026-09-17): 720p and 768p happen to sit close to a 2x upscale on
// both axes, 1080p does not (1056x608 -> 1920x1088 is not 2x — 1056*2 =
// 2112, not 1920). Do not "fix" the 1080p row to fit a 2x pattern the other
// two only approximate — this table is the ground truth, not an arithmetic
// rule that happens to reproduce two of its three rows.
export interface ExtenderQualityTier {
  id: '720p' | '768p' | '1080p'
  label: string
  pass1Resolution: string
  pass2Resolution: string
  pass2Width: number
  pass2Height: number
}

export const EXTENDER_QUALITY_TIERS: readonly ExtenderQualityTier[] = [
  { id: '720p', label: '720p', pass1Resolution: '608x352 (16:9)', pass2Resolution: '1280x720', pass2Width: 1280, pass2Height: 720 },
  { id: '768p', label: '768p', pass1Resolution: '704x384', pass2Resolution: '1344x768 (16:9)', pass2Width: 1344, pass2Height: 768 },
  { id: '1080p', label: '1080p', pass1Resolution: '1056x608 (16:9)', pass2Resolution: '1920x1088 (16:9)', pass2Width: 1920, pass2Height: 1088 },
] as const

export function extenderQualityOverride(tier: ExtenderQualityTier): Record<string, unknown> {
  return { pass1_resolution: tier.pass1Resolution, pass2_resolution: tier.pass2Resolution }
}

/** Match the effective inputs' `pass2_resolution` back to one of the three
 * tiers — `null` when it is something this control never wrote (a graph
 * update, or a value hand-edited before this panel existed). */
export function extenderQualityTierFromInputs(inputs: Record<string, unknown> | null): ExtenderQualityTier | null {
  if (!inputs) return null
  const p2 = String(inputs.pass2_resolution ?? '')
  return EXTENDER_QUALITY_TIERS.find((t) => t.pass2Resolution === p2) ?? null
}

// ── Live enumeration: the turbo LoRA list ────────────────────────────────
//
// Everything else on this page is small enough to hardcode from the node's
// own Python. The turbo LoRA list is not: it is whatever `.safetensors`
// files happen to sit in `models/loras` on the box right now, and this
// project has already been bitten once by a hardcoded LoRA filename pointing
// at a file that no longer existed. So this one enum is read from ComfyUI's
// own `/object_info/MiniMaxH3MasterExtender` at runtime — see
// `fetchExtenderNodeSchema` in `comfy.ts`, which fetches the JSON and hands
// it to the pure parser below.

export interface ExtenderNodeSchema {
  turboLoras: string[]
}

/** Pull the `turbo_lora` combo's option list out of a raw
 * `/object_info/MiniMaxH3MasterExtender` response. ComfyUI reports a combo
 * input as `[optionsArray, config]` under either `input.required` or
 * `input.optional` (this node declares `turbo_lora` under `optional`) — this
 * checks both rather than assuming which. Returns `null` for anything that
 * doesn't look like that shape (node not installed, malformed JSON, a
 * differently-shaped response) rather than throwing, the same tolerant
 * contract `parseExtenderPreviewInfo` already applies to a `/history` entry.
 */
export function parseExtenderNodeSchema(raw: unknown): ExtenderNodeSchema | null {
  if (!raw || typeof raw !== 'object') return null
  const node = (raw as Record<string, unknown>).MiniMaxH3MasterExtender as
    | { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
    | undefined
  if (!node?.input) return null
  const merged = { ...(node.input.required ?? {}), ...(node.input.optional ?? {}) }
  const spec = merged.turbo_lora
  if (!Array.isArray(spec) || !Array.isArray(spec[0])) return null
  return { turboLoras: (spec[0] as unknown[]).map(String) }
}
