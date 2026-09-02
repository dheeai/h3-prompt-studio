import { REF_CAPS, framesForSeconds } from './recipe'
import type { ComfyNode } from './types'

/**
 * Submit a whole clip plan to ComfyUI as ONE MiniMax H3 "Long Media multiclip"
 * job, mirroring `buildMulticlipGraph` in h3-shots' longform.mjs.
 *
 * Long Media has SIX workflow_modes. `ref2va_full`, `hybrid_auto`, `loop` and
 * `segmented_continuation` are SINGLE-PROMPT modes — one prompt for the whole
 * duration. Feeding several clips' merged prose to one of those was measured
 * (h3-shots, 2026-08-19) to come back with correct picture, every action
 * hallucinated, and NO DIALOGUE AT ALL: nothing tells a single-prompt segmenter
 * which sentence belongs to which segment. Only `multiclip` takes a prompt per
 * clip, so a clip-based deliverable always uses `multiclip` — never merge prose
 * to fit another mode.
 *
 * Subject numbering is a no-op here, unlike h3-shots: plates in the studio are
 * one session-global list already, and every clip's prompt cites `<Subject N>`
 * against that same list, so there is nothing to renumber per shot. What DOES
 * still need checking is a prompt that cites a subject past the end of that
 * list — `multiclipIssues` gates that instead of silently rendering the wrong
 * (or no) reference.
 */

const SETUP_CLASS = 'MiniMaxH3LatentLabLongMediaSetup'
const SAMPLER_CLASS = 'MiniMaxH3LatentLabLongMediaSampler'
const DECODE_CLASS = 'MiniMaxH3LatentLabLongMediaDecode'
const SCHEDULER_CLASS = 'BasicScheduler'
const SAVE_CLASS = 'SaveVideo'

/** Below this the accelerator LoRA samples above its distilled step count — a
 * 4-step production render came back looking corrupted (founder, 2026-08-23).
 * No env-var escape hatch: this is a browser app, not a script with a flag. */
const MIN_STEPS = 6

export class MulticlipError extends Error {}

const byClass = (g: Record<string, ComfyNode>, cls: string): string[] =>
  Object.entries(g).filter(([, n]) => n.class_type === cls).map(([id]) => id)

/** H3 snaps continuation clips up onto its 17k+5 grid, never down — a clip is
 * never shorter than the prose it was authored for. The excess lands as at
 * most 16 frames of tail. */
export function snapUp(frames: number): number {
  let n = Math.max(124, frames)
  while ((n - 5) % 17 !== 0) n += 1
  return n
}

export interface PaddedClip {
  /** What the operator asked for. */
  authored: number
  /** What gets SAMPLED — bumped by the overlap tax and re-snapped to the grid. */
  rendered: number
  /** What survives the trim — this is what the film actually runs. */
  delivered: number
}

/**
 * The overlap tax, paid explicitly.
 *
 * With head anchors, every clip after the first REPEATS the previous clip's
 * last `overlap` frames at its head and the trim removes them — so it
 * DELIVERS `overlap` fewer frames than it RENDERS. Left unpaid, this is a real
 * loss: h3-shots measured 4 shots authored at 1176f/49.000s land at
 * 1110f/46.250s when submitted at their authored lengths unpadded — short by
 * exactly 66f, 3 boundaries x 22. `padForOverlap` asks for `authored+overlap`
 * on every clip but the first, so the trim has something to remove without
 * eating into the prose the clip was written for.
 */
export function padForOverlap(clips: Array<{ frames: number }>, overlap: number): PaddedClip[] {
  return clips.map((c, i) => {
    const authored = c.frames
    // The FIRST clip is snapped too, which h3-shots does not need to do: there
    // the frame count comes from a project file already authored onto the grid,
    // whereas here it is derived from a plan's seconds and carries no floor.
    // `snapFrames` rounds onto 17k+5 but bottoms out at 5, so a short plan clip
    // could ask clip 1 for 73 frames while every clip after it got at least
    // 124 — snapUp is identity on an on-grid count of 124 or more, so this
    // matches h3-shots wherever h3-shots applies and only bites the short case.
    const rendered = i === 0 ? snapUp(authored) : snapUp(authored + overlap)
    const delivered = i === 0 ? rendered : rendered - overlap
    return { authored, rendered, delivered }
  })
}

export interface MulticlipClip {
  prompt: string
  seconds: number
  seed: number
}

interface LongMediaNodes {
  setup?: string
  sampler?: string
  decode?: string
  scheduler?: string
  output?: string
  /** SaveVideo nodes found, when none or more than one traces to the decode node. */
  saveAmbiguous: number
}

/**
 * Find the Long Media branch by node CLASS, never by node number, so every
 * variant of the graph binds without configuration — same governing idea as
 * recipe.ts's own detection.
 *
 * The SaveVideo is the one worth refusing to guess on: a Long Media graph can
 * ship more than one (a preview branch, say), and picking the wrong one is a
 * silent wrong-output bug. It is identified by tracing its `video` input back
 * to a node whose `images` input is the decode node, and left unresolved
 * rather than guessed when that trace does not land on exactly one node.
 */
function findLongMediaNodes(graph: Record<string, ComfyNode>): LongMediaNodes {
  const setup = byClass(graph, SETUP_CLASS)[0]
  const sampler = byClass(graph, SAMPLER_CLASS)[0]
  const decode = byClass(graph, DECODE_CLASS)[0]
  const scheduler = byClass(graph, SCHEDULER_CLASS)[0]

  let output: string | undefined
  let saveAmbiguous = 0
  if (decode) {
    const matches = byClass(graph, SAVE_CLASS).filter((id) => {
      const video = graph[id].inputs.video
      if (!Array.isArray(video) || typeof video[0] !== 'string') return false
      const fed = graph[video[0] as string]
      const images = fed?.inputs.images
      return Array.isArray(images) && images[0] === decode
    })
    if (matches.length === 1) output = matches[0]
    else saveAmbiguous = matches.length
  }

  return { setup, sampler, decode, scheduler, output, saveAmbiguous }
}

/** Read `overlap_frames` off the setup node, defaulting to 22 when absent — the
 * same default h3-shots uses when the graph doesn't carry the field at all. */
export function overlapFramesOf(graph: Record<string, ComfyNode> | null): number {
  if (!graph) return 22
  const id = byClass(graph, SETUP_CLASS)[0]
  const v = id ? graph[id].inputs.overlap_frames : undefined
  return typeof v === 'number' ? v : 22
}

/** Read the Long Media graph's own step count, for when no override is set. */
export function schedulerStepsOf(graph: Record<string, ComfyNode> | null): number | undefined {
  if (!graph) return undefined
  const id = byClass(graph, SCHEDULER_CLASS)[0]
  const v = id ? graph[id].inputs.steps : undefined
  return typeof v === 'number' ? v : undefined
}

/** `<Subject N>` or `<Picture N>` — the same labels recipe prompts use elsewhere. */
const CITATION = /<\s*(Subject|Picture)\s+(\d+)\s*>/gi

export interface MulticlipIssuesInput {
  /** The Long Media recipe's graph, or null when none is chosen yet. */
  graph: Record<string, ComfyNode> | null
  /** The clips as they will be submitted, one per plan clip, in order. */
  clips: Array<{ index: number; prompt: string }>
  plateCount: number
  steps: number
}

/** What the panel shows, and what blocks a multiclip submit — same style as
 * recipe.ts's `recipeIssues`. */
export function multiclipIssues(input: MulticlipIssuesInput): string[] {
  const { graph, clips, plateCount, steps } = input
  const out: string[] = []

  if (!graph) {
    out.push('No Long Media recipe loaded — drop the multiclip ComfyUI workflow saved in API format.')
  } else {
    const nodes = findLongMediaNodes(graph)
    if (!nodes.setup) out.push(`No ${SETUP_CLASS} node found — this does not look like the Long Media workflow.`)
    if (!nodes.sampler) out.push(`No ${SAMPLER_CLASS} node found.`)
    if (!nodes.decode) out.push(`No ${DECODE_CLASS} node found.`)
    if (!nodes.scheduler) out.push('No BasicScheduler node found — nothing would carry the step count.')
    if (nodes.decode && !nodes.output) {
      out.push(
        nodes.saveAmbiguous > 1
          ? `${nodes.saveAmbiguous} SaveVideo nodes trace back to the decode node — cannot tell which is the Long Media output.`
          : 'No SaveVideo found on the Long Media branch — its video input must trace back to the decode node.',
      )
    }
  }

  if (!clips.length) out.push('No clips in the plan — nothing to submit.')
  for (const c of clips) if (!c.prompt.trim()) out.push(`Clip ${c.index} has no prompt yet.`)

  // Zero plates is fine — a text-only film. H3's own cap is what actually blocks.
  if (plateCount > REF_CAPS.image) out.push(`${plateCount} plates exceeds H3's ${REF_CAPS.image}-reference cap.`)

  if (steps < MIN_STEPS) {
    out.push(
      `${steps} steps is below the floor of ${MIN_STEPS} — the accelerator LoRA samples above its distilled step count; under-stepped renders come back looking corrupted.`,
    )
  }

  // Plates are one session-global list and every clip already cites <Subject N>
  // against that same list, so there is no per-shot renumbering to do here (see
  // the module comment). The one real gate is a citation past the end of it.
  for (const c of clips) {
    for (const m of c.prompt.matchAll(CITATION)) {
      const n = Number(m[2])
      if (n > plateCount) out.push(`Clip ${c.index} cites <${m[1]} ${n}> but only ${plateCount} plate(s) are bound.`)
    }
  }

  return out
}

/**
 * Non-blocking notes about the graph itself.
 *
 * The studio's contract with a dropped workflow is to pass it through WHOLE and
 * write only the fields it owns — it does not prune to the branch it cares
 * about the way h3-shots does. That is the right default (a user's graph is
 * theirs), but it has a consequence worth stating: any OTHER output branch in
 * the file will also execute, costing GPU time and returning extra videos that
 * are not the film. Said out loud here rather than discovered in the outputs.
 */
export function multiclipWarnings(graph: Record<string, ComfyNode> | null): string[] {
  if (!graph) return []
  const nodes = findLongMediaNodes(graph)
  if (!nodes.output) return []
  const others = byClass(graph, SAVE_CLASS).filter((id) => id !== nodes.output)
  if (!others.length) return []
  return [
    `The workflow has ${others.length} other SaveVideo node${others.length === 1 ? '' : 's'}. The graph is submitted whole, so ${
      others.length === 1 ? 'that branch renders' : 'those branches render'
    } too — extra time, and extra videos coming back that are not the film.`,
  ]
}

export interface BuildMulticlipArgs {
  graph: Record<string, ComfyNode>
  clips: MulticlipClip[]
  plates: Array<{ filename: string; subfolder: string }>
  width: number
  height: number
  steps: number
  seed: number
  filenamePrefix: string
}

export interface BuildMulticlipResult {
  graph: Record<string, ComfyNode>
  padded: PaddedClip[]
  multiclipJson: string
  /** Delivered seconds, summed — what the film actually runs. */
  totalSeconds: number
  overlap: number
  outputNode: string
}

/**
 * Write a whole clip plan into a copy of the Long Media graph as one
 * `multiclip` job.
 *
 * Re-runs `multiclipIssues` itself and throws on anything it would have
 * reported, so this cannot be called past a gate the caller forgot to check.
 */
export function buildMulticlipGraph(args: BuildMulticlipArgs): BuildMulticlipResult {
  const { graph: source, clips, plates, width, height, steps, seed, filenamePrefix } = args

  const issues = multiclipIssues({
    graph: source,
    clips: clips.map((c, i) => ({ index: i + 1, prompt: c.prompt })),
    plateCount: plates.length,
    steps,
  })
  if (issues.length) throw new MulticlipError(issues.join(' '))

  const g: Record<string, ComfyNode> = JSON.parse(JSON.stringify(source))
  const nodes = findLongMediaNodes(g)
  // multiclipIssues already refused a graph missing any of these, so every
  // one of them is present here.
  const setup = g[nodes.setup as string]
  const sampler = g[nodes.sampler as string]
  const scheduler = g[nodes.scheduler as string]
  const output = nodes.output as string

  const overlap = overlapFramesOf(g)
  const padded = padForOverlap(
    clips.map((c) => ({ frames: framesForSeconds(c.seconds, 24) })),
    overlap,
  )

  const entries = clips.map((c, i) => ({
    prompt: c.prompt,
    duration: +(padded[i].rendered / 24).toFixed(3),
    seed: c.seed,
  }))
  const multiclipJson = JSON.stringify(entries, null, 2)
  const manualDuration = +(padded.reduce((sum, p) => sum + p.rendered, 0) / 24).toFixed(3)
  const totalSeconds = +(padded.reduce((sum, p) => sum + p.delivered, 0) / 24).toFixed(3)

  Object.assign(setup.inputs, {
    workflow_mode: 'multiclip', // the only mode that takes a prompt per clip — see the module comment
    multiclip_json: multiclipJson,
    // In multiclip a blank clip prompt inherits this field, so it must not be
    // left holding whatever the workflow shipped.
    prompt: clips[0].prompt,
    width,
    height,
    manual_duration: manualDuration,
  })

  // References are GLOBAL on this path, unlike the per-clip refs elsewhere:
  // every clip sees every plate and pays for it on every sampling step. So the
  // group is rebuilt rather than edited in place — whatever the graph shipped
  // is cleared, and exactly the plates given are wired, in plate order.
  for (let i = 1; i <= REF_CAPS.image; i += 1) delete setup.inputs[`image_${i}`]
  plates.forEach((p, i) => {
    const id = `mcref${i}`
    g[id] = {
      class_type: 'LoadImage',
      inputs: { image: p.subfolder ? `${p.subfolder}/${p.filename}` : p.filename, upload: 'image' },
    }
    setup.inputs[`image_${i + 1}`] = [id, 0]
  })

  // `refine_steps` is an INT (default 2) but the shipped graph can carry the
  // UI-only string "auto", which the ComfyUI API validator rejects outright.
  // Inert when refine is disabled, but it still has to parse.
  if (typeof sampler.inputs.refine_steps === 'string') sampler.inputs.refine_steps = 2
  sampler.inputs.seed = seed
  scheduler.inputs.steps = steps
  g[output].inputs.filename_prefix = filenamePrefix

  return { graph: g, padded, multiclipJson, totalSeconds, overlap, outputNode: output }
}
