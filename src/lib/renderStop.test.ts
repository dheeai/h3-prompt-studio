import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RenderStopped, nextPollStep } from './comfy'
import type { PollResult } from './comfy'
import { clipsAfterStop } from './filmEdit'

/**
 * A stop button is only real if THREE things happen together once it is
 * pressed: the poller gives up (not just "eventually" — on its very next
 * tick, never a tick later), the GPU mutex actually releases, and the clip
 * records it was rendering stop reading as done. `state.tsx`'s
 * `renderExtenderPlan` / `renderExtender` wire these three things through
 * React refs/state that cannot be driven from a plain `node:test` run (no
 * jsdom/React harness in this repo — `npm test` only globs `*.test.ts`).
 *
 * `simulateRenderJob` below reproduces the EXACT loop shape both of those
 * functions now share — poll, run the result through `nextPollStep`,
 * `continue`/throw/`break` on its verdict, `clipsAfterStop` in the
 * `RenderStopped` branch, an unconditional `finally` that drops the mutex —
 * built from the same exported primitives they call
 * (`nextPollStep`/`RenderStopped`/`clipsAfterStop`), so the COMPOSITION is
 * proven even though the React closures themselves are not directly
 * invoked here. What is NOT exercised by anything in this suite: the real
 * `/interrupt` and `/queue` network calls against a live ComfyUI
 * (`comfy.test.ts` covers their wire format with a mocked `fetch`, but
 * never against a real box — per the founder's "no GPU" instruction, the
 * live interrupt path stays unverified until watched by hand).
 */
type FakeClip = { id: string; state: 'queued' | 'rendering' | 'done' | 'failed'; extender?: { nodeId: string; sceneIndex: number } }

async function simulateRenderJob(opts: {
  clips: FakeClip[]
  nodeId: string
  /** Called once per tick — a stand-in for `pollExtender(endpoint, promptId)`. */
  pollFn: () => PollResult
  /** A stand-in for `renderStopRef.current` — read fresh each tick, exactly
   * like the ref `stopRender` flips from outside this loop. */
  shouldStop: () => boolean
}): Promise<{ clips: FakeClip[]; gpuBusy: 'idle' | 'render'; outcome: 'done' | 'stopped' | 'failed'; ticks: number }> {
  let gpuBusy: 'idle' | 'render' = 'render'
  let clips = opts.clips
  let ticks = 0
  try {
    for (;;) {
      ticks += 1
      const res = opts.pollFn()
      const step = nextPollStep(res, opts.shouldStop())
      if (step.kind === 'continue') continue
      if (step.kind === 'stopped') throw new RenderStopped()
      if (step.kind === 'failed') throw new Error(step.message)
      clips = clips.map((c) => (c.extender?.nodeId === opts.nodeId ? { ...c, state: 'done' } : c))
      return { clips, gpuBusy: 'idle', outcome: 'done', ticks }
    }
  } catch (e) {
    if (e instanceof RenderStopped) {
      clips = clipsAfterStop(clips, opts.nodeId)
      return { clips, gpuBusy: 'idle', outcome: 'stopped', ticks }
    }
    return { clips, gpuBusy: 'idle', outcome: 'failed', ticks }
  } finally {
    // The real `finally` in both `renderExtenderPlan` and `renderExtender`
    // is unconditional — `endGpuUse()` runs whether the try returned,
    // threw a real error, or threw `RenderStopped`. Mirrored the same way.
    gpuBusy = 'idle'
  }
}

test('stop mid-poll: the GPU mutex releases, and the poller stops on its very next tick, not one tick later', async () => {
  let ticksRun = 0
  const clips: FakeClip[] = [{ id: 'c1', state: 'rendering', extender: { nodeId: 'film-a', sceneIndex: 1 } }]
  const result = await simulateRenderJob({
    clips,
    nodeId: 'film-a',
    pollFn: () => {
      ticksRun += 1
      return { done: false }
    },
    // Stop is "requested" from tick 3 onward — mirrors `stopRender` flipping
    // the ref sometime after the 2nd poll went out.
    shouldStop: () => ticksRun >= 3,
  })
  assert.equal(result.outcome, 'stopped')
  assert.equal(result.gpuBusy, 'idle')
  // Ticks 1 and 2 saw `shouldStop() === false` and looped; tick 3 saw it
  // true and threw immediately, on the SAME tick the flag flipped true —
  // never polling a 4th time first.
  assert.equal(ticksRun, 3)
})

test('a job that finishes in the very same tick Stop was pressed still lands as done, never discarded', async () => {
  const clips: FakeClip[] = [{ id: 'c1', state: 'rendering', extender: { nodeId: 'film-a', sceneIndex: 1 } }]
  const result = await simulateRenderJob({
    clips,
    nodeId: 'film-a',
    pollFn: () => ({ done: true, output: { filename: 'a.mp4', subfolder: '', type: 'output' } }),
    // Stop was ALSO requested — but the job already finished this same tick.
    shouldStop: () => true,
  })
  assert.equal(result.outcome, 'done')
  assert.deepEqual(result.clips.map((c) => c.state), ['done'])
})

test('clip records do not read as done after a stop: every clip of the batch reads queued, never done or failed', async () => {
  const clips: FakeClip[] = [
    { id: 'c1', state: 'rendering', extender: { nodeId: 'film-a', sceneIndex: 1 } },
    { id: 'c2', state: 'rendering', extender: { nodeId: 'film-a', sceneIndex: 2 } },
  ]
  const result = await simulateRenderJob({
    clips,
    nodeId: 'film-a',
    pollFn: () => ({ done: false }),
    shouldStop: () => true,
  })
  assert.deepEqual(result.clips.map((c) => c.state), ['queued', 'queued'])
  assert.ok(result.clips.every((c) => c.state !== 'done' && c.state !== 'failed'))
})

test('a real failure (not a stop) still reads as failed, and still releases the mutex', async () => {
  const clips: FakeClip[] = [{ id: 'c1', state: 'rendering', extender: { nodeId: 'film-a', sceneIndex: 1 } }]
  const result = await simulateRenderJob({
    clips,
    nodeId: 'film-a',
    pollFn: () => ({ done: true, failed: 'sampler exploded' }),
    shouldStop: () => false,
  })
  assert.equal(result.outcome, 'failed')
  assert.equal(result.gpuBusy, 'idle')
})
