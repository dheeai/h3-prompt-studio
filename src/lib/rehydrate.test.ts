import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reconcileRehydratedClips } from './rehydrate'
import type { Clip } from './types'

function makeClip(over: Partial<Clip> = {}): Clip {
  return { id: 'c1', index: 1, parentId: null, state: 'done', prompt: 'a prompt', plateIds: [], at: 0, ...over }
}

test('reconcileRehydratedClips turns a stale "rendering" clip into a visibly-failed one, naming its promptId', () => {
  const [reconciled] = reconcileRehydratedClips([makeClip({ state: 'rendering', promptId: 'abc123' })])
  assert.equal(reconciled.state, 'failed')
  assert.ok(reconciled.error?.includes('abc123'))
  assert.ok(reconciled.error?.includes('reload'))
})

test('reconcileRehydratedClips leaves a rendering clip with no promptId still visibly failed, without inventing one', () => {
  const [reconciled] = reconcileRehydratedClips([makeClip({ state: 'rendering', promptId: undefined })])
  assert.equal(reconciled.state, 'failed')
  assert.equal(reconciled.error?.includes('undefined'), false)
})

test('reconcileRehydratedClips never touches a clip that is not mid-render', () => {
  const done = makeClip({ state: 'done' })
  const failed = makeClip({ id: 'c2', state: 'failed', error: 'already failed' })
  const queued = makeClip({ id: 'c3', state: 'queued' })
  const [r1, r2, r3] = reconcileRehydratedClips([done, failed, queued])
  assert.deepEqual(r1, done)
  assert.deepEqual(r2, failed)
  assert.deepEqual(r3, queued)
})

test('reconcileRehydratedClips keeps every other field (extender, prompt, seed) intact so Redo still works', () => {
  const [reconciled] = reconcileRehydratedClips([
    makeClip({ state: 'rendering', promptId: 'p1', prompt: 'the six sections', seed: 42, extender: { nodeId: 'n1', sceneIndex: 2 } }),
  ])
  assert.equal(reconciled.prompt, 'the six sections')
  assert.equal(reconciled.seed, 42)
  assert.deepEqual(reconciled.extender, { nodeId: 'n1', sceneIndex: 2 })
})
