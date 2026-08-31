/**
 * Structural parsing of a prompt for display.
 *
 * The prompt is whatever the model wrote, not a format we control, so every
 * rule here degrades to plain text rather than swallowing content it does not
 * recognise.
 */

export interface Section {
  /** null for anything before the first named section. */
  name: string | null
  body: string
}

/** Section names both H3 formats use, in the order the guides specify. */
export const KNOWN_SECTIONS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'integrated_multimodal_description',
  'overall_soundscape',
  'non_diegetic_music',
]

// A section header is a snake_case name at column 0 followed by a colon.
const HEADER = /^([a-z][a-z0-9_]{3,})[ \t]*:[ \t]*(.*)$/

export function splitSections(text: string): Section[] {
  const lines = text.split('\n')
  const sections: Section[] = []
  let current: Section | null = null
  const preamble: string[] = []

  for (const line of lines) {
    const m = line.match(HEADER)
    if (m) {
      if (current) sections.push(current)
      current = { name: m[1], body: m[2] ? `${m[2]}\n` : '' }
    } else if (current) {
      current.body += `${line}\n`
    } else {
      preamble.push(line)
    }
  }
  if (current) sections.push(current)

  const head = preamble.join('\n').trim()
  const out: Section[] = head ? [{ name: null, body: head }] : []
  for (const s of sections) out.push({ name: s.name, body: s.body.replace(/\n+$/, '') })

  // Nothing recognised — hand back the whole thing rather than an empty render.
  return out.length ? out : [{ name: null, body: text }]
}

export type TokenKind = 'subject' | 'picture' | 'video' | 'audio' | 'shot' | 'time' | 'dialogue' | 'na' | 'ref'

export interface Token {
  kind: TokenKind
  text: string
}

export const TOKEN_LABEL: Record<TokenKind, string> = {
  subject: 'Subject',
  picture: 'Picture',
  video: 'Video',
  audio: 'Audio',
  shot: 'Shot',
  time: 'Timecode',
  dialogue: 'Dialogue',
  na: 'Sentinel',
  ref: 'Label',
}

// One pass, alternation ordered longest-first so a wider match wins.
const INLINE = new RegExp(
  [
    '(?<dialogue><d>[\\s\\S]*?<\\/d>)',
    '(?<subject><\\s*Subject\\s+\\d+\\s*>)',
    '(?<picture><\\s*Picture\\s+\\d+\\s*>)',
    '(?<video><\\s*Video\\s+\\d+\\s*>)',
    '(?<audio><\\s*Audio\\s+\\d+\\s*>)',
    '(?<shot>\\[\\s*Shot\\s+\\d+\\s*\\])',
    '(?<time>\\d{2}:\\d{2}\\.\\d{3}(?:\\s*(?:to|[–—-])\\s*\\d{2}:\\d{2}\\.\\d{3})?|\\d+(?:\\.\\d+)?\\s*[–—-]\\s*\\d+(?:\\.\\d+)?\\s*s\\b|\\b\\d+(?:\\.\\d+)?\\s*s\\b)',
    '(?<na>\\bN\\/A\\b)',
    '(?<ref>@[a-z0-9_]+)',
  ].join('|'),
  'gi',
)

export function tokenize(text: string): (string | Token)[] {
  const out: (string | Token)[] = []
  let last = 0
  let m: RegExpExecArray | null
  const rx = new RegExp(INLINE.source, INLINE.flags)

  while ((m = rx.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const groups = m.groups || {}
    const kind = (Object.keys(groups).find((k) => groups[k] !== undefined) || 'ref') as TokenKind
    out.push({ kind, text: m[0] })
    last = m.index + m[0].length
    if (m[0].length === 0) rx.lastIndex++ // never spin on a zero-width match
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Which kinds actually appear, so the legend only shows what is on screen. */
export function kindsPresent(text: string): TokenKind[] {
  const seen = new Set<TokenKind>()
  for (const t of tokenize(text)) if (typeof t !== 'string') seen.add(t.kind)
  const order: TokenKind[] = ['subject', 'picture', 'video', 'audio', 'shot', 'dialogue', 'time', 'ref', 'na']
  return order.filter((k) => seen.has(k))
}
