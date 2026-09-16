import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_HEIGHT, FALLBACK_WIDTH, GEOMETRY_PRESETS, OOM_HEIGHT, OOM_WIDTH, makeRecipe, oomRisk } from './recipe'
import type { ComfyNode } from './types'

// ── makeRecipe's geometry fallback — the live hazard ───────────────────────

test('makeRecipe: a WIRED geometry (a link, not a literal) falls back to the validated 1216x672, never the OOM tier', () => {
  const graph: Record<string, ComfyNode> = {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { width: ['w', 0], height: ['h', 0], length: ['l', 0] } },
    w: { class_type: 'PrimitiveInt', inputs: { value: 864 } },
    h: { class_type: 'PrimitiveInt', inputs: { value: 480 } },
    l: { class_type: 'PrimitiveInt', inputs: { value: 124 } },
    out: { class_type: 'SaveVideo', inputs: {} },
  }
  // Confirm the premise: width/height are LINKS ([nodeId, outputIndex]), not
  // literal numbers — this is exactly what makes `Number(h3.inputs.width)`
  // come back NaN and fall through to the fallback.
  assert.ok(Array.isArray(graph.h3.inputs.width), 'expected width to be a wired link')
  assert.ok(Array.isArray(graph.h3.inputs.height), 'expected height to be a wired link')

  const recipe = makeRecipe('wired geometry', graph)
  assert.equal(recipe.defaults.width, 1216)
  assert.equal(recipe.defaults.height, 672)
  assert.equal(recipe.defaults.width, FALLBACK_WIDTH)
  assert.equal(recipe.defaults.height, FALLBACK_HEIGHT)
  // The bug this fixes: the fallback used to be 1344x768 — OOM_WIDTH/OOM_HEIGHT
  // themselves — so every wired-geometry recipe silently defaulted to the one
  // geometry measured to crash ComfyUI. Never again.
  assert.notEqual(recipe.defaults.width, OOM_WIDTH)
  assert.notEqual(recipe.defaults.height, OOM_HEIGHT)
})

test('makeRecipe: a literal width/height on the H3 node is read, not overridden by the fallback', () => {
  const graph: Record<string, ComfyNode> = {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { width: 864, height: 480, length: 124 } },
    out: { class_type: 'SaveVideo', inputs: {} },
  }
  const recipe = makeRecipe('literal', graph)
  assert.equal(recipe.defaults.width, 864)
  assert.equal(recipe.defaults.height, 480)
})

test('oomRisk: the new fallback geometry (1216x672) is never flagged, at any length', () => {
  assert.equal(oomRisk(FALLBACK_WIDTH, FALLBACK_HEIGHT, 10_000), false)
})

test('oomRisk: the old fallback geometry (1344x768) is exactly the OOM tier and IS flagged past 362 frames', () => {
  assert.equal(oomRisk(1344, 768, 363), true)
  assert.equal(oomRisk(1344, 768, 362), false)
})

test('GEOMETRY_PRESETS: the validated 1216x672 tier is offered as a preset, distinct from the OOM tier', () => {
  const validated = GEOMETRY_PRESETS.find((p) => p.width === 1216 && p.height === 672)
  assert.ok(validated, 'expected a 1216x672 preset')
  assert.equal(oomRisk(validated!.width, validated!.height, 10_000), false)
})
