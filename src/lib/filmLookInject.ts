import { describeFilmLookText } from './filmLook'
import type { FilmLook, H3Mode } from './types'

/**
 * Put the film's camera/lens/support look into the PROMPT ITSELF, mechanically.
 *
 * WHY THIS IS NOT A LINT. The look used to reach only the authoring model, as
 * an instruction inside `{{film}}` telling it to "write it into the prompt as
 * texture and feel" — so whether an ARRI Alexa 35 and a Cooke S4/i actually
 * arrived in `detailed_description` depended on the model complying, and
 * nothing checked. The founder's read (2026-09-18) was the right one: a line
 * we can simply write is not something to verify afterwards. Checking a thing
 * you could have guaranteed is strictly worse than guaranteeing it.
 *
 * CONSEQUENCE, AND IT IS THE WHOLE REASON THIS FILE TOUCHES `filmLook.ts` TOO:
 * the model must STOP writing the look, or a compliant one produces it twice —
 * and in a prompt, naming a thing twice weights it (the same mechanism behind
 * this codebase's `N/A` music sentinel: what a prompt names, it gets). So
 * `describeFilmLook` now tells the model the look is already stated and must
 * not be restated, while still SHOWING it — a locked-off-tripod film whose
 * model cannot see its own look writes `Push In` moves against it.
 *
 * WHERE IT IS APPLIED: at AUTHORING time, folded into the stored sections, not
 * at build time when `clips_json` is assembled. This app is approval-gated
 * throughout, so a line injected during the build would mean the prompt you
 * approved is not the prompt that rendered. Baked at authoring it is visible
 * on Approve prompts, editable by hand, and the guarantee is something you can
 * see rather than trust. It also matches the semantics "Story & shots" already
 * states: a clip already authored keeps the look it was written under until it
 * is redone.
 *
 * `prompt` is one of `EXTENDER_FREE_FIELDS`, so none of this can move the
 * Master Extender's 28-field signature or invalidate a validated clip.
 */

/** The body text the look contributes — the preset's own description plus any free
 * text, with no surrounding instruction block. `''` when no look is set, and
 * an unset look must leave a prompt byte-identical to what it was before this
 * feature existed. */
export function filmLookPromptText(look: FilmLook | undefined): string {
  return describeFilmLookText(look)
}

/**
 * Which section carries the style, and whether the style sits before or after
 * the `[Shot 1]` marker.
 *
 * THE TWO MODES DISAGREE, and the disagreement is in the schema's own field
 * descriptions rather than anywhere else, which is exactly how it would get
 * silently wrong:
 *
 *   detailed_description (Ref2VA)
 *     "Style in one or two sentences BEFORE [Shot 1]"
 *   integrated_multimodal_description (T2VA / I2VA / FL2VA / L2VA)
 *     "the body, in playback order, with style after the [Shot 1] marker"
 *
 * Same sentence, two positions.
 */
export function styleTargetFor(mode: H3Mode): { field: string; placement: 'before-marker' | 'after-marker' } {
  return mode === 'Ref2VA'
    ? { field: 'detailed_description', placement: 'before-marker' }
    : { field: 'integrated_multimodal_description', placement: 'after-marker' }
}

/** The marker both modes position the style against. Matched tolerantly on
 * inner spacing (`[Shot 1]`, `[Shot  1]`) because it is written by a model,
 * but never case-insensitively past the leading letter — the controlled
 * vocabulary is `[Shot N]` and a prompt spelling it otherwise has a different
 * problem than this function can fix. */
const SHOT_ONE_MARKER = /\[Shot\s+1\]/

/**
 * Fold the look into the sections. Pure, and safe to call twice.
 *
 * Idempotent by containment: a section that already carries this exact look
 * text is returned untouched, so re-authoring, a hand edit followed by a
 * re-inject, or a double call never stacks the paragraph up.
 *
 * A section with NO `[Shot 1]` marker still gets the look, prepended. The
 * alternative — dropping it because the anchor is missing — silently loses the
 * operator's own film-wide decision on exactly the malformed prompts that need
 * the most help, and a style paragraph in the wrong place is a far smaller
 * defect than no camera at all.
 */
export function injectFilmLook(
  sections: Record<string, string>,
  mode: H3Mode,
  look: FilmLook | undefined,
): Record<string, string> {
  const text = filmLookPromptText(look)
  if (!text) return sections

  const { field, placement } = styleTargetFor(mode)
  const body = sections[field] ?? ''
  if (body.includes(text)) return sections

  if (!body.trim()) return { ...sections, [field]: text }

  const marker = SHOT_ONE_MARKER.exec(body)
  if (placement === 'after-marker' && marker) {
    const at = marker.index + marker[0].length
    return { ...sections, [field]: `${body.slice(0, at)} ${text}${body.slice(at)}` }
  }
  return { ...sections, [field]: `${text}\n\n${body}` }
}
