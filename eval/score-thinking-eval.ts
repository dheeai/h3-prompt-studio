import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lint } from '../src/lib/lint'
import { parseBreakdown, splitHandoff, splitPromptReplacement } from '../src/lib/stages'
import { estTokens } from '../src/lib/tokens'
import { EVAL_CASES, EVAL_MODELS } from './cases'
import type { RawEvalRecord, ThinkingEvalCase } from './types'

export interface DeterministicFinding {
  id: string
  passed: boolean
  detail: string
}

export interface ScoreResult {
  passed: boolean
  findings: DeterministicFinding[]
}

interface SummaryRow {
  caseId: string
  family: string
  stage: string
  model: string
  thinking: boolean
  contentTokens: number
  reasoningTokens: number
  reportedCompletionTokens: number | null
  latencyMs: number
  ttftMs: number | null
  finishReason: string | null
  contractPass: boolean
  errors: string[]
  validatorFindings: DeterministicFinding[]
  pairedOnOffPassDelta: number | null
  pairedOnOffContentTokenDelta: number | null
  pairedOnOffReasoningTokenDelta: number | null
  pairedOnOffLatencyDeltaMs: number | null
  pairedOnOffTtftDeltaMs: number | null
}

const REF_FIELDS = [
  'subject_definitions',
  'summary',
  'retention_analysis',
  'detailed_description',
  'overall_soundscape',
  'non_diegetic_music',
] as const
const BASE_FIELDS = ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'] as const
const STAGE_HEADERS = [
  'WHERE THE SOURCE STANDS',
  'WHAT THE BRIEF FIXES',
  'DIRECTION SHEET',
  '<<<PROMPT>>>',
  '<<<EXPLANATION>>>',
  '<<<PRECEDES>>>',
  '<<<FOLLOWS>>>',
  '<<<OPEN>>>',
]

function finding(id: string, passed: boolean, detail: string): DeterministicFinding {
  return { id, passed, detail: passed ? detail : `FAIL: ${detail}` }
}

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function hasEvery(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text))
}

function hasUnnegatedMatch(text: string, pattern: RegExp): boolean {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const globalPattern = new RegExp(pattern.source, flags)
  for (const match of text.matchAll(globalPattern)) {
    const index = match.index ?? 0
    const prefix = text.slice(Math.max(0, index - 72), index)
    if (!/\b(?:without|not|no|never|does\s+not|do\s+not|did\s+not|doesn't|don't|didn't|avoid(?:s|ed|ing)?)\s+(?:\w+[\s,'’-]*){0,3}$/i.test(prefix)) return true
  }
  return false
}

function fieldValue(text: string, field: string): string {
  const start = new RegExp(`^[ \\t]*${field}[ \\t]*:?[ \\t]*`, 'im').exec(text)
  if (!start) return ''
  const rest = text.slice(start.index + start[0].length)
  const next = rest.search(/\n[ \t]*[a-z_][a-z0-9_]*[ \t]*:/i)
  return rest.slice(0, next < 0 ? undefined : next).trim()
}

function canonicalFields(text: string): string[] {
  const fields: string[] = []
  for (const match of text.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gim)) {
    const name = match[1]
    // Preserve every occurrence. A duplicate canonical field is ambiguous to
    // the downstream H3 parser and must not be normalized away by the scorer.
    if ([...REF_FIELDS, ...BASE_FIELDS].includes(name as never)) fields.push(name)
  }
  return fields
}

function expectedFields(testCase: ThinkingEvalCase): readonly string[] {
  return testCase.h3Mode === 'Ref2VA' ? REF_FIELDS : BASE_FIELDS
}

function requiredH3Fields(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const required = expectedFields(testCase)
  const missing = required.filter((field) => !fieldValue(text, field))
  const actual = canonicalFields(text)
  const duplicates = required.filter((field) => actual.filter((candidate) => candidate === field).length > 1)
  const lintRequired = lint(text, testCase.h3Mode).find((item) => item.id === 'mode/fields')
  const passed = missing.length === 0 && duplicates.length === 0 && lintRequired?.severity !== 'error'
  return finding(
    'required-h3-fields',
    passed,
    passed ? `${required.length} required ${testCase.h3Mode} fields are non-empty and unique` : `missing, empty, or duplicate fields: ${[...missing, ...duplicates.map((field) => `${field} (duplicate)`)].join(', ') || lintRequired?.detail || 'unknown'}`,
  )
}

function h3FieldOrder(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const required = [...expectedFields(testCase)]
  const actual = canonicalFields(text)
  const passed = JSON.stringify(actual) === JSON.stringify(required)
  return finding('h3-field-order', passed, passed ? required.join(' → ') : `expected ${required.join(' → ')}, got ${actual.join(' → ') || '(none)'}`)
}

function strictBreakdown(text: string): ReturnType<typeof parseBreakdown> {
  const visible = text.trim()
  // The breakdown stage is consumed as a machine document. Unlike the
  // forgiving UI parser, the eval must not silently strip prose or fences.
  if (!visible.startsWith('{') || !visible.endsWith('}')) return null
  const parsed = parseBreakdown(text)
  if (!parsed) return null
  let raw: unknown
  try {
    raw = JSON.parse(visible)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { clips?: unknown }).clips)) return null
  const clips = (raw as { clips: unknown[] }).clips
  const validRoles = new Set(['opening', 'rising', 'turn', 'falling', 'closing', 'standalone'])
  const valid = typeof (raw as { spine?: unknown }).spine === 'string' && !!(raw as { spine: string }).spine.trim() &&
    clips.every((item) => {
      if (!item || typeof item !== 'object') return false
      const clip = item as Record<string, unknown>
      return typeof clip.index === 'number' && Number.isInteger(clip.index) &&
        typeof clip.title === 'string' && !!clip.title.trim() &&
        typeof clip.role === 'string' && validRoles.has(clip.role) &&
        typeof clip.seconds === 'number' && Number.isFinite(clip.seconds) && clip.seconds > 0 &&
        typeof clip.covers === 'string' && !!clip.covers.trim() &&
        typeof clip.precedes === 'string' &&
        typeof clip.follows === 'string'
    })
  if (!valid) return null
  for (let index = 0; index < clips.length; index++) {
    const clip = clips[index] as Record<string, unknown>
    if (clip.index !== index + 1) return null
  }
  if (clips.length === 3 && clips.some((item) => (item as Record<string, unknown>).role === 'standalone')) return null
  if (clips.length === 3 && JSON.stringify(clips.map((item) => (item as Record<string, unknown>).role)) !== JSON.stringify(['opening', 'rising', 'closing'])) return null
  return parsed
}

function replacementBlocks(text: string): DeterministicFinding {
  const markers = [...text.matchAll(/<<<[^>\n]+>>>/g)].map((match) => match[0])
  const parsed = splitPromptReplacement(text)
  const passed =
    markers.length === 2 &&
    markers[0] === '<<<PROMPT>>>' &&
    markers[1] === '<<<EXPLANATION>>>' &&
    !!parsed?.prompt.trim() &&
    !!parsed.explanation.trim()
  return finding('prompt-replacement-blocks', passed, passed ? 'exactly one non-empty PROMPT block precedes one EXPLANATION block' : 'expected exactly PROMPT then EXPLANATION, with both blocks non-empty and no CHANGES block')
}

function handoffBlocks(text: string): DeterministicFinding {
  const handoff = splitHandoff(text)
  const markers = [...text.matchAll(/<<<[^>\n]+>>>/g)].map((match) => match[0])
  const passed =
    markers.length === 3 &&
    JSON.stringify(markers) === JSON.stringify(['<<<PRECEDES>>>', '<<<FOLLOWS>>>', '<<<OPEN>>>']) &&
    !!handoff.precedes.trim() &&
    !!handoff.follows.trim() &&
    !!handoff.open.trim()
  return finding('handoff-blocks', passed, passed ? 'PRECEDES, FOLLOWS, and OPEN are present and non-empty' : 'handoff requires exactly three non-empty PRECEDES, FOLLOWS, and OPEN blocks')
}

function directionSheetContract(text: string): DeterministicFinding {
  const fields = canonicalFields(text)
  const lower = normalized(text)
  const hasSections = lower.includes('where the source stands') && lower.includes('what the brief fixes') && lower.includes('direction sheet')
  const passed = hasSections && fields.length === 0
  return finding('direction-sheet-contract', passed, passed ? 'direct output is a direction sheet without H3 prompt fields' : fields.length ? `direct output improperly emitted H3 prompt fields: ${fields.join(', ')}` : 'direct output must include the direction-sheet contract sections')
}

function expectedDuration(testCase: ThinkingEvalCase): number | null {
  // Prompt fixtures carry their duration only in timecode ranges inside the
  // current canonical prompt. Do not mistake the first range's right-hand
  // endpoint (2.5 seconds) for the clip's total length (7 seconds).
  if (testCase.family === 'prompt') {
    const currentSpans = timeSpans(testCase.current)
    return currentSpans.length ? currentSpans[currentSpans.length - 1][1] : null
  }
  const source = `${testCase.story}\n${testCase.current}`
  const match = source.match(/\b(?:of |for )?(\d+(?:\.\d+)?)\s*(?:-second|seconds?|secs?|sec)\b/i)
  return match ? Number(match[1]) : null
}

function timeSpans(text: string): [number, number][] {
  return [...text.matchAll(/(\d+(?:\.\d+)?)\s*[–—-]\s*(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?\b/gi)]
    .map((match) => [Number(match[1]), Number(match[2])] as [number, number])
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end >= start)
}

function clipDuration(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id === 'scene-breakdown') {
    const breakdown = strictBreakdown(text)
    const passed = !!breakdown && breakdown.clips.length === 3 && breakdown.clips.every((clip) => clip.seconds === 3)
    return finding('clip-duration', passed, passed ? 'three clips are exactly 3 seconds each' : 'scene breakdown must contain exactly three 3-second clips')
  }

  const target = expectedDuration(testCase)
  if (target === null) return finding('clip-duration', true, 'no duration is declared by this fixture')
  const spans = timeSpans(text)
  // Exclude the right-hand number of a timecode range (e.g. "0.0–2.5
  // seconds") from the declared clip-length check. A wrong explicit length
  // such as "6 seconds" still remains visible because it is not range-bound.
  const declared = text.match(/(?<![\d.])(?<![–—-])\b(\d+(?:\.\d+)?)\s*(?:-second|seconds?|secs?|sec)\b/i)
  const declaredSeconds = declared ? Number(declared[1]) : null
  const end = spans.length ? spans[spans.length - 1][1] : null
  const contiguous = spans.every((span, index) => index === 0 || Math.abs(span[0] - spans[index - 1][1]) < 0.051)
  const requiresTimeline = testCase.id === 'clip-t2va-draft-from-direction-sheet'
  const startsAtZero = spans.length > 0 && Math.abs(spans[0][0]) < 0.051
  const passed = (declaredSeconds === null || Math.abs(declaredSeconds - target) < 0.051) &&
    (end === null || Math.abs(end - target) < 0.051) && contiguous &&
    (!requiresTimeline || (spans.length >= 2 && startsAtZero && end !== null && Math.abs(end - target) < 0.051))
  return finding('clip-duration', passed, passed ? `timing fits the fixture's ${target}-second constraint` : `expected ${target} seconds, got declared ${declaredSeconds ?? 'none'} and timeline end ${end ?? 'none'}`)
}

function t2vaSourceContract(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'clip-t2va-draft-from-direction-sheet') return finding('t2va-source-contract', true, 'not applicable to this fixture')
  const lower = normalized(text)
  const hasReferencePlaceholder = /<\s*(?:subject|reference|ref|image|object|character)\b[^>]*>|\{\{\s*(?:subject|reference|ref|image|object|character)\b[^}]*\}\}|\[\s*(?:subject|reference|ref|image|object|character)[ _-]?\d*\s*\]|\b(?:subject|reference|ref|image)[_-]\d+\b/i.test(text)
  const hasReferenceDependency = hasUnnegatedMatch(lower, /\b(?:reference[- ]image|reference frame|source image|input image|image[- ]to[- ]video|img2img|i2v|provided image|input frame|reference asset|source plate|input plate)\b/i) ||
    hasUnnegatedMatch(lower, /\b(?:use|uses|using|from|match|matches|preserve|preserves|follow|follows|depend(?:s|ing)?|require(?:s|d)?)\s+(?:the\s+)?(?:provided\s+)?(?:reference|source|input)\s+(?:image|frame|asset|plate|video)\b/i)

  const beatMarkers = [...text.matchAll(/(?:\[\s*)?\d+(?:\.\d+)?\s*[–—-]\s*\d+(?:\.\d+)?\s*seconds?\s*(?:\]\s*|:\s*)/gi)]
  const lastBeat = beatMarkers.length
    ? text.slice((beatMarkers.at(-1)?.index ?? 0) + (beatMarkers.at(-1)?.[0].length ?? 0))
    : text
  const finalHasCoin = /\bcoin\b/i.test(lastBeat)
  const finalHasClosedFist = /\b(?:closed|clenched)\s+fist\b/i.test(lastBeat)
  const finalConcealsCoin = /\b(?:coin|it)\b[^.\n]{0,100}\b(?:hidden|concealed|invisible|unseen|remains?\s+(?:inside|concealed|hidden)|stays?\s+(?:inside|hidden)|not\s+visible)\b/i.test(lastBeat) ||
    /\b(?:coin|it)\b[^.\n]{0,100}\b(?:remains?|stays?)\s+(?:inside|in)\s+(?:the\s+)?(?:(?:magician['’]s)\s+)?(?:closed|clenched)\s+fist\b/i.test(lastBeat) ||
    /\b(?:closed|clenched)\s+fist\b[^.\n]{0,100}\b(?:retain(?:s|ed)?|contain(?:s|ed)?|hold(?:s|ing)?)\s+(?:the\s+)?coin\b/i.test(lastBeat) ||
    /\b(?:hidden|concealed|invisible|unseen)\b[^.\n]{0,100}\b(?:coin|closed\s+fist)\b/i.test(lastBeat)
  const finalRevealsCoin = /\b(?:coin|it)\b[^.\n]{0,100}\b(?:visible|revealed|shown|exposed|disclosed|appears?)\b|\b(?:reveal(?:s|ed|ing)?|show(?:s|ed|ing)?|expos(?:es|ed|ing)?)\s+(?:the\s+)?coin\b/i.test(lastBeat)
  const childConvinced = hasUnnegatedMatch(lower, /\b(?:convinced|assured|satisfied|accepts?|trusts?|no longer skeptical)\b/i)
  const finalKeepsSkeptical = /\b(?:child|skeptic(?:al)?)\b[^.\n]{0,100}\b(?:remains?|stays?|keeps?)\s+(?:skeptic(?:al)?|doubtful|unconvinced)\b/i.test(lastBeat)
  const passed = !hasReferencePlaceholder && !hasReferenceDependency && finalHasCoin && finalHasClosedFist && finalConcealsCoin && !finalRevealsCoin && !childConvinced && finalKeepsSkeptical
  return finding('t2va-source-contract', passed, passed
    ? 'T2VA uses no reference dependency, preserves the skeptical child state, and ends with the coin concealed in the closed fist'
    : 'T2VA must stay text-only, keep the child skeptical through the final beat, and end with the coin concealed—not visible or revealed—in the closed fist')
}

function orderedBreakdownActions(text: string): DeterministicFinding {
  const breakdown = strictBreakdown(text)
  if (!breakdown || breakdown.clips.length !== 3) return finding('ordered-actions', false, 'cannot verify action order without a strict three-clip breakdown')
  const covers = breakdown.clips.map((clip) => normalized(clip.covers))
  const passed =
    /cross|crosses|crossing/.test(covers[0]) &&
    /lantern/.test(covers[0]) &&
    /train/.test(covers[1]) &&
    /find|finds|drawing|unfold/.test(covers[1]) &&
    /leave|leaves|lit/.test(covers[2]) &&
    /drawing/.test(covers[2])
  return finding('ordered-actions', passed, passed ? 'crossing, listening/finding, and lantern placement are in causal order' : 'three clips must move from crossing, through the absent train/drawing discovery, to the final lit lantern placement')
}

function stateTokens(value: string): Set<string> {
  const stop = new Set(['the', 'and', 'with', 'from', 'this', 'that', 'while', 'into', 'beside', 'next', 'clip', 'must', 'open', 'able', 'having', 'just', 'seen'])
  return new Set(normalized(value).match(/[a-z]{4,}/g)?.filter((token) => !stop.has(token)) ?? [])
}

function semanticAdjacency(left: string, right: string): boolean {
  const leftTokens = stateTokens(left)
  const rightTokens = stateTokens(right)
  const overlap = [...leftTokens].filter((token) => rightTokens.has(token))
  return overlap.length >= 2
}

function neighboringStates(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id === 'scene-breakdown') {
    const breakdown = strictBreakdown(text)
    const passed = !!breakdown && breakdown.clips.every((clip, index) => {
      if (clip.index !== index + 1) return false
      if (index === 0 && clip.precedes.trim()) return false
      if (index > 0 && !clip.precedes.trim()) return false
      if (index < breakdown.clips.length - 1 && !clip.follows.trim()) return false
      if (index > 0 && !semanticAdjacency(breakdown.clips[index - 1].follows, clip.precedes)) return false
      return true
    })
    return finding('neighboring-states', passed, passed ? 'every clip boundary has an explicit handoff state' : 'each adjacent breakdown boundary needs non-empty precedes and follows fields')
  }

  if (testCase.id === 'scene-middle-closing-direction') {
    const lower = normalized(text)
    const passed =
      lower.includes('where the source stands') &&
      lower.includes('what the brief fixes') &&
      hasEvery(lower, [/maya/, /drawing/, /unlit|found/, /platform/]) &&
      hasEvery(lower, [/carries|carry|end of the platform/, /lit|lantern/])
    return finding('neighboring-states', passed, passed ? 'the established opening and next handoff are acknowledged' : 'direction sheet must state the inherited platform/drawing state and the next lantern handoff')
  }

  if (testCase.id === 'continuation-planning' || testCase.id === 'continuation-prompt-authoring') {
    const lower = normalized(text)
    const passed = hasEvery(lower, [/lantern/, /drawing/, /flame/, /absent|remains/])
    return finding('neighboring-states', passed, passed ? 'continuation retains the inherited objects and unresolved train state' : 'continuation must carry the lantern, drawing, flame, and absent-train state')
  }

  return finding('neighboring-states', true, 'not applicable to this standalone fixture')
}

function continuityOpening(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (!testCase.id.startsWith('continuation-')) return finding('continuity-opening', true, 'not applicable to this fixture')
  const lower = normalized(text)
  const passed = hasEvery(lower, [/flame/, /wind/, /lantern/, /drawing/]) &&
    (testCase.id === 'continuation-planning' ? hasEvery(lower, [/precedes/, /follows/, /open/]) : hasEvery(lower, [/walks? away|recedes|away/, /visible/, /absent|remains/]))
  return finding('continuity-opening', passed, passed ? 'the next clip opens from the inherited flame state' : 'continuation must open on the bending flame and preserve the visible lantern/drawing state')
}

function reestablishesPriorAction(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (!testCase.id.startsWith('continuation-') && testCase.id !== 'scene-middle-closing-direction') {
    return finding('continuity-reestablishment', true, 'not applicable to this fixture')
  }
  const lower = normalized(text)
  const repeatedPlacement = hasUnnegatedMatch(lower, /(?:place|places|placed|placing|set|sets|setting|leave|leaves|leaving)\s+(?:the\s+)?(?:red\s+)?(?:paper\s+)?lantern\s+(?:beside|next to|by|on)/i)
  const newPlatformEstablishment = hasUnnegatedMatch(lower, /(?:establish|establishes|establishing|introduce|introduces|enter|enters|entering)\b[^.\n]{0,80}\b(?:platform|railway)/i)
  const repeatedDrawingDiscovery = [
    /\b(?:re-?find|re-?discover|re-?see|rediscover(?:s|ed|ing)?)\b[^.\n]{0,80}\bdrawing\b/i,
    /\b(?:find|finds|found|finding|discover|discovers|discovered|discovering|see|sees|saw|seeing|spot|spots|spotted|notice|notices|noticed)\b[^.\n]{0,80}\bdrawing\b[^.\n]{0,24}\b(?:again|anew|once more)\b/i,
    /\b(?:again|anew|once more)\b[^.\n]{0,40}\b(?:find|discover|see|spot|notice)\w*\b[^.\n]{0,80}\bdrawing\b/i,
  ].some((pattern) => hasUnnegatedMatch(lower, pattern))
  const passed = !repeatedPlacement && !newPlatformEstablishment && !repeatedDrawingDiscovery
  return finding('continuity-reestablishment', passed, passed ? 'prior placement, drawing discovery, and established setting are not replayed' : 'the response re-establishes the prior lantern placement, drawing discovery, or platform')
}

function prematureResolution(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const lower = normalized(text)
  if (testCase.id === 'scene-middle-closing-direction' || testCase.id.startsWith('continuation-')) {
    const passed = !/(?:train\s+(?:arrives?|pulls?\s+in|finally\s+comes?))|(?:resolv(?:es|ed|ing)\s+(?:the\s+)?(?:absent\s+)?train)/i.test(lower)
    return finding('no-premature-resolution', passed, passed ? 'the absent train remains unresolved' : 'the response prematurely resolves the absent train')
  }
  if (testCase.id === 'clip-direction-acting-heavy-two-hander') {
    const passed = !/(?:reconcil|forgive|happy ending|father returns?|everyone leaves together)/i.test(lower)
    return finding('no-premature-resolution', passed, passed ? 'the two-hander keeps its constrained ending' : 'the response adds a resolution outside the requested coat action')
  }
  return finding('no-premature-resolution', true, 'not applicable to this fixture')
}

function fixedFacts(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const lower = normalized(text)
  const requirements: Record<string, RegExp[]> = {
    'scene-breakdown': [/maya/, /lantern/, /drawing/, /train/, /dawn/],
    'scene-middle-closing-direction': [/maya/, /drawing/, /lantern/, /train/, /platform/],
    'clip-direction-acting-heavy-two-hander': [/sisters?/, /kitchen/, /blue coat/, /funeral/, /you only want it because he forgave you/],
    'clip-t2va-draft-from-direction-sheet': [/magician/, /child/, /coin/, /skeptic/, /closed fist/],
    'prompt-revise': [/woman/, /greenhouse/, /night/, /moth/, /wrist/, /latch/],
    'prompt-rebuild': [/woman/, /greenhouse/, /night/, /moth/, /wrist/, /latch/],
    'continuation-planning': [/lantern/, /drawing/, /flame/, /wind/, /train/],
    'continuation-prompt-authoring': [/lantern/, /drawing/, /flame/, /walk/, /train/],
  }
  const needed = requirements[testCase.id] ?? []
  const passed = hasEvery(lower, needed)
  return finding('fixed-facts', passed, passed ? 'fixture subjects, action, objects, and unresolved facts are retained' : `missing fixed facts: ${needed.filter((pattern) => !pattern.test(lower)).map(String).join(', ')}`)
}

function verbatimDialogue(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'clip-direction-acting-heavy-two-hander') return finding('verbatim-dialogue', true, 'not applicable to this fixture')
  const quote = 'You only want it because he forgave you.'
  const passed = normalized(text).includes(normalized(quote))
  return finding('verbatim-dialogue', passed, passed ? 'the required older-sister dialogue is verbatim' : `required verbatim dialogue is missing or changed: ${quote}`)
}

function actingSpecificity(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'clip-direction-acting-heavy-two-hander') return finding('dialogue-acting', true, 'not applicable to this fixture')
  const lower = normalized(text)
  const passed = hasEvery(lower, [/older sister|older/, /younger sister|younger/, /takes?|take/, /sets?|set|puts?\s+it\s+back/, /cannot|can't|unable/])
  return finding('dialogue-acting', passed, passed ? 'both performers have observable physical actions and the constrained coat beat' : 'two-hander output must specify observable older/younger performances and the coat action')
}

function twoHanderContract(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'clip-direction-acting-heavy-two-hander') return finding('two-hander-contract', true, 'not applicable to this fixture')
  const lower = normalized(text)
  const oneShot = /\bone\s+continuous\s+7[- ]second\s+shot\b|\bsingle\s+continuous\s+7[- ]second\s+shot\b/i.test(lower)
  const hasCut = /\b(?:cut\s+to|cutaway|multiple\s+shots?|multi[- ]shot|shot\s+[2-9]|then\s+cut)\b/i.test(lower)
  const addedCharacter = /\b(?:third|another|additional)\s+(?:character|person|performer|sister|woman|man|child)\b|\b(?:mother|waiter|friend|child)\s+(?:enters?|appears?|joins?)\b/i.test(lower)
  const passed = oneShot && !hasCut && !addedCharacter
  return finding('two-hander-contract', passed, passed ? 'one continuous 7-second shot contains only the two sisters' : 'two-hander must be one continuous 7-second shot with no cuts, multi-shot structure, or added characters')
}

function promptInventedEvents(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'prompt-revise' && testCase.id !== 'prompt-rebuild') return finding('prompt-invented-events', true, 'not applicable to this fixture')
  const lower = normalized(text)
  const invented = /\b(?:the\s+)?woman\s+(?:leaves?|walks?\s+away|enters?|speaks?|says?)\b|\bthe\s+moth\s+(?:flies?|leaves?|takes?\s+off)\b|\b(?:the\s+)?door\s+(?:closes?|slams?|locks?)\b/i.test(lower)
  const endingLines = [...lower.matchAll(/\b(?:end|ends|ending|concludes?|finally)\b[^.\n]{0,100}/gi)].map((match) => match[0])
  const badEnding = endingLines.some((line) => !/latch|hand/.test(line))
  const passed = !invented && !badEnding
  return finding('prompt-invented-events', passed, passed ? 'greenhouse prompt contains no event or ending outside the requested latch beat' : 'greenhouse replacement invents an event or resolves the scene away from the hand turning the latch')
}

function rebuildMaterialChange(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'prompt-rebuild') return finding('material-rebuild', true, 'not applicable to this fixture')
  const replacement = splitPromptReplacement(text)
  if (!replacement) return finding('material-rebuild', false, 'rebuild has no parsed replacement prompt')
  const compact = (value: string) => normalized(value).replace(/[^a-z0-9]+/g, '')
  const changed = compact(replacement.prompt) !== compact(testCase.current)
  const craftCategories = [
    { label: 'camera', terms: ['camera', 'framing', 'shot', 'lens', 'dolly', 'close-up', 'wide', 'medium', 'tracking', 'handheld'] },
    { label: 'blocking', terms: ['blocking', 'position', 'eyeline', 'hand', 'hands', 'fingers', 'shoulders', 'handle'] },
    { label: 'acting', terms: ['gaze', 'breath', 'reaction', 'performance', 'gesture', 'pause', 'eyes', 'fingers', 'shoulders', 'stop'] },
    { label: 'light', terms: ['light', 'lighting', 'palette', 'texture', 'shadow', 'cool', 'dark'] },
    { label: 'sound', terms: ['sound', 'soundscape', 'creak', 'click', 'insects', 'breath'] },
  ] as const
  const categorySignature = (value: string, terms: readonly string[]) => {
    const words = new Set(value.toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? [])
    return terms.filter((term) => words.has(term)).join('|')
  }
  const changedCategories = craftCategories.filter((category) => categorySignature(replacement.prompt, category.terms) !== categorySignature(testCase.current, category.terms))
  const actingChanged = changedCategories.some((category) => category.label === 'acting')
  const directingChanged = changedCategories.some((category) => ['camera', 'blocking', 'light', 'sound'].includes(category.label))
  const words = (value: string) => new Set(value.toLowerCase().match(/[a-z]+(?:-[a-z]+)?/g) ?? [])
  const replacementWords = words(replacement.prompt)
  const currentWords = words(testCase.current)
  const changedWordCount = new Set([...replacementWords, ...currentWords]).size - [...replacementWords].filter((word) => currentWords.has(word)).length
  // Category signatures alone can mistake a synonym (for example
  // fingers→hands) for a directing/acting rethink. Require a visible lexical
  // delta large enough to represent a structural beat or camera rewrite.
  const substantialRethink = changedWordCount >= 8
  const passed = changed && changedCategories.length >= 2 && actingChanged && directingChanged && substantialRethink
  return finding('material-rebuild', passed, passed ? `rebuild changed the prompt and rethought ${changedCategories.map((category) => category.label).join(', ')} (${changedWordCount} changed words)` : 'rebuild must materially change more than punctuation/whitespace or synonyms and rethink both directing and observable acting')
}

const CONCRETE_SOUND_SOURCE = /\b(?:rain|footsteps?|traffic|door|wind|engine|birds?|breath|clatter|hum|bell|water|thunder|clock|ticking|creak|rustle|scrape|whistle|horn|radio|glass|metal|paper|fabric|foley|coin|hinge|insects?)\b/i

function noDialoguePrompt(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id !== 'prompt-revise' && testCase.id !== 'prompt-rebuild') return finding('no-dialogue', true, 'not applicable to this fixture')
  const replacement = splitPromptReplacement(text)
  const prompt = replacement?.prompt ?? ''
  const forbidden = [
    /\b(?:dialogue|speech|conversation|verbal)\b/i,
    /\b(?:voice|voices)\b/i,
    /\b(?:say|says|said|speak|speaks|spoke|speaking|whisper|whispers|whispered|whispering|talk|talks|talked|talking)\b/i,
  ]
  const violations = forbidden.filter((pattern) => hasUnnegatedMatch(prompt, pattern))
  const passed = !!prompt.trim() && violations.length === 0
  return finding('no-dialogue', passed, passed ? 'parsed replacement prompt remains silent' : 'parsed replacement prompt must not add dialogue, speech, voices, or spoken action')
}

function soundAndMusic(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.stage === 'breakdown' || testCase.stage === 'handoff') return finding('sound-music', true, 'not applicable to a planning-only contract')
  const lower = normalized(text)
  const sound = fieldValue(text, 'overall_soundscape')
  const music = fieldValue(text, 'non_diegetic_music')
  const soundSources = CONCRETE_SOUND_SOURCE.test(sound)
  const directSoundSection = lower.match(/(?:sound anchors?|sound design)\s*:\s*([^\n]*)/i)?.[1] ?? ''
  const soundText = testCase.stage === 'direct' ? directSoundSection : sound
  const voiceCue = /\b(?:voice|voices|dialogue|speech|words|speak|talk|conversation|says?)\b/i.test(soundText)
  const silentCase = new Set(['clip-t2va-draft-from-direction-sheet', 'prompt-revise', 'prompt-rebuild', 'continuation-prompt-authoring']).has(testCase.id)
  const musicValid = silentCase ? /^n\/a\.?$/i.test(music) : (!!music || testCase.stage === 'direct')
  const directionSound = testCase.stage === 'direct' && !testCase.id.startsWith('continuation-')
    ? (!voiceCue && CONCRETE_SOUND_SOURCE.test(directSoundSection))
    : true
  const passed = testCase.stage === 'draft' || testCase.stage === 'revise' || testCase.stage === 'rebuild'
    ? !!sound && soundSources && !voiceCue && musicValid
    : directionSound
  return finding('sound-music', passed, passed ? 'sound uses concrete sources and music is represented safely' : 'soundscape must name concrete sources and non-diegetic music must use a safe sentinel or explicit score')
}

function protocolFindings(testCase: ThinkingEvalCase, record: RawEvalRecord): DeterministicFinding[] {
  const body = record.request?.body ?? {}
  const bodyKwargs = body.chat_template_kwargs
  const bodyArm = bodyKwargs && typeof bodyKwargs === 'object' && !Array.isArray(bodyKwargs)
    ? (bodyKwargs as { enable_thinking?: unknown }).enable_thinking
    : undefined
  const arm = record.chatTemplateKwargs?.enable_thinking
  return [
    finding('request-count', record.response?.requestCount === 1, `requestCount=${record.response?.requestCount ?? 'missing'}; expected 1`),
    finding('continuations', record.response?.continuations === 0, `continuations=${record.response?.continuations ?? 'missing'}; expected 0`),
    finding('transport-errors', !record.errors?.length, record.errors?.length ? record.errors.join(' | ') : 'no HTTP or network error recorded'),
    finding('thinking-arm', typeof bodyArm === 'boolean' && bodyArm === arm, `body enable_thinking=${String(bodyArm)}; record arm=${String(arm)}`),
    finding('thinking-format', arm ? !!record.response?.reasoning?.trim() || !!record.response?.content?.match(/<think>/i) : !record.response?.reasoning?.trim(), arm ? 'thinking-on response contains a captured reasoning channel' : 'thinking-off response has no captured reasoning channel'),
    finding('unterminated-think', record.response?.unterminatedThink === false, record.response?.unterminatedThink ? 'stream ended inside an inline <think> block' : 'thinking markers are terminated'),
    finding('non-empty-answer', !!record.response?.content?.trim(), record.response?.content?.trim() ? 'visible answer is non-empty' : 'no visible answer was captured'),
    finding('finish-reason', record.response?.finishReason === 'stop', `finish_reason=${record.response?.finishReason ?? 'missing'}; expected stop`),
    finding('repetition-loop', repetitionLoop(`${record.response?.content ?? ''}\n${record.response?.reasoning ?? ''}`).length === 0, 'no repeated paragraphs, contract markers, or continuation-loop language'),
  ]
}

function stageFindings(testCase: ThinkingEvalCase, record: RawEvalRecord): DeterministicFinding[] {
  const content = record.response?.content ?? ''
  const findings = protocolFindings(testCase, record)
  let semanticContent = content

  if (testCase.id === 'scene-breakdown') {
    const breakdown = strictBreakdown(content)
    findings.push(finding('breakdown-json', !!breakdown, breakdown ? 'breakdown JSON has the required clip fields' : 'response is not valid plain breakdown JSON with numeric sequential clip fields'))
    findings.push(orderedBreakdownActions(content))
  } else if (testCase.id === 'continuation-planning') {
    findings.push(handoffBlocks(content))
  } else if (testCase.id === 'prompt-revise' || testCase.id === 'prompt-rebuild') {
    const replacement = splitPromptReplacement(content)
    findings.push(replacementBlocks(content), requiredH3Fields(replacement?.prompt ?? '', testCase), h3FieldOrder(replacement?.prompt ?? '', testCase))
    semanticContent = replacement?.prompt ?? ''
  } else if (testCase.stage === 'direct') {
    // Direct produces a direction sheet. It is deliberately not a prompt
    // authoring pass, so applying the H3 field validators here would mark a
    // correct sheet as broken and hide the stage-contract violation we care
    // about when a model jumps ahead into a submission payload.
    findings.push(directionSheetContract(content))
  } else {
    findings.push(requiredH3Fields(content, testCase), h3FieldOrder(content, testCase))
  }

  findings.push(
    clipDuration(semanticContent, testCase),
    t2vaSourceContract(semanticContent, testCase),
    neighboringStates(content, testCase),
    continuityOpening(content, testCase),
    reestablishesPriorAction(content, testCase),
    fixedFacts(semanticContent, testCase),
    verbatimDialogue(content, testCase),
    actingSpecificity(content, testCase),
    twoHanderContract(content, testCase),
    noDialoguePrompt(semanticContent, testCase),
    soundAndMusic(semanticContent, testCase),
    prematureResolution(semanticContent, testCase),
    promptInventedEvents(semanticContent, testCase),
  )

  if (testCase.id === 'prompt-rebuild') {
    findings.push(rebuildMaterialChange(content, testCase))
  }

  // Every fixture declares a public validator ID. Keep those IDs visible in
  // the result even when the implementation uses several lower-level checks
  // to establish one contract (continuity is the main example).
  for (const validatorId of testCase.validators) {
    if (findings.some((item) => item.id === validatorId)) continue
    const continuityIds = testCase.id === 'clip-t2va-draft-from-direction-sheet'
      ? ['t2va-source-contract']
      : testCase.id === 'scene-middle-closing-direction'
        ? ['neighboring-states', 'continuity-reestablishment', 'no-premature-resolution']
        : ['neighboring-states', 'continuity-opening', 'continuity-reestablishment', 'no-premature-resolution']
    const mapped = validatorId === 'continuity' ? findings.filter((item) => continuityIds.includes(item.id)) : []
    findings.push(finding(validatorId, mapped.length > 0 && mapped.every((item) => item.passed), mapped.length > 0 ? 'all continuity sub-checks passed' : `validator ${validatorId} was not executed`))
  }

  return findings
}

/** Find repeated paragraphs, contract markers, stage headers, or loop language. */
export function repetitionLoop(text: string): string[] {
  const found: string[] = []
  const paragraphs = text
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph.length >= 24)
  const seen = new Set<string>()
  for (const paragraph of paragraphs) {
    if (seen.has(paragraph)) found.push(`repeated paragraph: ${paragraph.slice(0, 180)}`)
    seen.add(paragraph)
  }

  // Models can repeat a single long instruction without inserting a blank
  // line. Treat repeated substantive lines as the same loop symptom, while
  // ignoring short headings and normal field labels.
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 24 && !/^[a-z_]+:\s*$/i.test(line))
  const seenLines = new Set<string>()
  for (const line of lines) {
    if (seenLines.has(line)) found.push(`repeated line: ${line.slice(0, 180)}`)
    seenLines.add(line)
  }

  const markerCounts = new Map<string, number>()
  for (const marker of text.matchAll(/<<<[^>\n]+>>>/g)) markerCounts.set(marker[0], (markerCounts.get(marker[0]) ?? 0) + 1)
  for (const [marker, count] of markerCounts) if (count > 1) found.push(`repeated marker (${count}x): ${marker}`)

  for (const header of STAGE_HEADERS) {
    const count = text.split(header).length - 1
    if (count > 1) found.push(`repeated stage-contract header (${count}x): ${header}`)
  }

  const loopPattern = /\b(?:I(?:'ll| will)\s+(?:continue|retry|try again|keep going)|continuing (?:the )?(?:same )?(?:pass|prompt)|retrying (?:the )?(?:same )?(?:pass|prompt))\b/gi
  for (const match of text.matchAll(loopPattern)) found.push(`loop language: ${match[0]}`)
  return [...new Set(found)]
}

/** Score one isolated response without network access or model calls. */
export function scoreRecord(testCase: ThinkingEvalCase, record: RawEvalRecord): ScoreResult {
  const findings = stageFindings(testCase, record)
  return { passed: findings.every((item) => item.passed), findings }
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function summaryRow(testCase: ThinkingEvalCase | undefined, record: RawEvalRecord, score: ScoreResult): SummaryRow {
  const response = record.response
  const content = response?.content ?? ''
  const reasoning = response?.reasoning ?? ''
  return {
    caseId: record.caseId,
    family: record.family,
    stage: record.stage,
    model: record.model,
    thinking: record.chatTemplateKwargs?.enable_thinking === true,
    // llama's reported completion count covers the whole completion and can
    // include hidden reasoning. Keep visible content and reasoning estimates
    // separate; retain the provider total under its truthful name.
    contentTokens: estTokens(content),
    reasoningTokens: estTokens(reasoning),
    reportedCompletionTokens: numberValue(response?.usage?.completion),
    latencyMs: response?.elapsedMs ?? 0,
    ttftMs: numberValue(response?.timeToFirstTokenMs),
    finishReason: response?.finishReason ?? null,
    contractPass: score.passed && !!testCase,
    errors: record.errors ?? (testCase ? [] : ['unknown case ID']),
    validatorFindings: score.findings,
    pairedOnOffPassDelta: null,
    pairedOnOffContentTokenDelta: null,
    pairedOnOffReasoningTokenDelta: null,
    pairedOnOffLatencyDeltaMs: null,
    pairedOnOffTtftDeltaMs: null,
  }
}

function csvCell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(rows: SummaryRow[]): string {
  const headers = [
    'caseId', 'family', 'stage', 'model', 'thinking', 'contentTokens', 'reasoningTokens', 'latencyMs', 'ttftMs', 'finishReason',
    'reportedCompletionTokens',
    'contractPass', 'errors', 'validatorFindings', 'pairedOnOffPassDelta', 'pairedOnOffContentTokenDelta',
    'pairedOnOffReasoningTokenDelta', 'pairedOnOffLatencyDeltaMs', 'pairedOnOffTtftDeltaMs',
  ]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push([
      row.caseId, row.family, row.stage, row.model, row.thinking, row.contentTokens, row.reasoningTokens, row.latencyMs,
      row.ttftMs, row.finishReason ?? '', row.reportedCompletionTokens, row.contractPass, row.errors, row.validatorFindings.map((item) => `${item.id}:${item.passed ? 'pass' : 'fail'}`),
      row.pairedOnOffPassDelta, row.pairedOnOffContentTokenDelta, row.pairedOnOffReasoningTokenDelta,
      row.pairedOnOffLatencyDeltaMs, row.pairedOnOffTtftDeltaMs,
    ].map(csvCell).join(','))
  }
  return `${lines.join('\n')}\n`
}

interface PairSummary {
  caseId: string
  model: string
  on: { contractPass: boolean; contentTokens: number; reasoningTokens: number; latencyMs: number; ttftMs: number | null } | null
  off: { contractPass: boolean; contentTokens: number; reasoningTokens: number; latencyMs: number; ttftMs: number | null } | null
  delta: { contractPass: number | null; contentTokens: number | null; reasoningTokens: number | null; latencyMs: number | null; ttftMs: number | null }
}

function pairRows(rows: SummaryRow[]): PairSummary[] {
  const pairs = new Map<string, { on?: SummaryRow; off?: SummaryRow }>()
  for (const row of rows) {
    const key = `${row.caseId}\u0000${row.model}`
    const pair = pairs.get(key) ?? {}
    if (row.thinking) pair.on = row
    else pair.off = row
    pairs.set(key, pair)
  }
  return [...pairs.entries()].map(([key, pair]) => {
    const [caseId, model] = key.split('\u0000')
    const on = pair.on
    const off = pair.off
    const delta = {
      contractPass: on && off ? Number(on.contractPass) - Number(off.contractPass) : null,
      contentTokens: on && off ? on.contentTokens - off.contentTokens : null,
      reasoningTokens: on && off ? on.reasoningTokens - off.reasoningTokens : null,
      latencyMs: on && off ? on.latencyMs - off.latencyMs : null,
      ttftMs: on && off && on.ttftMs !== null && off.ttftMs !== null ? on.ttftMs - off.ttftMs : null,
    }
    return {
      caseId,
      model,
      on: on ? { contractPass: on.contractPass, contentTokens: on.contentTokens, reasoningTokens: on.reasoningTokens, latencyMs: on.latencyMs, ttftMs: on.ttftMs } : null,
      off: off ? { contractPass: off.contractPass, contentTokens: off.contentTokens, reasoningTokens: off.reasoningTokens, latencyMs: off.latencyMs, ttftMs: off.ttftMs } : null,
      delta,
    }
  })
}

const LIMITATIONS = [
  'default and ornith-35b are aliases of the same underlying Ornith weights; only default is evaluated.',
  'Temperature 0.2 leaves generation nondeterministic; identical fixtures, ordering, and request settings control the comparison but do not guarantee identical tokens.',
  'Deterministic findings measure protocol, format, fixed-fact, and continuity contracts, not cinematic taste.',
  'Qualitative review is a blinded structured human judgment and is not an objective quality measurement.',
  'A failed direct request is retained as one failure and is never retried by this harness.',
]

const QUALITATIVE_RUBRIC = {
  blinded: true,
  scale: '1–5; mark unscorable with a reason when a hard contract failure prevents review',
  dimensions: ['instruction following', 'directing', 'acting specificity', 'H3 usability', 'continuity', 'concision'],
  instructions: 'Show reviewers anonymized outputs without model name, thinking arm, or execution order. Report distributions and observations separately from deterministic contract results.',
}

/** Score a JSONL artifact and write summaries beside it; never makes a network call. */
export async function scoreFile(rawPath: string): Promise<{ records: number; failures: number; summaryCsv: string; summaryJson: string }> {
  const source = await readFile(rawPath, 'utf8')
  const lines = source.split(/\r?\n/).filter((line) => line.trim())
  const rows: SummaryRow[] = []
  const scoredRawLines: string[] = []
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      rows.push({
        caseId: '(malformed-jsonl)', family: 'unknown', stage: 'unknown', model: 'unknown', thinking: false,
        contentTokens: 0, reasoningTokens: 0, reportedCompletionTokens: null, latencyMs: 0, ttftMs: null, finishReason: null, contractPass: false,
        errors: [`invalid JSONL record: ${error instanceof Error ? error.message : String(error)}`], validatorFindings: [finding('record-shape', false, 'record is not valid JSON')],
        pairedOnOffPassDelta: null, pairedOnOffContentTokenDelta: null, pairedOnOffReasoningTokenDelta: null, pairedOnOffLatencyDeltaMs: null, pairedOnOffTtftDeltaMs: null,
      })
      scoredRawLines.push(line)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rows.push({
        caseId: '(malformed-record)', family: 'unknown', stage: 'unknown', model: 'unknown', thinking: false,
        contentTokens: 0, reasoningTokens: 0, reportedCompletionTokens: null, latencyMs: 0, ttftMs: null, finishReason: null, contractPass: false,
        errors: ['record is not a JSON object'], validatorFindings: [finding('record-shape', false, 'record is not a JSON object')],
        pairedOnOffPassDelta: null, pairedOnOffContentTokenDelta: null, pairedOnOffReasoningTokenDelta: null, pairedOnOffLatencyDeltaMs: null, pairedOnOffTtftDeltaMs: null,
      })
      scoredRawLines.push(line)
      continue
    }
    const record = parsed as RawEvalRecord
    const testCase = EVAL_CASES.find((candidate) => candidate.id === record.caseId)
    const score = testCase ? scoreRecord(testCase, record) : { passed: false, findings: [finding('record-shape', false, `unknown case ID ${record.caseId}`)] }
    // The runner intentionally knows nothing about scoring. Once this offline
    // pass has run, make the raw artifact self-describing while retaining every
    // original response/error and its one-request budget.
    record.deterministic = { passed: score.passed, findings: score.findings }
    rows.push(summaryRow(testCase, record, score))
    scoredRawLines.push(JSON.stringify(record))
  }

  const pairs = pairRows(rows)
  for (const row of rows) {
    const pair = pairs.find((candidate) => candidate.caseId === row.caseId && candidate.model === row.model)
    if (!pair) continue
    row.pairedOnOffPassDelta = pair.delta.contractPass
    row.pairedOnOffContentTokenDelta = pair.delta.contentTokens
    row.pairedOnOffReasoningTokenDelta = pair.delta.reasoningTokens
    row.pairedOnOffLatencyDeltaMs = pair.delta.latencyMs
    row.pairedOnOffTtftDeltaMs = pair.delta.ttftMs
  }

  const failures = rows.filter((row) => !row.contractPass).length
  const perCaseFailures = Object.fromEntries(EVAL_CASES.map((testCase) => [testCase.id, rows.filter((row) => row.caseId === testCase.id && !row.contractPass).length]))
  const comparisons = EVAL_MODELS.map((model) => {
    const modelRows = rows.filter((row) => row.model === model)
    return {
      model,
      on: { records: modelRows.filter((row) => row.thinking).length, passes: modelRows.filter((row) => row.thinking && row.contractPass).length },
      off: { records: modelRows.filter((row) => !row.thinking).length, passes: modelRows.filter((row) => !row.thinking && row.contractPass).length },
    }
  })
  const summary = {
    eval: 'studio-thinking-v1',
    planned: EVAL_CASES.length * EVAL_MODELS.length * 2,
    written: rows.length,
    failures,
    rows,
    pairs,
    perCaseFailures,
    comparisons,
    limitations: LIMITATIONS,
    qualitativeRubric: QUALITATIVE_RUBRIC,
  }
  const summaryCsv = join(dirname(rawPath), 'summary.csv')
  const summaryJson = join(dirname(rawPath), 'summary.json')
  await writeFile(rawPath, `${scoredRawLines.join('\n')}${scoredRawLines.length ? '\n' : ''}`, 'utf8')
  await writeFile(summaryCsv, toCsv(rows), 'utf8')
  await writeFile(summaryJson, `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
  return { records: rows.length, failures, summaryCsv, summaryJson }
}

async function main(): Promise<void> {
  const rawPath = process.argv[2]
  if (!rawPath) throw new Error('Usage: npx tsx eval/score-thinking-eval.ts <raw.jsonl>')
  const result = await scoreFile(rawPath)
  console.log(`records=${result.records} failures=${result.failures} summaryCsv=${result.summaryCsv} summaryJson=${result.summaryJson}`)
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
