import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PIPELINE_PRESETS, clipAuthoringPlan, pipelinePreset, presetRunsActing, presetRunsDirection } from './pipeline'

test('exactly three presets: the founder\'s A/B, plus the GEPA-optimised C', () => {
  assert.equal(PIPELINE_PRESETS.length, 3)
  assert.deepStrictEqual(PIPELINE_PRESETS.map((p) => p.id), ['direct-write', 'directed', 'optimised'])
})

test('pipelinePreset(undefined) is preset A — an operator who never touches the switch sees no change', () => {
  assert.equal(pipelinePreset(undefined).id, 'direct-write')
})

test('pipelinePreset falls back to preset A for an id it does not recognise', () => {
  // @ts-expect-error deliberately invalid — a corrupted/old settings blob
  assert.equal(pipelinePreset('bogus').id, 'direct-write')
})

test('preset A runs neither direction nor acting, and writes via draft', () => {
  const a = pipelinePreset('direct-write')
  assert.equal(presetRunsDirection(a), false)
  assert.equal(presetRunsActing(a), false)
  assert.equal(a.writerStage, 'draft')
  assert.deepStrictEqual(a.extraStages, [])
})

test('preset B runs both direction and acting, and writes via draftDirected', () => {
  const b = pipelinePreset('directed')
  assert.equal(presetRunsDirection(b), true)
  assert.equal(presetRunsActing(b), true)
  assert.equal(b.writerStage, 'draftDirected')
})

test('clipAuthoringPlan: preset A is one call', () => {
  assert.deepStrictEqual(clipAuthoringPlan(pipelinePreset('direct-write')), ['draft'])
})

test('clipAuthoringPlan: preset B is direction, then acting, then the directed writer — never reordered', () => {
  assert.deepStrictEqual(clipAuthoringPlan(pipelinePreset('directed')), ['direction', 'acting', 'draftDirected'])
})

test('preset C runs neither direction nor acting, and writes via draftOptimised — one call, like preset A', () => {
  const c = pipelinePreset('optimised')
  assert.equal(presetRunsDirection(c), false)
  assert.equal(presetRunsActing(c), false)
  assert.equal(c.writerStage, 'draftOptimised')
  assert.deepStrictEqual(c.extraStages, [])
})

test('clipAuthoringPlan: preset C is one call', () => {
  assert.deepStrictEqual(clipAuthoringPlan(pipelinePreset('optimised')), ['draftOptimised'])
})

test('every preset name and description is operator-facing prose, not an id', () => {
  for (const p of PIPELINE_PRESETS) {
    assert.ok(p.name.length > 0 && p.name !== p.id)
    assert.ok(p.description.length > 20, `${p.id} needs a real description`)
    assert.ok(p.cost.length > 0, `${p.id} needs to state its cost`)
  }
})
