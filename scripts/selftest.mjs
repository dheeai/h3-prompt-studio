#!/usr/bin/env node
// Run with: npx tsx scripts/selftest.mjs
//
// Deterministic unit tests for the pure functions added across llm.ts,
// stages.ts and lint.ts — no network, no browser. `llm.ts` is imported under
// plain node here (not a browser), which is the check that `location.origin`
// (used only inside the OpenRouter branch of streamChat) never gets evaluated
// for a non-OpenRouter provider — if it did, importing this file would throw.

import { readFileSync } from 'node:fs'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_TEMPLATES, fillTemplate, splitReply, parseBreakdown } from '../src/lib/stages.ts'
import { classifyInput, standingToText } from '../src/lib/lint.ts'
// stitch lives in llm.ts alongside streamChatComplete; importing it here also
// proves llm.ts loads cleanly under node — see the note above.
import { stitch, toLineBoundary, appendedFor, continuationBudgetFor, streamChat, streamChatComplete } from '../src/lib/llm.ts'
import { buildMulticlipGraph, multiclipIssues, padForOverlap, snapUp } from '../src/lib/multiclip.ts'
import {
  ENTRY_MODES,
  authorContinuation,
  continuationContextOverride,
  appendContinuationHistory,
  continuationPlateIsFresh,
  continuationSource,
  entryAction,
  entryLabel,
  entryMode,
  entryStartCopy,
  entryWorkflow,
  promptSourceForEntryMode,
  interruptedReasoningText,
  previousPromptForClip,
  clearDraftContext,
  shouldContinueStoryLoop,
} from '../src/lib/entry.ts'
import { agentApiKey, buildAgentModel, buildAgentTools, reduceAgentEvent, agentEventStatus } from '../src/lib/agent.ts'
import { buildH3SystemPrompt, buildStudioSystemPrompt } from '../src/lib/context.ts'
import { EVAL_ARMS, EVAL_CASES, EVAL_MODELS, buildEvalMessages, evalSkillRoot, evalVariants } from '../eval/cases.ts'
import { parseEvalSse, streamOneResponse } from '../eval/stream.ts'
import { parseCli, runOneVariant, runThinkingEval } from '../eval/run-thinking-eval.ts'
import { repetitionLoop, scoreFile, scoreRecord } from '../eval/score-thinking-eval.ts'

let pass = 0
let fail = 0

check('thinking eval fixtures: use the approved eight-case order',
  JSON.stringify(EVAL_CASES.map((testCase) => testCase.id)) === JSON.stringify([
    'scene-breakdown',
    'scene-middle-closing-direction',
    'clip-direction-acting-heavy-two-hander',
    'clip-t2va-draft-from-direction-sheet',
    'prompt-revise',
    'prompt-rebuild',
    'continuation-planning',
    'continuation-prompt-authoring',
  ]))
check('thinking eval fixtures: use the approved model order',
  JSON.stringify(EVAL_MODELS) === JSON.stringify(['default', 'thinkingcap-27b', 'qwen38-heretic-27b-fast']))
check('thinking eval fixtures: expose enabled and disabled arms',
  JSON.stringify(EVAL_ARMS) === JSON.stringify([true, false]))
check('thinking eval fixtures: expand to exactly 48 isolated variants', evalVariants().length === 48)
check('thinking eval fixtures: preserve the approved stage and entry-mode matrix',
  JSON.stringify(EVAL_CASES.map((testCase) => [testCase.stage, testCase.studioMode])) === JSON.stringify([
    ['breakdown', 'story'],
    ['direct', 'story'],
    ['direct', 'idea'],
    ['draft', 'idea'],
    ['revise', 'prompt'],
    ['rebuild', 'prompt'],
    ['handoff', 'story'],
    ['draft', 'story'],
  ]))
check('thinking eval fixtures: use Ref2VA except for the T2VA draft case',
  EVAL_CASES.filter((testCase) => testCase.h3Mode === 'T2VA').map((testCase) => testCase.id).join(',') === 'clip-t2va-draft-from-direction-sheet' &&
  EVAL_CASES.filter((testCase) => testCase.h3Mode === 'Ref2VA').length === 7)
const fallbackFixturePath = await mkdtemp(join(tmpdir(), 'h3-prompt-studio-eval-'))
try {
  const fallbackFixtureRoot = pathToFileURL(`${fallbackFixturePath}/`)
  await mkdir(new URL('public/skills/', fallbackFixtureRoot), { recursive: true })
  await cp(new URL('../public/skills/', import.meta.url), new URL('public/skills/', fallbackFixtureRoot), { recursive: true })
  const selectedFallbackRoot = await evalSkillRoot(fallbackFixtureRoot)
  check('thinking eval fixtures: fall back to tracked public skills when dist is absent',
    selectedFallbackRoot.pathname.endsWith('/public/skills/'))
} finally {
  await rm(fallbackFixturePath, { recursive: true, force: true })
}
const evalMessages = await buildEvalMessages(EVAL_CASES[0])
check('thinking eval messages: each case produces exactly a system and user message',
  evalMessages.length === 2 && evalMessages[0].role === 'system' && evalMessages[1].role === 'user')

// ── thinking-evaluation transport ─────────────────────────────────────

{
  const first = JSON.stringify({ choices: [{ delta: { reasoning: 'weigh the lens' } }] })
  const second = JSON.stringify({ choices: [{ delta: { content: '<think>private plan</think>answer' } }] })
  const terminal = JSON.stringify({ choices: [{ delta: { content: ' tail' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 7 } })
  // The terminal frame deliberately has no trailing blank-line separator.
  const sse = `data: ${first}\n\ndata: ${second}\n\ndata: ${terminal}`
  const parsed = parseEvalSse(sse)
  let firstTokenCalls = 0
  const streamed = await streamOneResponse(new Response(sse), () => { firstTokenCalls++ })
  check('thinking eval stream: terminal SSE frame keeps content, finish reason, reasoning, and usage',
    parsed.content === 'answer tail' && parsed.finishReason === 'stop' &&
    parsed.reasoning.includes('weigh the lens') && parsed.reasoning.includes('private plan') &&
    parsed.usage?.prompt === 12 && parsed.usage?.completion === 7 &&
    streamed.content === parsed.content && streamed.finishReason === parsed.finishReason && firstTokenCalls === 1,
    JSON.stringify({ parsed, streamed, firstTokenCalls }))
}

check('thinking eval stream: null SSE payload is ignored without aborting later frames',
  parseEvalSse('data: null\n\ndata: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}').content === 'answer')

{
  const chunks = [
    'data: {"choices":[{"delta":{"content":"<think>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"reason"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"</think>answer"},"finish_reason":"length"}]}',
  ]
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  }))
  let firstTokenCalls = 0
  const streamed = await streamOneResponse(response, () => { firstTokenCalls++ })
  check('thinking eval stream: reasoning_content, split inline think tags, raw-token TTFT, and length finish are retained', (() => {
    const separate = parseEvalSse('data: {"choices":[{"delta":{"reasoning_content":"separate reasoning"}}]}')
    return separate.reasoning === 'separate reasoning' && streamed.reasoning === 'reason' &&
      streamed.content === 'answer' && streamed.finishReason === 'length' &&
      streamed.unterminatedThink === false && firstTokenCalls === 1 && streamed.timeToFirstTokenMs !== null
  })(), JSON.stringify({ streamed, firstTokenCalls }))
}

{
  const response = new Response('data: {"choices":[{"delta":{"content":"<think>"}}]}\n\ndata: [DONE]\n\n')
  let firstTokenCalls = 0
  const streamed = await streamOneResponse(response, () => { firstTokenCalls++ })
  check('thinking eval stream: first raw inline think token triggers TTFT before splitter output',
    firstTokenCalls === 1 && streamed.timeToFirstTokenMs !== null && streamed.content === '' && streamed.unterminatedThink,
    JSON.stringify({ streamed, firstTokenCalls }))
}

check('thinking eval CLI: default selects both arms',
  JSON.stringify(parseCli([]).thinking) === JSON.stringify(undefined) &&
  JSON.stringify(parseCli([]).arms) === JSON.stringify([true, false]))
check('thinking eval CLI: --thinking on selects the enabled arm',
  JSON.stringify(parseCli(['--thinking', 'on']).arms) === JSON.stringify([true]))
check('thinking eval CLI: --thinking off selects the disabled arm',
  JSON.stringify(parseCli(['--thinking', 'off']).arms) === JSON.stringify([false]))
check('thinking eval CLI: exact model and case filters are preserved', (() => {
  const parsed = parseCli(['--model', 'thinkingcap-27b', '--case', 'prompt-revise'])
  return parsed.model === 'thinkingcap-27b' && parsed.caseId === 'prompt-revise' && JSON.stringify(parsed.arms) === JSON.stringify([true, false])
})())

{
  const originalFetch = globalThis.fetch
  let requests = 0
  let requestInit
  const responseBody = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"length"}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = async (_url, init) => {
    requests++
    requestInit = init
    return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const record = await runOneVariant('http://eval.local/llama/v1', EVAL_CASES[0], 'thinkingcap-27b', false)
    const body = JSON.parse(requestInit.body)
    check('thinking eval runner: one request uses the direct streaming body and selected arm',
      requests === 1 && requestInit.method === 'POST' && !requestInit.headers?.Authorization &&
      body.model === 'thinkingcap-27b' && body.temperature === 0.2 && body.max_tokens === 8192 &&
      body.stream === true && body.chat_template_kwargs?.enable_thinking === false &&
      record.response.finishReason === 'length' && record.response.requestCount === 1 && record.response.continuations === 0,
      JSON.stringify({ requests, body, record }))
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('synthetic connection refused') }
  try {
    const record = await runOneVariant('http://eval.local/llama/v1', EVAL_CASES[0], 'default', false)
    check('thinking eval runner: fetch rejection is one recorded attempt with no retry',
      requests === 1 && record.response.requestCount === 1 && record.response.continuations === 0 && record.errors.length === 1 &&
      record.errors[0].includes('synthetic connection refused'))
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const originalFetch = globalThis.fetch
  const malformedCase = { ...EVAL_CASES[0], id: 'synthetic-assembly-failure', stage: 'not-a-stage' }
  const originalCase = EVAL_CASES[0]
  const outputPath = await mkdtemp(join(tmpdir(), 'h3-prompt-studio-thinking-assembly-'))
  let requests = 0
  EVAL_CASES[0] = malformedCase
  globalThis.fetch = async () => { requests++; throw new Error('fetch must not be called after assembly failure') }
  try {
    const result = await runThinkingEval({
      baseUrl: 'http://eval.local/llama/v1', outputDir: outputPath,
      thinking: undefined, model: 'default', caseId: 'synthetic-assembly-failure',
    })
    const rows = readFileSync(join(outputPath, 'raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    check('thinking eval runner: message assembly failure becomes a record and matrix continues',
      result.planned === 2 && result.written === 2 && result.failures === 2 && requests === 0 &&
      rows.every((row) => row.response.requestCount === 1 && row.errors.length === 1 && /assembly|stage|replace/i.test(row.errors[0])))
  } finally {
    EVAL_CASES[0] = originalCase
    globalThis.fetch = originalFetch
    await rm(outputPath, { recursive: true, force: true })
  }
}

{
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return new Response('{"error":"synthetic failure"}', { status: 503, statusText: 'Unavailable' })
  }
  try {
    const record = await runOneVariant('http://eval.local/llama/v1', EVAL_CASES[0], 'default', true)
    check('thinking eval runner: HTTP failure is one recorded attempt with no retry',
      requests === 1 && record.response.requestCount === 1 && record.response.continuations === 0 &&
      record.errors.length === 1 && record.errors[0].startsWith('503 Unavailable'),
      JSON.stringify({ requests, record }))
  } finally {
    globalThis.fetch = originalFetch
  }
}

{
  const originalFetch = globalThis.fetch
  const outputPath = await mkdtemp(join(tmpdir(), 'h3-prompt-studio-thinking-runner-'))
  let requests = 0
  const responseBody = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = async () => {
    requests++
    return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const result = await runThinkingEval({
      baseUrl: 'http://eval.local/llama/v1', outputDir: outputPath,
      thinking: undefined, model: 'default', caseId: 'scene-breakdown',
    })
    const rows = readFileSync(join(outputPath, 'raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    check('thinking eval runner: filtered matrix writes true then false and flushes every planned row',
      result.planned === 2 && result.written === 2 && result.failures === 0 && requests === 2 &&
      JSON.stringify(rows.map((row) => row.chatTemplateKwargs.enable_thinking)) === JSON.stringify([true, false]),
      JSON.stringify({ result, requests, rows }))
  } finally {
    globalThis.fetch = originalFetch
    await rm(outputPath, { recursive: true, force: true })
  }
}

{
  const originalFetch = globalThis.fetch
  const outputPath = await mkdtemp(join(tmpdir(), 'h3-prompt-studio-thinking-runner-full-'))
  const requests = []
  const responseBody = 'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) })
    return new Response(responseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  try {
    const result = await runThinkingEval({
      baseUrl: 'http://eval.local/llama/v1', outputDir: outputPath,
      thinking: undefined, model: undefined, caseId: undefined,
    })
    const expected = EVAL_MODELS.flatMap((model) => EVAL_CASES.flatMap((testCase) => [
      [model, testCase.id, true], [model, testCase.id, false],
    ]))
    const rows = readFileSync(join(outputPath, 'raw.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    const actual = rows.map((row) => [row.model, row.caseId, row.chatTemplateKwargs.enable_thinking])
    check('thinking eval runner: default matrix writes all 48 variants in model/case/true-before-false order',
      result.planned === 48 && result.written === 48 && result.failures === 0 && requests.length === 48 &&
      JSON.stringify(actual) === JSON.stringify(expected),
      JSON.stringify({ result, requests: requests.length, actual }))
  } finally {
    globalThis.fetch = originalFetch
    await rm(outputPath, { recursive: true, force: true })
  }
}

// ── thinking-evaluation deterministic scoring ─────────────────────────────

function syntheticRecord(testCase, content, overrides = {}) {
  return {
    eval: 'studio-thinking-v1',
    caseId: testCase.id,
    family: testCase.family,
    stage: testCase.stage,
    studioMode: testCase.studioMode,
    model: 'default',
    chatTemplateKwargs: { enable_thinking: false },
    settings: {
      temperature: 0.2,
      maxTokens: 8192,
      h3Mode: testCase.h3Mode,
      selectedSkills: ['h3-acting', 'h3-direction', 'h3-prompting'],
      inputHash: 'input',
      systemHash: 'system',
    },
    request: {
      url: 'http://eval.local/llama/v1/chat/completions',
      body: {
        model: 'default', messages: [], temperature: 0.2, max_tokens: 8192, stream: true,
        chat_template_kwargs: { enable_thinking: false },
      },
    },
    response: {
      content,
      reasoning: '',
      finishReason: 'stop',
      usage: { prompt: 10, completion: 20 },
      elapsedMs: 100,
      timeToFirstTokenMs: 10,
      unterminatedThink: false,
      requestCount: 1,
      continuations: 0,
    },
    deterministic: { passed: true, findings: [] },
    qualitative: null,
    errors: [],
    ...overrides,
  }
}

const validBreakdown = JSON.stringify({
  spine: 'Maya leaves a light for a child at dawn.',
  clips: [
    { index: 1, title: 'Crossing', role: 'opening', seconds: 3, covers: 'Maya crosses the empty railway platform carrying the red paper lantern.', precedes: '', follows: 'Maya reaches the bench with the drawing.' },
    { index: 2, title: 'Drawing', role: 'rising', seconds: 3, covers: 'Maya hears the absent train, finds the child drawing, and unfolds it.', precedes: 'Maya reaches the bench with the drawing.', follows: 'Maya carries the lantern toward the end of the platform.' },
    { index: 3, title: 'Light', role: 'closing', seconds: 3, covers: 'Maya leaves the red paper lantern lit beside the drawing as first light reaches the tracks.', precedes: 'Maya carries the lantern toward the end of the platform.', follows: '' },
  ],
})
const validPromptReplacement = `<<<PROMPT>>>\nsubject_definitions:\n<Subject 1> is the woman at the greenhouse door.\n<Subject 2> is the glass greenhouse door and latch.\n<Subject 3> is the pale moth.\n\nsummary: At night, a woman opens the greenhouse door, a moth lands on her wrist, and her hand turns the latch.\n\nretention_analysis:\n<Subject 1>: fully_preserved\n<Subject 2>: fully_preserved\n<Subject 3>: fully_preserved\n\ndetailed_description:\n[Shot 1 — 0.0–2.5 seconds] The woman opens the greenhouse door at night.\n[Shot 2 — 2.5–5.0 seconds] The moth lands on her wrist and she stops to watch it.\n[Shot 3 — 5.0–7.0 seconds] Her hand turns the latch; end on the latch.\n\noverall_soundscape: night insects, hinge creak, breath catch, latch click.\nnon_diegetic_music: N/A\n<<<EXPLANATION>>>\nThe reaction is observable and the requested ending and named objects remain fixed.`
const validRebuildReplacement = `<<<PROMPT>>>\nsubject_definitions:\n<Subject 1> is the woman at the greenhouse door, with her face and posture clearly visible.\n<Subject 2> is the glass greenhouse door and its metal latch.\n<Subject 3> is a pale moth that lands on the woman’s wrist.\n\nsummary: At night, a woman approaches the greenhouse, tracks the moth on her wrist, and turns the latch in a motivated closing beat.\n\nretention_analysis:\n<Subject 1>: fully_preserved\n<Subject 2>: fully_preserved\n<Subject 3>: fully_preserved\n\ndetailed_description:\n[Shot 1 — 0.0–2.0 seconds] Begin in a wide, low-angle frame outside the greenhouse as the woman advances to the door and deliberately pulls the handle open. Keep the cool glass and dark garden in the composition.\n[Shot 2 — 2.0–4.5 seconds] Track inward with a slow dolly to her wrist as the pale moth lands. Hold her gaze, breath catch, and suspended fingers in a readable reaction pause.\n[Shot 3 — 4.5–7.0 seconds] Shift to a tight insert of her hand and the metal latch. Her shoulders settle as her fingers turn it; end on the latch rotating under her hand, with the moth still on her wrist.\n\noverall_soundscape: night insects, hinge creak, a soft fabric rustle, one breath catch, and the latch clicking under her hand.\nnon_diegetic_music: N/A\n<<<EXPLANATION>>>\nThe rebuild changes the framing, movement, blocking, lighting, and observable reaction while preserving the fixed subjects, moth landing, latch ending, and silent soundscape.`
const validHandoff = `<<<PRECEDES>>>\nThe red lantern is already lit beside the child’s drawing.\n<<<FOLLOWS>>>\nMaya walks away while the flame remains visible and the train stays absent.\n<<<OPEN>>>\nThe flame bends in the wind; the absent train remains unresolved.`
const validDirectionSheet = `WHERE THE SOURCE STANDS
The platform and child’s drawing are already established; this middle clip listens for the absent train.
WHAT THE BRIEF FIXES
Maya, the red lantern, the drawing, the empty railway platform, and the absent train remain fixed.
DIRECTION SHEET
The shot opens on Maya holding the unlit lantern beside the drawing. She listens for the absent train, unfolds the drawing, and carries the lantern toward the end of the platform. The next clip can open on the lantern lit at the platform end.
Sound anchors: wind against the platform, Maya’s breath, paper unfolding, and a distant rail hum; no score.`
const validT2vaPrompt = `integrated_multimodal_description: [0.0–1.5 seconds] The street magician displays an empty palm to the skeptical child. [1.5–4.5 seconds] The magician closes the other hand around the coin while the child leans in with a skeptical expression. [4.5–6.0 seconds] The magician holds the closed fist in frame; the coin remains hidden and the child remains skeptical.
overall_soundscape: coin click against the palm, fabric movement, and the child’s quiet breath.
non_diegetic_music: N/A`
const validTwoHanderDirection = `WHERE THE SOURCE STANDS
This is a single continuous two-hander in a quiet kitchen after a funeral; the requested coat action and dialogue are fixed.
WHAT THE BRIEF FIXES
The older and younger sisters argue over their father’s worn blue coat. The older sister says, “You only want it because he forgave you.” The younger sister takes it, cannot put it on, and sets it back down.
DIRECTION SHEET
One continuous 7-second shot. Hold a restrained two-shot as the older sister keeps one hand on the coat and delivers the line; let the younger sister’s eyes drop, fingers test the sleeve, and shoulders stop before she sets the coat back down. The shot ends on both sisters and the coat, with no resolution beyond the physical action.
Sound anchors: cloth rasp, one breath catch, and the coat settling on the table; no score.`

check('thinking eval scorer: valid breakdown passes exact three clips and handoffs', (() => {
  const result = scoreRecord(EVAL_CASES.find((c) => c.id === 'scene-breakdown'), syntheticRecord(EVAL_CASES[0], validBreakdown))
  return result.passed && result.findings.some((f) => f.id === 'breakdown-json' && f.passed) && result.findings.some((f) => f.id === 'neighboring-states' && f.passed)
})())
check('thinking eval scorer: wrong breakdown duration fails the duration finding', (() => {
  const wrong = validBreakdown.replace('"seconds":3', '"seconds":4')
  const result = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], wrong))
  return !result.passed && result.findings.some((f) => f.id === 'clip-duration' && !f.passed)
})())
check('thinking eval scorer: breakdown action order is enforced', (() => {
  const shuffled = validBreakdown.replace('Maya hears the absent train, finds the child drawing, and unfolds it.', 'Maya leaves the lantern lit beside the drawing.')
  const result = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], shuffled))
  return result.findings.some((f) => f.id === 'ordered-actions' && !f.passed)
})())
check('thinking eval scorer: adjacent breakdown handoffs must carry the same semantic state', (() => {
  const disconnected = validBreakdown.replace('"precedes":"Maya reaches the bench with the drawing."', '"precedes":"Maya is still crossing the platform."')
  const result = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], disconnected))
  return result.findings.some((f) => f.id === 'neighboring-states' && !f.passed)
})())
check('thinking eval scorer: breakdown response must be plain JSON without prose or fences', (() => {
  const fenced = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], `Here is the plan:\n\`\`\`json\n${validBreakdown}\n\`\`\``))
  return fenced.findings.some((f) => f.id === 'breakdown-json' && !f.passed)
})())
check('thinking eval scorer: three-clip breakdown requires numeric integer indices and non-standalone roles', (() => {
  const stringIndex = validBreakdown.replace('"index":1', '"index":"1"')
  const standalone = validBreakdown.replace('"role":"opening"', '"role":"standalone"')
  const stringResult = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], stringIndex))
  const standaloneResult = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], standalone))
  return stringResult.findings.some((f) => f.id === 'breakdown-json' && !f.passed) && standaloneResult.findings.some((f) => f.id === 'breakdown-json' && !f.passed)
})())
check('thinking eval scorer: malformed breakdown JSON fails the breakdown contract', (() => {
  const result = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], '{"spine":"unfinished"'))
  return result.findings.some((f) => f.id === 'breakdown-json' && !f.passed)
})())
check('thinking eval scorer: breakdown with empty clip fields is not valid JSON contract data', (() => {
  const invalid = JSON.stringify({ spine: 'Maya leaves a light.', clips: [{ index: 1, seconds: 3 }, { index: 2, seconds: 3 }, { index: 3, seconds: 3 }] })
  const result = scoreRecord(EVAL_CASES[0], syntheticRecord(EVAL_CASES[0], invalid))
  return result.findings.some((f) => f.id === 'breakdown-json' && !f.passed)
})())
check('thinking eval scorer: canonical T2VA fields pass in the required order', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const prompt = 'integrated_multimodal_description: A magician hides a coin from a skeptical child and holds the closed fist.\noverall_soundscape: coin click, fabric movement, quiet breath.\nnon_diegetic_music: N/A'
  const result = scoreRecord(testCase, syntheticRecord(testCase, prompt))
  return result.findings.some((f) => f.id === 'required-h3-fields' && f.passed) && result.findings.some((f) => f.id === 'h3-field-order' && f.passed)
})())
check('thinking eval scorer: T2VA 6-second draft requires explicit contiguous beats ending at 6 seconds', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const missing = scoreRecord(testCase, syntheticRecord(testCase, 'integrated_multimodal_description: A magician hides a coin from a skeptical child.\noverall_soundscape: coin click, fabric movement, quiet breath.\nnon_diegetic_music: N/A'))
  const valid = scoreRecord(testCase, syntheticRecord(testCase, validT2vaPrompt))
  return missing.findings.some((f) => f.id === 'clip-duration' && !f.passed) && valid.findings.some((f) => f.id === 'clip-duration' && f.passed)
})())
check('thinking eval scorer: T2VA rejects reference placeholders and dependencies', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const invalid = validT2vaPrompt.replace('The street magician displays', '<Subject 1> is the reference image; the street magician displays')
  const result = scoreRecord(testCase, syntheticRecord(testCase, invalid))
  return result.findings.some((f) => f.id === 't2va-source-contract' && !f.passed)
})())
check('thinking eval scorer: T2VA ending keeps the coin concealed in the magician’s closed fist', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const visible = validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', 'the magician reveals the coin and the child sees it')
  const result = scoreRecord(testCase, syntheticRecord(testCase, visible))
  return result.findings.some((f) => f.id === 't2va-source-contract' && !f.passed)
})())
check('thinking eval scorer: T2VA detects real references without flagging a generic source action', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const dependency = validT2vaPrompt.replace('The street magician displays', 'Using the source image, the street magician displays')
  const genericSource = validT2vaPrompt.replace('The street magician displays', 'The magician follows the source action and displays')
  const dependencyResult = scoreRecord(testCase, syntheticRecord(testCase, dependency))
  const genericSourceResult = scoreRecord(testCase, syntheticRecord(testCase, genericSource))
  return dependencyResult.findings.some((f) => f.id === 't2va-source-contract' && !f.passed) && genericSourceResult.findings.some((f) => f.id === 't2va-source-contract' && f.passed)
})())
check('thinking eval scorer: T2VA accepts coin remains in the closed fist as concealed', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const compliant = validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', 'the coin remains in the closed fist and the child remains skeptical')
  const result = scoreRecord(testCase, syntheticRecord(testCase, compliant))
  return result.findings.some((f) => f.id === 't2va-source-contract' && f.passed)
})())
check('thinking eval scorer: T2VA accepts retained, contained, and held coin variants', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const endings = [
    'the coin remains in the closed fist and the child remains skeptical',
    'the closed fist retains the coin and the child remains skeptical',
    'the closed fist contains the coin and the child remains skeptical',
    'the closed fist holds the coin and the child remains skeptical',
  ]
  return endings.every((ending) => {
    const result = scoreRecord(testCase, syntheticRecord(testCase, validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', ending)))
    return result.findings.some((f) => f.id === 't2va-source-contract' && f.passed)
  })
})())
check('thinking eval scorer: T2VA keeps the skeptical child state through the final fist beat', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const convinced = validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', 'the coin remains hidden; the child becomes convinced, then looks skeptical again')
  const result = scoreRecord(testCase, syntheticRecord(testCase, convinced))
  return result.findings.some((f) => f.id === 't2va-source-contract' && !f.passed)
})())
check('thinking eval scorer: T2VA accepts negated visibility and doubtful-expression wording', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const compliant = validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', 'the coin is not visible in the closed fist; the child is not convinced and maintains a doubtful expression')
  const result = scoreRecord(testCase, syntheticRecord(testCase, compliant))
  return result.findings.some((f) => f.id === 't2va-source-contract' && f.passed)
})())
check('thinking eval scorer: T2VA continuity validator reflects its source and final-state contract', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const valid = scoreRecord(testCase, syntheticRecord(testCase, validT2vaPrompt))
  const broken = scoreRecord(testCase, syntheticRecord(testCase, validT2vaPrompt.replace('the coin remains hidden and the child remains skeptical', 'the magician reveals the coin and the child sees it')))
  return valid.findings.some((f) => f.id === 'continuity' && f.passed) && broken.findings.some((f) => f.id === 'continuity' && !f.passed)
})())
check('thinking eval scorer: direct Direction Sheet passes without H3 prompt fields', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const result = scoreRecord(testCase, syntheticRecord(testCase, validDirectionSheet))
  return result.passed && !result.findings.some((f) => f.id === 'required-h3-fields' && !f.passed) && !result.findings.some((f) => f.id === 'h3-field-order' && !f.passed)
})())
check('thinking eval scorer: direct output that emits H3 fields fails its direction-sheet contract', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const result = scoreRecord(testCase, syntheticRecord(testCase, `${validDirectionSheet}\nintegrated_multimodal_description: an improper prompt payload`))
  return !result.passed && result.findings.some((f) => f.id === 'direction-sheet-contract' && !f.passed)
})())
check('thinking eval scorer: direct sound anchors require a concrete source, not a bare heading', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const invalid = validDirectionSheet.replace('Sound anchors: wind against the platform, Maya’s breath, paper unfolding, and a distant rail hum; no score.', 'Sound anchors:')
  const result = scoreRecord(testCase, syntheticRecord(testCase, invalid))
  return result.findings.some((f) => f.id === 'sound-music' && !f.passed)
})())
check('thinking eval scorer: two-hander direct requires one continuous 7-second shot', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-direction-acting-heavy-two-hander')
  const valid = scoreRecord(testCase, syntheticRecord(testCase, validTwoHanderDirection))
  const cut = scoreRecord(testCase, syntheticRecord(testCase, `${validTwoHanderDirection}\nCut to a third character entering the kitchen for Shot 2.`))
  return valid.passed && valid.findings.some((f) => f.id === 'two-hander-contract' && f.passed) && cut.findings.some((f) => f.id === 'two-hander-contract' && !f.passed)
})())
check('thinking eval scorer: reordered H3 fields fail the field-order contract', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const prompt = 'overall_soundscape: coin click, fabric movement, quiet breath.\nintegrated_multimodal_description: A magician hides a coin from a skeptical child and holds the closed fist.\nnon_diegetic_music: N/A'
  const result = scoreRecord(testCase, syntheticRecord(testCase, prompt))
  return result.findings.some((f) => f.id === 'h3-field-order' && !f.passed)
})())
check('thinking eval scorer: duplicate canonical H3 fields fail required and order contracts', (() => {
  const draftCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const replacementCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const duplicateDraft = validT2vaPrompt.replace('\noverall_soundscape:', '\noverall_soundscape: duplicate source.\noverall_soundscape:')
  const duplicateReplacement = validPromptReplacement.replace('<<<EXPLANATION>>>', 'overall_soundscape: duplicate source.\n<<<EXPLANATION>>>')
  const draft = scoreRecord(draftCase, syntheticRecord(draftCase, duplicateDraft))
  const replacement = scoreRecord(replacementCase, syntheticRecord(replacementCase, duplicateReplacement))
  return [draft, replacement].every((result) =>
    result.findings.some((f) => f.id === 'required-h3-fields' && !f.passed) &&
    result.findings.some((f) => f.id === 'h3-field-order' && !f.passed))
})())
check('thinking eval scorer: replacement prompt fields are validated inside PROMPT, not EXPLANATION', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const invalid = `<<<PROMPT>>>\nsummary: only a partial greenhouse prompt\n<<<EXPLANATION>>>\nsubject_definitions: fake\noverall_soundscape: fake\nnon_diegetic_music: N/A\ndetailed_description: fake\nretention_analysis: fake`
  const result = scoreRecord(testCase, syntheticRecord(testCase, invalid))
  return result.findings.some((f) => f.id === 'prompt-replacement-blocks' && f.passed) &&
    result.findings.some((f) => f.id === 'required-h3-fields' && !f.passed) &&
    result.findings.some((f) => f.id === 'h3-field-order' && !f.passed)
})())
check('thinking eval scorer: rebuild rejects punctuation-only edits and invented greenhouse events', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-rebuild')
  const unchangedReplacement = `<<<PROMPT>>>\n${testCase.current}\n<<<EXPLANATION>>>\nNo material change.`
  const punctuationOnly = unchangedReplacement.replace('latch.', 'latch!')
  const invented = validPromptReplacement.replace('end on the latch.', 'the woman leaves the greenhouse and the moth flies away; end with the door closed.')
  const punctuationResult = scoreRecord(testCase, syntheticRecord(testCase, punctuationOnly))
  const inventedResult = scoreRecord(testCase, syntheticRecord(testCase, invented))
  return punctuationResult.findings.some((f) => f.id === 'material-rebuild' && !f.passed) && inventedResult.findings.some((f) => f.id === 'prompt-invented-events' && !f.passed)
})())
check('thinking eval scorer: rebuild rejects a trivial adjective change without directing or acting rethink', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-rebuild')
  const trivial = `<<<PROMPT>>>\n${testCase.current.replace('turns the latch', 'firmly turns the latch')}\n<<<EXPLANATION>>>\nA stronger adjective was added.`
  const result = scoreRecord(testCase, syntheticRecord(testCase, trivial))
  return result.findings.some((f) => f.id === 'material-rebuild' && !f.passed)
})())
check('thinking eval scorer: rebuild rejects a synonym-only fingers-to-hands edit', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-rebuild')
  const trivial = `<<<PROMPT>>>\n${testCase.current.replace('her fingers stop', 'her hands stop')}\n<<<EXPLANATION>>>\nThe hand wording is more natural.`
  const result = scoreRecord(testCase, syntheticRecord(testCase, trivial))
  return result.findings.some((f) => f.id === 'material-rebuild' && !f.passed)
})())
check('thinking eval scorer: rebuild rejects a cross-category breath synonym without a structural rethink', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-rebuild')
  const trivial = `<<<PROMPT>>>\n${testCase.current.replaceAll('breath', 'exhalation')}\n<<<EXPLANATION>>>\nBreath was replaced with a synonym.`
  const result = scoreRecord(testCase, syntheticRecord(testCase, trivial))
  return result.findings.some((f) => f.id === 'material-rebuild' && !f.passed)
})())
check('thinking eval scorer: prompt replacement rejects dialogue anywhere in the parsed prompt', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const spoken = validPromptReplacement.replace('The moth lands on her wrist and she stops to watch it.', 'The moth lands on her wrist while she whispers a warning and stops to watch it.')
  const result = scoreRecord(testCase, syntheticRecord(testCase, spoken))
  return result.findings.some((f) => f.id === 'no-dialogue' && !f.passed)
})())
check('thinking eval scorer: valid prompt revise and rebuild pass no-dialogue and overall contract checks', (() => {
  const reviseCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const rebuildCase = EVAL_CASES.find((c) => c.id === 'prompt-rebuild')
  const revise = scoreRecord(reviseCase, syntheticRecord(reviseCase, validPromptReplacement))
  const rebuild = scoreRecord(rebuildCase, syntheticRecord(rebuildCase, validRebuildReplacement))
  return [revise, rebuild].every((result) => result.passed && result.findings.some((f) => f.id === 'no-dialogue' && f.passed))
})())
check('thinking eval scorer: explicit no-voices wording remains compliant in prompt soundscape', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const silent = validPromptReplacement.replace('overall_soundscape: night insects, hinge creak, breath catch, latch click.', 'overall_soundscape: night insects, hinge creak, breath catch, latch click; no voices.')
  const result = scoreRecord(testCase, syntheticRecord(testCase, silent))
  return result.passed && result.findings.some((f) => f.id === 'sound-music' && f.passed) && result.findings.some((f) => f.id === 'no-dialogue' && f.passed)
})())
check('thinking eval scorer: silent prompt cases do not treat voices as ambient sound', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const voiceOnly = validT2vaPrompt.replace('coin click against the palm, fabric movement, and the child’s quiet breath.', 'voices only.').replace('non_diegetic_music: N/A', 'non_diegetic_music: N/A')
  const result = scoreRecord(testCase, syntheticRecord(testCase, voiceOnly))
  return result.findings.some((f) => f.id === 'sound-music' && !f.passed)
})())
check('thinking eval scorer: silent prompt cases require exact N/A music sentinel', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-t2va-draft-from-direction-sheet')
  const denial = validT2vaPrompt.replace('non_diegetic_music: N/A', 'non_diegetic_music: no music')
  const result = scoreRecord(testCase, syntheticRecord(testCase, denial))
  return result.findings.some((f) => f.id === 'sound-music' && !f.passed)
})())
check('thinking eval scorer: prompt replacement requires exactly PROMPT then EXPLANATION', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'prompt-revise')
  const valid = scoreRecord(testCase, syntheticRecord(testCase, validPromptReplacement))
  const invalid = scoreRecord(testCase, syntheticRecord(testCase, `${validPromptReplacement}\n<<<CHANGES>>>\n- endless patch`))
  return valid.findings.some((f) => f.id === 'prompt-replacement-blocks' && f.passed) &&
    valid.findings.some((f) => f.id === 'required-h3-fields' && f.passed) &&
    valid.findings.some((f) => f.id === 'h3-field-order' && f.passed) &&
    invalid.findings.some((f) => f.id === 'prompt-replacement-blocks' && !f.passed)
})())
check('thinking eval scorer: handoff requires three non-empty fields', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'continuation-planning')
  const valid = scoreRecord(testCase, syntheticRecord(testCase, validHandoff))
  const invalid = scoreRecord(testCase, syntheticRecord(testCase, '<<<PRECEDES>>>\nonly one field'))
  return valid.findings.some((f) => f.id === 'handoff-blocks' && f.passed) && invalid.findings.some((f) => f.id === 'handoff-blocks' && !f.passed)
})())
check('thinking eval scorer: missing neighboring state fails continuity', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const result = scoreRecord(testCase, syntheticRecord(testCase, 'WHERE THE SOURCE STANDS\nThe platform is established.\nWHAT THE BRIEF FIXES\nMaya unfolds the drawing.\nDIRECTION SHEET\nThe shot begins and ends.'))
  return result.findings.some((f) => f.id === 'neighboring-states' && !f.passed)
})())
check('thinking eval scorer: scene middle rejects replaying the drawing discovery', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const replay = `${validDirectionSheet}\nMaya discovers the child’s drawing again before carrying the lantern onward.`
  const result = scoreRecord(testCase, syntheticRecord(testCase, replay))
  return result.findings.some((f) => f.id === 'continuity-reestablishment' && !f.passed)
})())
check('thinking eval scorer: scene middle accepts explicit negations of replaying drawing discovery', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'scene-middle-closing-direction')
  const compliant = `${validDirectionSheet}\nMaya proceeds without rediscovering the drawing and does not find the drawing again.`
  const result = scoreRecord(testCase, syntheticRecord(testCase, compliant))
  return result.findings.some((f) => f.id === 'continuity-reestablishment' && f.passed)
})())
check('thinking eval scorer: continuation cannot re-establish the prior placement', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'continuation-planning')
  const result = scoreRecord(testCase, syntheticRecord(testCase, `${validHandoff}\nMaya places the lantern beside the drawing again.`))
  return result.findings.some((f) => f.id === 'continuity-reestablishment' && !f.passed)
})())
check('thinking eval scorer: fixed dialogue cannot be rewritten', (() => {
  const testCase = EVAL_CASES.find((c) => c.id === 'clip-direction-acting-heavy-two-hander')
  const result = scoreRecord(testCase, syntheticRecord(testCase, `integrated_multimodal_description: Two sisters argue in a kitchen. The older sister says, "You only want it because he forgot you." The younger sister takes the blue coat and sets it down.\noverall_soundscape: fabric movement, breath.\nnon_diegetic_music: N/A`))
  return result.findings.some((f) => f.id === 'verbatim-dialogue' && !f.passed)
})())
check('thinking eval scorer: repeated paragraphs and loop language are reported', (() => {
  const repeated = 'same paragraph about the shot\n\nsame paragraph about the shot\nI will continue and retry this pass.'
  const loops = repetitionLoop(repeated)
  return loops.some((item) => /same paragraph/.test(item)) && loops.some((item) => /I will continue|retry/i.test(item))
})())
check('thinking eval scorer: raw records retain one request, zero continuations, and null qualitative', (() => {
  const row = syntheticRecord(EVAL_CASES[0], validBreakdown)
  return row.response.requestCount === 1 && row.response.continuations === 0 && row.qualitative === null
})())
check('thinking eval scorer: every case-declared validator has an explicit finding ID', (() => {
  const required = new Set(EVAL_CASES.flatMap((testCase) => testCase.validators))
  const observed = new Set(EVAL_CASES.flatMap((testCase) => scoreRecord(testCase, syntheticRecord(testCase, '')).findings.map((f) => f.id)))
  return [...required].every((id) => observed.has(id))
})())

{
  const outputPath = await mkdtemp(join(tmpdir(), 'h3-prompt-studio-thinking-score-'))
  try {
    const rawPath = join(outputPath, 'raw.jsonl')
    const row = syntheticRecord(EVAL_CASES[0], validBreakdown)
    const on = syntheticRecord(EVAL_CASES[0], validBreakdown, {
      chatTemplateKwargs: { enable_thinking: true },
      request: { ...row.request, body: { ...row.request.body, chat_template_kwargs: { enable_thinking: true } } },
      response: { ...row.response, reasoning: 'private plan', content: validBreakdown },
    })
    const failed = syntheticRecord(EVAL_CASES[0], validBreakdown, { errors: ['synthetic provider failure'] })
    await writeFile(rawPath, `${JSON.stringify(on)}\n${JSON.stringify(row)}\n${JSON.stringify(failed)}\n`)
    const result = await scoreFile(rawPath)
    const summary = JSON.parse(readFileSync(result.summaryJson, 'utf8'))
    const pair = summary.pairs.find((candidate) => candidate.caseId === 'scene-breakdown' && candidate.model === 'default')
    const rawRows = readFileSync(rawPath, 'utf8').trim().split('\n').map(JSON.parse)
    check('thinking eval scorer: summary files include row, pair data, failures, limitations, and blinded rubric',
      result.records === 3 && result.failures > 0 && readFileSync(result.summaryCsv, 'utf8').includes('caseId') &&
      summary.rows.length === 3 && Array.isArray(summary.pairs) && pair?.delta?.contentTokens !== null &&
      pair?.delta?.reasoningTokens !== null && summary.planned === 48 && rawRows.length === 3 &&
      rawRows.some((candidate) => candidate.errors?.includes('synthetic provider failure')) &&
      summary.rows.some((candidate) => candidate.contentTokens !== 20) &&
      Array.isArray(summary.limitations) && summary.qualitativeRubric?.dimensions?.length === 6,
      JSON.stringify({ result, summary }))
  } finally {
    await rm(outputPath, { recursive: true, force: true })
  }
}

// ── entry modes ────────────────────────────────────────────────────────

const entryModesAreComplete = (() => {
  const modes = ENTRY_MODES.map((m) => m.id)
  return JSON.stringify(modes) === JSON.stringify(['story', 'idea', 'prompt']) &&
    entryLabel('story') === 'Scene (Multi-shot)' && entryLabel('prompt') === 'Prompt' && entryLabel('idea') === 'Clip' &&
    entryAction('story') === 'Create clip plan' && entryAction('prompt') === 'Revise prompt' && entryAction('idea') === 'Generate prompt'
})()
check('entry modes: Story/Prompt/Idea have explicit copy and actions', entryModesAreComplete)
check('entry modes: approved user-facing names are Scene (Multi-shot), Prompt, and Clip',
  JSON.stringify(ENTRY_MODES.map((m) => m.label)) === JSON.stringify(['Scene (Multi-shot)', 'Clip', 'Prompt']))
check('entry modes: source metadata uses the approved terminology throughout',
  entryMode('story').title === 'Scene (Multi-shot)' && entryMode('story').placeholder.includes('scene') &&
  entryMode('prompt').title === 'Prompt' && entryMode('prompt').placeholder.includes('prompt') &&
  entryMode('idea').title === 'Clip' && entryMode('idea').placeholder.includes('clip'))
check('entry modes: empty-state copy follows the approved visible order',
  entryStartCopy() === 'Start with a Scene (Multi-shot), Clip, or Prompt.')
check('entry dispatch: click and keyboard share the same workflow',
  entryWorkflow('story') === 'story-plan' && entryWorkflow('prompt') === 'prompt-revise' && entryWorkflow('idea') === 'idea-prompt')
check('entry actions: Scene stops at a clip plan, Clip generates a prompt, Prompt exposes Revise',
  entryAction('story') === 'Create clip plan' && entryAction('idea') === 'Generate prompt' && entryAction('prompt') === 'Revise prompt')
check('Direct contract: timing and sound anchors are allowed without obsolete stage debate', (() => {
  const direct = DEFAULT_TEMPLATES.direct
  return direct.includes('beat durations') && direct.includes('exact timecodes') && direct.includes('concrete sound anchors') &&
    !direct.includes('Do not describe music or rhythm') && !direct.includes('Direct → Draft → Critique → Revise')
})())
check('story loop: only a completed pass advances to the next clip',
  shouldContinueStoryLoop({ status: 'ok' }) && !shouldContinueStoryLoop({ status: 'null' }) && !shouldContinueStoryLoop({ status: 'cancelled' }) && !shouldContinueStoryLoop({ status: 'error' }))
check('prompt mode: rough source is a working prompt even without canonical fields',
  promptSourceForEntryMode('prompt', 'a rough scene without H3 fields', '', false) === 'a rough scene without H3 fields')
check('prompt mode: an authored prompt still takes precedence over source fallback',
  promptSourceForEntryMode('prompt', 'rough source', 'canonical prompt', false) === 'canonical prompt')
check('non-prompt modes: source fallback still requires the existing prompt heuristic',
  promptSourceForEntryMode('story', 'rough source', '', true) === 'rough source' &&
  promptSourceForEntryMode('story', 'rough source', '', false) === '' &&
  promptSourceForEntryMode('idea', 'rough source', '', false) === '')

{
  const source = continuationSource('', { precedes: 'she faces the hatch', follows: 'the hatch opens', open: 'the warning remains unresolved' })
  check('continuation source: blank note carries hand-off fields forward',
    source === 'OPEN: the warning remains unresolved\nFOLLOWS: the hatch opens\nPRECEDES: she faces the hatch', source)
  check('continuation source: an optional note takes precedence',
    continuationSource('Make the next beat quieter', { precedes: 'old state', follows: 'old future', open: 'old question' }) === 'Make the next beat quieter')
  check('continuation source: previous prompt context has a dedicated template slot',
    fillTemplate('SOURCE {{story}}\nPREVIOUS {{previous}}', { story: source, previous: 'the prompt that produced the last clip' }).includes('PREVIOUS the prompt that produced the last clip'))

check('continuity: a later Scene clip inherits the nearest earlier canonical prompt', (() => {
  if (typeof previousPromptForClip !== 'function') return false
  const versions = [
    { stage: 'draft', clipIndex: 1, text: 'clip one canonical prompt' },
    { stage: 'direct', clipIndex: 2, text: 'clip two direction sheet' },
    { stage: 'draft', clipIndex: 4, text: 'clip four canonical prompt' },
  ]
  return previousPromptForClip(versions, 2) === 'clip one canonical prompt' &&
    previousPromptForClip(versions, 3) === 'clip one canonical prompt' &&
    previousPromptForClip(versions, 1) === undefined
})())

check('new draft: clears film, parent continuation, plan, and passes without touching unrelated state', (() => {
  if (typeof clearDraftContext !== 'function') return false
  const previous = {
    story: 'old scene',
    versions: [{ id: 'v1' }],
    currentId: 'v1',
    chat: [{ role: 'user', text: 'old note' }],
    film: { role: 'rising', spine: 'old film', precedes: 'old ending', follows: 'next beat', clipIndex: 2 },
    parentClipId: 'clip-1',
    parentPrompt: 'old prompt',
    breakdown: { spine: 'old film', clips: [] },
    keep: 'configuration',
  }
  const next = clearDraftContext(previous)
  return next.story === '' && next.versions.length === 0 && next.currentId === null &&
    next.chat.length === 0 && next.film === undefined && next.parentClipId === null &&
    next.parentPrompt === undefined && next.breakdown === undefined && next.keep === 'configuration'
})())
}

{
  const calls = []
  const ready = await authorContinuation(async (stage) => { calls.push(stage); return { stage } })
  check('continuation authoring: Direct then Draft reaches ready', ready === 'ready' && JSON.stringify(calls) === JSON.stringify(['direct', 'draft']), JSON.stringify({ ready, calls }))
  const inputs = []
  const propagated = await authorContinuation(async (stage, previous) => {
    inputs.push([stage, previous?.text ?? null])
    return stage === 'direct' ? { text: 'exact returned direction sheet' } : { text: 'canonical prompt' }
  })
  check('continuation authoring: immediate Draft receives the returned Direct text', propagated === 'ready' && JSON.stringify(inputs) === JSON.stringify([['direct', null], ['draft', 'exact returned direction sheet']]), JSON.stringify({ propagated, inputs }))
  const directFails = []
  const abortedAtDirect = await authorContinuation(async (stage) => { directFails.push(stage); return null })
  check('continuation authoring: Direct failure aborts before Draft', abortedAtDirect === 'aborted' && JSON.stringify(directFails) === JSON.stringify(['direct']), JSON.stringify({ abortedAtDirect, directFails }))
  const draftFails = []
  const abortedAtDraft = await authorContinuation(async (stage) => { draftFails.push(stage); return stage === 'direct' ? { stage } : null })
  check('continuation authoring: Draft failure stops with failure visible', abortedAtDraft === 'aborted' && JSON.stringify(draftFails) === JSON.stringify(['direct', 'draft']), JSON.stringify({ abortedAtDraft, draftFails }))
}

check('cancelled thinking: partial reasoning is retained, empty reasoning is not mislabeled',
  interruptedReasoningText('  the model was still weighing the shot  ') === 'the model was still weighing the shot' && interruptedReasoningText('   ') === null)

{
  const calls = []
  const mock = {
    story: 'an idea', versions: [], current: null, film: { role: 'standalone', spine: '', precedes: '', follows: '' }, breakdown: null,
    clips: [], clip: null, settings: { mode: 'Ref2VA', model: 'test-model', temperature: 0.2, selection: {} }, skills: [],
    appendPromptVersion(input) { calls.push(['append', input]); return { id: 'v-agent' } },
    setBreakdown() { calls.push(['breakdown']) }, prepareContinuation() { calls.push(['continuation']); return null },
    async render() { calls.push(['render']) }, async renderMulticlip() { calls.push(['multiclip']) },
  }
  const tools = buildAgentTools(mock)
  const setPrompt = tools.find((tool) => tool.name === 'set_current_prompt')
  await setPrompt.execute('call-1', { prompt: 'integrated_multimodal_description: a quiet room' })
  check('agent tools: prompt mutation delegates to the shared canonical version action', calls[0]?.[0] === 'append' && calls[0][1].text.includes('integrated_multimodal_description'))
  const render = tools.find((tool) => tool.name === 'render_current')
  const pending = await render.execute('call-2', {})
  check('agent tools: render is confirmation-gated', pending.details.requiresConfirmation === 'render_current' && !calls.some((call) => call[0] === 'render'))
  const model = buildAgentModel({ id: 'ollama', baseUrl: 'http://localhost:11434/v1' }, 'test-model')
  check('agent model: reuses the configured provider endpoint', model.api === 'openai-completions' && model.baseUrl.endsWith('/v1') && model.id === 'test-model')
  check('agent model: keyless local/LAN providers receive a non-secret compatibility key', agentApiKey({ baseUrl: 'http://localhost:11434/v1' }) === 'local-browser-runtime' && agentApiKey({ baseUrl: 'http://5090.tail3cca41.ts.net:9000/v1' }) === 'local-browser-runtime' && agentApiKey({ baseUrl: 'https://custom-model.example/v1' }) === 'local-browser-runtime' && agentApiKey({ baseUrl: 'https://openrouter.ai/api/v1' }) === undefined)
}

// Pi can finish a run without a text_delta (for example a provider error, or
// a complete message delivered only through message_end). The browser reducer
// must still leave a visible receipt and a non-ready status.
{
  const assistant = (text, stopReason = 'stop', errorMessage) => ({
    role: 'assistant',
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
  })
  const finalOnly = reduceAgentEvent([], { type: 'message_end', message: assistant('Final answer without a text delta') })
  check('agent transcript: message_end surfaces a final assistant message', finalOnly.some((item) => item.kind === 'assistant' && item.text === 'Final answer without a text delta'), JSON.stringify(finalOnly))
  const failedEvent = { type: 'agent_end', messages: [assistant('', 'error', 'Provider returned an empty response')] }
  const withFailure = reduceAgentEvent(finalOnly, failedEvent)
  check('agent transcript: agent_end surfaces a provider error', withFailure.some((item) => item.kind === 'assistant' && item.status === 'error' && item.text.includes('Provider returned an empty response')), JSON.stringify(withFailure))
  check('agent status: an error agent_end is not reported as Ready', agentEventStatus(failedEvent).kind === 'error' && agentEventStatus(failedEvent).message.includes('Provider returned an empty response'))
}

check('studio refinement budget: revise, rebuild, and freeform do not retry the generic continuation loop', continuationBudgetFor('revise') === 0 && continuationBudgetFor('rebuild') === 0 && continuationBudgetFor('freeform') === 0)
check('studio stage budgets: other stages remain explicitly finite', continuationBudgetFor('direct') > 0 && continuationBudgetFor('direct') < 8 && continuationBudgetFor('draft') > 0 && continuationBudgetFor('draft') < 8)

{
  const originalFetch = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => {
    requests++
    return new Response('{"error":"max_tokens exceeds context"}', { status: 400, statusText: 'Bad Request' })
  }
  try {
    await streamChatComplete({
      provider: { id: 'test', baseUrl: 'http://test.local/v1' },
      model: 'test-model',
      messages: [{ role: 'user', content: 'prompt' }],
      temperature: 0.2,
      maxTokens: 0,
      retryOnLimit: false,
      maxContinuations: 0,
      onDelta() {},
    })
  } catch {
    // The response is intentionally an output-limit error; the assertion is
    // about the number of endpoint attempts, not the error text.
  } finally {
    globalThis.fetch = originalFetch
  }
  check('prompt replacement limit errors make one endpoint attempt', requests === 1, `requests=${requests}`)
}

check('prompt replacement contracts: Revise and Rebuild return only prompt plus explanation',
  !DEFAULT_TEMPLATES.revise.includes('<<<CHANGES>>>') &&
  !DEFAULT_TEMPLATES.rebuild?.includes('<<<CHANGES>>>') &&
  DEFAULT_TEMPLATES.revise.includes('<<<PROMPT>>>') && DEFAULT_TEMPLATES.revise.includes('<<<EXPLANATION>>>') &&
  DEFAULT_TEMPLATES.rebuild?.includes('<<<PROMPT>>>') && DEFAULT_TEMPLATES.rebuild?.includes('<<<EXPLANATION>>>'))

const workflowModule = await import('../src/lib/studio-workflow.ts').catch(() => null)
check('workflow helper: visible actions are entry-specific and bounded', (() => {
  if (!workflowModule) return false
  const { studioActions } = workflowModule
  const labels = (mode, hasPlan) => studioActions(mode, hasPlan).map((a) => a.label)
  return JSON.stringify(labels('story', false)) === JSON.stringify(['Create clip plan']) &&
    JSON.stringify(labels('story', true)) === JSON.stringify(['Generate selected prompt', 'Generate all prompts']) &&
    JSON.stringify(labels('idea', false)) === JSON.stringify(['Generate prompt']) &&
    JSON.stringify(labels('prompt', false)) === JSON.stringify(['Revise prompt', 'Rebuild prompt'])
})())
check('workflow helper: long thinking has an explicit one-request status', (() => {
  if (!workflowModule) return false
  const { runStatusText } = workflowModule
  return runStatusText('revise', 'thinking', 0).includes('Thinking') &&
    runStatusText('rebuild', 'writing', 0).includes('one request') &&
    runStatusText('direct', 'continuing', 1).toLowerCase().includes('continuing') &&
    runStatusText('direct', 'thinking', 0).includes('one run')
})())
check('workflow helper: an empty active stream does not borrow the prior document', (() => {
  if (!workflowModule) return false
  const shown = workflowModule.displayedStudioPass(
    { stage: 'direct', text: '' },
    { stage: 'breakdown', text: '{"clips":[]}' },
    'direct',
  )
  return shown.text === '' && shown.stage === 'breakdown'
})())
check('workflow helper: Rebuild is a canonical prompt stage for Agent state', () =>
  !!workflowModule && workflowModule.isCanonicalPromptStage('rebuild') && !workflowModule.isCanonicalPromptStage('direct'))
check('studio surface: internal stage rail is not rendered', (() => {
  const appSource = readFileSync(new URL('../src/app/App.tsx', import.meta.url), 'utf8')
  const shortcut = appSource.match(/if \(\(e\.metaKey \|\| e\.ctrlKey\) && e\.key === 'Enter'[\s\S]{0,300}/)?.[0] ?? ''
  return appSource.includes('studioActions') && !appSource.includes('studio-stage-tools') && shortcut.includes('runVisibleAction(primaryAction.id)')
})())
check('prompt replacement parser: malformed two-block output is rejected', (() => {
  if (!workflowModule) return false
  const good = workflowModule.splitPromptReplacement('<<<PROMPT>>>\ncanonical\n<<<EXPLANATION>>>\nfixed timing')
  const missingExplanation = workflowModule.splitPromptReplacement('<<<PROMPT>>>\ncanonical')
  const unmarked = workflowModule.splitPromptReplacement('canonical with commentary')
  const preamble = workflowModule.splitPromptReplacement('preamble\n<<<PROMPT>>>\ncanonical\n<<<EXPLANATION>>>\nfixed timing')
  const postscript = workflowModule.splitPromptReplacement('<<<PROMPT>>>\ncanonical\n<<<EXPLANATION>>>\nfixed timing\n<<<POSTSCRIPT>>>\nextra')
  const duplicate = workflowModule.splitPromptReplacement('<<<PROMPT>>>\nfirst\n<<<PROMPT>>>\nsecond\n<<<EXPLANATION>>>\nfixed timing')
  const reversed = workflowModule.splitPromptReplacement('<<<EXPLANATION>>>\nfixed timing\n<<<PROMPT>>>\ncanonical')
  const changes = workflowModule.splitPromptReplacement('<<<PROMPT>>>\ncanonical\n<<<EXPLANATION>>>\nfixed timing\n<<<CHANGES>>>\n- changed')
  const jsonChanges = workflowModule.splitPromptReplacement('{"prompt":"canonical","explanation":"fixed timing","changes":["legacy"]}')
  return good?.prompt === 'canonical' && good?.explanation === 'fixed timing' && missingExplanation === null && unmarked === null &&
    preamble === null && postscript === null && duplicate === null && reversed === null &&
    changes?.prompt === 'canonical' && changes?.explanation === 'fixed timing' && changes?.changelog.length === 0 &&
    jsonChanges?.prompt === 'canonical' && jsonChanges?.explanation === 'fixed timing' && jsonChanges?.changelog.length === 0
})())
check('prompt replacement parser: accepts fenced markers and strict JSON from local models', (() => {
  if (!workflowModule) return false
  const fenced = workflowModule.splitPromptReplacement('```text\n<<<PROMPT>>>\ncanonical\n<<<EXPLANATION>>>\nfixed timing\n```')
  const json = workflowModule.splitPromptReplacement('{"prompt":"canonical","explanation":"fixed timing"}')
  const incomplete = workflowModule.splitPromptReplacement('{"prompt":"canonical"}')
  return fenced?.prompt === 'canonical' && fenced?.explanation === 'fixed timing' &&
    json?.prompt === 'canonical' && json?.explanation === 'fixed timing' && incomplete === null
})())

// llama.cpp can close an SSE response immediately after its final data frame,
// without writing the optional blank-line separator. The final explanation
// then used to disappear from `streamChat`, leaving Revise with only the
// prompt block and causing the strict replacement parser to reject it.
{
  const originalFetch = globalThis.fetch
  const promptDelta = JSON.stringify({ choices: [{ delta: { content: '<<<PROMPT>>>\ncanonical\n' } }] })
  const finalDelta = JSON.stringify({ choices: [{ delta: { content: '<<<EXPLANATION>>>\nfixed timing' }, finish_reason: 'stop' }] })
  globalThis.fetch = async () => new Response(`data: ${promptDelta}\n\ndata: ${finalDelta}`)
  try {
    const streamed = await streamChat({
      provider: { id: 'test', baseUrl: 'http://test.local/v1' },
      model: 'test-model',
      messages: [{ role: 'user', content: 'prompt' }],
      temperature: 0.2,
      maxTokens: 0,
      onDelta() {},
    })
    const parsed = workflowModule?.splitPromptReplacement(streamed.text)
    check('stream parser: keeps a final llama SSE frame without a blank-line terminator',
      parsed?.prompt === 'canonical' && parsed?.explanation === 'fixed timing' && streamed.finishReason === 'stop',
      JSON.stringify({ text: streamed.text, finishReason: streamed.finishReason }))
  } finally {
    globalThis.fetch = originalFetch
  }
}

check('standing: source description does not reference the retired stage regime', (() => {
  const standing = classifyInput('integrated_multimodal_description: a complete prompt\noverall_soundscape: rain on glass\nnon_diegetic_music: N/A')
  const text = standingToText(standing)
  return standing.suggest === 'revise' && !/Before Direct|After Direct|After Draft|ready for Critique|before Draft|Direct → Draft → Critique → Revise/i.test(text)
})())

{
  const built = {
    text: '# Loaded skills\n\n<skill name="Test Skill" file="SKILL.md">\nUNIQUE SKILL BODY\n</skill>',
    hash: 'test',
    tokens: 10,
    parts: [{ skillId: 'test', skillName: 'Test Skill', rel: 'SKILL.md', tokens: 4 }],
  }
  const studioPrompt = buildH3SystemPrompt(built, 'studio')
  const agentPrompt = buildH3SystemPrompt(built, 'agent')
  const storyModePrompt = buildStudioSystemPrompt(built, 'story')
  const promptModePrompt = buildStudioSystemPrompt(built, 'prompt')
  const ideaModePrompt = buildStudioSystemPrompt(built, 'idea')
  const count = (haystack, needle) => haystack.split(needle).length - 1
  check('H3 system prompt: Studio includes the complete selected skill context once', count(studioPrompt, built.text) === 1 && count(studioPrompt, 'UNIQUE SKILL BODY') === 1)
  check('H3 system prompt: Agent includes the complete selected skill context once plus Agent rules', count(agentPrompt, built.text) === 1 && count(agentPrompt, 'UNIQUE SKILL BODY') === 1 && agentPrompt.includes('deterministic Studio tools'))
  check('H3 system prompt: surfaces have distinct operational rules', studioPrompt.includes('Studio authoring surface') && !studioPrompt.includes('deterministic Studio tools') && agentPrompt.includes('deterministic Studio tools'))
  check('Studio system prompt: each entry mode has a non-empty, distinct contract',
    storyModePrompt.length > 500 && promptModePrompt.length > 500 && ideaModePrompt.length > 500 &&
    storyModePrompt !== promptModePrompt && promptModePrompt !== ideaModePrompt && storyModePrompt !== ideaModePrompt)
  check('H3 system prompt: Studio surface routes the selected entry mode',
    buildH3SystemPrompt(built, 'studio', 'prompt') === promptModePrompt)
  check('H3 system prompt: human-readable entry contract names match approved Studio terminology',
    storyModePrompt.includes('SCENE (MULTI-SHOT) MODE') &&
    promptModePrompt.includes('PROMPT MODE') &&
    ideaModePrompt.includes('CLIP MODE') &&
    !storyModePrompt.includes('STORY MODE') && !ideaModePrompt.includes('IDEA MODE'))
  check('Studio system prompt: selected skills remain one contiguous block per mode',
    count(storyModePrompt, built.text) === 1 && count(promptModePrompt, built.text) === 1 && count(ideaModePrompt, built.text) === 1 &&
    count(storyModePrompt, 'UNIQUE SKILL BODY') === 1 && count(promptModePrompt, 'UNIQUE SKILL BODY') === 1 && count(ideaModePrompt, 'UNIQUE SKILL BODY') === 1)
  check('Studio system prompt: contracts explain how to specify and build the canonical prompt',
    [storyModePrompt, promptModePrompt, ideaModePrompt].every((prompt) =>
      prompt.includes('canonical prompt') && prompt.includes('integrated_multimodal_description') && prompt.includes('overall_soundscape')))
  check('Studio system prompt: mode contracts route to their intended authoring process',
    storyModePrompt.toLowerCase().includes('extract the narrative spine') && storyModePrompt.includes('continuity-safe clips') &&
    promptModePrompt.includes('one complete replacement') && promptModePrompt.includes('surgical') &&
    ideaModePrompt.toLowerCase().includes('resolve the core moment') && ideaModePrompt.includes('submission-ready prompt'))
  check('Studio system prompt: missing context still returns a mode contract',
    buildStudioSystemPrompt(undefined, 'idea').toLowerCase().includes('clip mode') && buildStudioSystemPrompt(undefined, 'idea').includes('# No selected H3 skills'))
  check('H3 system prompt: Agent contract stays Agent-specific after Studio mode split',
    agentPrompt.includes('deterministic Studio tools') && !agentPrompt.includes('Idea mode') && !agentPrompt.includes('continuity-safe clips'))
}

check('continuation plates: a replaced frame is scoped to its source clip',
  continuationPlateIsFresh({ mode: 'replaced', fromClipId: 'clip-2' }, 'clip-2') && !continuationPlateIsFresh({ mode: 'replaced', fromClipId: 'clip-1' }, 'clip-2') && continuationPlateIsFresh({ mode: 'carried' }, 'clip-2'))

check('continuation context: hand-off override comes from the selected clip', (() => {
  const override = continuationContextOverride({ prompt: 'historical prompt', film: { role: 'rising', spine: 'one film', precedes: 'last frame', follows: 'next beat' } })
  return override.current === 'historical prompt' && override.film?.spine === 'one film' && override.film?.precedes === 'last frame'
})())

check('continuation history: prior versions remain before the new hand-off', (() => {
  const first = { id: 'v1' }
  const second = { id: 'v2' }
  const handoff = { id: 'handoff' }
  const next = appendContinuationHistory([first, second], handoff)
  return next.length === 3 && next[0] === first && next[1] === second && next[2] === handoff
})())

{
  const calls = []
  let cancelled = true
  const stoppedBeforeDirect = await authorContinuation(async (stage) => { calls.push(stage); return { stage } }, () => cancelled)
  check('continuation cancellation: a stop before Direct prevents every authoring call', stoppedBeforeDirect === 'aborted' && calls.length === 0)
  cancelled = false
  const callsAfterDirect = []
  const stoppedBeforeDraft = await authorContinuation(async (stage) => { callsAfterDirect.push(stage); cancelled = true; return { stage } }, () => cancelled)
  check('continuation cancellation: a stop between Direct and Draft prevents Draft', stoppedBeforeDraft === 'aborted' && JSON.stringify(callsAfterDirect) === JSON.stringify(['direct']))
}

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`)
  }
}

// ── splitReply ──────────────────────────────────────────────────────────

{
  const raw = '<<<PROMPT>>>\nthe prompt body\n<<<EXPLANATION>>>\nwhy it is this way\n<<<CHANGES>>>\n- one edit'
  const r = splitReply(raw)
  check(
    'splitReply: PROMPT, EXPLANATION, CHANGES in order',
    r.prompt === 'the prompt body' && r.explanation === 'why it is this way' && r.changelog.length === 1 && r.changelog[0] === 'one edit',
    JSON.stringify(r),
  )
}

{
  // Reversed order — the parser must not assume a fixed order.
  const raw = '<<<CHANGES>>>\n- one edit\n<<<EXPLANATION>>>\nwhy it is this way\n<<<PROMPT>>>\nthe prompt body'
  const r = splitReply(raw)
  check(
    'splitReply: reversed block order',
    r.prompt === 'the prompt body' && r.explanation === 'why it is this way' && r.changelog.length === 1 && r.changelog[0] === 'one edit',
    JSON.stringify(r),
  )
}

{
  const raw = JSON.stringify({ prompt: 'the prompt body', explanation: 'why', changes: ['edit one', 'edit two'] })
  const r = splitReply(raw)
  check(
    'splitReply: bare JSON reply',
    r.prompt === 'the prompt body' && r.explanation === 'why' && r.changelog.length === 2,
    JSON.stringify(r),
  )
}

{
  const raw = '```json\n' + JSON.stringify({ prompt: 'the prompt body', explanation: 'why', changes: 'a single change line' }) + '\n```'
  const r = splitReply(raw)
  check(
    'splitReply: fenced JSON reply, changes as a string',
    r.prompt === 'the prompt body' && r.explanation === 'why' && r.changelog.length === 1 && r.changelog[0] === 'a single change line',
    JSON.stringify(r),
  )
}

{
  const raw = 'integrated_multimodal_description: just the prompt text, no markers at all'
  const r = splitReply(raw)
  check('splitReply: unmarked reply is all prompt', r.prompt === raw && r.explanation === '' && r.changelog.length === 0, JSON.stringify(r))
}

// ── stitch ──────────────────────────────────────────────────────────────

{
  const old = 'She stands at the window, watching the rain fall on the empty street below her'
  const overlap = old.slice(-40) // exactly the 40-char tail
  const fresh = ' and thinks about nothing at all.'
  const { joined, appended } = stitch(old, overlap + fresh)
  check(
    'stitch: removes a 40-char overlap',
    joined === old + fresh && appended === fresh,
    JSON.stringify({ joined, appended }),
  )
}

{
  const old = 'the first half of the sentence'
  const fresh = ' — and the second half, which shares nothing with the first.'
  const { joined, appended } = stitch(old, fresh)
  check('stitch: a non-overlapping join is left untouched', joined === old + fresh && appended === fresh, JSON.stringify({ joined, appended }))
}

// ── classifyInput ─────────────────────────────────────────────────────────

{
  const prompt = `integrated_multimodal_description: A woman walks into a room.
overall_soundscape: footsteps on tile, 0-3s.
non_diegetic_music: N/A`
  const s = classifyInput(prompt)
  check('classifyInput: canonical prompt -> prompt', s.kind === 'prompt', s.kind)
}

{
  const rough = `**Integrated Multimodal Description**: A woman walks into a room, camera dollies in.
**Overall Soundscape**: footsteps on tile.
**Non Diegetic Music**: N/A`
  const s = classifyInput(rough)
  check('classifyInput: markdown-bolded fields -> rough-prompt', s.kind === 'rough-prompt', s.kind)
}

{
  const shotlist = `0:00-0:03 wide shot, dolly in on the doorway.
0:03-0:06 cut to close-up, handheld, 35mm.
0:06-0:09 medium shot, tracking, rack focus to her hand.`
  const s = classifyInput(shotlist)
  check('classifyInput: timecoded shot list with no fields -> rough-prompt', s.kind === 'rough-prompt', s.kind)
}

{
  const story = `Lira had walked the length of the gantry bay twice already, and each time she
told herself it was the last. The fragment sat where it had always sat, dull
and small against the deck plate, and she had known what it meant since the
first time she saw it catch the light.

She did not pick it up right away. Instead she stood there, the cold coming
up through the soles of her boots, and let the silence do what she could not
quite bring herself to do — decide.`
  const s = classifyInput(story)
  check('classifyInput: two narrative paragraphs -> story', s.kind === 'story', s.kind)
}

{
  const sheet = `WHAT THE BRIEF FIXES
- a woman enters a shop
- she says nothing
- the scene ends on her hand touching the counter

FIVE ANCHORS
1. the bell above the door
2. the dust on the shelf
...`
  const s = classifyInput(sheet)
  check('classifyInput: "WHAT THE BRIEF FIXES" -> direction-sheet', s.kind === 'direction-sheet', s.kind)
}

// A short story in the PRESENT tense, containing the ordinary phrase "for a
// long minute", was read as a brief — one loose spec substring outvoting the
// prose. Both halves of that are now regression-tested.
check('classifyInput: present-tense story is not a brief', () => {
  const story = `Mira has kept her father's watch repair shop shut since he died. On a wet Tuesday a boy of about nine knocks and holds up a cheap plastic watch with a cracked face. She tells him the shop is closed. He waits on the step in the rain anyway.

She watches him through the glass for a long minute. Then she unlocks the door, sits him at her father's bench, and takes out the loupe she has not touched in two years. She opens the watch. It is beyond saving.`
  const s = classifyInput(story)
  return s.kind === 'story' ? true : `got ${s.kind}`
})

// A soundscape reading "tense, moody" names a MOOD, not a source — claiming
// otherwise contradicts the linter's own finding, and the field NAME
// containing the word "sound" was what triggered it.
check('classifyInput: a mood is not a named sound source', () => {
  const rough = `**Integrated Multimodal Description**: A woman walks into a shop at dusk.
[0-3s] wide shot, handheld
**Overall Soundscape**: tense, moody
16:9, 10 seconds`
  const s = classifyInput(rough)
  if (s.kind !== 'rough-prompt') return `kind ${s.kind}`
  if (!s.lacks.some((l) => /sound sources/.test(l))) return 'claimed sound sources are named'
  if (s.has.some((h) => /official field structure/.test(h))) return 'claimed the official field structure is present'
  return true
})

// ── parseBreakdown ──────────────────────────────────────────────────────

{
  const raw =
    '```json\n' +
    JSON.stringify({
      spine: 'A woman decides to stay.',
      clips: [
        { index: 1, title: 'Arrival', role: 'opening', seconds: 8, covers: 'she arrives at the shop', precedes: '', follows: 'she is inside' },
        { index: 2, title: 'The decision', role: 'closing', seconds: 10, covers: 'she decides to stay', precedes: 'she is inside', follows: '' },
      ],
    }) +
    '\n```'
  const b = parseBreakdown(raw)
  check(
    'parseBreakdown: fenced JSON with two clips',
    !!b && b.spine === 'A woman decides to stay.' && b.clips.length === 2 && b.clips[0].role === 'opening' && b.clips[1].role === 'closing',
    JSON.stringify(b),
  )
}

// ── multiclip ─────────────────────────────────────────────────────────────

{
  const results = [124, 122, 125].map(snapUp)
  const onGrid = results.every((n) => (n - 5) % 17 === 0)
  check(
    'snapUp: fixed points 124->124, 122->124, 125->141, every result on the 17k+5 grid',
    onGrid && results[0] === 124 && results[1] === 124 && results[2] === 141,
    JSON.stringify(results),
  )
}

{
  // h3-shots measured 4 shots authored at 1176f/49.000s (agla-station shots
  // 1-4); submitted at their authored lengths UNPADDED they delivered
  // 1110f/46.250s — short by exactly 66f, 3 boundaries x 22. padForOverlap
  // exists to pay that tax: every clip after the first is asked to RENDER
  // authored+overlap (re-snapped up), so the trim has something to remove
  // without eating into the frames the clip was authored for.
  const frames = [294, 294, 294, 294] // 1176 frames / 49.000s authored, total
  const overlap = 22
  const padded = padForOverlap(frames.map((f) => ({ frames: f })), overlap)
  const totalAuthored = padded.reduce((a, p) => a + p.authored, 0)
  const boundariesPayTheTax = padded
    .slice(1)
    .every((p) => p.rendered === snapUp(p.authored + overlap) && p.delivered === p.rendered - overlap)
  check(
    'padForOverlap: 4 clips at 1176f/49.000s authored, first clip untouched, 3 boundaries pay authored+overlap',
    totalAuthored === 1176 &&
      padded[0].authored === 294 && padded[0].rendered === 294 && padded[0].delivered === 294 &&
      boundariesPayTheTax,
    JSON.stringify(padded),
  )
}

{
  const clips = [
    { index: 1, prompt: '' },
    { index: 2, prompt: 'a clip with real content' },
  ]
  const issues = multiclipIssues({ graph: null, clips, plateCount: 10, steps: 5 })
  check(
    'multiclipIssues: catches a missing prompt, 10 plates over the cap, and steps under the floor',
    issues.some((i) => /Clip 1 has no prompt/.test(i)) &&
      issues.some((i) => /10 plates exceeds/.test(i)) &&
      issues.some((i) => /5 steps is below the floor/.test(i)),
    JSON.stringify(issues),
  )
}

{
  const clips = [{ index: 1, prompt: 'the actor faces <Subject 3> across the room' }]
  const issues = multiclipIssues({ graph: null, clips, plateCount: 2, steps: 8 })
  check(
    'multiclipIssues: catches <Subject 3> cited with only 2 plates bound',
    issues.some((i) => /Clip 1 cites <Subject 3> but only 2 plate\(s\) are bound/.test(i)),
    JSON.stringify(issues),
  )
}

{
  // A minimal, hand-written Long Media graph — just enough of each class
  // buildMulticlipGraph looks for, identified by class_type rather than node
  // number. save1's `video` traces to combine1, whose `images` is decode1, so
  // it is the one SaveVideo on the branch even though it is not node "1".
  const graph = {
    decode1: { class_type: 'MiniMaxH3LatentLabLongMediaDecode', inputs: {} },
    combine1: { class_type: 'VHS_VideoCombine', inputs: { images: ['decode1', 0] } },
    save1: { class_type: 'SaveVideo', inputs: { video: ['combine1', 0], filename_prefix: 'old' } },
    setup1: {
      class_type: 'MiniMaxH3LatentLabLongMediaSetup',
      inputs: {
        overlap_frames: 22,
        image_1: ['oldLoader', 0],
        image_3: ['oldLoader2', 0],
        prompt: 'stale prompt the workflow shipped with',
        width: 100,
        height: 100,
        workflow_mode: 'ref2va_full',
        multiclip_json: '',
        manual_duration: 0,
      },
    },
    sampler1: { class_type: 'MiniMaxH3LatentLabLongMediaSampler', inputs: { seed: 0, refine_steps: 'auto' } },
    sched1: { class_type: 'BasicScheduler', inputs: { steps: 20 } },
    oldLoader: { class_type: 'LoadImage', inputs: { image: 'unused.png' } },
    oldLoader2: { class_type: 'LoadImage', inputs: { image: 'unused2.png' } },
  }

  const clips = [
    { prompt: 'Clip one prompt, <Subject 1> enters the frame.', seconds: 5, seed: 11 },
    { prompt: 'Clip two prompt, she turns to face <Subject 1>.', seconds: 3, seed: 12 },
  ]
  const plates = [
    { filename: 'a.png', subfolder: '' },
    { filename: 'b.png', subfolder: 'sub' },
  ]

  const result = buildMulticlipGraph({
    graph, clips, plates, width: 960, height: 544, steps: 8, seed: 42, filenamePrefix: 'run1',
  })

  const setupOut = result.graph.setup1.inputs
  const entries = JSON.parse(setupOut.multiclip_json)
  const threeDp = entries.every((e) => Math.round(e.duration * 1000) / 1000 === e.duration)
  const expectedManual = +(result.padded.reduce((a, p) => a + p.rendered, 0) / 24).toFixed(3)
  const imagesRewired =
    Array.isArray(setupOut.image_1) && setupOut.image_1[0] === 'mcref0' &&
    Array.isArray(setupOut.image_2) && setupOut.image_2[0] === 'mcref1' &&
    setupOut.image_3 === undefined &&
    result.graph.mcref0.inputs.image === 'a.png' &&
    result.graph.mcref1.inputs.image === 'sub/b.png'

  check(
    'buildMulticlipGraph: mode, per-clip durations, prompt inheritance, refine_steps coercion, manual_duration, image rewiring',
    setupOut.workflow_mode === 'multiclip' &&
      entries.length === clips.length &&
      threeDp &&
      setupOut.prompt === clips[0].prompt &&
      result.graph.sampler1.inputs.refine_steps === 2 &&
      setupOut.manual_duration === expectedManual &&
      imagesRewired,
    JSON.stringify({ setupOut, entries, expectedManual }),
  )
}

// h3-shots never had to snap its FIRST clip — its frame counts come from a
// project file already on the grid. Here they come from a plan's seconds, and
// snapFrames bottoms out at 5, so a short clip 1 could render fewer frames
// than H3's 124 floor while every clip after it was lifted to it.
check('padForOverlap: clip 1 gets the 124-frame floor too', () => {
  const [first] = padForOverlap([{ frames: 73 }, { frames: 294 }], 22)
  if (first.rendered !== 124) return `clip 1 rendered ${first.rendered}, expected 124`
  if (first.delivered !== 124) return `clip 1 delivered ${first.delivered}`
  return true
})

check('padForOverlap: an on-grid clip 1 is left exactly as authored', () => {
  const [first] = padForOverlap([{ frames: 294 }, { frames: 294 }], 22)
  return first.rendered === 294 ? true : `clip 1 rendered ${first.rendered}, expected 294`
})

// The graph is submitted whole, so a second output branch renders too.
check('multiclipWarnings: a second SaveVideo branch is called out', () => {
  const g = {
    s: { class_type: 'MiniMaxH3LatentLabLongMediaSetup', inputs: {} },
    m: { class_type: 'MiniMaxH3LatentLabLongMediaSampler', inputs: {} },
    d: { class_type: 'MiniMaxH3LatentLabLongMediaDecode', inputs: {} },
    b: { class_type: 'BasicScheduler', inputs: { steps: 6 } },
    combine: { class_type: 'CreateVideo', inputs: { images: ['d', 0] } },
    save: { class_type: 'SaveVideo', inputs: { video: ['combine', 0] } },
    other: { class_type: 'SaveVideo', inputs: { video: ['elsewhere', 0] } },
    elsewhere: { class_type: 'CreateVideo', inputs: { images: ['somethingelse', 0] } },
  }
  const w = multiclipWarnings(g)
  if (w.length !== 1) return `got ${w.length} warnings`
  return /other SaveVideo/.test(w[0]) ? true : w[0]
})

// Three measured join failures against thinkingcap-27b on a numbered list,
// all of which fused two values into one line. Each is now a fixed case.
check('toLineBoundary: a text already ending on a newline keeps it', () => {
  const b = toLineBoundary('106\n107\n')
  if (b.base !== '106\n107\n') return `base ${JSON.stringify(b.base)}`
  return b.dropped === '' ? true : `dropped ${JSON.stringify(b.dropped)}`
})

check('toLineBoundary: a short partial line is discarded', () => {
  const b = toLineBoundary('87\n88\n8')
  if (b.base !== '87\n88') return `base ${JSON.stringify(b.base)}`
  return b.dropped === '8' ? true : `dropped ${JSON.stringify(b.dropped)}`
})

check('toLineBoundary: a paragraph-length partial line is kept whole', () => {
  const long = 'x'.repeat(500)
  const b = toLineBoundary(`detailed_description:\n${long}`)
  return b.dropped === '' && b.base.endsWith(long) ? true : 'the long line was discarded'
})

check('appendedFor: a boundary join always supplies exactly one newline', () => {
  // The model continues with "108" and no newline of its own — the fusion case.
  if (appendedFor('106\n107', '108\n109', true) !== '\n108\n109') return 'no newline supplied'
  // And it must not double one up when the model does write one.
  if (appendedFor('106\n107', '\n108', true) !== '\n108') return 'newline doubled'
  // Off the boundary path the text is attached as-is.
  if (appendedFor('a sentence that ', 'continues here', false) !== 'continues here') return 'altered a mid-line join'
  return true
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
