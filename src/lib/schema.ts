import type { H3Mode } from './types'

/**
 * Schema-constrained output for the prompt-authoring stages.
 *
 * llama.cpp compiles a JSON Schema into a GBNF grammar and applies it as a
 * sampling mask, so a malformed reply is unreachable rather than merely
 * unlikely. That closes one measured defect class outright: asked for plain
 * text, this model wrapped its answer in an invented closing marker in 10 of
 * 10 runs — `<<<END_PROMPT>>>`, plus `<<<END>>>` and `<<<END PROMPT>>>` as
 * one-off spellings — which survives `splitReply()` and rides into the render
 * payload. It also never emitted `<<<EXPLANATION>>>`, so the two-block
 * contract was never satisfied. Under a schema both are impossible.
 *
 * Measured on 10 briefs x 20 blind pairwise judgements (2026-09-08,
 * qwen38-heretic-27b): prose quality is a wash against free text (12-7-1,
 * p=0.36, and the two judges agreed on only 5/10 briefs, so that split is
 * noise). The case for this rests on the structural defects, not on prose.
 *
 * Kept deliberately FLAT — six required strings. A decomposed variant with
 * per-shot objects and a camera enum takes exact-case controlled camera terms
 * from 0% to 95%, which is a large real win, but it also induced a new defect:
 * under the deeper grammar the model wrote structural tokens into free string
 * slots (`'},{'`, `'>=1'`) where a field had a format the grammar could not
 * express. That variant stays in `probe/json-schema` until it is fixed.
 */

/** ref2va — six sections, fixed order. */
export const REF_SECTIONS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const

/** T2VA / I2VA / FL2VA / L2VA — three core fields. */
export const BASE_SECTIONS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'] as const

export function sectionsFor(mode: H3Mode): readonly string[] {
  return mode === 'Ref2VA' ? REF_SECTIONS : BASE_SECTIONS
}

const DESCRIPTIONS: Record<string, string> = {
  subject_definitions:
    'One line per label. `<Subject N> is …` for a person, environment, garment, prop, style or action. A character, scene, costume or style plate is a Subject, never a Picture.',
  summary:
    'One paragraph opening with a bracketed task type from the fixed list — reference generation, keyframe completion, video continuation, video editing, audio reuse, audio reference — combined with " + ".',
  retention_analysis:
    'One line per label, each ending in a legal relationship marker: fully_preserved / partially_preserved / attribute_transfer / weak_reference for visible labels, fully_copy / partially_copy / reference / weak_reference for audio. Never a speaker id here.',
  detailed_description:
    'The body, in playback order. Style in one or two sentences BEFORE [Shot 1] — not a list of prohibitions. [Shot 1] carries no timestamp; later shots are "[Shot N] At MM:SS.mmm, …", strictly increasing. Camera motion uses the controlled vocabulary verbatim (Push In, Static Shot, Arc Shot …). Every spoken line carries a speaker id (S1)/(S2) before the verb AND the words inside <d>[Language] … </d>.',
  integrated_multimodal_description:
    'The body, in playback order, with style after the [Shot 1] marker. Shot, camera, speaker and dialogue formats as in the base guide.',
  overall_soundscape:
    'Ambience and physical sound only — no voice content, and nothing conveying words. A crowd as undifferentiated texture is fine; a crowd rendered as audible speech with no words supplied is not.',
  non_diegetic_music:
    'Audience-only score: instrumentation, tempo, dynamics. Exactly "N/A" when there is to be no music — never a sentence describing its absence, which is a score with "don\'t" in front of it.',
}

/**
 * The request's `response_format`, or null when this provider cannot take one.
 *
 * `explanation` rides in the same object so the Studio's prompt+explanation
 * contract survives without the `<<<PROMPT>>>` / `<<<EXPLANATION>>>` markers
 * the model kept mangling.
 */
export function h3ResponseFormat(mode: H3Mode): Record<string, unknown> {
  const fields = sectionsFor(mode)
  const properties: Record<string, unknown> = {}
  for (const f of fields) properties[f] = { type: 'string', description: DESCRIPTIONS[f] }
  properties.explanation = {
    type: 'string',
    description: 'Two or three sentences for the operator on what you decided and why. Never part of the prompt.',
  }
  return {
    type: 'json_schema',
    json_schema: {
      name: 'h3_prompt',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [...fields, 'explanation'],
        properties,
      },
    },
  }
}

/** Strip a fence, then take the first `{` to the last `}` — a model sometimes
 * wraps the object in a sentence despite the grammar. */
function parseLoose(raw: string): Record<string, unknown> | null {
  const s = raw.replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const v = JSON.parse(s.slice(a, b + 1)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Turn a schema-shaped reply into the canonical prompt plus its explanation.
 *
 * Returns null when the reply is not usable as one, so the caller can fall
 * back to the marker contract rather than replacing a good prompt with a
 * fragment. Every section must be present and non-empty: a partial object
 * must never become the canonical prompt.
 */
export function joinH3Sections(raw: string, mode: H3Mode): { prompt: string; explanation: string } | null {
  const obj = parseLoose(raw)
  if (!obj) return null
  const fields = sectionsFor(mode)
  const values = fields.map((f) => (typeof obj[f] === 'string' ? (obj[f] as string).trim() : ''))
  if (values.some((v) => !v)) return null
  const prompt = fields.map((f, i) => `${f}: ${values[i]}`).join('\n\n')
  const explanation = typeof obj.explanation === 'string' ? obj.explanation.trim() : ''
  return { prompt, explanation }
}
