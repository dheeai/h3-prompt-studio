import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamingCallbacks } from './streamingProgress'
import type { StudioRunPhase } from './studio-workflow'

interface Progress {
  text: string
  reasoning: string
  continuations: number
  phase?: StudioRunPhase
}

/** A tiny stand-in for React's `useState` setter, so `streamingCallbacks` can
 * be exercised without mounting a component — it only ever needs the
 * `(updater) => void` shape. */
function fakeState(initial: Progress | null) {
  let current = initial
  const set = (updater: (s: Progress | null) => Progress | null) => {
    current = updater(current)
  }
  return { get: () => current, set }
}

// ── the phase sequence a real call goes through ─────────────────────────

test('streamingCallbacks: starts thinking, stays thinking through reasoning-only chunks', () => {
  const state = fakeState({ text: '', reasoning: '', continuations: 0, phase: 'thinking' })
  const cb = streamingCallbacks<Progress>(state.set)
  cb.onReasoning('the model is considering the plot')
  assert.equal(state.get()?.phase, 'thinking')
  assert.equal(state.get()?.reasoning, 'the model is considering the plot')
  assert.equal(state.get()?.text, '')
})

test('streamingCallbacks: the FIRST real text flips thinking to writing, never straight to done', () => {
  const state = fakeState({ text: '', reasoning: 'notes so far', continuations: 0, phase: 'thinking' })
  const cb = streamingCallbacks<Progress>(state.set)
  assert.equal(state.get()?.phase, 'thinking')
  cb.onDelta('{"spine": "a woman finds a key",')
  assert.equal(state.get()?.phase, 'writing')
  // Further chunks stay in writing — this is not a one-shot flip-then-forget.
  cb.onDelta(' "shots": [')
  assert.equal(state.get()?.phase, 'writing')
})

test('streamingCallbacks: onReasoning after real text has started does not fall back into thinking', () => {
  const state = fakeState({ text: 'partial answer', reasoning: '', continuations: 0, phase: 'writing' })
  const cb = streamingCallbacks<Progress>(state.set)
  cb.onReasoning('an aside')
  assert.equal(state.get()?.phase, 'writing')
})

test('streamingCallbacks: a continuation round reports its own kind as a phase', () => {
  const state = fakeState({ text: 'so far', reasoning: '', continuations: 0, phase: 'writing' })
  const cb = streamingCallbacks<Progress>(state.set)
  cb.onContinuation(1, 'answer')
  assert.equal(state.get()?.phase, 'continuing')
  assert.equal(state.get()?.continuations, 1)
  cb.onContinuation(1, 'thinking')
  assert.equal(state.get()?.phase, 'thinking-recovery')
})

test('streamingCallbacks: onRewind trims exactly the requested tail, never below zero', () => {
  const state = fakeState({ text: 'hello world', reasoning: '', continuations: 0, phase: 'writing' })
  const cb = streamingCallbacks<Progress>(state.set)
  cb.onRewind(6)
  assert.equal(state.get()?.text, 'hello')
  cb.onRewind(999)
  assert.equal(state.get()?.text, '')
})

// ── never resurrects a cleared/cancelled slot ───────────────────────────

test('streamingCallbacks: every callback is a no-op once the slot has gone back to null', () => {
  const state = fakeState(null)
  const cb = streamingCallbacks<Progress>(state.set)
  cb.onDelta('late chunk')
  cb.onReasoning('late thought')
  cb.onContinuation(2, 'answer')
  cb.onRewind(3)
  assert.equal(state.get(), null)
})
