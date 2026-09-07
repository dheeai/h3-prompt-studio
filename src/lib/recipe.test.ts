import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FALLBACK_HEIGHT, FALLBACK_WIDTH, GEOMETRY_PRESETS, OOM_HEIGHT, OOM_WIDTH, SHIPPED_CHAIN_RECIPE_ID, makeRecipe, oomRisk, parseWorkflow, resolveChainRecipeAutoBind } from './recipe'
import type { ComfyNode, Recipe } from './types'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = join(HERE, '__fixtures__', 'contexloop_workflow.json')
const SHIPPED_PATH = join(HERE, '..', '..', 'public', 'workflows', 'minimax_h3_contexloop_api.json')

function shippedGraph() {
  return parseWorkflow(readFileSync(SHIPPED_PATH, 'utf8'))
}

// ── the shipped asset itself ──────────────────────────────────────────────

test('the shipped copy and the test fixture are byte-identical', () => {
  assert.equal(readFileSync(SHIPPED_PATH, 'utf8'), readFileSync(FIXTURE_PATH, 'utf8'))
})

test('the shipped asset parses and yields a recipe with the chain node classes bound', () => {
  const graph = shippedGraph()
  const recipe = makeRecipe('Contex-Loop (shipped)', graph, SHIPPED_CHAIN_RECIPE_ID)

  assert.equal(recipe.id, SHIPPED_CHAIN_RECIPE_ID)
  assert.equal(recipe.bindings.prompt?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.equal(recipe.bindings.length?.classType, 'MiniMaxH3ReferenceToVideo')
  assert.ok(recipe.bindings.output, 'expected a save node to be bound')
  assert.ok(recipe.refHost, 'expected a reference-image host to be bound')
  assert.ok(recipe.defaults.width > 0 && recipe.defaults.height > 0)
})

// ── makeRecipe's geometry fallback — the live hazard ───────────────────────

test('makeRecipe: the shipped workflow (a WIRED geometry, not a literal) falls back to the validated 1216x672, never the OOM tier', () => {
  const graph = shippedGraph()
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

function fixtureShipped(): Recipe {
  return makeRecipe('Contex-Loop (shipped)', shippedGraph(), SHIPPED_CHAIN_RECIPE_ID)
}

const fetchFixture = async () => fixtureShipped()
const fetchThrows = async (): Promise<Recipe | null> => {
  throw new Error('fetchShipped should not have been called')
}
const fetchFails = async (): Promise<Recipe | null> => null

test('resolveChainRecipeAutoBind: no-op once chainRecipeAutoBound is already set', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: true }, fetchThrows)
  assert.equal(result, null)
})

test('resolveChainRecipeAutoBind: an already-bound chain recipe is left alone (just marks the flag)', async () => {
  const own: Recipe = { ...fixtureShipped(), id: 'operators-own-recipe' }
  const recipes = [own]
  const result = await resolveChainRecipeAutoBind(
    recipes,
    { chainRecipeId: 'operators-own-recipe', chainRecipeAutoBound: false },
    fetchThrows,
  )
  assert.ok(result)
  assert.equal(result!.chainRecipeId, 'operators-own-recipe')
  assert.equal(result!.chainRecipeAutoBound, true)
  assert.equal(result!.added, null)
  assert.equal(result!.recipes, recipes) // same reference — untouched
})

test('resolveChainRecipeAutoBind: fresh profile fetches, adds, and binds the shipped recipe', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchFixture)
  assert.ok(result)
  assert.equal(result!.chainRecipeId, SHIPPED_CHAIN_RECIPE_ID)
  assert.equal(result!.chainRecipeAutoBound, true)
  assert.equal(result!.added?.id, SHIPPED_CHAIN_RECIPE_ID)
  assert.equal(result!.recipes.length, 1)
})

test('resolveChainRecipeAutoBind: does not duplicate on a repeat run — reuses the stored shipped recipe without fetching', async () => {
  const first = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchFixture)
  assert.ok(first)

  // Simulate the next boot: the shipped recipe is now in storage, but the
  // settings write from the first run (chainRecipeAutoBound: true) has NOT
  // yet round-tripped through idb for this test — this is exactly the case
  // that must still not add a second copy.
  const second = await resolveChainRecipeAutoBind(first!.recipes, { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchThrows)
  assert.ok(second)
  assert.equal(second!.added, null, 'must not fetch or add a duplicate once the shipped recipe is already stored')
  assert.equal(second!.recipes.length, 1)
  assert.equal(second!.chainRecipeId, SHIPPED_CHAIN_RECIPE_ID)
})

test('resolveChainRecipeAutoBind: a deliberate delete is never resurrected — chainRecipeAutoBound stays the only gate', async () => {
  // After a successful auto-bind, the operator deletes the shipped recipe.
  // chainRecipeId is now dangling (points at nothing), but the flag from the
  // first bind survived in settings — that flag alone must stop a rebind.
  const result = await resolveChainRecipeAutoBind(
    [],
    { chainRecipeId: SHIPPED_CHAIN_RECIPE_ID, chainRecipeAutoBound: true },
    fetchThrows,
  )
  assert.equal(result, null)
})

test('resolveChainRecipeAutoBind: a fetch/parse failure changes nothing, so the caller retries next reload', async () => {
  const result = await resolveChainRecipeAutoBind([], { chainRecipeId: undefined, chainRecipeAutoBound: false }, fetchFails)
  assert.equal(result, null)
})
