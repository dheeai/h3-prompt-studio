import assert from 'node:assert/strict'
import test from 'node:test'
import { armModelLock, modelSwapWarning, describeModelLock } from './modelLock'

test('nothing used yet warns about nothing, and the first call arms', () => {
  assert.equal(modelSwapWarning(null, 'thinkingcap-27b', 'llamacpp'), null)
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.deepEqual(l, { model: 'thinkingcap-27b', provider: 'llamacpp', armedAt: 1 })
})

test('the same model+provider warns about nothing and does not re-arm', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.equal(modelSwapWarning(l, 'thinkingcap-27b', 'llamacpp'), null)
  assert.equal(armModelLock(l, 'thinkingcap-27b', 'llamacpp', 2), l)
})

test('a different MODEL is ALLOWED, with an advisory naming both and the cost', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  const why = modelSwapWarning(l, 'kat-coder-v2.5', 'llamacpp')
  assert.match(String(why), /"thinkingcap-27b" → "kat-coder-v2.5"/)
  assert.match(String(why), /150x/)
  // The wording must read as a cost being reported, never as a refusal --
  // this is the whole point of the 2026-09-17 change.
  assert.match(String(why), /Continuing\./)
  assert.doesNotMatch(String(why), /refus|blocked|cannot|pinned to/i)
})

test('a different PROVIDER is reported the same way', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.match(String(modelSwapWarning(l, 'thinkingcap-27b', 'openrouter')), /provider "llamacpp" → "openrouter"/)
})

test('both changing is reported as both', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.match(String(modelSwapWarning(l, 'deepseek/deepseek-v4.1-flash', 'openrouter')), /provider .* and model /)
})

test('armModelLock RE-ARMS to the new model, so a swap warns once and not forever', () => {
  const first = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  const second = armModelLock(first, 'kat-coder-v2.5', 'llamacpp', 2)
  assert.deepEqual(second, { model: 'kat-coder-v2.5', provider: 'llamacpp', armedAt: 2 })
  // The scene authored AFTER the swap is not news any more.
  assert.equal(modelSwapWarning(second, 'kat-coder-v2.5', 'llamacpp'), null)
})

test('describeModelLock states both states', () => {
  assert.match(describeModelLock(null), /no model used yet/)
  assert.match(describeModelLock({ model: 'm', provider: 'p', armedAt: 0 }), /using p\/m/)
})
