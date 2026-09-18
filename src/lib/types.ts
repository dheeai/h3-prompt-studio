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
  /**
   * Written by the studio's OWN pipeline while the operator was watching a
   * scene render, rather than in response to something they clicked — see
   * "author the next clip while I watch this one" (2026-09-16). Never set by
   * a manual Draft/Revise/Continue; surfaced so a prompt on the page can be
   * told apart from one the operator actually asked for.
   */
  auto?: boolean
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
  /**
   * A film-wide camera/lens/look choice, made once and carried into every
   * clip's `{{film}}` block (`filmBlock` in `stages.ts` → `describeFilmLook`
   * in `filmLook.ts`) — see `FilmLook`'s own comment for why this lives here
   * rather than as a render/graph setting. `state.tsx`'s `setFilm` merges a
   * partial update onto the existing `film` object, so setting this once,
   * before any clip is authored, is enough for it to reach every clip
   * authored afterwards without being re-picked per clip.
   */
  look?: FilmLook
}

/**
 * A film-wide camera/lens/look choice (2026-09-17 brief: "a camera lens as a
 * static selection at the beginning"; refined same day to ONE dropdown of
 * named camera-and-lens COMBINATIONS rather than independent axes — a focal
 * length, a grain gauge and a palette are not independent choices, and a
 * multi-axis form invites picking ones that do not describe any real camera
 * package).
 *
 * Deliberately NOT one of `EXTENDER_SIGNATURE_FIELDS` (`extender.ts`) and
 * never routed through `buildExtenderGraph` — those 28 fields are hashed by
 * the Master Extender node, and moving one truncates every already-validated
 * clip in the film. A look is authored PROMPT text instead: changing it
 * mid-film reaches only clips not yet authored, leaving already-authored or
 * already-rendered clips exactly as they were (and the film visually
 * inconsistent until those are redone by hand) — a much cheaper failure mode
 * than discarding a validated render.
 *
 * The presets themselves (see `FILM_LOOK_PRESETS` in `filmLook.ts`) are
 * built from the `h3-cinematography` skill's own six-element look grammar
 * (aspect, grain gauge, four-colour palette, optics register), which
 * records what actually reads as cinema to H3, rather than being invented
 * here. `preset` is optional, and `freeText` is a standing escape hatch — a
 * named list cannot cover everything H3 responds to. An entirely unset look
 * adds nothing to the prompt — see `describeFilmLook`.
 *
 * UNMEASURED: whether a stated focal length (part of a preset's optics
 * register) produces a genuine field-of-view change in the render, or is
 * only a stylistic nudge H3 obeys the way it obeys grain/palette
 * vocabulary. A preset's `bestFor` line is a suggestion about the LOOK,
 * never a claim of optical accuracy.
 */
export interface FilmLook {
  /** The id of a `FilmLookPreset` from `filmLook.ts`'s `FILM_LOOK_PRESETS` —
   * a complete, coherent camera-and-lens combination, not an isolated axis. */
  preset?: string
  /** Anything the preset list doesn't cover, appended verbatim — or a look
   * written entirely from scratch, alongside or instead of a preset. */
  freeText?: string
}

/**
 * One entry of a workflow's style-stack (`LTX_lora_loader.stack_data`) —
 * the SELECTABLE LoRA slot, distinct from an accelerator LoRA (baked into
 * the workflow's own turbo slot), which is never user-editable. `lora` is
 * the exact filename ComfyUI reported — some are percent-encoded
 * (`Neon%20Skyline%20Style...`) — and must be carried byte-exact; never
 * decoded or re-encoded, or the box will not find the file on disk.
 */
export interface LoraStackEntry {
  lora: string
  /** 0-1 — the range a workflow's own baked-in stack already uses. Nothing
   * in the node's schema documents a wider range accepting >1, so the
   * studio's editor caps here. */
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
   * workflow already carries baked into its own `LTX_lora_loader.stack_data`"
   * — so an untouched clip renders exactly as before this existed. Set
   * explicitly (including `[]`, "no style LoRA at all") the moment an
   * operator edits it.
   */
  loraStack?: LoraStackEntry[]
}

export interface Breakdown {
  /** The film's spine in one line. */
  spine: string
  clips: BreakdownClip[]
  at: number
}

// ── Full Story mode — a shot list, finer-grained than a Breakdown ─────────
//
// `Breakdown`/`BreakdownClip` above are a CLIP-level plan: one entry already
// IS one H3 clip, with a role and continuity text. Full Story mode's model
// call is one level finer than that — a `Shot` is the smallest fixed unit
// ("what happens", nothing about how it's shot), and several shots are
// PACKED into one clip-sized `ShotGroup` afterwards, by pure grouping logic,
// not a second model call. See `shotList.ts`'s module comment for why this
// coexists with `Breakdown` (derives one) rather than replacing or
// duplicating it.

/**
 * One BEAT — the two-pass planner's coarse first pass (`shotList.ts`'s
 * module comment, 2026-09-18 rework). A beat is a distinct movement of the
 * story, never a shot: a complete plot is ~6-12 of these whether the film
 * runs 30 seconds or 30 minutes, because the beat count follows the STORY,
 * never the operator's runtime slider — only the SECOND pass (subdividing a
 * beat into shots) is sized to the runtime. `weight` is relative screen time
 * only (not seconds, not a percentage) — `shotList.ts`'s `allocateBeatSeconds`
 * is what turns it into real seconds.
 */
export interface Beat {
  /** 1-based position in the whole film's arc. */
  index: number
  /** What happens — fixed elements only, same discipline as `Shot.covers`. */
  covers: string
  /** How much relative screen time this beat deserves next to the others. */
  weight: number
}

/** The whole film's beats, before any runtime has been allocated across
 * them — pass 1's own output. */
export interface BeatList {
  spine: string
  beats: Beat[]
  at: number
}

/** A `Beat` once `allocateBeatSeconds` has given it its share of the
 * operator's runtime ceiling — what pass 2 (`subdivideBeat`) actually
 * decomposes into shots. */
export interface AllocatedBeat extends Beat {
  seconds: number
}

/** One shot — the whole film's finest grain. Bare content only: camera,
 * performance and sound are decided later, in the per-clip expansion step
 * (`STAGE_INFO.direct`/`draft` in `stages.ts`) — never here. */
export interface Shot {
  /** 1-based position in the whole film. Stable identity across a revision:
   * "cut from shot N" always means this number, never a re-derived position. */
  index: number
  /** What happens — fixed elements only (who, where, what happens, how it
   * ends). No camera, no shot construction, no performance, no sound. */
  covers: string
  /** This shot's own authored length, in seconds. */
  seconds: number
  /** Which beat (`Beat.index`) this shot was subdivided from — unset for a
   * shot with no beat of its own (there is none once every shot comes from
   * `subdivideBeat`, but the field is optional so a hand-authored `Shot`
   * literal, e.g. in a test, never has to carry one). Lets a plot revision
   * (`planShotRevision`) find which beat a cut shot came from without a
   * second lookup structure. */
  beatIndex?: number
}

/** The whole film's shot list — Full Story mode's step 2 output, before any
 * grouping into clip-sized sets. */
export interface ShotList {
  /** The film's spine in one line — same notion as `Breakdown.spine`. */
  spine: string
  /** The operator's own hard runtime ceiling, in seconds, that the shots'
   * total was asked to fit inside — see `shotList.ts`'s `checkRuntimeCeiling`. */
  maxRuntimeSeconds: number
  shots: Shot[]
  /**
   * Pass 1's beats, each with its allocated share of `maxRuntimeSeconds` —
   * kept here (not just used transiently in `state.tsx`) so a later
   * revision (`planShotRevision`) can re-subdivide only the beats at or
   * after a cut without re-authoring the whole arc. Optional so a
   * hand-built `ShotList` literal (e.g. `shotScreens.test.ts`'s fixtures,
   * written before beats existed) still type-checks with none.
   */
  beats?: AllocatedBeat[]
  at: number
}

/** One clip-sized grouping of consecutive shots — Full Story mode's step 3
 * output. A group is the unit that becomes one H3 clip. */
export interface ShotGroup {
  /** 1-based position among the film's groups — becomes `BreakdownClip.index`
   * / the Master Extender's `sceneIndex` once expanded (see
   * `shotList.ts`'s `breakdownClipsFromShotGroups`). */
  index: number
  /** The `Shot.index` values this group covers, in order — always
   * contiguous, and a shot is never split across two groups. */
  shotIndices: number[]
  /** Sum of the covered shots' own `seconds` — authored, not grid-snapped;
   * see `geometry.ts`'s `framesForSeconds` for the grid-snapped figure. */
  seconds: number
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
  /**
   * Author the next clip's draft in the background the instant a scene
   * lands, so it is already on the page by the time the operator has
   * finished watching what just rendered — see the module comment on
   * `entry.ts`'s `canAutoAuthorNext`. Default ON; switchable off for an
   * operator on a metered endpoint, or one who wants the GPU quiet between
   * renders.
   */
  autoAuthorNext?: boolean
  /** Pre-redesign fields, read ONLY by `migrateBreakIntoScenes` on load to
   * seed `breakIntoScenes` for an existing profile, then left alone —
   * nothing in the current UI writes or reads these any more. */
  studioMode?: 'idea' | 'prompt' | 'video' | 'story'
  planFirst?: boolean

  // ── the render loop ───────────────────────────────────────────────────
  /** Which ComfyUI to render on. */
  comfyEndpointId?: string
  /** Target clip length before the frame grid snaps it. */
  seconds: number
  /** A film normally wants one seed the whole way down. */
  lockSeed: boolean
  seed: number
  /**
   * Operator overrides onto the shipped Master Extender graph's own baked
   * master-node inputs — ONLY fields that differ from the graph's baked
   * value are ever stored here (see `extenderSettings.ts`'s
   * `withExtenderOverride`), so an untouched install sends nothing and a
   * later graph update is never silently shadowed by a stale copy. Keyed by
   * the node's own field names (`EXTENDER_SIGNATURE_FIELDS` in
   * `lib/extender.ts`) — e.g. `pass2_resolution`, `pass2_steps`,
   * `context_length`, `sla_sparsity`. Applied at build time via
   * `buildExtenderGraph`'s existing `overrides` argument, which is also what
   * the settings-signature guard hashes — this is never a second gate on top
   * of it.
   */
  extenderOverrides?: Record<string, unknown>
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
  endpointId?: string
  seed?: number
  frames?: number
  fps?: number
  promptId?: string
  /** The style-stack this scene actually rendered with — recorded so a
   * film's card can say what rendered even after the plan clip it came from
   * changes. Unset means the workflow's own baked default was used (see
   * `BreakdownClip.loraStack`). */
  loraStack?: LoraStackEntry[]
  /** Where the mp4 lives on the box. Resolved to a URL at render time. */
  output?: { filename: string; subfolder: string; type: string }
  /** Last frame, as a data URL, once pulled. */
  lastFrame?: string
  error?: string
  ms?: number
  at: number
  /**
   * Set when this clip is one scene of a Master Extender FILM — either a
   * manually-continued one, or one plan clip of a whole plan submitted as a
   * film (every plan clip gets its own `Clip`, sharing one `nodeId`).
   * `nodeId` is this film's own stable Master Extender node id (see
   * `lib/extender.ts`'s TRAP 1); `sceneIndex` is this clip's 1-based position
   * within it (not necessarily equal to `Clip.index`, though the studio's
   * own "Continue" turn always keeps them in step). An Extender scene
   * delivers exactly what it authored — there is no overlap tax to account
   * for (see `lib/extender.ts`'s module comment).
   */
  extender?: { nodeId: string; sceneIndex: number }
}
