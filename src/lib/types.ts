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

export type StageId = 'direct' | 'draft' | 'critique' | 'revise' | 'freeform' | 'handoff'

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
  /** One line per edit, each naming the document that required it. */
  changelog?: string[]
  /** Completion tokens — real if the server reported them, else estimated. */
  tokens?: number
  /** True when `tokens` is an estimate rather than a reported count. */
  tokensEstimated?: boolean
  /** The instruction that produced it, for freeform turns. */
  note?: string
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
  /** Target clip length before the frame grid snaps it. */
  seconds: number
  /** A film normally wants one seed the whole way down. */
  lockSeed: boolean
  seed: number
  /** Override the recipe's own step count when set. */
  steps?: number
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
  promptId?: string
  /** Where the mp4 lives on the box. Resolved to a URL at render time. */
  output?: { filename: string; subfolder: string; type: string }
  /** Last frame, as a data URL, once pulled. */
  lastFrame?: string
  error?: string
  ms?: number
  at: number
}
