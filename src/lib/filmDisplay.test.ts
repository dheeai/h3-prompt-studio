import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SCENE_LENGTH_CHIPS,
  cumulativeFilm,
  cumulativeSceneStarts,
  deliveredVsAskedLine,
  isOnSceneLengthGrid,
  sceneWorkLabel,
  secondsLabel,
} from './filmDisplay'
import type { PaddedClip } from './filmDisplay'

test('SCENE_LENGTH_CHIPS: every curated chip is actually on H3s legal grid', () => {
  for (const f of SCENE_LENGTH_CHIPS) assert.equal(isOnSceneLengthGrid(f), true, `${f} should be on-grid`)
})

test('isOnSceneLengthGrid: rejects anything below the 124f floor', () => {
  assert.equal(isOnSceneLengthGrid(123), false)
  assert.equal(isOnSceneLengthGrid(0), false)
})

test('isOnSceneLengthGrid: rejects an off-grid frame count between two legal lengths', () => {
  // 124 and 141 are both legal; nothing between them is.
  assert.equal(isOnSceneLengthGrid(130), false)
})

test('isOnSceneLengthGrid: 124 is the floor and is on-grid', () => {
  assert.equal(isOnSceneLengthGrid(124), true)
})

test('secondsLabel: one decimal place at 24fps', () => {
  assert.equal(secondsLabel(124), '5.2s')
  assert.equal(secondsLabel(192), '8.0s')
})

test('sceneWorkLabel: a done scene reads checkpointed at rest, restored mid-render', () => {
  assert.equal(sceneWorkLabel('done', false), 'checkpointed')
  assert.equal(sceneWorkLabel('done', true), 'restored')
})

test('sceneWorkLabel: the scene actually being sampled reads sampling regardless of film state', () => {
  assert.equal(sceneWorkLabel('rendering', true), 'sampling')
  assert.equal(sceneWorkLabel('rendering', false), 'sampling')
})

test('sceneWorkLabel: failed and queued pass through untouched', () => {
  assert.equal(sceneWorkLabel('failed', true), 'failed')
  assert.equal(sceneWorkLabel('queued', false), 'queued')
})

test('cumulativeFilm: sums DELIVERED frames', () => {
  const padded: PaddedClip[] = [
    { authored: 124, rendered: 124, delivered: 124 },
    { authored: 124, rendered: 124, delivered: 124 },
    { authored: 124, rendered: 124, delivered: 124 },
  ]
  const totals = cumulativeFilm(padded, 24)
  assert.equal(totals.frames, 372)
  assert.equal(totals.seconds, 15.5)
})

test('cumulativeSceneStarts: each scene starts where the previous one delivered up to', () => {
  const padded: PaddedClip[] = [
    { authored: 124, rendered: 124, delivered: 124 },
    { authored: 124, rendered: 124, delivered: 124 },
    { authored: 124, rendered: 124, delivered: 124 },
  ]
  const starts = cumulativeSceneStarts(padded, 24)
  assert.equal(starts[0], 0)
  assert.equal(starts[1], +(124 / 24).toFixed(3))
  assert.equal(starts[2], +((124 + 124) / 24).toFixed(3))
})

test('deliveredVsAskedLine: authored === delivered has nothing extra to disclose', () => {
  assert.equal(deliveredVsAskedLine({ authored: 124, rendered: 124, delivered: 124 }), 'asked 124f')
})

test('deliveredVsAskedLine: a mismatch (if one ever occurs) discloses both numbers', () => {
  assert.equal(deliveredVsAskedLine({ authored: 124, rendered: 158, delivered: 136 }), 'asked 124f · delivered 136f')
})
