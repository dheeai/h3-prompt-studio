import type { Binding, BindingSlot, ComfyNode, Recipe } from './types'

/**
 * Reading a user's own ComfyUI workflow, and writing only the slots we own.
 *
 * The governing idea: the recipe stays THEIRS. We detect where the prompt, the
 * references, the geometry and the seed live, write those, and hand the rest of
 * the graph back byte-for-byte — loaders, LoRA stack, attention, sigma shift,
 * sampler, VAE. Everything they tuned in ComfyUI survives.
 *
 * Detection is by node CLASS TYPE, never by node number, so the turbo, 8-step,
 * SLA and hybrid variants of one graph all bind with no configuration.
 */

const H3 = 'MiniMaxH3ReferenceToVideo'

/** Class types that hold each slot, best candidate first. */
const CANDIDATES: Record<Exclude<BindingSlot, 'output'>, Array<[cls: string, field: string]>> = {
  prompt: [[H3, 'prompt'], ['CLIPTextEncode', 'text'], ['PrimitiveStringMultiline', 'value']],
  width: [[H3, 'width'], ['EmptyLatentImage', 'width']],
  height: [[H3, 'height'], ['EmptyLatentImage', 'height']],
  length: [[H3, 'length'], ['EmptyHunyuanLatentVideo', 'length']],
  seed: [['RandomNoise', 'noise_seed'], ['KSampler', 'seed'], ['KSamplerAdvanced', 'noise_seed']],
  steps: [['BasicScheduler', 'steps'], ['KSampler', 'steps'], ['KSamplerAdvanced', 'steps']],
}

const OUTPUT_CLASSES = ['SaveVideo', 'VHS_VideoCombine', 'SaveAnimatedWEBP', 'SaveWEBM', 'SaveImage']

export class WorkflowError extends Error {}

/** Accept only API-format graphs, and say plainly when handed the other one. */
export function parseWorkflow(text: string): Record<string, ComfyNode> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    throw new WorkflowError(`That file is not valid JSON — ${(e as Error).message}`)
  }
  if (!j || typeof j !== 'object') throw new WorkflowError('That file is not a workflow.')

  const o = j as Record<string, unknown>
  if (Array.isArray(o.nodes)) {
    throw new WorkflowError(
      'That is the UI workflow, which cannot be run directly. In ComfyUI use Workflow ▸ Export (API) and drop that file instead.',
    )
  }

  const entries = Object.entries(o).filter(
    ([, v]) => v && typeof v === 'object' && typeof (v as ComfyNode).class_type === 'string',
  )
  if (!entries.length) throw new WorkflowError('No nodes found. This does not look like an API-format workflow.')
  return Object.fromEntries(entries) as Record<string, ComfyNode>
}

const byClass = (g: Record<string, ComfyNode>, cls: string) =>
  Object.entries(g).filter(([, n]) => n.class_type === cls)

/**
 * Work out where everything lives.
 *
 * Where two nodes could plausibly hold a slot we do NOT guess — the slot lands
 * in `ambiguous` and the panel asks. Silently picking the wrong scheduler is
 * worse than one question.
 */
export function detectBindings(graph: Record<string, ComfyNode>): Pick<Recipe, 'bindings' | 'ambiguous' | 'refHost'> {
  const bindings: Recipe['bindings'] = {}
  const ambiguous: Recipe['ambiguous'] = {}

  for (const [slot, candidates] of Object.entries(CANDIDATES) as Array<
    [Exclude<BindingSlot, 'output'>, Array<[string, string]>]
  >) {
    const hits: Binding[] = []
    for (const [cls, field] of candidates) {
      for (const [node, n] of byClass(graph, cls)) {
        if (field in n.inputs) hits.push({ node, field, classType: cls })
      }
    }
    if (hits.length === 1) bindings[slot] = hits[0]
    else if (hits.length > 1) {
      // One H3 node beats anything else — it is the authority for its own fields.
      const h3 = hits.filter((h) => h.classType === H3)
      if (h3.length === 1) bindings[slot] = h3[0]
      else {
        bindings[slot] = hits[0]
        ambiguous[slot] = hits
      }
    }
  }

  const out: Binding[] = []
  for (const cls of OUTPUT_CLASSES) for (const [node] of byClass(graph, cls)) out.push({ node, field: '', classType: cls })
  if (out.length === 1) bindings.output = out[0]
  else if (out.length > 1) {
    bindings.output = out[0]
    ambiguous.output = out
  }

  // The reference group is an autogrow input expressed as dotted keys on the
  // node itself: ref_images.ref_image_0, …_1. Find whoever carries them.
  let refHost: string | undefined
  for (const [id, n] of Object.entries(graph)) {
    if (Object.keys(n.inputs).some((k) => k.startsWith('ref_images.') || /^ref_image_\d+$/.test(k))) refHost = id
  }
  if (!refHost) {
    const h3 = byClass(graph, H3)[0]
    if (h3) refHost = h3[0]
  }

  return { bindings, ambiguous, refHost }
}

/** H3 snaps length to a 17k+5 grid. Anything else is rounded DOWN onto it. */
export function snapFrames(frames: number): number {
  const k = Math.max(0, Math.round((frames - 5) / 17))
  return Math.max(5, k * 17 + 5)
}

export function framesForSeconds(seconds: number, fps = 24): number {
  return snapFrames(Math.round(seconds * fps))
}

export function secondsForFrames(frames: number, fps = 24): number {
  return frames / fps
}

export function makeRecipe(name: string, graph: Record<string, ComfyNode>): Recipe {
  const det = detectBindings(graph)
  const h3 = byClass(graph, H3)[0]?.[1]
  const width = Number(h3?.inputs.width) || 1344
  const height = Number(h3?.inputs.height) || 768
  const length = Number(h3?.inputs.length) || 124
  return {
    id: `r${Date.now().toString(36)}`,
    name,
    graph,
    ...det,
    defaults: { width, height, fps: 24, seconds: secondsForFrames(length) },
    addedAt: Date.now(),
  }
}

export interface RenderInputs {
  prompt: string
  /** Uploaded plates, in the order they must be numbered. */
  refs: Array<{ filename: string; subfolder: string }>
  width?: number
  height?: number
  frames?: number
  seed?: number
  steps?: number
}

const set = (g: Record<string, ComfyNode>, b: Binding | undefined, value: unknown) => {
  if (!b || !g[b.node]) return
  g[b.node].inputs[b.field] = value
}

/**
 * Write our slots into a copy of the recipe's graph.
 *
 * References are REBUILT rather than edited: whatever LoadImage nodes the graph
 * shipped are disconnected and exactly as many as we have plates are created,
 * numbered in plate order. Editing in place silently keeps a stale fourth
 * reference when a scene drops to three.
 */
export function applyRecipe(recipe: Recipe, input: RenderInputs): Record<string, ComfyNode> {
  const g: Record<string, ComfyNode> = JSON.parse(JSON.stringify(recipe.graph))
  const b = recipe.bindings

  set(g, b.prompt, input.prompt)
  if (input.width != null) set(g, b.width, input.width)
  if (input.height != null) set(g, b.height, input.height)
  if (input.frames != null) set(g, b.length, snapFrames(input.frames))
  if (input.seed != null) set(g, b.seed, input.seed)
  if (input.steps != null) set(g, b.steps, input.steps)

  if (recipe.refHost && g[recipe.refHost]) {
    const host = g[recipe.refHost]
    const stale = Object.keys(host.inputs).filter((k) => k.startsWith('ref_images.') || /^ref_image_\d+$/.test(k))
    const linked = new Set<string>()
    for (const k of stale) {
      const v = host.inputs[k]
      if (Array.isArray(v) && typeof v[0] === 'string') linked.add(v[0])
      delete host.inputs[k]
    }
    // Drop the LoadImage nodes that only existed to feed those slots.
    for (const id of linked) if (g[id]?.class_type === 'LoadImage') delete g[id]

    input.refs.forEach((ref, i) => {
      const id = `plate${i}`
      g[id] = {
        class_type: 'LoadImage',
        inputs: { image: ref.subfolder ? `${ref.subfolder}/${ref.filename}` : ref.filename, upload: 'image' },
      }
      host.inputs[`ref_images.ref_image_${i}`] = [id, 0]
    })
  }

  return g
}

/** What the panel shows, and what blocks a render. */
export function recipeIssues(recipe: Recipe | null): string[] {
  if (!recipe) return ['No recipe loaded — drop a ComfyUI workflow saved in API format.']
  const out: string[] = []
  if (!recipe.bindings.prompt) out.push('No prompt field found. Nothing would carry your prompt into the render.')
  if (!recipe.bindings.output) out.push('No save node found. The render would produce no file.')
  if (!recipe.refHost) out.push('No reference-image input found — plates cannot be attached to this graph.')
  return out
}
