import { test } from 'node:test'
import assert from 'node:assert/strict'
import { joinH3Sections } from './schema'
import {
  buildExportPlan,
  buildFallbackBundle,
  buildProjectJson,
  clipFileBase,
  clipMarkdown,
  exportRootName,
  parseProjectJson,
  planMarkdown,
  redactLoraStack,
  splitH3PromptSections,
} from './sessionExport'
import type { BreakdownClipLike, BuildExportPlanInput } from './sessionExport'
import type { LoraStackEntry, ShotGroup, ShotList, Version } from './types'

const REF2VA_RAW = JSON.stringify({
  subject_definitions: '<Subject 1> is a woman in a maroon saree.',
  summary: '[reference generation] A woman walks across a courtyard at dusk.',
  retention_analysis: '<Subject 1>: fully_preserved',
  detailed_description: 'Warm, restrained light. [Shot 1] She crosses the courtyard, unhurried.',
  overall_soundscape: 'Distant temple bells, a light breeze.',
  non_diegetic_music: 'N/A',
  explanation: 'Kept the identity plate fully preserved and let the courtyard carry the mood.',
})

function makeClip(over: Partial<BreakdownClipLike> = {}): BreakdownClipLike {
  return {
    index: 1,
    title: 'Arrival',
    role: 'opening',
    seconds: 12,
    covers: 'Lira arrives at the courtyard gate.',
    precedes: '',
    follows: 'the gate swings open',
    ...over,
  }
}

function makeVersion(over: Partial<Version> = {}): Version {
  const { prompt } = joinH3Sections(REF2VA_RAW, 'Ref2VA')!
  return {
    id: 'v1',
    stage: 'rebuild',
    label: 'Rebuild',
    text: prompt,
    model: 'thinkingcap-27b',
    providerId: 'localbox',
    at: 1_726_000_000_000,
    ms: 4200,
    clipIndex: 1,
    explanation: 'Kept the identity plate fully preserved.',
    ...over,
  }
}

// ── clipFileBase ────────────────────────────────────────────────────────

test('clipFileBase zero-pads to at least two digits and matches the index', () => {
  assert.equal(clipFileBase(1), 'clip01')
  assert.equal(clipFileBase(9), 'clip09')
  assert.equal(clipFileBase(12), 'clip12')
  assert.equal(clipFileBase(100), 'clip100')
})

// ── splitH3PromptSections ───────────────────────────────────────────────

test('splitH3PromptSections recovers all six Ref2VA sections from a joinH3Sections string', () => {
  const { prompt } = joinH3Sections(REF2VA_RAW, 'Ref2VA')!
  const sections = splitH3PromptSections(prompt, 'Ref2VA')
  assert.ok(sections)
  assert.deepEqual(
    sections!.map((s) => s.field),
    ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'],
  )
  assert.equal(sections!.find((s) => s.field === 'summary')!.value, '[reference generation] A woman walks across a courtyard at dusk.')
  assert.equal(sections!.find((s) => s.field === 'non_diegetic_music')!.value, 'N/A')
})

test('splitH3PromptSections returns null for text that is not the joined six-section shape', () => {
  assert.equal(splitH3PromptSections('just some free text with no section labels at all', 'Ref2VA'), null)
})

// ── redactLoraStack ─────────────────────────────────────────────────────

test('redactLoraStack keeps strength and on/off but never the filename', () => {
  const stack: LoraStackEntry[] = [
    { lora: 'Neon%20Skyline%20Style_v2.safetensors', strength: 0.8, on: true },
    { lora: 'another_real_file.safetensors', strength: 0.3, on: false },
  ]
  const redacted = redactLoraStack(stack)
  assert.deepEqual(redacted, { count: 2, entries: [{ strength: 0.8, on: true }, { strength: 0.3, on: false }] })
  assert.equal(JSON.stringify(redacted).includes('.safetensors'), false)
})

test('redactLoraStack is null for an unset or empty stack', () => {
  assert.equal(redactLoraStack(undefined), null)
  assert.equal(redactLoraStack([]), null)
})

// ── clipMarkdown ────────────────────────────────────────────────────────

test('clipMarkdown writes all six section headings and the clip meta', () => {
  const v = makeVersion()
  const md = clipMarkdown({ clip: makeClip(), mode: 'Ref2VA', promptText: v.text, explanation: v.explanation, approvedAt: v.at })
  for (const heading of [
    '## Subject definitions',
    '## Summary',
    '## Retention analysis',
    '## Detailed description',
    '## Overall soundscape',
    '## Non-diegetic music',
  ]) {
    assert.ok(md.includes(heading), `expected ${heading} in:\n${md}`)
  }
  assert.ok(md.startsWith('# Clip 01 — Arrival'))
  assert.ok(md.includes('Role: opening · 12.0s'))
  assert.ok(md.includes('Lira arrives at the courtyard gate.'))
  assert.ok(md.includes('Kept the identity plate fully preserved.'))
})

test('clipMarkdown falls back to the raw prompt when sections cannot be parsed', () => {
  const md = clipMarkdown({ clip: makeClip(), mode: 'Ref2VA', promptText: 'not a sectioned prompt', approvedAt: 0 })
  assert.ok(md.includes('sections could not be parsed'))
  assert.ok(md.includes('not a sectioned prompt'))
})

// ── planMarkdown ────────────────────────────────────────────────────────

function baseExportInput(over: Partial<BuildExportPlanInput> = {}): BuildExportPlanInput {
  const shotList: ShotList = {
    spine: 'Lira crosses the city to deliver a letter.',
    maxRuntimeSeconds: 30,
    shots: [
      { index: 1, covers: 'Lira leaves her house.', seconds: 4.5, beatIndex: 1 },
      { index: 2, covers: 'She crosses the market.', seconds: 6, beatIndex: 1 },
    ],
    beats: [{ index: 1, covers: 'Lira sets out.', weight: 1, seconds: 10.5 }],
    at: 0,
  }
  const shotGroups: ShotGroup[] = [{ index: 1, shotIndices: [1, 2], seconds: 10.5 }]
  return {
    filmName: 'Lira in the Rain',
    mode: 'Ref2VA',
    plot: 'A courier crosses a city in the rain to deliver one letter.',
    maxRuntimeSeconds: 30,
    filmLook: { freeText: 'shot on a vintage anamorphic zoom' },
    filmLoraStack: [{ lora: 'style_box.example.ts.net.safetensors', strength: 0.6, on: true }],
    shotList,
    shotGroups,
    shotGroupIssues: [],
    breakdown: { spine: shotList.spine, clips: [makeClip()] },
    versions: [makeVersion()],
    exportedAt: 1_726_000_000_000,
    ...over,
  }
}

test('planMarkdown includes the plot, beats with seconds, shots with seconds, clip groups and film look', () => {
  const md = planMarkdown(baseExportInput())
  assert.ok(md.includes('A courier crosses a city in the rain to deliver one letter.'))
  assert.ok(md.includes('(weight 1, ~10.5s) Lira sets out.'))
  assert.ok(md.includes('4.5s — Lira leaves her house.'))
  assert.ok(md.includes('6.0s — She crosses the market.'))
  assert.ok(md.includes('clip01 — shots 1-2 — 10.5s'))
  assert.ok(md.includes('shot on a vintage anamorphic zoom'))
  assert.ok(md.includes('clip01 — Arrival — opening — 12.0s'))
  assert.ok(md.includes('prompt approved'))
})

test('planMarkdown never writes the LoRA filename, only a redacted count/strength summary', () => {
  const md = planMarkdown(baseExportInput())
  assert.equal(md.includes('.safetensors'), false)
  assert.equal(md.includes('example.ts.net'), false)
  assert.ok(md.includes('1 style LoRA configured: #1 strength 0.60 (on)'))
})

// ── project.json ────────────────────────────────────────────────────────

test('buildProjectJson round-trips plot, maxRuntimeSeconds, mode, filmLook, shotList, shotGroups and breakdown clip fields', () => {
  const input = baseExportInput()
  const json = buildProjectJson(input)
  const parsed = parseProjectJson(JSON.stringify(json))
  assert.ok(parsed)
  assert.equal(parsed!.plot, input.plot)
  assert.equal(parsed!.maxRuntimeSeconds, input.maxRuntimeSeconds)
  assert.equal(parsed!.mode, input.mode)
  assert.deepEqual(parsed!.filmLook, input.filmLook)
  assert.deepEqual(parsed!.shotList, input.shotList)
  assert.deepEqual(parsed!.shotGroups, input.shotGroups)
  const clip = parsed!.breakdown!.clips[0]
  assert.equal(clip.index, 1)
  assert.equal(clip.title, 'Arrival')
  assert.equal(clip.role, 'opening')
  assert.equal(clip.seconds, 12)
  assert.equal(clip.covers, makeClip().covers)
  assert.equal(clip.prompt, input.versions[0].text)
})

test('buildProjectJson does NOT round-trip a LoRA stack filename — it is redacted on the way in', () => {
  const input = baseExportInput()
  const json = buildProjectJson(input)
  assert.deepEqual(json.filmLoraStack, redactLoraStack(input.filmLoraStack))
  assert.equal(JSON.stringify(json).includes('example.ts.net'), false)
  assert.equal(JSON.stringify(json).includes('.safetensors'), false)
})

test('parseProjectJson rejects anything that is not a formatVersion:1 object', () => {
  assert.equal(parseProjectJson('{"not":"a project"}'), null)
  assert.equal(parseProjectJson('not even json'), null)
})

// ── buildExportPlan (the write plan, as pure data) ─────────────────────

test('buildExportPlan writes plan.md, project.json and one prompts/clipNN.md per authored clip', () => {
  const files = buildExportPlan(baseExportInput())
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['plan.md', 'project.json', 'prompts/clip01.md'],
  )
})

test('buildExportPlan skips a breakdown clip with no authored prompt yet', () => {
  const input = baseExportInput({
    breakdown: { spine: 'x', clips: [makeClip({ index: 1 }), makeClip({ index: 2, title: 'Not yet' })] },
    versions: [makeVersion({ clipIndex: 1 })],
  })
  const files = buildExportPlan(input)
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['plan.md', 'project.json', 'prompts/clip01.md'],
  )
})

test('buildExportPlan honours an explicit approvedClipIndices filter', () => {
  const input = baseExportInput({
    breakdown: { spine: 'x', clips: [makeClip({ index: 1 }), makeClip({ index: 2, title: 'Second' })] },
    versions: [makeVersion({ id: 'v1', clipIndex: 1 }), makeVersion({ id: 'v2', clipIndex: 2 })],
    approvedClipIndices: [2],
  })
  const files = buildExportPlan(input)
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['plan.md', 'project.json', 'prompts/clip02.md'],
  )
})

test('buildExportPlan zero-pads clip numbering and matches the clip index for a two-digit clip', () => {
  const input = baseExportInput({
    breakdown: { spine: 'x', clips: [makeClip({ index: 12 })] },
    versions: [makeVersion({ clipIndex: 12 })],
  })
  const files = buildExportPlan(input)
  assert.ok(files.some((f) => f.path === 'prompts/clip12.md'))
})

// ── the redaction test constraint 4 demands ────────────────────────────

test('a full export plan of a session carrying a tailnet-looking LoRA filename contains no ts.net and no http anywhere', () => {
  const files = buildExportPlan(
    baseExportInput({
      filmLoraStack: [{ lora: 'style_box.example.ts.net_endpoint_http.safetensors', strength: 0.5, on: true }],
      breakdown: { spine: 'x', clips: [makeClip({ loraStack: [{ lora: 'per_clip_box.example.ts.net.safetensors', strength: 0.9, on: true }] })] },
    }),
  )
  const all = files.map((f) => f.content).join('\n')
  assert.equal(all.includes('ts.net'), false)
  assert.equal(all.includes('http'), false)
  assert.equal(all.includes('example.ts.net'), false)
  assert.equal(all.includes('.safetensors'), false)
})

test('the fallback bundle (no showDirectoryPicker) also carries no LoRA filename, ts.net or http', () => {
  const files = buildExportPlan(
    baseExportInput({ filmLoraStack: [{ lora: 'x_box.example.ts.net.safetensors', strength: 0.5, on: true }] }),
  )
  const bundle = buildFallbackBundle(files, 'Lira in the Rain')
  assert.equal(bundle.markdown.includes('ts.net'), false)
  assert.equal(bundle.json.includes('ts.net'), false)
  assert.equal(bundle.markdown.includes('http'), false)
  assert.equal(bundle.json.includes('http'), false)
})

// ── fallback bundle shape ───────────────────────────────────────────────

test('buildFallbackBundle concatenates plan.md and every prompt file into one markdown, plus project.json separately', () => {
  const files = buildExportPlan(baseExportInput())
  const bundle = buildFallbackBundle(files, 'Lira in the Rain')
  assert.equal(bundle.markdownFilename, 'Lira_in_the_Rain-plan.md')
  assert.equal(bundle.jsonFilename, 'Lira_in_the_Rain-project.json')
  assert.ok(bundle.markdown.includes('# Lira in the Rain'))
  assert.ok(bundle.markdown.includes('# Clip 01 — Arrival'))
  assert.ok(bundle.markdown.includes('## Subject definitions'))
  const parsedJson = parseProjectJson(bundle.json)
  assert.ok(parsedJson)
})

// ── filename safety ─────────────────────────────────────────────────────

test('exportRootName flattens a project name with slashes instead of creating a nested folder', () => {
  const name = exportRootName('Act 2 / the door')
  assert.equal(name.includes('/'), false)
  assert.equal(name, 'Act_2_the_door')
})

// ── provenance — which pipeline preset authored this prompt ────────────────
// The A/B is unmeasurable if a prompt on disk can't be attributed to the
// preset that wrote it (`lib/pipeline.ts`).

test('clipMarkdown states the pipeline preset when the Version carries one', () => {
  const v = makeVersion({ pipelinePreset: 'directed' })
  const md = clipMarkdown({ clip: makeClip(), mode: 'Ref2VA', promptText: v.text, approvedAt: v.at, pipelinePreset: v.pipelinePreset })
  assert.ok(md.includes('Pipeline preset: Directed'))
})

test('clipMarkdown says nothing about a preset for a prompt written before presets existed', () => {
  const v = makeVersion()
  const md = clipMarkdown({ clip: makeClip(), mode: 'Ref2VA', promptText: v.text, approvedAt: v.at })
  assert.equal(md.includes('Pipeline preset'), false)
})

test('buildProjectJson carries the pipeline preset per clip, null when the Version has none', () => {
  const directed = baseExportInput({ versions: [makeVersion({ pipelinePreset: 'directed' })] })
  const json = buildProjectJson(directed)
  assert.equal(json.breakdown!.clips[0].pipelinePreset, 'directed')

  const legacy = baseExportInput({ versions: [makeVersion()] })
  const legacyJson = buildProjectJson(legacy)
  assert.equal(legacyJson.breakdown!.clips[0].pipelinePreset, null)
})

test('buildExportPlan\'s clipNN.md reports the preset that produced it', () => {
  const input = baseExportInput({ versions: [makeVersion({ pipelinePreset: 'direct-write' })] })
  const files = buildExportPlan(input)
  const clipFile = files.find((f) => f.path === 'prompts/clip01.md')!
  assert.ok(clipFile.content.includes('Pipeline preset: Direct and write'))
})
