import type { ComfyNode } from './types'

/**
 * Submit a WHOLE FILM to ComfyUI as one MiniMax H3 **Master Extender** job —
 * the studio's second render path, alongside `chain.ts`'s Contex-Loop.
 *
 * The graph (`public/workflows/minimax_h3_master_extender_api.json`) is a
 * single node, `MiniMaxH3MasterExtender`, that takes the WHOLE film as one
 * `clips_json` string and keeps its OWN validated-clip disk cache on the box —
 * measured on the real box before this file was written: one 15s clip cold
 * 72.5s, a 4-clip 57.6s film 178.8s with two clips served from cache.
 * `MiniMaxH3MasterFinalDecode` decodes the ENTIRE chain on every run, so the
 * output of a job containing N clips is clips 1..N already joined.
 *
 * This is deliberately much simpler than `chain.ts`: the node does the
 * chaining itself (its own `context_length`/`identity_continuity`), so this
 * file needs NONE of `chain.ts`'s machinery — no overlap tax, no
 * `padForOverlap`/`snapUp` frame-grid math (`frames.ts`), no `scene_range`
 * resume, no per-scene checkpoint hashes, no `@tag` reference activation.
 * `clips_json.duration` is plain SECONDS (the node calls
 * `duration_to_h3_frames` itself); references are plain filenames in
 * `refs_json`, never a wired `LoadImage` graph node.
 *
 * ═══ GROUND TRUTH — read directly off the node's own source, 2026-09-16 ══════
 *
 * (`ComfyUI_MiniMax_H3_Master_Extender/master_node.py` on the 5090, via
 * `ssh h3box`, since this repo ships the graph but not the node's Python.)
 *
 * TRAP 1 — the disk cache is keyed by the ComfyUI NODE ID, not by anything
 * about the film: `owner = str(unique_id)`, `cache_owner = f"master_v2_{owner}"`.
 * The shipped graph has the node at id `"6"`. Two films submitted at the same
 * id would share (and truncate) one chain — so every film gets its own
 * `nodeId`, stable for its whole life, and every `["6", N]`-shaped link
 * anywhere in the graph must be repointed at the new id (`renumberExtenderNode`).
 *
 * TRAP 2 — a settings OR reference-picture change truncates the whole chain
 * to zero. The node hashes exactly these 28 fields (its own `settings` list,
 * `master_node.py` line ~396) and calls `_truncate_chain(..., 0)` — every
 * validated clip, gone, silently re-rendered — the moment the hash moves:
 *
 *   pass1_resolution, pass2_resolution, pass2_denoise, pdd_nfe,
 *   pdd_file, upscaler_model, context_length, audio_context_length,
 *   identity_continuity, refs_json,
 *   sla_enabled, sla_sparsity, sparse_method, sparse_tau,
 *   pass2_chunk_frames, pass2_chunk_overlap,
 *   accel_mode, turbo_lora, turbo_lora_strength, turbo_sampler, turbo_scheduler,
 *   pass2_lora, pass2_lora_strength, pass2_lora_mode, pass2_steps,
 *   semantic_bridge, semantic_bridge_alpha, semantic_bridge_match
 *
 * Note `refs_json` is IN that list — swapping or adding a plate re-renders the
 * whole film. NOT in the list, and so free to change mid-film: `run_mode`,
 * `clips_json` itself (a clip's `prompt`/`duration`/`seed`/`seed_mode`/`title`,
 * and the clip count), `smart_offload`, `attention_backend`, `async_decode`,
 * `master_ui`. `checkExtenderSignature` mirrors exactly this list and refuses a
 * build that would move it while any clip is validated — see
 * `h3-step-by-step/lib/graph.mjs`'s `guardSignature` for the same contract
 * applied from a script instead of a browser.
 *
 * `h3_preview_info` (a UI-type output on `MiniMaxH3MasterFinalDecode`, read
 * straight from `/history`) is what `parseExtenderPreviewInfo` reads —
 * confirmed live in `motion_context_disk.py`: `{"ui": {"h3_video": [...],
 * "h3_preview_info": [{"clip": N, "total_clips": M, "cache_mode": "...", ...}]}}`.
 */

const EXTENDER_CLASS = 'MiniMaxH3MasterExtender'

export class ExtenderError extends Error {}

const byClass = (g: Record<string, ComfyNode>, cls: string): string | undefined =>
  Object.keys(g).find((k) => g[k]?.class_type === cls)

/**
 * Renumber the Master Extender node to `newId`, repointing EVERY link
 * anywhere in the graph that named its old id — not just
 * `MiniMaxH3MasterFinalDecode.cache`, which is the one the shipped graph
 * happens to wire, but any input shaped `["<oldId>", slot]` on any node, so a
 * different graph wired around this node never leaves a dangling reference
 * behind (see `assertNoDanglingLinks`, called after every build).
 *
 * A no-op when the node is already at `newId` (so calling this twice on an
 * already-renumbered graph is safe). Throws when `newId` is already some
 * OTHER node's id — two films must never collide on one node id (TRAP 1).
 */
export function renumberExtenderNode(graph: Record<string, ComfyNode>, newId: string): Record<string, ComfyNode> {
  const oldId = byClass(graph, EXTENDER_CLASS)
  if (!oldId) throw new ExtenderError(`No ${EXTENDER_CLASS} node found — this does not look like the Master Extender workflow.`)
  if (oldId === newId) return graph
  if (graph[newId]) throw new ExtenderError(`Node id '${newId}' is already used by this workflow — pick a different film id.`)

  const out: Record<string, ComfyNode> = {}
  for (const [id, node] of Object.entries(graph)) {
    const inputs: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(node.inputs)) {
      inputs[k] = Array.isArray(v) && v[0] === oldId ? [newId, v[1]] : v
    }
    out[id === oldId ? newId : id] = { ...node, inputs }
  }
  return out
}

/** Pruning/renumbering is how a required input goes missing. Fail here, not
 * as a ComfyUI 400 that blames the wrong node — same contract as `chain.ts`'s
 * own `assertNoDanglingLinks`, kept as a separate copy here rather than a
 * shared import so this file stays independent of `chain.ts`'s machinery. */
function assertNoDanglingLinks(g: Record<string, ComfyNode>): Record<string, ComfyNode> {
  for (const [k, v] of Object.entries(g)) {
    for (const [ik, iv] of Object.entries(v.inputs)) {
      if (Array.isArray(iv) && typeof iv[0] === 'string' && !g[iv[0] as string]) {
        throw new ExtenderError(`${k} (${v.class_type}).${ik} points at deleted node ${iv[0]}`)
      }
    }
  }
  return g
}

/**
 * The node's own 28-field `master_signature` list, verbatim from
 * `master_node.py` (see the module comment). Order does not matter for
 * detecting change — `extenderSignature` hashes it as a JSON array either way
 * — but is kept identical to the source for anyone diffing the two later.
 */
export const EXTENDER_SIGNATURE_FIELDS = [
  'pass1_resolution', 'pass2_resolution', 'pass2_denoise', 'pdd_nfe',
  'pdd_file', 'upscaler_model', 'context_length', 'audio_context_length',
  'identity_continuity', 'refs_json',
  'sla_enabled', 'sla_sparsity', 'sparse_method', 'sparse_tau',
  'pass2_chunk_frames', 'pass2_chunk_overlap',
  'accel_mode', 'turbo_lora', 'turbo_lora_strength', 'turbo_sampler', 'turbo_scheduler',
  'pass2_lora', 'pass2_lora_strength', 'pass2_lora_mode', 'pass2_steps',
  'semantic_bridge', 'semantic_bridge_alpha', 'semantic_bridge_match',
] as const

/** Fields a film is free to change mid-chain (never in `EXTENDER_SIGNATURE_FIELDS`
 * — a clip's own `clips_json` entry, and the clip count). Documented here for
 * whoever reaches for this file wondering why it isn't a hashed field. */
export const EXTENDER_FREE_FIELDS = ['prompt', 'duration', 'seed', 'seed_mode', 'title', 'loras'] as const

/** `kwargs.get(field, default)` fallbacks the node applies to the four
 * optional widgets that landed after the shipped graph's `_default_clips()` —
 * a graph missing one of these (an older export) must hash the SAME default
 * the node itself would apply, or every such graph would look "changed"
 * against itself. */
const EXTENDER_SIGNATURE_DEFAULTS: Record<string, unknown> = {
  pass2_lora: 'none',
  pass2_lora_strength: 1.0,
  pass2_lora_mode: 'stack on engine LoRA',
  pass2_steps: 0,
  semantic_bridge: 'none',
  semantic_bridge_alpha: 0.12,
  semantic_bridge_match: 'per_token',
}

const fieldValue = (inputs: Record<string, unknown>, field: string): unknown =>
  inputs[field] ?? EXTENDER_SIGNATURE_DEFAULTS[field] ?? null

/**
 * A stable, cheap hash over exactly the node's own signature fields — NOT
 * byte-compatible with the node's python `sha256(json.dumps(settings,
 * sort_keys=True))` (replicating that buys nothing; a list's own order is
 * unaffected by `sort_keys` anyway), and does not need to be: it only has to
 * detect CHANGE, which a stable JSON-then-hash does exactly as well as sha256
 * for this purpose. (cyrb53-style two-lane multiply-hash, plain JS, no crypto
 * dependency — this runs in the browser on every keystroke of a render-blocking
 * preview, so it stays synchronous.)
 */
export function extenderSignature(masterInputs: Record<string, unknown>): string {
  const fields = EXTENDER_SIGNATURE_FIELDS.map((f) => fieldValue(masterInputs, f))
  const text = JSON.stringify(fields)
  let h1 = 0xdeadbeef ^ text.length
  let h2 = 0x41c6ce57 ^ text.length
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** Which frozen fields moved, for an error the operator can act on —
 * `refs_json` is reported by name only (its own JSON text is not useful to
 * read in an error banner), everything else states old -> new. */
export function extenderSignatureDiff(current: Record<string, unknown>, prior: Record<string, unknown> | undefined): string[] {
  if (!prior) return []
  const out: string[] = []
  for (const f of EXTENDER_SIGNATURE_FIELDS) {
    const c = fieldValue(current, f)
    const p = fieldValue(prior, f)
    if (JSON.stringify(c) !== JSON.stringify(p)) {
      out.push(f === 'refs_json' ? 'refs_json (the reference pictures) changed' : `${f}: ${JSON.stringify(p)} -> ${JSON.stringify(c)}`)
    }
  }
  return out
}

/**
 * Guard the chain against TRAP 2: throws `ExtenderError` naming what moved
 * and how many validated clips it would destroy, UNLESS `acceptReset` is
 * explicitly passed — the same refusal shape as `h3-step-by-step/submit.mjs`'s
 * `guardSignature`, applied here in the build path itself rather than a CLI
 * wrapper around it, so nothing that calls `buildExtenderGraph` can bypass it.
 *
 * Returns the CURRENT signature always; returns a non-null `refusalAccepted`
 * message only when `acceptReset` was needed and used (an informational
 * receipt for the operator — "you just discarded N validated clips" — never
 * itself a failure).
 */
function checkExtenderSignature(
  current: Record<string, unknown>,
  prior: Record<string, unknown> | undefined,
  validatedCount: number,
  acceptReset: boolean | undefined,
): { signature: string; refusalAccepted: string | null } {
  const signature = extenderSignature(current)
  if (!prior || validatedCount <= 0) return { signature, refusalAccepted: null }
  if (extenderSignature(prior) === signature) return { signature, refusalAccepted: null }

  const diff = extenderSignatureDiff(current, prior)
  const message =
    `render settings changed since clip ${validatedCount} was validated.\n` +
    diff.map((l) => `  changed: ${l}`).join('\n') +
    `\nSubmitting would truncate the chain and re-render ${validatedCount} validated clip(s).`

  if (!acceptReset) throw new ExtenderError(message)
  return { signature, refusalAccepted: message }
}

export type ExtenderSeedMode = 'fixed' | 'randomize' | 'increment' | 'decrement'

/** One reference plate for the 9 `refs_json` slots — position IS the numbering
 * a prompt cites as `<Picture N>`, the same convention `chain.ts`'s
 * `<Subject N>`/`<Picture N>` citation uses, just without the `@tag` rewrite:
 * H3 reads `<Picture N>` directly, no prose transform needed. */
export interface ExtenderPlate {
  filename: string
  subfolder?: string
}

/** H3's own reference-image cap — the same constant `recipe.ts` exports as
 * `REF_CAPS.image`, repeated here (rather than imported) so this file has no
 * dependency on `recipe.ts`'s Binding/CANDIDATES machinery, which does not
 * apply to this node at all (see the module comment). */
export const EXTENDER_REF_SLOTS = 9

/** Build the `refs_json` string: 9 slots, in plate order, `null` past the end
 * — never more than `EXTENDER_REF_SLOTS`, and never fewer than that many
 * entries (the node's own `load_reference_images` requires an array of AT
 * MOST nine, and pads its own reads by index, so a short array is fine, but a
 * fixed nine keeps the slot numbering visually stable in the UI). */
export function buildExtenderRefsJson(plates: ExtenderPlate[]): string {
  const images: Array<string | null> = plates
    .slice(0, EXTENDER_REF_SLOTS)
    .map((p) => (p.subfolder ? `${p.subfolder}/${p.filename}` : p.filename))
  while (images.length < EXTENDER_REF_SLOTS) images.push(null)
  return JSON.stringify({ images })
}

/** One clip going into `clips_json` — the pieces the studio actually has an
 * opinion about. `validated` mirrors the Studio's existing append-only
 * semantics (`ScenesStrip.tsx`'s replace-discards-everything-after) rather
 * than inventing a second notion of "accepted" — see the module comment. */
export interface ExtenderClipInput {
  title?: string
  prompt: string
  /** Seconds — sent AS SECONDS, never converted to frames here (the node calls
   * `duration_to_h3_frames` itself; see the module comment on why this file
   * carries none of `frames.ts`'s grid math). */
  seconds: number
  seed: number
  seedMode?: ExtenderSeedMode
  validated: boolean
  loras?: unknown[]
}

/** Build the `clips_json` string — `id` is the 0-based position
 * `master_node.py` itself uses (`for i, clip_cfg in enumerate(clips)`), so it
 * is always derived from array order, never carried in from the caller. */
export function buildExtenderClipsJson(clips: ExtenderClipInput[]): string {
  return JSON.stringify(
    clips.map((c, i) => ({
      id: i,
      title: c.title?.trim() || `Clip ${i + 1}`,
      prompt: c.prompt,
      duration: c.seconds,
      beyond: false,
      seed: c.seed,
      seed_mode: c.seedMode ?? 'fixed',
      validated: c.validated,
      loras: c.loras ?? [],
    })),
  )
}

/** Clip count / total seconds / how many will actually be sampled versus
 * served from cache — the cost disclosure the brief asks be shown before
 * anything is spent, computed off exactly the same `validated` flags the
 * build will send, never a second estimate that can drift from it. */
export interface ExtenderCostEstimate {
  clipCount: number
  totalSeconds: number
  toSample: number
  fromCache: number
}

export function extenderCostEstimate(clips: Array<{ seconds: number; validated: boolean }>): ExtenderCostEstimate {
  return {
    clipCount: clips.length,
    totalSeconds: clips.reduce((sum, c) => sum + c.seconds, 0),
    toSample: clips.filter((c) => !c.validated).length,
    fromCache: clips.filter((c) => c.validated).length,
  }
}

export interface ExtenderBuildArgs {
  /** The Master Extender workflow, exactly as shipped. */
  graph: Record<string, ComfyNode>
  /** This film's own, stable-for-life node id — see TRAP 1. */
  nodeId: string
  clips: ExtenderClipInput[]
  plates: ExtenderPlate[]
  runMode: 'clip_by_clip' | 'full_batch'
  /** Operator-chosen render settings (e.g. `pass2_resolution`), merged onto
   * the master node's own inputs before `refs_json`/`clips_json`/`run_mode`
   * are written — unset leaves the shipped graph's own baked defaults alone. */
  overrides?: Record<string, unknown>
  /** What was actually recorded as this film's frozen settings the last time
   * a submit of it succeeded — `undefined` for a film's first-ever submit,
   * which can never trip the guard (nothing validated to lose yet). */
  priorMasterInputs?: Record<string, unknown>
  /** How many clips are validated right now — purely for the refusal message;
   * the guard never fires at all when this is 0. */
  validatedCount: number
  /** Explicit operator override: proceed even though the guard would
   * otherwise refuse, discarding the validated clips named in the message. */
  acceptReset?: boolean
}

export interface ExtenderBuildResult {
  graph: Record<string, ComfyNode>
  nodeId: string
  clipsJson: string
  refsJson: string
  signature: string
  /** Non-null only when `acceptReset` was needed AND used — see
   * `checkExtenderSignature`'s module comment. */
  refusalAccepted: string | null
}

/**
 * Build one submittable Master Extender graph for a whole film.
 *
 * Throws `ExtenderError` on: no clips, no `MiniMaxH3MasterExtender` node, a
 * node-id collision (TRAP 1), a dangling link left after renumbering, or a
 * settings/refs change that would truncate validated clips without
 * `acceptReset` (TRAP 2) — never submits a graph it cannot account for, same
 * contract as `chain.ts`'s `buildChainGraph`.
 */
export function buildExtenderGraph(args: ExtenderBuildArgs): ExtenderBuildResult {
  if (!args.clips.length) throw new ExtenderError('No clips in this film — nothing to submit.')

  const source: Record<string, ComfyNode> = JSON.parse(JSON.stringify(args.graph))
  const g = renumberExtenderNode(source, args.nodeId)
  const master = g[args.nodeId]
  if (!master) throw new ExtenderError(`No ${EXTENDER_CLASS} node found after renumbering — this does not look like the Master Extender workflow.`)

  for (const [k, v] of Object.entries(args.overrides ?? {})) master.inputs[k] = v

  const refsJson = buildExtenderRefsJson(args.plates)
  const clipsJson = buildExtenderClipsJson(args.clips)
  master.inputs.refs_json = refsJson
  master.inputs.clips_json = clipsJson
  master.inputs.run_mode = args.runMode

  const { signature, refusalAccepted } = checkExtenderSignature(master.inputs, args.priorMasterInputs, args.validatedCount, args.acceptReset)

  assertNoDanglingLinks(g)
  return { graph: g, nodeId: args.nodeId, clipsJson, refsJson, signature, refusalAccepted }
}

/** One `MiniMaxH3MasterFinalDecode` UI output — read straight off
 * `/history/<id>`'s `outputs[nodeId].h3_preview_info[0]`, confirmed live
 * against `motion_context_disk.py` (see the module comment). Both run_mode
 * shapes share `clip`/`total_clips`/`cache_mode`; the rest is best-effort. */
export interface ExtenderPreviewInfo {
  clip: number
  totalClips: number
  cacheMode: string
  mode?: string
  interrupted?: boolean
}

/**
 * Pull the node's own progress receipt out of a `/history` entry's `outputs`
 * — never a spinner with no information, per the brief. Never throws: an
 * unrecognised shape (a foreign graph, an older node version) just reads as
 * "no preview info", the same tolerant contract `parseExtenderPreviewInfo`'s
 * caller (`comfy.ts`'s `pollExtender`) already applies to everything else it
 * reads off a history entry.
 */
export function parseExtenderPreviewInfo(outputs: Record<string, unknown> | undefined): ExtenderPreviewInfo | null {
  if (!outputs) return null
  for (const out of Object.values(outputs)) {
    const rec = out as Record<string, unknown> | undefined
    const list = rec?.h3_preview_info
    if (!Array.isArray(list) || !list.length) continue
    const info = list[list.length - 1] as Record<string, unknown>
    if (typeof info?.clip !== 'number' || typeof info?.total_clips !== 'number') continue
    return {
      clip: info.clip,
      totalClips: info.total_clips,
      cacheMode: typeof info.cache_mode === 'string' ? info.cache_mode : '',
      mode: typeof info.mode === 'string' ? info.mode : undefined,
      interrupted: typeof info.interrupted === 'boolean' ? info.interrupted : undefined,
    }
  }
  return null
}

/** One file `/history` reported as an output — same shape `chain.ts`'s
 * `ChainOutputCandidate` uses, repeated here (rather than imported) for the
 * same independence reason as `assertNoDanglingLinks`. */
export interface ExtenderOutputCandidate {
  filename: string
  subfolder: string
  type: string
}

/**
 * Pick the SAVED film out of a Master Extender job's outputs, never the
 * `h3_video` scrub preview `MiniMaxH3MasterFinalDecode` also emits.
 *
 * Both are legitimate video files at plausible paths, so — same hazard
 * `chain.ts`'s `pickAssembledVideo` exists for on the Contex-Loop path — this
 * cannot just take "whichever file came back". The preview is published with
 * ComfyUI's `type: "temp"` (`_comfy_media_item`, `master_node.py`); the real
 * save (`SaveVideo`, node 9 in the shipped graph) is `type: "output"`. Prefer
 * `output`; fall back to the last video-looking file when nothing is typed
 * that way, so an unusual graph still returns something rather than nothing.
 */
export function pickExtenderVideo(outputs: ExtenderOutputCandidate[]): ExtenderOutputCandidate | undefined {
  const videos = outputs.filter((o) => /\.(mp4|webm|mov|mkv)$/i.test(o.filename))
  return videos.find((o) => o.type === 'output') ?? videos[videos.length - 1]
}
