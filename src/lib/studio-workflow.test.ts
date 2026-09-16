import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipsNeedingPrompt } from './studio-workflow'
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
