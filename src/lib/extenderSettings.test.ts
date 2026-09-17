import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTENDER_QUALITY_TIERS,
  extenderEngineChoiceFromInputs,
  extenderEngineOverride,
  extenderQualityOverride,
  extenderQualityTierFromInputs,
  isExtenderFieldFrozen,
  mergeExtenderInputs,
  parseExtenderNodeSchema,
  turboLoraStepCount,
  withExtenderOverride,
  withExtenderOverrides,
} from './extenderSettings'

// ── which fields are frozen ─────────────────────────────────────────────────

test('isExtenderFieldFrozen: a signature field (e.g. pass2_resolution) is frozen', () => {
  assert.equal(isExtenderFieldFrozen('pass2_resolution'), true)
  assert.equal(isExtenderFieldFrozen('context_length'), true)
  assert.equal(isExtenderFieldFrozen('sla_sparsity'), true)
})

test('isExtenderFieldFrozen: a field the node never hashes is free', () => {
  assert.equal(isExtenderFieldFrozen('run_mode'), false)
  assert.equal(isExtenderFieldFrozen('smart_offload'), false)
  assert.equal(isExtenderFieldFrozen('prompt'), false)
})

// ── only-changed-fields persistence ─────────────────────────────────────────

const baked = { pass2_steps: 6, pass2_denoise: 0.25, context_length: '22' }

test('withExtenderOverride stores a field only when it differs from the baked value', () => {
  const overrides = withExtenderOverride(undefined, baked, 'pass2_steps', 8)
  assert.deepEqual(overrides, { pass2_steps: 8 })
})

test('withExtenderOverride: an untouched install (every field at its baked value) persists nothing at all', () => {
  const overrides = withExtenderOverride(undefined, baked, 'pass2_steps', 6)
  assert.equal(overrides, undefined)
})

test('withExtenderOverride: setting a field back to the baked value removes the override entirely (reset)', () => {
  const withEdit = withExtenderOverride(undefined, baked, 'pass2_steps', 8)
  const reset = withExtenderOverride(withEdit, baked, 'pass2_steps', 6)
  assert.equal(reset, undefined)
})

test('withExtenderOverride leaves OTHER already-stored overrides untouched', () => {
  const one = withExtenderOverride(undefined, baked, 'pass2_steps', 8)
  const two = withExtenderOverride(one, baked, 'pass2_denoise', 0.3)
  assert.deepEqual(two, { pass2_steps: 8, pass2_denoise: 0.3 })
  const resetOne = withExtenderOverride(two, baked, 'pass2_steps', 6)
  assert.deepEqual(resetOne, { pass2_denoise: 0.3 })
})

// ── merge / reset-to-baked ───────────────────────────────────────────────────

test('mergeExtenderInputs: no overrides is exactly the baked value', () => {
  assert.deepEqual(mergeExtenderInputs(baked, undefined), baked)
})

test('mergeExtenderInputs: an override wins over the baked value for that field only', () => {
  const merged = mergeExtenderInputs(baked, { pass2_steps: 8 })
  assert.deepEqual(merged, { pass2_steps: 8, pass2_denoise: 0.25, context_length: '22' })
})

test('mergeExtenderInputs: clearing overrides (reset all) restores exactly the graph\'s baked value', () => {
  const edited = mergeExtenderInputs(baked, { pass2_steps: 8, pass2_denoise: 0.3 })
  assert.notDeepEqual(edited, baked)
  const reset = mergeExtenderInputs(baked, undefined)
  assert.deepEqual(reset, baked)
})

test('mergeExtenderInputs: a null graph (workflow not loaded yet) is null, never a stale object', () => {
  assert.equal(mergeExtenderInputs(null, { pass2_steps: 8 }), null)
})

// ── withExtenderOverrides: multi-field patches ──────────────────────────────

test('withExtenderOverrides stores only the fields of a patch that differ from baked', () => {
  const overrides = withExtenderOverrides(undefined, baked, { pass2_steps: 8, pass2_denoise: 0.25 })
  assert.deepEqual(overrides, { pass2_steps: 8 })
})

test('withExtenderOverrides: a patch that matches baked on every field persists nothing', () => {
  const overrides = withExtenderOverrides(undefined, baked, { pass2_steps: 6, pass2_denoise: 0.25 })
  assert.equal(overrides, undefined)
})

test('withExtenderOverrides: switching back to a patch matching baked clears exactly those fields, leaving others', () => {
  const one = withExtenderOverrides(undefined, baked, { pass2_steps: 8, context_length: '39' })
  const back = withExtenderOverrides(one, baked, { pass2_steps: 6, context_length: '39' })
  assert.deepEqual(back, { context_length: '39' })
})

// ── Control 1: engine + steps — turbo LoRA filename parsing ─────────────────

test('turboLoraStepCount reads the trained step count out of a turbo LoRA filename', () => {
  assert.equal(turboLoraStepCount('minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'), '4')
  assert.equal(turboLoraStepCount('some_lightning_8step_lora.safetensors'), '8')
  assert.equal(turboLoraStepCount('lightx2v-6-step.safetensors'), '6')
})

test('turboLoraStepCount returns null when the filename does not encode a step count', () => {
  assert.equal(turboLoraStepCount('some_random_lora.safetensors'), null)
})

// ── Control 1: engine + steps — coherence ───────────────────────────────────
//
// The acceptance test the brief asks for: a turbo LoRA's own step count can
// never disagree with pdd_nfe, because extenderEngineOverride never takes
// steps as a separate input for turbo mode — it is always derived from the
// lora filename.

test('extenderEngineOverride: PDD mode sets accel_mode + the chosen step count', () => {
  assert.deepEqual(extenderEngineOverride({ mode: 'pdd', steps: '6' }, '8'), { accel_mode: 'PDD 8-step', pdd_nfe: '6' })
})

test('extenderEngineOverride: Turbo LoRA mode derives pdd_nfe from the LoRA filename, never the other way round', () => {
  const patch = extenderEngineOverride({ mode: 'turbo', lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors' }, '8')
  assert.deepEqual(patch, {
    accel_mode: 'Turbo LoRA',
    turbo_lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
    pdd_nfe: '4',
  })
})

test('extenderEngineOverride: an 8-step turbo LoRA cannot end up paired with a mismatched pdd_nfe', () => {
  const patch = extenderEngineOverride({ mode: 'turbo', lora: 'some_lightning_8step_lora.safetensors' }, '4')
  assert.equal(patch.pdd_nfe, '8') // NOT '4', the bakedPddNfe passed in — the filename wins
})

test('extenderEngineOverride: a turbo LoRA whose filename carries no step count falls back to the baked pdd_nfe, never a guess', () => {
  const patch = extenderEngineOverride({ mode: 'turbo', lora: 'some_random_lora.safetensors' }, '8')
  assert.equal(patch.pdd_nfe, '8')
})

test('extenderEngineChoiceFromInputs: reads PDD mode + its step count off the effective inputs', () => {
  assert.deepEqual(extenderEngineChoiceFromInputs({ accel_mode: 'PDD 8-step', pdd_nfe: '6' }), { mode: 'pdd', steps: '6' })
})

test('extenderEngineChoiceFromInputs: reads Turbo LoRA mode + the lora filename off the effective inputs', () => {
  assert.deepEqual(extenderEngineChoiceFromInputs({ accel_mode: 'Turbo LoRA', turbo_lora: 'x.safetensors', pdd_nfe: '4' }), {
    mode: 'turbo',
    lora: 'x.safetensors',
  })
})

test('extenderEngineChoiceFromInputs: an invalid PDD pdd_nfe (outside 4/6/8) reads back as 8, never an unofferable value', () => {
  assert.deepEqual(extenderEngineChoiceFromInputs({ accel_mode: 'PDD 8-step', pdd_nfe: '20' }), { mode: 'pdd', steps: '8' })
})

// ── Control 2: quality ──────────────────────────────────────────────────────

test('EXTENDER_QUALITY_TIERS: the three founder-settled pairings, verbatim', () => {
  assert.deepEqual(
    EXTENDER_QUALITY_TIERS.map((t) => [t.id, t.pass1Resolution, t.pass2Resolution]),
    [
      ['720p', '608x352 (16:9)', '1280x720'],
      ['768p', '704x384', '1344x768 (16:9)'],
      ['1080p', '1056x608 (16:9)', '1920x1088 (16:9)'],
    ],
  )
})

test('extenderQualityOverride: sets pass1_resolution AND pass2_resolution together, as a pair', () => {
  const tier = EXTENDER_QUALITY_TIERS.find((t) => t.id === '768p')!
  assert.deepEqual(extenderQualityOverride(tier), { pass1_resolution: '704x384', pass2_resolution: '1344x768 (16:9)' })
})

test('extenderQualityTierFromInputs: matches the tier by pass2_resolution', () => {
  const tier = extenderQualityTierFromInputs({ pass2_resolution: '1920x1088 (16:9)' })
  assert.equal(tier?.id, '1080p')
})

test('extenderQualityTierFromInputs: a pass2_resolution none of the three tiers wrote reads as null (custom), not a guess', () => {
  assert.equal(extenderQualityTierFromInputs({ pass2_resolution: '1056x608 (16:9)' }), null)
})

// ── Control 2: quality — live enumeration parsing ───────────────────────────

test('parseExtenderNodeSchema: reads the turbo_lora combo out of a /object_info response, from "optional"', () => {
  const raw = {
    MiniMaxH3MasterExtender: {
      input: {
        required: { pass1_resolution: [['608x352 (16:9)'], {}] },
        optional: { turbo_lora: [['none', 'a.safetensors', 'b_4step.safetensors'], { default: 'none' }] },
      },
    },
  }
  assert.deepEqual(parseExtenderNodeSchema(raw), { turboLoras: ['none', 'a.safetensors', 'b_4step.safetensors'] })
})

test('parseExtenderNodeSchema: null when the node is missing from the response', () => {
  assert.equal(parseExtenderNodeSchema({ SomeOtherNode: {} }), null)
})

test('parseExtenderNodeSchema: null on a malformed/unexpected shape rather than throwing', () => {
  assert.equal(parseExtenderNodeSchema(null), null)
  assert.equal(parseExtenderNodeSchema('not an object'), null)
  assert.equal(parseExtenderNodeSchema({ MiniMaxH3MasterExtender: { input: { required: {} } } }), null)
})
