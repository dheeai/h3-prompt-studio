import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padForOverlap } from './frames'
import {
  SCENE_LENGTH_CHIPS,
  cumulativeFilm,
  cumulativeSceneStarts,
  deliveredVsAskedLine,
  isOnSceneLengthGrid,
  sceneWorkLabel,
  secondsLabel,
  videoDoorEstimate,
} from './chainDisplay'

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

test('sceneWorkLabel: the scene actually being sampled reads sampling regardless of chain state', () => {
  assert.equal(sceneWorkLabel('rendering', true), 'sampling')
  assert.equal(sceneWorkLabel('rendering', false), 'sampling')
})

test('sceneWorkLabel: failed and queued pass through untouched', () => {
  assert.equal(sceneWorkLabel('failed', true), 'failed')
  assert.equal(sceneWorkLabel('queued', false), 'queued')
})

test('the measured overlap tax from the redesign brief: 124f asked, repeated, delivers 136f', () => {
  // "ask 124f and scene 1 gives 124f (5.17s) but every later scene renders
  // 158f and delivers 136f (5.67s)"
  const padded = padForOverlap([{ frames: 124 }, { frames: 124 }], 22)
  assert.deepEqual(padded[0], { authored: 124, rendered: 124, delivered: 124 })
  assert.equal(padded[1].rendered, 158)
  assert.equal(padded[1].delivered, 136)
})

test('the measured overlap tax from the redesign brief: 362f asked delivers 374f', () => {
  // "ask 362f and later scenes deliver 374f"
  const padded = padForOverlap([{ frames: 362 }, { frames: 362 }], 22)
  assert.equal(padded[1].delivered, 374)
})

test('cumulativeFilm: sums DELIVERED frames, never authored', () => {
  const padded = padForOverlap([{ frames: 124 }, { frames: 124 }, { frames: 124 }], 22)
  const totals = cumulativeFilm(padded, 24)
  // 124 + 136 + 136 = 396 delivered frames
  assert.equal(totals.frames, 396)
  assert.equal(totals.seconds, 16.5)
})

test('cumulativeSceneStarts: each scene starts where the previous one delivered up to', () => {
  const padded = padForOverlap([{ frames: 124 }, { frames: 124 }, { frames: 124 }], 22)
  const starts = cumulativeSceneStarts(padded, 24)
  assert.equal(starts[0], 0)
  assert.equal(starts[1], +(124 / 24).toFixed(3))
  assert.equal(starts[2], +((124 + 136) / 24).toFixed(3))
})

test('deliveredVsAskedLine: scene 1 has nothing extra to disclose', () => {
  const [scene1] = padForOverlap([{ frames: 124 }], 22)
  assert.equal(deliveredVsAskedLine(scene1), 'asked 124f')
})

test('deliveredVsAskedLine: a continued scene discloses the overlap tax', () => {
  const [, scene2] = padForOverlap([{ frames: 124 }, { frames: 124 }], 22)
  assert.equal(deliveredVsAskedLine(scene2), 'asked 124f · delivered 136f')
})

test('videoDoorEstimate: matches the live measurement — 56.928s source + 124f scene lands at ~61.2s', () => {
  // Measured live 2026-09-07: dhee_src.mp4 (56.928s) + a 124f scene asked for,
  // continued via buildChainGraph's externalVideo, rendered a joined film of
  // 61.167s — this predicts 61.178s, matching within encoding rounding, and
  // matches FromVideo.dc.html's own worked example (56.9s + 5.2s -> 61.2s).
  const estimate = videoDoorEstimate(56.928, 124, 22)
  assert.equal(estimate.sourceSeconds, 56.928)
  assert.equal(estimate.askedFrames, 124)
  assert.equal(estimate.deliveredFrames, 102)
  assert.equal(estimate.deliveredSeconds, 4.25)
  assert.equal(+estimate.filmSeconds.toFixed(1), 61.2)
})

test('videoDoorEstimate: scene 1 pays the overlap tax even though it is index 0 in its own chain', () => {
  // Without `firstHasPredecessor`, padForOverlap would treat this as an
  // unoverlapped first clip and deliver the full 124f — this is the bug the
  // video door's numbers exist to avoid.
  const estimate = videoDoorEstimate(10, 124, 22)
  assert.notEqual(estimate.deliveredFrames, 124)
  assert.equal(estimate.deliveredFrames, 102)
})
