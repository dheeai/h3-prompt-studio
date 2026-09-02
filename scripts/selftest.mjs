#!/usr/bin/env node
// Run with: npx tsx scripts/selftest.mjs
//
// Deterministic unit tests for the pure functions added across llm.ts,
// stages.ts and lint.ts — no network, no browser. `llm.ts` is imported under
// plain node here (not a browser), which is the check that `location.origin`
// (used only inside the OpenRouter branch of streamChat) never gets evaluated
// for a non-OpenRouter provider — if it did, importing this file would throw.

import { fillTemplate, splitReply, parseBreakdown } from '../src/lib/stages.ts'
import { classifyInput } from '../src/lib/lint.ts'
// stitch lives in llm.ts alongside streamChatComplete; importing it here also
// proves llm.ts loads cleanly under node — see the note above.
import { stitch, toLineBoundary, appendedFor } from '../src/lib/llm.ts'
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
  entryWorkflow,
  interruptedReasoningText,
  shouldContinueStoryLoop,
} from '../src/lib/entry.ts'
import { buildAgentModel, buildAgentTools } from '../src/lib/agent.ts'

let pass = 0
let fail = 0

// ── entry modes ────────────────────────────────────────────────────────

const entryModesAreComplete = (() => {
  const modes = ENTRY_MODES.map((m) => m.id)
  return JSON.stringify(modes) === JSON.stringify(['story', 'prompt', 'idea']) &&
    entryLabel('story') === 'A story' && entryLabel('prompt') === 'A prompt' && entryLabel('idea') === 'An idea' &&
    entryAction('story') === 'Generate clip plan' && entryAction('prompt') === 'Refine prompt' && entryAction('idea') === 'Generate H3 prompt'
})()
check('entry modes: Story/Prompt/Idea have explicit copy and actions', entryModesAreComplete)
check('entry dispatch: click and keyboard share the same workflow',
  entryWorkflow('story') === 'story-plan' && entryWorkflow('prompt') === 'prompt-revise' && entryWorkflow('idea') === 'idea-prompt')
check('story loop: only a completed pass advances to the next clip',
  shouldContinueStoryLoop({ status: 'ok' }) && !shouldContinueStoryLoop({ status: 'null' }) && !shouldContinueStoryLoop({ status: 'cancelled' }) && !shouldContinueStoryLoop({ status: 'error' }))

{
  const source = continuationSource('', { precedes: 'she faces the hatch', follows: 'the hatch opens', open: 'the warning remains unresolved' })
  check('continuation source: blank note carries hand-off fields forward',
    source === 'OPEN: the warning remains unresolved\nFOLLOWS: the hatch opens\nPRECEDES: she faces the hatch', source)
  check('continuation source: an optional note takes precedence',
    continuationSource('Make the next beat quieter', { precedes: 'old state', follows: 'old future', open: 'old question' }) === 'Make the next beat quieter')
  check('continuation source: previous prompt context has a dedicated template slot',
    fillTemplate('SOURCE {{story}}\nPREVIOUS {{previous}}', { story: source, previous: 'the prompt that produced the last clip' }).includes('PREVIOUS the prompt that produced the last clip'))
}

{
  const calls = []
  const ready = await authorContinuation(async (stage) => { calls.push(stage); return { stage } })
  check('continuation authoring: Direct then Draft reaches ready', ready === 'ready' && JSON.stringify(calls) === JSON.stringify(['direct', 'draft']), JSON.stringify({ ready, calls }))
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
