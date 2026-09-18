import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveNextStepInput } from './nextStepInput'
import type { NextStepSource } from './nextStepInput'
import { nextStep } from './nextStep'
import type { Timeline, TimelineClip } from './timeline'

/**
 * `deriveNextStepInput` is the seam between real app state and `nextStep()`'s
 * pure contract — see its own module comment. These tests build a `Timeline`
 * by hand (never through `buildTimeline`) so a `'rendered'`-not-kept clip
 * (the "awaiting judgement" case) can be expressed directly, exactly as
 * `timeline.ts`'s own module comment says that state is only reachable when
 * a caller hands it in rather than derives it from today's render records.
 */

function clip(index: number, state: TimelineClip['state'], deliveredSeconds = 10): TimelineClip {
  return {
    index,
    title: `Clip ${index}`,
    state,
    shots: [],
    askedSeconds: deliveredSeconds,
    padded: { authored: deliveredSeconds * 24, rendered: deliveredSeconds * 24, delivered: deliveredSeconds * 24 },
    deliveredSeconds,
    isEstimate: state !== 'kept' && state !== 'rendered',
    filmStartSeconds: 0,
  }
}

function timeline(clips: TimelineClip[]): Timeline {
  const keptSeconds = clips.filter((c) => c.state === 'kept').reduce((s, c) => s + c.deliveredSeconds, 0)
  const renderedSeconds = clips.filter((c) => c.state === 'rendered').reduce((s, c) => s + c.deliveredSeconds, 0)
  const totalSeconds = clips.reduce((s, c) => s + c.deliveredSeconds, 0)
  return {
    clips,
    totalSeconds,
    isEstimate: clips.some((c) => c.isEstimate),
    runtimeBar: { keptSeconds, renderedSeconds, remainingSeconds: totalSeconds - keptSeconds - renderedSeconds },
  }
}

const base: NextStepSource = {
  plot: '',
  hasShotList: false,
  awaitingSubdivision: false,
  thinBriefCheck: null,
  groupCount: 0,
  approvedClipCount: 0,
  clipsNeedingPromptCount: 0,
  timeline: timeline([]),
  rendering: false,
  callsPerClip: 1,
}

test('an empty film sends the operator to the plot', () => {
  const s = nextStep(deriveNextStepInput(base))
  assert.equal(s.kind, 'write-plot')
})

test('a plot with no shot list names the planner', () => {
  const s = nextStep(deriveNextStepInput({ ...base, plot: 'A monsoon wedding nearly derailed by a lost ring.' }))
  assert.equal(s.kind, 'make-shot-list')
})

test('beats landed but not yet subdivided pauses on the thin-brief check', () => {
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A courier crosses a flooded city before dawn.',
      hasShotList: true,
      awaitingSubdivision: true,
      thinBriefCheck: { naturalSeconds: 40, maxRuntimeSeconds: 180, isThin: true },
    }),
  )
  assert.equal(s.kind, 'resolve-thin-brief')
  assert.match(s.detail, /naturally fills about 40s/)
})

test('shots exist but nothing is approved yet asks for approval', () => {
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A retired locksmith is pulled into one last job.',
      hasShotList: true,
      groupCount: 3,
      approvedClipCount: 0,
    }),
  )
  assert.equal(s.kind, 'approve-groups')
  assert.equal(s.action, 'Approve 3 clips')
})

test('a mix — clip 1 needs rendering, clip 3 needs a prompt — reports WRITING, never rendering', () => {
  const t = timeline([clip(1, 'written', 8), clip(2, 'kept', 9), clip(3, 'planned', 7)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A street food vendor discovers her cart is haunted.',
      hasShotList: true,
      groupCount: 3,
      approvedClipCount: 3,
      clipsNeedingPromptCount: 1,
      timeline: t,
    }),
  )
  assert.equal(s.kind, 'write-prompts')
  assert.equal(s.action, 'Write prompts for 1 clip')
})

test('a render in flight offers to stop, ahead of anything else waiting', () => {
  const t = timeline([clip(1, 'rendering', 8), clip(2, 'written', 9)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'Two rival chai stalls merge for one festival night.',
      hasShotList: true,
      groupCount: 2,
      approvedClipCount: 2,
      timeline: t,
      rendering: true,
    }),
  )
  assert.equal(s.kind, 'stop-or-wait')
})

test('written, unrendered clips ask to render — ALL of them, in one job', () => {
  const t = timeline([clip(1, 'written', 8), clip(2, 'written', 6)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A night-bus driver races a landslide to the last stop.',
      hasShotList: true,
      groupCount: 2,
      approvedClipCount: 2,
      timeline: t,
    }),
  )
  assert.equal(s.kind, 'render-clips')
  assert.equal(s.action, 'Render 2 clips')
  assert.match(s.cost!, /14\.0s of sampling/)
})

test('a clip rendered but not yet kept asks the operator to watch it', () => {
  const t = timeline([clip(1, 'kept', 8), clip(2, 'rendered', 6)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A power cut strands a wedding band mid-song.',
      hasShotList: true,
      groupCount: 2,
      approvedClipCount: 2,
      timeline: t,
    }),
  )
  assert.equal(s.kind, 'watch-and-keep')
  assert.equal(s.action, 'Watch 1 clip')
})

test('every clip kept reports the finished film and its delivered length', () => {
  const t = timeline([clip(1, 'kept', 8), clip(2, 'kept', 11.4)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A tea-stall radio outlives three generations of the same family.',
      hasShotList: true,
      groupCount: 2,
      approvedClipCount: 2,
      timeline: t,
    }),
  )
  assert.equal(s.kind, 'film-done')
  assert.match(s.detail, /2 clips kept, 19\.4s delivered/)
})

test('callsPerClip flows straight through to the write-prompts cost', () => {
  const t = timeline([clip(5, 'planned', 4)])
  const s = nextStep(
    deriveNextStepInput({
      ...base,
      plot: 'A monsoon wedding nearly derailed by a lost ring.',
      hasShotList: true,
      groupCount: 1,
      approvedClipCount: 1,
      clipsNeedingPromptCount: 1,
      timeline: t,
      callsPerClip: 3,
    }),
  )
  assert.equal(s.cost, '3 model calls')
})
