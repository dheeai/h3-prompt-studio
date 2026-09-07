import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChainGraph, chainIssues, chainShotsForPlan, citeToTag, pickAssembledVideo, snapUp, ChainError, CHAIN_MIN_STEPS, CANONICAL_UNET, SINGULARITY_UNET } from './chain'
import { padForOverlap } from './frames'
import type { ChainPlate, ChainPlanClip, ChainShot } from './chain'
import type { ComfyNode } from './types'

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
        opts: { runName: 'probe', width: 864, height: 480, steps: CHAIN_MIN_STEPS - 1 },
      }),
    ChainError,
  )
})

test('buildChainGraph refuses a citation past the end of the plate list', () => {
  const workflow = loadFixture('contexloop_workflow.json')
  assert.throws(
    () =>
      buildChainGraph({
        graph: workflow,
        shots: [{ index: 1, prompt: 'Only <Subject 2> is cited.', frames: 362, seed: 1 }],
        plates: scaffoldPlates,
        opts: { runName: 'probe', width: 864, height: 480, steps: 6 },
      }),
    ChainError,
  )
})

test('citeToTag turns <Subject N> / <Picture N> into the plate\'s @tag', () => {
  const plates: ChainPlate[] = [
    { id: 'aarav', filename: 'aarav.png', subfolder: '' },
    { id: 'meera', filename: 'meera.png', subfolder: '' },
  ]
  assert.equal(citeToTag('<Subject 1> looks at <Picture 2>.', plates), '@aarav looks at @meera.')
})

test('chainIssues reports a missing recipe and empty shots, but not zero plates', () => {
  assert.deepStrictEqual(chainIssues({ graph: null, shots: [], plateCount: 0, steps: 6 }), [
    'No Contex-Loop recipe loaded — drop the chain ComfyUI workflow saved in API format.',
    'No clips in the chain — nothing to submit.',
  ])

  const workflow = loadFixture('contexloop_workflow.json')
  const issues = chainIssues({
    graph: workflow,
    shots: [{ index: 1, prompt: '<Subject 3> is not bound.' }],
    plateCount: 1,
    steps: 6,
  })
  assert.ok(issues.some((i) => i.includes('<Subject 3>')))
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
