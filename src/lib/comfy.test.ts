import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clearQueue, inputUrl, interrupt, listBoxInputs, nextPollStep } from './comfy'
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

// ── the input folder, subfolders included (2026-09-18) ──────────────────
//
// The picker showed "Nothing here" against a box whose `input/preserve` held
// 198 images: `LoadImage`'s combo is files-only and non-recursive, so the
// only thing it could see was an input root containing nothing but
// directories. These cover the walk that fixed it.

/** A fetch stub speaking the two shapes `listBoxInputs` reads: VHS's
 * `/vhs/getpath` directory listing (directories carry a trailing slash) and
 * an `/object_info/<node>` combo. */
function boxFetch(tree: Record<string, string[]>, combos: Record<string, string[]> = {}) {
  const seen: string[] = []
  const stub = (async (url: string) => {
    const u = String(url)
    seen.push(u)
    const g = u.match(/\/vhs\/getpath\?path=(.*)$/)
    if (g) {
      const path = decodeURIComponent(g[1])
      const listing = tree[path]
      return listing
        ? new Response(JSON.stringify(listing), { status: 200 })
        : new Response('404: Not Found', { status: 404 })
    }
    const o = u.match(/\/object_info\/(\w+)$/)
    if (o) {
      const node = o[1]
      const field = node === 'LoadImage' ? 'image' : 'video'
      return new Response(
        JSON.stringify({ [node]: { input: { required: { [field]: [combos[node] ?? []] } } } }),
        { status: 200 },
      )
    }
    return new Response('404: Not Found', { status: 404 })
  }) as typeof fetch
  return { stub, seen }
}

async function withFetch<T>(stub: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    globalThis.fetch = original
  }
}

test('listBoxInputs finds files in a subfolder, which the combo alone cannot see', async () => {
  // The real shape measured on the box: an input root of directories only.
  const { stub } = boxFetch({
    'input': ['3d/', 'preserve/'],
    'input/3d': ['rig.png'],
    'input/preserve': ['tanvi.jpg', 'well.png', 'notes.txt'],
  })
  const out = await withFetch(stub, () => listBoxInputs(EP))
  assert.deepEqual(
    out.images.map((f) => `${f.subfolder}/${f.filename}`).sort(),
    ['3d/rig.png', 'preserve/tanvi.jpg', 'preserve/well.png'],
  )
  // A non-image is not offered on the image tab.
  assert.equal(out.images.some((f) => f.filename === 'notes.txt'), false)
})

test('listBoxInputs falls back to the portable cwd spelling of the input root', async () => {
  // `/vhs/getpath` resolves a relative path against ComfyUI's PROCESS cwd,
  // which on a portable install is the PARENT of the ComfyUI directory — so
  // plain `input` misses and `ComfyUI/input` hits. This is the live box.
  const { stub, seen } = boxFetch({
    'ComfyUI/input': ['preserve/'],
    'ComfyUI/input/preserve': ['t1.jpg'],
  })
  const out = await withFetch(stub, () => listBoxInputs(EP))
  assert.deepEqual(out.images, [{ filename: 't1.jpg', subfolder: 'preserve' }])
  assert.ok(seen.some((u) => u.includes('path=input')), 'tries the plain spelling first')
})

test('listBoxInputs still lists a box with no VideoHelperSuite, from the combos alone', async () => {
  const { stub } = boxFetch({}, { LoadImage: ['loose.png'], VHS_LoadVideo: ['clip.mp4'] })
  const out = await withFetch(stub, () => listBoxInputs(EP))
  assert.deepEqual(out.images, [{ filename: 'loose.png', subfolder: '' }])
  assert.deepEqual(out.videos, [{ filename: 'clip.mp4', subfolder: '' }])
})

test('listBoxInputs does not list the same file twice when the walk and the combo agree', async () => {
  // ComfyUI annotates a subfoldered combo entry as `sub/name.png`; the walk
  // reports the same file as a {subfolder, filename} pair. They must dedupe.
  const { stub } = boxFetch(
    { 'input': ['preserve/'], 'input/preserve': ['dup.png'] },
    { LoadImage: ['preserve/dup.png'] },
  )
  const out = await withFetch(stub, () => listBoxInputs(EP))
  assert.equal(out.images.length, 1)
  assert.deepEqual(out.images[0], { filename: 'dup.png', subfolder: 'preserve' })
})

test('listBoxInputs bounds the walk rather than following an input tree forever', async () => {
  // Depth 2, so a third level is never requested — one picker open must not
  // become an unbounded number of requests.
  const { stub, seen } = boxFetch({
    'input': ['a/'],
    'input/a': ['b/'],
    'input/a/b': ['c/', 'deep.png'],
    'input/a/b/c': ['deeper.png'],
  })
  const out = await withFetch(stub, () => listBoxInputs(EP))
  assert.equal(out.images.some((f) => f.filename === 'deep.png'), true)
  assert.equal(out.images.some((f) => f.filename === 'deeper.png'), false)
  assert.equal(seen.some((u) => u.includes(encodeURIComponent('input/a/b/c'))), false)
})

test('inputUrl addresses a file in a subfolder, not just the input root', () => {
  const url = inputUrl(EP, 'tanvi.jpg', undefined, 'preserve')
  assert.ok(url.includes('subfolder=preserve'), url)
  assert.ok(url.includes('type=input'), url)
  // The default stays the root, so every existing call site is unchanged.
  assert.ok(inputUrl(EP, 'tanvi.jpg').includes('subfolder=&'), inputUrl(EP, 'tanvi.jpg'))
})
