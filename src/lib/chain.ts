import { REF_CAPS, framesForSeconds } from './recipe'
import { padForOverlap, snapUp } from './frames'
import type { PaddedClip } from './frames'
import type { ComfyNode } from './types'

/**
 * Submit a WHOLE RANGE of clips to ComfyUI as ONE MiniMax H3 Contex-Loop "chain"
 * job, porting `buildChainGraph` from h3-shots' `longform.mjs` (measured 2026-09-01,
 * `submit.mjs --longform chain`).
 *
 * Chain is the studio's ONLY multi-clip render path (Long Media multiclip was
 * removed — "everything should be chainable through context loop," founder
 * 2026-09-07). What makes it worth having: it writes per-scene checkpoints
 * under ComfyUI's `output/h3_chains/<run_name>/`, so a later call can resume
 * from clip N's checkpoint and sample ONLY clip N+1 via `scene_range` — the
 * studio's "Continue" turn, and a plan's single-scene redo, both pay for one
 * clip's render, not the whole plan's.
 *
 * ═══ THE SETTINGS THIS FILE DOES NOT LET YOU CHOOSE ═══════════════════════════════
 *
 * `CHAIN_CONTEXT_LENGTH` (22), `CHAIN_AUDIO_CONTEXT_LENGTH` (0),
 * `CHAIN_VIDEO_BLEND_FRAMES` (0) and `CHAIN_CONTINUATION_MODE` ('guide') are the
 * validated audio-safe recipe measured on a 27-clip film (2026-09-06) and are NOT
 * exposed as build options. `guide` matters specifically: the `masked_av` family
 * VAE-encodes the previous tail under a denoise mask, which is the same class of
 * mechanism that, in a different pack, monkeypatched H3 for the whole ComfyUI
 * process and broke every later render's audio until a restart. `guide` does not do
 * that, and `context_length: 22` is tuned for `guide` specifically (39 is only for
 * `masked_av`, to keep the audio/video clocks meeting). Widening this file to accept
 * a different continuation mode needs the same care longform.mjs takes over it, not
 * a config knob.
 *
 * ═══ WHY THIS PORT DIFFERS FROM h3-shots ON REFERENCE ADDRESSING ══════════════════
 *
 * h3-shots' shot prose names a plate by its FILENAME ("...shown in aarav.png..."),
 * and `tagifyPrompt` there swaps the filename for `@<id>`. The studio has no
 * filenames in its prose — every clip cites a plate by its position in the ONE
 * session-global plate list, as `<Subject N>` / `<Picture N>`. So this file's
 * `citeToTag` reads that citation instead of a filename match; everything downstream
 * (the per-scene @tag activation, the Tagged Ref2VA reference chain, the 9-reference
 * cap per scene) is otherwise the same mechanism h3-shots uses.
 */

// ── node classes, resolved by TYPE — never by node number, so a turbo / 8-step /
//    SLA variant of the graph all bind with no configuration (same governing idea
//    as recipe.ts). ─────────────────────────────────────────────────────────────
const PLAN_CLASS = 'MiniMaxH3ChainPlan'
const CURRENT_CLASS = 'MiniMaxH3ChainCurrent'
const CONTEXT_CLASS = 'MiniMaxH3ChainContext'
const TRIM_CLASS = 'MiniMaxH3LoopTrim'
const ASSEMBLE_CLASS = 'MiniMaxH3ChainAssemble'
const LOOP_START_CLASS = 'MiniMaxH3ChainLoopStart'
const DEMO_I2V_CLASS = 'MiniMaxH3ImageToVideo'
const SIGMA_SHIFT_CLASS = 'MiniMaxH3SigmaShift'
const CLIP_LOADER_CLASS = 'CLIPLoader'
const VAE_LOADER_CLASS = 'VAELoader'
const SCHEDULER_CLASS = 'BasicScheduler'
const SAMPLER_ADV_CLASS = 'SamplerCustomAdvanced'
const SAMPLER_SELECT_CLASS = 'KSamplerSelect'
const LORA_BYPASS_CLASS = 'LoraLoaderBypassModelOnly'
const LORA_MODEL_ONLY_CLASS = 'LoraLoaderModelOnly'
const UNET_LOADER_CLASS = 'UNETLoader'
const TAGGED_PICTURE_CLASS = 'MiniMaxH3TaggedPictureReference'
const TAGGED_R2V_CLASS = 'MiniMaxH3TaggedReferenceToVideo'
/** The stock (non-Tagged) MiniMax H3 ref2va conditioning node — a ComfyUI
 * built-in (`comfy_extras/nodes_minimax_h3.py`), not part of the Contex-Loop
 * pack. Used only when a chain has no plate to cite — see the module comment
 * beside its wiring below. */
const STOCK_R2V_CLASS = 'MiniMaxH3ReferenceToVideo'

/** Contex-Loop's context_length is an ENUM; anything else snaps DOWN silently. */
export const CONTEXT_CHOICES = [1, 5, 22, 39, 56, 73] as const

/** The validated audio-safe recipe (founder 2026-09-01/2026-09-06) — see the
 * module comment. Not build options: a chain that silently drifted off these
 * would risk the monkeypatch-broken-audio failure mode documented above. */
export const CHAIN_CONTEXT_LENGTH = 22
export const CHAIN_AUDIO_CONTEXT_LENGTH = 0
export const CHAIN_VIDEO_BLEND_FRAMES = 0
export const CHAIN_CONTINUATION_MODE = 'guide'
export const CHAIN_ANCHOR_MODE = 'head'
export const CHAIN_ENCODE_MODE = 'video'
export const CHAIN_REF_IMAGE_SIZE = 'max'
export const CHAIN_REFERENCE_POLICY = 'strict'
export const CHAIN_SCHEDULER = 'simple'
export const CHAIN_SAMPLER = 'euler'
export const CHAIN_SHIFT_VIDEO = 12
export const CHAIN_SHIFT_AUDIO = 3
export const CHAIN_SEGMENT_CRF = 18
export const CHAIN_DEFAULT_DURATION_SECONDS = 15.0

/** Canonical acceleration LoRA (founder 2026-09-01) — stamped onto every chain
 * graph so a stale workflow file cannot silently load a different turbo LoRA. */
export const CANONICAL_TURBO_LORA = 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors'

/** Canonical diffusion model (founder 2026-09-01) — same stamping contract.
 *
 * This is h3-shots' canonical UNET and stays the BUILDER's default, because the
 * golden-graph test compares this module's output against a real
 * `submit.mjs --longform chain --dry`, which stamps exactly this file. Changing
 * the constant would make that comparison assert nothing. To render on a
 * different model, pass `opts.unetName` — see `SINGULARITY_UNET`. */
export const CANONICAL_UNET = 'minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors'

/**
 * The studio's rendering default: MiniMax H3 Singularity, a pruned ref2va
 * checkpoint.
 *
 * Chosen by the founder on 2026-09-06 after an A/B against the canonical
 * fastvideo UNET, and then used to render a whole 27-clip film (6:57 at
 * 1216x672, 6 steps). It is paired with `CANONICAL_TURBO_LORA` — the ref2v
 * turbo v0.1 accelerator — which is what that film shipped on, so switching
 * only the UNET here reproduces the validated configuration exactly.
 *
 * Note the pairing is deliberate and measured, not incidental: the ref2v LoRA
 * is distilled for ref2v, and this is a ref2va checkpoint. The fl2v-distilled
 * continuation LoRA that h3-shots' runbook specified for scenes 2+ was dropped
 * for that film precisely because it put an FL2V-distilled LoRA on a REF2VA
 * model. Do not reintroduce an fl2v LoRA alongside this UNET.
 */
export const SINGULARITY_UNET = 'Minimax-h3_Singularity_ref2va_Pruned_v1.3_int8.safetensors'

/** Below this the accelerator LoRA samples above its distilled step count — a
 * 4-step production render came back looking corrupted (founder, 2026-08-23).
 * No override: this is a browser app, not a script with an env-var escape hatch. */
export const CHAIN_MIN_STEPS = 6

export class ChainError extends Error {}

const allOfClass = (g: Record<string, ComfyNode>, cls: string): string[] =>
  Object.keys(g).filter((k) => g[k]?.class_type === cls)
const byClass = (g: Record<string, ComfyNode>, cls: string): string | undefined => allOfClass(g, cls)[0]

/** Keep only the nodes the output node actually reaches. */
function pruneTo(g: Record<string, ComfyNode>, outId: string): Record<string, ComfyNode> {
  const live = new Set<string>()
  const stack = [outId]
  while (stack.length) {
    const k = stack.pop() as string
    if (live.has(k) || !g[k]) continue
    live.add(k)
    for (const iv of Object.values(g[k].inputs)) {
      if (Array.isArray(iv) && typeof iv[0] === 'string') stack.push(iv[0])
    }
  }
  for (const k of Object.keys(g)) if (!live.has(k)) delete g[k]
  return g
}

/** Pruning is how a required input goes missing. Fail here, not as a ComfyUI 400
 * that blames the wrong node. */
function assertNoDanglingLinks(g: Record<string, ComfyNode>): Record<string, ComfyNode> {
  for (const [k, v] of Object.entries(g)) {
    for (const [ik, iv] of Object.entries(v.inputs)) {
      if (Array.isArray(iv) && typeof iv[0] === 'string' && !g[iv[0] as string]) {
        throw new ChainError(`${k} (${v.class_type}).${ik} points at deleted node ${iv[0]}`)
      }
    }
  }
  return g
}

/**
 * Stamp the turbo LoRA onto the graph's distillation loader — targets
 * `LoraLoaderBypassModelOnly` by class (unambiguous on the chain graph), or,
 * when absent, the one `LoraLoaderModelOnly` whose CURRENT name contains
 * "turbo" (case-insensitive), same contract as h3-shots' `applyLoraOverride`.
 * Returns the node id patched, or null on a graph that has neither.
 */
function applyLoraOverride(g: Record<string, ComfyNode>, name: string, strength: number | undefined): string | null {
  const k =
    byClass(g, LORA_BYPASS_CLASS) ??
    allOfClass(g, LORA_MODEL_ONLY_CLASS).find((id) => /turbo/i.test(String(g[id].inputs?.lora_name ?? '')))
  if (!k) return null
  g[k].inputs.lora_name = name
  if (strength !== undefined) g[k].inputs.strength_model = strength
  return k
}

/** Stamp the canonical diffusion model onto the graph's plain UNETLoader. A
 * no-op when the graph has none. */
function applyUnetOverride(g: Record<string, ComfyNode>, name: string): void {
  const k = byClass(g, UNET_LOADER_CLASS)
  if (!k) return
  g[k].inputs.unet_name = name
}

/** `<Subject N>` or `<Picture N>` — the same labels recipe prompts use elsewhere. */
const CITATION = /<\s*(Subject|Picture)\s+(\d+)\s*>/gi

/** One reference plate, keyed by its position in the studio's ONE session-global
 * plate list — that position IS the `<Subject N>` / `<Picture N>` numbering. */
export interface ChainPlate {
  id: string
  filename: string
  subfolder: string
}

/**
 * CHAIN prose transform: `<Subject N>` / `<Picture N>` -> the plate's `@tag`.
 *
 * The Tagged Ref2VA conditioning backend activates a reference IFF its `@tag`
 * literally occurs in the scene's resolved prompt — this is the per-scene
 * activation mechanism, not a numeric `scenes` range. So the citation must
 * become the literal tag text for that plate to ride this scene at all.
 */
export function citeToTag(text: string, plates: ChainPlate[]): string {
  return text.replace(CITATION, (_whole, kind: string, nStr: string) => {
    const n = Number(nStr)
    const p = plates[n - 1]
    if (!p) throw new ChainError(`prose cites <${kind} ${n}> but only ${plates.length} plate(s) are bound`)
    return `@${p.id}`
  })
}

export interface ChainShot {
  /** 1-based position in the WHOLE chain — the scene number, and the identity
   * the checkpoint / resume machinery addresses it by. Re-submitting the same
   * plan with a different prompt/frames/steps/seed for an already-rendered
   * scene is what `verify_resume_history` refuses — see the module comment on
   * `buildChainGraph`. */
  index: number
  /** Resolved prompt, citing `<Subject N>` / `<Picture N>` against the plates
   * array passed alongside it. */
  prompt: string
  /** Authored length in frames — expected already on H3's 17k+5 grid (`snapUp`
   * is applied regardless, so an off-grid value is not silently accepted, it is
   * rounded up). */
  frames: number
  steps?: number
  seed: number
}

/** One clip of a Studio clip plan, as the pieces needed to become a `ChainShot`. */
export interface ChainPlanClip {
  /** 1-based position in the plan — the same identity as `ChainShot.index`. */
  index: number
  prompt: string
  seconds: number
}

/** What was actually recorded for a plan clip the last time IT rendered as
 * part of THIS plan's chain — what a redo of some OTHER clip must resend
 * byte-identically. See `chainShotsForPlan`. */
export interface ChainPlanPriorClip {
  prompt: string
  frames: number
  steps?: number
  seed?: number
}

/**
 * Map a Studio clip plan into the `ChainShot[]` a chain submit needs —
 * shared by the whole-plan submit and a single-scene redo, which differ only
 * in which clips are allowed to use their CURRENT prompt/settings.
 *
 * With no `sceneIndex`: every clip uses its current prompt/settings — the
 * whole-plan fast path, nothing has rendered yet so there is nothing to
 * resend.
 *
 * With a `sceneIndex`: every clip OTHER than that one resends exactly what
 * `priorOf` returns for it (an earlier submit of this same plan's chain) —
 * never re-derived from the plan's current prompt/settings, which is exactly
 * the drift Contex-Loop's `verify_resume_history` exists to catch. The target
 * scene alone uses its current prompt/settings — that is the redo. A clip
 * `priorOf` has nothing for (never rendered) falls back to current values
 * too, same as the whole-plan case.
 */
export function chainShotsForPlan(
  plan: ChainPlanClip[],
  opts: {
    sceneIndex?: number
    steps: number
    fps?: number
    /** Seed for a clip using its CURRENT settings — a plain counter in tests,
     * `settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31)`
     * in the app. Called once per such clip, in plan order. */
    nextSeed: () => number
    priorOf: (index: number) => ChainPlanPriorClip | undefined
  },
): ChainShot[] {
  const fps = opts.fps ?? 24
  return plan.map((c) => {
    const prior = opts.sceneIndex !== undefined && c.index !== opts.sceneIndex ? opts.priorOf(c.index) : undefined
    if (prior) return { index: c.index, prompt: prior.prompt, frames: prior.frames, steps: prior.steps ?? opts.steps, seed: prior.seed ?? 0 }
    return { index: c.index, prompt: c.prompt, frames: framesForSeconds(c.seconds, fps), steps: opts.steps, seed: opts.nextSeed() }
  })
}

export interface ChainBuildOpts {
  /** The checkpoint folder identity. Stable across every call in one chain —
   * changing it starts a DIFFERENT chain with no history to resume from. */
  runName: string
  width: number
  height: number
  /** Floored at `CHAIN_MIN_STEPS`; never forced down to it. */
  steps: number
  baseSeed?: number
  /** Chain's own resume knob: the scheduler's 1-based comma/colon list
   * ("", "3", "3:8"). Blank means every scene — a fresh, un-resumed run. */
  sceneRange?: string
  /** Rejoin what is already saved, sampling nothing. */
  assembleOnly?: boolean
  loraName?: string
  loraStrength?: number
  unetName?: string
}

export interface ChainReferenceUsage {
  id: string
  /** 1-based scene numbers this plate's `@tag` actually appears in. */
  scenes: number[]
}

export interface BuildChainResult {
  graph: Record<string, ComfyNode>
  padded: PaddedClip[]
  planJson: string
  references: ChainReferenceUsage[]
  outputNode: string
}

export interface BuildChainArgs {
  /** The Contex-Loop workflow, exactly as the operator dropped it — see
   * `recipe.ts`'s "the recipe stays theirs" governing idea. */
  graph: Record<string, ComfyNode>
  shots: ChainShot[]
  plates: ChainPlate[]
  opts: ChainBuildOpts
}

/**
 * Build the whole chain as one job. Ported from `buildChainGraph` in h3-shots'
 * `longform.mjs` (measured 2026-09-01/2026-09-06); see the module comment for
 * what is fixed rather than configurable, and for why the reference-addressing
 * transform differs from h3-shots' own.
 *
 * Throws `ChainError` on anything the graph or the shot/plate data cannot
 * support — never submits a graph it cannot account for.
 */
export function buildChainGraph(args: BuildChainArgs): BuildChainResult {
  const { graph: source, shots, plates, opts } = args
  const {
    runName, width, height, steps,
    baseSeed = 1000,
    sceneRange = '',
    assembleOnly = false,
    loraName = CANONICAL_TURBO_LORA,
    loraStrength,
    unetName = CANONICAL_UNET,
  } = opts

  if (!shots.length) throw new ChainError('No shots in this chain — nothing to submit.')
  if (steps < CHAIN_MIN_STEPS) {
    throw new ChainError(
      `${steps} steps is below the floor of ${CHAIN_MIN_STEPS} — the accelerator LoRA samples above its ` +
        'distilled step count; under-stepped renders come back looking corrupted.',
    )
  }
  // Guard against a LoRA/steps combination already measured to look
  // corrupted, the same contract h3-shots enforces at build time — checked
  // before anything is mutated, not after.
  if (/_sla_/i.test(loraName)) throw new ChainError(`SLA turbo LoRA is forbidden: ${loraName}. Use ${CANONICAL_TURBO_LORA}.`)

  const g: Record<string, ComfyNode> = JSON.parse(JSON.stringify(source))
  for (const k of Object.keys(g)) {
    const v = g[k] as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) delete g[k]
  }

  const plan = byClass(g, PLAN_CLASS)
  const cur = byClass(g, CURRENT_CLASS)
  const ctx = byClass(g, CONTEXT_CLASS)
  const trim = byClass(g, TRIM_CLASS)
  const asm = byClass(g, ASSEMBLE_CLASS)
  const loopStart = byClass(g, LOOP_START_CLASS)
  const i2v = byClass(g, DEMO_I2V_CLASS)
  const shift = byClass(g, SIGMA_SHIFT_CLASS)
  const clip = byClass(g, CLIP_LOADER_CLASS)
  const vVae = allOfClass(g, VAE_LOADER_CLASS).find((k) => !/audio/i.test(String(g[k].inputs?.vae_name ?? '')))
  const aVae = allOfClass(g, VAE_LOADER_CLASS).find((k) => /audio/i.test(String(g[k].inputs?.vae_name ?? '')))
  const sched = allOfClass(g, SCHEDULER_CLASS).find((k) => Array.isArray(g[k].inputs?.steps))
  const adv = allOfClass(g, SAMPLER_ADV_CLASS).find((k) => (g[k].inputs?.latent_image as unknown[] | undefined)?.[0] === ctx)
  // THE CHAIN'S SAMPLER-SELECT, resolved from the graph rather than by class —
  // a graph can carry more than one KSamplerSelect (an unrelated single-clip
  // demo branch ships its own), and what identifies the chain's is that its own
  // SamplerCustomAdvanced already points at it.
  const turbo = (g[adv as string]?.inputs?.sampler as unknown[] | undefined)?.[0] as string | undefined ?? byClass(g, SAMPLER_SELECT_CLASS)

  const missing: string[] = []
  for (const [name, id] of Object.entries({ plan, cur, ctx, trim, asm, loopStart, i2v, turbo, shift, clip, vVae, aVae, sched, adv })) {
    if (!id) missing.push(name)
  }
  if (missing.length) throw new ChainError(`This does not look like the Contex-Loop workflow — missing the node behind: ${missing.join(', ')}`)

  pruneTo(g, asm as string)
  applyLoraOverride(g, loraName, loraStrength)
  applyUnetOverride(g, unetName)

  // The demo branch's own image-to-video and sampler-select go; the chain's
  // sampler-select must NOT (they can be the same class), so `turbo` is
  // excluded by identity, not by class.
  delete g[i2v as string]
  for (const k of allOfClass(g, SAMPLER_SELECT_CLASS)) if (k !== turbo) delete g[k]
  if (g[turbo as string]) g[turbo as string].inputs.sampler_name = CHAIN_SAMPLER
  else g[turbo as string] = { class_type: SAMPLER_SELECT_CLASS, inputs: { sampler_name: CHAIN_SAMPLER } }

  const padded = padForOverlap(
    shots.map((s) => ({ frames: s.frames })),
    CHAIN_CONTEXT_LENGTH,
  )

  const compiled = shots.map((s) => citeToTag(s.prompt, plates))

  const planJson = JSON.stringify(
    {
      shots: shots.map((s, i) => ({
        id: `shot${String(s.index).padStart(2, '0')}`,
        prompt: compiled[i],
        length: padded[i].rendered,
        steps: s.steps ?? steps,
        seed: s.seed,
        // H3 treats an omitted scene value of 0 as "inherit video context". Carry
        // an explicit zero so the fixed audio-safe recipe actually disables
        // generated-audio carry instead of silently using the visual context.
        audio_context_length: CHAIN_AUDIO_CONTEXT_LENGTH,
      })),
    },
    null,
    2,
  )

  Object.assign(g[plan as string].inputs, {
    plan_json: planJson,
    run_name: runName,
    generation_fingerprint: '',
    width,
    height,
    context_length: CHAIN_CONTEXT_LENGTH,
    encode_mode: CHAIN_ENCODE_MODE,
    anchor_mode: CHAIN_ANCHOR_MODE,
    crop: 'disabled',
    audio_mode: 'generated_audio',
    audio_context_length: CHAIN_AUDIO_CONTEXT_LENGTH,
    default_duration_seconds: CHAIN_DEFAULT_DURATION_SECONDS,
    default_steps: steps,
    base_seed: baseSeed,
    segment_crf: CHAIN_SEGMENT_CRF,
    video_blend_frames: CHAIN_VIDEO_BLEND_FRAMES,
    continuation_mode: CHAIN_CONTINUATION_MODE,
  })

  // THE REFERENCE REGISTRY — the pack's Tagged (prompt-driven) API. A plate
  // activates in a scene IFF its `@tag` occurs in that scene's resolved
  // prompt, which `citeToTag` has already produced above — so "used" is
  // simply which plates any compiled prompt actually cites, never a
  // separately-declared list that could drift from the prose.
  const used: ChainReferenceUsage[] = plates
    .map((p) => ({ id: p.id, scenes: compiled.map((t, i) => (t.includes(`@${p.id}`) ? i + 1 : 0)).filter(Boolean) }))
    .filter((p) => p.scenes.length)

  const over = shots
    .map((_, i) => ({ scene: i + 1, n: used.filter((p) => p.scenes.includes(i + 1)).length }))
    .filter((x) => x.n > REF_CAPS.image)
  if (over.length) throw new ChainError(`scene(s) over H3's ${REF_CAPS.image}-reference cap: ${JSON.stringify(over)}`)

  if (used.length) {
    const byId = new Map(plates.map((p) => [p.id, p]))
    let prev: string | null = null
    used.forEach((p, i) => {
      const plate = byId.get(p.id) as ChainPlate
      g[`h3lfImg${i}`] = {
        class_type: 'LoadImage',
        inputs: { image: plate.subfolder ? `${plate.subfolder}/${plate.filename}` : plate.filename },
      }
      g[`h3lfRef${i}`] = {
        class_type: TAGGED_PICTURE_CLASS,
        inputs: {
          image: [`h3lfImg${i}`, 0],
          tag: p.id,
          ...(prev ? { previous: [prev, 0] } : {}),
        },
      }
      prev = `h3lfRef${i}`
    })

    g.h3lfSref = {
      class_type: TAGGED_R2V_CLASS,
      inputs: {
        clip: [clip as string, 0],
        vae: [vVae as string, 0],
        audio_vae: [aVae as string, 0],
        references: [prev, 0],
        clip_index: [cur as string, 1],
        clip_count: [cur as string, 2],
        prompt: [cur as string, 4],
        width: [cur as string, 8],
        height: [cur as string, 9],
        length: [cur as string, 6],
        ref_image_size: CHAIN_REF_IMAGE_SIZE,
        state: [cur as string, 0],
        reference_policy: CHAIN_REFERENCE_POLICY,
        conditioning_backend: 'native_ref2va',
      },
    }
    g[ctx as string].inputs.conditioning = ['h3lfSref', 0]
    g[ctx as string].inputs.latent = ['h3lfSref', 1]
  } else {
    // No plate is cited anywhere in this chain — a text-only film. The
    // Tagged wrapper's `references` input is a REQUIRED custom-typed socket
    // (`MiniMaxH3TaggedReferenceToVideo` on the box) and there is no node
    // that emits an "empty" registry to satisfy it, so wiring it with
    // nothing upstream (a dangling link) is exactly what came back as
    // `prompt_outputs_failed_validation` on 2026-09-07 — a validation error
    // ComfyUI blamed on the downstream conditioning consumer, not on the
    // actual missing input.
    //
    // The fix is to condition on the STOCK `MiniMaxH3ReferenceToVideo` node
    // instead — verified on the box (comfy_extras/nodes_minimax_h3.py) to
    // take its `ref_images`/`ref_videos`/`ref_audios` as genuinely OPTIONAL
    // Autogrow inputs (min: 0): with none connected it just tokenizes the
    // prompt with no reference items, which is a normal, valid graph. This
    // is the same node the pack's own (deprecated) scheduled-reference path
    // builds under the Tagged API, so it is not a workaround invented here.
    g.h3lfNoRef = {
      class_type: STOCK_R2V_CLASS,
      inputs: {
        clip: [clip as string, 0],
        vae: [vVae as string, 0],
        audio_vae: [aVae as string, 0],
        prompt: [cur as string, 4],
        width: [cur as string, 8],
        height: [cur as string, 9],
        length: [cur as string, 6],
        ref_image_size: CHAIN_REF_IMAGE_SIZE,
      },
    }
    g[ctx as string].inputs.conditioning = ['h3lfNoRef', 0]
    g[ctx as string].inputs.latent = ['h3lfNoRef', 1]
  }
  g[ctx as string].inputs.audio_vae = [aVae as string, 0]
  g[adv as string].inputs.latent_image = [ctx as string, 3]
  g[adv as string].inputs.sampler = [turbo as string, 0]
  g[sched as string].inputs.scheduler = CHAIN_SCHEDULER
  g[trim as string].inputs.fps = 24
  g[trim as string].inputs.retain_overlap_frames = CHAIN_VIDEO_BLEND_FRAMES
  Object.assign(g[shift as string].inputs, { shift_video: CHAIN_SHIFT_VIDEO, shift_audio: CHAIN_SHIFT_AUDIO })
  if (sceneRange) g[loopStart as string].inputs.scene_range = sceneRange
  Object.assign(g[asm as string].inputs, {
    audio_source: 'generated',
    filename: runName,
    audio_bitrate: 256,
    copy_to_output: true,
  })

  if (assembleOnly) {
    const only: Record<string, ComfyNode> = {
      [plan as string]: g[plan as string],
      h3lfManifest: { class_type: 'MiniMaxH3ChainManifestLoad', inputs: { plan: [plan as string, 0] } },
      h3lfAssemble: { ...g[asm as string], inputs: { ...g[asm as string].inputs, manifest: ['h3lfManifest', 0] } },
    }
    return { graph: assertNoDanglingLinks(only), padded, planJson, references: used, outputNode: 'h3lfAssemble' }
  }

  return { graph: assertNoDanglingLinks(g), padded, planJson, references: used, outputNode: asm as string }
}

/** What the panel shows, and what blocks a chain submit. */
export interface ChainIssuesInput {
  graph: Record<string, ComfyNode> | null
  shots: Array<{ index: number; prompt: string }>
  plateCount: number
  steps: number
}

const CHAIN_REQUIRED_CLASSES = [
  PLAN_CLASS, CURRENT_CLASS, CONTEXT_CLASS, TRIM_CLASS, ASSEMBLE_CLASS,
  LOOP_START_CLASS, DEMO_I2V_CLASS, SIGMA_SHIFT_CLASS,
]

/** One file ComfyUI's `/history` reported as an output — filename/subfolder/type,
 * whatever node produced it. */
export interface ChainOutputCandidate {
  filename: string
  subfolder: string
  type: string
}

/**
 * Pick the FILM out of a chain job's outputs, never a scene checkpoint.
 *
 * Contex-Loop emits every scene's checkpoint MP4 as an output too (under a
 * `segments` subfolder in ComfyUI's `output/h3_chains/<run_name>/`), and it
 * comes back ALONGSIDE the assembled film with no ordering guarantee that
 * favours the film — h3-shots measured this actually downloading scene 1
 * while looking exactly like success (a playable file at the right path;
 * only its frame count gave it away). Assemble writes to the output ROOT
 * under `filename`, which `buildChainGraph` sets to `runName` — so matching
 * on that name, and refusing anything under a `segments` subfolder, is how
 * this is told apart without waiting to count frames after the fact.
 */
export function pickAssembledVideo(outputs: ChainOutputCandidate[], runName: string): ChainOutputCandidate | undefined {
  const videos = outputs.filter((o) => /\.(mp4|webm|mov)$/i.test(o.filename))
  return videos.find((o) => !/segments/i.test(o.subfolder) && o.filename.startsWith(runName))
}

export function chainIssues(input: ChainIssuesInput): string[] {
  const { graph, shots, plateCount, steps } = input
  const out: string[] = []

  if (!graph) {
    out.push('No Contex-Loop recipe loaded — drop the chain ComfyUI workflow saved in API format.')
  } else {
    for (const cls of CHAIN_REQUIRED_CLASSES) {
      if (!byClass(graph, cls)) out.push(`No ${cls} node found — this does not look like the Contex-Loop workflow.`)
    }
  }

  if (!shots.length) out.push('No clips in the chain — nothing to submit.')
  for (const s of shots) if (!s.prompt.trim()) out.push(`Clip ${s.index} has no prompt yet.`)

  // Zero plates is fine — a text-only film. A plateless chain used to build
  // cleanly here and then be refused by the box (`prompt_outputs_failed_validation`
  // on the Tagged Ref2VA reference node's `conditioning` input, measured live
  // 2026-09-07), because the Tagged wrapper's `references` socket is a
  // required custom-typed input nothing was connecting. `buildChainGraph` now
  // conditions a plateless scene on the stock (non-Tagged) ref2va node
  // instead, whose reference inputs are genuinely optional — see its own
  // module comment. H3's reference cap is what actually blocks.
  if (plateCount > REF_CAPS.image) out.push(`${plateCount} plates exceeds H3's ${REF_CAPS.image}-reference cap.`)

  if (steps < CHAIN_MIN_STEPS) {
    out.push(
      `${steps} steps is below the floor of ${CHAIN_MIN_STEPS} — the accelerator LoRA samples above its distilled step count; under-stepped renders come back looking corrupted.`,
    )
  }

  for (const s of shots) {
    for (const m of s.prompt.matchAll(CITATION)) {
      const n = Number(m[2])
      if (n > plateCount) out.push(`Clip ${s.index} cites <${m[1]} ${n}> but only ${plateCount} plate(s) are bound.`)
    }
  }

  return out
}

export { snapUp }
