/**
 * The candidate output schemas.
 *
 * Deliberately FLAT and dumb. llama.cpp compiles JSON Schema to a GBNF
 * grammar and its converter does not take all of JSON Schema — `allOf` and
 * `$ref` are unreliable, `pattern` is partial — so nothing here uses them.
 *
 * Note what is NOT expressible: "350-500 words". No schema can hold a word
 * count, so `detailed_description` length stays a lint check, never a
 * constraint. The schema buys presence, naming, order and the absence of
 * preamble; it buys nothing about prose quality.
 */

/** Full-reference (ref2va): six sections, fixed order. */
export const REF_SIX = {
  type: 'object',
  additionalProperties: false,
  required: [
    'subject_definitions',
    'summary',
    'retention_analysis',
    'detailed_description',
    'overall_soundscape',
    'non_diegetic_music',
  ],
  properties: {
    subject_definitions: {
      type: 'string',
      description:
        'One line per label. `<Subject N> is …` for a person/environment/garment/prop/style/action. A character or style plate is a Subject, never a Picture.',
    },
    summary: {
      type: 'string',
      description:
        'One paragraph, opening with a bracketed task type: [reference generation] / [video continuation] / [keyframe completion] / [video editing] / [audio reuse] / [audio reference], combined with " + ".',
    },
    retention_analysis: {
      type: 'string',
      description:
        'One line per label, each ending in a relationship marker: fully_preserved / partially_preserved / attribute_transfer / weak_reference for visible labels; fully_copy / partially_copy / reference / weak_reference for audio. Never write "(Sx)" here.',
    },
    detailed_description: {
      type: 'string',
      description:
        'The body, 350-500 words, in playback order. Style in one or two sentences BEFORE [Shot 1]. [Shot 1] carries no timestamp; later shots are "[Shot N] At MM:SS.mmm, the shot cuts to …", strictly increasing. Camera motion uses the controlled vocabulary verbatim. Every spoken line carries a speaker id (S1)/(S2) before the verb AND the words inside <d>[Language] … </d>.',
    },
    overall_soundscape: {
      type: 'string',
      description:
        'Ambience and physical sound only. NO voice content of any kind, not even described in the abstract.',
    },
    non_diegetic_music: {
      type: 'string',
      description:
        'Audience-only score: instrumentation, tempo, dynamics. Exactly "N/A" when there is to be no music — never a sentence describing its absence.',
    },
  },
} as const

/** Base (T2VA / I2VA / FL2VA / L2VA): three core fields. */
export const BASE_THREE = {
  type: 'object',
  additionalProperties: false,
  required: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
  properties: {
    integrated_multimodal_description: {
      type: 'string',
      description:
        'The body, in playback order. Style AFTER the [Shot 1] marker in this form. Shot, camera, speaker and dialogue formats as in the base guide.',
    },
    overall_soundscape: { type: 'string', description: 'Ambience and physical sound only. No voice content.' },
    non_diegetic_music: { type: 'string', description: 'Score, or exactly "N/A" for none.' },
  },
} as const

/**
 * The more-structure variant: the body becomes a shot array.
 *
 * This is the genuinely open question the flat schema cannot answer — does
 * forcing the shot grid produce a better body, or does chopping the prose into
 * cells make each cell worse? `at` is a string, not a number, because the
 * format is MM:SS.mmm and shot 1 must be able to carry nothing.
 */
export const REF_SHOTS = {
  type: 'object',
  additionalProperties: false,
  required: [
    'subject_definitions',
    'summary',
    'retention_analysis',
    'style',
    'shots',
    'overall_soundscape',
    'non_diegetic_music',
  ],
  properties: {
    subject_definitions: REF_SIX.properties.subject_definitions,
    summary: REF_SIX.properties.summary,
    retention_analysis: REF_SIX.properties.retention_analysis,
    style: {
      type: 'string',
      description: 'One or two sentences of visual style. Sits before [Shot 1] in the assembled body.',
    },
    shots: {
      type: 'array',
      minItems: 2,
      maxItems: 6,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['at', 'prose'],
        properties: {
          at: {
            type: 'string',
            description: 'Empty string for the first shot. Otherwise MM:SS.mmm, strictly increasing.',
          },
          prose: {
            type: 'string',
            description:
              'Composition, each subject and their position in frame, environment and light, the action as a state change, camera motion from the controlled vocabulary, and the sound of this moment. Dialogue carries (Sx) and <d>[Language] …</d>.',
          },
        },
      },
    },
    overall_soundscape: REF_SIX.properties.overall_soundscape,
    non_diegetic_music: REF_SIX.properties.non_diegetic_music,
  },
} as const

/** Canonical field order for assembling flat JSON back into prompt text. */
export const REF_ORDER = REF_SIX.required
export const BASE_ORDER = BASE_THREE.required

// ─────────────────────────────────────────────────────────────────────────────
// The DECOMPOSED schema.
//
// The flat schemas above constrain only the SECTION SHAPE — six strings — so
// every fatal defect the judges found lived inside one of those strings, where
// no grammar can reach. This one removes the slot instead of forbidding the
// content:
//
//   · camera is an ENUM of the 20 controlled terms, so a shot cannot exist
//     without a registering camera term, and "in a static medium shot" is
//     unrepresentable. (Measured: 0 exact-case terms in the flat 8k set.)
//   · dialogue is an ARRAY whose entries cannot be half-filled, and the
//     ASSEMBLER writes the speech sentence — so speech-without-words has no
//     path to exist, and (Sx) is a field rather than a phrasing choice.
//   · overall_soundscape entries carry a `kind` enum with NO vocal member, so
//     there is no category for voice content.
//   · non_diegetic_music is a BOOLEAN plus a description; `present: false`
//     makes the assembler emit exactly `N/A`, so suppression-by-denial — the
//     defect both DENIAL-flagged prompts hit — cannot be written.
//   · `at` is ignored for the first shot by the assembler, so [Shot 1] can
//     never carry a timestamp.
//
// Constructs are limited to enum / required / array / nested object, which are
// the parts of JSON Schema llama.cpp's GBNF converter handles reliably. No
// if-then, allOf, $ref or oneOf.
// ─────────────────────────────────────────────────────────────────────────────

/** base_guide.md:100-111 — the controlled camera motion vocabulary, verbatim. */
export const CAMERA_TERMS = [
  'Zoom In', 'Zoom Out', 'Push In', 'Pull Out', 'Pan Left', 'Pan Right',
  'Truck Left', 'Truck Right', 'Tilt Up', 'Tilt Down', 'Pedestal Up', 'Pedestal Down',
  'Arc Shot', 'Tracking Shot', 'Static Shot', 'Shake Slightly', 'Shake Strongly',
  'POV', 'Roll Clockwise', 'Roll Counterclockwise',
] as const

const CAMERA_MODIFIERS = [
  '', 'with small amplitude', 'with large amplitude', 'at slow speed', 'at fast speed',
] as const

const TASK_TYPE_ENUM = [
  'keyframe completion', 'reference generation', 'video editing',
  'video continuation', 'audio reuse', 'audio reference',
] as const

const MARKER_ENUM = [
  'fully_preserved', 'partially_preserved', 'attribute_transfer', 'weak_reference',
  'fully_copy', 'partially_copy', 'reference',
] as const

const SOUND_KIND = [
  'ambience', 'impact', 'friction', 'mechanical', 'weather', 'body_movement', 'water', 'fire',
] as const

export const REF_DECOMPOSED = {
  type: 'object',
  additionalProperties: false,
  required: ['subject_definitions', 'task_types', 'summary', 'retention_analysis', 'style', 'speakers', 'shots', 'crowd', 'overall_soundscape', 'non_diegetic_music'],
  properties: {
    subject_definitions: {
      type: 'array', minItems: 1, maxItems: 9,
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'definition'],
        properties: {
          label: { type: 'string', description: 'Exactly like "<Subject 1>", "<Picture 1>", "<Video 1>" or "<Audio 1>". A character, scene, costume or style plate is a Subject; only a true first/last/keyframe anchor is a Picture.' },
          definition: { type: 'string', description: 'What this label denotes and the features to follow. Name concrete features; never write only "as in the reference".' },
        },
      },
    },
    task_types: {
      type: 'array', minItems: 1, maxItems: 3,
      items: { type: 'string', enum: TASK_TYPE_ENUM },
      description: 'The task types for this generation. A reference supplying only camera/cuts/rhythm is reference generation, NOT video editing.',
    },
    summary: { type: 'string', description: 'One paragraph using the labels. Do NOT write the bracketed task-type prefix yourself — it is generated from task_types.' },
    retention_analysis: {
      type: 'array', minItems: 1, maxItems: 9,
      items: {
        type: 'object', additionalProperties: false,
        required: ['label', 'shots', 'marker', 'note'],
        properties: {
          label: { type: 'string', description: 'The same label string as in subject_definitions.' },
          shots: { type: 'string', description: 'Where it appears, e.g. "appears in [Shot 1], [Shot 3]". Must agree with the shots array.' },
          marker: { type: 'string', enum: MARKER_ENUM, description: 'Use attribute_transfer for a garment/style/trait moved onto a different target subject. Audio labels take fully_copy / partially_copy / reference / weak_reference.' },
          note: { type: 'string', description: 'One clause on what is preserved. Never write a speaker id here.' },
        },
      },
    },
    speakers: {
      type: 'array', maxItems: 4, uniqueItems: true,
      description: 'CAST every speaking subject here ONCE, before writing any shot. Empty array for a scene with no speech. One entry per DISTINCT voice: two people who both speak need two entries with two different ids. A shot\'s dialogue then references an id from this table, so the same person always carries the same id and their vocal identity is emitted exactly once, before their first line.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'subject_label', 'vocal_identity'],
        properties: {
          id: { type: 'string', enum: ['S1', 'S2', 'S3', 'S4'], description: 'Assign in order of first vocal event. Never reuse one id for two different people.' },
          subject_label: { type: 'string', description: 'The speaking subject\'s label, e.g. "<Subject 2>".' },
          vocal_identity: { type: 'string', description: 'Age, register, pace, accent — fixed for this voice, e.g. "late thirties, warm mid-range, unhurried".' },
        },
      },
    },
    style: { type: 'string', description: 'ONE or TWO sentences of visual style only — medium, palette, light quality, grain, depth of field. This is not the place for prohibitions: do not write any "No ..." clauses here or anywhere.' },
    shots: {
      type: 'array', minItems: 1, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['at', 'camera', 'camera_modifier', 'composition', 'subjects_in_frame', 'opening_state', 'action', 'closing_state', 'sound', 'dialogue'],
        properties: {
          at: { type: 'string', description: 'MM:SS.mmm for shots after the first, strictly increasing. Ignored for the first shot, which never carries a timestamp.' },
          camera: { type: 'string', enum: CAMERA_TERMS, description: 'The controlled camera motion for this shot. If only distance or angle would change from the previous shot, move the camera instead of cutting.' },
          camera_modifier: { type: 'string', enum: CAMERA_MODIFIERS, description: 'Optional amplitude or speed qualifier; empty string for none.' },
          composition: { type: 'string', description: 'Framing and shot size, plus environment and light in this moment.' },
          subjects_in_frame: { type: 'array', minItems: 1, items: { type: 'string' }, description: 'One entry per visible subject: its label and WHERE IN FRAME it sits, e.g. "<Subject 1> left of frame, three-quarter back to camera".' },
          opening_state: {
            type: 'string',
            description: 'The physical state this shot OPENS on — posture, position in the room and in frame, and the phase and direction of any movement already underway. It must describe the SAME INSTANT as the previous shot\'s closing_state, seen from this shot\'s framing. Empty string for the first shot only. Use continuation verbs (crosses, keeps, carries, meets, completes) and never an initiating verb: the verb that starts an action appears exactly once, in `action`, in the shot where it starts.',
          },
          action: { type: 'string', description: 'The action as an observable STATE CHANGE, not an emotion label. 40-80 words. Each cut must bring new information. The initiating verb for a new action belongs here and appears only once across the whole prompt.' },
          closing_state: {
            type: 'string',
            description: 'The physical state this shot ENDS on — posture, position, and the phase and direction of any movement still in progress. The next shot opens on this same instant. If a posture or location differs between two shots, the change must be visibly underway here; a subject standing at one shot\'s end and seated at the next shot\'s open, with nothing in between, is two unrelated events rather than one.',
          },
          sound: { type: 'string', description: 'The physical, synchronised sound of THIS moment — impacts, footsteps, fabric, mechanism. No voices, and nothing that conveys words.' },
          dialogue: {
            type: 'array', maxItems: 4,
            description: 'Empty when nobody speaks in this shot. Never describe speech in `action` — put it here and the speech line is generated for you.',
            items: {
              type: 'object', additionalProperties: false,
              required: ['speaker_id', 'language', 'words', 'delivery'],
              properties: {
                speaker_id: { type: 'string', enum: ['S1', 'S2', 'S3', 'S4'], description: 'MUST be an id you declared in the top-level `speakers` table. The label and vocal identity are looked up from there — do not restate them.' },
                language: { type: 'string', description: 'e.g. "English", "Hindi".' },
                words: { type: 'string', minLength: 1, description: 'The EXACT words spoken. Never empty.' },
                delivery: { type: 'string', enum: ['on-camera', 'off-screen voiceover'], description: 'off-screen voiceover renders the required phrase and states the lips stay closed.' },
              },
            },
          },
        },
      },
    },
    crowd: {
      type: 'object', additionalProperties: false,
      required: ['present', 'rendering', 'sources'],
      properties: {
        present: { type: 'boolean' },
        rendering: { type: 'string', enum: ['no_crowd', 'non_vocal_texture', 'worded_dialogue'],
          description: 'A crowd rendered as voices WITHOUT words becomes babble. Choose non_vocal_texture and describe it through sources, or worded_dialogue and supply real lines in a shot\'s dialogue array.' },
        sources: { type: 'array', items: { type: 'string' }, description: 'Non-vocal crowd sound sources: footsteps on packed ground, crates, fabric, handled produce.' },
      },
    },
    overall_soundscape: {
      type: 'array', minItems: 2, maxItems: 10,
      description: 'AMBIENCE that runs under the whole video. Shot-synchronised events belong in that shot\'s `sound` field instead.',
      items: {
        type: 'object', additionalProperties: false,
        required: ['source', 'kind'],
        properties: {
          source: { type: 'string', description: 'A concrete physical source, not a mood.' },
          kind: { type: 'string', enum: SOUND_KIND },
        },
      },
    },
    non_diegetic_music: {
      type: 'object', additionalProperties: false,
      required: ['present', 'description'],
      properties: {
        present: { type: 'boolean', description: 'false renders exactly "N/A". Never describe the absence of music.' },
        description: { type: 'string', description: 'When present: instrumentation, tempo, dynamics and how it tracks the beats. Empty string when absent.' },
      },
    },
  },
} as const
