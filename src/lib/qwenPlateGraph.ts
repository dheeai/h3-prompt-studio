/**
 * Patch `public/workflows/qwen21_tti.json` (ported from
 * `~/.kshana/bundles/h3_chapter/workflows/qwen21_tti.json`, commit `baaee62`
 * — READ ONLY, another agent owns that repo) for one plate generation.
 *
 * Deliberately much simpler than `extender.ts`'s Master Extender graph
 * builder: one plate is one independent, one-shot submission (no chain, no
 * validated-clip cache, no 28-field signature guard to protect) — find the
 * two nodes that matter by `class_type` (never a hardcoded node id, since a
 * differently-exported copy of this graph could number them differently),
 * patch them, submit.
 *
 * Node identification (verified against the shipped graph's own node
 * titles and confirmed against a fresh read of the bundle's workflow file):
 *   - `TextEncodeQwenImage21` — the prompt node. `inputs.prompt` /
 *     `inputs.negative_prompt` are plain strings; `inputs.resolution` is
 *     the reference-image pixel budget (irrelevant for pure text-to-image,
 *     kept in sync anyway so an inspected graph never looks internally
 *     inconsistent).
 *   - `EmptyLatentImage` — the ONLY thing controlling output size in this
 *     graph. `inputs.width`/`inputs.height`/`inputs.batch_size`.
 *   - `KSampler` — `inputs.seed` (25 steps/cfg 1.0/euler/simple are the
 *     graph's own baked defaults, never touched here).
 *   - `SaveImage` — `inputs.filename_prefix`.
 */
import type { ComfyNode } from './types'

export class QwenPlateGraphError extends Error {}

const TEXT_ENCODE_CLASS = 'TextEncodeQwenImage21'
const EMPTY_LATENT_CLASS = 'EmptyLatentImage'
const KSAMPLER_CLASS = 'KSampler'
const SAVE_IMAGE_CLASS = 'SaveImage'

const byClass = (g: Record<string, ComfyNode>, cls: string): string | undefined =>
  Object.keys(g).find((k) => g[k]?.class_type === cls)

export interface QwenPlateBuildArgs {
  /** The shipped `qwen21_tti.json`, exactly. */
  graph: Record<string, ComfyNode>
  /** `platePrompting.ts`'s `parsePlatePromptRewrite` output — the rewritten
   * Qwen Image 2.1 prompt text, never the raw plate brief. */
  prompt: string
  width: number
  height: number
  seed?: number
  filenamePrefix?: string
}

export function buildQwenPlateGraph(args: QwenPlateBuildArgs): Record<string, ComfyNode> {
  const g: Record<string, ComfyNode> = JSON.parse(JSON.stringify(args.graph))

  const encodeId = byClass(g, TEXT_ENCODE_CLASS)
  if (!encodeId) throw new QwenPlateGraphError(`No ${TEXT_ENCODE_CLASS} node found — is this the qwen21_tti workflow?`)
  g[encodeId].inputs.prompt = args.prompt
  g[encodeId].inputs.negative_prompt = ''
  g[encodeId].inputs.resolution = Math.max(args.width, args.height)

  const latentId = byClass(g, EMPTY_LATENT_CLASS)
  if (latentId) {
    g[latentId].inputs.width = args.width
    g[latentId].inputs.height = args.height
  }

  const samplerId = byClass(g, KSAMPLER_CLASS)
  if (samplerId && args.seed !== undefined) g[samplerId].inputs.seed = args.seed

  const saveId = byClass(g, SAVE_IMAGE_CLASS)
  if (saveId && args.filenamePrefix) g[saveId].inputs.filename_prefix = args.filenamePrefix

  return g
}

/** The node ComfyUI's `/history` entry keys the saved image under — same
 * `class_type`-lookup discipline used throughout this file, since a plate
 * job's output-picking never needs `extender.ts`'s "prefer type: output
 * over a scrub preview" logic (a plate render has exactly one image, no
 * preview stream). */
export function findSaveImageNodeId(graph: Record<string, ComfyNode>): string | undefined {
  return byClass(graph, SAVE_IMAGE_CLASS)
}
