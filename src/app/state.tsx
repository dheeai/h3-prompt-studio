import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, buildH3SystemPrompt, type BuiltContext, selectionForStage, selectionKey } from '../lib/context'
import { armModelLock, modelSwapWarning, describeModelLock, type ModelLock } from '../lib/modelLock'
import { classifyInput, findingsToText, lint, looksLikePrompt, standingToText } from '../lib/lint'
import { continuationBudgetFor, streamChatComplete } from '../lib/llm'
import type { ChatContentPart } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders, LOCAL_LLM_URL, LOCAL_LLM_MODEL} from '../lib/providers'
import { PROMPT_STAGES, SCHEMA_STAGES, STAGE_LABEL, continuationFrameBlock, durationBlock, fillTemplateWithDuration, filmBlock, platesBlock, hasPromptBlock, latestPromptForClip, nextRole, parseBreakdown, splitPromptReplacement, splitReply, templateFor } from '../lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../lib/schema'
import { DEFAULT_ENDPOINTS, fetchExtenderNodeSchema, lastFrameOf, poll, pollExtender, probeComfy, submit, uploadImage, viewUrl } from '../lib/comfy'
import type { PollResult } from '../lib/comfy'
import { framesForSeconds } from '../lib/geometry'
import { parseWorkflow } from '../lib/workflow'
import { EXTENDER_REF_SLOTS, ExtenderError, buildExtenderGraph, extenderCostEstimate, extenderGeometryFromInputs, readExtenderMasterInputs } from '../lib/extender'
import { mergeExtenderInputs } from '../lib/extenderSettings'
import type { ExtenderNodeSchema } from '../lib/extenderSettings'
import { readBakedLoraStack } from '../lib/loras'
import type { ExtenderClipInput, ExtenderCostEstimate, ExtenderPlate, ExtenderPreviewInfo } from '../lib/extender'
import { countFromIndex, dropFromIndex, dropInvalidatedAutoDraft, redoSeed, validatedClipAt } from '../lib/filmEdit'
import type { PendingAutoDraft } from '../lib/filmEdit'
import { cumulativeFilm, sceneWorkLabel } from '../lib/filmDisplay'
import type { PaddedClip, SceneWorkLabel } from '../lib/filmDisplay'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import { estTokens } from '../lib/tokens'
import { authoringModeForContent, authorContinuation, canAutoAuthorNext, clearDraftContext, continuationSource, interruptedReasoningText, migrateBreakIntoScenes, nextPlanClipToAuthor, previousPromptForClip, promptSourceForAuthoringMode, withContinuationFrame } from '../lib/entry'
import type { AuthoringMode } from '../lib/entry'
import { clipsNeedingPrompt, isSingleRequestStage, type StudioRunPhase } from '../lib/studio-workflow'
import { normalizeThinkingBudgets, resolveThinkingBudget } from '../lib/thinking'
import type {
  Breakdown, ChatTurn, Clip, ComfyEndpoint, ComfyNode, FilmContext, Finding, LoraStackEntry, Plate, ProbeResult,
  Provider, Selection, Settings, Skill, StageId, Version,
} from '../lib/types'

const SETTINGS_SCHEMA = 6

const DEFAULT_FILM: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '' }

const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  // Preselect the operator's own endpoint when a gitignored `.env.local`
  // supplies one (see `LOCAL_LLM_URL` in lib/providers.ts). Falls back to
  // Ollama, so the public build's default is unchanged and no host is baked in.
  providerId: LOCAL_LLM_URL ? 'localbox' : 'ollama',
  model: LOCAL_LLM_MODEL ?? '',
  temperature: 0.35,
  // 0 = no ceiling. A six-section Ref2VA prompt is long, and a reasoning model
  // spends tokens thinking before it writes a word — so any fixed number is a
  // guess that eventually truncates someone. Sending nothing lets the server
  // apply the real limit, which is its context minus the prompt.
  maxTokens: 0,
  thinkingBudgets: {},
  mode: 'Ref2VA',
  selection: {},
  stageTemplates: {},
  onboarded: false,
  seconds: 7.3,
  lockSeed: true,
  seed: 42,
  breakIntoScenes: false,
  // OFF by default (founder, 2026-09-17): "when the prompt is created and
  // rendered it immediately triggers the next scene's prompt — I dont want that
  // behaviour." Full Story mode makes each prompt something you ask for, so a
  // render landing must not write the next one on its own.
  autoAuthorNext: false,
}

/** The deterministic name a plate uploads under — shared so a chain build
 * predicts the exact filename a real upload will produce, without uploading. */
function plateFilename(p: Plate): string {
  return `${p.id}_${p.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'plate'}.png`
}

/**
 * Poll a submitted render to completion or failure.
 *
 * Poll rather than hold a websocket: a dropped link must not lose a render the
 * box is still perfectly happily producing. Shared by every render path —
 * `pollFn` is `poll` for a single clip and `pollChain` (chain.ts-aware, so it
 * never mistakes a scene checkpoint for the assembled film) for any chain job.
 */
async function pollToDone(
  ep: ComfyEndpoint,
  promptId: string,
  pollFn: (ep: ComfyEndpoint, promptId: string) => Promise<PollResult> = poll,
): Promise<Clip['output']> {
  const deadline = Date.now() + 60 * 60 * 1000
  let misses = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    if (Date.now() > deadline) throw new Error('Gave up waiting after an hour.')
    let res
    try {
      res = await pollFn(ep, promptId)
      misses = 0
    } catch {
      // The box can drop off a network and come back. Only give up when it
      // has been gone long enough to be a real outage.
      if (++misses > 120) throw new Error('Lost contact with the box for five minutes.')
      continue
    }
    if (!res.done) continue
    if (res.failed) throw new Error(res.failed)
    return res.output
  }
}

interface Session {
  /** Style LoRAs for the NEXT scene the composer will render.
   *
   * The plan path stores this per `BreakdownClip`; the composer path had no
   * equivalent, so per-scene LoRAs were unreachable when rendering one scene
   * at a time — which is the whole primary loop. Unset means "whatever the
   * bound graph bakes in, or the operator's machine-local default". */
  loraStack?: LoraStackEntry[]
  story: string
  versions: Version[]
  currentId: string | null
  /** The composer thread. Carried into every freeform turn so it continues. */
  chat?: ChatTurn[]
  /** Where this clip sits in a longer film, if it is not standalone. */
  film?: FilmContext
  /** The clip this draft continues from — set by Continue, null for a head. */
  parentClipId?: string | null
  /** The prompt that produced parentClipId, available to continuation Draft. */
  parentPrompt?: string
  /** The last Break down pass, if the story has been split into clips. */
  breakdown?: Breakdown
  /**
   * The parent clip's last rendered frame, as a PNG data URL — a VISION INPUT
   * for the one continuation draft call, never a plate (`continueFrom`'s "NO
   * LAST-FRAME PLATE" comment below explains why a still must not be wired as
   * a reference). Lives here, on the session, rather than in `plates`, purely
   * so it structurally cannot be uploaded to the box, cannot be counted
   * against H3's nine-reference cap, and cannot reach a film graph's
   * reference slots — see `withContinuationFrame`. Cleared the moment the
   * draft that used it lands, fails or is cancelled.
   */
  continuationFrame?: string
  /**
   * A pipeline-authored draft, not yet rendered, sitting at the position it
   * would occupy once submitted — Task 1's own bookkeeping for HAZARD 1 (see
   * `dropInvalidatedAutoDraft`'s module comment in `filmEdit.ts`). Only ever
   * set by an AUTOMATIC `continueFrom` call (the no-plan background-authoring
   * path); the plan path's background authoring doesn't need it — see
   * `nextPlanClipToAuthor`'s module comment for why a plan clip's draft
   * doesn't depend on the parent's actual rendered pixels the way a
   * continuation's does.
   */
  pendingAutoDraft?: PendingAutoDraft
}

type ContinuationPhase = 'frame' | 'draft' | 'ready'

interface ContinuationStatus {
  clipId: string
  phase: ContinuationPhase
  state: 'running' | 'ready' | 'failed' | 'cancelled'
  source?: string
  /** Written by the background pipeline rather than an operator action —
   * see `Version.auto`'s module comment. */
  auto?: boolean
}

interface RunContextOverride {
  /** Source text to use instead of the current session's source. */
  story?: string
  /** Prompt to hand to a stage instead of deriving it from session history. */
  current?: string
  /** Film context to hand to a stage instead of the current session context. */
  film?: FilmContext
  /** Parent prompt context for the Direct pass. */
  previous?: string
  /** Attribute the pass to the selected clip's position in the film. */
  clipIndex?: number
  /** Explicit Studio authoring contract for this pass. */
  studioMode?: AuthoringMode
  /** Written by the background pipeline (Task 1, 2026-09-16) rather than an
   * operator action — tags the resulting `Version`/`streaming` so the
   * operator can tell a prompt on the page apart from one they asked for. */
  auto?: boolean
}

/** A prompt version written by a deterministic surface such as Agent. */
export interface PromptVersionInput {
  text: string
  explanation?: string
  changelog?: string[]
  note?: string
  clipIndex?: number
}

/** The small, synchronous state bridge exposed to the browser Agent. */
export interface PreparedContinuation {
  clipId: string
  clipIndex: number
  prompt: string
  film: FilmContext
  hasEndingFrame: boolean
}

/**
 * One scene of a film (`renderExtender`'s Continue-from-a-clip flow, as
 * opposed to the clip-plan's whole-job submit), as the film UI actually
 * shows it: what it delivered against what it was asked for, and what its
 * card should say about its own work state right now. Always
 * `authored === rendered === delivered` — the Master Extender pays no
 * overlap tax (see `lib/extender.ts`'s module comment) — but the three-field
 * shape survives because a scene's own accounting still has three names
 * worth showing.
 */
export interface FilmSceneRow extends PaddedClip {
  clip: Clip
  sceneIndex: number
  label: SceneWorkLabel
}

/**
 * The film's OWN identity — never a clip's. Fixes the defect measured live
 * 2026-09-06: the render loop stores the assembled film as the NEWEST clip's
 * `output`, so a clip's OWN card would otherwise silently play a cumulative
 * cut that has nothing to do with that one scene. `filmClip` is that same
 * underlying Clip record (its `.output` really is the whole film) but the UI
 * must present it as the FILM's own, never as scene N's own clip.
 */
export interface FilmInfo {
  runName: string
  /** Ordered by scene, 1-based. */
  scenes: FilmSceneRow[]
  /** The Clip record whose `.output` currently holds the assembled film —
   * the newest scene's, since every render of this film reassembles the
   * whole thing. Never render this per-scene; it belongs to the film. */
  filmClip: Clip | null
  totalFrames: number
  totalSeconds: number
}

/** One plan clip as the Master Extender submit panel shows it — no frame
 * accounting to disclose beyond what was asked for (see `lib/extender.ts`'s
 * module comment). `validated` mirrors exactly what `renderExtenderPlan`
 * will send for this clip — never a second estimate. */
interface ExtenderPlanPreviewClip {
  index: number
  title: string
  prompt: string
  seconds: number
  validated: boolean
}

interface ExtenderPlanPreview {
  /** This film's own stable Master Extender node id — see TRAP 1 in
   * `lib/extender.ts`'s module comment. Derived from the breakdown's own
   * timestamp. */
  nodeId: string
  clips: ExtenderPlanPreviewClip[]
  cost: ExtenderCostEstimate
  /** Every blocking problem — same contract as `sceneBlockers`. */
  issues: string[]
}

export interface Api {
  ready: boolean
  skills: Skill[]
  settings: Settings
  providers: Provider[]
  probes: Record<string, ProbeResult>
  story: string
  versions: Version[]
  current: Version | null
  streaming: {
    stage: StageId
    text: string
    reasoning: string
    startedAt: number
    continuations: number
    /** Set once a continuation round is actually underway. */
    phase?: StudioRunPhase
    /** Written by the background pipeline rather than an operator action —
     * see `Version.auto`'s module comment. */
    auto?: boolean
  } | null
  chat: ChatTurn[]
  film: FilmContext
  breakdown: Breakdown | null
  error: string | null
  /** Thinking from a run that produced no answer, kept so it is not lost. */
  failedReasoning: string | null
  /** Partial thinking captured when the operator stopped an in-flight run. */
  interruptedReasoning: string | null
  findings: Finding[]
  context: BuiltContext | null
  /** The one control on the composer — see `lib/entry.ts`'s module comment.
   * Agent has its own fixed contract and never reads this. */
  breakIntoScenes: boolean

  setStory: (s: string) => void
  setBreakIntoScenes: (v: boolean) => void
  setFilm: (f: Partial<FilmContext>) => void
  patchSettings: (p: Partial<Settings>) => void
  toggleSkill: (skill: Skill) => void
  toggleFile: (skill: Skill, rel: string) => void
  addSkills: (skills: Skill[]) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  setProviders: (p: Provider[]) => Promise<void>
  refreshProbe: (id: string) => Promise<void>
  run: (stage: StageId, note?: string, override?: RunContextOverride) => Promise<Version | null>
  /** Bounded generation for Scene/Clip; Prompt Rebuild is one LLM request. */
  rebuild: (mode?: AuthoringMode, opts?: { auto?: boolean }) => Promise<void>

  // ── the render loop ─────────────────────────────────────────────────
  plates: Plate[]
  endpoints: ComfyEndpoint[]
  endpoint: ComfyEndpoint | null
  comfyProbes: Record<string, ProbeResult>
  clips: Clip[]
  clip: Clip | null
  rendering: Clip | null
  /** The GPU mutex: whether the box is currently held by an LLM call or a
   * render. Both `run()` and every render path refuse to start while the
   * other holds it — see the module comment beside `gpuBusyRef`. */
  gpuBusy: 'idle' | 'llm' | 'render'
  /** Why the primary "Make scene N" action (the Master Extender path, the
   * studio's only render path) cannot start yet. Empty when it can render. */
  sceneBlockers: string[]
  /** Whether the shipped `MiniMaxH3MasterExtender` workflow loaded — there is
   * no operator-supplied-workflow UI: the graph ships fixed at
   * `public/workflows/`, so this is a readiness flag rather than a picker. */
  extenderReady: boolean
  /** The geometry/steps the Master Extender will ACTUALLY render at — the
   * graph's own baked value, with any operator override
   * (`Settings.extenderOverrides`) already applied (issue #30: the topbar
   * must report what will actually be sent, never a stale or nominal
   * number). Null before the graph has loaded. */
  extenderDefaults: { width: number; height: number; steps: number } | null
  /** The shipped graph's own baked master-node inputs, none of the
   * operator's overrides applied — what the settings panel seeds every
   * control from and compares an edit against (`readExtenderMasterInputs`).
   * Null before the graph has loaded. */
  extenderMasterDefaults: Record<string, unknown> | null
  /** The Master Extender node's live `turbo_lora` file list off the CURRENT
   * endpoint's own `/object_info` — never hardcoded (see
   * `fetchExtenderNodeSchema`'s module comment). Null before it has been
   * fetched, or when the endpoint is unreachable / has no such node. */
  extenderNodeSchema: ExtenderNodeSchema | null
  /** The Master Extender's own baked style-stack default
   * (`LTX_lora_loader.stack_data` on the shipped graph) — what
   * `LoraStackEditor` seeds an edit from before the operator customizes it. */
  extenderDefaultLoraStack: LoraStackEntry[]
  /** The clip plan's Master Extender accounting and gate — the cost-before-
   * spend disclosure the brief asks for (clip count, total seconds, how many
   * will sample versus come from cache), computed off exactly the flags
   * `renderExtenderPlan` will send. Null with no plan yet. */
  extenderPlanPreview: ExtenderPlanPreview | null
  /** The active Master Extender film's own identity/scenes — see
   * `Clip.extender`'s module comment. Null until some clip in this session
   * rendered through this path. */
  extenderFilm: FilmInfo | null
  /** The node's own progress receipt for the in-flight (or last) Master
   * Extender job — `h3_preview_info`, read straight from `/history` rather
   * than shown as a bare spinner. Null before anything has been submitted. */
  extenderProgress: ExtenderPreviewInfo | null
  /** End-to-end continuation progress, retained as a receipt once ready or failed. */
  continuation: ContinuationStatus | null
  addPlate: (p: Omit<Plate, 'id' | 'addedAt'>) => Promise<void>
  updatePlate: (id: string, patch: Partial<Plate>) => Promise<void>
  deletePlate: (id: string) => Promise<void>
  reorderPlate: (id: string, delta: number) => Promise<void>
  setEndpoints: (e: ComfyEndpoint[]) => Promise<void>
  refreshComfyProbe: (id: string) => Promise<void>
  clipUrl: (c: Clip) => string | null
  /**
   * Submit the clip plan as ONE Master Extender job — the studio's only
   * multi-clip render path. `runMode` is the node's own switch:
   * `'clip_by_clip'` renders the next not-yet-validated clip and stops,
   * `'full_batch'` renders every pending clip in one job. Every clip already
   * validated (a landed `Clip` at that plan index, for THIS film's node id)
   * resends exactly its own recorded prompt/seconds/seed, never the plan's
   * current (possibly since-edited) values.
   */
  renderExtenderPlan: (runMode: 'clip_by_clip' | 'full_batch') => Promise<void>
  /**
   * Render the composer's current text as one Master Extender scene — the
   * single-scene equivalent of `renderExtenderPlan`: every earlier scene of
   * this session's film resends exactly what was recorded when it rendered
   * (`validated: true`), and the new one goes out `validated: false`, via
   * `run_mode: 'clip_by_clip'`. Joins whichever film the current clip
   * belongs to (via `parentClipId`, set by `prepareContinuation`/
   * `continueFrom`), or starts a fresh one at scene 1.
   */
  renderExtender: () => Promise<void>
  /**
   * Prepare a REDO of one already-landed scene on the manual/composer chain
   * (`renderExtender`'s own path) — brought back for the Master Extender per
   * the 2026-09-16 brief ("redo a single scene" existed for Contex-Loop as
   * "Replace scene" and was wrongly removed with it). Loads the scene's OWN
   * prompt/film context into the composer and selects its predecessor as the
   * new render's parent, so pressing the composer's existing "Make scene N"
   * — unchanged — resubmits at exactly this same index, discarding every
   * scene after it exactly as Continue-from-here already does. Nothing is
   * sent by this call itself; see the module comment beside its definition.
   * `keepSeed` reuses the scene's exact recorded seed instead of drawing a
   * fresh one (see `lib/filmEdit.ts`'s `redoSeed`).
   */
  redoScene: (clipId: string, opts?: { keepSeed?: boolean }) => void
  /**
   * REDO one clip of a Break-down plan (`renderExtenderPlan`'s own path) —
   * the ClipPlan-panel counterpart of `redoScene` above. Drops the `done`
   * Clip record(s) at or after `index` for this plan's film RIGHT AWAY (so
   * the cost preview — `extenderPlanPreview` — immediately shows the right
   * resample/cache split), but sends nothing: the operator still presses
   * "Render the next clip" / "Render every pending clip" to actually
   * resubmit, exactly `renderExtenderPlan`'s existing contract, unchanged.
   */
  redoPlanClip: (index: number, opts?: { keepSeed?: boolean }) => void
  selectClip: (id: string) => void
  /** How many scenes of `clip`'s film, from `fromIndex` on, currently exist —
   * what a Continue-from-here targeting `fromIndex` would invalidate
   * (everything from the target scene on gets discarded locally and would
   * need re-rendering). Zero when there is nothing to lose. */
  scenesFrom: (clipId: string, fromIndex: number) => number
  /** Author the next prompt from a landed clip; rendering remains a separate
   * action. Works from ANY clip in a film, not only the newest — rendering
   * the result (via `renderExtender`) then invalidates every scene from its
   * target on. */
  continueFrom: (clipId: string, note?: string, opts?: { auto?: boolean }) => Promise<void>
  /**
   * Author every remaining plan clip that has no prompt yet, then submit the
   * whole plan as one Master Extender job — Task 2, "Generate the rest"
   * (2026-09-16). The autonomous tail on an interactive head: gated in the UI
   * behind a plan existing AND at least one scene already landed, and behind
   * one confirmation stating the cost before anything is spent (`ClipPlan.tsx`'s
   * `GenerateRestAction`, using the SAME `extenderPlanPreview` numbers the
   * manual submit button already shows, per the brief — never a second
   * estimate that can drift). Stops the instant an authoring pass comes back
   * empty (Stop/cancel, or a real failure) and leaves whatever already
   * landed — authored or rendered — untouched; nothing here retries or
   * rolls back.
   */
  generateRest: () => Promise<void>
  /** A pipeline-authored draft still sitting on the page, not yet rendered —
   * see HAZARD 1 in the 2026-09-16 brief and `dropInvalidatedAutoDraft`. Null
   * once it renders, is discarded, or was never authored automatically. */
  pendingAutoDraft: PendingAutoDraft | null
  /** Append a canonical prompt version without invoking an LLM stage. */
  appendPromptVersion: (input: PromptVersionInput) => Version | null
  /** Save the clip plan without invoking an LLM stage. */
  setBreakdown: (breakdown: Breakdown) => void
  /** Set (or clear, with `undefined`) one plan clip's style-stack selection.
   * Clearing returns it to "whatever the bound workflow already carries" —
   * see `BreakdownClip.loraStack`'s module comment. */
  setClipLoraStack: (clipIndex: number, stack: LoraStackEntry[] | undefined) => void
  /** Style LoRAs chosen for the next composer render; undefined = leave the
   * bound graph's baked stack alone. */
  loraStack: LoraStackEntry[] | undefined
  /** Style LoRAs for the next composer render. Undefined = leave the bound
   * graph's baked stack alone. */
  setLoraStack: (stack: LoraStackEntry[] | undefined) => void
  /** Select a clip and stage its deterministic continuation context. */
  prepareContinuation: (clipId: string) => PreparedContinuation | null
  cancel: () => void
  selectVersion: (id: string) => void
  clearError: () => void
  /** Advisory message — shown, never blocking. See `notice` in the provider. */
  notice: string | null
  clearNotice: () => void
  reset: () => Promise<void>
  /** Claim the GPU mutex for a caller OUTSIDE `run()`/the render paths — the
   * Agent's own LLM loop, which does not go through `run()`. Returns false
   * (and sets `error`) when the box is already held by the other side.
   * Always release with `endGpuUse`. */
  beginGpuUse: (kind: 'llm' | 'render') => boolean
  endGpuUse: () => void
  /** The model this session is pinned to, and a deliberate release. */
  modelLock: ModelLock
  modelLockLabel: string
}

const Ctx = createContext<Api | null>(null)

export function useApp(): Api {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  // The composer's one control — plan the whole arc first, vs just this
  // scene — is a sticky preference, unlike the draft itself, so it lives in
  // `settings` and round-trips through the same load/migrate/persist path
  // every other setting does. See `Settings.breakIntoScenes`'s module comment.
  const breakIntoScenes: boolean = settings.breakIntoScenes ?? false
  const [providers, setProvidersState] = useState<Provider[]>(DEFAULT_PROVIDERS)
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [session, setSession] = useState<Session>({ story: '', versions: [], currentId: null, chat: [] })
  const [clips, setClips] = useState<Clip[]>([])
  const [currentClipId, setCurrentClipId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState<{
    stage: StageId
    text: string
    reasoning: string
    startedAt: number
    continuations: number
    phase?: StudioRunPhase
    auto?: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Advisory, non-blocking, and deliberately a SEPARATE channel from `error`:
  // a model swap is a cost to state, not a failure to refuse (see modelLock.ts).
  // Folding it into `error` would have made a normal choice look like a fault.
  const [notice, setNotice] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const [failedReasoning, setFailedReasoning] = useState<string | null>(null)
  const [interruptedReasoning, setInterruptedReasoning] = useState<string | null>(null)
  const [continuation, setContinuation] = useState<ContinuationStatus | null>(null)
  const [plates, setPlates] = useState<Plate[]>([])
  const [endpoints, setEndpointsState] = useState<ComfyEndpoint[]>(DEFAULT_ENDPOINTS)
  const [comfyProbes, setComfyProbes] = useState<Record<string, ProbeResult>>({})
  /** The Master Extender node's live `turbo_lora` file list, per endpoint —
   * see `fetchExtenderNodeSchema`'s module comment. Refreshed alongside the
   * probe below; `null` for an endpoint not yet fetched or unreachable, so
   * the settings panel can fall back to the graph's own baked value. */
  const [extenderNodeSchemas, setExtenderNodeSchemas] = useState<Record<string, ExtenderNodeSchema | null>>({})
  const [renderingId, setRenderingId] = useState<string | null>(null)
  // ── Master Extender (the studio's only render path) ────────────────────
  //
  // The graph ships fixed at `public/workflows/minimax_h3_master_extender_api.json`
  // — there is no operator-drop-your-own-workflow UI for this path — so it is
  // fetched once at boot (below) as a plain asset, never through an idb store.
  const [extenderGraph, setExtenderGraph] = useState<Record<string, ComfyNode> | null>(null)
  const [extenderProgress, setExtenderProgress] = useState<ExtenderPreviewInfo | null>(null)
  // What was actually recorded as each film's frozen settings the last time a
  // submit of it succeeded — keyed by the film's own node id, so
  // `checkExtenderSignature` (inside `buildExtenderGraph`) has something to
  // compare against on every later submit of the SAME film. Session-lifetime
  // only, same as every other render-loop ref here: a refresh always starts
  // the studio's WORK clean (see the boot effect's own comment), and this is
  // exactly that — bookkeeping about work in progress, not configuration.
  const extenderFrozenRef = useRef<Record<string, Record<string, unknown>>>({})
  /**
   * A redo's seed choice, one-shot, keyed by `${nodeId}:${sceneIndex}` — set
   * only by `redoScene`/`redoPlanClip` when `keepSeed` is asked for (never
   * for the default fresh-seed case, which needs no override: dropping the
   * old Clip record already forces the ordinary "nothing validated at this
   * index" branch in `renderExtender`/`renderExtenderPlan`, which mints a
   * fresh seed on its own). Read and deleted in the same breath by whichever
   * of those two builds this scene's `clips_json` entry next, so a stale
   * keep-seed request can never leak into an unrelated later render of the
   * same index.
   */
  const redoSeedOverridesRef = useRef<Record<string, number>>({})
  /**
   * Carries a REDO's `nodeId` through the one case `parentClipId` cannot
   * express: redoing scene 1 itself, which has no predecessor scene to read
   * a `nodeId` off. Set by `redoScene`; consulted (and preferred over the
   * ordinary parent-derived nodeId/sceneIndex) by `renderExtender`. Cleared
   * by every OTHER session-preparing entry point (`prepareContinuation`,
   * `continueFrom`) and once a redone scene actually lands, so a stray
   * earlier redo can never leak into an unrelated later render — see the
   * module comment on `redoScene`.
   */
  const redoTargetRef = useRef<{ nodeId: string; sceneIndex: number } | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const continuationAbortRef = useRef<AbortController | null>(null)
  // ── pipeline (background) authoring — Task 1, 2026-09-16 ──────────────
  //
  // `pipelineAuthoringRef` holds the in-flight job (whichever of
  // `continueFrom`/`rebuild` background authoring is currently running), so
  // an operator action that must preempt it (Replace, Continue, typing —
  // HAZARD 2) can abort it AND wait for the GPU mutex it holds to actually
  // release before proceeding — see `abortPipelineAuthoring`. Every call site
  // that starts a background job is responsible for clearing its OWN entry
  // once it settles (compare-and-clear against the promise object itself, so
  // a job that started a later one never clobbers it).
  //
  // `authorNextAfterLandingRef` exists purely for ordering: the function it
  // holds needs `continueFrom` and `rebuild`, both defined later in this
  // component than `renderExtender`/`renderExtenderPlan`, which need to CALL it.
  // Reading it through a ref — assigned once, right after its real
  // definition below — sidesteps having to hoist half this file.
  const pipelineAuthoringRef = useRef<Promise<unknown> | null>(null)
  const authorNextAfterLandingRef = useRef<(landed: { clipId?: string; sceneIndex: number }) => Promise<void>>(
    async () => {},
  )
  // Same forward-ref reasoning as `authorNextAfterLandingRef`: `setStory` is
  // declared well before `abortPipelineAuthoring` (which itself needs
  // `cancel`), and a dependency array reads its identifier immediately, not
  // lazily — so a direct reference would throw before either is defined.
  const abortPipelineAuthoringRef = useRef<() => Promise<void>>(async () => {})
  // ── the GPU mutex ──────────────────────────────────────────────────────
  //
  // The gateway single-flights the GPU, and the two directions are NOT
  // symmetric in cost: llama evicts cleanly (`unload`), but ComfyUI evicts via
  // a `free` request it cannot honour mid-sample, and the supervisor hard-
  // kills it at its timeout. So a model call fired while a render is in
  // flight can destroy tens of minutes of GPU work — measured to actually
  // happen. `gpuBusyRef` is the single guard both directions check before
  // starting: an LLM stage (`run()`, below) refuses to start while a render
  // holds it, and every render path refuses to start while an LLM call holds
  // it. The ref is read synchronously inside async closures (same pattern as
  // `sessionRef`); `gpuBusy` is its state mirror, for the UI to show why a
  // button is disabled.
  const [gpuBusy, setGpuBusyState] = useState<'idle' | 'llm' | 'render'>('idle')
  const gpuBusyRef = useRef<'idle' | 'llm' | 'render'>('idle')
  // ONE MODEL PER SESSION, enforced at the same choke point as the GPU mutex.
  //
  // Every LLM path already routes through `settings.model` — the authoring stages, the
  // Agent surface, and the plate/vision analysis — so there is no per-stage swap. The
  // hole is a swap BETWEEN calls: changing the selection mid-session evicts ~30 GB and
  // reloads, and swap contention on this box has been measured at ~150x on render times.
  // Founder directive 2026-09-10: the Studio must never swap models. The lock arms on the
  // first model call and pins it; a different one is refused with the reason.
  // `beginGpuUse('llm')` is the one gate all three LLM paths pass through, which is why
  // this lives here rather than at each call site.
  const [modelLock, setModelLock] = useState<ModelLock>(null)
  const modelLockRef = useRef<ModelLock>(null)
  const beginGpuUse = useCallback((kind: 'llm' | 'render'): boolean => {
    if (gpuBusyRef.current !== 'idle') {
      setError(
        gpuBusyRef.current === 'render'
          ? 'A render is in flight on the box — wait for it to finish before calling the model. A chat completion fired mid-render gets ComfyUI hard-killed by the gateway (it cannot honour a mid-sample unload cleanly).'
          : 'A model call is in flight — wait for it to finish before starting a render. The gateway single-flights the GPU; starting a render now is refused rather than racing the drain.',
      )
      return false
    }
    if (kind === 'llm') {
      // A swap is expensive, not forbidden (founder, 2026-09-17). State the cost
      // once per change and proceed — `armModelLock` re-arms to the new model, so
      // the scene after this one is not warned about a choice already made.
      const swap = modelSwapWarning(modelLockRef.current, settings.model, settings.providerId)
      if (swap) setNotice(swap)
      const armed = armModelLock(modelLockRef.current, settings.model, settings.providerId)
      if (armed !== modelLockRef.current) { modelLockRef.current = armed; setModelLock(armed) }
    }
    gpuBusyRef.current = kind
    setGpuBusyState(kind)
    return true
  }, [settings.model, settings.providerId])
  const endGpuUse = useCallback(() => {
    gpuBusyRef.current = 'idle'
    setGpuBusyState('idle')
  }, [])
  // run() closes over session, so chaining two stages in one turn would read
  // state from before the first one finished. The ref always holds the latest.
  const sessionRef = useRef(session)
  sessionRef.current = session

  // ── boot ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      let bundledIds: string[] = []
      const [savedSettings, savedProviders] = await Promise.all([
        idb.get<Settings>('settings', 'settings'),
        loadProviders(),
      ])
      let stored = await loadSkills()

      // Sync whatever this deployment ships with — not just on a first visit,
      // or a skill added to the deployment later would never reach anyone who
      // had already opened the app.
      const bundled = await fetchBundledSkills()
      if (bundled.length) {
        const byId = new Map(stored.map((s) => [s.id, s]))
        const seen = new Set(savedSettings?.seenBundled ?? [])
        const writes: Skill[] = []
        for (const b of bundled) {
          const existing = byId.get(b.id)
          if (existing) {
            // A bundled skill belongs to the deployment, so refresh its text —
            // but never touch one the user uploaded or fetched themselves.
            if (existing.source === 'bundled' && JSON.stringify(existing.files) !== JSON.stringify(b.files)) writes.push(b)
          } else if (!seen.has(b.id)) {
            writes.push(b)
          }
          // Anything already seen and since deleted stays deleted.
        }
        for (const w of writes) await saveSkill(w)

        // A bundled skill dropped from the deployment should disappear with it
        // — it is the deployment's, not the user's. Only ever prune when the
        // manifest actually loaded, so a failed fetch cannot wipe the library.
        bundledIds = bundled.map((b) => b.id)
        const shipped = new Set(bundledIds)
        const stale = stored.filter((s) => s.source === 'bundled' && !shipped.has(s.id))
        for (const s of stale) await removeSkill(s.id)

        if (writes.length || stale.length) stored = await loadSkills()
      }

      const merged: Settings = {
        ...DEFAULT_SETTINGS,
        ...savedSettings,
        stageTemplates: { ...(savedSettings?.stageTemplates || {}) },
        thinkingBudgets: normalizeThinkingBudgets(savedSettings?.thinkingBudgets),
        seenBundled: [...new Set([...(savedSettings?.seenBundled ?? []), ...bundledIds])],
      }

      // A profile from before this redesign may carry a pre-redesign door
      // (or nothing at all) instead of the one remaining control — migrate on
      // every load, not just once behind the schema gate: cheap, and a no-op
      // on an already-current value, so this never needs its own version
      // bump to keep working. Only seeds `breakIntoScenes` when the profile
      // has never set it directly (an operator's own later choice must win
      // over a stale door value on every subsequent load).
      if (savedSettings?.breakIntoScenes === undefined) {
        merged.breakIntoScenes = migrateBreakIntoScenes(savedSettings?.studioMode, savedSettings?.planFirst).breakIntoScenes
      }

      // Settings persist per browser, so raising a default only reaches people
      // who have never opened the app. Anyone already carrying the old 4096
      // ceiling needs it lifted explicitly — once, without stamping on a limit
      // they set deliberately later.
      if ((savedSettings?.schema ?? 1) < SETTINGS_SCHEMA) {
        // Every previous default was a fixed ceiling, and each one truncated
        // something eventually. Move anyone still carrying one to no limit;
        // it is a ceiling, so removing it cannot make an answer worse.
        merged.maxTokens = DEFAULT_SETTINGS.maxTokens
        // Older versions stored a full copy of every stage template, which
        // pinned each browser to the prompts shipped on the day it first ran.
        // Drop them so the current ones apply; overrides made from here on are
        // stored individually and survive.
        merged.stageTemplates = {}
        merged.schema = SETTINGS_SCHEMA
      }
      // Nothing selected yet — start with each skill's primary document, which
      // is the useful default and keeps the first context small.
      if (!savedSettings && stored.length) {
        const sel: Selection = {}
        for (const s of stored) {
          const primary = s.files.find((f) => /^SKILL\.md$/i.test(f.rel)) ?? s.files[0]
          if (primary && /h3-(direction|prompting)/.test(s.id)) sel[s.id] = [primary.rel]
        }
        merged.selection = sel
      }

      const savedEndpoints = await idb.get<ComfyEndpoint[]>('settings', 'comfyEndpoints')
      if (savedEndpoints?.length) setEndpointsState(savedEndpoints)

      // A refresh starts clean. The draft, its passes, the film context, the
      // plates and the clips are all WORK, and work that reappears by itself
      // is work you have to remember to throw away before you can trust what
      // is on the page. Only the CONFIGURATION persists: settings, providers,
      // skills and endpoints. Whatever an earlier visit wrote is cleared here
      // rather than merely ignored, so nothing lingers on disk. The retired
      // `recipes` store itself is dropped one layer down, in `db.ts`'s own
      // upgrade migration — never recreated here.
      await Promise.all([idb.clear('sessions'), idb.clear('plates'), idb.clear('clips')])

      setSkills(stored)
      setSettings(merged)
      setProvidersState(savedProviders)
      setReady(true)
    })().catch((e) => {
      setError(String((e as Error).message || e))
      setReady(true)
    })
  }, [])

  // Fetch the shipped Master Extender workflow once — a plain fixed asset.
  // Never throws: a missing/malformed asset just leaves the path unavailable
  // (`extenderReady: false`).
  useEffect(() => {
    let live = true
    void fetch(new URL('workflows/minimax_h3_master_extender_api.json', document.baseURI).toString(), { cache: 'no-cache' })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status}`))))
      .then((text) => {
        if (live) setExtenderGraph(parseWorkflow(text))
      })
      .catch(() => {
        /* stays null — extenderReady:false says so in the UI */
      })
    return () => {
      live = false
    }
  }, [])

  // ── persist ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (ready) void idb.set('settings', 'settings', settings)
  }, [ready, settings])


  // ── the cached context layer ──────────────────────────────────────────
  useEffect(() => {
    let live = true
    void buildContext(skills, settings.selection).then((c) => {
      if (live) setContext(c)
    })
    return () => {
      live = false
    }
  }, [skills, settings.selection])

  // ── probe every provider once at boot, then on demand ─────────────────
  const refreshProbe = useCallback(
    async (id: string) => {
      const p = providers.find((x) => x.id === id)
      if (!p) return
      setProbes((prev) => ({ ...prev, [id]: { state: 'probing', detail: '', models: [], at: Date.now() } }))
      const result = await probe(p)
      setProbes((prev) => ({ ...prev, [id]: result }))
    },
    [providers],
  )

  useEffect(() => {
    if (!ready) return
    for (const p of providers) void refreshProbe(p.id)
    // Probing is cheap and only runs when the provider list itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, providers.map((p) => `${p.id}:${p.baseUrl}:${p.apiKey ? 1 : 0}`).join('|')])

  // ── derived ───────────────────────────────────────────────────────────
  const current = useMemo(
    () => session.versions.find((v) => v.id === session.currentId) ?? session.versions[session.versions.length - 1] ?? null,
    [session],
  )

  const findings = useMemo(() => {
    // The rules describe a prompt. Run them on the prompt — not on a direction
    // sheet, not on critique notes (which are prose about a prompt and will
    // "fail" every structural rule they are measured against), and not on the
    // explanation that now rides alongside a draft/revise/freeform reply —
    // splitReply pulls the prompt out from under the markers first.
    if (streaming?.text) return PROMPT_STAGES.has(streaming.stage) ? lint(splitReply(streaming.text).prompt, settings.mode) : []
    if (current && PROMPT_STAGES.has(current.stage)) return lint(current.text, settings.mode)
    const lastPrompt = [...session.versions].reverse().find((v) => PROMPT_STAGES.has(v.stage))
    if (lastPrompt) return lint(lastPrompt.text, settings.mode)
    return looksLikePrompt(session.story) ? lint(session.story, settings.mode) : []
  }, [current, streaming, settings.mode, session.story, session.versions])

  // ── actions ───────────────────────────────────────────────────────────
  const patchSettings = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])
  const setBreakIntoScenes = useCallback((v: boolean) => patchSettings({ breakIntoScenes: v }), [patchSettings])

  const setStory = useCallback((story: string) => {
    // HAZARD 2 (2026-09-16 brief): typing into the composer while pipeline
    // authoring is in flight must win the race, not lose it to whatever the
    // background draft writes back a moment later — see
    // `abortPipelineAuthoring`. Cheap on every keystroke: a null ref is a
    // single property read, and the abort only does real work the one time
    // it is actually needed.
    if (pipelineAuthoringRef.current) void abortPipelineAuthoringRef.current()
    setSession((s) => ({ ...s, story }))
  }, [])

  const setFilm = useCallback((f: Partial<FilmContext>) => {
    setSession((s) => ({ ...s, film: { ...DEFAULT_FILM, ...s.film, ...f } }))
    // Also update the ref synchronously. A caller that sets the film and
    // immediately calls run() (the clip plan's "Direct this clip") must not
    // have run() read sessionRef.current before React has flushed the state
    // update above — run() takes its snapshot the instant it is called.
    sessionRef.current = { ...sessionRef.current, film: { ...DEFAULT_FILM, ...sessionRef.current.film, ...f } }
  }, [])

  const toggleSkill = useCallback((skill: Skill) => {
    setSettings((s) => {
      const sel = { ...s.selection }
      const active = sel[skill.id]?.length
      if (active) delete sel[skill.id]
      else {
        const primary = skill.files.find((f) => /^SKILL\.md$/i.test(f.rel)) ?? skill.files[0]
        sel[skill.id] = primary ? [primary.rel] : []
      }
      return { ...s, selection: sel }
    })
  }, [])

  const toggleFile = useCallback((skill: Skill, rel: string) => {
    setSettings((s) => {
      const sel = { ...s.selection }
      const files = new Set(sel[skill.id] || [])
      if (files.has(rel)) files.delete(rel)
      else files.add(rel)
      if (files.size) sel[skill.id] = [...files]
      else delete sel[skill.id]
      return { ...s, selection: sel }
    })
  }, [])

  const addSkills = useCallback(async (incoming: Skill[]) => {
    setSkills((prev) => {
      const byId = new Map(prev.map((s) => [s.id, s]))
      for (const s of incoming) byId.set(s.id, s)
      return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
    })
    for (const s of incoming) await saveSkill(s)
  }, [])

  const deleteSkill = useCallback(async (id: string) => {
    await removeSkill(id)
    setSkills((prev) => prev.filter((s) => s.id !== id))
    setSettings((s) => {
      const sel = { ...s.selection }
      delete sel[id]
      return { ...s, selection: sel }
    })
  }, [])

  const setProviders = useCallback(async (next: Provider[]) => {
    setProvidersState(next)
    await saveProviders(next)
  }, [])

  const appendPromptVersion = useCallback((input: PromptVersionInput): Version | null => {
    const text = input.text.trim()
    if (!text) return null
    const snap = sessionRef.current
    const previous = [...snap.versions].reverse().find((v) => PROMPT_STAGES.has(v.stage))
    const version: Version = {
      id: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      stage: 'freeform',
      label: STAGE_LABEL.freeform,
      text,
      fromText: previous?.text,
      explanation: input.explanation?.trim() || undefined,
      changelog: input.changelog?.filter(Boolean),
      model: settings.model,
      providerId: settings.providerId,
      at: Date.now(),
      ms: 0,
      note: input.note,
      clipIndex: input.clipIndex ?? snap.film?.clipIndex,
    }
    const next = { ...snap, versions: [...snap.versions, version], currentId: version.id }
    setSession(next)
    sessionRef.current = next
    return version
  }, [settings.model, settings.providerId])

  const setBreakdown = useCallback((breakdown: Breakdown) => {
    const next = { ...sessionRef.current, breakdown }
    setSession(next)
    sessionRef.current = next
  }, [])

  /** Set (or clear, with `undefined`) the style LoRAs for the composer's next render. */
  const setLoraStack = useCallback((stack: LoraStackEntry[] | undefined) => {
    const next = { ...sessionRef.current, loraStack: stack }
    sessionRef.current = next
    setSession(next)
  }, [])

  const setClipLoraStack = useCallback((clipIndex: number, stack: LoraStackEntry[] | undefined) => {
    const b = sessionRef.current.breakdown
    if (!b) return
    setBreakdown({ ...b, clips: b.clips.map((c) => (c.index === clipIndex ? { ...c, loraStack: stack } : c)) })
  }, [setBreakdown])

  /** A fresh Break down pass builds entirely new BreakdownClip objects
   * (`parseBreakdown`), which would otherwise silently discard any
   * style-stack an operator had already set on a clip at that index — the
   * same "never silently discard a recorded choice" contract this file
   * already keeps for a rendered scene's prompt/frames/steps/seed. */
  const carryLoraStacksInto = useCallback((fresh: Breakdown | null, prior: Breakdown | undefined): Breakdown | null => {
    if (!fresh || !prior) return fresh
    return { ...fresh, clips: fresh.clips.map((c) => ({ ...c, loraStack: prior.clips.find((p) => p.index === c.index)?.loraStack })) }
  }, [])

  const selectVersion = useCallback((id: string) => setSession((s) => ({ ...s, currentId: id })), [])

  const cancel = useCallback(() => {
    const thought = interruptedReasoningText(streaming?.reasoning ?? '')
    if (thought) setInterruptedReasoning(thought)
    continuationAbortRef.current?.abort()
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(null)
  }, [streaming?.reasoning])

  /**
   * Abort any in-flight PIPELINE (background) authoring and wait for the GPU
   * mutex it holds to actually release, before the operator's own action —
   * Replace, Continue, or typing into the composer — proceeds. HAZARD 2,
   * 2026-09-16 brief: a plain `cancel()` only asks the request to stop; the
   * mutex is not free until `run()`'s own `finally` runs `endGpuUse()`, which
   * happens on the NEXT tick once the abort actually rejects the in-flight
   * fetch — so this awaits the tracked job rather than firing the abort and
   * continuing, or the caller's own `beginGpuUse('llm')`/`('render')` could
   * still lose the race and surface a spurious "already busy" error instead
   * of just... going next.
   */
  const abortPipelineAuthoring = useCallback(async () => {
    const inFlight = pipelineAuthoringRef.current
    if (!inFlight) return
    cancel()
    try {
      await inFlight
    } catch {
      // Aborted — exactly what was asked for.
    }
  }, [cancel])
  abortPipelineAuthoringRef.current = abortPipelineAuthoring

  const run = useCallback(
    async (stage: StageId, note?: string, override?: RunContextOverride): Promise<Version | null> => {
      const snap = sessionRef.current
      const cur = snap.versions.find((v) => v.id === snap.currentId) ?? snap.versions[snap.versions.length - 1] ?? null
      const provider = providers.find((p) => p.id === settings.providerId)
      if (!provider) {
        setError('Pick a provider first.')
        return null
      }
      if (!settings.model) {
        setError('Pick a model first.')
        return null
      }

      // Stages after Direct work on a document. Usually that is the previous
      // pass — but when someone pastes a finished prompt and asks for a
      // critique straight away, the source IS the document. Without this the
      // template's PROMPT section went out empty and the model was asked to
      // audit nothing.
      // Each stage wants a particular KIND of document, not simply whichever
      // pass ran last. Feeding it `current` blindly meant that after Critique,
      // Revise received the critique prose in the slot labelled PROMPT — and
      // never saw the prompt at all.
      const lastOf = (st: StageId) => [...snap.versions].reverse().find((v) => v.stage === st) ?? null
      const lastPrompt = () => [...snap.versions].reverse().find((v) => PROMPT_STAGES.has(v.stage)) ?? null

      const sourceStory = override?.story ?? snap.story
      // The composer's TEXT decides the authoring contract — no door is
      // picked up front any more. See `lib/entry.ts`'s module comment.
      const contentAuthoringMode = override?.studioMode ?? authoringModeForContent(classifyInput(sourceStory).kind, breakIntoScenes)
      const clipIndex = override?.clipIndex ?? override?.film?.clipIndex ?? snap.film?.clipIndex
      // Scene's film context describes the hand-off state, but the previous
      // canonical prompt is equally important to Direct: it shows the model
      // exactly what produced that state. Continuation explicitly supplies
      // parentPrompt; planned clips derive it from earlier canonical passes.
      const previousPrompt = override?.previous ?? snap.parentPrompt ?? previousPromptForClip(snap.versions, clipIndex)
      let working: string
      if (stage === 'direct' || stage === 'breakdown') {
        working = ''
      } else if (override?.current !== undefined) {
        working = override.current
      } else if (stage === 'draft') {
        // Prefer a direction sheet — the one you are reading, else the latest.
        working = (cur?.stage === 'direct' ? cur.text : lastOf('direct')?.text) ?? snap.story
      } else {
        // Critique, Revise, Rebuild and a freeform note all operate on the prompt.
        const authoredPrompt = (cur && PROMPT_STAGES.has(cur.stage) ? cur.text : lastPrompt()?.text) ?? ''
        working = promptSourceForAuthoringMode(
          contentAuthoringMode,
          sourceStory,
          authoredPrompt,
          looksLikePrompt(sourceStory),
        )
      }

      if (!sourceStory.trim() && !snap.versions.length) {
        setError('Paste something first.')
        return null
      }
      if (stage !== 'direct' && stage !== 'breakdown' && !working.trim()) {
        setError(
          stage === 'draft'
            ? 'Nothing to draft from yet.'
            : `${STAGE_LABEL[stage]} works on a prompt, and there isn’t one yet. Paste one, or run Draft first.`,
        )
        return null
      }

      // The model's review against the loaded skills is the substance of a
      // revise pass; the deterministic rules are a small mechanical extra.
      const critiqueText = lastOf('critique')?.text ?? ''

      // Each stage gets only the documents it needs — `draft` renders a sheet
      // and wants the FIELD FORMAT, not the directing skill it was already
      // directed with. The cached `context` prop (the whole selection) is only
      // reused when this stage takes the whole selection anyway.
      const stageSelection = selectionForStage(skills, settings.selection, stage)
      const takesEverything = selectionKey(stageSelection) === selectionKey(settings.selection)
      const ctx = takesEverything && context ? context : await buildContext(skills, stageSelection)
      const template = templateFor(settings.stageTemplates, stage)
      // The operator's chosen length, snapped to the renderable grid, stated to the
      // model. Without this the templates ask for timings that "sum to the declared
      // duration" and never declare one — measured 2026-09-11.
      const clipFrames = framesForSeconds(settings.seconds)
      const user = fillTemplateWithDuration(template, {
        duration: durationBlock(settings.seconds, clipFrames),
        story: sourceStory,
        current: working,
        previous: previousPrompt,
        mode: settings.mode,
        film: filmBlock(override?.film ?? snap.film),
        notes: note,
        findings: findings.length ? findingsToText(findings) : undefined,
        critique: critiqueText,
        standing: standingToText(classifyInput(snap.story)),
        plates: platesBlock(plates),
        continuationFrame: continuationFrameBlock(!!snap.continuationFrame),
      })

      // Show the plates, not just describe them. Only a plate added from THIS
      // machine has a dataUrl — one picked from the box is deliberately never
      // round-tripped back, so it contributes its text line only. Images go in
      // the user turn, AFTER the byte-identical system block, so the KV prefix
      // cache still hits; putting them earlier would destroy it.
      const plateImages: ChatContentPart[] =
        provider.supportsVision && SCHEMA_STAGES.has(stage)
          ? plates
              .filter((pl) => pl.kind === 'image' && pl.dataUrl)
              .map((pl) => ({ type: 'image_url' as const, image_url: { url: pl.dataUrl! } }))
          : []

      // The continuation's last-rendered frame rides its OWN session field,
      // never `plates` — see `Session.continuationFrame`'s comment and
      // `withContinuationFrame`. It is appended after the plates (still in
      // the user turn, still after the byte-identical system block), gated
      // on vision support exactly as the plates above are.
      const requestImages: ChatContentPart[] =
        provider.supportsVision && SCHEMA_STAGES.has(stage)
          ? withContinuationFrame(plateImages, snap.continuationFrame)
          : plateImages

      if (!beginGpuUse('llm')) return null

      const ac = new AbortController()
      abortRef.current = ac
      setFailedReasoning(null)
      setInterruptedReasoning(null)
      setStreaming({ stage, text: '', reasoning: '', startedAt: Date.now(), continuations: 0, phase: 'thinking', auto: override?.auto })
      setError(null)

      try {
        const result = await streamChatComplete({
          provider,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          thinkingBudget: resolveThinkingBudget(provider.id, settings.model, settings.thinkingBudgets),
          // Constrain the reply where the deliverable IS the canonical prompt.
          // Direct and Critique produce one undivided document, and Handoff /
          // Breakdown have their own shapes, so they stay free text.
          responseFormat:
            provider.supportsJsonSchema && SCHEMA_STAGES.has(stage) ? h3ResponseFormat(settings.mode) : undefined,
          contextHash: ctx.hash,
          signal: ac.signal,
          // The cached block is always first and byte-identical between calls;
          // everything that varies goes in the user turn after it.
          // The skills stay first and byte-identical so the prefix cache holds;
          // the frame and the thread follow, which is what makes a composer
          // turn a continuation rather than a cold single-shot request.
          messages: [
            { role: 'system', content: buildH3SystemPrompt(ctx, 'studio', contentAuthoringMode) },
            {
              role: 'user',
              content: requestImages.length ? [{ type: 'text' as const, text: user }, ...requestImages] : user,
            },
            ...(stage === 'freeform'
              ? [
                  ...(snap.chat ?? []).map((t) => ({ role: t.role, content: t.text })),
                  { role: 'user' as const, content: note ?? '' },
                ]
              : []),
          ],
          onDelta: (chunk) => setStreaming((s) => (s ? { ...s, text: s.text + chunk, phase: s.phase === 'thinking' ? 'writing' : s.phase } : s)),
          onReasoning: (chunk) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + chunk, phase: s.text ? s.phase : 'thinking' } : s)),
          onContinuation: (round, kind) =>
            setStreaming((s) => (s ? { ...s, continuations: round, phase: kind === 'thinking' ? 'thinking-recovery' : 'continuing' } : s)),
          // A continuation resumes from the last complete line, so the partial
          // one already on the page has to come back off it.
          onRewind: (chars) => setStreaming((s) => (s ? { ...s, text: s.text.slice(0, Math.max(0, s.text.length - chars)) } : s)),
          maxContinuations: continuationBudgetFor(stage),
          retryOnLimit: !isSingleRequestStage(stage),
        })

        if (!result.text.trim()) {
          // Keep the thinking visible — it is the only evidence of what went
          // wrong, and discarding it on failure loses the whole run.
          setFailedReasoning(result.reasoning.trim() || null)
          const chars = result.reasoning.trim().length
          const thinking = chars ? `${chars.toLocaleString()} characters of thinking` : 'nothing'
          const tried = result.continuations
            ? ` ${result.continuations} continuation${result.continuations === 1 ? '' : 's'} were tried and still came back empty.`
            : ''

          if (result.unterminatedThink) {
            throw new Error(
              `The model opened a <think> block and never closed it, so its whole reply (${thinking}) was counted as thinking and no answer came out. That is a model or chat-template quirk rather than a limit — re-running usually clears it.`,
            )
          }
          if (result.finishReason === 'length') {
            throw new Error(
              result.sentLimit
                ? `Cut off at the ${result.sentLimit.toLocaleString()}-token ceiling after ${thinking}, before any answer.${tried} Raise it, or set output length to “No limit” in Settings.`
                : `The model ran out of room after ${thinking}, before writing an answer.${tried} No ceiling was sent from here, so this is the server's own limit — possibly an output cap it enforces on its own side, which cannot be raised from this app — shorten the source or load fewer skill files.`,
            )
          }
          throw new Error(
            chars
              ? `The model produced ${thinking} and then stopped without an answer${result.finishReason ? ` (finish reason: ${result.finishReason})` : ''}. Its thinking is kept above. Re-running usually helps; a smaller skill selection helps more.`
              : `The model returned nothing at all${result.finishReason ? ` (finish reason: ${result.finishReason})` : ''}.`,
          )
        }
        // Break down is off-chain and returns JSON, not a prompt — parse it
        // and record it as its own kind of version rather than falling into
        // the prompt/changelog handling below.
        if (stage === 'breakdown') {
          const parsed = parseBreakdown(result.text)
          const version: Version = {
            id: `v${Date.now().toString(36)}`,
            stage,
            label: STAGE_LABEL[stage],
            text: parsed ? JSON.stringify(parsed, null, 2) : `Could not parse a clip plan from the reply.\n\n${result.text.trim()}`,
            fromText: snap.story || undefined,
            model: settings.model,
            providerId: provider.id,
            at: Date.now(),
            ms: result.ms,
            reasoning: result.reasoning.trim() || undefined,
            tokens: result.usage?.completion ?? estTokens(result.text + result.reasoning),
            tokensEstimated: result.usage?.completion === undefined,
            continuations: result.continuations || undefined,
            truncated: result.truncated || undefined,
            clipIndex,
            auto: override?.auto,
          }
          const carriedBreakdown = carryLoraStacksInto(parsed, sessionRef.current.breakdown) ?? sessionRef.current.breakdown
          const nextSession = {
            ...sessionRef.current,
            versions: [...sessionRef.current.versions, version],
            currentId: version.id,
            breakdown: carriedBreakdown,
          }
          setSession((s) => ({
            ...s,
            versions: [...s.versions, version],
            currentId: version.id,
            breakdown: carriedBreakdown,
          }))
          // A caller may start the next planned clip immediately after this
          // promise resolves, before React has committed the functional state
          // update. Keep the synchronous snapshot just as setFilm() does.
          sessionRef.current = nextSession
          return version
        }

        // A composer turn may simply be a question. Answering it is a valid
        // outcome — forcing every turn to emit a prompt is what made asking
        // one rewrite the document instead of replying.
        if (stage === 'freeform' && !hasPromptBlock(result.text)) {
          const answer = result.text.trim()
          setSession((sn) => ({
            ...sn,
            chat: [
              ...(sn.chat ?? []),
              { role: 'user', text: note ?? '', at: Date.now() },
              { role: 'assistant', text: answer, at: Date.now() },
            ],
          }))
          return null
        }

        // Draft, Revise and freeform are asked for a prompt plus an
        // explanation (and, for Revise/freeform, a changelog); Direct and
        // Critique return one undivided document.
        // A schema-constrained reply carries the sections as fields, so the
        // <<<PROMPT>>>/<<<EXPLANATION>>> markers are neither present nor
        // needed. joinH3Sections returns null on anything incomplete, which
        // falls through to the marker contract rather than letting a partial
        // object replace a good prompt.
        const schemaResult =
          result.schemaHonoured && SCHEMA_STAGES.has(stage) ? joinH3Sections(result.text, settings.mode) : null

        const wantsSplit = stage === 'draft' || stage === 'revise' || stage === 'rebuild' || stage === 'freeform'
        const strictReplacement = stage === 'revise' || stage === 'rebuild'
        const splitResult = schemaResult
          ? { ...schemaResult, changelog: [] as string[] }
          : wantsSplit
          ? strictReplacement
            ? splitPromptReplacement(result.text)
            : splitReply(result.text)
          : { prompt: result.text.trim(), explanation: '', changelog: [] as string[] }
        if (strictReplacement && !schemaResult && !splitResult) {
          // A malformed replacement must never become the new canonical
          // prompt. Keep the prior version untouched and surface the failed
          // contract alongside any model thinking for diagnosis.
          setFailedReasoning(result.reasoning.trim() || null)
          throw new Error('Prompt replacement must include non-empty <<<PROMPT>>> and <<<EXPLANATION>>> blocks.')
        }
        setFailedReasoning(null)
        const { prompt: bodyText, explanation, changelog } = splitResult ?? { prompt: '', explanation: '', changelog: [] as string[] }

        const version: Version = {
          id: `v${Date.now().toString(36)}`,
          stage,
          label: STAGE_LABEL[stage],
          text: bodyText || result.text.trim(),
          fromText: working || undefined,
          explanation: explanation || undefined,
          changelog: changelog.length ? changelog : undefined,
          model: settings.model,
          providerId: provider.id,
          at: Date.now(),
          ms: result.ms,
          reasoning: result.reasoning.trim() || undefined,
          tokens: result.usage?.completion ?? estTokens(result.text + result.reasoning),
          tokensEstimated: result.usage?.completion === undefined,
          note,
          continuations: result.continuations || undefined,
          truncated: result.truncated || undefined,
          clipIndex,
          auto: override?.auto,
        }
        // The composer is the ONE box — a pass that produced a canonical
        // prompt (Draft/Revise/Rebuild/a prompt-bearing freeform note) writes
        // it straight back into the composer's text, so what is on screen
        // and what would render are never two different things. Direct,
        // Critique and Hand-off are not canonical prompts and must never
        // overwrite it — a direction sheet or a critique landing in the
        // composer would silently become the next render payload.
        const nextStory = PROMPT_STAGES.has(stage) ? version.text : sessionRef.current.story
        const nextSession = {
          ...sessionRef.current,
          story: nextStory,
          versions: [...sessionRef.current.versions, version],
          currentId: version.id,
          chat:
            stage === 'freeform'
              ? [
                  ...(sessionRef.current.chat ?? []),
                  { role: 'user' as const, text: note ?? '', at: Date.now() },
                  {
                    role: 'assistant' as const,
                    text: changelog.length ? changelog.map((c) => `- ${c}`).join('\n') : 'Updated the prompt.',
                    at: Date.now(),
                    versionId: version.id,
                  },
                ]
              : sessionRef.current.chat,
        }
        setSession((s) => ({
          ...s,
          story: PROMPT_STAGES.has(stage) ? version.text : s.story,
          versions: [...s.versions, version],
          currentId: version.id,
          chat:
            stage === 'freeform'
              ? [
                  ...(s.chat ?? []),
                  { role: 'user', text: note ?? '', at: Date.now() },
                  {
                    role: 'assistant',
                    text: changelog.length ? changelog.map((c) => `- ${c}`).join('\n') : 'Updated the prompt.',
                    at: Date.now(),
                    versionId: version.id,
                  },
                ]
              : s.chat,
        }))
        // Keep chained calls (notably Generate all prompts) from reading the
        // pre-pass versions while React is still batching the update.
        sessionRef.current = nextSession
        return version
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(String((e as Error).message || e))
        return null
      } finally {
        abortRef.current = null
        setStreaming(null)
        endGpuUse()
      }
    },
    [providers, settings, context, skills, findings, breakIntoScenes, beginGpuUse, endGpuUse],
  )

  const rebuild = useCallback(async (mode?: AuthoringMode, opts?: { auto?: boolean }) => {
    const studioModeOverride = mode ?? authoringModeForContent(classifyInput(sessionRef.current.story).kind, breakIntoScenes)
    if (studioModeOverride === 'prompt') {
      // Prompt Rebuild is its own finite operation. It deliberately does not
      // route through the Scene/Clip Direct → Draft quality sequence.
      await run('rebuild', undefined, { studioMode: 'prompt', auto: opts?.auto })
      return
    }
    // ONE pass. `draft` now works the directing gates internally and writes the
    // prompt from them, so the sheet is no longer generated, returned, and sent
    // straight back in — which cost a second reasoning warm-up, a second round
    // trip, and the sheet's own tokens twice. `direct` remains its own stage
    // for anyone who wants the sheet itself.
    await run('draft', undefined, { studioMode: studioModeOverride, auto: opts?.auto })
  }, [run, breakIntoScenes])

  const reset = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(null)
    setError(null)
    // A new draft is a new writing context. Keep rendered production and
    // configuration, but never let a Scene plan, selected film position, or
    // continuation parent leak into a standalone Clip/Prompt entry.
    const next = clearDraftContext(sessionRef.current)
    setSession(next)
    // run() snapshots this ref synchronously. Keep it aligned with the reset
    // so a fast tab switch and submit cannot send the previous Scene context.
    sessionRef.current = next
    setCurrentClipId(null)
    setContinuation(null)
    setPlates((prev) => prev.filter((p) => p.mode !== 'replaced'))
    setInterruptedReasoning(null)
    setFailedReasoning(null)
  }, [])

  // ── the render loop ───────────────────────────────────────────────────

  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const platesRef = useRef(plates)
  platesRef.current = plates

  const clearReplacedPlates = useCallback(() => {
    const carried = platesRef.current.filter((p) => p.mode !== 'replaced')
    // Keep the ref in sync immediately. A continuation can reach Draft before
    // React paints the state update, and render must never see a stale ending
    // frame from an earlier clip in that gap.
    platesRef.current = carried
    setPlates(carried)
  }, [])

  /** Clear the continuation frame once the draft that used it lands, fails or
   * is cancelled — same reasoning as `clearReplacedPlates` just above: a
   * frame that outlived its one draft call would otherwise ride along into
   * an unrelated later request (e.g. a freeform note typed after a failed
   * continuation, or clip 6's continuation reusing clip 4's frame). */
  const clearContinuationFrame = useCallback(() => {
    const next = { ...sessionRef.current, continuationFrame: undefined }
    sessionRef.current = next
    setSession(next)
  }, [])

  const endpoint = useMemo(
    () => endpoints.find((e) => e.id === settings.comfyEndpointId) ?? endpoints[0] ?? null,
    [endpoints, settings.comfyEndpointId],
  )
  const clip = useMemo(
    () => clips.find((c) => c.id === currentClipId) ?? null,
    [clips, currentClipId],
  )
  const rendering = useMemo(() => clips.find((c) => c.id === renderingId) ?? null, [clips, renderingId])

  const prepareContinuation = useCallback((clipId: string): PreparedContinuation | null => {
    const source = clipsRef.current.find((c) => c.id === clipId)
    if (!source) return null
    // An ordinary continuation always derives nodeId/sceneIndex from
    // `parentClipId` — a stray redo target left over from an earlier,
    // abandoned `redoScene` must not leak into it (see `redoTargetRef`'s
    // module comment).
    redoTargetRef.current = null
    const sourceFilm = source.film ?? DEFAULT_FILM
    const preparedFilm: FilmContext = {
      ...DEFAULT_FILM,
      ...sourceFilm,
      precedes: sourceFilm.precedes || `The audience has just watched clip ${source.index}.`,
      clipIndex: undefined,
    }
    const next = {
      ...sessionRef.current,
      story: `Continue from clip ${source.index}. Preserve its final physical state and advance the unresolved action.`,
      film: preparedFilm,
      parentClipId: source.id,
      parentPrompt: source.prompt,
    }
    setSession(next)
    sessionRef.current = next
    setCurrentClipId(source.id)
    return {
      clipId: source.id,
      clipIndex: source.index,
      prompt: source.prompt,
      film: preparedFilm,
      hasEndingFrame: !!source.lastFrame || !!source.output,
    }
  }, [])

  /**
   * Gates the primary "Make scene N" action — the studio's only render path.
   * Checks the COMPOSER'S text directly (`session.story`), since that is
   * what `renderExtender` actually sends: nothing here gates rendering
   * behind an LLM stage having run.
   */
  const sceneBlockers = useMemo(() => {
    const out: string[] = []
    if (!endpoint) out.push('No ComfyUI endpoint. Add one under “Where it renders”.')
    else if (comfyProbes[endpoint.id] && comfyProbes[endpoint.id].state !== 'ok') {
      out.push(`${endpoint.label} is not reachable — ${comfyProbes[endpoint.id].detail}`)
    }
    if (!extenderGraph) out.push('The Master Extender workflow has not loaded — check public/workflows/minimax_h3_master_extender_api.json.')
    if (!session.story.trim()) out.push('Nothing to render yet — write or paste something in the composer.')
    const jobless = plates.filter((p) => !p.job.trim())
    if (jobless.length) out.push(`${jobless.length} plate(s) have no job written. An unexplained reference drifts.`)
    return out
  }, [endpoint, comfyProbes, extenderGraph, session.story, plates])

  /**
   * The active MASTER EXTENDER film — the currently selected clip's film, or
   * else the most recently touched one in this session. The film so far
   * belongs to the FILM (`filmClip`), never presented as one scene's own
   * clip; each scene's card gets its own work-state label. Computed WITHOUT
   * any overlap-tax accounting: an Extender scene has no overlap tax to pay
   * (see `lib/extender.ts`'s module comment), so
   * `authored === rendered === delivered` for every scene here, always.
   */
  const extenderFilm = useMemo<FilmInfo | null>(() => {
    const nodeId = clip?.extender?.nodeId ?? [...clips].reverse().find((c) => c.extender)?.extender?.nodeId
    if (!nodeId) return null
    const inFilm = clips.filter((c): c is Clip & { extender: NonNullable<Clip['extender']> } => c.extender?.nodeId === nodeId)
    if (!inFilm.length) return null
    const ordered = [...inFilm].sort((a, b) => a.extender.sceneIndex - b.extender.sceneIndex)
    const filmIsRendering = rendering?.extender?.nodeId === nodeId
    const scenes: FilmSceneRow[] = ordered.map((c) => ({
      authored: c.frames ?? 0,
      rendered: c.frames ?? 0,
      delivered: c.frames ?? 0,
      clip: c,
      sceneIndex: c.extender.sceneIndex,
      label: sceneWorkLabel(c.state, filmIsRendering),
    }))
    const totals = cumulativeFilm(scenes, 24)
    return {
      runName: nodeId,
      scenes,
      filmClip: ordered[ordered.length - 1] ?? null,
      totalFrames: totals.frames,
      totalSeconds: totals.seconds,
    }
  }, [clips, clip, rendering])

  /**
   * The clip plan's Master Extender accounting and gate — no frame-overlap
   * accounting to disclose (see `lib/extender.ts`'s module comment).
   * `nodeId` is derived from the breakdown's own timestamp so it stays the
   * SAME across every submit of this plan (TRAP 1) and matches what
   * `renderExtenderPlan` will actually use.
   */
  const extenderPlanPreview = useMemo<ExtenderPlanPreview | null>(() => {
    const b = session.breakdown
    if (!b || !b.clips.length) return null

    const nodeId = `m_${b.at.toString(36)}`
    const plan = b.clips.map((c) => {
      const v = [...session.versions].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
      const validated = !!validatedClipAt(clips, nodeId, c.index)
      return { index: c.index, title: c.title || `clip ${c.index}`, seconds: c.seconds, prompt: v?.text ?? '', validated }
    })

    const issues: string[] = []
    if (!extenderGraph) issues.push('The Master Extender workflow has not loaded — check public/workflows/minimax_h3_master_extender_api.json.')
    for (const p of plan) if (!p.prompt.trim()) issues.push(`Clip ${p.index} has no prompt yet.`)
    const imagePlateCount = plates.filter((p) => p.kind === 'image').length
    if (imagePlateCount > EXTENDER_REF_SLOTS) issues.push(`${imagePlateCount} plates exceeds H3's ${EXTENDER_REF_SLOTS}-reference cap.`)

    return {
      nodeId,
      clips: plan,
      cost: extenderCostEstimate(plan),
      issues,
    }
  }, [session.breakdown, session.versions, clips, plates, extenderGraph])

  const savePlate = useCallback(async (p: Plate) => {
    setPlates((prev) => {
      const i = prev.findIndex((x) => x.id === p.id)
      if (i === -1) return [...prev, p]
      const next = [...prev]
      next[i] = p
      return next
    })
  }, [])

  const addPlate = useCallback(
    async (p: Omit<Plate, 'id' | 'addedAt'>) => {
      await savePlate({ ...p, id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`, addedAt: Date.now() })
    },
    [savePlate],
  )

  const updatePlate = useCallback(
    async (id: string, patch: Partial<Plate>) => {
      const cur = platesRef.current.find((p) => p.id === id)
      if (!cur) return
      // Editing a plate invalidates its upload: the box holds the old bytes
      // under that name, so a changed image must be re-sent before it is cited.
      const next = { ...cur, ...patch }
      if (patch.dataUrl && patch.dataUrl !== cur.dataUrl) delete next.uploaded
      await savePlate(next)
    },
    [savePlate],
  )

  const deletePlate = useCallback(async (id: string) => {
    setPlates((prev) => prev.filter((p) => p.id !== id))
  }, [])

  /** Order IS the <Picture N> numbering, so moving a plate renumbers the clause. */
  const reorderPlate = useCallback(async (id: string, delta: number) => {
    const list = [...platesRef.current]
    const i = list.findIndex((p) => p.id === id)
    const j = i + delta
    if (i === -1 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    const now = Date.now()
    const stamped = list.map((p, k) => ({ ...p, addedAt: now + k }))
    setPlates(stamped)
  }, [])

  const setEndpoints = useCallback(async (next: ComfyEndpoint[]) => {
    setEndpointsState(next)
    await idb.set('settings', 'comfyEndpoints', next)
  }, [])

  const refreshComfyProbe = useCallback(
    async (id: string) => {
      const ep = endpoints.find((e) => e.id === id)
      if (!ep) return
      setComfyProbes((prev) => ({ ...prev, [id]: { state: 'probing', detail: '', models: [], at: Date.now() } }))
      const result = await probeComfy(ep)
      setComfyProbes((prev) => ({ ...prev, [id]: result }))
    },
    [endpoints],
  )

  useEffect(() => {
    if (!ready) return
    for (const e of endpoints) void refreshComfyProbe(e.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, endpoints.map((e) => `${e.id}:${e.baseUrl}`).join('|')])

  // The Master Extender's live turbo LoRA list, fetched alongside the probe
  // above (same "one entry per endpoint" shape) — see `fetchExtenderNodeSchema`.
  useEffect(() => {
    if (!ready) return
    for (const e of endpoints) {
      void fetchExtenderNodeSchema(e).then((schema) => setExtenderNodeSchemas((prev) => ({ ...prev, [e.id]: schema })))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, endpoints.map((e) => `${e.id}:${e.baseUrl}`).join('|')])

  const clipUrl = useCallback(
    (c: Clip) => {
      const ep = endpoints.find((e) => e.id === c.endpointId) ?? endpoint
      return c.output && ep ? viewUrl(ep, c.output) : null
    },
    [endpoints, endpoint],
  )

  const patchClip = useCallback((id: string, patch: Partial<Clip>) => {
    setClips((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)))
  }, [])

  /**
   * Submit the clip plan as ONE Master Extender job — see `Api.renderExtenderPlan`'s
   * module comment and `lib/extender.ts` for the graph-building/guard logic
   * this calls into. The node itself takes the WHOLE plan on every submit
   * (there is no partial-resume equivalent to reach for), so this never
   * splits into per-scene jobs and has no single-scene "redo" branch —
   * `run_mode` is the only shape choice, and it is the caller's (clip_by_clip
   * vs full_batch).
   */
  const renderExtenderPlan = useCallback(
    async (runMode: 'clip_by_clip' | 'full_batch') => {
      setError(null)
      if (!endpoint || !extenderGraph) {
        setError('Pick an endpoint and make sure the Master Extender workflow has loaded first.')
        return
      }
      const b = sessionRef.current.breakdown
      if (!b || !b.clips.length) {
        setError('No clip plan — run Break down first.')
        return
      }

      const nodeId = `m_${b.at.toString(36)}`
      const vs = sessionRef.current.versions
      const plan = b.clips.map((c) => {
        const v = [...vs].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
        return { index: c.index, title: c.title || `clip ${c.index}`, seconds: c.seconds, prompt: v?.text ?? '' }
      })

      // A clip already validated as part of THIS film resends exactly what
      // was recorded when it last rendered — never re-derived from the
      // plan's current (possibly since-edited) prompt/seconds/seed. A clip
      // with no prior render (first submit, or a scene added to the plan
      // after the fact) uses its current prompt/settings, same as a fresh
      // submit.
      const priorFor = (index: number) =>
        clipsRef.current
          .filter((x) => x.extender?.nodeId === nodeId && x.extender.sceneIndex === index && x.state === 'done')
          .sort((a, x) => x.at - a.at)[0]

      const extClips: ExtenderClipInput[] = plan.map((p) => {
        const prior = priorFor(p.index)
        if (prior) {
          return { title: p.title, prompt: prior.prompt, seconds: (prior.frames ?? 0) / 24, seed: prior.seed ?? 42, validated: true }
        }
        // A REDO (`redoPlanClip`) may have left a one-shot keep-seed request
        // for this exact index — see `redoSeedOverridesRef`'s module comment.
        // Consumed here whether or not it was actually set (deleting an
        // absent key is a no-op), so it can never leak into a later,
        // unrelated submit of the same index.
        const overrideKey = `${nodeId}:${p.index}`
        const keptSeed = redoSeedOverridesRef.current[overrideKey]
        delete redoSeedOverridesRef.current[overrideKey]
        return {
          title: p.title,
          prompt: p.prompt,
          seconds: p.seconds,
          seed: redoSeed(keptSeed, keptSeed !== undefined, () => (settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31))),
          validated: false,
        }
      })

      const missing = extClips.filter((c) => !c.prompt.trim())
      if (missing.length) {
        setError(`${missing.length} clip(s) have no prompt yet.`)
        return
      }
      const imagePlates = platesRef.current.filter((p) => p.kind === 'image')
      if (imagePlates.length > EXTENDER_REF_SLOTS) {
        setError(`${imagePlates.length} plates exceeds H3's ${EXTENDER_REF_SLOTS}-reference cap.`)
        return
      }

      if (!beginGpuUse('render')) return

      const jobId = `c${Date.now().toString(36)}`
      const t0 = Date.now()
      const draftClips: Clip[] = plan.map((p, i) => ({
        id: `${jobId}_${p.index}`,
        index: p.index,
        parentId: null,
        state: 'queued',
        prompt: extClips[i].prompt,
        film: sessionRef.current.film,
        plateIds: imagePlates.map((pl) => pl.id),
        endpointId: endpoint.id,
        seed: extClips[i].seed,
        // Approximate — DISPLAY ONLY (the scrubber's tick widths, the
        // "Xs" readouts). The node itself is what turns `seconds` into
        // frames (`duration_to_h3_frames`); this file sends seconds, never
        // frames, on the wire — see `lib/extender.ts`'s module comment.
        frames: Math.round(extClips[i].seconds * 24),
        fps: 24,
        extender: { nodeId, sceneIndex: p.index },
        at: Date.now(),
      }))

      setClips((prev) => [...prev.filter((c) => c.extender?.nodeId !== nodeId), ...draftClips])
      setCurrentClipId(draftClips[draftClips.length - 1]?.id ?? null)
      setRenderingId(draftClips[0]?.id ?? null)
      setExtenderProgress(null)

      const patchFilmClips = (patch: Partial<Clip>) =>
        setClips((prev) => prev.map((c) => (c.extender?.nodeId === nodeId ? { ...c, ...patch } : c)))

      try {
        // Same upload contract as every other render path: a plate already
        // on THIS box (picked, or uploaded by an earlier submit) is cited by
        // name and never sent back to it.
        const extPlates: ExtenderPlate[] = []
        for (const p of imagePlates) {
          if (p.boxFile?.endpointId === endpoint.id) {
            extPlates.push({ filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
            continue
          }
          if (p.uploaded?.endpointId === endpoint.id) {
            extPlates.push({ filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
            continue
          }
          if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
          const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
          extPlates.push(up)
          await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
        }

        const validatedCount = extClips.filter((c) => c.validated).length
        const built = buildExtenderGraph({
          graph: extenderGraph,
          nodeId,
          clips: extClips,
          plates: extPlates,
          runMode,
          overrides: settings.extenderOverrides,
          priorMasterInputs: extenderFrozenRef.current[nodeId],
          validatedCount,
        })
        // What this submit actually sent — the new frozen baseline the NEXT
        // submit of this same film compares against. Recorded only once the
        // submit below actually succeeds (see the end of the try block), so
        // a rejected/failed render never becomes the new baseline.
        const masterInputsUsed = built.graph[nodeId].inputs

        const promptId = await submit(endpoint, built.graph)
        patchFilmClips({ state: 'rendering', promptId })

        let output: Clip['output']
        let lastPreview: ExtenderPreviewInfo | null = null
        for (;;) {
          await new Promise((r) => setTimeout(r, 2500))
          const res = await pollExtender(endpoint, promptId)
          if (res.preview) {
            lastPreview = res.preview
            setExtenderProgress(res.preview)
          }
          if (!res.done) continue
          if (res.failed) throw new Error(res.failed)
          output = res.output
          break
        }

        extenderFrozenRef.current[nodeId] = masterInputsUsed

        // Only the clips the node actually rendered (or served from cache)
        // THIS run are "landed" — `clip_by_clip` mode advances by exactly
        // one, `full_batch` finishes every pending clip. The node's own
        // progress receipt is the source of truth for how many that is; a
        // missing receipt (an older/foreign graph) falls back to "everything
        // asked for landed", which is only wrong for `clip_by_clip` on such a
        // graph and merely optimistic there, never destructive.
        const landedCount = lastPreview?.clip ?? plan.length
        setClips((prev) =>
          prev.map((c) => {
            if (c.extender?.nodeId !== nodeId) return c
            return c.extender.sceneIndex <= landedCount
              ? { ...c, state: 'done', output, ms: Date.now() - t0 }
              : { ...c, state: 'queued' }
          }),
        )
      } catch (e) {
        const msg = e instanceof ExtenderError ? e.message : String((e as Error).message || e)
        patchFilmClips({ state: 'failed', error: msg, ms: Date.now() - t0 })
        setError(msg)
      } finally {
        setRenderingId(null)
        endGpuUse()
      }
    },
    [endpoint, extenderGraph, settings.lockSeed, settings.seed, settings.extenderOverrides, savePlate, beginGpuUse, endGpuUse],
  )

  /**
   * Render the COMPOSER'S current text as ONE Master Extender scene — every
   * earlier scene of this session's film resends exactly what was recorded
   * when IT rendered (`validated: true`), and the new one goes out
   * `validated: false`, via `run_mode: 'clip_by_clip'` — so a film of N
   * clips costs only the last one's render; the node's own validated-clip
   * disk cache serves the rest. Nothing gates this on an LLM stage having
   * run: `session.story` is the one thing on screen, and it is always the
   * render payload, typed, pasted, or authored by "Draft it for me" — see the
   * module comment on `Session`.
   *
   * Which film this joins: the parent clip's `.extender` (set by an earlier
   * `renderExtender`/`renderExtenderPlan` call, via `continueFrom`/
   * `prepareContinuation`) when the current session continues from one;
   * otherwise this STARTS a fresh film at scene 1 with a freshly minted node
   * id — every film needs its own (TRAP 1 in `lib/extender.ts`'s module
   * comment).
   *
   * Continuing from an EARLIER scene, not the newest, discards every scene
   * AFTER the target index out of local state — the Master Extender's own
   * validated-clip cache is a linear prefix, so a scene that no longer
   * follows what actually rendered before it can no longer be trusted as
   * "already sampled" either.
   *
   * This is also where `redoScene` lands: `redoTargetRef` (set only by a
   * redo) is preferred over the ordinary parent-derived nodeId/sceneIndex,
   * so redoing scene 1 of an existing film — no predecessor scene to read a
   * `nodeId` off — still joins that SAME film instead of minting a new one.
   * The seed similarly prefers a redo's one-shot keep-seed override
   * (`redoSeedOverridesRef`) over the ordinary fresh-seed default.
   */
  const renderExtender = useCallback(async () => {
    if (!endpoint || !extenderGraph) {
      setError('Pick an endpoint and make sure the Master Extender workflow has loaded first.')
      return
    }
    const prompt = sessionRef.current.story
    if (!prompt.trim()) {
      setError('Nothing to render — write or paste something in the composer first.')
      return
    }

    const parentId = sessionRef.current.parentClipId ?? null
    const parent = parentId ? clipsRef.current.find((c) => c.id === parentId) : undefined
    const redoTarget = redoTargetRef.current
    const nodeId = redoTarget?.nodeId ?? parent?.extender?.nodeId ?? `m_${Date.now().toString(36)}`
    const sceneIndex = redoTarget?.sceneIndex ?? (parent?.extender?.sceneIndex ?? 0) + 1

    const seedOverrideKey = `${nodeId}:${sceneIndex}`
    const keptSeed = redoSeedOverridesRef.current[seedOverrideKey]
    delete redoSeedOverridesRef.current[seedOverrideKey]
    const seed = redoSeed(keptSeed, keptSeed !== undefined, () => (settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31)))
    const seconds = settings.seconds
    const frames = framesForSeconds(seconds, 24)

    const imagePlates = platesRef.current.filter((p) => p.kind === 'image')
    if (imagePlates.length > EXTENDER_REF_SLOTS) {
      setError(`${imagePlates.length} plates exceeds H3's ${EXTENDER_REF_SLOTS}-reference cap.`)
      return
    }
    if (!beginGpuUse('render')) return

    const id = `c${Date.now().toString(36)}`
    const t0 = Date.now()

    const draft: Clip = {
      id,
      index: clipsRef.current.length + 1,
      parentId,
      state: 'queued',
      prompt,
      film: sessionRef.current.film,
      plateIds: imagePlates.map((p) => p.id),
      endpointId: endpoint.id,
      seed,
      frames,
      fps: 24,
      extender: { nodeId, sceneIndex },
      at: Date.now(),
    }
    // Drop any existing scene at or after the target index before adding the
    // new one — see the module comment above. A fresh continuation (nothing
    // yet at `sceneIndex`) is a no-op filter, so this is the same append it
    // always was for the common case.
    setClips((prev) => [...dropFromIndex(prev, nodeId, sceneIndex), draft])
    setCurrentClipId(id)
    setRenderingId(id)
    setExtenderProgress(null)

    // HAZARD 1 (2026-09-16 brief): a scene at or before `sceneIndex` being
    // (re)written invalidates a pipeline-authored draft that was written
    // against an OLDER version of it — see `dropInvalidatedAutoDraft`'s
    // module comment. Writing AT `sceneIndex` itself (rendering the draft as
    // the operator found it, or overwriting it with something fresh) is
    // ordinary consumption, never a discard.
    const draftGate = dropInvalidatedAutoDraft(sessionRef.current.versions, sessionRef.current.pendingAutoDraft, sceneIndex)
    if (draftGate.discarded) {
      const withoutStaleDraft = { ...sessionRef.current, versions: draftGate.versions, pendingAutoDraft: undefined }
      sessionRef.current = withoutStaleDraft
      setSession(withoutStaleDraft)
    }

    // Every earlier scene of THIS film resends exactly what was recorded
    // when IT rendered — never re-derived from whatever settings happen to
    // be current now. Scoped to `sceneIndex < target` (not merely "same
    // nodeId") so continuing from an EARLIER scene never resends a later
    // one that is about to be discarded above.
    const priorClips = clipsRef.current
      .filter(
        (c): c is Clip & { extender: NonNullable<Clip['extender']> } =>
          c.extender?.nodeId === nodeId && c.extender.sceneIndex < sceneIndex,
      )
      .sort((a, b) => a.extender.sceneIndex - b.extender.sceneIndex)
    const extClips: ExtenderClipInput[] = [
      ...priorClips.map((c) => ({
        title: `Clip ${c.extender.sceneIndex}`,
        prompt: c.prompt,
        seconds: (c.frames ?? 0) / 24,
        seed: c.seed ?? 0,
        validated: true,
      })),
      { title: `Clip ${sceneIndex}`, prompt, seconds, seed, validated: false },
    ]

    let landed = false
    try {
      // Same upload contract as `renderExtenderPlan`: a plate already on
      // THIS box (picked, or uploaded by an earlier clip) is cited by name
      // and never sent back.
      const extPlates: ExtenderPlate[] = []
      for (const p of imagePlates) {
        if (p.boxFile?.endpointId === endpoint.id) {
          extPlates.push({ filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
          continue
        }
        if (p.uploaded?.endpointId === endpoint.id) {
          extPlates.push({ filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
          continue
        }
        if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
        const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
        extPlates.push(up)
        await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
      }

      const built = buildExtenderGraph({
        graph: extenderGraph,
        nodeId,
        clips: extClips,
        plates: extPlates,
        runMode: 'clip_by_clip',
        overrides: settings.extenderOverrides,
        priorMasterInputs: extenderFrozenRef.current[nodeId],
        validatedCount: priorClips.length,
      })
      const masterInputsUsed = built.graph[nodeId].inputs

      const promptId = await submit(endpoint, built.graph)
      patchClip(id, { state: 'rendering', promptId })

      let output: Clip['output']
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500))
        const res = await pollExtender(endpoint, promptId)
        if (res.preview) setExtenderProgress(res.preview)
        if (!res.done) continue
        if (res.failed) throw new Error(res.failed)
        output = res.output
        break
      }

      extenderFrozenRef.current[nodeId] = masterInputsUsed

      const donePatch = { state: 'done' as const, output, ms: Date.now() - t0 }
      patchClip(id, donePatch)
      // `patchClip` queues a `setClips` update that React has not necessarily
      // flushed by the time the finally block below reads `clipsRef.current`
      // (a background `continueFrom` call reads it synchronously) — mirror it
      // the same way `setFilm`'s own comment does for `sessionRef`.
      clipsRef.current = clipsRef.current.map((c) => (c.id === id ? { ...c, ...donePatch } : c))
      // The composer is always "the next thing": once a scene lands, this
      // scene becomes the implicit predecessor for whatever gets typed next,
      // and the box clears so last scene's text is never mistaken for the
      // next one's. An explicit Continue-from-here on a DIFFERENT scene
      // overrides this the moment it is pressed.
      const advanced = { ...sessionRef.current, story: '', parentClipId: id, parentPrompt: prompt }
      setSession(advanced)
      sessionRef.current = advanced
      // This scene's own `.extender` (just recorded on `donePatch`/the draft
      // itself) is now the correct source for the NEXT render's nodeId — a
      // redo's one-shot override has done its job and must not outlive it.
      redoTargetRef.current = null
      landed = true
    } catch (e) {
      const msg = e instanceof ExtenderError ? e.message : String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
      endGpuUse()
      // Task 1, 2026-09-16: begin authoring the next clip's draft the
      // instant this one lands, so it is on the page by the time the
      // operator has finished watching it — see `authorNextAfterLanding`.
      // Fires only AFTER `endGpuUse()` above, never before — `run()`'s own
      // `beginGpuUse('llm')` must find the box idle, not still marked
      // 'render' from this call.
      if (landed) void authorNextAfterLandingRef.current({ clipId: id, sceneIndex })
    }
  }, [endpoint, extenderGraph, settings.lockSeed, settings.seed, settings.seconds, settings.extenderOverrides, patchClip, savePlate, beginGpuUse, endGpuUse])

  const selectClip = useCallback((id: string) => setCurrentClipId(id), [])

  /** How many scenes of the clip's film, from `fromIndex` on, currently
   * exist — see the module comment on `Api.scenesFrom`. */
  const scenesFrom = useCallback((clipId: string, fromIndex: number): number => {
    const target = clipsRef.current.find((c) => c.id === clipId)
    const nodeId = target?.extender?.nodeId
    if (!nodeId) return 0
    return countFromIndex(clipsRef.current, nodeId, fromIndex)
  }, [])

  /**
   * See `Api.redoScene`'s module comment. Reached from scene N's OWN card
   * (`ScenesStrip`'s "Redo this scene"), not its predecessor's — the
   * difference from an ordinary "Continue from here" click on scene N-1 is
   * only WHAT the composer is loaded with: that scene's own already-rendered
   * prompt, ready to resubmit as-is or edited, rather than a fresh
   * "Continue from clip N-1…" scaffold. Everything downstream — the
   * predecessor-as-parent selection, the discard-count warning, the actual
   * drop-and-resubmit — is `renderExtender`'s existing, unmodified machinery.
   */
  const redoScene = useCallback((clipId: string, opts?: { keepSeed?: boolean }) => {
    const target = clipsRef.current.find((c) => c.id === clipId)
    if (!target?.extender) return
    const { nodeId, sceneIndex } = target.extender

    const key = `${nodeId}:${sceneIndex}`
    if (opts?.keepSeed) redoSeedOverridesRef.current[key] = target.seed ?? 0
    else delete redoSeedOverridesRef.current[key]

    redoTargetRef.current = { nodeId, sceneIndex }
    const parent = clipsRef.current.find((c) => c.extender?.nodeId === nodeId && c.extender.sceneIndex === sceneIndex - 1) ?? null

    const next: Session = {
      ...sessionRef.current,
      story: target.prompt,
      film: target.film ?? DEFAULT_FILM,
      parentClipId: parent?.id ?? null,
      parentPrompt: parent?.prompt,
    }
    setSession(next)
    sessionRef.current = next
    setCurrentClipId(parent?.id ?? null)
  }, [])

  /**
   * See `Api.redoPlanClip`'s module comment. Unlike `redoScene`, this drops
   * the Clip record(s) immediately rather than deferring to the eventual
   * render call — the ClipPlan panel has no per-scene render call to defer
   * to (`renderExtenderPlan` always takes the whole plan), so the drop has
   * to happen here for `extenderPlanPreview`'s cost line to show the right
   * resample/cache split BEFORE the operator presses either of its two
   * render buttons. This is still not "sending" anything: no ComfyUI job
   * exists until one of those buttons is pressed next.
   */
  const redoPlanClip = useCallback((index: number, opts?: { keepSeed?: boolean }) => {
    const b = sessionRef.current.breakdown
    if (!b) return
    const nodeId = `m_${b.at.toString(36)}`
    const key = `${nodeId}:${index}`

    if (opts?.keepSeed) {
      const prior = validatedClipAt(clipsRef.current, nodeId, index)
      if (prior) redoSeedOverridesRef.current[key] = prior.seed ?? 0
    } else {
      delete redoSeedOverridesRef.current[key]
    }

    setClips((prev) => dropFromIndex(prev, nodeId, index))
  }, [])

  /**
   * Close the loop end to end.
   *
   * ONE model call now, not three (2026-09-16, "perf: a continuation is one
   * model call, and it can see the frame it continues from"). This used to
   * run Hand-off — read the parent clip's prompt, write a fresh paraphrase of
   * its ending state — then Direct, then Draft. Hand-off's paraphrase was
   * never new information: `{{previous}}` already hands Draft the parent's
   * own canonical prompt, and that prompt's final `[Shot N]` block already
   * states the ending state explicitly. And Draft's own template already
   * directs-then-drafts in one pass for every other entry point through this
   * app (commit ded83fa) — continuation alone was still paying for a separate
   * Direct call. See `authorContinuation` and `continuationSource` in
   * `lib/entry.ts` for the two halves of this cut.
   *
   * What replaces the accuracy Hand-off used to buy by re-deriving the end
   * state in prose: the parent clip's actual last RENDERED frame, extracted
   * below and handed to Draft as a vision input (never a plate — see "NO
   * LAST-FRAME PLATE"). The rendered parent clip remains in the filmstrip and
   * carries the parent prompt, plates, seed and film context into render.
   */
  const continueFrom = useCallback(
    async (clipId: string, note?: string, opts?: { auto?: boolean }) => {
      const c = clipsRef.current.find((x) => x.id === clipId)
      if (!c) return
      // Same reasoning as `prepareContinuation` above — this is an ordinary
      // continuation, never a redo, so any leftover redo target is stale.
      redoTargetRef.current = null
      const url = clipUrl(c)
      if (!url && !c.lastFrame) {
        setError('That clip has no file yet.')
        return
      }

      // HAZARD 2 (2026-09-16 brief): a MANUAL Continue must preempt any
      // pipeline (background) authoring already in flight, rather than lose
      // the race to it. Skipped when THIS call IS the background job
      // (`opts.auto`) — `abortPipelineAuthoring` awaits the very promise this
      // call itself is running as, which would deadlock.
      if (!opts?.auto) await abortPipelineAuthoring()

      // Continuation has work to cancel before the model is called: frame
      // extraction is asynchronous. Abort any stale run before installing
      // this run's controller so Stop/Escape always targets the active
      // action.
      continuationAbortRef.current?.abort()
      const controller = new AbortController()
      continuationAbortRef.current = controller
      const isCancelled = () => controller.signal.aborted
      const markCancelled = (phase: ContinuationPhase, source?: string) => {
        clearReplacedPlates()
        clearContinuationFrame()
        setContinuation({ clipId, phase, state: 'cancelled', source })
      }

      try {
      setError(null)
      setContinuation({ clipId, phase: 'frame', state: 'running' })
      // NO LAST-FRAME PLATE. This used to extract the previous clip's final
      // frame and add it as a `replaced` plate so the next clip had something
      // to continue from. The Master Extender makes that redundant and
      // slightly harmful: the node already carries its own motion context
      // (`context_length`) plus identity continuity across validated clips
      // — a still image is a strictly weaker version of what its own
      // continuity already provides, and it burned one of H3's nine
      // reference slots on every continuation. Any earlier extracted frame
      // is dropped here so a stale one cannot be cited by the next prompt.
      const staleFrames = platesRef.current.filter((p) => p.mode === 'replaced')
      if (staleFrames.length) {
        const kept = platesRef.current.filter((p) => p.mode !== 'replaced')
        platesRef.current = kept
        setPlates(kept)
      }

      if (isCancelled()) {
        markCancelled('frame')
        return
      }

      // The frame Draft actually gets to SEE — a vision input carried on its
      // own `Session.continuationFrame` field (never `plates`; see above and
      // `withContinuationFrame`). Best-effort: a tainted canvas or a box
      // without CORS must not block the turn, so a failure here authors
      // without the frame and surfaces a quiet note instead of failing the
      // whole continuation.
      let frame: string | undefined
      if (url) {
        try {
          frame = await lastFrameOf(url, controller.signal)
        } catch (e) {
          if (isCancelled() || (e as Error).name === 'AbortError') {
            markCancelled('frame')
            return
          }
          setError(`Could not read the previous clip's last frame — authoring without it (${(e as Error).message}).`)
        }
      }

      // A user may have selected an older clip before pressing Continue. The
      // next source must read that clip's stored film context, never the
      // session's currently selected pass.
      const previousSession = sessionRef.current
      const sourceFilm = c.film ?? previousSession.film
      // The breakdown already decided what the NEXT clip covers and what it
      // precedes/follows — that is exactly what Hand-off used to re-derive
      // in prose. Look it up by the next clip's plan index rather than
      // asking a model to state it again.
      const planClip = previousSession.breakdown?.clips.find(
        (bc) => bc.index === (sourceFilm?.clipIndex ?? c.index) + 1,
      )
      const nextSource = continuationSource(note, { covers: planClip?.covers, spine: sourceFilm?.spine })

      if (isCancelled()) {
        markCancelled('frame', nextSource)
        return
      }
      const nextSession: Session = {
        story: nextSource,
        versions: previousSession.versions,
        currentId: previousSession.currentId,
        chat: [],
        parentClipId: clipId,
        parentPrompt: c.prompt,
        film: {
          ...DEFAULT_FILM,
          ...sourceFilm,
          role: nextRole(sourceFilm?.role ?? 'standalone'),
          precedes: planClip?.precedes || sourceFilm?.precedes || '',
          follows: planClip?.follows || sourceFilm?.follows || '',
        },
        breakdown: previousSession.breakdown,
        continuationFrame: frame,
      }
      // `run()` snapshots sessionRef synchronously. Keep it in lockstep with
      // the state update so Draft starts from the new source/frame rather
      // than the old prompt during this same async turn.
      setSession(nextSession)
      sessionRef.current = nextSession
      setCurrentClipId(clipId)

      setContinuation({ clipId, phase: 'draft', state: 'running', source: nextSource, auto: opts?.auto })
      let authoredVersion: Version | null = null
      let authored: 'ready' | 'aborted'
      try {
        authored = await authorContinuation(async (stage) => {
          if (isCancelled()) return null
          const v = await run(stage, undefined, { studioMode: 'story', auto: opts?.auto })
          authoredVersion = v
          return v
        }, isCancelled)
      } catch (e) {
        // `run()` normally turns provider failures into null, but preserve an
        // unexpected failure as a visible error and a failed receipt too.
        const message = String((e as Error).message || e)
        setError(message)
        clearContinuationFrame()
        setContinuation({ clipId, phase: 'draft', state: 'failed', source: nextSource, auto: opts?.auto })
        return
      }
      clearContinuationFrame()
      if (isCancelled()) {
        setContinuation({ clipId, phase: 'draft', state: 'cancelled', source: nextSource, auto: opts?.auto })
        return
      }
      if (authored !== 'ready') {
        setContinuation({ clipId, phase: 'draft', state: 'failed', source: nextSource, auto: opts?.auto })
        return
      }
      // Track the freshly-authored, not-yet-rendered draft so a later
      // Continue on its own parent (or anything earlier) can find and
      // discard it — see HAZARD 1 and `dropInvalidatedAutoDraft`. Scoped
      // to `opts.auto`: a MANUAL continuation was the operator's own request,
      // never silently discarded by this mechanism.
      if (opts?.auto && authoredVersion) {
        const pendingSceneIndex = (c.extender?.sceneIndex ?? c.index) + 1
        const withPending = {
          ...sessionRef.current,
          pendingAutoDraft: { versionId: (authoredVersion as Version).id, sceneIndex: pendingSceneIndex },
        }
        sessionRef.current = withPending
        setSession(withPending)
      }
      setContinuation({ clipId, phase: 'ready', state: 'ready', source: nextSource, auto: opts?.auto })
      } catch (e) {
        if (isCancelled() || (e as Error).name === 'AbortError') {
          markCancelled('frame')
        } else {
          const message = String((e as Error).message || e)
          setError(message)
          clearContinuationFrame()
          setContinuation({ clipId, phase: 'draft', state: 'failed' })
        }
      } finally {
        if (continuationAbortRef.current === controller) continuationAbortRef.current = null
      }
    },
    [clearReplacedPlates, clearContinuationFrame, clipUrl, run, abortPipelineAuthoring],
  )

  /**
   * The real implementation behind `authorNextAfterLandingRef` — see that
   * ref's own comment for why this is reached through a ref rather than
   * called directly from `renderExtender`/`renderExtenderPlan`, both defined
   * earlier in this file than `continueFrom`/`rebuild`, which this needs.
   *
   * "The next clip" means two different things depending on whether this
   * session is working a Break-down plan or a manual Continue-from-here
   * chain — see the module comment on `nextPlanClipToAuthor` in `entry.ts`.
   * Tracked through the SAME `pipelineAuthoringRef` HAZARD 2's preemption
   * (Replace / a manual Continue / typing) already reads, so Stop and a race
   * with the operator cancel this exactly the way they cancel a manual
   * continuation.
   */
  const authorNextAfterLanding = useCallback(
    async (landed: { clipId?: string; sceneIndex: number }) => {
      if (!canAutoAuthorNext({ enabled: !!settings.autoAuthorNext, gpuBusy: gpuBusyRef.current })) return
      const breakdown = sessionRef.current.breakdown
      const job: Promise<unknown> = breakdown
        ? (async () => {
            const next = nextPlanClipToAuthor(breakdown, sessionRef.current.versions, landed.sceneIndex)
            if (!next) return
            setFilm({
              role: next.role,
              spine: breakdown.spine,
              precedes: next.precedes,
              follows: next.follows,
              covers: next.covers,
              title: next.title,
              clipIndex: next.index,
            })
            await rebuild('story', { auto: true })
          })()
        : landed.clipId
          ? continueFrom(landed.clipId, undefined, { auto: true })
          : Promise.resolve()
      pipelineAuthoringRef.current = job
      try {
        await job
      } finally {
        if (pipelineAuthoringRef.current === job) pipelineAuthoringRef.current = null
      }
    },
    [settings.autoAuthorNext, setFilm, rebuild, continueFrom],
  )
  authorNextAfterLandingRef.current = authorNextAfterLanding

  /**
   * "Generate the rest" (Task 2, 2026-09-16) — see the module comment on
   * `Api.generateRest`. Wiring plus a gate over two things that already
   * exist: `clipsNeedingPrompt` (the same "has a prompt" notion as
   * everywhere else) drives the authoring loop, and `renderExtenderPlan()`
   * submits the whole plan exactly as the manual "Render every pending clip"
   * button does.
   */
  const generateRest = useCallback(async () => {
    const breakdown = sessionRef.current.breakdown
    if (!breakdown) return
    setError(null)
    for (const c of clipsNeedingPrompt(breakdown, sessionRef.current.versions)) {
      setFilm({
        role: c.role,
        spine: breakdown.spine,
        precedes: c.precedes,
        follows: c.follows,
        covers: c.covers,
        title: c.title,
        clipIndex: c.index,
      })
      await rebuild('story')
      // `rebuild` swallows a provider failure or a Stop into `error`/`null`
      // rather than throwing, so the only way to tell those apart from
      // success is whether this clip actually got a prompt. Stopping here
      // leaves every earlier clip's authoring AND every already-rendered
      // scene untouched — nothing in this loop retries or rewinds.
      if (!latestPromptForClip(sessionRef.current.versions, c.index)) return
    }
    await renderExtenderPlan('full_batch')
  }, [rebuild, renderExtenderPlan, setFilm])

  // The graph's own baked master-node inputs — what the settings panel seeds
  // every control from — with the operator's overrides merged on top for
  // `extenderDefaults`, so the topbar's geometry line reports what will
  // ACTUALLY render (issue #30), never the baked value alone once an
  // override is set.
  const extenderMasterDefaults = useMemo(() => readExtenderMasterInputs(extenderGraph), [extenderGraph])
  const extenderNodeSchema = useMemo(
    () => (endpoint ? extenderNodeSchemas[endpoint.id] ?? null : null),
    [endpoint, extenderNodeSchemas],
  )
  const extenderEffectiveInputs = useMemo(
    () => mergeExtenderInputs(extenderMasterDefaults, settings.extenderOverrides),
    [extenderMasterDefaults, settings.extenderOverrides],
  )
  const extenderDefaults = useMemo(() => extenderGeometryFromInputs(extenderEffectiveInputs), [extenderEffectiveInputs])
  const extenderDefaultLoraStack = useMemo(() => readBakedLoraStack(extenderGraph), [extenderGraph])

  const api: Api = {
    ready,
    skills,
    settings,
    providers,
    probes,
    story: session.story,
    versions: session.versions,
    current,
    streaming,
    chat: session.chat ?? [],
    film: session.film ?? DEFAULT_FILM,
    breakdown: session.breakdown ?? null,
    error,
    failedReasoning,
    interruptedReasoning,
    continuation,
    findings,
    context,
    breakIntoScenes,
    setStory,
    setBreakIntoScenes,
    setFilm,
    patchSettings,
    toggleSkill,
    toggleFile,
    addSkills,
    deleteSkill,
    setProviders,
    refreshProbe,
    run,
    rebuild,
    plates,
    endpoints,
    endpoint,
    comfyProbes,
    clips,
    clip,
    rendering,
    gpuBusy,
    sceneBlockers,
    extenderReady: !!extenderGraph,
    extenderDefaults,
    extenderMasterDefaults,
    extenderNodeSchema,
    extenderDefaultLoraStack,
    extenderPlanPreview,
    extenderFilm,
    extenderProgress,
    renderExtenderPlan,
    addPlate,
    updatePlate,
    deletePlate,
    reorderPlate,
    setEndpoints,
    refreshComfyProbe,
    clipUrl,
    renderExtender,
    redoScene,
    redoPlanClip,
    selectClip,
    scenesFrom,
    continueFrom,
    generateRest,
    pendingAutoDraft: session.pendingAutoDraft ?? null,
    appendPromptVersion,
    setBreakdown,
    setClipLoraStack,
    loraStack: session.loraStack,
    setLoraStack,
    prepareContinuation,
    cancel,
    selectVersion,
    clearError: () => {
      setError(null)
      setFailedReasoning(null)
      setInterruptedReasoning(null)
    },
    notice,
    clearNotice: () => setNotice(null),
    reset,
    beginGpuUse,
    modelLock,
    modelLockLabel: describeModelLock(modelLock),
    endGpuUse,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
