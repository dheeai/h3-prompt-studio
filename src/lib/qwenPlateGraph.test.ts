import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildQwenPlateGraph, findSaveImageNodeId, QwenPlateGraphError } from './qwenPlateGraph'
import type { ComfyNode } from './types'

/** A minimal stand-in for `public/workflows/qwen21_tti.json` — one node per
 * class_type this file cares about, numbered differently from the shipped
 * graph on purpose, so a test that hardcoded a node id would fail loudly. */
function fixtureGraph(): Record<string, ComfyNode> {
  return {
    a1: { class_type: 'UNETLoader', inputs: { unet_name: 'x' } },
    a2: { class_type: 'CLIPLoader', inputs: { clip_name: 'x' } },
    a3: { class_type: 'VAELoader', inputs: { vae_name: 'x' } },
    a4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['a2', 0], prompt: 'test', negative_prompt: '', resolution: 1408 } },
    a5: { class_type: 'EmptyLatentImage', inputs: { width: 1408, height: 1408, batch_size: 1 } },
    a6: { class_type: 'KSampler', inputs: { seed: 1, steps: 25, cfg: 1.0, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['a1', 0], positive: ['a4', 0], negative: ['a4', 1], latent_image: ['a5', 0] } },
    a7: { class_type: 'VAEDecode', inputs: { samples: ['a6', 0], vae: ['a3', 0] } },
    a8: { class_type: 'SaveImage', inputs: { filename_prefix: 'dag/qwen21_image', images: ['a7', 0] } },
  }
}

test('buildQwenPlateGraph: sets the prompt on the TextEncodeQwenImage21 node, by class_type not node id', () => {
  const g = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'A woman in a blue cardigan.', width: 1024, height: 1536 })
  assert.equal(g.a4.inputs.prompt, 'A woman in a blue cardigan.')
  assert.equal(g.a4.inputs.negative_prompt, '')
})

test('buildQwenPlateGraph: sets width/height on EmptyLatentImage', () => {
  const g = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536 })
  assert.equal(g.a5.inputs.width, 1024)
  assert.equal(g.a5.inputs.height, 1536)
})

test('buildQwenPlateGraph: syncs the encode node\'s own resolution field to the larger of width/height', () => {
  const g = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536 })
  assert.equal(g.a4.inputs.resolution, 1536)
})

test('buildQwenPlateGraph: an explicit seed reaches KSampler; omitted leaves the graph\'s own baked seed alone', () => {
  const withSeed = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536, seed: 42 })
  assert.equal(withSeed.a6.inputs.seed, 42)
  const withoutSeed = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536 })
  assert.equal(withoutSeed.a6.inputs.seed, 1)
})

test('buildQwenPlateGraph: an explicit filenamePrefix reaches SaveImage; omitted leaves the graph\'s own baked prefix alone', () => {
  const withPrefix = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536, filenamePrefix: 'plates/nusrat' })
  assert.equal(withPrefix.a8.inputs.filename_prefix, 'plates/nusrat')
  const withoutPrefix = buildQwenPlateGraph({ graph: fixtureGraph(), prompt: 'p', width: 1024, height: 1536 })
  assert.equal(withoutPrefix.a8.inputs.filename_prefix, 'dag/qwen21_image')
})

test('buildQwenPlateGraph: never mutates the graph passed in — a deep clone, same discipline as buildExtenderGraph', () => {
  const original = fixtureGraph()
  const originalPromptBefore = original.a4.inputs.prompt
  buildQwenPlateGraph({ graph: original, prompt: 'a totally different prompt', width: 1024, height: 1536 })
  assert.equal(original.a4.inputs.prompt, originalPromptBefore)
})

test('buildQwenPlateGraph: throws when the graph has no TextEncodeQwenImage21 node at all', () => {
  const g = fixtureGraph()
  delete (g as any).a4
  assert.throws(() => buildQwenPlateGraph({ graph: g, prompt: 'p', width: 1024, height: 1536 }), QwenPlateGraphError)
})

test('findSaveImageNodeId: finds the SaveImage node by class_type', () => {
  assert.equal(findSaveImageNodeId(fixtureGraph()), 'a8')
})

test('findSaveImageNodeId: undefined when there is no SaveImage node', () => {
  const g = fixtureGraph()
  delete (g as any).a8
  assert.equal(findSaveImageNodeId(g), undefined)
})
