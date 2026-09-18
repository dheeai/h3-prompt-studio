import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextStep } from './nextStep'
import type { NextStepInput } from './nextStep'

const base: NextStepInput = {
  plot: 'A courier crosses a flooded city to deliver one sealed letter before dawn.',
  hasShotList: true,
  awaitingSubdivision: false,
  thinBriefAlert: null,
  groupCount: 4,
  approvedClipCount: 4,
  clipsNeedingPrompt: 0,
  clipsNeedingRender: 0,
  secondsToRender: 0,
  rendering: false,
  clipsAwaitingJudgement: 0,
  keptClipCount: 4,
  callsPerClip: 1,
  deliveredSeconds: 60.3,
}
const at = (patch: Partial<NextStepInput>) => nextStep({ ...base, ...patch })

test('an empty film sends you to the plot, and offers nothing to press', () => {
  const s = at({ plot: '   ', hasShotList: false })
  assert.equal(s.kind, 'write-plot')
  // Nothing to press is correct here: it needs typing, not a click.
  assert.equal(s.actionable, false)
  assert.equal(s.spendsGpu, false)
})

test('a plot with no shot list names the planner and its shape of cost', () => {
  const s = at({ hasShotList: false })
  assert.equal(s.kind, 'make-shot-list')
  assert.match(s.action, /Make the shot list/)
  assert.match(s.cost!, /one per beat/)
  assert.equal(s.actionable, true)
})

test('the thin-brief pause carries the warning into the step itself', () => {
  const s = at({ awaitingSubdivision: true, thinBriefAlert: 'This plot naturally fills about 120s; 600s asks for more.' })
  assert.equal(s.kind, 'resolve-thin-brief')
  assert.match(s.detail, /naturally fills about 120s/)
  assert.match(s.detail, /Lower the runtime/)
  assert.equal(s.actionable, true)
})

test('unapproved groups ask for approval, and say it is free', () => {
  const s = at({ approvedClipCount: 0 })
  assert.equal(s.kind, 'approve-groups')
  assert.equal(s.action, 'Approve 4 clips')
  assert.equal(s.cost, null)
})

test('one group reads as one clip, not "1 clips"', () => {
  assert.equal(at({ approvedClipCount: 0, groupCount: 1 }).action, 'Approve 1 clip')
})

// ── the founder's "select all and render in 1 shot" ─────────────────────

test('writing prompts is ONE bulk action across every clip that needs one', () => {
  const s = at({ clipsNeedingPrompt: 4 })
  assert.equal(s.kind, 'write-prompts')
  assert.equal(s.action, 'Write prompts for 4 clips')
  assert.equal(s.cost, '4 model calls')
  assert.equal(s.spendsGpu, false)
})

test('the directed preset costs three calls a clip, and says so', () => {
  const s = at({ clipsNeedingPrompt: 4, callsPerClip: 3 })
  assert.equal(s.cost, '12 model calls')
  assert.match(s.detail, /directed, then performed, then written/)
})

test('rendering is ONE bulk action, and is the only step that admits to spending GPU', () => {
  const s = at({ clipsNeedingRender: 4, secondsToRender: 60 })
  assert.equal(s.kind, 'render-clips')
  assert.equal(s.action, 'Render 4 clips')
  assert.match(s.cost!, /60\.0s of sampling/)
  assert.equal(s.spendsGpu, true)
  assert.match(s.detail, /All of them, in one job/)
})

test('no other step ever claims to spend GPU', () => {
  const others: Array<Partial<NextStepInput>> = [
    { plot: '', hasShotList: false }, { hasShotList: false }, { awaitingSubdivision: true },
    { approvedClipCount: 0 }, { clipsNeedingPrompt: 2 }, { rendering: true },
    { clipsAwaitingJudgement: 2 }, {},
  ]
  for (const p of others) assert.equal(at(p).spendsGpu, false, JSON.stringify(p))
})

// ── ordering: the cheap step always comes first ─────────────────────────

test('an unwritten clip beats an unrendered one — writing is free, rendering is not', () => {
  const s = at({ clipsNeedingPrompt: 1, clipsNeedingRender: 3, secondsToRender: 45 })
  assert.equal(s.kind, 'write-prompts')
})

test('a render in flight beats everything except the steps before it', () => {
  const s = at({ rendering: true, clipsNeedingRender: 2, clipsAwaitingJudgement: 1 })
  assert.equal(s.kind, 'stop-or-wait')
  assert.match(s.detail, /never resampled/)
})

test('an unapproved plan beats an unwritten prompt', () => {
  assert.equal(at({ approvedClipCount: 0, clipsNeedingPrompt: 4 }).kind, 'approve-groups')
})

test('a thin brief beats approval — the warning lands before the calls are spent', () => {
  assert.equal(at({ awaitingSubdivision: true, approvedClipCount: 0 }).kind, 'resolve-thin-brief')
})

// ── the end ─────────────────────────────────────────────────────────────

test('a rendered clip waiting to be judged asks you to watch it', () => {
  const s = at({ clipsAwaitingJudgement: 2 })
  assert.equal(s.kind, 'watch-and-keep')
  assert.equal(s.action, 'Watch 2 clips')
})

test('a finished film reports what it delivered and how to carry on', () => {
  const s = at({})
  assert.equal(s.kind, 'film-done')
  assert.match(s.detail, /4 clips kept, 60\.3s delivered/)
  assert.match(s.detail, /Add to the plot/)
})

test('every step has words to press or a reason it has none — nothing is a dead end', () => {
  const all: Array<Partial<NextStepInput>> = [
    { plot: '', hasShotList: false }, { hasShotList: false }, { awaitingSubdivision: true },
    { approvedClipCount: 0 }, { clipsNeedingPrompt: 3 }, { rendering: true },
    { clipsNeedingRender: 3, secondsToRender: 45 }, { clipsAwaitingJudgement: 1 }, {},
  ]
  const kinds = new Set<string>()
  for (const p of all) {
    const s = at(p)
    kinds.add(s.kind)
    assert.ok(s.action.trim().length > 0, s.kind)
    assert.ok(s.detail.trim().length > 0, s.kind)
    // "Continue" and "Next" say nothing about what happens.
    assert.doesNotMatch(s.action, /^(Continue|Next|Proceed|Go)$/i)
  }
  // All nine steps are reachable, so none is unreachable dead code.
  assert.equal(kinds.size, 9)
})
