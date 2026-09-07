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

  // ── the render loop ───────────────────────────────────────────────────
  /** Which ComfyUI to render on. */
  comfyEndpointId?: string
  /** Which stored recipe to render with. */
  recipeId?: string
  /** Which stored recipe is the Long Media (multiclip) workflow — a user has both. */
  multiclipRecipeId?: string
  /** Which stored recipe is the Contex-Loop (chain) workflow — a user can have all three. */
  chainRecipeId?: string
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
  addedAt: number
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

/** One clip's frame accounting inside a multiclip job — see multiclip.ts's `padForOverlap`. */
export interface MulticlipPerClip {
  /** 1-based position in the plan this entry came from. */
  index: number
  authored: number
  rendered: number
  delivered: number
}

/**
 * Set when a `Clip` is not one render loop pass but a whole plan submitted as
 * ONE Long Media multiclip job — still a single render producing a single
 * video, so it stays one `Clip` rather than becoming a new kind of record.
 */
export interface MulticlipRecord {
  /** Which plan clip indexes this one job covered, in order. */
  clipIndexes: number[]
  perClip: MulticlipPerClip[]
  /** Delivered seconds, summed — what the film actually runs, not what was asked for. */
  totalSeconds: number
}

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
  /** Where the mp4 lives on the box. Resolved to a URL at render time. */
  output?: { filename: string; subfolder: string; type: string }
  /** Last frame, as a data URL, once pulled. */
  lastFrame?: string
  error?: string
  ms?: number
  at: number
  /** Set when this clip is a whole plan submitted as one Long Media multiclip job. */
  multiclip?: MulticlipRecord
  /** Set when this clip is one scene of a Contex-Loop chain. */
  chain?: ClipChainInfo
}
