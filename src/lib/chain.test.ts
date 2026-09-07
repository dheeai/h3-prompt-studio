import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildChainGraph, chainIssues, chainShotsForPlan, citeToTag, pickAssembledVideo, snapUp, ChainError,
  chainMinSteps, CHAIN_MIN_STEPS_SLA, CHAIN_MIN_STEPS_VSA, CHAIN_MIN_STEPS_DEFAULT,
  CANONICAL_UNET, CANONICAL_TURBO_LORA, SINGULARITY_UNET,
  ACCELERATOR_LORA_RE, EXPLICIT_LORA_RE, selectableStyleLoras, serializeLoraStack, readBakedLoraStack,
  loraStackKey, planNeedsPerSceneLoraSplit, localLoraStackOverride, chainWarnings } from './chain'
import { padForOverlap } from './frames'
import type { ChainPlate, ChainPlanClip, ChainShot } from './chain'
import type { ComfyNode, LoraStackEntry } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, '__fixtures__')

function loadFixture(name: string): Record<string, ComfyNode> {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, ComfyNode>
}

/**
 * The golden graph is a REAL output of h3-shots' own tool:
 *
 *   cd ~/Projects/h3-shots
 *   node scaffold.mjs __chain_probe_studio --clips 3 --width 864 --height 480 --frames 362
 *   node submit.mjs __chain_probe_studio --longform chain --shots 1-3 --dry --audio-context 0
 *
 * `contexloop_workflow.json` is the exact base workflow that run loaded
 * (`workflows/minimax_h3_contexloop_api.json`), and `chain_golden.graph.json`
 * is the `.graph.json` it wrote — untouched, so this test is comparing this
 * port's output against an independently-produced ComfyUI graph, not against
 * anything hand-written for the test.
 *
 * The scaffold names its one reference plate `hero` (file `hero.png`), and its
 * clip prose names the plate by literal FILENAME ("...shown in hero.png..."),
 * which h3-shots' own `tagifyPrompt` turns into `@hero`. The studio has no
 * filenames in its prose — a clip cites a plate by its position in the global
 * plate list, `<Subject N>` / `<Picture N>` — so the shots below cite
 * `<Subject 1>` where the scaffold's prose names `hero.png`, and `citeToTag`
 * is this port's equivalent of `tagifyPrompt`. The PROMPT TEXT therefore
 * differs from the golden graph's by construction; everything else in the
 * chain — node classes, links, per-clip frame accounting, and every plan
 * field but the prompt string — must match exactly.
 */
const GOLDEN_RUN_NAME = '__chain_probe_studio_chain_864x480_1-3'

function scaffoldShots(): ChainShot[] {
  return [1, 2, 3].map((n) => ({
    index: n,
    prompt: `subject_definitions:\n<Subject 1> is the character shown in <Subject 1>: a placeholder subject.\n\n[Shot 1] Something happens.`,
    frames: 362,
    steps: 6,
    seed: 1000 + n,
  }))
}

const scaffoldPlates: ChainPlate[] = [{ id: 'hero', filename: 'hero.png', subfolder: '' }]

/** Strip the per-shot `prompt` text out of a chain-plan node's `plan_json`
 * so two graphs authored from different prose can still be compared on
 * every OTHER field. */
function planWithoutPrompts(node: ComfyNode): ComfyNode {
  const parsed = JSON.parse(String(node.inputs.plan_json)) as { shots: Array<Record<string, unknown>> }
  return {
    ...node,
    inputs: {
      ...node.inputs,
      plan_json: JSON.stringify({ shots: parsed.shots.map((s) => ({ ...s, prompt: '<prompt elided for comparison>' })) }),
    },
  }
}

test('buildChainGraph matches a golden graph produced by h3-shots submit.mjs --longform chain --dry', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const golden = loadFixture('chain_golden.graph.json')

  const result = buildChainGraph({
    graph: workflow,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: GOLDEN_RUN_NAME, width: 864, height: 480, steps: 6, baseSeed: 1000 },
  })

  // Same node set.
  assert.deepStrictEqual(new Set(Object.keys(result.graph)), new Set(Object.keys(golden)))

  // Same node CLASS for every node.
  for (const id of Object.keys(golden)) {
    assert.equal(result.graph[id].class_type, golden[id].class_type, `node ${id} class_type`)
  }

  // Same everything else, node by node — except the chain-plan node, whose
  // plan_json carries prose this test authored differently on purpose (see
  // the module comment above).
  for (const id of Object.keys(golden)) {
    if (id === '80') continue
    assert.deepStrictEqual(result.graph[id].inputs, golden[id].inputs, `node ${id} (${golden[id].class_type}) inputs`)
  }
  assert.deepStrictEqual(planWithoutPrompts(result.graph['80']), planWithoutPrompts(golden['80']), 'plan node, prompts elided')

  // The prose transform actually ran: every compiled prompt cites the plate
  // by its @tag, and no raw <Subject N> citation survives.
  const compiledPlan = JSON.parse(String(result.graph['80'].inputs.plan_json)) as { shots: Array<{ prompt: string }> }
  for (const shot of compiledPlan.shots) {
    assert.ok(shot.prompt.includes('@hero'), 'compiled prompt cites @hero')
    assert.ok(!/<\s*Subject\s+\d+\s*>/i.test(shot.prompt), 'no raw <Subject N> survives tagging')
  }

  // Per-clip render/deliver frame counts — the overlap tax, paid explicitly.
  // Measured on the golden run: clip 1 pays nothing; clips 2/3 render 396f
  // and deliver 374f (delivered = rendered - 22, the context length).
  assert.deepStrictEqual(
    result.padded.map((p) => [p.authored, p.rendered, p.delivered]),
    [
      [362, 362, 362],
      [362, 396, 374],
      [362, 396, 374],
    ],
  )

  assert.equal(result.outputNode, '97')
  assert.deepStrictEqual(result.references, [{ id: 'hero', scenes: [1, 2, 3] }])
})

test('buildChainGraph stamps scene_range only when given one, and leaves it out on a fresh run', () => {
  const workflow = loadFixture('contexloop_workflow.json')

  const fresh = buildChainGraph({
    graph: workflow,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: 6 },
  })
  assert.equal(fresh.graph['82'].inputs.scene_range, '', 'untouched — the workflow file\'s own default')

  const resumed = buildChainGraph({
    graph: workflow,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: 6, sceneRange: '3' },
  })
  assert.equal(resumed.graph['82'].inputs.scene_range, '3')
})

test('buildChainGraph refuses steps below the accelerator LoRA floor', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  assert.throws(
    () =>
      buildChainGraph({
        graph: workflow,
        shots: scaffoldShots(),
        plates: scaffoldPlates,
        opts: { runName: 'probe', width: 864, height: 480, steps: chainMinSteps(workflow) - 1 },
      }),
    ChainError,
  )
})

/**
 * The floor is a property of the GRAPH's own attention/gate config, never a
 * single app-wide constant — this is what makes the two shipped chain
 * variants (`recipe.ts`'s SLA default and VSA gate) safe to switch between.
 * `contexloop_workflow.json` is the real SLA fixture (`H3SLAAttention`);
 * `contexloop_vsa_workflow.json` is the VSA-gated one (`Ref2VAVSAGatePatch`).
 */
test('chainMinSteps derives the floor from the graph itself, and moves when the bound variant switches', () => {
  const sla = loadFixture('contexloop_workflow.json')
  const vsa = loadFixture('contexloop_vsa_workflow.json')

  assert.equal(chainMinSteps(sla), CHAIN_MIN_STEPS_SLA)
  assert.equal(chainMinSteps(sla), 6, 'a 4-step production render came back corrupted on this config, 2026-08-23')
  assert.equal(chainMinSteps(vsa), CHAIN_MIN_STEPS_VSA)
  assert.equal(chainMinSteps(vsa), 4, 'validated clean at 4 steps once the VSA gate replaced SLA attention, 2026-09-07')
  assert.notEqual(chainMinSteps(sla), chainMinSteps(vsa), 'switching the bound recipe must move the floor')

  // Neither node class present (unknown/foreign graph, or null/no recipe
  // loaded yet) — falls back to the conservative SLA-tier floor, never the
  // lower VSA one.
  assert.equal(chainMinSteps(null), CHAIN_MIN_STEPS_DEFAULT)
  assert.equal(chainMinSteps({}), CHAIN_MIN_STEPS_DEFAULT)
})

test('an SLA recipe cannot be submitted at 4 steps — the exact corruption this floor exists to prevent', () => {
  const sla = loadFixture('contexloop_workflow.json')
  assert.throws(
    () =>
      buildChainGraph({
        graph: sla,
        shots: scaffoldShots(),
        plates: scaffoldPlates,
        opts: { runName: 'probe', width: 864, height: 480, steps: CHAIN_MIN_STEPS_VSA },
      }),
    ChainError,
  )
  // 6 (the SLA floor) succeeds on the same graph.
  const ok = buildChainGraph({
    graph: sla,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: CHAIN_MIN_STEPS_SLA },
  })
  assert.ok(ok.graph)
})

test('a VSA recipe builds cleanly at exactly its own floor of 4 steps', () => {
  const vsa = loadFixture('contexloop_vsa_workflow.json')
  const result = buildChainGraph({
    graph: vsa,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: CHAIN_MIN_STEPS_VSA },
  })
  assert.ok(result.graph, 'a 4-step build must not throw on the VSA-gated graph')
})

test('the model path runs the Ref2VAVSAGatePatch gate, not SLA attention (VSA variant)', () => {
  const workflow = loadFixture('contexloop_vsa_workflow.json')
  const result = buildChainGraph({
    graph: workflow,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: CHAIN_MIN_STEPS_VSA },
  })

  const nodes = Object.values(result.graph)
  const gate = nodes.find((n) => n.class_type === 'Ref2VAVSAGatePatch')
  assert.ok(gate, 'expected a Ref2VAVSAGatePatch node in the model path')
  assert.equal(gate!.inputs.gate_file, 'fasth3_vsa_gate.safetensors')
  assert.equal(gate!.inputs.sparsity, 0.75)

  assert.ok(!nodes.some((n) => n.class_type === 'H3SLAAttention'), 'SLA attention must be gone')
  assert.ok(!nodes.some((n) => n.class_type === 'ModelAttentionBackend'), 'the SLA attention backend selector must be gone')

  // The gate sits between the style stack and the sigma shift, same position
  // SLA attention used to occupy — never floating disconnected from the model path.
  const shift = nodes.find((n) => n.class_type === 'MiniMaxH3SigmaShift')!
  const shiftModelSrc = (shift.inputs.model as [string, number])[0]
  assert.equal(result.graph[shiftModelSrc]?.class_type, 'Ref2VAVSAGatePatch')
})

/**
 * An unresolvable citation used to REFUSE the render. It no longer does:
 * `<Subject N>` is H3's own label syntax, so a citation with no plate behind
 * it is still valid prose — it just means no reference image rides that scene
 * for that subject. Blocking refused whole prompts an authoring pass had
 * legitimately written with more subjects than plates bound.
 */
test('buildChainGraph leaves an unresolvable citation alone instead of refusing', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const built = buildChainGraph({
    graph: workflow,
    shots: [{ index: 1, prompt: '<Subject 1> looks at <Subject 2>.', frames: 362, seed: 1 }],
    plates: scaffoldPlates,
    opts: { runName: 'probe', width: 864, height: 480, steps: 6 },
  })
  const plan = JSON.parse(String(built.graph['80'].inputs.plan_json)) as { shots: Array<{ prompt: string }> }
  assert.ok(plan.shots[0].prompt.includes('@hero'), 'the resolvable citation still becomes a tag')
  assert.ok(plan.shots[0].prompt.includes('<Subject 2>'), 'the unresolvable one is left as written')
})

test('citeToTag turns <Subject N> / <Picture N> into the plate\'s @tag', () => {
  const plates: ChainPlate[] = [
    { id: 'aarav', filename: 'aarav.png', subfolder: '' },
    { id: 'meera', filename: 'meera.png', subfolder: '' },
  ]
  assert.equal(citeToTag('<Subject 1> looks at <Picture 2>.', plates), '@aarav looks at @meera.')
})

test('chainIssues reports a missing recipe and empty shots, but neither zero plates nor a dangling citation', () => {
  assert.deepStrictEqual(chainIssues({ graph: null, shots: [], plateCount: 0, steps: 6 }), [
    'No Contex-Loop recipe loaded — drop the chain ComfyUI workflow saved in API format.',
    'No clips in the chain — nothing to submit.',
  ])

  const graph = loadFixture('contexloop_workflow.json')
  const dangling = chainIssues({
    graph,
    shots: [{ index: 1, prompt: 'Only <Subject 3> is cited.' }],
    plateCount: 1,
    steps: 6,
  })
  assert.deepStrictEqual(dangling, [], 'a dangling citation is advice, not a blocker')
})

test('chainWarnings surfaces a dangling citation once per clip, naming what it costs', () => {
  const out = chainWarnings({
    shots: [{ index: 1, prompt: '<Subject 2> and <Subject 3> and <Subject 2> again.' }],
    plateCount: 1,
  })
  assert.equal(out.length, 1, 'one line per clip, not one per citation')
  assert.ok(out[0].includes('<Subject 2>') && out[0].includes('<Subject 3>'))
  assert.ok(out[0].includes('no reference image'), 'says what it actually costs')
})

/**
 * The studio renders on Singularity (founder A/B 2026-09-06, then a whole
 * 27-clip film), while the BUILDER default stays h3-shots' canonical fastvideo
 * UNET so the golden-graph comparison against `submit.mjs --dry` keeps meaning
 * something. Both halves are asserted here so neither can drift silently.
 */
test('opts.unetName stamps the graph, and the builder default stays the h3-shots canonical', () => {
  const shots = [{ index: 1, prompt: 'A courtyard at dawn, @p1 standing still.', frames: 124, seed: 1 }]
  const plates = [{ id: 'p1', filename: 'p1.png', subfolder: '' }]
  const base = { runName: 'r', width: 864, height: 480, steps: 6 }

  const unetOf = (graph: Record<string, { class_type?: string; inputs?: Record<string, unknown> }>) =>
    Object.values(graph).find((n) => n.class_type === 'UNETLoader')?.inputs?.unet_name

  const dflt = buildChainGraph({ graph: loadFixture('contexloop_workflow.json'), shots, plates, opts: base })
  assert.strictEqual(unetOf(dflt.graph), CANONICAL_UNET)

  const sing = buildChainGraph({
    graph: loadFixture('contexloop_workflow.json'), shots, plates,
    opts: { ...base, unetName: SINGULARITY_UNET },
  })
  assert.strictEqual(unetOf(sing.graph), SINGULARITY_UNET)
  assert.strictEqual(SINGULARITY_UNET, 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors')
})

test('chainIssues is clean on a plateless chain and on a one-plate chain alike', () => {
  const graph = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.' }]

  const none = chainIssues({ graph, shots, plateCount: 0, steps: 6 })
  assert.deepStrictEqual(none, [], `a plateless chain should be clean, got ${JSON.stringify(none)}`)

  const one = chainIssues({ graph, shots, plateCount: 1, steps: 6 })
  assert.deepStrictEqual(one, [], `a one-plate chain should be clean, got ${JSON.stringify(one)}`)
})

/**
 * Fix, not just a gate: a plateless chain used to build cleanly and then
 * 400 at the box with `prompt_outputs_failed_validation` on the Tagged
 * Ref2VA reference node's `conditioning` input (measured live 2026-09-07),
 * because its `references` socket is a required custom-typed input with
 * nothing wired to it. `buildChainGraph` now conditions a plateless scene on
 * the stock `MiniMaxH3ReferenceToVideo` node instead, whose reference inputs
 * are genuinely optional — proved here at the graph level, and with a real
 * submit against the box (see the founder-facing report).
 */
test('buildChainGraph conditions a plateless scene on the stock ref2va node, never the Tagged wrapper', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const result = buildChainGraph({
    graph: workflow,
    shots: [{ index: 1, prompt: 'A courtyard at dawn, empty and still.', frames: 124, seed: 1 }],
    plates: [],
    opts: { runName: 'plateless_probe', width: 864, height: 480, steps: 6 },
  })

  const classesUsed = new Set(Object.values(result.graph).map((n) => n.class_type))
  assert.ok(classesUsed.has('MiniMaxH3ReferenceToVideo'), 'stock ref2va node is present')
  assert.ok(!classesUsed.has('MiniMaxH3TaggedReferenceToVideo'), 'Tagged wrapper is not built at all')
  assert.ok(!classesUsed.has('MiniMaxH3TaggedPictureReference'), 'no picture-reference node either')
  assert.deepStrictEqual(result.references, [])

  // The stock node's own reference-image autogrow inputs are never set — an
  // Autogrow input left absent is what makes it genuinely optional, as
  // opposed to being connected to nothing.
  const stock = Object.values(result.graph).find((n) => n.class_type === 'MiniMaxH3ReferenceToVideo')
  assert.ok(stock)
  for (const key of Object.keys(stock!.inputs)) assert.ok(!key.startsWith('ref_images'), `unexpected ${key} on the stock node`)

  // Chain Context's conditioning/latent trace to the stock node, not h3lfSref.
  const ctxNode = Object.entries(result.graph).find(([, n]) => n.class_type === 'MiniMaxH3ChainContext')?.[1]
  assert.ok(ctxNode)
  const stockId = Object.entries(result.graph).find(([, n]) => n.class_type === 'MiniMaxH3ReferenceToVideo')?.[0]
  assert.deepStrictEqual(ctxNode!.inputs.conditioning, [stockId, 0])
  assert.deepStrictEqual(ctxNode!.inputs.latent, [stockId, 1])
})

// ── externalVideo — continue an existing video into scene 1 ──────────────────

test('buildChainGraph wires LoadVideo -> MiniMaxH3ChainExternalVideo -> LoopStart.external_context when externalVideo is given', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn, empty and still.', frames: 124, seed: 1 }]
  const built = buildChainGraph({
    graph: workflow,
    shots,
    plates: [],
    opts: { runName: 'r', width: 864, height: 480, steps: 6, externalVideo: { filename: 'dhee_src.mp4', prependOriginal: true } },
  })

  const loadVideo = Object.values(built.graph).find((n) => n.class_type === 'LoadVideo')
  assert.ok(loadVideo, 'LoadVideo node is present')
  assert.equal(loadVideo!.inputs.file, 'dhee_src.mp4')

  const extVideo = Object.entries(built.graph).find(([, n]) => n.class_type === 'MiniMaxH3ChainExternalVideo')
  assert.ok(extVideo, 'MiniMaxH3ChainExternalVideo node is present')
  const [extVideoId, extVideoNode] = extVideo!
  const loadVideoId = Object.entries(built.graph).find(([, n]) => n.class_type === 'LoadVideo')![0]
  assert.deepStrictEqual(extVideoNode.inputs.source_video, [loadVideoId, 0])
  assert.equal(extVideoNode.inputs.prepend_original, true)
  assert.ok(!('source_frames' in extVideoNode.inputs), 'source_video and source_frames are never both connected')

  const loopStart = Object.values(built.graph).find((n) => n.class_type === 'MiniMaxH3ChainLoopStart')
  assert.ok(loopStart)
  assert.deepStrictEqual(loopStart!.inputs.external_context, [extVideoId, 0])
})

test('buildChainGraph stamps prepend_original as passed, false included', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  const built = buildChainGraph({
    graph: workflow,
    shots,
    plates: [],
    opts: { runName: 'r', width: 864, height: 480, steps: 6, externalVideo: { filename: 'clip1.mp4', prependOriginal: false } },
  })
  const extVideoNode = Object.values(built.graph).find((n) => n.class_type === 'MiniMaxH3ChainExternalVideo')
  assert.equal(extVideoNode!.inputs.prepend_original, false)
})

test('buildChainGraph refuses externalVideo alongside a sceneRange that does not start at 1', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 2, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  assert.throws(
    () =>
      buildChainGraph({
        graph: workflow,
        shots,
        plates: [],
        opts: {
          runName: 'r', width: 864, height: 480, steps: 6, sceneRange: '2',
          externalVideo: { filename: 'clip1.mp4', prependOriginal: true },
        },
      }),
    ChainError,
  )
})

test('buildChainGraph allows externalVideo with a sceneRange that starts at 1 (e.g. "1:3")', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  const built = buildChainGraph({
    graph: workflow,
    shots,
    plates: [],
    opts: {
      runName: 'r', width: 864, height: 480, steps: 6, sceneRange: '1:3',
      externalVideo: { filename: 'clip1.mp4', prependOriginal: true },
    },
  })
  const loopStart = Object.values(built.graph).find((n) => n.class_type === 'MiniMaxH3ChainLoopStart')
  assert.deepStrictEqual(loopStart!.inputs.scene_range, '1:3')
})

test('buildChainGraph with no externalVideo leaves the golden graph byte-identical (no LoadVideo/ExternalVideo, no external_context)', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const golden = loadFixture('chain_golden.graph.json')
  const result = buildChainGraph({
    graph: workflow,
    shots: scaffoldShots(),
    plates: scaffoldPlates,
    opts: { runName: GOLDEN_RUN_NAME, width: 864, height: 480, steps: 6, baseSeed: 1000 },
  })
  const classesUsed = new Set(Object.values(result.graph).map((n) => n.class_type))
  assert.ok(!classesUsed.has('LoadVideo'))
  assert.ok(!classesUsed.has('MiniMaxH3ChainExternalVideo'))
  const loopStart = Object.values(result.graph).find((n) => n.class_type === 'MiniMaxH3ChainLoopStart')
  assert.ok(!('external_context' in loopStart!.inputs))
  // And the graph is still identical to the golden fixture, node for node.
  assert.deepStrictEqual(new Set(Object.keys(result.graph)), new Set(Object.keys(golden)))
})

// ── padForOverlap / snapUp — the overlap tax and the frame-grid check ─────────

test('snapUp never returns below 124, and only ever rounds UP onto the 17k+5 grid', () => {
  assert.equal(snapUp(0), 124)
  assert.equal(snapUp(1), 124)
  assert.equal(snapUp(124), 124) // already on-grid: identity
  assert.equal(snapUp(125), 141) // off-grid: rounds up, never down
  assert.equal(snapUp(384), 396) // measured case from the golden run above
  for (let f = 124; f < 2000; f += 7) {
    const n = snapUp(f)
    assert.ok(n >= f, `snapUp(${f}) = ${n} must not be smaller than its input`)
    assert.ok(n >= 124 && (n - 5) % 17 === 0, `snapUp(${f}) = ${n} is off H3's 17k+5 grid`)
  }
})

test('padForOverlap pays the overlap tax on every clip but the first', () => {
  const padded = padForOverlap([{ frames: 362 }, { frames: 362 }, { frames: 362 }], 22)
  assert.deepStrictEqual(padded[0], { authored: 362, rendered: 362, delivered: 362 })
  // snapUp(362 + 22) = snapUp(384) = 396; delivered = 396 - 22 = 374.
  assert.deepStrictEqual(padded[1], { authored: 362, rendered: 396, delivered: 374 })
  assert.deepStrictEqual(padded[2], { authored: 362, rendered: 396, delivered: 374 })
})

// ── pickAssembledVideo — the film, never a scene checkpoint ───────────────────

test('pickAssembledVideo picks the run-named file at the output root, not a segment checkpoint', () => {
  const outputs = [
    { filename: 'chain_probe_scene01.mp4', subfolder: 'h3_chains/chain_probe/segments', type: 'output' },
    { filename: 'chain_probe_scene02.mp4', subfolder: 'h3_chains/chain_probe/segments', type: 'output' },
    { filename: 'chain_probe.mp4', subfolder: '', type: 'output' },
  ]
  const picked = pickAssembledVideo(outputs, 'chain_probe')
  assert.deepStrictEqual(picked, { filename: 'chain_probe.mp4', subfolder: '', type: 'output' })
})

test('pickAssembledVideo finds nothing when only segment checkpoints came back', () => {
  const outputs = [{ filename: 'chain_probe_scene01.mp4', subfolder: 'h3_chains/chain_probe/segments', type: 'output' }]
  assert.equal(pickAssembledVideo(outputs, 'chain_probe'), undefined)
})

test('pickAssembledVideo ignores non-video files and a differently-named run', () => {
  const outputs = [
    { filename: 'chain_probe.json', subfolder: '', type: 'output' },
    { filename: 'other_run.mp4', subfolder: '', type: 'output' },
  ]
  assert.equal(pickAssembledVideo(outputs, 'chain_probe'), undefined)
})

test('padForOverlap on a single (head-only) clip never pays the tax', () => {
  // 192 is already on H3's 17k+5 grid, so snapUp is identity here — this
  // isolates "clip 1 pays no overlap tax" from the separate off-grid-input
  // rounding covered by the snapUp tests above.
  const padded = padForOverlap([{ frames: 192 }], 22)
  assert.deepStrictEqual(padded, [{ authored: 192, rendered: 192, delivered: 192 }])
})

// ── chainShotsForPlan — plan -> chain shots, whole-plan vs single-scene redo ──

const threeClipPlan: ChainPlanClip[] = [
  { index: 1, prompt: 'Clip one prose.', seconds: 5.2 },
  { index: 2, prompt: 'Clip two prose.', seconds: 5.2 },
  { index: 3, prompt: 'Clip three prose.', seconds: 5.2 },
]

test('chainShotsForPlan (whole-plan, no sceneIndex): every clip uses its current prompt/settings, in order', () => {
  let n = 0
  const shots = chainShotsForPlan(threeClipPlan, {
    steps: 6,
    nextSeed: () => ++n,
    priorOf: () => {
      throw new Error('a fresh whole-plan submit must never consult prior history')
    },
  })
  assert.deepStrictEqual(shots, [
    { index: 1, prompt: 'Clip one prose.', frames: 124, steps: 6, seed: 1 },
    { index: 2, prompt: 'Clip two prose.', frames: 124, steps: 6, seed: 2 },
    { index: 3, prompt: 'Clip three prose.', frames: 124, steps: 6, seed: 3 },
  ])
})

test('chainShotsForPlan (single-scene redo): every OTHER clip resends its recorded prior byte-identically', () => {
  const recorded = new Map([
    [1, { prompt: 'Clip one, as it actually rendered.', frames: 124, steps: 6, seed: 111 }],
    [3, { prompt: 'Clip three, as it actually rendered.', frames: 141, steps: 8, seed: 333 }],
  ])
  let n = 0
  const shots = chainShotsForPlan(threeClipPlan, {
    sceneIndex: 2,
    steps: 6,
    nextSeed: () => ++n,
    priorOf: (index) => recorded.get(index),
  })
  assert.deepStrictEqual(shots, [
    // Untouched: byte-identical to what was recorded, not re-derived from
    // the plan's current prompt/seconds/steps.
    { index: 1, prompt: 'Clip one, as it actually rendered.', frames: 124, steps: 6, seed: 111 },
    // The redo target alone uses the plan's current prompt/settings.
    { index: 2, prompt: 'Clip two prose.', frames: 124, steps: 6, seed: 1 },
    { index: 3, prompt: 'Clip three, as it actually rendered.', frames: 141, steps: 8, seed: 333 },
  ])
})

test('chainShotsForPlan: a clip with no recorded prior falls back to current settings even during a single-scene redo', () => {
  const shots = chainShotsForPlan(threeClipPlan, {
    sceneIndex: 2,
    steps: 6,
    nextSeed: () => 42,
    priorOf: () => undefined, // nothing has ever rendered for this plan
  })
  assert.deepStrictEqual(shots.map((s) => s.prompt), ['Clip one prose.', 'Clip two prose.', 'Clip three prose.'])
  assert.ok(shots.every((s) => s.seed === 42))
})

test('chainShotsForPlan output feeds buildChainGraph for both a whole-plan submit and a single-scene redo', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const plates: ChainPlate[] = [{ id: 'hero', filename: 'hero.png', subfolder: '' }]
  const plan: ChainPlanClip[] = [
    { index: 1, prompt: '<Subject 1> stands still.', seconds: 5.2 },
    { index: 2, prompt: '<Subject 1> turns to leave.', seconds: 5.2 },
  ]

  let n = 1000
  const whole = chainShotsForPlan(plan, { steps: 6, nextSeed: () => ++n, priorOf: () => undefined })
  const wholeBuilt = buildChainGraph({ graph: workflow, shots: whole, plates, opts: { runName: 'plan_probe', width: 864, height: 480, steps: 6 } })
  assert.equal(wholeBuilt.graph['82'].inputs.scene_range, '', 'a whole-plan submit samples every scene')

  const recorded = new Map(whole.map((s) => [s.index, { prompt: s.prompt, frames: s.frames, steps: s.steps, seed: s.seed }]))
  const redo = chainShotsForPlan(
    [{ index: 1, prompt: '<Subject 1> stands still, more still.', seconds: 5.2 }, plan[1]],
    { sceneIndex: 1, steps: 6, nextSeed: () => ++n, priorOf: (i) => recorded.get(i) },
  )
  // Scene 2 is byte-identical to the whole-plan submit's recorded shot.
  assert.deepStrictEqual(redo[1], whole[1])
  const redoBuilt = buildChainGraph({ graph: workflow, shots: redo, plates, opts: { runName: 'plan_probe', width: 864, height: 480, steps: 6, sceneRange: '1' } })
  assert.equal(redoBuilt.graph['82'].inputs.scene_range, '1', 'a single-scene redo samples only the redone scene')
})

// ── style-stack LoRA selection (LTX_lora_loader.stack_data) ──────────────────

test('serializeLoraStack matches the exact shape h3-shots\' own baked workflows use, byte-exact filenames included', () => {
  const stack: LoraStackEntry[] = [
    { lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true },
    { lora: 'HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors', strength: 0.7, on: false },
  ]
  const json = serializeLoraStack(stack)
  assert.deepStrictEqual(JSON.parse(json), [
    { on: true, lora: 'MysticXXX_MMH3-V4.safetensors', str: 0.5, v: 1, a: 1, t: 1 },
    { on: false, lora: 'HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors', str: 0.7, v: 1, a: 1, t: 1 },
  ])
  // The %20-laden filename must survive round-trip without being decoded or re-encoded.
  assert.ok(json.includes('HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors'))
})

test('readBakedLoraStack reads back what serializeLoraStack wrote, round-trip', () => {
  const stack: LoraStackEntry[] = [
    { lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true },
    { lora: 'Torpedo%20Tits%20T2V%20-%20MinimaxH3.safetensors', strength: 1, on: false },
  ]
  const graph: Record<string, ComfyNode> = {
    98: { class_type: 'LTX_lora_loader', inputs: { mode: 'minimax', stack_data: serializeLoraStack(stack), model: ['66', 0] } },
  }
  assert.deepStrictEqual(readBakedLoraStack(graph), stack)
})

test('readBakedLoraStack reads the shipped fixture\'s own default (MysticX @ 0.5, on)', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  assert.deepStrictEqual(readBakedLoraStack(workflow), [{ lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true }])
})

test('readBakedLoraStack never throws — no node, and malformed JSON, both read as empty', () => {
  assert.deepStrictEqual(readBakedLoraStack(null), [])
  assert.deepStrictEqual(readBakedLoraStack({}), [])
  assert.deepStrictEqual(
    readBakedLoraStack({ 98: { class_type: 'LTX_lora_loader', inputs: { stack_data: 'not json' } } }),
    [],
  )
})

test('localLoraStackOverride: absent/empty/malformed all read as empty — the public build gets nothing', () => {
  assert.deepStrictEqual(localLoraStackOverride(undefined), [])
  assert.deepStrictEqual(localLoraStackOverride(''), [])
  assert.deepStrictEqual(localLoraStackOverride('not json'), [])
})

test('localLoraStackOverride: parses VITE_LOCAL_LORA_STACK the same shape serializeLoraStack writes', () => {
  const stack: LoraStackEntry[] = [
    { lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true },
    {
      lora: 'Torpedo%20Tits%20T2V%20-%20MinimaxH3%20-%20torpedo%20tits%2Ca%2020%20year%20old%20woman%2Cwearing%20nothing%20shows%20off%20her%20medium%20sized%20torpedo%20tit%20breasts.safetensors',
      strength: 1,
      on: true,
    },
  ]
  assert.deepStrictEqual(localLoraStackOverride(serializeLoraStack(stack)), stack)
})

test('ACCELERATOR_LORA_RE catches the canonical turbo LoRA and the fl2v/lightx2v family, never a style LoRA', () => {
  assert.ok(ACCELERATOR_LORA_RE.test(CANONICAL_TURBO_LORA))
  assert.ok(ACCELERATOR_LORA_RE.test('minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors'))
  assert.ok(ACCELERATOR_LORA_RE.test('lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank16_bf16.safetensors'))
  assert.ok(!ACCELERATOR_LORA_RE.test('MysticXXX_MMH3-V4.safetensors'))
})

test('EXPLICIT_LORA_RE catches exactly the five gated LoRAs, never an ordinary style LoRA', () => {
  for (const name of [
    'HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors',
    'HMPenis%20-%20Penis-Cock%20-%20MinimaxH3.safetensors',
    'Torpedo%20Tits%20T2V%20-%20MinimaxH3.safetensors',
    'Vagina%20v0.2%20T2V-I2V%20-%20MinimaxH3.safetensors',
    'MysticXXX_MMH3-V4.safetensors',
  ]) {
    assert.ok(EXPLICIT_LORA_RE.test(name), `${name} should be gated`)
  }
  assert.ok(!EXPLICIT_LORA_RE.test('PlagueKind-tiddies-realismslider.safetensors'))
})

test('selectableStyleLoras excludes the accelerator family always, and the explicit five (incl. MysticX) unless opted in', () => {
  const all = [
    'MysticXXX_MMH3-V4.safetensors',
    CANONICAL_TURBO_LORA,
    'minimax_h3_fl2v_turbo_4step_v1.1_768p_comfyui_bf16.safetensors',
    'HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors',
    'PlagueKind-tiddies-realismslider.safetensors',
  ]
  assert.deepStrictEqual(selectableStyleLoras(all, { allowExplicit: false }), [
    'PlagueKind-tiddies-realismslider.safetensors',
  ])
  assert.deepStrictEqual(selectableStyleLoras(all, { allowExplicit: true }), [
    'MysticXXX_MMH3-V4.safetensors',
    'HMBreasts%20-%20Breasts-Areoles%20-%20MinimaxH3%20-%20HMBreasts.safetensors',
    'PlagueKind-tiddies-realismslider.safetensors',
  ])
})

test('buildChainGraph leaves stack_data untouched when opts.loraStack is not given — the no-op-until-edited contract', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  const built = buildChainGraph({ graph: workflow, shots, plates: [], opts: { runName: 'r', width: 864, height: 480, steps: 6 } })
  const stackNode = Object.entries(built.graph).find(([, n]) => n.class_type === 'LTX_lora_loader')?.[1]
  assert.equal(stackNode?.inputs.stack_data, '[{"on": true, "lora": "MysticXXX_MMH3-V4.safetensors", "str": 0.5, "v": 1, "a": 1, "t": 1}]')
})

test('buildChainGraph stamps opts.loraStack onto LTX_lora_loader.stack_data, replacing the workflow\'s own baked default', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  const stack: LoraStackEntry[] = [{ lora: 'PlagueKind-tiddies-realismslider.safetensors', strength: 0.8, on: true }]
  const built = buildChainGraph({ graph: workflow, shots, plates: [], opts: { runName: 'r', width: 864, height: 480, steps: 6, loraStack: stack } })
  const stackNode = Object.entries(built.graph).find(([, n]) => n.class_type === 'LTX_lora_loader')?.[1]
  assert.deepStrictEqual(readBakedLoraStack({ x: stackNode! }), stack)
})

test('buildChainGraph refuses an accelerator-family LoRA in the style stack, even if something upstream let it through', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  assert.throws(
    () =>
      buildChainGraph({
        graph: workflow, shots, plates: [],
        opts: { runName: 'r', width: 864, height: 480, steps: 6, loraStack: [{ lora: CANONICAL_TURBO_LORA, strength: 1, on: true }] },
      }),
    ChainError,
  )
})

test('buildChainGraph refuses a style-stack selection on a workflow with no LTX_lora_loader node', () => {
  const workflow = loadFixture('contexloop_workflow.json') as Record<string, ComfyNode>
  const stripped = Object.fromEntries(Object.entries(workflow).filter(([, n]) => n.class_type !== 'LTX_lora_loader'))
  const shots = [{ index: 1, prompt: 'A courtyard at dawn.', frames: 124, seed: 1 }]
  assert.throws(
    () =>
      buildChainGraph({
        graph: stripped, shots, plates: [],
        opts: { runName: 'r', width: 864, height: 480, steps: 6, loraStack: [{ lora: 'PlagueKind-tiddies-realismslider.safetensors', strength: 0.5, on: true }] },
      }),
    ChainError,
  )
})

test('loraStackKey treats "unset" as its own value, distinct from an explicit empty or identical stack', () => {
  const a: LoraStackEntry[] = [{ lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true }]
  const b: LoraStackEntry[] = [{ lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true }]
  assert.equal(loraStackKey(a), loraStackKey(b), 'two explicit stacks with identical content compare equal')
  assert.notEqual(loraStackKey(undefined), loraStackKey(a), 'unset never compares equal to an explicit stack, even a matching one')
  assert.notEqual(loraStackKey(undefined), loraStackKey([]), 'unset never compares equal to an explicit empty stack')
})

test('planNeedsPerSceneLoraSplit: false when every clip is unset, or every clip explicitly agrees; true the moment one differs', () => {
  const a: LoraStackEntry[] = [{ lora: 'MysticXXX_MMH3-V4.safetensors', strength: 0.5, on: true }]
  const b: LoraStackEntry[] = [{ lora: 'PlagueKind-tiddies-realismslider.safetensors', strength: 0.5, on: true }]

  assert.equal(planNeedsPerSceneLoraSplit([undefined, undefined, undefined]), false, 'nobody customized anything')
  assert.equal(planNeedsPerSceneLoraSplit([a, a, a]), false, 'every clip explicitly agrees')
  assert.equal(planNeedsPerSceneLoraSplit([a]), false, 'a single-clip plan never needs to split')
  assert.equal(planNeedsPerSceneLoraSplit([]), false)
  assert.equal(planNeedsPerSceneLoraSplit([a, b, a]), true, 'one clip differs')
  assert.equal(planNeedsPerSceneLoraSplit([undefined, a]), true, 'unset vs. customized still counts as differing')
})
