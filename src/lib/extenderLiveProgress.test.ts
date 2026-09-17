import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extenderWsUrl, matchesOwner, parseExtenderProgressEvent, watchExtenderProgress,
} from './extenderLiveProgress'
import type { ExtenderLiveProgress, MinimalSocket, SocketCtor } from './extenderLiveProgress'
import type { ComfyEndpoint } from './types'

const EP: ComfyEndpoint = { id: 'e1', label: 'the box', baseUrl: 'https://5090.tail3cca41.ts.net/comfyui', builtIn: true }

const RAW_EVENT = {
  type: 'master_extender_progress',
  data: { owner: 'm_abc123', clip_index: 3, total_clips: 6, stage: 'sampling', message: 'pass 1', percent: 0.4 },
}

// ── parseExtenderProgressEvent — untrusted socket input ───────────────────

test('parseExtenderProgressEvent: a well-formed event parses into the displayed state', () => {
  const evt = parseExtenderProgressEvent(RAW_EVENT)
  assert.deepEqual(evt, {
    ownerId: 'm_abc123',
    clipIndex: 3,
    totalClips: 6,
    stage: 'sampling',
    message: 'pass 1',
    percent: 0.4,
  })
})

test('parseExtenderProgressEvent: clamps an out-of-range percent instead of passing it through', () => {
  const over = parseExtenderProgressEvent({ ...RAW_EVENT, data: { ...RAW_EVENT.data, percent: 1.4 } })
  const under = parseExtenderProgressEvent({ ...RAW_EVENT, data: { ...RAW_EVENT.data, percent: -0.2 } })
  assert.equal(over?.percent, 1)
  assert.equal(under?.percent, 0)
})

test('parseExtenderProgressEvent: a non-number percent defaults to 0 rather than rejecting the whole event', () => {
  const evt = parseExtenderProgressEvent({ ...RAW_EVENT, data: { ...RAW_EVENT.data, percent: 'forty' } })
  assert.equal(evt?.percent, 0)
})

test('parseExtenderProgressEvent: non-string stage/message fall back to empty string rather than rejecting the event', () => {
  const evt = parseExtenderProgressEvent({ ...RAW_EVENT, data: { ...RAW_EVENT.data, stage: 7, message: null } })
  assert.equal(evt?.stage, '')
  assert.equal(evt?.message, '')
})

const malformed: Array<[string, unknown]> = [
  ['not an object', 'master_extender_progress'],
  ['null', null],
  ['an array', [1, 2, 3]],
  ['wrong type field', { type: 'something_else', data: RAW_EVENT.data }],
  ['missing type field', { data: RAW_EVENT.data }],
  ['missing data', { type: 'master_extender_progress' }],
  ['data is null', { type: 'master_extender_progress', data: null }],
  ['data is a string', { type: 'master_extender_progress', data: 'nope' }],
  ['missing owner', { type: 'master_extender_progress', data: { clip_index: 0, total_clips: 1 } }],
  ['owner is empty string', { type: 'master_extender_progress', data: { ...RAW_EVENT.data, owner: '' } }],
  ['owner is a number', { type: 'master_extender_progress', data: { ...RAW_EVENT.data, owner: 42 } }],
  ['missing clip_index', { type: 'master_extender_progress', data: { owner: 'm_1', total_clips: 6 } }],
  ['clip_index is a string', { type: 'master_extender_progress', data: { ...RAW_EVENT.data, clip_index: '3' } }],
  ['clip_index is NaN', { type: 'master_extender_progress', data: { ...RAW_EVENT.data, clip_index: NaN } }],
  ['missing total_clips', { type: 'master_extender_progress', data: { owner: 'm_1', clip_index: 0 } }],
  ['total_clips is a string', { type: 'master_extender_progress', data: { ...RAW_EVENT.data, total_clips: '6' } }],
]

for (const [label, payload] of malformed) {
  test(`parseExtenderProgressEvent: rejects a hostile/malformed payload — ${label}`, () => {
    assert.equal(parseExtenderProgressEvent(payload), null)
  })
}

// ── matchesOwner — ignoring events for a different job ────────────────────

test('matchesOwner: true when the event owner is this render\'s node id', () => {
  const evt = parseExtenderProgressEvent(RAW_EVENT) as ExtenderLiveProgress
  assert.equal(matchesOwner(evt, 'm_abc123'), true)
})

test('matchesOwner: false for a different job\'s owner — another tab/film must not overwrite this progress panel', () => {
  const evt = parseExtenderProgressEvent(RAW_EVENT) as ExtenderLiveProgress
  assert.equal(matchesOwner(evt, 'm_some_other_film'), false)
})

// ── extenderWsUrl — same endpoint every other comfy.ts call uses ─────────

test('extenderWsUrl: swaps https for wss and appends /ws?clientId=', () => {
  assert.equal(extenderWsUrl(EP, 'h3-prompt-studio'), 'wss://5090.tail3cca41.ts.net/comfyui/ws?clientId=h3-prompt-studio')
})

test('extenderWsUrl: swaps http for ws for a plain local box', () => {
  const local: ComfyEndpoint = { id: 'local', label: 'localhost', baseUrl: 'http://127.0.0.1:8188', builtIn: true }
  assert.equal(extenderWsUrl(local, 'abc'), 'ws://127.0.0.1:8188/ws?clientId=abc')
})

test('extenderWsUrl: strips a trailing slash before appending /ws', () => {
  const trailing: ComfyEndpoint = { id: 'x', label: 'x', baseUrl: 'http://box.test:8188/', builtIn: true }
  assert.equal(extenderWsUrl(trailing, 'abc'), 'ws://box.test:8188/ws?clientId=abc')
})

// ── watchExtenderProgress — connect/filter/disconnect lifecycle ──────────
//
// A fake `MinimalSocket`/`SocketCtor` stands in for the DOM `WebSocket` (no
// jsdom/browser in this repo's `npm test` — see `renderStop.test.ts`'s own
// note on the same constraint). What is NOT exercised here: an actual
// `wss://` connection to a real ComfyUI box — per the founder's "no GPU"
// instruction, the live socket stays unverified until watched by hand.

class FakeSocket implements MinimalSocket {
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed = false
  close() {
    this.closed = true
  }
}

function fakeCtor(sockets: FakeSocket[]): SocketCtor {
  return class {
    constructor() {
      const s = new FakeSocket()
      sockets.push(s)
      return s as unknown as this
    }
  } as unknown as SocketCtor
}

test('watchExtenderProgress: a well-formed event for THIS job reaches onProgress', () => {
  const sockets: FakeSocket[] = []
  const seen: ExtenderLiveProgress[] = []
  const handle = watchExtenderProgress(EP, 'm_abc123', (evt) => seen.push(evt), { wsCtor: fakeCtor(sockets) })
  sockets[0].onmessage?.({ data: JSON.stringify(RAW_EVENT) })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].clipIndex, 3)
  handle.close()
  assert.equal(sockets[0].closed, true)
})

test('watchExtenderProgress: ignores an event whose owner is a different job', () => {
  const sockets: FakeSocket[] = []
  const seen: ExtenderLiveProgress[] = []
  watchExtenderProgress(EP, 'm_this_film', (evt) => seen.push(evt), { wsCtor: fakeCtor(sockets) })
  sockets[0].onmessage?.({ data: JSON.stringify(RAW_EVENT) }) // owner: m_abc123
  assert.equal(seen.length, 0)
})

test('watchExtenderProgress: a hostile/malformed message never reaches onProgress and never throws', () => {
  const sockets: FakeSocket[] = []
  const seen: ExtenderLiveProgress[] = []
  watchExtenderProgress(EP, 'm_abc123', (evt) => seen.push(evt), { wsCtor: fakeCtor(sockets) })
  assert.doesNotThrow(() => {
    sockets[0].onmessage?.({ data: 'not json{{{' })
    sockets[0].onmessage?.({ data: 123 })
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'master_extender_progress', data: 'nope' }) })
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'execution_start' }) })
  })
  assert.equal(seen.length, 0)
})

test('watchExtenderProgress: a wsCtor that throws on construction returns a no-op handle instead of throwing', () => {
  const throwing: SocketCtor = class {
    constructor() {
      throw new Error('ECONNREFUSED')
    }
  } as unknown as SocketCtor
  const handle = watchExtenderProgress(EP, 'm_abc123', () => {
    throw new Error('should never be called')
  }, { wsCtor: throwing })
  assert.doesNotThrow(() => handle.close())
})

test('watchExtenderProgress: close() swallows a socket that throws on close', () => {
  const throwsOnClose: SocketCtor = class {
    onmessage: ((ev: { data: unknown }) => void) | null = null
    onerror: ((ev: unknown) => void) | null = null
    close() {
      throw new Error('already gone')
    }
  } as unknown as SocketCtor
  const handle = watchExtenderProgress(EP, 'm_abc123', () => {}, { wsCtor: throwsOnClose })
  assert.doesNotThrow(() => handle.close())
})

test('watchExtenderProgress: no WebSocket constructor available (opts.wsCtor omitted, none injected) returns a no-op handle', () => {
  // Exercises the `Ctor` branch directly rather than depending on whether
  // THIS runtime happens to have a global WebSocket (Node does; a stripped
  // embed might not) — passing `undefined` through `wsCtor` is exactly what
  // that missing-global case collapses to.
  const handle = watchExtenderProgress(EP, 'm_abc123', () => {
    throw new Error('should never be called')
  }, { wsCtor: undefined as unknown as SocketCtor, clientId: 'x' })
  // With no global WebSocket in this environment this would already be a
  // no-op; assert only the observable contract — closing it is harmless.
  assert.doesNotThrow(() => handle.close())
})

// ── the render itself must complete even if the socket never connects ────

/** Mirrors `renderStop.test.ts`'s `simulateRenderJob` shape — the same
 * poll/step loop `renderExtenderPlan`/`renderExtender` run — but with the
 * progress socket wired in exactly as those two functions now wire it: opened
 * before the poll loop, closed in a `finally` that always runs. */
async function simulateRenderWithProgress(opts: {
  pollFn: () => { done: boolean; failed?: string }
  wsCtor: SocketCtor
}): Promise<{ outcome: 'done' | 'failed'; socketClosed: boolean }> {
  let closed = false
  const handle = watchExtenderProgress(EP, 'm_job', () => {}, { wsCtor: opts.wsCtor })
  const originalClose = handle.close
  handle.close = () => {
    closed = true
    originalClose()
  }
  let outcome: 'done' | 'failed'
  try {
    for (;;) {
      const res = opts.pollFn()
      if (!res.done) continue
      outcome = res.failed ? 'failed' : 'done'
      break
    }
  } finally {
    // `finally` runs before the enclosing try/finally statement completes —
    // i.e. before this function falls through to the `return` below — so
    // `closed` is already up to date there, unlike a `return` written INSIDE
    // the try block (which would capture the pre-finally value).
    handle.close()
  }
  return { outcome, socketClosed: closed }
}

test('render still completes when the socket construction throws (never connects at all)', async () => {
  const neverConnects: SocketCtor = class {
    constructor() {
      throw new Error('WebSocket is not available')
    }
  } as unknown as SocketCtor
  let polls = 0
  const res = await simulateRenderWithProgress({
    pollFn: () => (++polls < 3 ? { done: false } : { done: true }),
    wsCtor: neverConnects,
  })
  assert.equal(res.outcome, 'done')
  assert.equal(res.socketClosed, true)
})

test('render still completes (and reports failure correctly) when the socket drops mid-render', async () => {
  const sockets: FakeSocket[] = []
  let polls = 0
  const res = await simulateRenderWithProgress({
    pollFn: () => {
      polls += 1
      if (polls === 2) sockets[0]?.onerror?.(new Event('error'))
      return polls < 4 ? { done: false } : { done: true, failed: 'sampler exploded' }
    },
    wsCtor: fakeCtor(sockets),
  })
  assert.equal(res.outcome, 'failed')
  assert.equal(res.socketClosed, true)
})
