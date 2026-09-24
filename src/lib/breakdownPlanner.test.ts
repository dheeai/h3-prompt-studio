import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BREAKDOWN_PLANNERS, breakdownPlanner } from './breakdownPlanner'

test('breakdownPlanner: unset falls back to the incumbent beats-subdivide planner', () => {
  assert.equal(breakdownPlanner(undefined).id, 'beats-subdivide')
})

test('breakdownPlanner: an unrecognised id falls back to the incumbent', () => {
  assert.equal(breakdownPlanner('nonsense' as any).id, 'beats-subdivide')
})

test('breakdownPlanner: resolves structured-json by id', () => {
  assert.equal(breakdownPlanner('structured-json').id, 'structured-json')
})

test('BREAKDOWN_PLANNERS: exactly the two documented planners, incumbent first', () => {
  assert.deepEqual(BREAKDOWN_PLANNERS.map((p) => p.id), ['beats-subdivide', 'structured-json'])
})

test('structured-json defaults to the "raw-ask" writer preset — the pairing the planner is for', () => {
  assert.equal(breakdownPlanner('structured-json').defaultPipelinePreset, 'raw-ask')
})

test('beats-subdivide defaults to the incumbent "direct-write" writer preset', () => {
  assert.equal(breakdownPlanner('beats-subdivide').defaultPipelinePreset, 'direct-write')
})
