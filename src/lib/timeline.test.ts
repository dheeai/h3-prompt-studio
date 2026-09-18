import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Breakdown, BreakdownClip, Clip, Shot, ShotGroup, Version } from './types'
import type { DirectedShot, DirectionDoc } from './direction'
import { buildTimeline, deriveClipTimelineState } from './timeline'
import type { TimelineInput } from './timeline'

// ── fixtures ───────────────────────────────────────────────────────────

function shot(index: number, covers: string, seconds: number): Shot {
  return { index, covers, seconds }
}

function group(index: number, shotIndices: number[], seconds: number): ShotGroup {
  return { index, shotIndices, seconds }
}

function planClip(index: number, over: Partial<BreakdownClip> = {}): BreakdownClip {
  return { index, title: `Clip ${index}`, role: 'rising', seconds: 12, covers: '', precedes: '', follows: '', ...over }
}

function promptVersion(clipIndex: number, text = 'a prompt'): Version {
  return { id: `v${clipIndex}`, stage: 'draft', label: 'Draft', text, model: 'm', providerId: 'p', at: 0, ms: 0, clipIndex }
}

function renderedClip(nodeId: string, sceneIndex: number, state: Clip['state'], id = `c${sceneIndex}`): Clip {
  return {
    id,
    index: sceneIndex,
    parentId: null,
    state,
    prompt: `prompt ${sceneIndex}`,
    plateIds: [],
    at: sceneIndex,
    extender: { nodeId, sceneIndex },
  }
}

function directedShot(over: Partial<DirectedShot> & { index: number; cameraMovement: string }): DirectedShot {
  return {
    whyThisShot: '',
    viewerGaze: '',
    cameraStartAngle: '',
    cameraEndAngle: '',
    optics: '',
    backgroundTreatment: '',
    action: '',
    environmentalPressure: '',
    physicalMicroAction: '',
    thirdConcreteFact: '',
    ...over,
  }
}

function directionDoc(clipIndex: number, shots: DirectedShot[]): DirectionDoc {
  return { clipIndex, wantRightNow: '', obstacle: '', geometrySentence: '', rhythm: '', whyTheseShots: '', shots }
}

const EMPTY: TimelineInput = {
  shotList: { shots: [] },
  shotGroups: [],
  breakdown: null,
  clips: [],
  versions: [],
  nodeId: undefined,
}

// ── deriveClipTimelineState — all six, directly ───────────────────────────

test('deriveClipTimelineState: no render record and no prompt is planned', () => {
  assert.equal(deriveClipTimelineState(undefined, false, false), 'planned')
})

test('deriveClipTimelineState: no render record but a prompt exists is written', () => {
  assert.equal(deriveClipTimelineState(undefined, true, false), 'written')
})

test('deriveClipTimelineState: queued (submitted, nothing back yet) is written', () => {
  assert.equal(deriveClipTimelineState('queued', true, false), 'written')
})

test('deriveClipTimelineState: rendering is rendering regardless of validated/prompt', () => {
  assert.equal(deriveClipTimelineState('rendering', true, false), 'rendering')
  assert.equal(deriveClipTimelineState('rendering', false, true), 'rendering')
})

test('deriveClipTimelineState: failed is failed regardless of validated/prompt', () => {
  assert.equal(deriveClipTimelineState('failed', true, true), 'failed')
})

test('deriveClipTimelineState: done and validated is kept', () => {
  assert.equal(deriveClipTimelineState('done', true, true), 'kept')
})

test('deriveClipTimelineState: done but not validated is rendered, not kept', () => {
  assert.equal(deriveClipTimelineState('done', true, false), 'rendered')
})

// ── empty / minimal films ─────────────────────────────────────────────────

test('buildTimeline: an empty shot list produces an empty, zero-length timeline', () => {
  const t = buildTimeline(EMPTY)
  assert.deepEqual(t.clips, [])
  assert.equal(t.totalSeconds, 0)
  assert.equal(t.isEstimate, false)
  assert.deepEqual(t.runtimeBar, { keptSeconds: 0, renderedSeconds: 0, remainingSeconds: 0 })
})

test('buildTimeline: a single shot in a single clip', () => {
  const t = buildTimeline({
    ...EMPTY,
    shotList: { shots: [shot(1, 'Aisha unlocks the shutter alone', 8)] },
    shotGroups: [group(1, [1], 8)],
    breakdown: { spine: 'a morning', at: 0, clips: [planClip(1, { seconds: 8, covers: 'Aisha unlocks the shutter alone' })] },
  })
  assert.equal(t.clips.length, 1)
  const c = t.clips[0]
  assert.equal(c.shots.length, 1)
  assert.equal(c.shots[0].shotIndex, 1)
  assert.equal(c.shots[0].clipPosition, 1)
  assert.equal(c.shots[0].clipStartSeconds, 0)
  assert.equal(c.shots[0].filmStartSeconds, 0)
  assert.equal(c.state, 'planned') // no prompt authored, nothing rendered
})

test('buildTimeline: a BreakdownClip whose ShotGroup has gone missing still gets a row, with no shots', () => {
  const t = buildTimeline({
    ...EMPTY,
    breakdown: { spine: 's', at: 0, clips: [planClip(1, { seconds: 9 })] },
  })
  assert.equal(t.clips.length, 1)
  assert.deepEqual(t.clips[0].shots, [])
  assert.equal(t.clips[0].askedSeconds, 9) // falls back to the frozen BreakdownClip.seconds
})

test('buildTimeline: a ShotGroup with no BreakdownClip yet reads as planned, titled generically', () => {
  const t = buildTimeline({
    ...EMPTY,
    shotList: { shots: [shot(1, 'the shop opens', 6)] },
    shotGroups: [group(1, [1], 6)],
    breakdown: null,
  })
  assert.equal(t.clips.length, 1)
  assert.equal(t.clips[0].state, 'planned')
  assert.equal(t.clips[0].title, 'clip 1')
  assert.equal(t.clips[0].askedSeconds, 6)
})

// ── film-wide shot number vs. in-clip position ────────────────────────────

test('buildTimeline: film-wide shot number and in-clip position are reported separately, never conflated', () => {
  const shots: Shot[] = [
    shot(1, 'Aisha opens the shop', 3),
    shot(2, 'She counts the till', 4),
    shot(3, 'A customer walks in', 5),
    shot(4, 'They haggle over the price', 6),
    shot(5, 'She relents with a laugh', 5),
  ]
  const groups: ShotGroup[] = [group(1, [1, 2, 3], 12), group(2, [4, 5], 11)]
  const breakdown: Breakdown = { spine: 's', at: 0, clips: [planClip(1, { seconds: 12 }), planClip(2, { seconds: 11 })] }

  const t = buildTimeline({ ...EMPTY, shotList: { shots }, shotGroups: groups, breakdown })

  assert.equal(t.clips.length, 2)
  // Clip 2's SECOND clip starts at film-wide shot 4 — its own first shot.
  const clip2Shots = t.clips[1].shots
  assert.deepEqual(clip2Shots.map((s) => s.shotIndex), [4, 5])
  assert.deepEqual(clip2Shots.map((s) => s.clipPosition), [1, 2])
  // Film shot 8 would be clip 2's 5th shot, were this film that long — the
  // relationship under test is shotIndex - (first shotIndex of the clip) + 1.
  assert.equal(clip2Shots[1].shotIndex - clip2Shots[0].shotIndex + 1, clip2Shots[1].clipPosition)
})

// ── shot absolute starts, within and across clips ─────────────────────────

test('buildTimeline: shot starts accumulate from their own clips start, both intra-clip and absolute', () => {
  const shots: Shot[] = [shot(1, 'a', 3), shot(2, 'b', 4), shot(3, 'c', 5), shot(4, 'd', 6), shot(5, 'e', 5)]
  const groups: ShotGroup[] = [group(1, [1, 2, 3], 12), group(2, [4, 5], 11)]
  const breakdown: Breakdown = { spine: 's', at: 0, clips: [planClip(1, { seconds: 12 }), planClip(2, { seconds: 11 })] }

  const t = buildTimeline({ ...EMPTY, shotList: { shots }, shotGroups: groups, breakdown })

  const [c1, c2] = t.clips
  // Intra-clip: cumulative from 0 within clip 1.
  assert.deepEqual(c1.shots.map((s) => s.clipStartSeconds), [0, 3, 7])
  // Neither clip has rendered, so both clips' lengths are still estimates —
  // clip 2 starts exactly where clip 1's ASKED 12s ends (no delivered fact
  // exists yet for either).
  assert.equal(c1.filmStartSeconds, 0)
  assert.equal(c2.filmStartSeconds, 12)
  // Absolute = clip start + intra-clip offset.
  assert.deepEqual(c2.shots.map((s) => s.filmStartSeconds), [12, 12 + 6])
})

// ── the bug under test: clip starts accumulate DELIVERED seconds, not asked ─

test('buildTimeline: a rendered clip that asked 15s but grid-snaps to more pushes every later clip by the DELIVERED figure, not the ask', () => {
  const nodeId = 'm_1'
  const shots: Shot[] = [shot(1, 'the long establishing shot', 15), shot(2, 'a short reaction', 5)]
  const groups: ShotGroup[] = [group(1, [1], 15), group(2, [2], 5)]
  const breakdown: Breakdown = { spine: 's', at: 0, clips: [planClip(1, { seconds: 15 }), planClip(2, { seconds: 5 })] }
  // Clip 1 has rendered (done + validated); clip 2 has not.
  const clips: Clip[] = [renderedClip(nodeId, 1, 'done')]
  const versions: Version[] = [promptVersion(1), promptVersion(2)]

  const t = buildTimeline({ ...EMPTY, shotList: { shots }, shotGroups: groups, breakdown, clips, versions, nodeId })

  const [c1, c2] = t.clips
  assert.equal(c1.state, 'kept')
  assert.equal(c1.isEstimate, false)
  // 15s @ 24fps = 360 raw frames; H3's 17k+5 grid snaps that to 362 frames
  // (measured behaviour `clipTiming` already encodes) = 15.0833...s, NOT 15.0s.
  assert.equal(c1.padded.authored, 360)
  assert.equal(c1.padded.delivered, 362)
  assert.equal(c1.deliveredSeconds, 15.083)
  // Clip 2 starts at clip 1's DELIVERED 15.083s, not its asked 15.0s.
  assert.equal(c2.filmStartSeconds, 15.083)
  assert.notEqual(c2.filmStartSeconds, 15)
  // Clip 2 itself has not rendered yet, so it is written (has a prompt) and
  // its own length is an honest estimate, not a fabricated delivered figure.
  assert.equal(c2.state, 'written')
  assert.equal(c2.isEstimate, true)
  assert.equal(c2.deliveredSeconds, c2.askedSeconds)
})

// ── every clip state, on a real mixed film ────────────────────────────────

test('buildTimeline: a film mixing every reachable state reports each correctly', () => {
  const nodeId = 'm_2'
  const shots: Shot[] = [shot(1, 'a', 4), shot(2, 'b', 4), shot(3, 'c', 4), shot(4, 'd', 4), shot(5, 'e', 4)]
  const groups: ShotGroup[] = [
    group(1, [1], 4), // rendered + validated -> kept
    group(2, [2], 4), // rendering right now
    group(3, [3], 4), // errored -> failed
    group(4, [4], 4), // approved, prompt written, not submitted -> written
    // group 5 has no shot and no breakdown clip below (never approved) -> planned
  ]
  const breakdown: Breakdown = {
    spine: 's',
    at: 0,
    clips: [planClip(1, { seconds: 4 }), planClip(2, { seconds: 4 }), planClip(3, { seconds: 4 }), planClip(4, { seconds: 4 })],
  }
  const clips: Clip[] = [renderedClip(nodeId, 1, 'done'), renderedClip(nodeId, 2, 'rendering'), renderedClip(nodeId, 3, 'failed')]
  const versions: Version[] = [promptVersion(1), promptVersion(2), promptVersion(3), promptVersion(4)]

  const t = buildTimeline({
    ...EMPTY,
    shotList: { shots },
    shotGroups: [...groups, group(5, [5], 4)],
    breakdown,
    clips,
    versions,
    nodeId,
  })

  const byIndex = new Map(t.clips.map((c) => [c.index, c]))
  assert.equal(byIndex.get(1)?.state, 'kept')
  assert.equal(byIndex.get(2)?.state, 'rendering')
  assert.equal(byIndex.get(3)?.state, 'failed')
  assert.equal(byIndex.get(4)?.state, 'written')
  assert.equal(byIndex.get(5)?.state, 'planned') // shot group 5 was never approved
})

// ── the runtime bar ────────────────────────────────────────────────────────

test('buildTimeline: the runtime bar (kept + rendered + remaining) sums exactly to the film total', () => {
  const nodeId = 'm_3'
  const shots: Shot[] = [shot(1, 'a', 6), shot(2, 'b', 6), shot(3, 'c', 6)]
  const groups: ShotGroup[] = [group(1, [1], 6), group(2, [2], 6), group(3, [3], 6)]
  const breakdown: Breakdown = {
    spine: 's',
    at: 0,
    clips: [planClip(1, { seconds: 6 }), planClip(2, { seconds: 6 }), planClip(3, { seconds: 6 })],
  }
  // Clip 1 kept, clip 2 rendered-but-not-kept (constructed directly via a
  // 'done' record whose scene the caller has not marked validated any other
  // way this codebase currently expresses — see `deriveClipTimelineState`'s
  // own module comment), clip 3 still just written.
  const clips: Clip[] = [renderedClip(nodeId, 1, 'done'), renderedClip(nodeId, 2, 'done')]
  const versions: Version[] = [promptVersion(1), promptVersion(2), promptVersion(3)]

  const t = buildTimeline({ ...EMPTY, shotList: { shots }, shotGroups: groups, breakdown, clips, versions, nodeId })

  const sum = +(t.runtimeBar.keptSeconds + t.runtimeBar.renderedSeconds + t.runtimeBar.remainingSeconds).toFixed(3)
  assert.equal(sum, t.totalSeconds)
  // Both rendered clips are 'done' -> validated -> kept, in THIS codebase's
  // actual validated rule (see `filmEdit.ts`'s `validatedClipAt`) — so all of
  // it lands in kept, none in the separate 'rendered' bucket. That is a real,
  // reachable fact about how this app currently wires validation, not a gap
  // in this file's own accounting.
  assert.equal(t.runtimeBar.renderedSeconds, 0)
  assert.ok(t.runtimeBar.keptSeconds > 0)
  assert.ok(t.runtimeBar.remainingSeconds > 0)
})

// ── camera terms from a clip's DirectionDoc, matched by in-clip position ──

test('buildTimeline: a directed clips shots carry their camera term, matched by clip position not film-wide index', () => {
  const shots: Shot[] = [shot(1, 'a', 3), shot(2, 'b', 3), shot(3, 'c', 3), shot(4, 'd', 3)]
  const groups: ShotGroup[] = [group(1, [1, 2], 6), group(2, [3, 4], 6)]
  const breakdown: Breakdown = { spine: 's', at: 0, clips: [planClip(1, { seconds: 6 }), planClip(2, { seconds: 6 })] }
  const directionByClip = {
    2: directionDoc(2, [
      directedShot({ index: 1, cameraMovement: 'Push In' }),
      directedShot({ index: 2, cameraMovement: 'Pan Left' }),
    ]),
  }

  const t = buildTimeline({ ...EMPTY, shotList: { shots }, shotGroups: groups, breakdown, directionByClip })

  assert.equal(t.clips[0].shots[0].cameraMovement, undefined) // clip 1 was never directed
  assert.equal(t.clips[1].shots[0].cameraMovement, 'Push In') // clip 2, in-clip shot 1 (film shot 3)
  assert.equal(t.clips[1].shots[1].cameraMovement, 'Pan Left') // clip 2, in-clip shot 2 (film shot 4)
})

// ── verbatim text — no normalisation, ever ────────────────────────────────

test('buildTimeline: a shots covers text survives byte-for-byte, including non-Latin script', () => {
  const covers = 'कहानी शुरू होती है — दुकान खुलती है'
  const t = buildTimeline({
    ...EMPTY,
    shotList: { shots: [shot(1, covers, 5)] },
    shotGroups: [group(1, [1], 5)],
    breakdown: { spine: 's', at: 0, clips: [planClip(1, { seconds: 5 })] },
  })
  assert.equal(t.clips[0].shots[0].covers, covers)
  assert.equal(t.clips[0].shots[0].covers.length, covers.length)
})
