import type { Finding, H3Mode } from './types'

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

/**
 * Is this text already a prompt rather than a story? Used to decide whether a
 * pasted source can be critiqued directly instead of being directed first.
 */
export function looksLikePrompt(text: string): boolean {
  return /(^|\n)[ \t]*(integrated_multimodal_description|overall_soundscape|non_diegetic_music|detailed_description|retention_analysis|subject_definitions)[ \t]*:/i.test(
    text,
  )
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

/** The text handed to the REVISE stage. Passes are omitted — they are not work. */
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
