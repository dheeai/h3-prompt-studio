import type { Finding, H3Mode, StageId } from './types'

/**
 * The prompt check.
 *
 * Deterministic rules only — no model involved. These encode failure modes
 * that were measured on real renders, which is why several of them look
 * paranoid: each one cost somebody a generation to find.
 */

function fieldValue(text: string, field: string): string | null {
  // Matches "field: value" or "field\n  value", up to the next top-level field.
  const re = new RegExp(`^[ \\t]*${field}[ \\t]*:?[ \\t]*(.*(?:\\n(?![ \\t]*[a-z_]+[ \\t]*:).*)*)`, 'im')
  const m = text.match(re)
  return m ? m[1].trim() : null
}

function excerpt(text: string, index: number, len: number, pad = 34): string {
  const start = Math.max(0, index - pad)
  const end = Math.min(text.length, index + len + pad)
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`
}

function findAll(text: string, re: RegExp): { match: string; excerpt: string }[] {
  const out: { match: string; excerpt: string }[] = []
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m: RegExpExecArray | null
  while ((m = rx.exec(text))) {
    out.push({ match: m[0], excerpt: excerpt(text, m.index, m[0].length) })
    if (out.length > 12) break
  }
  return out
}

const DENIAL = /\b(none|no\b|without|silence|silent|absent|absence|do not|don'?t|never|avoid|omit)\b/i

const MUSIC_VOCAB =
  /\b(\d{2,3}\s?bpm|on the beat|on-beat|off-?beat|downbeat|upbeat|to the rhythm|rhythmic(?:ally)?|musical(?:ly)?|percussi\w+|melod\w+|harmon(?:y|ies|ic)|tempo|syncopat\w+|groove|drum\w*|bass ?line|chord\w*|score|soundtrack|instrument(?:al|s)?)\b/i

const DIALOGUE_NEGATION =
  /\b(?:does not|doesn'?t|will not|won'?t|never)\s+(?:speak|talk|say|utter)\w*\b|\bno (?:dialogue|lines|speech|words)\b|\bsays nothing\b|\bwordless\b|\bin silence\b/i

/**
 * Required sections differ by mode, and getting this wrong flags a correct
 * prompt as broken.
 *
 * Full-reference (Ref2VA) output is six named sections in a fixed order —
 * subject_definitions, summary, retention_analysis, detailed_description,
 * overall_soundscape, non_diegetic_music — and does NOT use
 * integrated_multimodal_description, which belongs to the base modes.
 */
const BASE_FIELDS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music']
const REF_FIELDS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
]

function requiredFields(mode: H3Mode): string[] {
  return mode === 'Ref2VA' ? REF_FIELDS : BASE_FIELDS
}

/**
 * Full-reference mode labels content as <Subject N> / <Picture N> / <Video N> /
 * <Audio N>. The @name form belongs to our own shorthand, so both count.
 */
function referenceLabels(text: string): string[] {
  const angle = [...text.matchAll(/<\s*(Subject|Picture|Video|Audio)\s+\d+\s*>/gi)].map((m) => m[0].replace(/\s+/g, ' '))
  const at = [...text.matchAll(/@[a-z0-9_]+/gi)].map((m) => m[0])
  return [...new Set([...angle, ...at])]
}

const FIELD_NAMES = [
  'integrated_multimodal_description',
  'overall_soundscape',
  'non_diegetic_music',
  'detailed_description',
  'retention_analysis',
  'subject_definitions',
]

/**
 * Strip markdown/heading decoration from one line, so a field name buried
 * inside `## Non Diegetic Music` or `**overall_soundscape**` reads the same
 * as the plain `overall_soundscape:` the strict form expects.
 */
function normalizeLine(line: string): string {
  return line
    .replace(/^[ \t#>*_-]+/, '')
    .replace(/[ \t*_#]+$/, '')
    .toLowerCase()
}

/**
 * Which of the six canonical field names appear at the start of a line, in
 * ANY casing or spacing — Title Case, markdown-bolded, a heading, spaces
 * instead of underscores. A rough or badly formatted pasted prompt uses these
 * constantly; only the punctuation differs from the strict form.
 */
function fieldNamesFound(text: string): string[] {
  const lines = text.split('\n')
  const found = new Set<string>()
  for (const raw of lines) {
    const line = normalizeLine(raw)
    if (!line) continue
    for (const name of FIELD_NAMES) {
      const words = name.split('_')
      const pattern = new RegExp(`^${words.join('[\\s_-]+')}\\b`, 'i')
      if (pattern.test(line)) found.add(name)
    }
  }
  return [...found]
}

/**
 * Is this text already a prompt rather than a story? Used to decide whether a
 * pasted source can be critiqued directly instead of being directed first.
 *
 * Loosened to count the markdown/heading/Title-Case variants of a field name
 * too — a badly formatted pasted prompt is still a prompt, and `lint()`'s own
 * field parsing stays strict, so its "missing required field" finding is then
 * honest information about the FORMATTING rather than a false "not a prompt".
 */
export function looksLikePrompt(text: string): boolean {
  return fieldNamesFound(text).length > 0
}

/**
 * The ORIGINAL strict check — a canonical field name at line start with a
 * colon, no formatting on top. `classifyInput` needs this exact distinction
 * to tell a finished prompt apart from a rough one; the loosened
 * `looksLikePrompt` above deliberately can no longer make that call, since it
 * treats both as "a prompt" for the purpose of enabling prompt operations.
 */
function looksLikePromptStrict(text: string): boolean {
  return /(^|\n)[ \t]*(integrated_multimodal_description|overall_soundscape|non_diegetic_music|detailed_description|retention_analysis|subject_definitions)[ \t]*:/i.test(
    text,
  )
}

// ── classifying a pasted source ───────────────────────────────────────────

export interface Standing {
  kind: 'empty' | 'idea' | 'story' | 'brief' | 'direction-sheet' | 'rough-prompt' | 'prompt'
  confidence: 'high' | 'medium' | 'low'
  evidence: string[]
  has: string[]
  lacks: string[]
  /** One sentence describing the source and the useful next authoring move. */
  stands: string
  suggest: StageId
}

const TIMECODE_RE = /\b\d{1,2}:\d{2}\b|\[\s*\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*s\s*\]|\b\d+(?:\.\d+)?\s*[-–—]\s*\d+(?:\.\d+)?\s*s\b/i
const SHOT_SIZE_RE = /\b(close-?up|wide shot|medium shot|ecu|two-?shot|insert)\b/i
const CAMERA_RE = /\b(dolly|\bpan\b|\btilt\b|handheld|\d+\s?mm\b|rack focus|tracking shot|tracking)\b/i
const CUT_TO_RE = /\bcut to\b/i
const REF_LABEL_RE = /<\s*(subject|ref|picture|video|audio)\b/i
const ASPECT_RATIO_RE = /\b(16:9|9:16|1:1|4:5|21:9)\b/
const DURATION_RE = /\b\d+(?:\.\d+)?\s*(seconds|secs?|sec)\b/i

const ROUGH_CATEGORIES: { label: string; re: RegExp }[] = [
  { label: 'timecodes', re: TIMECODE_RE },
  { label: 'shot-size vocabulary', re: SHOT_SIZE_RE },
  { label: 'camera vocabulary', re: CAMERA_RE },
  { label: '"cut to"', re: CUT_TO_RE },
  { label: 'reference labels', re: REF_LABEL_RE },
  { label: 'an aspect ratio', re: ASPECT_RATIO_RE },
  { label: 'a duration in seconds', re: DURATION_RE },
]

function roughEvidence(text: string): string[] {
  return ROUGH_CATEGORIES.filter((c) => c.re.test(text)).map((c) => c.label)
}

function countHits(text: string, words: string[]): number {
  const lower = text.toLowerCase()
  return words.filter((w) => lower.includes(w)).length
}

/** One heuristic per aspect a prompt would eventually need to declare. */
const ASPECT_LABELS: Record<string, { has: string; lacks: string }> = {
  subject: { has: 'a subject is named', lacks: 'no subject named' },
  place: { has: 'a place is named', lacks: 'no place named' },
  action: { has: 'an action is described', lacks: 'no action described' },
  ending: { has: 'an ending is stated', lacks: 'no ending stated' },
  dialogue: { has: 'dialogue is present', lacks: 'no dialogue' },
  duration: { has: 'a duration is stated', lacks: 'no duration stated' },
  'aspect ratio': { has: 'an aspect ratio is stated', lacks: 'no aspect ratio stated' },
  'shots/cuts': { has: 'shots or cuts are described', lacks: 'no shots or cuts described' },
  camera: { has: 'camera behaviour is described', lacks: 'no camera direction' },
  'sound sources': { has: 'sound sources are named', lacks: 'no sound sources named' },
  'music field': { has: 'the music field is set', lacks: 'no music field' },
  'field structure': { has: 'the official field structure is present', lacks: 'no official field structure' },
}

/**
 * Concrete sound SOURCES — a thing in the world that makes a noise.
 *
 * Deliberately excludes 'sound', 'audio' and 'soundscape': those are the
 * words the FIELD is called, and matching them meant a soundscape reading
 * "tense, moody" was reported as having named its sources. Naming a mood
 * where a source belongs is the exact failure the linter exists to catch, so
 * the standing read must not contradict it.
 */
const SOUND_SOURCE_RE =
  /\b(rain|footsteps?|traffic|doors?|wind|engines?|birds?|breath(?:ing)?|voices?|clatter|hum|bells?|water|thunder|keyboards?|machin(?:e|ery)|crowd|sirens?|clock|ticking|creak|rustl(?:e|ing)|scrape|whistle|horn|radio|television|tv|dripping|typing|chair|glass|metal|paper|fabric|sfx|foley)\b/i

/** An actor doing something — a pronoun or a person, then a verb close by. */
const ACTION_RE =
  /\b(?:he|she|they|it|we|i|a|an|the)\b[^.\n]{0,40}?\b\w+(?:s|ed|ing)\b/i

function detectAspects(text: string): Record<string, boolean> {
  const fields = fieldNamesFound(text)
  // A proper noun used more than once is a named character; one used once is
  // as likely to be a sentence opener or a hyphenated term ("Close-up").
  const capitals = text.slice(15).match(/\b[A-Z][a-z]{2,}\b/g) || []
  const counts = capitals.reduce<Record<string, number>>((a, w) => ((a[w] = (a[w] ?? 0) + 1), a), {})
  return {
    subject:
      /\b(he|she|they|i|we)\b/i.test(text) ||
      /\ba (?:man|woman|person|boy|girl|figure|character)\b/i.test(text) ||
      Object.values(counts).some((n) => n > 1),
    place: /\b(room|street|shop|forest|kitchen|office|city|house|bay|studio|beach|field|stage|garden|lane|street)\b/i.test(text) || /\b(inside|outside|indoors|outdoors)\b/i.test(text),
    action: ACTION_RE.test(text),
    ending: /\b(ends?|finally|in the end|concludes?|resolves?)\b/i.test(text),
    dialogue: /["“][^"”]{2,}["”]/.test(text) || /\b(says?|said|asks?|asked|whispers?|whispered|shouts?|shouted)\b/i.test(text),
    duration: DURATION_RE.test(text),
    'aspect ratio': ASPECT_RATIO_RE.test(text),
    'shots/cuts': CUT_TO_RE.test(text) || TIMECODE_RE.test(text) || /\bshots?\b/i.test(text),
    camera: CAMERA_RE.test(text),
    'sound sources': SOUND_SOURCE_RE.test(text),
    'music field': fields.includes('non_diegetic_music'),
    'field structure': looksLikePromptStrict(text),
  }
}

const STANDS: Record<Standing['kind'], string> = {
  empty: 'Nothing pasted yet.',
  idea: 'This is an idea: decide the observable action, ending state, and craft choices.',
  story: 'This is a story: preserve its fixed events, then resolve the H3 shooting decisions.',
  brief: 'This is a brief: preserve its requested constraints, then resolve the H3 shooting decisions.',
  'direction-sheet': 'This is a direction sheet: use its shot decisions to build the canonical prompt.',
  'rough-prompt': 'This is a rough prompt: preserve its intent and complete the canonical H3 structure.',
  prompt: 'This is a prompt: diagnose material weaknesses, then return a complete replacement.',
}

const SUGGEST: Record<Standing['kind'], StageId> = {
  empty: 'direct',
  idea: 'direct',
  story: 'direct',
  brief: 'direct',
  'direction-sheet': 'draft',
  'rough-prompt': 'direct',
  prompt: 'revise',
}

function buildStanding(kind: Standing['kind'], confidence: Standing['confidence'], evidence: string[], text: string): Standing {
  const aspects = detectAspects(text)
  const has: string[] = []
  const lacks: string[] = []
  for (const key of Object.keys(ASPECT_LABELS)) {
    const label = ASPECT_LABELS[key]
    ;(aspects[key] ? has : lacks).push(aspects[key] ? label.has : label.lacks)
  }
  return { kind, confidence, evidence, has, lacks, stands: STANDS[kind], suggest: SUGGEST[kind] }
}

/**
 * Spec LANGUAGE, as anchored patterns rather than substrings.
 *
 * 'for a' was on this list as a substring and matched "for a long minute",
 * which is how a short story came to be read as a brief. A spec word has to
 * be used as a directive to count for anything.
 */
const SPEC_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bwe need\b/i, label: 'we need' },
  { re: /\b(?:it|this|the video|the ad|the film) (?:should|must)\b/i, label: 'should / must' },
  { re: /\bdeliverable/i, label: 'deliverable' },
  { re: /\btarget (?:audience|market|viewer)\b/i, label: 'target audience' },
  { re: /\bcall to action\b/i, label: 'call to action' },
  { re: /\bbrand(?:ing|ed)?\b/i, label: 'brand' },
  { re: /\bduration\b/i, label: 'duration' },
  { re: /\baspect ratio\b/i, label: 'aspect ratio' },
  { re: /\bkey message\b/i, label: 'key message' },
]

/**
 * How many sentences read as narration rather than specification.
 *
 * Tense-agnostic on purpose: it counts sentences that open on a person and
 * run long enough to be telling something. A story told in the present is
 * still a story, which a past-tense count cannot see.
 */
function narrativeSentences(text: string): number {
  return text.split(/(?<=[.!?])\s+/).filter((sentence) => {
    const words = sentence.trim().split(/\s+/)
    if (words.length < 6) return false
    return /^(?:he|she|they|it|we|i|his|her|their|then|[A-Z][a-z]{2,})\b/i.test(words[0] ?? '')
  }).length
}

/**
 * A deterministic read of a pasted source: what kind of thing it is and what
 * authoring work remains.
 *
 * No model involved — cheap keyword heuristics. They will occasionally be
 * wrong about a borderline source, which is fine: this is a first read for
 * the model (and the operator) to confirm or correct, not a verdict.
 */
export function classifyInput(text: string): Standing {
  const trimmed = text.trim()
  if (!trimmed) return buildStanding('empty', 'high', [], trimmed)

  if (looksLikePromptStrict(trimmed)) return buildStanding('prompt', 'high', ['canonical field structure at line start'], trimmed)

  if (/what the brief fixes/i.test(trimmed) || countHits(trimmed, ['anchor', 'beat grid', 'escalation', 'shot card']) >= 2) {
    return buildStanding('direction-sheet', 'high', ['direction-sheet vocabulary (anchors, beat grid, escalation, shot cards)'], trimmed)
  }

  const looseFields = fieldNamesFound(trimmed)
  const vocab = roughEvidence(trimmed)
  if (looseFields.length >= 2 || vocab.length >= 2) {
    const evidence = [...looseFields.map((f) => `field name “${f}” present, informally formatted`), ...vocab]
    return buildStanding('rough-prompt', looseFields.length >= 2 ? 'high' : 'medium', evidence, trimmed)
  }

  const bulletLines = trimmed.split('\n').filter((l) => /^[ \t]*([-*•]|\d+[.)])\s+/.test(l)).length
  const specHits = SPEC_PATTERNS.filter((p) => p.re.test(trimmed)).map((p) => p.label)
  // A brief has to out-vote the prose, not merely appear alongside it. One
  // spec word used to be enough, which read a short story as a specification
  // on the strength of the phrase "for a long minute" — and the narrative
  // test it was weighed against counted only PAST tense, so a story told in
  // the present ("she takes out the loupe") registered as no narrative at all.
  const narrative = narrativeSentences(trimmed)
  if ((bulletLines >= 3 || specHits.length >= 2) && narrative < 3) {
    const evidence = [bulletLines >= 3 ? `${bulletLines} bulleted/numbered lines` : '', ...specHits.map((w) => `spec language “${w}”`)].filter(Boolean)
    return buildStanding('brief', bulletLines >= 3 ? 'high' : 'medium', evidence, trimmed)
  }

  if (trimmed.length < 200) return buildStanding('idea', 'medium', [`${trimmed.length} characters — too short to be sure`], trimmed)

  return buildStanding(
    'story',
    narrative >= 3 ? 'high' : 'medium',
    [`${trimmed.length} characters of prose, ${narrative} narrative sentence${narrative === 1 ? '' : 's'}, no field structure`],
    trimmed,
  )
}

const STANDING_KIND_LABEL: Record<Standing['kind'], string> = {
  empty: 'empty',
  idea: 'an idea',
  story: 'a story',
  brief: 'a brief',
  'direction-sheet': 'a direction sheet',
  'rough-prompt': 'a rough prompt',
  prompt: 'a finished prompt',
}

/** Render a Standing as the paragraph handed to the model via `{{standing}}`. */
export function standingToText(s: Standing): string {
  const lines = [
    `This reads as ${STANDING_KIND_LABEL[s.kind]} (${s.confidence} confidence).`,
    s.evidence.length ? `Evidence: ${s.evidence.join('; ')}.` : '',
    `Has: ${s.has.length ? s.has.join(', ') : 'nothing yet'}.`,
    `Lacks: ${s.lacks.length ? s.lacks.join(', ') : 'nothing — everything above is present'}.`,
    s.stands,
  ]
  return lines.filter(Boolean).join('\n')
}

export function lint(prompt: string, mode: H3Mode): Finding[] {
  const findings: Finding[] = []
  const text = prompt.trim()
  if (!text) return findings

  // ── required fields ─────────────────────────────────────────────────────
  const required = requiredFields(mode)
  const missing = required.filter((f) => fieldValue(text, f) === null)
  findings.push(
    missing.length
      ? {
          id: 'mode/fields',
          severity: 'error',
          title: `${mode} is missing a required field`,
          detail: `The ${mode} structure needs ${required.join(', ')}. Missing: ${missing.join(', ')}.`,
          matches: [],
          metric: `${required.length - missing.length} / ${required.length}`,
        }
      : {
          id: 'mode/fields',
          severity: 'pass',
          title: `Required ${mode} fields present`,
          detail: '',
          matches: [],
          metric: `${required.length} / ${required.length}`,
        },
  )

  // ── the music sentinel ──────────────────────────────────────────────────
  const music = fieldValue(text, 'non_diegetic_music')
  const musicIsNA = music !== null && /^n\/a\.?$/i.test(music.trim())
  const musicIsDenial = music !== null && !musicIsNA && DENIAL.test(music)
  // The sweep below applies whenever music is MEANT to be absent — which
  // includes the denial case, where the field is wrong but the intent is
  // still silence. Gating it on the sentinel alone let a prompt carrying both
  // faults report only one of them.
  const musicShouldBeSilent = musicIsNA || musicIsDenial
  if (musicIsDenial) {
    findings.push({
      id: 'music/sentinel',
      severity: 'error',
      title: 'non_diegetic_music must be exactly N/A',
      detail:
        'Anything that describes the absence of music is a specification of a score with “don’t” in front of it — the model acts on it and returns music. N/A is a null: there is nothing to synthesise.',
      matches: [music.replace(/\s+/g, ' ').trim().slice(0, 220)],
    })
  } else if (musicIsNA) {
    findings.push({ id: 'music/sentinel', severity: 'pass', title: 'Music suppressed with the sentinel', detail: '', matches: [], metric: 'N/A' })
  }

  // ── rhythm vocabulary leaking into a silent film ────────────────────────
  if (musicShouldBeSilent) {
    // Only sweep outside the music field itself, which legitimately says N/A.
    const swept = text.replace(/^[ \t]*non_diegetic_music[ \t]*:?.*$/im, '')
    const hits = findAll(swept, MUSIC_VOCAB)
    findings.push(
      hits.length
        ? {
            id: 'music/vocab-leak',
            severity: 'warn',
            title: 'Rhythm vocabulary in a music-free prompt',
            detail:
              'Setting the field is only half of it. Musical words anywhere in the prompt still hand the model a cue — including the names of your own systems, which it cannot know are not musical.',
            matches: hits.map((h) => h.excerpt),
            metric: `${hits.length} match${hits.length === 1 ? '' : 'es'}`,
          }
        : { id: 'music/vocab-leak', severity: 'pass', title: 'No musical vocabulary elsewhere in the prompt', detail: '', matches: [] },
    )
  }

  // ── silence written as a denial ─────────────────────────────────────────
  const negations = findAll(text, DIALOGUE_NEGATION)
  if (negations.length) {
    findings.push({
      id: 'dialogue/negation',
      severity: 'warn',
      title: 'Silence written as a denial',
      detail:
        'Same failure as music: naming the modality instructs the model to produce it, negation or not. Omit the line, or use the sentinel.',
      matches: negations.map((h) => h.excerpt),
      metric: `${negations.length}`,
    })
  }

  // ── timing ──────────────────────────────────────────────────────────────
  const spans = [...text.matchAll(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*s\b/g)].map((m) => [Number(m[1]), Number(m[2])] as const)
  if (spans.length) {
    const declared = text.match(/\b(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b(?![^\n]*[–—-])/i)
    const end = Math.max(...spans.map((s) => s[1]))
    const gaps: string[] = []
    for (let i = 1; i < spans.length; i++) {
      if (Math.abs(spans[i][0] - spans[i - 1][1]) > 0.001) gaps.push(`${spans[i - 1][1]}s → ${spans[i][0]}s`)
    }
    const target = declared ? Number(declared[1]) : null
    const sumOk = target === null || Math.abs(end - target) < 0.051
    findings.push(
      gaps.length || !sumOk
        ? {
            id: 'timing/sum',
            severity: 'warn',
            title: gaps.length ? 'Cut timings leave a gap or overlap' : 'Cuts do not reach the declared duration',
            detail: gaps.length
              ? `The timeline is not contiguous: ${gaps.join(', ')}.`
              : `Cuts end at ${end}s but the prompt declares ${target}s.`,
            matches: [],
            metric: `${end}s${target ? ` / ${target}s` : ''}`,
          }
        : {
            id: 'timing/sum',
            severity: 'pass',
            title: 'Cut durations are contiguous and reach the declared length',
            detail: '',
            matches: [],
            metric: `${end}s${target ? ` / ${target}s` : ''}`,
          },
    )
  }

  // ── reference labels ────────────────────────────────────────────────────
  const refs = referenceLabels(text)
  if (mode === 'Ref2VA') {
    findings.push(
      refs.length
        ? { id: 'refs/declared', severity: 'pass', title: 'Reference labels present', detail: '', matches: refs, metric: `${refs.length}` }
        : {
            id: 'refs/declared',
            severity: 'warn',
            title: 'Ref2VA with no reference labels',
            detail:
              'Full-reference mode with no <Subject N>, <Picture N>, <Video N> or <Audio N> label means nothing is actually being referenced. Either declare the references or use a base mode.',
            matches: [],
            metric: '0',
          },
    )
  }

  // ── on-screen text budget ───────────────────────────────────────────────
  const quoted = [...text.matchAll(/[“"']([^“”"'\n]{2,120})[”"']/g)].map((m) => m[1])
  const glyphs = quoted.reduce((n, q) => n + q.length, 0)
  if (quoted.length) {
    findings.push(
      glyphs > 120
        ? {
            id: 'text/glyph-budget',
            severity: 'warn',
            title: 'On-screen text is over the glyph budget',
            detail:
              'Long strings of rendered text degrade badly. Decompose the copy across beats — per phrase or per word — so no single frame carries the whole thing.',
            matches: quoted.slice(0, 6),
            metric: `${glyphs} glyphs`,
          }
        : { id: 'text/glyph-budget', severity: 'pass', title: 'On-screen text inside the glyph budget', detail: '', matches: [], metric: `${glyphs} glyphs` },
    )
  }

  // ── soundscape concreteness ─────────────────────────────────────────────
  const sound = fieldValue(text, 'overall_soundscape')
  if (sound) {
    const timed = (sound.match(/\d+(?:\.\d+)?\s*s\b/g) || []).length
    const clauses = sound.split(/[,;]/).length
    findings.push(
      timed > 0 || clauses >= 3
        ? {
            id: 'audio/concrete',
            severity: 'pass',
            title: 'Soundscape names concrete sources',
            detail: '',
            matches: [],
            metric: timed ? `${timed} placed in time` : `${clauses} elements`,
          }
        : {
            id: 'audio/concrete',
            severity: 'warn',
            title: 'Soundscape describes a mood, not sources',
            detail: 'Name what makes the sound and when. A mood gives the model nothing to synthesise and it will invent something generic.',
            matches: [sound.replace(/\s+/g, ' ').slice(0, 180)],
          },
    )
  }

  const rank: Record<Finding['severity'], number> = { error: 0, warn: 1, pass: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

export function summarise(findings: Finding[]) {
  return {
    error: findings.filter((f) => f.severity === 'error').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    pass: findings.filter((f) => f.severity === 'pass').length,
  }
}

/** The actionable findings handed to a prompt replacement operation. */
export function findingsToText(findings: Finding[]): string {
  const actionable = findings.filter((f) => f.severity !== 'pass')
  if (!actionable.length) return '(the deterministic check found nothing)'
  return actionable
    .map((f, i) => {
      const quotes = f.matches.length ? `\n   quoting: ${f.matches.map((m) => `"${m}"`).join(', ')}` : ''
      return `${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n   ${f.detail}${quotes}`
    })
    .join('\n')
}
