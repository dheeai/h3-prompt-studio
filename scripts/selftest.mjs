#!/usr/bin/env node
// Run with: npx tsx scripts/selftest.mjs
//
// Deterministic unit tests for the pure functions added across llm.ts,
// stages.ts and lint.ts — no network, no browser. `llm.ts` is imported under
// plain node here (not a browser), which is the check that `location.origin`
// (used only inside the OpenRouter branch of streamChat) never gets evaluated
// for a non-OpenRouter provider — if it did, importing this file would throw.

import { readFileSync } from 'node:fs'
import { DEFAULT_TEMPLATES, fillTemplate, splitReply, parseBreakdown } from '../src/lib/stages.ts'
import { classifyInput, standingToText } from '../src/lib/lint.ts'
// stitch lives in llm.ts alongside streamChatComplete; importing it here also
// proves llm.ts loads cleanly under node — see the note above.
import { stitch, toLineBoundary, appendedFor, continuationBudgetFor, streamChatComplete } from '../src/lib/llm.ts'
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

let pass = 0
let fail = 0

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
