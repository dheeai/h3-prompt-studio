import type { FilmLook } from './types'

/**
 * Preset vocabulary for the film-wide look selector (2026-09-17 brief,
 * corrected same day). The first pass built four presets around abstract
 * grammar — aspect ratio, palette, grain — and the founder called that a
 * misreading: "I meant providing a list of modern cinema recording cameras.
 * If we add that in the prompt it generally improves how the movie is shot.
 * Not just about 16:9 etc." He is right about the mechanism: a generative
 * video model has strong learned associations with named hardware — "ARRI
 * Alexa 35 with Cooke S4 primes" pulls a whole coherent look (skin
 * rendering, highlight roll-off, bokeh character) that an abstract
 * description does not. The camera/lens NAME is the lever.
 *
 * A second correction, same day, gave the exact sentence shape to produce —
 * his own worked example: "The target video is live-action and cinematic,
 * shot on an ARRI Alexa with a Cooke Varotal 18-100mm zoom lens, locked off
 * on a tripod." Three things every preset's `description` must do because of
 * that example:
 *   1. Open on ONE flowing sentence, not a labelled block — prose the model
 *      can act on, not a spec sheet.
 *   2. Name SPECIFIC glass — an actual lens (and, for a prime set, a
 *      representative focal length), never a bare family name.
 *   3. Name a camera SUPPORT (tripod, handheld, dolly, Steadicam, crane,
 *      shoulder-mounted) — this is the film's DEFAULT camera behaviour, not
 *      a hard constraint. Per-shot camera movement is still decided during
 *      expansion (`h3-cinematography`'s movement governor); a shot that
 *      genuinely needs to move or hold still still may. The wording says so
 *      every time, so this default never fights that per-shot decision.
 *
 * ONE dropdown of named COMBINATIONS, not independent axes — a focal length,
 * a grain gauge and a palette are not independent choices, and a multi-axis
 * form invites picking ones that do not describe any real camera package.
 * Each preset below pairs the hardware sentence with the SAME six-element
 * look grammar the first pass used (aspect + film feel + grain gauge +
 * sharpening suppression + plastic-texture ban + a four-colour palette) plus
 * a default optics register, using `h3-cinematography`'s own worked
 * vocabulary (`~/.claude/skills/h3-cinematography/SKILL.md`) — that grammar
 * is measured to work on this model, so the hardware name is additive to
 * it, not a replacement for it. Only ONE preset reuses the skill's own
 * worked palette example verbatim (warm brown / soft gold / matte cream /
 * low-saturation vintage black); the others apply the same taught grammar
 * (name four colours, say "restrained", pick a grain gauge deliberately) to
 * a different mood and a different package.
 *
 * The spread covers six genuinely different registers a DP would recognise,
 * not four variations of prestige drama: large-format digital, Super 35
 * digital (the founder's own worked example of the mechanism), anamorphic,
 * documentary/run-and-gun, vintage character glass, and photochemical film.
 * Every body+glass pairing is real and plausible — a body that exists, glass
 * that mounts to it and is actually used with it.
 *
 * A named list cannot cover everything H3 responds to, so the UI pairs this
 * with a free-text field (`FilmLook.freeText`) rather than trying to
 * enumerate every possible combination here.
 *
 * UNMEASURED, and this module cannot make it otherwise: whether naming this
 * hardware, this glass or this support produces a genuine optical/motion
 * change in the render, or is only a stylistic nudge H3 happens to obey the
 * way it obeys grain/palette vocabulary. `bestFor` is a suggestion about the
 * LOOK a preset produces, never a claim that H3 renders true optical
 * accuracy or a true field of view — `describeFilmLook` states every choice
 * as a look, and the UI copy must not claim more than that either.
 */
export interface FilmLookPreset {
  id: string
  /** The dropdown's own label — the camera + glass, and its support. */
  name: string
  /** What kind of film this suits — a suggestion, not a rule. */
  bestFor: string
  /** What this preset actually writes into the FILM-WIDE LOOK block below,
   * verbatim: one opening hardware sentence (body + specific glass +
   * support, read as the film's default), then the six-element look
   * grammar. */
  description: string
}

export const FILM_LOOK_PRESETS: FilmLookPreset[] = [
  {
    id: 'large-format-alexa65-sphero65',
    name: 'ARRI Alexa 65 with Panavision Sphero 65 primes — on a crane',
    bestFor: 'an epic, large-canvas story where scale carries the frame — landscape, spectacle, a world dwarfing the people in it',
    description:
      'The target video is live-action and cinematic, shot on an ARRI Alexa 65 with a Panavision Sphero 65 40mm prime lens, on a crane. ' +
      "That crane move is this film's default camera behaviour, not a rule — a shot that genuinely needs to hold still or push in still may. " +
      '2.39:1 widescreen composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Fine large-format digital grain, closer to a scanned digital negative than heavy analog texture, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette restrained and sun-worn: sun-bleached ochre, dusty sage green, overcast sky-blue, worn low-saturation white. ' +
      'Default optics register: 40mm wide establishing width opening scenes, tightening to 75mm for chest-up coverage, the large-format sensor keeping shallow depth of field even at wider focal lengths.',
  },
  {
    id: 'super35-alexa35-cooke-s4i',
    name: 'ARRI Alexa 35 with Cooke S4/i primes — locked off on a tripod',
    bestFor: 'a high-end contemporary drama where skin rendering and a restrained warm grade carry the mood',
    description:
      'The target video is live-action and cinematic, shot on an ARRI Alexa 35 with a Cooke S4/i 75mm prime lens, locked off on a tripod. ' +
      "That locked-off tripod is this film's default camera behaviour, not a rule — a shot that genuinely needs to move still may. " +
      '2.39:1 widescreen composition, 24fps, authentic film viewing feel, realistic cinematography. ' +
      'Subtle fine 35mm vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette restrained and high-end: warm brown, soft gold, matte cream, low-saturation vintage black. ' +
      'Default optics register: 85mm portrait framing, chest-up, tightening toward 100mm for the closest moments.',
  },
  {
    id: 'anamorphic-alexaminilf-panavision-c',
    name: 'ARRI Alexa Mini LF with Panavision C-Series anamorphic — on a Steadicam',
    bestFor: 'a widescreen, flare-heavy look for a story with scale and romance in it — city nights, chases, sweeping establishing shots',
    description:
      'The target video is live-action and cinematic, shot on an ARRI Alexa Mini LF with a Panavision C-Series 50mm anamorphic prime lens, on a Steadicam. ' +
      "That Steadicam float is this film's default camera behaviour, not a rule — a shot that genuinely needs to lock off still may. " +
      '2.39:1 anamorphic widescreen composition, 24fps, authentic film viewing feel, realistic cinematography, oval bokeh and horizontal lens flare. ' +
      'Subtle fine 35mm film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette restrained and nocturnal: midnight blue, amber sodium-vapor gold, deep charcoal, muted cool teal. ' +
      'Default optics register: 50mm anamorphic opening a scene wide, tightening to 75mm anamorphic for closer coverage, oval bokeh held throughout.',
  },
  {
    id: 'documentary-fx6-cabrio',
    name: 'Sony FX6 with a Fujinon Cabrio zoom — handheld',
    bestFor: 'an observational, run-and-gun scene that needs to feel caught rather than composed — verité, handheld coverage',
    description:
      'The target video is live-action and cinematic, shot on a Sony FX6 with a Fujinon Cabrio 19-90mm T2.9 zoom lens, handheld. ' +
      "That handheld camera is this film's default camera behaviour, not a rule — a shot that genuinely needs to lock off still may. " +
      '16:9 composition, 24fps, observational documentary immediacy rather than a locked cinema rig. ' +
      'Light natural video-sensor grain, no heavy film-stock texture layered on top, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette neutral and true-to-life, minimal grade: warm skin ochre, daylight white, muted green, soft grey. ' +
      "Default optics register: the zoom favouring its wide end for coverage, pushing in to a tighter 90mm-equivalent framing for a candid insert.",
  },
  {
    id: 'vintage-alexamini-k35',
    name: 'ARRI Alexa Mini with rehoused Canon K35 primes — shoulder-mounted',
    bestFor: 'a story that wants warmth and imperfection in the image itself — nostalgia, a period feel, a character-driven indie',
    description:
      'The target video is live-action and cinematic, shot on an ARRI Alexa Mini with a rehoused Canon K35 35mm prime lens, shoulder-mounted. ' +
      "That shoulder-mounted camera is this film's default camera behaviour, not a rule — a shot that genuinely needs to be still still may. " +
      '2:1 widescreen composition, 24fps, authentic film viewing feel, realistic cinematography, warm low-contrast character with gentle swirly bokeh at the edges of frame. ' +
      'Subtle fine vintage film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette warm and faded: faded amber, dusty rose, warm ivory, soft brown-black. ' +
      'Default optics register: 35mm and 50mm K35 primes favoured, chest-up to waist-up framing, character bokeh softening the edges of every frame.',
  },
  {
    id: 'photochemical-arricam-masterprime',
    name: 'Arricam ST/LT with Zeiss Master Primes on Kodak Vision3 — on a dolly',
    bestFor: 'a classic, painterly film look where grain and halation are part of the mood — a period piece or a director-driven prestige drama',
    description:
      'The target video is live-action and cinematic, shot on an Arricam ST/LT with a Zeiss Master Prime 75mm lens on 35mm Kodak Vision3 film stock, on a dolly. ' +
      "That dolly move is this film's default camera behaviour, not a rule — a shot that genuinely needs to lock off or go handheld still may. " +
      '1.66:1 composition, 24fps, true photochemical film feel — halation and soft chemical crispness rather than a digital-sensor look. ' +
      'Fine 35mm photochemical film grain, reduced digital sharpening, no influencer plastic texture. ' +
      'Overall palette classic and warm: Kodak-warm amber, muted teal shadow, cream highlight, deep film black. ' +
      'Default optics register: 50mm and 75mm Master Primes favoured, chest-up framing tightening to 100mm for the closest moments.',
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
/**
 * The look as PROMPT BODY — the text that is written into the prompt itself,
 * with no instruction wrapped around it. Split out of `describeFilmLook` so
 * the paragraph the model is shown and the paragraph that is actually injected
 * (`injectFilmLook`, `filmLookInject.ts`) can never drift into two different
 * strings; one of them would then be the lie.
 */
export function describeFilmLookText(look: FilmLook | undefined): string {
  if (!look || !isFilmLookSet(look)) return ''
  const parts: string[] = []
  if (look.preset?.trim()) {
    const preset = filmLookPreset(look.preset)
    parts.push(preset ? preset.description : look.preset.trim())
  }
  if (look.freeText?.trim()) parts.push(look.freeText.trim())
  return parts.join(' ')
}

/**
 * The look as it is shown TO THE AUTHORING MODEL.
 *
 * It no longer asks the model to write the look. `injectFilmLook` puts that
 * paragraph into the prompt mechanically, so a model that also wrote it would
 * produce it twice — and a prompt that names a thing twice weights it, the
 * same mechanism behind this codebase's `N/A` music sentinel.
 *
 * The look is still SHOWN, and that is not redundant: a film whose look is
 * "locked off on a tripod" needs its director to know that before choosing
 * camera behaviour, or it writes `Push In` moves against its own film. Seeing
 * the look governs the direction; writing it is now someone else's job.
 */
export function describeFilmLook(look: FilmLook | undefined): string {
  const text = describeFilmLookText(look)
  if (!text) return ''
  return `FILM-WIDE LOOK — chosen once for the whole film, and applies to this clip too.

THIS PARAGRAPH IS ALREADY IN THE PROMPT, written there for you. Do NOT restate
it, paraphrase it, or write your own version of it — it would then appear
twice, and a prompt that says a thing twice weights it. Direct CONSISTENTLY
with it instead: it is what the film is shot on, so let it govern the camera
behaviour, the framing and the texture you choose.

It is a described look, not a measured optical guarantee — never treat it as a
promise that the lens, glass or camera support physically changed.

${text}
`
}
