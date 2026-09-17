import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearQueue, interrupt, nextPollStep } from './comfy'
import type { ComfyEndpoint } from './types'
import type { PollResult } from './comfy'

const EP: ComfyEndpoint = { id: 'e1', label: 'test box', baseUrl: 'http://box.test:8188', builtIn: true }

// ── nextPollStep — the poller's own stop check (2026-09-17 brief: "no way ──
// ── to cancel a job") ─────────────────────────────────────────────────────

test('nextPollStep: not done, no stop requested — keeps polling', () => {
  const res: PollResult = { done: false }
  assert.deepEqual(nextPollStep(res, false), { kind: 'continue' })
})

test('nextPollStep: not done, stop requested — stops instead of continuing to poll', () => {
  const res: PollResult = { done: false }
  assert.deepEqual(nextPollStep(res, true), { kind: 'stopped' })
})

test('nextPollStep: done and successful in the SAME tick a stop was requested still lands — a click that arrives a beat late never discards a finished render', () => {
  const res: PollResult = { done: true, output: { filename: 'a.mp4', subfolder: '', type: 'output' } }
  assert.deepEqual(nextPollStep(res, true), { kind: 'done', output: res.output })
})

test('nextPollStep: a real failure reports failed even when a stop was also requested', () => {
  const res: PollResult = { done: true, failed: 'sampler exploded' }
  assert.deepEqual(nextPollStep(res, true), { kind: 'failed', message: 'sampler exploded' })
})

test('nextPollStep: done with no stop requested — ordinary success', () => {
  const res: PollResult = { done: true, output: { filename: 'a.mp4', subfolder: '', type: 'output' } }
  assert.deepEqual(nextPollStep(res, false), { kind: 'done', output: res.output })
})

// ── interrupt / clearQueue — the two calls a real Stop makes ─────────────
// ── against ComfyUI (2026-09-17 brief: "no way to cancel a job") ─────────

test('interrupt: posts to /interrupt on the endpoint', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  try {
    await interrupt(EP)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://box.test:8188/interrupt')
    assert.equal(calls[0].init?.method, 'POST')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('interrupt: a dead box (fetch throws) is swallowed, not re-thrown — Stop must not itself fail', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  try {
    await assert.doesNotReject(interrupt(EP))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('clearQueue: posts {clear:true} to /queue — this is what drops anything queued behind the interrupted job', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    return new Response(null, { status: 200 })
  }) as typeof fetch
  try {
    await clearQueue(EP)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://box.test:8188/queue')
    assert.equal(calls[0].init?.method, 'POST')
    assert.equal(calls[0].init?.body, JSON.stringify({ clear: true }))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('clearQueue: a dead box (fetch throws) is swallowed, not re-thrown', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as typeof fetch
  try {
    await assert.doesNotReject(clearQueue(EP))
  } finally {
    globalThis.fetch = originalFetch
  }
})
