import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isExtenderFieldFrozen, mergeExtenderInputs, withExtenderOverride } from './extenderSettings'

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
