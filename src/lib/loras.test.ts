import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ACCELERATOR_LORA_RE, selectableStyleLoras, serializeLoraStack, readBakedLoraStack,
  loraStackKey, planNeedsPerSceneLoraSplit, localLoraStackOverride, resolveLoraStack, loraStackToWire,
} from './loras'
import type { ComfyNode, LoraStackEntry } from './types'

// Neutral, invented filenames throughout — these tests exist to prove the
// percent-encoding round-trip is byte-exact, not to name a real LoRA.
const STYLE_A = 'studio_glow_v2.safetensors'
const STYLE_B_ENCODED = 'Neon%20Skyline%20Style%20-%20MinimaxH3.safetensors'
const CANONICAL_TURBO_LORA = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

test('serializeLoraStack matches the exact shape an LTX_lora_loader parses, byte-exact filenames included', () => {
  const stack: LoraStackEntry[] = [
    { lora: STYLE_A, strength: 0.5, on: true },
    { lora: STYLE_B_ENCODED, strength: 0.7, on: false },
  ]
  const json = serializeLoraStack(stack)
  assert.deepStrictEqual(JSON.parse(json), [
    { on: true, lora: STYLE_A, str: 0.5, v: 1, a: 1, t: 1 },
    { on: false, lora: STYLE_B_ENCODED, str: 0.7, v: 1, a: 1, t: 1 },
  ])
  // The %20-laden filename must survive round-trip without being decoded or re-encoded.
  assert.ok(json.includes(STYLE_B_ENCODED))
})

test('readBakedLoraStack reads back what serializeLoraStack wrote, round-trip', () => {
  const stack: LoraStackEntry[] = [
    { lora: STYLE_A, strength: 0.5, on: true },
    { lora: STYLE_B_ENCODED, strength: 1, on: false },
  ]
  const graph: Record<string, ComfyNode> = {
    98: { class_type: 'LTX_lora_loader', inputs: { mode: 'minimax', stack_data: serializeLoraStack(stack), model: ['66', 0] } },
  }
  assert.deepStrictEqual(readBakedLoraStack(graph), stack)
})

test('readBakedLoraStack reads a graph\'s own baked default', () => {
  const graph: Record<string, ComfyNode> = {
    98: {
      class_type: 'LTX_lora_loader',
      inputs: { stack_data: '[{"on": true, "lora": "studio_glow_v2.safetensors", "str": 0.5, "v": 1, "a": 1, "t": 1}]' },
    },
  }
  assert.deepStrictEqual(readBakedLoraStack(graph), [{ lora: 'studio_glow_v2.safetensors', strength: 0.5, on: true }])
})

test('readBakedLoraStack never throws — no node, and malformed JSON, both read as empty', () => {
  assert.deepStrictEqual(readBakedLoraStack(null), [])
  assert.deepStrictEqual(readBakedLoraStack({}), [])
  assert.deepStrictEqual(
    readBakedLoraStack({ 98: { class_type: 'LTX_lora_loader', inputs: { stack_data: 'not json' } } }),
    [],
  )
})

test('localLoraStackOverride: absent/empty/malformed all read as empty — the public build gets nothing', () => {
  assert.deepStrictEqual(localLoraStackOverride(undefined), [])
  assert.deepStrictEqual(localLoraStackOverride(''), [])
  assert.deepStrictEqual(localLoraStackOverride('not json'), [])
})

test('localLoraStackOverride: parses VITE_LOCAL_LORA_STACK the same shape serializeLoraStack writes', () => {
  const stack: LoraStackEntry[] = [
    { lora: STYLE_A, strength: 0.5, on: true },
    { lora: STYLE_B_ENCODED, strength: 1, on: true },
  ]
  assert.deepStrictEqual(localLoraStackOverride(serializeLoraStack(stack)), stack)
})

test('ACCELERATOR_LORA_RE catches the canonical turbo LoRA and the fl2v/lightx2v family, never a style LoRA', () => {
  assert.ok(ACCELERATOR_LORA_RE.test(CANONICAL_TURBO_LORA))
  assert.ok(ACCELERATOR_LORA_RE.test('minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'))
  assert.ok(ACCELERATOR_LORA_RE.test('lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank16_bf16.safetensors'))
  assert.ok(!ACCELERATOR_LORA_RE.test(STYLE_A))
})

test('selectableStyleLoras excludes the accelerator family, and nothing else — any other LoRA the box offers is selectable', () => {
  const all = [
    STYLE_A,
    CANONICAL_TURBO_LORA,
    'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors',
    STYLE_B_ENCODED,
  ]
  assert.deepStrictEqual(selectableStyleLoras(all), [STYLE_A, STYLE_B_ENCODED])
})

test('loraStackKey treats "unset" as its own value, distinct from an explicit empty or identical stack', () => {
  const a: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.5, on: true }]
  const b: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.5, on: true }]
  assert.equal(loraStackKey(a), loraStackKey(b), 'two explicit stacks with identical content compare equal')
  assert.notEqual(loraStackKey(undefined), loraStackKey(a), 'unset never compares equal to an explicit stack, even a matching one')
  assert.notEqual(loraStackKey(undefined), loraStackKey([]), 'unset never compares equal to an explicit empty stack')
})

test('planNeedsPerSceneLoraSplit: false when every clip is unset, or every clip explicitly agrees; true the moment one differs', () => {
  const a: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.5, on: true }]
  const b: LoraStackEntry[] = [{ lora: STYLE_B_ENCODED, strength: 0.5, on: true }]

  assert.equal(planNeedsPerSceneLoraSplit([undefined, undefined, undefined]), false, 'nobody customized anything')
  assert.equal(planNeedsPerSceneLoraSplit([a, a, a]), false, 'every clip explicitly agrees')
  assert.equal(planNeedsPerSceneLoraSplit([a]), false, 'a single-clip plan never needs to split')
  assert.equal(planNeedsPerSceneLoraSplit([]), false)
  assert.equal(planNeedsPerSceneLoraSplit([a, b, a]), true, 'one clip differs')
  assert.equal(planNeedsPerSceneLoraSplit([undefined, a]), true, 'unset vs. customized still counts as differing')
})

// ── resolveLoraStack / loraStackToWire — Full Story mode's film-wide
// default with a per-clip override (founder brief: "the story mode doesn't
// have the lora selection") ─────────────────────────────────────────────

test('resolveLoraStack: an unset clip with no film default falls all the way through to the workflow default', () => {
  const workflowDefault: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.4, on: true }]
  assert.deepStrictEqual(resolveLoraStack(undefined, undefined, workflowDefault), workflowDefault)
})

test('resolveLoraStack: an unset clip inherits the film-wide default over the workflow default', () => {
  const filmStack: LoraStackEntry[] = [{ lora: STYLE_B_ENCODED, strength: 0.6, on: true }]
  const workflowDefault: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.4, on: true }]
  assert.deepStrictEqual(resolveLoraStack(undefined, filmStack, workflowDefault), filmStack)
})

test('resolveLoraStack: an explicit per-clip stack wins over both the film-wide and the workflow default', () => {
  const clipStack: LoraStackEntry[] = [{ lora: 'clip_only.safetensors', strength: 0.9, on: true }]
  const filmStack: LoraStackEntry[] = [{ lora: STYLE_B_ENCODED, strength: 0.6, on: true }]
  const workflowDefault: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.4, on: true }]
  assert.deepStrictEqual(resolveLoraStack(clipStack, filmStack, workflowDefault), clipStack)
})

test('resolveLoraStack: an explicit empty stack (no style LoRA at all) is respected, never treated as "unset"', () => {
  const filmStack: LoraStackEntry[] = [{ lora: STYLE_B_ENCODED, strength: 0.6, on: true }]
  assert.deepStrictEqual(resolveLoraStack([], filmStack, [{ lora: STYLE_A, strength: 0.4, on: true }]), [])
})

test('loraStackToWire matches serializeLoraStack\'s own per-entry shape, unstringified', () => {
  const stack: LoraStackEntry[] = [{ lora: STYLE_A, strength: 0.5, on: true }]
  assert.deepStrictEqual(loraStackToWire(stack), JSON.parse(serializeLoraStack(stack)))
})
