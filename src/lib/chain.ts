import { REF_CAPS, framesForSeconds } from './recipe'
import { padForOverlap, snapUp } from './frames'
import type { PaddedClip } from './frames'
import type { ComfyNode, LoraStackEntry } from './types'

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
/** The Contex-Loop pack's SELECTABLE LoRA stack — separate from the
 * accelerator's `LoraLoaderBypassModelOnly` above, and never confused with it
 * (see `LoraStackEntry`'s module comment in types.ts). */
const LORA_STYLE_STACK_CLASS = 'LTX_lora_loader'
const UNET_LOADER_CLASS = 'UNETLoader'
const TAGGED_PICTURE_CLASS = 'MiniMaxH3TaggedPictureReference'
const TAGGED_R2V_CLASS = 'MiniMaxH3TaggedReferenceToVideo'
/** The stock (non-Tagged) MiniMax H3 ref2va conditioning node — a ComfyUI
 * built-in (`comfy_extras/nodes_minimax_h3.py`), not part of the Contex-Loop
 * pack. Used only when a chain has no plate to cite — see the module comment
 * beside its wiring below. */
const STOCK_R2V_CLASS = 'MiniMaxH3ReferenceToVideo'
/** Core ComfyUI video loader — its single required input is a COMBO of
 * filenames already in the box's input folder (verified live 2026-09-07:
 * `object_info` reports exactly `file`). Not the pack's own node. */
const LOAD_VIDEO_CLASS = 'LoadVideo'
/** Contex-Loop's own node for turning an uploaded/picked video into scene 1's
 * predecessor — see `ChainBuildOpts.externalVideo`'s module comment. */
const EXTERNAL_VIDEO_CLASS = 'MiniMaxH3ChainExternalVideo'

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

/**
 * Below its floor the accelerator LoRA samples above its distilled step
 * count — and the floor is a property of the graph's OWN attention/gate
 * config, not of the app, because the two shipped chain variants
 * (`recipe.ts`'s `SHIPPED_CHAIN_RECIPE_SLA_ID` / `_VSA_ID`) were measured at
 * different floors:
 *
 * History: a 4-step production render came back looking corrupted
 * (founder, 2026-08-23) on the SLA-attention front end (`H3SLAAttention` +
 * `ModelAttentionBackend`), so the floor for that config is 6 — safely
 * inside the distilled step count.
 *
 * The floor is 4 only where the model path runs the `Ref2VAVSAGatePatch`
 * gate (`fasth3_vsa_gate.safetensors`, sparsity 0.75) instead of SLA
 * attention (founder, 2026-09-07) — 4 steps is validated clean on THAT
 * config specifically. This is a deliberate departure from the
 * SLA-attention recipe, made because the VSA gate is faster — not a
 * relaxation of the original 2026-08-23 finding, which still holds for any
 * graph still running SLA attention. If the founder switches the bound
 * chain recipe from VSA back to SLA, submitting at 4 steps must be refused
 * again — that is exactly what `chainMinSteps` deriving from the graph
 * (rather than a single global) exists to guarantee.
 *
 * No override: this is a browser app, not a script with an env-var escape hatch.
 */
export const CHAIN_MIN_STEPS_SLA = 6
export const CHAIN_MIN_STEPS_VSA = 4
/** Neither node class found (an unknown/foreign graph) — same conservative
 * floor as SLA, never the lower VSA one, since the corruption risk is on
 * under-stepping, not on being overly cautious. */
export const CHAIN_MIN_STEPS_DEFAULT = 6

const SLA_ATTENTION_CLASS = 'H3SLAAttention'
const VSA_GATE_CLASS = 'Ref2VAVSAGatePatch'

/**
 * The step floor for THIS graph's own attention/gate config — read from the
 * graph itself (never a setting, never a single app-wide constant), so
 * switching the bound chain recipe between the shipped SLA and VSA variants
 * (or dropping in any other workflow) moves the floor with it.
 */
export function chainMinSteps(graph: Record<string, ComfyNode> | null | undefined): number {
  if (!graph) return CHAIN_MIN_STEPS_DEFAULT
  const classes = new Set(Object.values(graph).map((n) => n.class_type))
  if (classes.has(SLA_ATTENTION_CLASS)) return CHAIN_MIN_STEPS_SLA
  if (classes.has(VSA_GATE_CLASS)) return CHAIN_MIN_STEPS_VSA
  return CHAIN_MIN_STEPS_DEFAULT
}

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

/**
 * Every LoRA name matching this is an ACCELERATOR — distilled-step or
 * turbo-family — never a style choice. Offering one of these in the
 * selectable style stack invites the corrupted-render failure
 * `chainMinSteps` exists for (an accelerator LoRA sampled at the wrong step
 * count), so this is checked both at the UI layer (`selectableStyleLoras`)
 * and defensively at build time (`buildChainGraph` refuses one here even if
 * something upstream let it through).
 */
export const ACCELERATOR_LORA_RE = /turbo|lightx2v/i

/** Explicit-content style LoRAs — gated behind an opt-in toggle, off by
 * default, same shape as h3-shots' `H3_NO_TORPEDO`/`H3_NO_VAGINA`/`H3_NO_PENIS`
 * env gates (this is a browser app with no env vars, so the gate is a UI
 * toggle instead). MysticX joined this list 2026-09-07 — it is the NSFW LoRA
 * the shipped workflow used to bake in by default (see `stack_data` on the
 * shipped `LTX_lora_loader`, now empty); it must not be offered by default
 * either. */
export const EXPLICIT_LORA_RE = /HMBreasts|HMPenis|Torpedo|Vagina|MysticX/i

/** The style LoRAs worth offering in the picker: never an accelerator, and
 * explicit-content ones only when the operator has opted in. */
export function selectableStyleLoras(all: string[], opts: { allowExplicit: boolean }): string[] {
  return all.filter((name) => !ACCELERATOR_LORA_RE.test(name) && (opts.allowExplicit || !EXPLICIT_LORA_RE.test(name)))
}

/** Serialize a style-stack selection into the exact `stack_data` shape the
 * Contex-Loop pack's `LTX_lora_loader` parses — `str`/`v`/`a`/`t`, not
 * `strength`, matching h3-shots' own baked workflows byte-for-byte so a
 * filename with `%20` in it survives round-trip untouched. */
export function serializeLoraStack(stack: LoraStackEntry[]): string {
  return JSON.stringify(stack.map((e) => ({ on: e.on, lora: e.lora, str: e.strength, v: 1, a: 1, t: 1 })))
}

/** Parse a `stack_data`-shaped JSON string (`serializeLoraStack`'s own output,
 * or whatever a workflow file / env var already carries) into `LoraStackEntry[]`.
 * Never throws: anything malformed, or not an array, just reads as empty. Shared
 * by `readBakedLoraStack` (a graph's own baked default) and `localLoraStackOverride`
 * (the operator's own machine-local default). */
function parseLoraStackData(raw: string): LoraStackEntry[] {
  try {
    const parsed = JSON.parse(raw) as Array<{ on?: unknown; lora?: unknown; str?: unknown }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => typeof e.lora === 'string')
      .map((e) => ({ lora: e.lora as string, strength: typeof e.str === 'number' ? e.str : 0.5, on: e.on !== false }))
  } catch {
    return []
  }
}

/** The inverse of `serializeLoraStack` — read back whatever a graph's
 * `LTX_lora_loader.stack_data` already carries (the workflow file's OWN
 * baked default, e.g. MysticX @ 0.5), so the studio can show and seed an
 * edit from it rather than starting a customization from nothing. Never
 * throws: a graph with no style-stack node, or malformed JSON, just reads as
 * empty. */
export function readBakedLoraStack(graph: Record<string, ComfyNode> | null | undefined): LoraStackEntry[] {
  if (!graph) return []
  const id = byClass(graph, LORA_STYLE_STACK_CLASS)
  if (!id) return []
  return parseLoraStackData(String(graph[id].inputs.stack_data ?? '[]'))
}

/**
 * The operator's OWN machine-local default style stack — sourced from
 * `VITE_LOCAL_LORA_STACK` in a gitignored `.env.local`, never from the
 * shipped workflow.
 *
 * Vite inlines `VITE_*` vars at BUILD time, and the GitHub Pages build runs
 * from a fresh checkout with no `.env.local` present, so this is empty on the
 * public site regardless of what any operator's own machine has configured —
 * the shipped `LTX_lora_loader.stack_data` (empty, see `EXPLICIT_LORA_RE`'s
 * module comment) is what every visitor actually gets. `raw` is
 * `import.meta.env.VITE_LOCAL_LORA_STACK` — passed in rather than read
 * directly so this stays testable outside Vite.
 */
export function localLoraStackOverride(raw: string | undefined): LoraStackEntry[] {
  if (!raw) return []
  return parseLoraStackData(raw)
}

/**
 * A stable comparison key for a plan clip's style-stack selection —
 * `undefined` ("leave the workflow's own baked stack alone") is its OWN
 * distinct value, never treated as equal to an explicit stack even one with
 * identical content, because the two mean different things at build time
 * (one stamps nothing, the other stamps exactly that array).
 */
export function loraStackKey(stack: LoraStackEntry[] | undefined): string {
  if (stack === undefined) return '\0default'
  return JSON.stringify(stack.map((e) => ({ on: e.on, lora: e.lora, str: e.strength })))
}

/**
 * Whether a whole-plan chain submit can go out as ONE job, or must auto-split
 * into one job per scene.
 *
 * One ComfyUI job builds ONE graph with ONE `LTX_lora_loader.stack_data` —
 * every shot in that job samples against whatever this build stamped, so a
 * whole-plan submit can only stay a single job when every plan clip wants the
 * SAME style stack. The moment two clips differ, the only way to honour both
 * is one job per scene (see the module comment on `renderChainPlan` in
 * state.tsx for why that costs almost nothing extra).
 */
export function planNeedsPerSceneLoraSplit(stacks: ReadonlyArray<LoraStackEntry[] | undefined>): boolean {
  if (stacks.length <= 1) return false
  const first = loraStackKey(stacks[0])
  return stacks.some((s) => loraStackKey(s) !== first)
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
  return text.replace(CITATION, (whole, kind: string, nStr: string) => {
    const n = Number(nStr)
    const p = plates[n - 1]
    // An unresolvable citation is LEFT AS IT IS rather than refusing the
    // render. `<Subject N>` is H3's own native label syntax, so a citation
    // with no plate behind it is still meaningful prose — the model reads it
    // as a subject the prompt's own `subject_definitions` describes. It only
    // means no PLATE rides that scene for it, which costs identity fidelity,
    // not validity. Blocking here refused whole prompts an authoring pass had
    // legitimately written with more subjects than plates bound.
    if (!p) return whole
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
  /** Floored at `chainMinSteps(graph)` for THIS graph; never forced down to it. */
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
  /**
   * The style stack for THIS job. Unset leaves the workflow's own baked
   * `LTX_lora_loader.stack_data` untouched — a clip that has never been
   * customized renders exactly as before this existed (still MysticX @ 0.5
   * on the shipped fixture). Set (including `[]`) to replace it, so a stale
   * workflow file can never silently decide which style LoRAs render.
   */
  loraStack?: LoraStackEntry[]
  /**
   * Continue from an EXISTING video rather than starting a chain from
   * nothing — wires `LoadVideo(filename) -> MiniMaxH3ChainExternalVideo(plan,
   * source_video, prepend_original) -> LoopStart.external_context`.
   *
   * Only meaningful on a SCENE-1 submit: Contex-Loop's `_initial_state` only
   * consults `external_context` when `range_start === 1` (`start_clip`
   * defaulting to 1, or `scene_range` starting there) — any later scene
   * ignores it silently, which would look like the option did nothing rather
   * than fail loudly. So `buildChainGraph` throws `ChainError` instead of
   * building a graph whose external video is a no-op.
   *
   * `prepend_original: true` (the node's own default) persists a normalized
   * copy of the whole source video and places it before the generated scenes
   * during assembly, audio included — false renders only the extension.
   */
  externalVideo?: { filename: string; prependOriginal: boolean }
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
    loraStack,
    externalVideo,
  } = opts

  if (!shots.length) throw new ChainError('No shots in this chain — nothing to submit.')
  // `_initial_state` only reads `external_context` when the range starts at
  // scene 1 — check before anything is mutated, not after, same contract as
  // the steps/SLA guards below.
  if (externalVideo && sceneRange && !/^1(:|$)/.test(sceneRange)) {
    throw new ChainError(
      `externalVideo can only continue a scene-1 submit — scene_range "${sceneRange}" does not start at 1, so ` +
        'the imported video would be silently ignored.',
    )
  }
  // NOT gated on step count. Under-stepping an accelerator LoRA below its
  // distilled count does degrade a render, and `chainWarnings` still says so —
  // but that is a judgement about picture quality, not a malformed graph, and
  // the operator is better placed to make it than this builder is. A render
  // that comes back soft is cheap to redo; a floor that refuses to submit is
  // not. (Demoted from a hard error 2026-09-08 at the founder's call.)
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

  if (loraStack !== undefined) {
    const bad = loraStack.find((e) => ACCELERATOR_LORA_RE.test(e.lora))
    if (bad) throw new ChainError(`Style-stack LoRA "${bad.lora}" is an accelerator LoRA — accelerators only belong in the turbo slot.`)
    const stackNode = byClass(g, LORA_STYLE_STACK_CLASS)
    if (!stackNode) throw new ChainError(`No ${LORA_STYLE_STACK_CLASS} node found — this workflow has nowhere to apply a style-stack selection.`)
    g[stackNode].inputs.stack_data = serializeLoraStack(loraStack)
  }

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

  if (externalVideo) {
    g.h3lfLoadVideo = { class_type: LOAD_VIDEO_CLASS, inputs: { file: externalVideo.filename } }
    g.h3lfExternalVideo = {
      class_type: EXTERNAL_VIDEO_CLASS,
      inputs: {
        plan: [plan as string, 0],
        source_fps: 24.0,
        prepend_original: externalVideo.prependOriginal,
        source_video: ['h3lfLoadVideo', 0],
      },
    }
    g[loopStart as string].inputs.external_context = ['h3lfExternalVideo', 0]
  }

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

  return out
}

/**
 * Things worth saying that must NOT stop a render.
 *
 * An unresolvable `<Subject N>` citation lives here rather than in
 * `chainIssues`: `<Subject N>` is H3's own label syntax, so a citation with no
 * plate behind it still reads as valid prose — it just means no reference
 * image rides that scene for that subject. That costs identity fidelity, not
 * validity, and blocking on it refused whole prompts an authoring pass had
 * legitimately written with more subjects than plates bound.
 */
export function chainWarnings(
  input: Pick<ChainIssuesInput, 'shots' | 'plateCount'> & Partial<Pick<ChainIssuesInput, 'steps' | 'graph'>>,
): string[] {
  const { shots, plateCount, steps, graph } = input
  const out: string[] = []

  // Advisory, not a gate: this is a picture-quality call for the operator.
  if (typeof steps === 'number') {
    const minSteps = chainMinSteps(graph)
    if (steps < minSteps) {
      out.push(
        `${steps} steps is below this workflow's accelerator LoRA distilled count of ${minSteps} — expect a softer or noisier render. Submitting anyway is fine.`,
      )
    }
  }
  for (const s of shots) {
    const unresolved = new Set<string>()
    for (const m of s.prompt.matchAll(CITATION)) {
      if (Number(m[2]) > plateCount) unresolved.add(`<${m[1]} ${m[2]}>`)
    }
    if (unresolved.size) {
      out.push(
        `Clip ${s.index} cites ${[...unresolved].join(', ')} with ${plateCount} plate(s) bound — ` +
          'those subjects render from the prompt text alone, with no reference image to hold their identity.',
      )
    }
  }
  return out
}

export { snapUp }
