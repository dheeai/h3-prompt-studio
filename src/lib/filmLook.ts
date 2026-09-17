import type { FilmLook } from './types'

/**
 * Preset vocabulary for the film-wide look selector (2026-09-17 brief: "a
 * camera, focal, lens etc." chosen once at the start of the film; refined
 * same day, founder: "a dropdown with a set of camera lens combinations —
 * maybe even a suggestion on which one works best for what kind of film").
 *
 * ONE dropdown of named COMBINATIONS, not independent axes. A focal length,
 * a grain gauge and a palette are not independent choices — 85mm with heavy
 * 16mm grain and a clean-digital grade is a combination that does not
 * describe any real camera package, and a multi-axis form invites exactly
 * that. Each preset below bundles aspect + film feel + grain gauge +
 * sharpening suppression + plastic-texture ban + a four-colour palette +
 * a default optics register into ONE coherent look, using the
 * `h3-cinematography` skill's own six-element look grammar and worked
 * vocabulary (`~/.claude/skills/h3-cinematography/SKILL.md`) rather than
 * invented terms — only the skill's ONE worked palette example (warm
 * restrained: brown/gold/cream/black) is reused verbatim; the others apply
 * the same taught grammar (name four colours, say "restrained", pick a
 * grain gauge deliberately) to a different mood, which is the pattern the
 * skill teaches rather than a single fixed instance of it.
 *
 * A named list cannot cover everything H3 responds to (the skill's own
 * point about lens/stock/grain vocabulary), so the UI pairs this with a
 * free-text field (`FilmLook.freeText`) rather than trying to enumerate
 * every possible combination here.
 *
 * UNMEASURED, and this module cannot make it otherwise: whether a preset's
 * stated focal length produces a genuine field-of-view change in the
 * render, or is only a stylistic nudge H3 happens to obey the way it obeys
 * grain/palette vocabulary. `bestFor` is a suggestion about the LOOK a
 * preset produces, never a claim that H3 renders a true optical
 * equivalent — `describeFilmLook` states every choice as a look, and the UI
 * copy must not claim more than that either.
 */
export interface FilmLookPreset {
  id: string
  /** The dropdown's own label — a short, named, complete combination. */
  name: string
  /** What kind of film this suits — a suggestion, not a rule. */
  bestFor: string
  /** What this preset actually writes into the FILM-WIDE LOOK block below,
   * verbatim, in the skill's six-element grammar. */
  description: string
}

export const FILM_LOOK_PRESETS: FilmLookPreset[] = [
  {
    id: 'widescreen-warm-restrained',
    name: '2.39:1 widescreen, warm restrained palette',
    bestFor: 'a high-end, widescreen drama where the palette and grain carry the mood',
    description:
      '2.39:1 widescreen composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Subtle fine 35mm vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette restrained and high-end: warm brown, soft gold, matte cream, low-saturation vintage black. ' +
      'Default optics register: 85mm portrait framing, chest-up, tightening toward 100mm for the closest moments.',
  },
  {
    id: '16x9-neutral-naturalistic',
    name: '16:9, neutral naturalistic',
    bestFor: 'a naturalistic scene where the performance has to carry it, not the grade',
    description:
      '16:9 composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Subtle fine 35mm vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette neutral and true-to-life, minimal grade. ' +
      'Default optics register: 70mm wide-medium opening out to 85mm chest-up.',
  },
  {
    id: 'widescreen-cool-desaturated',
    name: '20:9 widescreen, cool desaturated palette',
    bestFor: 'distance and tension between people, a colder relationship',
    description:
      'Widescreen 20:9 composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Subtle fine 35mm vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette restrained and desaturated: steel blue, slate, charcoal, muted low-saturation white. ' +
      'Default optics register: 85mm chest-up, held through most of the clip.',
  },
  {
    id: 'high-contrast-one-accent',
    name: '2.39:1, high-contrast with one warm accent',
    bestFor: 'a scene built around one small warm detail against a cold world',
    description:
      '2.39:1 widescreen composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Subtle fine 35mm vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'High-contrast palette: deep black, cold white, one restrained warm accent colour. ' +
      'Default optics register: 100mm facial close-up favoured.',
  },
]

export function filmLookPreset(id: string | undefined): FilmLookPreset | undefined {
  return id ? FILM_LOOK_PRESETS.find((p) => p.id === id) : undefined
}

/** Is anything actually set — a preset choice or the free text? An
 * all-empty `FilmLook` (or none at all) must behave exactly like no look
 * was ever added, so `describeFilmLook` returns '' and the prompt an
 * operator gets who never opens the selector is unchanged. */
export function isFilmLookSet(look: FilmLook | undefined): boolean {
  if (!look) return false
  return !!(look.preset?.trim() || look.freeText?.trim())
}

/**
 * The block `filmBlock` (`stages.ts`) folds into every clip's `{{film}}`
 * placeholder — see that function's own comment for where it is spliced in.
 * A recognised preset writes its full description; an unrecognised id (a
 * stored value from a preset list that has since changed) still writes the
 * raw id rather than silently vanishing. Free text always appends alongside
 * a preset, never replacing it.
 */
export function describeFilmLook(look: FilmLook | undefined): string {
  if (!look || !isFilmLookSet(look)) return ''
  const lines: string[] = []
  if (look.preset?.trim()) {
    const preset = filmLookPreset(look.preset)
    lines.push(preset ? `- ${preset.name}: ${preset.description}` : `- ${look.preset.trim()}`)
  }
  if (look.freeText?.trim()) lines.push(`- ${look.freeText.trim()}`)
  return `FILM-WIDE LOOK — chosen once for the whole film, and applies to this clip too.
This is a described look, not a measured optical guarantee: write it into the
prompt as texture and feel, the same way the rest of this look reads, never
as a promise that the lens or stock physically changed.
${lines.join('\n')}
`
}
