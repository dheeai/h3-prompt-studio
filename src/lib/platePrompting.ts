/**
 * Author one MISSING ledger entity's reference-plate image prompt, for
 * Qwen Image 2.1 text-to-image — "generate missing" half of the founder's
 * "paste a chapter -> arbitrary-length video, with plates he may pre-
 * provide and the rest generated" ask.
 *
 * ONE model call per plate: SYSTEM = Qwen Image 2.1's own official
 * prompt-rewrite instructions, verbatim
 * (`qwenRewriteSystemPromptT2i.ts`/`qwenRewriteSystemPromptEdit.ts`, per
 * `~/.claude/skills/qwen-image-prompt-rewrite`) — USER = our own plate
 * brief below, the FIXED content that rewrite step must carry through
 * unchanged (per that system prompt's own Step 1: "what the user has
 * fixed... must survive into your description unchanged"). The templates'
 * LIRA-discipline content and the 6-panel contact-sheet / identity-sheet /
 * product-plate structure are ported (adapted from a shared multi-entity
 * document to one entity at a time) from
 * `~/.kshana/bundles/h3_chapter/prompts/{location,character,prop}_plate_prompt.md`
 * (commit `baaee62`) — READ ONLY, another agent owns that repo.
 *
 * TWO OVERRIDES this Studio applies on top of the official rewrite prompt's
 * own contract (both system-prompt files' own module comments repeat this):
 *   1. Aspect ratio is FIXED BY US per entity kind (`PLATE_SIZES`), never
 *      the rewrite's own `wh_ratio` step — `parsePlatePromptRewrite` reads
 *      `rewritten_prompt` only and discards `wh_ratio`/`ratio_follow`
 *      entirely.
 *   2. The model is asked for prose only as far as this Studio uses it —
 *      the JSON envelope is parsed then thrown away except that one field.
 *
 * Vocabulary discipline: the brief instructs the model not to describe the
 * PLATE AS AN ARTIFACT (no "contact sheet", "panel", "reference sheet" in
 * its own prose) — the founder's rule that a plate's subject-definition
 * description (once analysed, `analyzeSubjectImage`) must describe WHAT IS
 * IN THE PICTURE, never the picture as a photography/format artifact. This
 * rule does not exist anywhere in the bundle's own prompts (confirmed by a
 * full grep of `h3_chapter` — prompts, schemas, both validators) — it is
 * NET NEW here, stated once in each brief and again as the defensive
 * `stripPlateFormatVocabulary` strip (`chapterBreakdown.ts`) wherever a
 * plate's description reaches a REFERENCES line.
 */

export type PlateEntityKind = 'character' | 'location' | 'prop'

/** `LedgerEntity.kind` has FOUR values (`character`/`prop`/`creature`/
 * `environment`, per `chapterBreakdown.ts`'s state-ledger design) but the
 * plate briefs below only have THREE shapes (an identity sheet, a product
 * plate, a location contact sheet) — there is no separate "creature" or
 * "environment" template. A creature gets the identity-sheet treatment
 * (the ledger's own module comment: "a creature gets the same axes as a
 * person"); an environment IS the location it belongs to (the ledger
 * tracks environment STATE, e.g. a lamp lit or not, as its own entity, but
 * the PLATE is the room itself). */
export function platePromptKindForLedgerKind(kind: 'character' | 'prop' | 'creature' | 'environment'): PlateEntityKind {
  if (kind === 'prop') return 'prop'
  if (kind === 'environment') return 'location'
  return 'character'
}

export interface PlateSize {
  width: number
  height: number
}

/** Per the founder's brief: location 1408x1408 (2048x2048 optional, not
 * wired as a toggle here — see the module comment on scope), character
 * 1024x1536, prop 1216x1216. Matches
 * `~/.kshana/bundles/h3_chapter/bundle.json`'s own hardcoded
 * `additionalArgs` per plate-image node exactly (that bundle's
 * `location_sheet_size` project input is itself unwired to its runner —
 * confirmed live, not worth reproducing the same dead toggle here). */
export const PLATE_SIZES: Record<PlateEntityKind, PlateSize> = {
  location: { width: 1408, height: 1408 },
  character: { width: 1024, height: 1536 },
  prop: { width: 1216, height: 1216 },
}

/** The optional larger location size the bundle's own (unwired) toggle
 * offers — exposed here as a plain alternative a caller can opt into,
 * never a default. */
export const LOCATION_PLATE_SIZE_LARGE: PlateSize = { width: 2048, height: 2048 }

const NO_ARTIFACT_LANGUAGE = `Do not describe this image as a "contact sheet", "panel", "grid", "reference sheet", "identity sheet", "plate", or any other photography/format artifact term — describe only what is actually in the frame: the room, the person, or the object itself, as if you were simply looking at it.`

export interface PlateBriefInput {
  /** This entity's own name — `LedgerEntity.name` / a founder-typed plate name. */
  name: string
  /** This entity's own description — the breakdown/ledger's account of
   * what it looks like, NEVER its narrative arc (see `chapterBreakdown.ts`'s
   * `ReferencePlateInfo` module comment for why arc language is banned
   * from a plate-facing description too). */
  description: string
  /** The whole chapter, for grounding only — set dressing/wardrobe/build
   * the description doesn't already imply must not be invented from it. */
  chapter: string
}

/** `location_plate_prompt.md`, adapted to one entity at a time (the bundle's
 * own template scans a shared `reference_plan.missingLocations[]` document
 * for "the ONE entry whose id equals..."; the Studio already knows which
 * entity it is calling for, so that indirection is dropped). The 6-panel
 * locked-camera structure and LIRA discipline are otherwise unchanged. */
export function fillLocationPlateBrief(input: PlateBriefInput): string {
  return `Author ONE contact-sheet reference-plate image for this location, for a text-to-image model. A single sheet is the ONLY reference generated per location, used as ONE reference image in a later video-generation step — the whole sheet is bound as one picture, never cropped into separate panels afterward. Name nothing you don't want in every future clip at this location; whatever this sheet shows is what the room IS, permanently.

THIS LOCATION:
Name: ${input.name}
Description: ${input.description}

Full chapter text, for scene grounding only — do not invent set dressing this text never implies:
${input.chapter}

================================================================
LIRA discipline
================================================================

Write concise natural prose, not a keyword stack. Specify observable materials, lighting direction/quality, and a source-derived palette. Compose the image as a 3-row x 2-column grid of six panels separated by thin clean white gutters, no text, no captions, no labels — all six panels showing the EXACT SAME room from different locked camera stations so asset positions match perfectly across every panel:

Panel 1 (top-left): eye-level establishing view from the doorway.
Panel 2 (top-right): eye-level from the opposite corner.
Panel 3 (middle-left): eye-level facing the far wall.
Panel 4 (middle-right): eye-level facing the remaining wall.
Panel 5 (bottom-left): tight close-up of ONE key surface in the room (whatever this location's description names as its most story-relevant detail).
Panel 6 (bottom-right): an overhead cutaway view of the whole room with two walls removed, on a plain white background.

Every panel shares one consistent lighting scheme, palette and grain — state it once, as the global style, and never let a single panel drift from it.

${NO_ARTIFACT_LANGUAGE}`
}

/** `character_plate_prompt.md`, adapted to one entity at a time — same
 * simplification as the location brief above. */
export function fillCharacterPlateBrief(input: PlateBriefInput): string {
  return `Author an identity-sheet image for this character, for a text-to-image model. This image is what a later video-generation step will hold identity from for every clip this character appears in — it is generated once and must LOCK the character; nothing in any later clip's prose should contradict it.

THIS CHARACTER:
Name: ${input.name}
Description: ${input.description}

Full chapter text, for grounding only — do not invent traits the description does not imply:
${input.chapter}

================================================================
LIRA discipline
================================================================

Write concise natural prose, not a keyword stack — state what is attached to what (whose hair, on which garment, under which light). Specify observable materials, lighting, framing. Forbid accidental text, labels, extra subjects, and invented identity details beyond what the description actually gives you.

A clean, full-body, front-facing studio image: neutral pose, neutral expression, plain neutral background, even lighting, wardrobe exactly as described. No props, no set dressing, no second person in frame. This is a REFERENCE image, not a scene.

${NO_ARTIFACT_LANGUAGE}`
}

/** `prop_plate_prompt.md`, adapted to one entity at a time. */
export function fillPropPlateBrief(input: PlateBriefInput): string {
  return `Author a reference-plate image for this recurring prop, for a text-to-image model. This image is what a later video-generation step will hold this object's identity from in every clip that cites it — it is generated once.

THIS PROP:
Name: ${input.name}
Description: ${input.description}

Full chapter text, for context only:
${input.chapter}

================================================================
LIRA discipline
================================================================

Write concise natural prose, not a keyword stack. Specify observable materials, surface, scale (relative to a hand or a common object), lighting, and a source-derived palette from the prop's own description. Forbid accidental text/labels unless the description explicitly calls for legible markings.

A clean product-style image: the object alone, centered, plain neutral background, even studio lighting, no hand or person holding it, no set dressing.

${NO_ARTIFACT_LANGUAGE}`
}

export function fillPlateBrief(kind: PlateEntityKind, input: PlateBriefInput): string {
  if (kind === 'location') return fillLocationPlateBrief(input)
  if (kind === 'character') return fillCharacterPlateBrief(input)
  return fillPropPlateBrief(input)
}

/**
 * Extract only `rewritten_prompt` from Qwen's own rewrite-prompt JSON
 * reply — `wh_ratio`/`ratio_follow` are read then discarded per this
 * module's own override #1 (aspect ratio is fixed by us, per entity kind).
 * Tolerant of a code fence or surrounding prose; `null` on anything that
 * doesn't parse or carries no usable string, never a placeholder.
 */
export function parsePlatePromptRewrite(raw: string): string | null {
  const s = raw.replace(/```(?:json)?/gi, '').trim()
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const obj = JSON.parse(s.slice(a, b + 1)) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null
    const rewritten = (obj as Record<string, unknown>).rewritten_prompt
    return typeof rewritten === 'string' && rewritten.trim() ? rewritten.trim() : null
  } catch {
    return null
  }
}
