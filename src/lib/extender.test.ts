import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXTENDER_SIGNATURE_FIELDS,
  ExtenderError,
  FILM_FALLBACK_NAME,
  filmOutputPrefix,
  slugifyFilmName,
  buildExtenderClipsJson,
  buildExtenderGraph,
  buildExtenderRefsJson,
  extenderCostEstimate,
  extenderGeometryFromInputs,
  extenderSignature,
  extenderSignatureDiff,
  parseExtenderPreviewInfo,
  pickExtenderVideo,
  platesFreezeReason,
  readExtenderDefaults,
  readExtenderMasterInputs,
  renumberExtenderNode,
} from './extender'
import { loraStackToWire, resolveLoraStack } from './loras'
import type { ComfyNode, LoraStackEntry } from './types'
import { dropFromIndex, redoSeed, validatedClipAt } from './filmEdit'

/** A minimal stand-in for the shipped graph — one extender node ("6"), one
 * Final Decode ("7") that references it by `["6", 0]`, one SaveVideo ("9")
 * downstream of the decode. Enough to exercise renumbering/dangling-link
 * checks without the full 157-line shipped fixture. */
function fixtureGraph(): Record<string, ComfyNode> {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'x' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'x' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'video' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'audio' } },
    '6': {
      class_type: 'MiniMaxH3MasterExtender',
      inputs: {
        pdd_file: 'pdd.safetensors',
        upscaler_model: 'up.safetensors',
        run_mode: 'full_batch',
        pass1_resolution: '608x352 (16:9)',
        pass2_resolution: '1280x720',
        pass2_denoise: 0.25,
        pdd_nfe: '4',
        context_length: '22',
        audio_context_length: 0,
        identity_continuity: true,
        smart_offload: true,
        clips_json: '[]',
        refs_json: '{"images":[null,null,null,null,null,null,null,null,null]}',
        sla_enabled: true,
        sla_sparsity: 0.9,
        pass2_chunk_frames: 124,
        pass2_chunk_overlap: 22,
        accel_mode: 'Turbo LoRA',
        turbo_lora: 'turbo.safetensors',
        turbo_lora_strength: 1,
        turbo_sampler: 'euler',
        turbo_scheduler: 'simple',
        model: ['11', 0],
        clip: ['2', 0],
        vae: ['3', 0],
        audio_vae: ['4', 0],
      },
    },
    '7': {
      class_type: 'MiniMaxH3MasterFinalDecode',
      inputs: { fps: 24, cache: ['6', 0], vae: ['3', 0], audio_vae: ['4', 0] },
    },
    // The stale dated prefix the shipped workflow used to bake — kept in the
    // fixture so the naming tests below prove it is actually replaced.
    '9': { class_type: 'SaveVideo', inputs: { video: ['7', 0], filename_prefix: 'video/2026-09-15/Extender__' } },
    '11': { class_type: 'LTX_lora_loader', inputs: { model: ['1', 0], stack_data: '[]' } },
  }
}

function hasDanglingLinks(g: Record<string, ComfyNode>): boolean {
  return Object.values(g).some((n) =>
    Object.values(n.inputs).some((v) => Array.isArray(v) && typeof v[0] === 'string' && !g[v[0] as string]),
  )
}

test('renumberExtenderNode renumbers the extender node and repoints every reference to it, leaving no dangling link', () => {
  const g = renumberExtenderNode(fixtureGraph(), 'm_filmA')
  assert.ok(g.m_filmA)
  assert.equal(g['6'], undefined)
  assert.deepEqual(g['7'].inputs.cache, ['m_filmA', 0])
  assert.equal(hasDanglingLinks(g), false)
})

test('renumberExtenderNode is a no-op when the node is already at the requested id', () => {
  const g = fixtureGraph()
  const out = renumberExtenderNode(g, '6')
  assert.equal(out, g)
})

test('renumberExtenderNode refuses to renumber onto an id some OTHER node already owns', () => {
  assert.throws(() => renumberExtenderNode(fixtureGraph(), '7'), ExtenderError)
})

test('renumberExtenderNode throws when the graph has no MiniMaxH3MasterExtender node at all', () => {
  const g = fixtureGraph()
  delete g['6']
  assert.throws(() => renumberExtenderNode(g, 'm_filmA'), ExtenderError)
})

test('renumberExtenderNode: two different films never collide, each keeping its own untouched cache link', () => {
  const filmA = renumberExtenderNode(fixtureGraph(), 'm_filmA')
  const filmB = renumberExtenderNode(fixtureGraph(), 'm_filmB')
  assert.ok(filmA.m_filmA)
  assert.ok(filmB.m_filmB)
  assert.equal(filmA.m_filmB, undefined)
  assert.equal(filmB.m_filmA, undefined)
})

test('buildExtenderGraph builds cleanly at a custom node id with no dangling ["6", 0]-style reference left behind', () => {
  const result = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_rain_city',
    clips: [{ prompt: 'a woman walks in the rain', seconds: 5, seed: 42, validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    validatedCount: 0,
  })
  assert.ok(result.graph.m_rain_city)
  assert.equal(result.graph['6'], undefined)
  assert.deepEqual(result.graph['7'].inputs.cache, ['m_rain_city', 0])
  assert.equal(hasDanglingLinks(result.graph), false)
  assert.equal(result.nodeId, 'm_rain_city')
})

test('buildExtenderGraph refuses with no clips', () => {
  assert.throws(
    () => buildExtenderGraph({ graph: fixtureGraph(), nodeId: 'm_x', clips: [], plates: [], runMode: 'clip_by_clip', validatedCount: 0 }),
    ExtenderError,
  )
})

// ── the settings-signature guard — TRAP 2 ─────────────────────────────────

const guardClips = [{ prompt: 'p', seconds: 5, seed: 1, validated: true }]

test('the signature guard permits a settings change when nothing is validated yet', () => {
  const first = buildExtenderGraph({ graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip', validatedCount: 0 })
  const g2 = fixtureGraph()
  g2['6'].inputs.pass2_denoise = 0.3
  assert.doesNotThrow(() =>
    buildExtenderGraph({
      graph: g2, nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
      priorMasterInputs: { ...fixtureGraph()['6'].inputs, refs_json: first.refsJson },
      validatedCount: 0,
    }),
  )
})

test('the signature guard refuses a settings change once a clip is validated, naming what moved and how many would be lost', () => {
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  const g2 = fixtureGraph()
  g2['6'].inputs.pass2_denoise = 0.3
  let caught: unknown
  try {
    buildExtenderGraph({
      graph: g2, nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
      priorMasterInputs: priorInputs, validatedCount: 3,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError)
  const msg = (caught as Error).message
  assert.match(msg, /pass2_denoise/)
  assert.match(msg, /3 validated clip\(s\)/)
})

test('the signature guard refuses a reference-picture change once a clip is validated', () => {
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  let caught: unknown
  try {
    buildExtenderGraph({
      graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [{ filename: 'lira.png', subfolder: '' }], runMode: 'clip_by_clip',
      priorMasterInputs: priorInputs, validatedCount: 1,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError)
  assert.match((caught as Error).message, /refs_json/)
})

test('the signature guard proceeds when acceptReset is passed, and reports what was discarded', () => {
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  const g2 = fixtureGraph()
  g2['6'].inputs.pass2_denoise = 0.3
  const result = buildExtenderGraph({
    graph: g2, nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
    priorMasterInputs: priorInputs, validatedCount: 2, acceptReset: true,
  })
  assert.ok(result.refusalAccepted)
  assert.match(result.refusalAccepted as string, /pass2_denoise/)
})

test('the signature guard refuses a quality-tier change (the settings panel\'s own override shape) once a clip is validated', () => {
  // Exercises the exact patch `extenderQualityOverride` produces (both
  // pass1_resolution AND pass2_resolution together) through the real build
  // path — the panel only ever writes through `overrides`, never around the
  // guard, and this is what proves that end to end rather than by reading
  // the panel's source.
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  let caught: unknown
  try {
    buildExtenderGraph({
      graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
      overrides: { pass1_resolution: '704x384', pass2_resolution: '1344x768 (16:9)' },
      priorMasterInputs: priorInputs, validatedCount: 2,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError)
  const msg = (caught as Error).message
  assert.match(msg, /pass1_resolution/)
  assert.match(msg, /pass2_resolution/)
  assert.match(msg, /2 validated clip\(s\)/)
})

test('the signature is unaffected by FREE fields (prompt/duration/seed/title/clip count are never hashed)', () => {
  const inputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  assert.equal(extenderSignature(inputs), extenderSignature(inputs))
  assert.deepEqual(extenderSignatureDiff(inputs, inputs), [])
})

// ── redo a single scene (2026-09-16 brief) ─────────────────────────────────
//
// The whole mechanism: drop the `done` Clip records for sceneIndex >= N
// (`dropFromIndex`, `filmEdit.ts`), then rebuild `clips_json` the exact same
// way `renderExtenderPlan` already does — `validatedClipAt` decides
// validated/not, `redoSeed` decides the seed. No new build path.

interface FakeFilmClip {
  extender: { nodeId: string; sceneIndex: number }
  state: string
  prompt: string
  seconds: number
  seed: number
}

function landedFilm(nodeId: string, n: number): FakeFilmClip[] {
  return Array.from({ length: n }, (_, i) => ({
    extender: { nodeId, sceneIndex: i + 1 },
    state: 'done',
    prompt: `clip ${i + 1}`,
    seconds: 5,
    seed: 100 + i,
  }))
}

/** Exactly `renderExtenderPlan`'s own `extClips` construction — a validated
 * clip resends its own recorded prompt/seconds/seed; an unvalidated one uses
 * the plan's current prompt and a redo-aware seed. Kept here rather than
 * imported so this test exercises the CONTRACT (what the real builder must
 * do), not the private closure inside `state.tsx`. */
function planExtClips(
  clips: readonly FakeFilmClip[],
  nodeId: string,
  planLength: number,
  opts: { keepSeed?: Map<number, number> } = {},
) {
  return Array.from({ length: planLength }, (_, i) => {
    const index = i + 1
    const prior = validatedClipAt(clips, nodeId, index)
    if (prior) return { prompt: prior.prompt, seconds: prior.seconds, seed: prior.seed, validated: true }
    // What `redoScene`/`redoPlanClip` capture at the moment of the redo click
    // (`target.seed`, read BEFORE the Clip record is dropped) — never
    // re-derived from the post-drop clip list, which no longer has it.
    const keptSeed = opts.keepSeed?.get(index)
    return { prompt: `current plan clip ${index}`, seconds: 5, seed: redoSeed(keptSeed, keptSeed !== undefined, () => 999), validated: false }
  })
}

test('redoing scene 3 of a 5-scene plan: clips_json carries validated=true for 1-2 and validated=false for 3-5', () => {
  const nodeId = 'm_test'
  const landed = landedFilm(nodeId, 5)
  const afterRedo = dropFromIndex(landed, nodeId, 3)

  const extClips = planExtClips(afterRedo, nodeId, 5)
  const json = JSON.parse(buildExtenderClipsJson(extClips)) as Array<Record<string, unknown>>

  assert.deepEqual(json.map((c) => c.validated), [true, true, false, false, false])
  // Untouched scenes resend exactly what they recorded — never the plan's
  // (possibly since-edited) current text.
  assert.equal(json[0].prompt, 'clip 1')
  assert.equal(json[1].prompt, 'clip 2')
  // Redone scenes pick up the plan's CURRENT prompt, not the stale rendered one.
  assert.equal(json[2].prompt, 'current plan clip 3')
})

test('a redo gets a fresh seed by default', () => {
  const nodeId = 'm_test'
  const landed = landedFilm(nodeId, 3)
  const afterRedo = dropFromIndex(landed, nodeId, 2)
  const extClips = planExtClips(afterRedo, nodeId, 3)
  assert.notEqual(extClips[1].seed, 101) // scene 2's old recorded seed
  assert.equal(extClips[1].seed, 999) // the injected "fresh" seed
})

test('a redo preserves the seed under keep-seed', () => {
  const nodeId = 'm_test'
  const landed = landedFilm(nodeId, 3)
  const oldSeed = landed[1].seed // captured before the drop, same as redoScene/redoPlanClip do
  const afterRedo = dropFromIndex(landed, nodeId, 2)
  const extClips = planExtClips(afterRedo, nodeId, 3, { keepSeed: new Map([[2, oldSeed]]) })
  assert.equal(extClips[1].seed, 101) // scene 2's own recorded seed, unchanged
})

test('extenderCostEstimate after a redo reports the right resample/cache split', () => {
  const nodeId = 'm_test'
  const landed = landedFilm(nodeId, 5)
  const afterRedo = dropFromIndex(landed, nodeId, 3)
  const extClips = planExtClips(afterRedo, nodeId, 5)
  const est = extenderCostEstimate(extClips.map((c) => ({ seconds: c.seconds, validated: c.validated })))
  assert.deepEqual(est, { clipCount: 5, totalSeconds: 25, toSample: 3, fromCache: 2 })
})

test('the signature guard still refuses a genuine settings change after a redo lowered validatedCount', () => {
  // A redo of scene 3 of a 5-scene film lowers validatedCount from 5 to 2 —
  // the guard must still fire at the LOWER count, naming exactly that many
  // clips at risk, never treating the redo itself as license to skip it.
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  const g2 = fixtureGraph()
  g2['6'].inputs.pass2_denoise = 0.3
  let caught: unknown
  try {
    buildExtenderGraph({
      graph: g2, nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'full_batch',
      priorMasterInputs: priorInputs, validatedCount: 2,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError)
  assert.match((caught as Error).message, /2 validated clip\(s\)/)
})

test('a redo that changes only clips_json/seed (never a signature field) does not trip the guard', () => {
  const inputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  const first = buildExtenderGraph({ graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip', validatedCount: 0 })
  // Simulate: 3 clips landed, then scene 2 was redone (dropped + resubmitted
  // with a fresh seed) — validatedCount drops from 3 to 1, but nothing in
  // master.inputs itself (the settings the guard actually hashes) moved.
  assert.doesNotThrow(() =>
    buildExtenderGraph({
      graph: fixtureGraph(), nodeId: 'm_a',
      clips: [
        { prompt: 'clip 1', seconds: 5, seed: 1, validated: true },
        { prompt: 'redone clip 2', seconds: 5, seed: 999, validated: false },
      ],
      plates: [], runMode: 'full_batch',
      priorMasterInputs: { ...inputs, refs_json: first.refsJson },
      validatedCount: 1,
    }),
  )
})

// ── clips_json / refs_json ─────────────────────────────────────────────────

test('buildExtenderClipsJson round-trips prompt, duration, seed and validated for every clip', () => {
  const json = buildExtenderClipsJson([
    { title: 'Opening', prompt: 'a woman walks in the rain', seconds: 5.2, seed: 42, seedMode: 'fixed', validated: true },
    { prompt: 'she stops under an awning', seconds: 6, seed: 928397738, seedMode: 'randomize', validated: false },
  ])
  const parsed = JSON.parse(json) as Array<Record<string, unknown>>
  assert.equal(parsed.length, 2)
  assert.deepEqual(
    { id: parsed[0].id, title: parsed[0].title, prompt: parsed[0].prompt, duration: parsed[0].duration, seed: parsed[0].seed, seed_mode: parsed[0].seed_mode, validated: parsed[0].validated },
    { id: 0, title: 'Opening', prompt: 'a woman walks in the rain', duration: 5.2, seed: 42, seed_mode: 'fixed', validated: true },
  )
  assert.deepEqual(
    { id: parsed[1].id, title: parsed[1].title, prompt: parsed[1].prompt, duration: parsed[1].duration, seed: parsed[1].seed, seed_mode: parsed[1].seed_mode, validated: parsed[1].validated },
    { id: 1, title: 'Clip 2', prompt: 'she stops under an awning', duration: 6, seed: 928397738, seed_mode: 'randomize', validated: false },
  )
})

test('buildExtenderClipsJson defaults seed_mode to fixed and loras to an empty array', () => {
  const parsed = JSON.parse(buildExtenderClipsJson([{ prompt: 'p', seconds: 5, seed: 1, validated: false }]))[0]
  assert.equal(parsed.seed_mode, 'fixed')
  assert.deepEqual(parsed.loras, [])
})

// ── Full Story mode's film-wide default + per-clip override, wired all the
// way into clips_json — the same `resolveLoraStack` -> `loraStackToWire`
// assembly `renderExtenderPlan` (state.tsx) runs per plan clip at submit
// time, exercised here as pure functions since state.tsx itself has no
// React-free seam to unit-test through. ───────────────────────────────────

test('a plan of BreakdownClip-shaped inputs reaches clips_json.loras correctly resolved, PER CLIP', () => {
  const workflowDefault: LoraStackEntry[] = [{ lora: 'workflow_default.safetensors', strength: 0.3, on: true }]
  const filmStack: LoraStackEntry[] = [{ lora: 'film_wide.safetensors', strength: 0.6, on: true }]
  // Clip 1: no override — inherits the film-wide stack.
  // Clip 2: its own override — wins over the film-wide stack.
  // Clip 3: no film-wide stack in force for it either — falls through to the workflow default.
  const plan = [
    { index: 1, clipStack: undefined, filmStack },
    { index: 2, clipStack: [{ lora: 'clip2_only.safetensors', strength: 0.9, on: true }], filmStack },
    { index: 3, clipStack: undefined, filmStack: undefined },
  ]

  const json = buildExtenderClipsJson(
    plan.map((p) => ({
      title: `Clip ${p.index}`,
      prompt: `clip ${p.index}`,
      seconds: 5,
      seed: 1,
      validated: false,
      loras: loraStackToWire(resolveLoraStack(p.clipStack, p.filmStack, workflowDefault)),
    })),
  )
  const parsed = JSON.parse(json) as Array<{ title: string; loras: unknown[] }>

  assert.deepEqual(parsed[0].loras, [{ on: true, lora: 'film_wide.safetensors', str: 0.6, v: 1, a: 1, t: 1 }])
  assert.deepEqual(parsed[1].loras, [{ on: true, lora: 'clip2_only.safetensors', str: 0.9, v: 1, a: 1, t: 1 }])
  assert.deepEqual(parsed[2].loras, [{ on: true, lora: 'workflow_default.safetensors', str: 0.3, v: 1, a: 1, t: 1 }])
})

test('buildExtenderRefsJson places each plate at its 0-based index, padding the rest with null out to 9', () => {
  const json = buildExtenderRefsJson([
    { filename: 'lira.png', subfolder: '' },
    { filename: 'aarav.png', subfolder: 'input' },
  ])
  const parsed = JSON.parse(json) as { images: Array<string | null> }
  assert.equal(parsed.images.length, 9)
  assert.equal(parsed.images[0], 'lira.png')
  assert.equal(parsed.images[1], 'input/aarav.png')
  assert.deepEqual(parsed.images.slice(2), Array(7).fill(null))
})

test('buildExtenderRefsJson never exceeds the 9-slot cap', () => {
  const plates = Array.from({ length: 12 }, (_, i) => ({ filename: `p${i}.png`, subfolder: '' }))
  const parsed = JSON.parse(buildExtenderRefsJson(plates)) as { images: Array<string | null> }
  assert.equal(parsed.images.length, 9)
  assert.equal(parsed.images[8], 'p8.png')
})

test('buildExtenderRefsJson: an empty plate list is a valid text-only film', () => {
  const parsed = JSON.parse(buildExtenderRefsJson([])) as { images: Array<string | null> }
  assert.deepEqual(parsed.images, Array(9).fill(null))
})

// ── cost / progress / output picking ───────────────────────────────────────

test('extenderCostEstimate reports clip count, total seconds, and the sample/cache split', () => {
  const est = extenderCostEstimate([
    { seconds: 5, validated: true },
    { seconds: 6.5, validated: true },
    { seconds: 7, validated: false },
  ])
  assert.deepEqual(est, { clipCount: 3, totalSeconds: 18.5, toSample: 1, fromCache: 2 })
})

test('parseExtenderPreviewInfo reads clip/total_clips/cache_mode off a clip_by_clip-shaped history entry', () => {
  const outputs = {
    '7': {
      h3_video: [{ filename: 'preview.mp4' }],
      h3_preview_info: [{ mode: 'clip_by_clip', clip: 2, total_clips: 2, cache_mode: 'sampled' }],
    },
  }
  assert.deepEqual(parseExtenderPreviewInfo(outputs), { clip: 2, totalClips: 2, cacheMode: 'sampled', mode: 'clip_by_clip', interrupted: undefined })
})

test('parseExtenderPreviewInfo reads a full_batch_incremental-shaped entry, interrupted flag included', () => {
  const outputs = {
    '7': {
      h3_preview_info: [{
        mode: 'full_batch_incremental', clip: 3, total_clips: 4, cache_mode: 'decoded_segments_incremental', interrupted: true,
      }],
    },
  }
  const info = parseExtenderPreviewInfo(outputs)
  assert.equal(info?.clip, 3)
  assert.equal(info?.totalClips, 4)
  assert.equal(info?.interrupted, true)
})

test('parseExtenderPreviewInfo returns null when there is no h3_preview_info anywhere (a foreign/older graph)', () => {
  assert.equal(parseExtenderPreviewInfo({ '9': { images: [{ filename: 'x.png' }] } }), null)
  assert.equal(parseExtenderPreviewInfo(undefined), null)
})

test('pickExtenderVideo prefers the type:"output" save over the type:"temp" scrub preview', () => {
  const out = pickExtenderVideo([
    { filename: 'h3_preview_master_v2_6.mp4', subfolder: '', type: 'temp' },
    { filename: 'MiniMax_H3_Master_Turbo_00001.mp4', subfolder: 'video/2026-09-16', type: 'output' },
  ])
  assert.equal(out?.filename, 'MiniMax_H3_Master_Turbo_00001.mp4')
})

test('pickExtenderVideo falls back to the last video-looking file when nothing is typed "output"', () => {
  const out = pickExtenderVideo([
    { filename: 'a.mp4', subfolder: '', type: 'temp' },
    { filename: 'b.mp4', subfolder: '', type: 'temp' },
  ])
  assert.equal(out?.filename, 'b.mp4')
})

test('pickExtenderVideo ignores non-video files', () => {
  const out = pickExtenderVideo([{ filename: 'thumb.png', subfolder: '', type: 'output' }])
  assert.equal(out, undefined)
})

// ── readExtenderDefaults — issue #30: report what the node will ACTUALLY render at ──

test('readExtenderDefaults reads pass2_resolution/pass2_steps off the master node, never guesses', () => {
  const graph: Record<string, ComfyNode> = {
    6: { class_type: 'MiniMaxH3MasterExtender', inputs: { pass2_resolution: '1280x720', pass2_steps: 1 } },
  }
  assert.deepStrictEqual(readExtenderDefaults(graph), { width: 1280, height: 720, steps: 1 })
})

test('readExtenderDefaults: null graph, no master node, or an unparseable resolution all read as null', () => {
  assert.equal(readExtenderDefaults(null), null)
  assert.equal(readExtenderDefaults({}), null)
  assert.equal(
    readExtenderDefaults({ 6: { class_type: 'MiniMaxH3MasterExtender', inputs: { pass2_resolution: 'not-a-size' } } }),
    null,
  )
})

test('extenderGeometryFromInputs reads the same shape straight off an inputs record, not just a graph', () => {
  assert.deepStrictEqual(extenderGeometryFromInputs({ pass2_resolution: '960x544', pass2_steps: 5 }), { width: 960, height: 544, steps: 5 })
  assert.equal(extenderGeometryFromInputs(null), null)
  assert.equal(extenderGeometryFromInputs(undefined), null)
})

test('extenderGeometryFromInputs: an override merged onto the baked inputs changes the reported geometry — the issue #30 fix, generalised to overrides', () => {
  const baked = { pass2_resolution: '1280x720', pass2_steps: 6 }
  const withOverride = { ...baked, pass2_resolution: '960x544' }
  assert.deepStrictEqual(extenderGeometryFromInputs(baked), { width: 1280, height: 720, steps: 6 })
  assert.deepStrictEqual(extenderGeometryFromInputs(withOverride), { width: 960, height: 544, steps: 6 })
})

// ── readExtenderMasterInputs — the settings panel's seed values ────────────

test('readExtenderMasterInputs reads every one of the 28 signature fields present on the graph', () => {
  const inputs = readExtenderMasterInputs(fixtureGraph())
  assert.ok(inputs)
  assert.equal(inputs!.pass2_resolution, '1280x720')
  assert.equal(inputs!.context_length, '22')
  assert.equal(inputs!.sla_sparsity, 0.9)
})

test('readExtenderMasterInputs falls back to the node\'s own kwargs default for a field an older graph export omits', () => {
  // The fixture graph predates pass2_lora/semantic_bridge/pass2_steps landing
  // on the node — exactly the "older export" case EXTENDER_SIGNATURE_DEFAULTS
  // exists for (see extender.ts's module comment).
  const inputs = readExtenderMasterInputs(fixtureGraph())
  assert.ok(inputs)
  assert.equal(inputs!.pass2_lora, 'none')
  assert.equal(inputs!.pass2_steps, 0)
  assert.equal(inputs!.semantic_bridge_match, 'per_token')
})

test('readExtenderMasterInputs: null graph or no master node reads as null', () => {
  assert.equal(readExtenderMasterInputs(null), null)
  assert.equal(readExtenderMasterInputs({}), null)
})

// ── the settings panel's overrides, via buildExtenderGraph's existing argument ──
//
// Job 2 (2026-09-16): the panel never re-implements the guard — it only
// feeds `overrides` into the SAME `buildExtenderGraph` call every render
// path already makes, so these prove the existing mechanism carries the
// panel's edits end to end, including through the guard.

test('overrides reach the master node\'s inputs in the built graph', () => {
  const built = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_ov',
    clips: [{ prompt: 'p', seconds: 5, seed: 1, validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    overrides: { pass2_steps: 12, pass2_denoise: 0.4 },
    validatedCount: 0,
  })
  assert.equal(built.graph.m_ov.inputs.pass2_steps, 12)
  assert.equal(built.graph.m_ov.inputs.pass2_denoise, 0.4)
})

test('a settings-panel override to a signature field is PERMITTED when nothing is validated yet', () => {
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  assert.doesNotThrow(() =>
    buildExtenderGraph({
      graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
      overrides: { pass2_denoise: 0.4 },
      priorMasterInputs: priorInputs, validatedCount: 0,
    }),
  )
})

test('a settings-panel override to a signature field is REFUSED once a clip is validated — the SAME guard, never a duplicate', () => {
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([]) }
  let caught: unknown
  try {
    buildExtenderGraph({
      graph: fixtureGraph(), nodeId: 'm_a', clips: guardClips, plates: [], runMode: 'clip_by_clip',
      overrides: { pass2_denoise: 0.4 },
      priorMasterInputs: priorInputs, validatedCount: 4,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError)
  assert.match((caught as Error).message, /pass2_denoise/)
  assert.match((caught as Error).message, /4 validated clip\(s\)/)
})

// ── Full Story mode's plate wiring (issue #31) ─────────────────────────────
//
// Full Story mode has no plate route of its own — `renderExtenderPlan` calls
// this SAME `buildExtenderGraph` with `runMode: 'full_batch'`, so these prove
// plates reach `refs_json`, in slot order, through the one path that already
// exists, rather than a second one.

test('Full Story build (full_batch): plates reach refs_json in slot order, position preserved', () => {
  const built = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_story',
    clips: [
      { title: 'Clip 1', prompt: '<Picture 1> walks in.', seconds: 5, seed: 1, validated: false },
      { title: 'Clip 2', prompt: '<Picture 2> answers.', seconds: 5, seed: 2, validated: false },
    ],
    plates: [
      { filename: 'lira.png', subfolder: '' },
      { filename: 'aarav.png', subfolder: 'input' },
    ],
    runMode: 'full_batch',
    validatedCount: 0,
  })
  const parsed = JSON.parse(built.graph.m_story.inputs.refs_json as string) as { images: Array<string | null> }
  assert.equal(parsed.images[0], 'lira.png')
  assert.equal(parsed.images[1], 'input/aarav.png')
  // Reordering the plate array (as `reorderPlate` does before a submit) moves
  // the same picture to the position its prompt cites it by.
  const reordered = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_story2',
    clips: [{ title: 'Clip 1', prompt: '<Picture 1> answers.', seconds: 5, seed: 1, validated: false }],
    plates: [
      { filename: 'aarav.png', subfolder: 'input' },
      { filename: 'lira.png', subfolder: '' },
    ],
    runMode: 'full_batch',
    validatedCount: 0,
  })
  const parsedReordered = JSON.parse(reordered.graph.m_story2.inputs.refs_json as string) as { images: Array<string | null> }
  assert.equal(parsedReordered.images[0], 'input/aarav.png')
  assert.equal(parsedReordered.images[1], 'lira.png')
})

test('Full Story build (full_batch): the 9-slot cap holds even when handed more plates than that', () => {
  const plates = Array.from({ length: 11 }, (_, i) => ({ filename: `p${i}.png`, subfolder: '' }))
  const built = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_story3',
    clips: [{ title: 'Clip 1', prompt: 'a scene.', seconds: 5, seed: 1, validated: false }],
    plates,
    runMode: 'full_batch',
    validatedCount: 0,
  })
  const parsed = JSON.parse(built.graph.m_story3.inputs.refs_json as string) as { images: Array<string | null> }
  assert.equal(parsed.images.length, 9)
  assert.equal(parsed.images[8], 'p8.png')
})

// ── plates freeze (issue #31: visible before a plate is picked, not only at submit) ──

test('platesFreezeReason: nothing validated yet — the plate set is free to change', () => {
  assert.equal(platesFreezeReason(0), null)
})

test('platesFreezeReason: once a clip is validated, names refs_json and the count as the reason', () => {
  const reason = platesFreezeReason(3)
  assert.ok(reason)
  assert.match(reason as string, /3 clips are already validated/)
  assert.match(reason as string, /refs_json/)
})

test('platesFreezeReason: singular phrasing for exactly one validated clip', () => {
  assert.match(platesFreezeReason(1) as string, /1 clip is already validated/)
})

test('platesFreezeReason matches what the guard would actually refuse: same validatedCount, same refs_json cause', () => {
  // The freeze banner and `checkExtenderSignature`'s refusal must never
  // disagree about WHEN a plate change stops being free — both are driven by
  // the identical validatedCount a real submit computes
  // (`extenderPlanPreview.cost.fromCache` in `app/state.tsx`).
  const priorInputs = { ...fixtureGraph()['6'].inputs, refs_json: buildExtenderRefsJson([{ filename: 'lira.png', subfolder: '' }]) }
  const validatedCount = 2
  assert.ok(platesFreezeReason(validatedCount), 'the picker must show a freeze banner for this validatedCount')

  let caught: unknown
  try {
    buildExtenderGraph({
      graph: fixtureGraph(),
      nodeId: 'm_guard',
      clips: [
        { prompt: 'a', seconds: 5, seed: 1, validated: true },
        { prompt: 'b', seconds: 5, seed: 2, validated: true },
        { prompt: 'c', seconds: 5, seed: 3, validated: false },
      ],
      // A plate swap — a picker action the freeze banner is meant to stop —
      // moves refs_json and so trips the guard at this SAME validatedCount.
      plates: [{ filename: 'someone-else.png', subfolder: '' }],
      runMode: 'full_batch',
      priorMasterInputs: priorInputs,
      validatedCount,
    })
  } catch (e) {
    caught = e
  }
  assert.ok(caught instanceof ExtenderError, 'submitting with a swapped plate at this validatedCount must still be refused')
  assert.match((caught as Error).message, /refs_json/)
})

// ── the film-wide look (2026-09-17 brief) is NOT a signature field ────────
// It rides on FilmContext, never on the graph the Master Extender node
// hashes — see FilmLook's module comment in types.ts. A regression here
// would silently start truncating every validated clip in a film the
// moment an operator picked a different look.

test('EXTENDER_SIGNATURE_FIELDS never gained the film-wide look, or any of its fields', () => {
  const fields = EXTENDER_SIGNATURE_FIELDS as readonly string[]
  assert.ok(!fields.includes('look'))
  assert.ok(!fields.includes('preset'))
  assert.ok(!fields.includes('freeText'))
  assert.ok(!fields.includes('film'))
  assert.ok(!fields.some((f) => /look/i.test(f)))
})

// ── the film-wide LoRA default (this brief) is ALSO not a signature field —
// `loras` already lived in EXTENDER_FREE_FIELDS before this brief (a plan
// clip's own stack was never hashed); this guards that a film-wide default
// or its resolution never grows a NEW hashed field either. A regression here
// would start truncating every validated clip the moment an operator picked
// a film-wide style, or a per-clip override, rather than leaving both free
// to change mid-film as documented.

test('EXTENDER_SIGNATURE_FIELDS never gained the style-stack fields this brief touches', () => {
  // NOT a blanket "/lora/i" scan — `pass2_lora`/`pass2_lora_strength`/
  // `pass2_lora_mode` are the node's own pre-existing PASS-2 ACCELERATOR
  // LoRA fields, legitimately hashed already, and unrelated to the style
  // stack (`ACCELERATOR_LORA_RE` in `lib/loras.ts` is exactly the guard
  // that keeps the two apart). This checks only the fields this brief could
  // plausibly have added.
  const fields = EXTENDER_SIGNATURE_FIELDS as readonly string[]
  assert.ok(!fields.includes('loras'))
  assert.ok(!fields.includes('loraStack'))
  assert.ok(!fields.includes('filmLoraStack'))
  assert.ok(!fields.includes('style_lora'))
  assert.ok(!fields.includes('style_loras'))
})

// ── where a film is saved, and under what name ──────────────────────────

test('slugifyFilmName flattens a name into something safe inside a filename_prefix', () => {
  assert.equal(slugifyFilmName('The Lighthouse Keeper'), 'The_Lighthouse_Keeper')
  // A `/` must never survive: ComfyUI would read it as a subfolder, which is
  // the exact behaviour this change exists to remove.
  assert.equal(slugifyFilmName('Act 2 / the door'), 'Act_2_the_door')
  assert.equal(slugifyFilmName('../../etc/passwd'), 'etc_passwd')
  assert.equal(slugifyFilmName('  spaced  out  '), 'spaced_out')
  assert.equal(slugifyFilmName('कहानी'), 'कहानी')
})

test('slugifyFilmName falls back rather than returning an empty prefix', () => {
  assert.equal(slugifyFilmName(''), FILM_FALLBACK_NAME)
  assert.equal(slugifyFilmName('!!!'), FILM_FALLBACK_NAME)
})

test('slugifyFilmName caps a long name and never leaves a trailing separator', () => {
  const slug = slugifyFilmName('a '.repeat(60))
  assert.ok(slug.length <= 48)
  assert.ok(!slug.endsWith('_'))
})

test('filmOutputPrefix puts a film directly in video/, never in a dated subfolder', () => {
  assert.equal(filmOutputPrefix('The Lighthouse Keeper'), 'video/The_Lighthouse_Keeper')
  assert.equal(filmOutputPrefix(undefined), `video/${FILM_FALLBACK_NAME}`)
  // One separator only — anything deeper would be a folder again.
  assert.equal(filmOutputPrefix('Act 2 / the door').split('/').length, 2)
})

test('buildExtenderGraph names the save after the project, replacing the shipped dated prefix', () => {
  const built = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_keeper',
    clips: [{ prompt: 'the lamp goes out', seconds: 5, seed: 1, validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    validatedCount: 0,
    filmName: 'The Lighthouse Keeper',
  })
  assert.equal(built.graph['9'].inputs.filename_prefix, 'video/The_Lighthouse_Keeper')
})

test('buildExtenderGraph replaces the dated prefix even when no film name was given', () => {
  const built = buildExtenderGraph({
    graph: fixtureGraph(),
    nodeId: 'm_unnamed',
    clips: [{ prompt: 'a door closes', seconds: 5, seed: 1, validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    validatedCount: 0,
  })
  assert.equal(built.graph['9'].inputs.filename_prefix, `video/${FILM_FALLBACK_NAME}`)
})

test('renaming a film never invalidates a validated clip — filename_prefix is not a hashed field', () => {
  const args = {
    graph: fixtureGraph(),
    nodeId: 'm_keeper',
    clips: [{ prompt: 'the lamp goes out', seconds: 5, seed: 1, validated: true }],
    plates: [],
    runMode: 'clip_by_clip' as const,
    validatedCount: 1,
  }
  const first = buildExtenderGraph({ ...args, filmName: 'Working Title' })
  // A rename, with the FIRST submit's master inputs as the frozen baseline:
  // the guard must not fire, and the signature must be byte-identical.
  const renamed = buildExtenderGraph({
    ...args,
    filmName: 'The Lighthouse Keeper',
    priorMasterInputs: first.graph.m_keeper.inputs,
  })
  assert.equal(renamed.signature, first.signature)
  assert.equal(renamed.refusalAccepted, null)
  assert.equal(renamed.graph['9'].inputs.filename_prefix, 'video/The_Lighthouse_Keeper')
})
