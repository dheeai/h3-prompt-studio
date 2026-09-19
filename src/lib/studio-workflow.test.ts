import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipsNeedingPrompt, isCanonicalPromptStage, studioActions } from './studio-workflow'
import type { Breakdown, BreakdownClip, Version } from './types'

function planClip(index: number, over: Partial<BreakdownClip> = {}): BreakdownClip {
  return { index, title: `clip ${index}`, role: 'rising', seconds: 7, covers: '', precedes: '', follows: '', ...over }
}

function draftVersion(clipIndex: number): Version {
  return {
    id: `v${clipIndex}`, stage: 'draft', label: 'Draft', text: `prompt ${clipIndex}`,
    model: 'm', providerId: 'p', at: 0, ms: 0, clipIndex,
  }
}

// ── clipsNeedingPrompt — the gate behind "Generate the rest" ───────────────

test('clipsNeedingPrompt: skips a clip that already has a prompt, authors the rest', () => {
  const breakdown: Breakdown = { spine: 'a film', at: 0, clips: [planClip(1), planClip(2), planClip(3)] }
  const remaining = clipsNeedingPrompt(breakdown, [draftVersion(1)])
  assert.deepEqual(remaining.map((c) => c.index), [2, 3])
})

test('clipsNeedingPrompt: every clip already authored means nothing left to do', () => {
  const breakdown: Breakdown = { spine: 'a film', at: 0, clips: [planClip(1), planClip(2)] }
  const remaining = clipsNeedingPrompt(breakdown, [draftVersion(1), draftVersion(2)])
  assert.deepEqual(remaining, [])
})

test('clipsNeedingPrompt: nothing authored means the whole plan is remaining, in order', () => {
  const breakdown: Breakdown = { spine: 'a film', at: 0, clips: [planClip(1), planClip(2), planClip(3)] }
  const remaining = clipsNeedingPrompt(breakdown, [])
  assert.deepEqual(remaining.map((c) => c.index), [1, 2, 3])
})

test('clipsNeedingPrompt: a non-prompt pass (e.g. critique) for a clip does not count as "has a prompt"', () => {
  const breakdown: Breakdown = { spine: 'a film', at: 0, clips: [planClip(1)] }
  const critiqueOnly: Version = { id: 'v1', stage: 'critique', label: 'Critique', text: 'notes', model: 'm', providerId: 'p', at: 0, ms: 0, clipIndex: 1 }
  const remaining = clipsNeedingPrompt(breakdown, [critiqueOnly])
  assert.deepEqual(remaining.map((c) => c.index), [1])
})

// ── isCanonicalPromptStage — every writer stage, across all three presets ──

test('isCanonicalPromptStage: draft, draftDirected and draftOptimised (the three presets\' writers) all count', () => {
  assert.ok(isCanonicalPromptStage('draft'))
  assert.ok(isCanonicalPromptStage('draftDirected'))
  assert.ok(isCanonicalPromptStage('draftOptimised'))
})

test('isCanonicalPromptStage: revise, rebuild and freeform also count; direct, critique, handoff and breakdown do not', () => {
  assert.ok(isCanonicalPromptStage('revise'))
  assert.ok(isCanonicalPromptStage('rebuild'))
  assert.ok(isCanonicalPromptStage('freeform'))
  assert.ok(!isCanonicalPromptStage('direct'))
  assert.ok(!isCanonicalPromptStage('critique'))
  assert.ok(!isCanonicalPromptStage('handoff'))
  assert.ok(!isCanonicalPromptStage('breakdown'))
})

test('the single-clip door runs preset C, not preset A', () => {
  // `idea` is "Break into scenes" OFF — one clip, one call. Measured over 3
  // samples x 7 held-out cases: C 0.751 (1 call) vs B 0.708 (3 calls), C
  // winning 6/7. If this ever reads 'draft' again the single-clip path has
  // silently reverted to the unoptimised writer.
  const actions = studioActions('idea', false)
  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].stages, ['draftOptimised'])
})

test('Full Story keeps `draft`, so the preset switch still governs multi-clip', () => {
  // Preset B writes direction and acting as inspectable artifacts, which is
  // worth more across a film than on one clip — and the C-vs-B measurement
  // was single-clip only, so it does not license changing this.
  for (const a of studioActions('story', true)) assert.deepEqual(a.stages, ['draft'])
})
