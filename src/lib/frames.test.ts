import { test } from 'node:test'
import assert from 'node:assert/strict'
import { padForOverlap, snapUp } from './frames'

test('snapUp: identity on an already on-grid count', () => {
  assert.equal(snapUp(124), 124)
})

test('snapUp: rounds up onto the 17k+5 grid, never down', () => {
  assert.equal(snapUp(130), 141)
})

test('snapUp: never returns less than the 124f floor', () => {
  assert.equal(snapUp(5), 124)
})

test('padForOverlap: the first clip pays no overlap by default', () => {
  const [scene1] = padForOverlap([{ frames: 124 }], 22)
  assert.deepEqual(scene1, { authored: 124, rendered: 124, delivered: 124 })
})

test('padForOverlap: firstHasPredecessor trims the join overlap WITHOUT the padded-request compensation a normal continuation gets — measured, not assumed', () => {
  // Measured live 2026-09-07: a 56.928s source + a 124f scene asked for
  // landed at 61.167s, which is 56.928 + (124-22)/24 (=61.178, matching
  // within encoding rounding) — NOT 56.928 + 136/24 (=62.7), which is what a
  // compensated continuation (the i>0 branch) would deliver.
  const [scene1] = padForOverlap([{ frames: 124 }], 22, { firstHasPredecessor: true })
  assert.equal(scene1.rendered, 124)
  assert.equal(scene1.delivered, 102)
})

test('padForOverlap: firstHasPredecessor only changes clip 0 — later clips are unaffected', () => {
  const withFlag = padForOverlap([{ frames: 124 }, { frames: 124 }], 22, { firstHasPredecessor: true })
  const withoutFlag = padForOverlap([{ frames: 124 }, { frames: 124 }], 22)
  assert.notEqual(withFlag[0].delivered, withoutFlag[0].delivered)
  assert.deepEqual(withFlag[1], withoutFlag[1])
})

test('padForOverlap: firstHasPredecessor defaults to off — omitting opts entirely behaves exactly as before', () => {
  const withOpts = padForOverlap([{ frames: 124 }], 22, {})
  const withoutOpts = padForOverlap([{ frames: 124 }], 22)
  assert.deepEqual(withOpts, withoutOpts)
})
