import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FALLBACK_HEIGHT, FALLBACK_WIDTH, GEOMETRY_PRESETS, OOM_HEIGHT, OOM_WIDTH,
  SHIPPED_CHAIN_RECIPE_SLA_ID, SHIPPED_CHAIN_RECIPE_VSA_ID,
  makeRecipe, oomRisk, parseWorkflow, resolveChainRecipeAutoBind,
} from './recipe'
import type { ComfyNode, Recipe } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))
const SLA_FIXTURE_PATH = join(HERE, '__fixtures__', 'contexloop_workflow.json')
const VSA_FIXTURE_PATH = join(HERE, '__fixtures__', 'contexloop_vsa_workflow.json')
const SHIPPED_SLA_PATH = join(HERE, '..', '..', 'public', 'workflows', 'minimax_h3_contexloop_sla_api.json')
const SHIPPED_VSA_PATH = join(HERE, '..', '..', 'public', 'workflows', 'minimax_h3_contexloop_vsa_api.json')

function shippedSlaGraph() {
  return parseWorkflow(readFileSync(SHIPPED_SLA_PATH, 'utf8'))
}
function shippedVsaGraph() {
  return parseWorkflow(readFileSync(SHIPPED_VSA_PATH, 'utf8'))
}

// ── the shipped assets themselves ─────────────────────────────────────────

/**
 * The shipped SLA copy and its test fixture are the SAME underlying
 * Contex-Loop graph, but no longer byte-identical: the shipped copy is
 * stripped of its NSFW style-stack default before it goes on the public
 * GitHub Pages site (`public/` is downloadable by anyone), while the fixture
 * keeps MysticX baked in because it is a real `submit.mjs --dry` output from
 * h3-shots and the golden-graph comparison in chain.test.ts depends on that
 * realism.
 *
 * So this asserts the ONE deliberate difference and nothing else: every node
 * is identical except `LTX_lora_loader.stack_data`, which is `[]` on the
 * shipped copy and MysticX @ 0.5 on the fixture.
 */
test('the shipped SLA copy matches its test fixture except its NSFW style stack is stripped for public distribution', () => {
  const shipped = JSON.parse(readFileSync(SHIPPED_SLA_PATH, 'utf8')) as Record<string, ComfyNode>
  const fixture = JSON.parse(readFileSync(SLA_FIXTURE_PATH, 'utf8')) as Record<string, ComfyNode>

  assert.deepStrictEqual(Object.keys(shipped).sort(), Object.keys(fixture).sort())
  for (const id of Object.keys(fixture)) {
    if (id === '98') continue // the style-stack node — asserted separately below
    assert.deepStrictEqual(shipped[id], fixture[id], `node ${id} (${fixture[id].class_type}) should be identical`)
  }

  assert.equal(shipped['98'].inputs.stack_data, '[]', 'shipped stack must be empty — no NSFW LoRA ships by default')
  assert.equal(
    fixture['98'].inputs.stack_data,
    '[{"on": true, "lora": "MysticXXX_MMH3-V4.safetensors", "str": 0.5, "v": 1, "a": 1, "t": 1}]',
    'fixture keeps the real h3-shots submit.mjs --dry output so the golden-graph test stays meaningful',
  )

  assert.ok(Object.values(shipped).some((n) => n.class_type === 'H3SLAAttention'), 'expected the SLA attention node')
  assert.ok(!Object.values(shipped).some((n) => n.class_type === 'Ref2VAVSAGatePatch'), 'the VSA gate must not be on the SLA variant')
})

/**
 * The VSA gate variant has no equivalent h3-shots run to source a fixture
 * from — h3-shots has not adopted the gate (see chain.test.ts's module
 * comment on why its golden-graph test only covers SLA). Its fixture is
 * simply the shipped asset itself, already stripped (it never carried the
 * NSFW default to begin with), so this asserts byte-identity rather than a
 * one-node difference.
 */
test('the shipped VSA copy is byte-identical to its test fixture (nothing to strip — never carried the NSFW default)', () => {
  const shipped = JSON.parse(readFileSync(SHIPPED_VSA_PATH, 'utf8')) as Record<string, ComfyNode>
  const fixture = JSON.parse(readFileSync(VSA_FIXTURE_PATH, 'utf8')) as Record<string, ComfyNode>
  assert.deepStrictEqual(shipped, fixture)

  assert.ok(Object.values(shipped).some((n) => n.class_type === 'Ref2VAVSAGatePatch'), 'expected the VSA gate node')
  assert.ok(!Object.values(shipped).some((n) => n.class_type === 'H3SLAAttention'), 'SLA attention must not be on the VSA variant')
  const stack = Object.values(shipped).find((n) => n.class_type === 'LTX_lora_loader')
  assert.equal(stack?.inputs.stack_data, '[]', 'no NSFW LoRA ships by default on this variant either')
})

test('an empty shipped style stack is a working no-op, not a broken graph (both variants)', () => {
  for (const graph of [shippedSlaGraph(), shippedVsaGraph()]) {
    const stackNode = Object.values(graph).find((n) => n.class_type === 'LTX_lora_loader')!
    assert.equal(stackNode.inputs.stack_data, '[]')
    // parseWorkflow/makeRecipe still bind every required class on the emptied graph —
    // an empty stack does not make the graph unparseable or drop a required node.
    const recipe = makeRecipe('Contex-Loop (shipped)', graph, SHIPPED_CHAIN_RECIPE_SLA_ID)
    assert.ok(recipe.bindings.output, 'expected a save node to be bound even with an empty style stack')
  }
})

test('the shipped SLA asset parses and yields a recipe with the chain node classes bound', () => {
  const graph = shippedSlaGraph()
  const recipe = makeRecipe('Contex-Loop SLA (shipped)', graph, SHIPPED_CHAIN_RECIPE_SLA_ID)

  assert.equal(recipe.id, SHIPPED_CHAIN_RECIPE_SLA_ID)
  assert.equal(recipe.bindings.prompt?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.equal(recipe.bindings.length?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.ok(recipe.bindings.output, 'expected a save node to be bound')
  assert.ok(recipe.refHost, 'expected a reference-image host to be bound')
  assert.ok(recipe.defaults.width > 0 && recipe.defaults.height > 0)
})

test('the shipped VSA asset parses and yields a recipe with the chain node classes bound', () => {
  const graph = shippedVsaGraph()
  const recipe = makeRecipe('Contex-Loop VSA gate (shipped)', graph, SHIPPED_CHAIN_RECIPE_VSA_ID)

  assert.equal(recipe.id, SHIPPED_CHAIN_RECIPE_VSA_ID)
  assert.equal(recipe.bindings.prompt?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.equal(recipe.bindings.length?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.ok(recipe.bindings.output, 'expected a save node to be bound')
  assert.ok(recipe.refHost, 'expected a reference-image host to be bound')
  assert.ok(recipe.defaults.width > 0 && recipe.defaults.height > 0)
})

// ── makeRecipe's geometry fallback — the live hazard ───────────────────────

test('makeRecipe: the shipped workflow (a WIRED geometry, not a literal) falls back to the validated 1216x672, never the OOM tier', () => {
  const graph = shippedSlaGraph()
  const h3Node = Object.values(graph).find((n) => n.class_type === 'MiniMaxH3ReferenceToVideo')!
  // Confirm the premise: the shipped graph's width/height are LINKS
  // ([nodeId, outputIndex]), not literal numbers — this is exactly what made
  // `Number(h3.inputs.width)` come back NaN and fall through to the fallback.
  assert.ok(Array.isArray(h3Node.inputs.width), 'expected width to be a wired link on the shipped graph')
  assert.ok(Array.isArray(h3Node.inputs.height), 'expected height to be a wired link on the shipped graph')

  const recipe = makeRecipe('Contex-Loop (shipped)', graph)
  assert.equal(recipe.defaults.width, 1216)
  assert.equal(recipe.defaults.height, 672)
  assert.equal(recipe.defaults.width, FALLBACK_WIDTH)
  assert.equal(recipe.defaults.height, FALLBACK_HEIGHT)
  // The bug this fixes: the fallback used to be 1344x768 — OOM_WIDTH/OOM_HEIGHT
  // themselves — so every auto-bound recipe silently defaulted to the one
  // geometry measured to crash ComfyUI. Never again.
  assert.notEqual(recipe.defaults.width, OOM_WIDTH)
  assert.notEqual(recipe.defaults.height, OOM_HEIGHT)
})

test('makeRecipe: a literal width/height on the H3 node is read, not overridden by the fallback', () => {
  const graph: Record<string, ComfyNode> = {
    h3: { class_type: 'MiniMaxH3ReferenceToVideo', inputs: { width: 864, height: 480, length: 124 } },
    out: { class_type: 'SaveVideo', inputs: {} },
  }
  const recipe = makeRecipe('literal', graph)
  assert.equal(recipe.defaults.width, 864)
  assert.equal(recipe.defaults.height, 480)
})

test('oomRisk: the new fallback geometry (1216x672) is never flagged, at any length', () => {
  assert.equal(oomRisk(FALLBACK_WIDTH, FALLBACK_HEIGHT, 10_000), false)
})

test('oomRisk: the old fallback geometry (1344x768) is exactly the OOM tier and IS flagged past 362 frames', () => {
  assert.equal(oomRisk(1344, 768, 363), true)
  assert.equal(oomRisk(1344, 768, 362), false)
})

test('GEOMETRY_PRESETS: the validated 1216x672 tier is offered as a preset, distinct from the OOM tier', () => {
  const validated = GEOMETRY_PRESETS.find((p) => p.width === 1216 && p.height === 672)
  assert.ok(validated, 'expected a 1216x672 preset')
  assert.equal(oomRisk(validated!.width, validated!.height, 10_000), false)
})

// ── resolveChainRecipeAutoBind — the boot decision, no fetch/DOM involved ──

function fixtureShippedSla(): Recipe {
  return makeRecipe('Contex-Loop SLA (shipped)', shippedSlaGraph(), SHIPPED_CHAIN_RECIPE_SLA_ID)
}
function fixtureShippedVsa(): Recipe {
  return makeRecipe('Contex-Loop VSA gate (shipped)', shippedVsaGraph(), SHIPPED_CHAIN_RECIPE_VSA_ID)
}

const fetchBoth = async () => [fixtureShippedSla(), fixtureShippedVsa()]
const fetchThrows = async (): Promise<Recipe[]> => {
  throw new Error('fetchShipped should not have been called')
}
const fetchFails = async (): Promise<Recipe[]> => []

test('resolveChainRecipeAutoBind: no-op once chainRecipeAutoBound is already set', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: true }, fetchThrows)
  assert.equal(result, null)
})

test('resolveChainRecipeAutoBind: an already-bound chain recipe is left alone (just marks the flag)', async () => {
  const own: Recipe = { ...fixtureShippedSla(), id: 'operators-own-recipe' }
  const recipes = [own]
  const result = await resolveChainRecipeAutoBind(
    recipes,
    { chainRecipeId: 'operators-own-recipe', chainRecipeAutoBound: false },
    fetchThrows,
  )
  assert.ok(result)
  assert.equal(result!.chainRecipeId, 'operators-own-recipe')
  assert.equal(result!.chainRecipeAutoBound, true)
  assert.deepStrictEqual(result!.added, [])
  assert.equal(result!.recipes, recipes) // same reference — untouched
})

test('resolveChainRecipeAutoBind: fresh profile fetches and adds BOTH shipped variants, but binds SLA as the default', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchBoth)
  assert.ok(result)
  assert.equal(result!.chainRecipeId, SHIPPED_CHAIN_RECIPE_SLA_ID, 'SLA is the measured-known-good default')
  assert.equal(result!.chainRecipeAutoBound, true)
  assert.deepStrictEqual(result!.added.map((r) => r.id).sort(), [SHIPPED_CHAIN_RECIPE_SLA_ID, SHIPPED_CHAIN_RECIPE_VSA_ID].sort())
  assert.equal(result!.recipes.length, 2, 'both variants show up as selectable chips')
})

test('resolveChainRecipeAutoBind: does not duplicate on a repeat run — reuses the stored shipped recipes without fetching', async () => {
  const first = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchBoth)
  assert.ok(first)

  // Simulate the next boot: both shipped recipes are now in storage, but the
  // settings write from the first run (chainRecipeAutoBound: true) has NOT
  // yet round-tripped through idb for this test — this is exactly the case
  // that must still not add a duplicate.
  const second = await resolveChainRecipeAutoBind(first!.recipes, { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchThrows)
  assert.ok(second)
  assert.deepStrictEqual(second!.added, [], 'must not fetch or add a duplicate once both shipped recipes are already stored')
  assert.equal(second!.recipes.length, 2)
  assert.equal(second!.chainRecipeId, SHIPPED_CHAIN_RECIPE_SLA_ID)
})

test('resolveChainRecipeAutoBind: only the missing variant is fetched and added when one is already stored', async () => {
  const result = await resolveChainRecipeAutoBind(
    [fixtureShippedVsa()],
    { chainRecipeId: undefined, chainRecipeAutoBound: false },
    fetchBoth,
  )
  assert.ok(result)
  assert.deepStrictEqual(result!.added.map((r) => r.id), [SHIPPED_CHAIN_RECIPE_SLA_ID], 'only SLA was missing')
  assert.equal(result!.recipes.length, 2)
  assert.equal(result!.chainRecipeId, SHIPPED_CHAIN_RECIPE_SLA_ID)
})

test('resolveChainRecipeAutoBind: VSA alone (SLA unavailable) still binds — falls back to whichever variant fetched', async () => {
  const vsaOnly = async () => [fixtureShippedVsa()]
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, vsaOnly)
  assert.ok(result)
  assert.equal(result!.chainRecipeId, SHIPPED_CHAIN_RECIPE_VSA_ID)
  assert.equal(result!.recipes.length, 1)
})

test('resolveChainRecipeAutoBind: a deliberate delete is never resurrected — chainRecipeAutoBound stays the only gate', async () => {
  // After a successful auto-bind, the operator deletes both shipped recipes.
  // chainRecipeId is now dangling (points at nothing), but the flag from the
  // first bind survived in settings — that flag alone must stop a rebind.
  const result = await resolveChainRecipeAutoBind(
    [],
    { chainRecipeId: SHIPPED_CHAIN_RECIPE_SLA_ID, chainRecipeAutoBound: true },
    fetchThrows,
  )
  assert.equal(result, null)
})

test('resolveChainRecipeAutoBind: a fetch/parse failure on both variants changes nothing, so the caller retries next reload', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchFails)
  assert.equal(result, null)
})
