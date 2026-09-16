import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GEOMETRY_PRESETS, OOM_HEIGHT, OOM_WIDTH, framesForSeconds, oomRisk, secondsForFrames, snapFrames } from './geometry'

// ── frame grid ──────────────────────────────────────────────────────────────

test('snapFrames rounds onto the 17k+5 grid, never below 5', () => {
  assert.equal(snapFrames(0), 5)
  assert.equal(snapFrames(5), 5)
  assert.equal(snapFrames(120), 124) // 5s at 24fps
  assert.equal(snapFrames(480), 481) // 20s at 24fps
})

test('framesForSeconds/secondsForFrames round-trip through the grid', () => {
  const frames = framesForSeconds(5)
  assert.equal(frames, 124)
  assert.ok(Math.abs(secondsForFrames(frames) - 5.1667) < 0.001)
})

// ── OOM risk — the live hazard on the largest tier ─────────────────────────

test('oomRisk: the old fallback geometry (1344x768) is exactly the OOM tier and IS flagged past 362 frames', () => {
  assert.equal(oomRisk(1344, 768, 363), true)
  assert.equal(oomRisk(1344, 768, 362), false)
})

test('oomRisk: every OTHER measured geometry is never flagged, at any length', () => {
  for (const p of GEOMETRY_PRESETS) {
    if (p.width >= OOM_WIDTH && p.height >= OOM_HEIGHT) continue
    assert.equal(oomRisk(p.width, p.height, 10_000), false, `${p.label} should never be flagged`)
  }
})

test('GEOMETRY_PRESETS: the validated 1216x672 tier is offered, distinct from the OOM tier', () => {
  const validated = GEOMETRY_PRESETS.find((p) => p.width === 1216 && p.height === 672)
  assert.ok(validated, 'expected a 1216x672 preset')
  assert.equal(oomRisk(validated!.width, validated!.height, 10_000), false)
})
