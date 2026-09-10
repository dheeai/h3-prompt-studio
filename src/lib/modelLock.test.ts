import assert from 'node:assert/strict'
import test from 'node:test'
import { armModelLock, modelLockViolation, describeModelLock } from './modelLock'

test('unarmed lock permits anything, and arms on first use', () => {
  assert.equal(modelLockViolation(null, 'thinkingcap-27b', 'llamacpp'), null)
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.deepEqual(l, { model: 'thinkingcap-27b', provider: 'llamacpp', armedAt: 1 })
})

test('same model+provider is permitted and does not re-arm', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.equal(modelLockViolation(l, 'thinkingcap-27b', 'llamacpp'), null)
  assert.equal(armModelLock(l, 'thinkingcap-27b', 'llamacpp', 2), l)
})

test('a different MODEL is refused, and the reason names both', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  const why = modelLockViolation(l, 'kat-coder-v2.5', 'llamacpp')
  assert.match(String(why), /pinned to llamacpp\/thinkingcap-27b/)
  assert.match(String(why), /"thinkingcap-27b" → "kat-coder-v2.5"/)
  assert.match(String(why), /30 GB/)
})

test('a different PROVIDER is refused too', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.match(String(modelLockViolation(l, 'thinkingcap-27b', 'openrouter')), /provider "llamacpp" → "openrouter"/)
})

test('both changing is reported as both', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.match(String(modelLockViolation(l, 'deepseek/deepseek-v4.1-flash', 'openrouter')), /provider .* and model /)
})

test('armModelLock never silently re-arms to a different model', () => {
  const l = armModelLock(null, 'thinkingcap-27b', 'llamacpp', 1)
  assert.equal(armModelLock(l, 'kat-coder-v2.5', 'llamacpp', 2), l)
})

test('describeModelLock states both states', () => {
  assert.match(describeModelLock(null), /not pinned/)
  assert.match(describeModelLock({ model: 'm', provider: 'p', armedAt: 0 }), /pinned to p\/m/)
})
