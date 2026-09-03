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
    if ([...REF_FIELDS, ...BASE_FIELDS].includes(name as never) && !fields.includes(name)) fields.push(name)
  }
  return fields
}

function expectedFields(testCase: ThinkingEvalCase): readonly string[] {
  return testCase.h3Mode === 'Ref2VA' ? REF_FIELDS : BASE_FIELDS
}

function requiredH3Fields(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const required = expectedFields(testCase)
  const missing = required.filter((field) => !fieldValue(text, field))
  const lintRequired = lint(text, testCase.h3Mode).find((item) => item.id === 'mode/fields')
  const passed = missing.length === 0 && lintRequired?.severity !== 'error'
  return finding(
    'required-h3-fields',
    passed,
    passed ? `${required.length} required ${testCase.h3Mode} fields are non-empty` : `missing or empty fields: ${missing.join(', ') || lintRequired?.detail || 'unknown'}`,
  )
}

function h3FieldOrder(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  const required = [...expectedFields(testCase)]
  const actual = canonicalFields(text)
  const passed = JSON.stringify(actual) === JSON.stringify(required)
  return finding('h3-field-order', passed, passed ? required.join(' → ') : `expected ${required.join(' → ')}, got ${actual.join(' → ') || '(none)'}`)
}

function strictBreakdown(text: string): ReturnType<typeof parseBreakdown> {
  const parsed = parseBreakdown(text)
  if (!parsed) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let raw: unknown
  try {
    raw = JSON.parse(text.slice(start, end + 1))
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
      return Number.isFinite(Number(clip.index)) &&
        typeof clip.title === 'string' && !!clip.title.trim() &&
        typeof clip.role === 'string' && validRoles.has(clip.role) &&
        Number.isFinite(Number(clip.seconds)) && Number(clip.seconds) > 0 &&
        typeof clip.covers === 'string' && !!clip.covers.trim() &&
        typeof clip.precedes === 'string' &&
        typeof clip.follows === 'string'
    })
  return valid ? parsed : null
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
    const breakdown = parseBreakdown(text)
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
  const passed = (declaredSeconds === null || Math.abs(declaredSeconds - target) < 0.051) && (end === null || Math.abs(end - target) < 0.051) && contiguous
  return finding('clip-duration', passed, passed ? `timing fits the fixture's ${target}-second constraint` : `expected ${target} seconds, got declared ${declaredSeconds ?? 'none'} and timeline end ${end ?? 'none'}`)
}

function neighboringStates(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.id === 'scene-breakdown') {
    const breakdown = parseBreakdown(text)
    const passed = !!breakdown && breakdown.clips.every((clip, index) => {
      if (clip.index !== index + 1) return false
      if (index === 0 && clip.precedes.trim()) return false
      if (index > 0 && !clip.precedes.trim()) return false
      if (index < breakdown.clips.length - 1 && !clip.follows.trim()) return false
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
  const repeatedPlacement = /(?:place|places|placed|placing|set|sets|setting|leave|leaves|leaving)\s+(?:the\s+)?(?:red\s+)?(?:paper\s+)?lantern\s+(?:beside|next to|by|on)/i.test(lower)
  const newPlatformEstablishment = /(?:establish|establishes|establishing|introduce|introduces|enter|enters|entering)\b[^.\n]{0,80}\b(?:platform|railway)/i.test(lower)
  const passed = !repeatedPlacement && !newPlatformEstablishment
  return finding('continuity-reestablishment', passed, passed ? 'prior placement and established setting are not replayed' : 'the response re-establishes the prior lantern placement or platform')
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

function soundAndMusic(text: string, testCase: ThinkingEvalCase): DeterministicFinding {
  if (testCase.stage === 'breakdown' || testCase.stage === 'handoff') return finding('sound-music', true, 'not applicable to a planning-only contract')
  const lower = normalized(text)
  const sound = fieldValue(text, 'overall_soundscape')
  const music = fieldValue(text, 'non_diegetic_music')
  const soundSources = /\b(?:rain|footsteps?|traffic|door|wind|engine|birds?|breath|voices?|clatter|hum|bell|water|thunder|clock|ticking|creak|rustle|scrape|whistle|horn|radio|glass|metal|paper|fabric|foley|coin|hinge|insects?)\b/i.test(sound)
  const musicValid = !!music && (/^n\/a\.?$/i.test(music) || !/\b(?:no|without|none|silence|silent|absent|do not|don't)\s+(?:music|score|soundtrack)\b/i.test(music))
  const directionSound = testCase.stage === 'direct' && !testCase.id.startsWith('continuation-') ? soundSources || /sound anchors?|sound design|footsteps?|breath|fabric|coin|hinge/i.test(lower) : true
  const passed = testCase.stage === 'draft' || testCase.stage === 'revise' || testCase.stage === 'rebuild'
    ? !!sound && soundSources && musicValid
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

  if (testCase.id === 'scene-breakdown') {
    const breakdown = strictBreakdown(content)
    findings.push(finding('breakdown-json', !!breakdown, breakdown ? 'breakdown JSON has the required clip fields' : 'response is not valid breakdown JSON with non-empty clip fields'))
  } else if (testCase.id === 'continuation-planning') {
    findings.push(handoffBlocks(content))
  } else if (testCase.id === 'prompt-revise' || testCase.id === 'prompt-rebuild') {
    const replacement = splitPromptReplacement(content)
    findings.push(replacementBlocks(content), requiredH3Fields(replacement?.prompt ?? '', testCase), h3FieldOrder(replacement?.prompt ?? '', testCase))
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
    clipDuration(content, testCase),
    neighboringStates(content, testCase),
    continuityOpening(content, testCase),
    reestablishesPriorAction(content, testCase),
    fixedFacts(content, testCase),
    verbatimDialogue(content, testCase),
    actingSpecificity(content, testCase),
    soundAndMusic(content, testCase),
    prematureResolution(content, testCase),
  )

  if (testCase.id === 'prompt-rebuild') {
    const replacement = splitPromptReplacement(content)
    findings.push(finding('material-rebuild', !!replacement && normalized(replacement.prompt) !== normalized(testCase.current), !!replacement && normalized(replacement.prompt) !== normalized(testCase.current) ? 'rebuild materially rethought the directing' : 'rebuild returned the unchanged source prompt'))
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
    contentTokens: numberValue(response?.usage?.completion) ?? estTokens(content),
    reasoningTokens: estTokens(reasoning),
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
    'contractPass', 'errors', 'validatorFindings', 'pairedOnOffPassDelta', 'pairedOnOffContentTokenDelta',
    'pairedOnOffReasoningTokenDelta', 'pairedOnOffLatencyDeltaMs', 'pairedOnOffTtftDeltaMs',
  ]
  const lines = [headers.join(',')]
  for (const row of rows) {
    lines.push([
      row.caseId, row.family, row.stage, row.model, row.thinking, row.contentTokens, row.reasoningTokens, row.latencyMs,
      row.ttftMs, row.finishReason ?? '', row.contractPass, row.errors, row.validatorFindings.map((item) => `${item.id}:${item.passed ? 'pass' : 'fail'}`),
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
        contentTokens: 0, reasoningTokens: 0, latencyMs: 0, ttftMs: null, finishReason: null, contractPass: false,
        errors: [`invalid JSONL record: ${error instanceof Error ? error.message : String(error)}`], validatorFindings: [finding('record-shape', false, 'record is not valid JSON')],
        pairedOnOffPassDelta: null, pairedOnOffContentTokenDelta: null, pairedOnOffReasoningTokenDelta: null, pairedOnOffLatencyDeltaMs: null, pairedOnOffTtftDeltaMs: null,
      })
      scoredRawLines.push(line)
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      rows.push({
        caseId: '(malformed-record)', family: 'unknown', stage: 'unknown', model: 'unknown', thinking: false,
        contentTokens: 0, reasoningTokens: 0, latencyMs: 0, ttftMs: null, finishReason: null, contractPass: false,
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
