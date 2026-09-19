/**
 * DIRECTION — one clip: which shots exist, and how each is filmed.
 *
 * This is preset B's first added call (`lib/pipeline.ts`). It exists because
 * the direction work in preset A is DELIBERATELY DISCARDED: `DEFAULT_TEMPLATES.draft`
 * hands the model the whole directing corpus, tells it to work the gates
 * through — scene formula, every shot's job, the beat grid with a duration and
 * a change per beat — and then says "Do NOT output that working." So with
 * `h3-direction` loaded (it is, confirmed by the founder 2026-09-18) all of
 * that reasoning is thrown away and only whatever leaked into one free-text
 * field survives. Preset B's hypothesis is that making direction an ARTIFACT
 * beats asking for it as internal monologue, with the same corpus in both arms.
 *
 * SHAPE, AND THE TWO MEASURED FAILURES IT SITS BETWEEN. Both this codebase and
 * the h3_film_slm bundle learned the same lesson from opposite sides:
 *
 *   - too FLAT: `schema.ts`'s six strings reliably produce prose and nothing
 *     else; a decomposed probe variant took exact-case controlled camera terms
 *     from 0% to 95%, a large real win.
 *   - too DEEP: that same probe variant induced a new defect — the model wrote
 *     structural tokens (`'},{'`, `'>=1'`) into free string slots where a field
 *     had a format the grammar could not express. It is still parked in
 *     `probe/json-schema` for that reason.
 *   - too BIG: h3_film_slm's direction schema v0.6.0 asked 169 leaf fields in
 *     one call and a 27B "dropped required fields it had supplied correctly on
 *     earlier attempts". Its own recorded fix was SPLITTING THE CALL — one per
 *     shot — not raising the reasoning budget.
 *
 * So this is one call per CLIP, not per film and not per shot. A clip is about
 * four shots, so roughly thirty leaf fields — an order of magnitude under the
 * 169 that failed, and split further if a clip runs long. Per-shot would follow
 * film_slm exactly, but it measured `acting` at 67.1s per call and a 5-minute
 * film is ~45 shots; per-clip is what fits the constraint this whole studio is
 * built around, prompt production staying under render time.
 *
 * PROPERTY ORDER IS THE FEATURE, borrowed wholesale from h3_film_slm: "the
 * model emits properties in the order they are declared, so declaring every
 * justification BEFORE the decision it justifies makes the model reason in
 * writing before it commits." Every `why` field below precedes what it
 * justifies. Do not reorder these for tidiness.
 */

/** The controlled camera motion vocabulary, verbatim from `h3-prompting`'s
 * `base_guide.md:100-111`. Copied rather than imported from
 * `probe/json-schema/schemas.ts` so shipped code never depends on the probe
 * tree — and as an ENUM rather than prose because that is precisely the change
 * the probe measured at 0% -> 95% exact-case compliance. */
export const H3_CONTROLLED_CAMERA_TERMS = [
  'Zoom In', 'Zoom Out', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right',
  'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down',
  'Arc Shot', 'Tracking Shot', 'Static Shot', 'Shake Slightly', 'Shake Strongly',
  'POV', 'Roll Clockwise', 'Roll Counterclockwise',
] as const

/**
 * Five camera figures from the Singularity spec's §9
 * (https://huggingface.co/WarmBloodAban/Minimax-h3_Singularity/blob/main/MiniMax_H3_Singularity_Prompt_Writing_Specification_Enhanced_EN.md),
 * added ALONGSIDE — not instead of — the 20 above. DO NOT fold these back
 * into `H3_CONTROLLED_CAMERA_TERMS` or "clean up" the split: the two lists
 * are different KINDS of thing wearing the same `string` type.
 *
 * The first 20 are MiniMax's own controlled vocabulary — tokens H3's prompt
 * parser recognises as such. These five are corpus-tested camera FIGURES the
 * Singularity spec documents; H3 reads them as ordinary descriptive prose,
 * not as tokens. They earn a place here anyway because each names a move the
 * official 20 cannot express: `Swoop` is a curved/diving trajectory through
 * space (not a straight push/pull or a fixed-radius arc); `Whip Pan` is a
 * rapid rotational snap (not `Pan Left`/`Pan Right`'s steady rotation);
 * `Dive` is a downward-and-forward plunge from an elevated viewpoint (no
 * existing term is vertical AND forward); `Handheld` is a controlled
 * physical-presence shake distinct from `Shake Slightly`/`Shake Strongly`'s
 * pure amplitude; `Barrel Roll` rolls around the lens axis WHILE travelling
 * (unlike `Roll Clockwise`/`Roll Counterclockwise`, which roll in place).
 *
 * Everything else §9 names was deliberately left OUT because the official 20
 * already cover it: orbit/arc -> `Arc Shot`, tracking -> `Tracking Shot`,
 * push-in -> `Push In`, pull-back -> `Pull Out`, pan -> `Pan Left`/`Pan
 * Right`, tilt -> `Tilt Up`/`Tilt Down`, static/locked-off -> `Static Shot`.
 */
export const SINGULARITY_CAMERA_TERMS = ['Swoop', 'Whip Pan', 'Dive', 'Handheld', 'Barrel Roll'] as const

/** The enum AND the template both read from this — widening flows through
 * automatically to both without a second edit site. */
export const CAMERA_TERMS = [...H3_CONTROLLED_CAMERA_TERMS, ...SINGULARITY_CAMERA_TERMS] as const

export type CameraTerm = (typeof CAMERA_TERMS)[number]

/** True only for the official 20 — the narrower question `offVocabularyMovements`
 * cannot answer, since a Singularity term passes that check by design. */
export function isH3ControlledTerm(term: string): boolean {
  return (H3_CONTROLLED_CAMERA_TERMS as readonly string[]).includes(term)
}

/** One directed shot. */
export interface DirectedShot {
  /** 1-based within the clip. */
  index: number
  /** Why this shot exists at all — stated BEFORE the shot is specified. */
  whyThisShot: string
  /** What the audience is doing with their eyes here. */
  viewerGaze: string
  cameraStartAngle: string
  cameraEndAngle: string
  /** From `CAMERA_TERMS`, verbatim. */
  cameraMovement: string
  optics: string
  backgroundTreatment: string
  /**
   * The action, decomposed into an ordered causal chain per the Singularity
   * spec's §8 ("Action Writing: From Labels to Processes") — a one-word
   * label like "attacks" or "examines" is not visually reliable, so the
   * shot is forced to write the chain out rather than assert it. Declared,
   * required and rendered in this order because the order IS the chain:
   *
   *   1. initialState — where the shot opens
   *   2. trigger       — the one thing that starts it
   *   3. action        — the primary continuous action (§8's own name; kept
   *                       unchanged because downstream code and stored
   *                       documents reference this field)
   *   4. reaction       — the contact/impact beat and its physical consequence
   *   5. finalState     — where the shot settles, for §12 continuity to pick up
   *
   * COMPATIBILITY: documents authored before this change are persisted in
   * IndexedDB without these four new fields. `parseDirection` coerces
   * missing values to `''` via `str()`, and `directionToPromptBlock` filters
   * empty lines, so an old document still renders a clean (shorter) block.
   */
  initialState: string
  trigger: string
  action: string
  reaction: string
  finalState: string
  /** h3_film_slm's `threeDetails`: three concrete facts that stop a shot
   * reading as a generic description of its own summary. */
  environmentalPressure: string
  physicalMicroAction: string
  thirdConcreteFact: string
}

export interface DirectionDoc {
  /** The clip this directs, by its plan index. */
  clipIndex: number
  /** The clip's own understanding of itself, before any shot is chosen. */
  wantRightNow: string
  obstacle: string
  geometrySentence: string
  rhythm: string
  /** Why this set of shots, rather than another — declared after the
   * interrogation above and before the shots themselves. */
  whyTheseShots: string
  shots: DirectedShot[]
}

export const DIRECTION_TEMPLATE = `Direct ONE clip. Decide which shots exist and how each one is filmed.

You are NOT writing the prompt. Another pass does that, and it will be given
exactly what you write here — so anything you leave vague it has to invent,
and anything you decide it will honour.

ANSWER IN THE ORDER ASKED. Each justification comes before the decision it
justifies, deliberately: state why, then commit. Do not skip ahead and do not
go back and revise an earlier answer to fit a later one.

INTERROGATE THE CLIP FIRST — what is wanted right now, what stops it, where
the bodies and the camera are in relation to each other (use directional
words), and the rhythm. Then decide which shots exist and why.

THEN SPECIFY EACH SHOT. Camera movement MUST be one of these, spelled exactly:
{{cameraTerms}}

WHAT YOU MAY NOT CHANGE: the people, the place, the action and its outcome,
and any dialogue. Those are fixed. You decide HOW it is shot, never WHAT
happens.

DO NOT WRITE ONE-WORD ACTIONS. Write the chain: the state the shot opens in,
the one thing that triggers it, the primary action, the contact/impact
reaction, and the state it settles into. If anything distant or in the
background is meant to keep moving, SAY SO — left unstated, it freezes.

DO NOT WRITE performance here — no gaze direction for the actor, no breath, no
delivery. A separate pass owns that. You own the camera and the frame.

{{film}}

THE CLIP
{{covers}}

THE SHOTS THIS CLIP WAS PLANNED AS
{{shots}}

{{plates}}`

export function fillDirectionTemplate(
  template: string,
  parts: { covers: string; shots: string; film: string; plates: string },
): string {
  return template
    .replace(/\{\{cameraTerms\}\}/g, CAMERA_TERMS.join(', '))
    .replace(/\{\{covers\}\}/g, parts.covers)
    .replace(/\{\{shots\}\}/g, parts.shots)
    .replace(/\{\{film\}\}/g, parts.film)
    .replace(/\{\{plates\}\}/g, parts.plates)
    .trim()
}

/** `response_format` for the direction call — same flat-ish, `strict: true`
 * discipline as `schema.ts`'s `h3ResponseFormat` and `shotList.ts`'s, so an
 * endpoint that compiles JSON Schema into a sampling grammar makes a malformed
 * direction unreachable. `cameraMovement` is the one enum, for the reason in
 * `CAMERA_TERMS`'s comment. */
export function directionResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'direction',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['wantRightNow', 'obstacle', 'geometrySentence', 'rhythm', 'whyTheseShots', 'shots'],
        properties: {
          wantRightNow: { type: 'string', description: 'What is wanted RIGHT NOW in this clip, by whoever drives it.' },
          obstacle: { type: 'string', description: 'What stops it. Not a mood — a thing in the way.' },
          geometrySentence: {
            type: 'string',
            description:
              'Where the bodies and the camera are in relation to each other, in ONE sentence, using directional words (left of, behind, facing away, above).',
          },
          rhythm: { type: 'string', description: 'The clip\'s rhythm — where it is slow, where it turns, where it lands.' },
          whyTheseShots: {
            type: 'string',
            description: 'Why THIS set of shots rather than another. Stated before the shots, so the set is reasoned rather than listed.',
          },
          shots: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: [
                'index', 'whyThisShot', 'viewerGaze',
                'cameraStartAngle', 'cameraEndAngle', 'cameraMovement',
                'optics', 'backgroundTreatment',
                'initialState', 'trigger', 'action', 'reaction', 'finalState',
                'environmentalPressure', 'physicalMicroAction', 'thirdConcreteFact',
              ],
              properties: {
                index: { type: 'number', description: '1-based within this clip, contiguous.' },
                whyThisShot: { type: 'string', description: 'Why this shot exists. Answered BEFORE it is specified.' },
                viewerGaze: { type: 'string', description: 'What the audience is looking at, and what they are looking FOR.' },
                cameraStartAngle: { type: 'string', description: 'Where the camera starts — height, side, distance.' },
                cameraEndAngle: { type: 'string', description: 'Where it ends. The same as the start is a legitimate answer for a held shot.' },
                cameraMovement: { type: 'string', enum: [...CAMERA_TERMS], description: 'Exactly one term from the list above, spelled verbatim.' },
                optics: { type: 'string', description: 'Focal length and depth of field, consistent with the film-wide look.' },
                backgroundTreatment: {
                  type: 'string',
                  description:
                    'What the background does — what is legible in it, what falls away. State whether anything back there keeps moving through the shot. If a distant or background figure is meant to keep walking, working, or acting, say so explicitly — left unstated, it freezes.',
                },
                initialState: { type: 'string', description: 'The state this shot opens in — body position, weight, what the hands hold, where the eyes already are. Not backstory: what a frame-one still would show.' },
                trigger: { type: 'string', description: 'The one thing that starts the movement. Name a single event, not a mood.' },
                action: { type: 'string', description: 'The primary continuous action, and the displacement or momentum it produces.' },
                reaction: { type: 'string', description: 'The contact or impact beat and its physical consequence — recoil, stagger, cloth and hair responding to force, dust, spill, a surface taking light.' },
                finalState: { type: 'string', description: 'The pose or state this shot settles into — write it explicitly so the next shot can carry it forward.' },
                environmentalPressure: { type: 'string', description: 'One concrete fact about the place pressing on the people — heat, noise, crowding, cold.' },
                physicalMicroAction: { type: 'string', description: 'One small physical act, specific enough that it could not be any other scene.' },
                thirdConcreteFact: { type: 'string', description: 'A third concrete, visible fact. Not a feeling, not a restatement of the action.' },
              },
            },
          },
        },
      },
    },
  }
}

/** Strip a ```json fence, if present — the same tolerant unwrap `stages.ts`
 * and `shotList.ts` each apply locally. */
function stripFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

/**
 * Parse a direction document, coercing rather than trusting — the same
 * defensive shape `parseShotList` and `parseBreakdown` use. `clipIndex` is
 * carried IN rather than read back out of the reply: the studio knows which
 * clip it asked about, and never needs the model to echo it correctly.
 */
export function parseDirection(raw: string, clipIndex: number): DirectionDoc | null {
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
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  if (!Array.isArray(o.shots) || !o.shots.length) return null

  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const shots: DirectedShot[] = o.shots.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    return {
      index: Number(c.index) || i + 1,
      whyThisShot: str(c.whyThisShot),
      viewerGaze: str(c.viewerGaze),
      cameraStartAngle: str(c.cameraStartAngle),
      cameraEndAngle: str(c.cameraEndAngle),
      // An off-vocabulary movement is kept as written rather than dropped or
      // snapped to a neighbour: the prompt writer downstream can still read
      // "slow push" and do something sensible, whereas an empty field tells it
      // nothing. `offVocabularyMovements` reports the drift instead.
      cameraMovement: str(c.cameraMovement),
      optics: str(c.optics),
      backgroundTreatment: str(c.backgroundTreatment),
      // The four chain fields are absent on a pre-change document rehydrated
      // from IndexedDB; `str()` coerces that absence to '', same as any other
      // missing field here — no special-casing needed.
      initialState: str(c.initialState),
      trigger: str(c.trigger),
      action: str(c.action),
      reaction: str(c.reaction),
      finalState: str(c.finalState),
      environmentalPressure: str(c.environmentalPressure),
      physicalMicroAction: str(c.physicalMicroAction),
      thirdConcreteFact: str(c.thirdConcreteFact),
    }
  })

  return {
    clipIndex,
    wantRightNow: str(o.wantRightNow),
    obstacle: str(o.obstacle),
    geometrySentence: str(o.geometrySentence),
    rhythm: str(o.rhythm),
    whyTheseShots: str(o.whyTheseShots),
    shots: shots.map((s, i) => ({ ...s, index: i + 1 })),
  }
}

/** Which shots named a camera movement outside the (now widened) vocabulary.
 * Reported, never corrected — this is the number the A/B wants (the probe
 * measured 0% -> 95% on exactly this), and snapping a term would hide it.
 * A Singularity term (`Swoop`, `Whip Pan`, ...) passes this check BY DESIGN —
 * it is a legal `CAMERA_TERMS` entry, just not an `H3_CONTROLLED_CAMERA_TERMS`
 * one. Use `isH3ControlledTerm` when the narrower question is what you mean. */
export function offVocabularyMovements(doc: DirectionDoc): number[] {
  const ok = new Set<string>(CAMERA_TERMS)
  return doc.shots.filter((s) => !ok.has(s.cameraMovement)).map((s) => s.index)
}

/**
 * The direction document as the block preset B's prompt writer is given.
 *
 * The justifications are deliberately LEFT OUT: `whyThisShot`, `viewerGaze`
 * and the clip interrogation exist to make the model reason before it commits,
 * and they have done that job by the time this is read. Passing them on would
 * re-spend the tokens and invite the writer to argue with decisions already
 * made — the same reason h3_film_slm's acting node is told the director's
 * choices "may not be restated here".
 */
export function directionToPromptBlock(doc: DirectionDoc | undefined): string {
  if (!doc || !doc.shots.length) return ''
  const shots = doc.shots.map((s) => {
    const details = [s.environmentalPressure, s.physicalMicroAction, s.thirdConcreteFact].filter(Boolean)
    return [
      `[Shot ${s.index}]`,
      // The chain, in causal order — §8's own sequence, minus the
      // justification fields already spent on the way here. A pre-change
      // document has no initialState/trigger/reaction/finalState; `.filter
      // (Boolean)` drops those lines rather than printing them empty, so the
      // block still reads cleanly with only `action` present.
      s.initialState ? `  initialState: ${s.initialState}` : '',
      s.trigger ? `  trigger: ${s.trigger}` : '',
      `  action: ${s.action}`,
      s.reaction ? `  reaction: ${s.reaction}` : '',
      s.finalState ? `  finalState: ${s.finalState}` : '',
      `  camera: ${s.cameraStartAngle} -> ${s.cameraEndAngle}, ${s.cameraMovement}`,
      `  optics: ${s.optics}`,
      `  background: ${s.backgroundTreatment}`,
      details.length ? `  concrete: ${details.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  return `THE DIRECTION FOR THIS CLIP — already decided. Write these shots, in this
order, with these camera moves. Do not re-choose them, do not add a shot and do
not drop one. Whatever camera term was chosen must appear verbatim — some are
H3's controlled vocabulary, some are corpus-tested figures from the
Singularity spec, but either way the exact wording is fixed, not a suggestion.

Geometry: ${doc.geometrySentence}
Rhythm: ${doc.rhythm}

${shots.join('\n\n')}
`
}
