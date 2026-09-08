export type SkillSource = 'bundled' | 'upload' | 'url'

export interface SkillFile {
  /** Path relative to the skill root, e.g. "references/rule-of-six.md". */
  rel: string
  text: string
  /** Estimated tokens — see tokens.ts for why this is an estimate. */
  tokens: number
}

export interface Skill {
  id: string
  name: string
  description: string
  source: SkillSource
  /** Where a url-sourced skill came from, for re-sync. */
  origin?: string
  addedAt: number
  files: SkillFile[]
}

/** Which files of which skills are currently loaded into the context. */
export type Selection = Record<string, string[]>

export type ProviderKind = 'openai' | 'ollama'

export interface Provider {
  id: string
  label: string
  /** Base URL including the OpenAI-compatible path segment, e.g. .../v1 */
  baseUrl: string
  kind: ProviderKind
  /** Held in this browser only. Never sent anywhere but this provider. */
  apiKey?: string
  builtIn: boolean
  /** llama.cpp understands cache_prompt; others reject unknown fields. */
  sendCachePrompt?: boolean
  /** Endpoint compiles `response_format: json_schema` into a sampling
   * constraint. Verified on llama.cpp build b10826 (2026-09-08): accepted,
   * enforced, and it does NOT suppress the reasoning block. */
  supportsJsonSchema?: boolean
  /**
   * Endpoint + model can take image content parts.
   *
   * Every model on the local box is mmproj-equipped (thinkingcap-27b,
   * qwen38-heretic-27b*, huihui-*), so plates can be shown to the authoring
   * model rather than only described. A text-only model 400s on an
   * `image_url` part, so `llm.ts` retries text-only when that happens —
   * this flag only decides whether to try.
   */
  supportsVision?: boolean
  /**
   * Endpoint honours a per-request reasoning ceiling.
   *
   * Set FALSE for a server that accepts the fields and ignores them — the
   * dangerous case, because the request says 4096 and nothing is bounded.
   * Measured 2026-09-08 against ninfer (NInfer, NVFP4 Qwen3.8-27B): with
   * `reasoning_budget_tokens: 128` it produced 786 chars of reasoning against
   * an 834-char baseline, and `thinking_budget_tokens: 128` produced 1162 —
   * MORE than baseline. Its only real levers are the coarse `reasoning_effort`
   * enum and a process-level `--default-thinking-budget`.
   *
   * Leave undefined to infer from the endpoint (see `reasoningBudgetSupported`).
   */
  supportsReasoningBudget?: boolean
  /** Set-up hint shown when a probe fails with a CORS-shaped error. */
  corsHint?: string
}

export type ProbeState =
  | 'unknown'
  | 'probing'
  | 'ok'
  | 'mixed-content'
  | 'local-network-blocked'
  | 'unreachable'
  | 'no-key'
  | 'error'

export interface ProbeResult {
  state: ProbeState
  detail: string
  /** A concrete next step, when the failure has one. */
  hint?: string
  /** A corrected URL to offer, when the entered one is malformed. */
  suggest?: string
  models: string[]
  at: number
}

export type StageId = 'direct' | 'draft' | 'critique' | 'revise' | 'rebuild' | 'freeform' | 'handoff' | 'breakdown'

export interface Version {
  id: string
  stage: StageId
  label: string
  text: string
  model: string
  providerId: string
  at: number
  ms: number
  /** Thinking tokens, when the model emitted any. */
  reasoning?: string
  /** Exactly what this pass worked from, so a diff has a real "before". */
  fromText?: string
  /** The prose explanation alongside the prompt — a separate section, never the prompt itself. */
  explanation?: string
  /** One line per edit, each naming the document that required it. */
  changelog?: string[]
  /** Completion tokens — real if the server reported them, else estimated. */
  tokens?: number
  /** True when `tokens` is an estimate rather than a reported count. */
  tokensEstimated?: boolean
  /** The instruction that produced it, for freeform turns. */
  note?: string
  /** How many continuation rounds the server-side output cap forced. */
  continuations?: number
  /** True when even the last continuation round was still cut off. */
  truncated?: boolean
  /** Which clip of a breakdown this pass was directed for, if any. */
  clipIndex?: number
}

/** Where a clip sits in a longer film, when it is not standalone. */
export type ClipRole = 'standalone' | 'opening' | 'rising' | 'turn' | 'falling' | 'closing'

export interface FilmContext {
  role: ClipRole
  /** What the whole film is about — one line. */
  spine: string
  /** The state the audience arrives in, from the previous clip. */
  precedes: string
  /** What the next clip has to be able to open on. */
  follows: string
  /** A short name for the clip, from a breakdown. */
  title?: string
  /** What THIS clip alone must cover, from a breakdown — the rest of the source is context only. */
  covers?: string
  /** Which clip of a breakdown this is, so a pass can be attributed to it. */
  clipIndex?: number
}

/**
 * One entry of the Contex-Loop style-stack (`LTX_lora_loader.stack_data`) —
 * the SELECTABLE LoRA slot, distinct from the accelerator LoRA stamped into
 * `LoraLoaderBypassModelOnly` (`chain.ts`'s `CANONICAL_TURBO_LORA`), which is
 * never user-editable. `lora` is the exact filename ComfyUI reported — some
 * are percent-encoded (`HMBreasts%20-%20...`) — and must be carried byte-exact;
 * never decoded or re-encoded, or the box will not find the file on disk.
 */
export interface LoraStackEntry {
  lora: string
  /** 0-1 — the range the workflow's own baked-in stack already uses (MysticX
   * @ 0.5). Nothing in the node's schema documents a wider range accepting
   * >1, so the studio's editor caps here. */
  strength: number
  on: boolean
}

/** One clip of a story broken down into several. */
export interface BreakdownClip {
  index: number
  title: string
  role: ClipRole
  seconds: number
  /** What happens in this clip — fixed elements only, no camera. */
  covers: string
  /** What the audience arrives at THIS clip having just seen — empty for the first. */
  precedes: string
  /** What the next clip must open on. */
  follows: string
  /**
   * This clip's style-stack selection. Unset means "whatever the bound
   * Contex-Loop workflow already carries baked into its own
   * `LTX_lora_loader.stack_data`" — so an untouched clip renders exactly as
   * before this existed. Set explicitly (including `[]`, "no style LoRA at
   * all") the moment an operator edits it, and from then on THAT is what
   * `chain.ts` stamps into the graph at build time, replacing whatever the
   * workflow file carries.
   */
  loraStack?: LoraStackEntry[]
}

export interface Breakdown {
  /** The film's spine in one line. */
  spine: string
  clips: BreakdownClip[]
  at: number
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  at: number
  /** Set when this turn produced a new pass rather than just an answer. */
  versionId?: string
}

export type H3Mode = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA' | 'Ref2VA' | 'MoGr'

export interface Settings {
  /** Bumped when a default changes in a way that must reach existing users. */
  schema?: number
  providerId: string
  model: string
  temperature: number
  /** 0 = send no ceiling at all and let the server use its own maximum. */
  maxTokens: number
  /** Per-provider/model reasoning budget for compatible local Qwen models. */
  thinkingBudgets?: Record<string, number>
  mode: H3Mode
  selection: Selection
  /**
   * User overrides ONLY. Storing a full copy meant a stored snapshot shadowed
   * the shipped defaults forever, so no improvement to a stage prompt could
   * ever reach someone who had already opened the app.
   */
  stageTemplates: Partial<Record<StageId, string>>
  /** Bundled skill ids already offered, so a deletion is not undone on reload. */
  seenBundled?: string[]
  onboarded: boolean

  // ── the composer ──────────────────────────────────────────────────────
  /** The one control on the composer: plan the whole arc first (writing
   * every scene's prompt before any render) rather than just this scene.
   * There are no entry-mode doors any more — see `lib/entry.ts`'s module
   * comment — this is the only variable the operator chooses. */
  breakIntoScenes?: boolean
  /** Pre-redesign fields, read ONLY by `migrateBreakIntoScenes` on load to
   * seed `breakIntoScenes` for an existing profile, then left alone —
   * nothing in the current UI writes or reads these any more. */
  studioMode?: 'idea' | 'prompt' | 'video' | 'story'
  planFirst?: boolean

  // ── the render loop ───────────────────────────────────────────────────
  /** Which ComfyUI to render on. */
  comfyEndpointId?: string
  /** Which stored recipe to render with. */
  recipeId?: string
  /** Which stored recipe is the Contex-Loop (chain) workflow — the studio's
   * only multi-clip render path — a user has both this and `recipeId`. */
  chainRecipeId?: string
  /**
   * Set once the app has auto-bound the shipped Contex-Loop recipes — both
   * the SLA default and the selectable VSA gate variant (see
   * `fetchShippedChainRecipes`). Gates the attempt rather than `chainRecipeId`
   * itself, so a deliberate later deletion of a shipped recipe — which can
   * leave `chainRecipeId` pointing at nothing — is never silently re-bound on
   * the next reload. A fetch/parse failure on both leaves this unset, so it
   * keeps retrying on later reloads rather than giving up forever on a
   * transient miss.
   */
  chainRecipeAutoBound?: boolean
  /** Which shipped-variant SET this profile has been offered — see
   * `SHIPPED_SET_VERSION`. Lets a profile bound before a new variant existed
   * be topped up once, without re-binding. */
  shippedRecipeSetVersion?: number
  /** Shipped recipes the operator DELETED. Recorded because "top up an older
   * profile with a newly shipped variant" and "never resurrect a deliberate
   * deletion" otherwise collide: with only a version counter, a profile that
   * had deleted a shipped recipe is indistinguishable from one that never
   * received it. An id in here is never re-added. */
  dismissedShippedRecipes?: string[]
  /** UNET stamped onto every chain graph. Unset means `SINGULARITY_UNET` — the
   * model the 27-clip film of 2026-09-06 shipped on. Set it to override. */
  chainUnetName?: string
  /** Target clip length before the frame grid snaps it. */
  seconds: number
  /** A film normally wants one seed the whole way down. */
  lockSeed: boolean
  seed: number
  /** Override the recipe's own step count when set. */
  steps?: number
  /**
   * Geometry override. Left unset, the recipe's OWN defaults win — a workflow
   * swap must not silently keep stale geometry, so these are never copied from
   * `recipe.defaults` on load, only written when the operator picks one.
   */
  width?: number
  height?: number
}

export type Severity = 'error' | 'warn' | 'pass'

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  /** Literal excerpts from the prompt that triggered it. */
  matches: string[]
  metric?: string
}

// ── the render loop ───────────────────────────────────────────────────────

/**
 * A reference image with its JOB written down.
 *
 * The job is not decoration. H3 measurably does better when every reference is
 * told what it is for, and a plate with no job is the failure this type exists
 * to prevent — so `job` is required, not optional.
 */
export interface Plate {
  id: string
  /** What it is, for the humans: "Lira — identity plate". */
  name: string
  /** What the model must take from it, and what it must ignore. */
  job: string
  /** What the model is being handed. H3 takes both, on separate inputs. */
  kind: 'image' | 'video'
  /**
   * Data URL — set when the file came from this machine, so a plate survives a
   * reload without the box. Absent for a plate picked FROM the box, which is
   * already where it needs to be and should never be round-tripped through here.
   */
  dataUrl?: string
  /** Set when the plate is a file already sitting in ComfyUI's input folder. */
  boxFile?: { endpointId: string; filename: string; subfolder: string; type: string }
  /** Filename on the ComfyUI box once uploaded, so it is uploaded once. */
  uploaded?: { endpointId: string; filename: string; subfolder: string }
  /** Carried plates persist across clips; a replaced one is rewritten each clip. */
  mode: 'carried' | 'replaced'
  /** Set when this plate was pulled from a clip's last frame. */
  fromClipId?: string
  /** Which possessive phrasing seeds `job` — the radio in the plate editor. */
  subjectKind?: 'male' | 'female' | 'other'
  /**
   * Structured identity read from a vision-model analysis of this plate's
   * image, in separate fields so `wardrobe` can be overridden independently
   * of identity — see `wardrobeOverride` and `lib/subject.ts`'s `composeSubjectJob`.
   */
  subjectDef?: SubjectDefinition
  /**
   * Wardrobe stated in the operator's own words, replacing `subjectDef.wardrobe`
   * in the composed `job` text entirely rather than negating it — the source
   * garment is never named once an override is set (see `composeSubjectJob`).
   */
  wardrobeOverride?: string
  /**
   * The exact text this app itself last wrote into `job` (from the subject-kind
   * radio or a composed analysis). If `job` no longer equals this, the operator
   * has hand-edited it, and a later radio/analysis change must not silently
   * overwrite it — only offer to.
   */
  jobAuto?: string
  addedAt: number
}

/**
 * Identity attributes read off a plate's image by a vision-model pass, kept
 * apart from every other field so wardrobe can be replaced without touching
 * identity — the Lara Croft -> saree case `lib/subject.ts` exists for.
 */
export interface SubjectDefinition {
  apparentAge: string
  build: string
  face: string
  hair: string
  skin: string
  /** A scar, tattoo, mole or similar — empty string when none are visible. */
  distinguishingMarks: string
  /** What the subject is actually wearing in the image — never blended with identity. */
  wardrobe: string
}

export interface ComfyEndpoint {
  id: string
  label: string
  /** Base URL with no trailing slash, e.g. http://localhost:8188 */
  baseUrl: string
  builtIn: boolean
}

/** Where one value lives inside a user-supplied workflow graph. */
export interface Binding {
  /** Node id in the API-format graph. */
  node: string
  /** Input key on that node. Dotted keys (ref_images.ref_image_0) are literal. */
  field: string
  /** class_type of the node, for display and for re-detection. */
  classType: string
}

export type BindingSlot = 'prompt' | 'width' | 'height' | 'length' | 'seed' | 'steps' | 'output'

/**
 * A ComfyUI workflow plus the map of which node holds what.
 *
 * Bindings are detected by node CLASS TYPE, never by node number, so every
 * variant of a graph — turbo, 8-step, SLA, hybrid — binds without configuration.
 */
export interface Recipe {
  id: string
  name: string
  /** API-format graph, exactly as exported. Stored whole and passed through. */
  graph: Record<string, ComfyNode>
  bindings: Partial<Record<BindingSlot, Binding>>
  /** Candidates the detector could not choose between, for the UI to ask about. */
  ambiguous: Partial<Record<BindingSlot, Binding[]>>
  /**
   * Which node carries each autogrow reference group, found by its prefix.
   * H3 has four: images (max 9), videos (max 3), the videos' soundtracks, and
   * standalone audio.
   */
  refHost?: string
  refHosts?: Partial<Record<'ref_image_' | 'ref_video_' | 'ref_video_audio_' | 'ref_audio_', string>>
  defaults: { width: number; height: number; fps: number; seconds: number }
  addedAt: number
}

export interface ComfyNode {
  class_type: string
  inputs: Record<string, unknown>
  _meta?: { title?: string }
}

export type ClipState = 'queued' | 'rendering' | 'done' | 'failed'

/**
 * Set when a `Clip` was rendered as one scene of a Contex-Loop CHAIN — a
 * single job that resumes every earlier scene from its ComfyUI checkpoint
 * and samples only this one. `runName` is the checkpoint folder identity
 * (stable across every clip in one chain); `sceneIndex` is this clip's
 * 1-based position within it (not necessarily equal to `Clip.index`, though
 * the studio's own "Continue" turn always keeps them in step).
 */
export interface ClipChainInfo {
  runName: string
  sceneIndex: number
  /**
   * Set when this scene's submit carried an external video as scene 1's
   * predecessor (`ChainBuildOpts.externalVideo`). Contex-Loop's join still
   * trims `CHAIN_CONTEXT_LENGTH` frames off this scene's front — but, unlike
   * a continued CLIP, `buildChainGraph` has no compensation for it (nothing
   * in `shots[0]` signals an external predecessor), so this scene genuinely
   * DELIVERS fewer frames than authored rather than landing back at
   * authored. Measured live 2026-09-07: a 56.928s source plus a 124f scene
   * asked for landed at 61.167s (56.928 + 102/24), not 62.095s (an unpaid,
   * untrimmed first clip) or 62.7s (a compensated continuation).
   * `sceneAccounting`'s `padForOverlap` call reads this so the post-render
   * display matches what actually rendered — see `padForOverlap`'s
   * `firstHasPredecessor` for the formula and why it is a measured gap
   * rather than a design choice.
   */
  continuesExternalVideo?: boolean
  /**
   * The actual external-video choice this scene submitted with — recorded
   * (not just the boolean above) so a later Replace of scene 1 can re-pass it
   * faithfully without asking the operator to re-pick the file. `endpointId`
   * is carried so a replace on a DIFFERENT endpoint is recognised as stale
   * (the box file only exists where it was uploaded/picked) rather than
   * silently reused.
   */
  externalVideo?: { filename: string; prependOriginal: boolean; endpointId: string }
}

export interface Clip {
  id: string
  /** 1-based position in the film. */
  index: number
  /** The clip this one continues from, if any — the film is a tree. */
  parentId: string | null
  state: ClipState
  /** The prompt text that produced it, kept so a clip explains itself. */
  prompt: string
  /** The film context this clip was directed under. */
  film?: FilmContext
  plateIds: string[]
  recipeId?: string
  endpointId?: string
  seed?: number
  frames?: number
  fps?: number
  /**
   * Recorded so a later chain scene can resend an EARLIER scene's exact
   * step count in `plan_json` — Contex-Loop's `verify_resume_history` hashes
   * prompt/frames/steps/seed per scene and refuses to resume on a mismatch,
   * so this must survive even if `settings.steps` changes later.
   */
  steps?: number
  promptId?: string
  /** The style-stack this scene actually rendered with — recorded the same
   * way `steps`/`seed` are, so a chain's card can say what rendered even
   * after the plan clip it came from changes. Unset means the workflow's own
   * baked default was used (see `BreakdownClip.loraStack`). */
  loraStack?: LoraStackEntry[]
  /** Where the mp4 lives on the box. Resolved to a URL at render time. */
  output?: { filename: string; subfolder: string; type: string }
  /** Last frame, as a data URL, once pulled. */
  lastFrame?: string
  error?: string
  ms?: number
  at: number
  /** Set when this clip is one scene of a Contex-Loop chain — either a
   * manually-continued one, or one plan clip of a whole plan submitted as a
   * chain (every plan clip gets its own `Clip`, sharing one `runName`). */
  chain?: ClipChainInfo
}
