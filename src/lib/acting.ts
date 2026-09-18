/**
 * ACTING — one clip: a few fields of performance, as INPUT to the prompt
 * writer.
 *
 * DELIBERATELY THIN, AND DELIBERATELY UNVERIFIED. Founder, 2026-09-18:
 * "acting is not too important - so we should not cross verify whatever it
 * says.. we need to fill a few fields as its an input to the final prompt
 * writer. Direction is important." So: no `critique` coverage, no lint
 * findings, no schema round-trip check on its content, and nothing downstream
 * refuses a render because a field here is weak. If it is wrong it is wrong.
 * It exists so the writer has something concrete to work from instead of
 * inventing a performance from the action line alone.
 *
 * That instruction is also why this file is one flat object per character
 * rather than h3_film_slm's eleven-field-per-character-per-shot schema. That
 * one is the better document and it is not in dispute — but it measured 67.1s
 * per call, one call per SHOT, described in its own schema as "the most
 * expensive node in the pipeline", and at ~45 shots for a five-minute film it
 * would cost more time than the film takes to render. Four fields per
 * character per CLIP is what fits.
 *
 * FIELD CHOICE is taken from film_slm's own recorded findings rather than
 * invented:
 *   - `objective` must be A VERB AIMED AT THE PARTNER, never a state. Its
 *     schema is explicit: "'shame him into stepping back'... Not 'she is
 *     afraid'". A state gives a generative model nothing to play.
 *   - `tactic` is HOW the objective is pursued, and changes when one fails.
 *   - `physicalBehaviour` is the one surviving prose field: v0.8.0 of that
 *     schema COLLAPSED five fields (`howItIsShownPhysically`,
 *     `observableBehavior`, `physicalBusiness`, `bodyState`, `beatChange`)
 *     into this one, because "nothing reconciled five independent accounts of
 *     one pair of hands" and it was "the likeliest cause of the character
 *     described with three hands". Do not split it back apart.
 *   - `eyeLife` is kept SEPARATE from `physicalBehaviour` on purpose, quoting
 *     that schema: "dead eyes are the specific failure mode it exists to
 *     prevent, and it earns its own attention."
 */

export interface Performance {
  characterId: string
  /** A verb aimed at the partner, never a state. */
  objective: string
  /** How the objective is pursued here — press, charm, shame, plead, stall, bargain. */
  tactic: string
  /** How the viewer SEES it: one reconciled account of one body. */
  physicalBehaviour: string
  /** Kept apart from the above deliberately — dead eyes are the failure mode. */
  eyeLife: string
}

export interface ActingDoc {
  clipIndex: number
  performances: Performance[]
}

export const ACTING_TEMPLATE = `Write the PERFORMANCE for one clip. Four fields per character, nothing else.

The camera, the framing and the blocking are already decided and are shown to
you below only so you know what frame the actor is in. You may not restate
them, re-choose them, or describe the camera at all. You answer the thing a
director is not concerned with: what the actor adds inside the frame they were
given.

objective — A VERB AIMED AT THE OTHER PERSON. "shame him into stepping back",
"get her to hand over the satchel". NEVER a state: "she is afraid" and "he
wants to be loved" are not objectives and give a performance nothing to play.

tactic — HOW they pursue it here: press, charm, shame, plead, stall, bargain.

physicalBehaviour — how the viewer SEES it, in ONE account of ONE body.
Concrete and observable: what the hands do, what the weight does, what the
face does. Do not give several independent descriptions of the same person in
the same second; write the one.

eyeLife — what the eyes are doing, on its own. Not a mood word. Where they go,
what they hold, what they avoid, when they drop.

{{film}}

THE CLIP
{{covers}}

{{direction}}

{{plates}}`

export function fillActingTemplate(
  template: string,
  parts: { covers: string; direction: string; film: string; plates: string },
): string {
  return template
    .replace(/\{\{covers\}\}/g, parts.covers)
    .replace(/\{\{direction\}\}/g, parts.direction)
    .replace(/\{\{film\}\}/g, parts.film)
    .replace(/\{\{plates\}\}/g, parts.plates)
    .trim()
}

export function actingResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'acting',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['performances'],
        properties: {
          performances: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['characterId', 'objective', 'tactic', 'physicalBehaviour', 'eyeLife'],
              properties: {
                characterId: { type: 'string', description: 'Who this is, by the name the clip already uses.' },
                objective: { type: 'string', description: 'A verb aimed at the partner. Never a state.' },
                tactic: { type: 'string', description: 'How they pursue it in THIS clip.' },
                physicalBehaviour: { type: 'string', description: 'One reconciled, observable account of one body.' },
                eyeLife: { type: 'string', description: 'What the eyes do. Not a mood word.' },
              },
            },
          },
        },
      },
    },
  }
}

function stripFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

/**
 * Parse an acting document. Tolerant to the point of permissiveness, on
 * purpose: an acting doc is never gated on, so a partially-filled reply is
 * strictly better than none, and a missing field reads as empty rather than
 * failing the clip. Returns null ONLY when there is no usable array at all.
 */
export function parseActing(raw: string, clipIndex: number): ActingDoc | null {
  const text = stripFence(raw.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  const o = (obj ?? {}) as Record<string, unknown>
  if (!Array.isArray(o.performances) || !o.performances.length) return null
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return {
    clipIndex,
    performances: o.performances.map((item, i) => {
      const c = (item ?? {}) as Record<string, unknown>
      return {
        characterId: str(c.characterId) || `Character ${i + 1}`,
        objective: str(c.objective),
        tactic: str(c.tactic),
        physicalBehaviour: str(c.physicalBehaviour),
        eyeLife: str(c.eyeLife),
      }
    }),
  }
}

/** The acting document as the block the prompt writer is given. Empty
 * performances are dropped rather than passed on as blank labels — a heading
 * with nothing under it reads to a model as something to invent. */
export function actingToPromptBlock(doc: ActingDoc | undefined): string {
  if (!doc) return ''
  const lines = doc.performances
    .map((p) => {
      const parts = [
        p.objective && `wants: ${p.objective}`,
        p.tactic && `by: ${p.tactic}`,
        p.physicalBehaviour && `seen as: ${p.physicalBehaviour}`,
        p.eyeLife && `eyes: ${p.eyeLife}`,
      ].filter(Boolean)
      return parts.length ? `- ${p.characterId} — ${parts.join('; ')}` : ''
    })
    .filter(Boolean)
  if (!lines.length) return ''
  return `THE PERFORMANCE FOR THIS CLIP — what each person is playing. Write it as
observable behaviour in the shots above; never name an objective or a tactic
in the prompt itself, and never state an emotion as a label.

${lines.join('\n')}
`
}
