import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, buildH3SystemPrompt, type BuiltContext } from '../lib/context'
import { classifyInput, findingsToText, lint, looksLikePrompt, standingToText } from '../lib/lint'
import { continuationBudgetFor, streamChatComplete } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders, LOCAL_LLM_URL, LOCAL_LLM_MODEL} from '../lib/providers'
import { STAGE_LABEL, fillTemplate, filmBlock, hasPromptBlock, nextRole, parseBreakdown, splitHandoff, splitPromptReplacement, splitReply, templateFor } from '../lib/stages'
import { DEFAULT_ENDPOINTS, lastFrameOf, poll, pollChain, probeComfy, submit, uploadImage, viewUrl } from '../lib/comfy'
import type { PollResult } from '../lib/comfy'
import { applyRecipe, fetchShippedChainRecipes, framesForSeconds, oomRisk, recipeIssues, resolveChainRecipeAutoBind, SHIPPED_SET_VERSION, SHIPPED_CHAIN_IDS} from '../lib/recipe'
import { padForOverlap } from '../lib/frames'
import type { PaddedClip } from '../lib/frames'
import { CHAIN_CONTEXT_LENGTH, ChainError, SINGULARITY_UNET, buildChainGraph, chainIssues, chainMinSteps, chainShotsForPlan, planNeedsPerSceneLoraSplit } from '../lib/chain'
import type { ChainPlate, ChainShot } from '../lib/chain'
import { countFromIndex, dropFromIndex, externalVideoForReplace, scenesBefore, sceneRangeFor } from '../lib/chainEdit'
import { cumulativeFilm, sceneWorkLabel } from '../lib/chainDisplay'
import type { SceneWorkLabel } from '../lib/chainDisplay'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import { estTokens } from '../lib/tokens'
import { appendContinuationHistory, authoringModeForContent, authorContinuation, clearDraftContext, continuationContextOverride, continuationPlateIsFresh, continuationSource, interruptedReasoningText, migrateBreakIntoScenes, previousPromptForClip, promptSourceForAuthoringMode } from '../lib/entry'
import type { AuthoringMode } from '../lib/entry'
import { isSingleRequestStage, type StudioRunPhase } from '../lib/studio-workflow'
import { normalizeThinkingBudgets, resolveThinkingBudget } from '../lib/thinking'
import type {
  Breakdown, ChatTurn, Clip, ClipChainInfo, ComfyEndpoint, FilmContext, Finding, LoraStackEntry, Plate, ProbeResult,
  Provider, Recipe, Selection, Settings, Skill, StageId, Version,
} from '../lib/types'

const SETTINGS_SCHEMA = 6

const DEFAULT_FILM: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '' }

/** Stages whose output is a prompt, as opposed to a direction sheet or notes. */
const PROMPT_STAGES = new Set<StageId>(['draft', 'revise', 'rebuild', 'freeform'])

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
  /** The prompt that produced parentClipId, available to continuation Direct. */
  parentPrompt?: string
  /** The last Break down pass, if the story has been split into clips. */
  breakdown?: Breakdown
  /**
   * Continue an EXISTING video into this session's chain, instead of starting
   * one from nothing — only meaningful while `parentClipId` is unset (a fresh
   * scene 1); a continuation (`prepareContinuation`/`continueFrom`) always
   * starts its own new `Session` object, so this never carries over into one.
   */
  externalVideo?: { endpointId: string; filename: string; prependOriginal: boolean } | null
}

type ContinuationPhase = 'frame' | 'handoff' | 'direct' | 'draft' | 'ready'

interface ContinuationStatus {
  clipId: string
  phase: ContinuationPhase
  state: 'running' | 'ready' | 'failed' | 'cancelled'
  source?: string
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

/** One plan clip's prompt and frame accounting, for the clip plan's chain panel. */
interface ChainPlanPreviewClip extends PaddedClip {
  index: number
  title: string
  prompt: string
  seconds: number
}

interface ChainPlanPreview {
  /** The chain identity every submit of this plan resumes — derived from the
   * breakdown's own timestamp, so the first whole-plan submit and any later
   * single-scene redo land on the same run. */
  runName: string
  clips: ChainPlanPreviewClip[]
  /** Delivered seconds, summed — what the film actually runs. */
  totalSeconds: number
  /** Every blocking problem — same contract as `blockers`. */
  issues: string[]
  /** Non-blocking — an OOM risk at the chosen geometry, named per clip. */
  warnings: string[]
}

/**
 * One scene of a MANUALLY-continued chain (`renderChain`'s Continue-from-a-
 * clip flow, as opposed to the clip-plan's whole-job submit), as the chain
 * flow UI actually shows it: what it delivered against what it was asked for,
 * and what its card should say about its own work state right now.
 */
export interface ChainSceneRow extends PaddedClip {
  clip: Clip
  sceneIndex: number
  label: SceneWorkLabel
}

/**
 * The chain's OWN identity — never a clip's. Fixes the defect measured live
 * 2026-09-06: `renderChain`/`pollChain` store the assembled film as the
 * NEWEST clip's `output` (`studio_chain_smoke.mp4` at 124 frames, then
 * `studio_chain_smoke_001.mp4` at 260 once scene 2 landed), so a clip's OWN
 * card silently plays a cumulative cut that has nothing to do with that one
 * scene. `filmClip` is that same underlying Clip record (its `.output` really
 * is the whole-chain assemble node's output, for every chain job this studio
 * submits — see the module comment on `chainFilm`, below) but the UI must
 * present it as the CHAIN's film, never as scene N's own clip.
 */
export interface ChainFilmInfo {
  runName: string
  /** Ordered by scene, 1-based. */
  scenes: ChainSceneRow[]
  /** The Clip record whose `.output` currently holds the assembled film —
   * the newest scene's, since every render/redo of this chain reassembles
   * the whole thing. Never render this per-scene; it belongs to the chain. */
  filmClip: Clip | null
  totalFrames: number
  totalSeconds: number
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
  rebuild: (mode?: AuthoringMode) => Promise<void>

  // ── the render loop ─────────────────────────────────────────────────
  plates: Plate[]
  recipes: Recipe[]
  recipe: Recipe | null
  /** The Contex-Loop (chain) workflow — a DIFFERENT stored recipe from `recipe`.
   * The studio's only multi-clip render path (Long Media multiclip removed
   * 2026-09-07). */
  chainRecipe: Recipe | null
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
  /** Why a render cannot start yet — empty when it can. */
  blockers: string[]
  /** Non-blocking — an OOM risk at the chosen geometry for the single-clip render. */
  warnings: string[]
  /** Why the primary "Render scene N" action cannot start yet — the chain
   * equivalent of `blockers`, which gates the plain single-clip `render()`
   * path this button no longer uses. Empty when it can render. */
  chainBlockers: string[]
  /** The current clip plan's chain accounting and gate, or null with no plan yet. */
  chainPlanPreview: ChainPlanPreview | null
  /** Delivered/rendered/authored frame accounting for every clip that is part
   * of SOME chain, keyed by `Clip.id` — the one place "how long did this scene
   * actually turn out" is computed, so every place a length is shown (the
   * scene spine, the old clip rail, a clip's own info line) reads the same
   * number. A clip with no `.chain` (the Agent's plain single-clip render)
   * has no entry — its own `frames` already IS what it delivered. */
  sceneAccounting: Record<string, PaddedClip>
  /** The active chain's own identity, scenes and assembled film — see
   * `ChainFilmInfo`'s module comment for the defect this exists to fix. Null
   * until some clip in this session has rendered as part of a chain. */
  chainFilm: ChainFilmInfo | null
  /** End-to-end continuation progress, retained as a receipt once ready or failed. */
  continuation: ContinuationStatus | null
  addPlate: (p: Omit<Plate, 'id' | 'addedAt'>) => Promise<void>
  updatePlate: (id: string, patch: Partial<Plate>) => Promise<void>
  deletePlate: (id: string) => Promise<void>
  reorderPlate: (id: string, delta: number) => Promise<void>
  addRecipe: (r: Recipe) => Promise<void>
  deleteRecipe: (id: string) => Promise<void>
  setEndpoints: (e: ComfyEndpoint[]) => Promise<void>
  refreshComfyProbe: (id: string) => Promise<void>
  clipUrl: (c: Clip) => string | null
  render: () => Promise<void>
  /**
   * Submit the clip plan as a Contex-Loop chain — the only multi-clip render
   * path. With no `sceneIndex`, submits every plan clip fresh in one job.
   * With one, redoes JUST that plan clip: every other clip resends exactly
   * what was recorded for it on an earlier submit of this same plan, and
   * `scene_range` limits sampling to the one scene actually being redone.
   * See the module comment beside its definition.
   */
  renderChainPlan: (sceneIndex?: number) => Promise<void>
  /** Render the composer's current text as one Contex-Loop chain scene — see
   * the module comment beside `renderChain`'s definition for which chain it
   * joins and what gets resent for append-only resume verification.
   * `seedOverride`/`runNameOverride` exist for `replaceScene`, below — a
   * fresh render call never needs either. */
  renderChain: (opts?: { seedOverride?: number; runNameOverride?: string }) => Promise<void>
  selectClip: (id: string) => void
  /** How many scenes of `clip`'s chain, from `fromIndex` on, currently exist —
   * what a Replace or a Continue-from-here targeting `fromIndex` would
   * invalidate (append-only: everything from the target scene on gets
   * discarded and would need re-rendering). Zero when there is nothing to
   * lose. */
  scenesFrom: (clipId: string, fromIndex: number) => number
  /**
   * Replace one already-rendered scene of a chain in place: reloads that
   * scene's own prompt into the composer for editing, resends every scene
   * BEFORE it byte-identically, and resubmits it with a fresh seed by default
   * (same seed + same prompt reproduces the same clip, so a "replace" that
   * does not change the seed changes nothing) — pass `keepSeed` to reuse the
   * original seed instead. A scene-1 replace re-passes the chain's original
   * external-video choice, if it had one. Every scene after the replaced one
   * is invalidated (see `scenesFrom`) — Contex-Loop is append-only, so they
   * no longer resume against a checkpoint that still exists.
   */
  replaceScene: (clipId: string, opts?: { keepSeed?: boolean }) => Promise<void>
  /** Author the next prompt from a landed clip; rendering remains a separate
   * action. Works from ANY clip in a chain, not only the newest — rendering
   * the result (via `renderChain`) then invalidates every scene from its
   * target on, the same append-only consequence `replaceScene` has. */
  continueFrom: (clipId: string, note?: string) => Promise<void>
  /** Append a canonical prompt version without invoking an LLM stage. */
  appendPromptVersion: (input: PromptVersionInput) => Version | null
  /** Save the clip plan without invoking an LLM stage. */
  setBreakdown: (breakdown: Breakdown) => void
  /** Set (or clear, with `undefined`) one plan clip's style-stack selection.
   * Clearing returns it to "whatever the bound Contex-Loop workflow already
   * carries" — see `BreakdownClip.loraStack`'s module comment. */
  setClipLoraStack: (clipIndex: number, stack: LoraStackEntry[] | undefined) => void
  /** Whether the session is about to start a fresh chain at scene 1 — the
   * only time "continue from an existing video" means anything (a
   * continuation always carries its own `parentClipId`). */
  isFreshChainStart: boolean
  /** This session's "continue from an existing video" choice, or null. */
  externalVideo: { endpointId: string; filename: string; prependOriginal: boolean } | null
  /** Style LoRAs chosen for the next composer render; undefined = leave the
   * bound graph's baked stack alone. */
  loraStack: LoraStackEntry[] | undefined
  setExternalVideo: (v: { endpointId: string; filename: string; prependOriginal: boolean } | null) => void
  /** Style LoRAs for the next composer render. Undefined = leave the bound
   * graph's baked stack alone. */
  setLoraStack: (stack: LoraStackEntry[] | undefined) => void
  /** Select a clip and stage its deterministic continuation context. */
  prepareContinuation: (clipId: string) => PreparedContinuation | null
  cancel: () => void
  selectVersion: (id: string) => void
  clearError: () => void
  reset: () => Promise<void>
  /** Claim the GPU mutex for a caller OUTSIDE `run()`/the render paths — the
   * Agent's own LLM loop, which does not go through `run()`. Returns false
   * (and sets `error`) when the box is already held by the other side.
   * Always release with `endGpuUse`. */
  beginGpuUse: (kind: 'llm' | 'render') => boolean
  endGpuUse: () => void
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
  } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const [failedReasoning, setFailedReasoning] = useState<string | null>(null)
  const [interruptedReasoning, setInterruptedReasoning] = useState<string | null>(null)
  const [continuation, setContinuation] = useState<ContinuationStatus | null>(null)
  const [plates, setPlates] = useState<Plate[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [endpoints, setEndpointsState] = useState<ComfyEndpoint[]>(DEFAULT_ENDPOINTS)
  const [comfyProbes, setComfyProbes] = useState<Record<string, ProbeResult>>({})
  const [renderingId, setRenderingId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const continuationAbortRef = useRef<AbortController | null>(null)
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
  const beginGpuUse = useCallback((kind: 'llm' | 'render'): boolean => {
    if (gpuBusyRef.current !== 'idle') {
      setError(
        gpuBusyRef.current === 'render'
          ? 'A render is in flight on the box — wait for it to finish before calling the model. A chat completion fired mid-render gets ComfyUI hard-killed by the gateway (it cannot honour a mid-sample unload cleanly).'
          : 'A model call is in flight — wait for it to finish before starting a render. The gateway single-flights the GPU; starting a render now is refused rather than racing the drain.',
      )
      return false
    }
    gpuBusyRef.current = kind
    setGpuBusyState(kind)
    return true
  }, [])
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

      const [savedRecipes, savedEndpoints] = await Promise.all([
        idb.all<Recipe>('recipes'),
        idb.get<ComfyEndpoint[]>('settings', 'comfyEndpoints'),
      ])

      // Bind the shipped Contex-Loop chain recipes (SLA default, VSA gate
      // selectable) so a fresh profile can render before an operator ever
      // drops a workflow of their own — see `resolveChainRecipeAutoBind` for
      // why this is gated on `chainRecipeAutoBound` rather than on whether
      // `chainRecipeId` itself resolves.
      let recipesForState = savedRecipes
      const bind = await resolveChainRecipeAutoBind(savedRecipes, merged, fetchShippedChainRecipes)
      if (bind) {
        merged.chainRecipeId = bind.chainRecipeId
        merged.chainRecipeAutoBound = bind.chainRecipeAutoBound
        // Recorded whether or not anything was added, so a profile is topped
        // up with a new shipped variant exactly once.
        merged.shippedRecipeSetVersion = SHIPPED_SET_VERSION
        recipesForState = bind.recipes
        for (const r of bind.added) await idb.set('recipes', r.id, r)
      }
      setRecipes(recipesForState.sort((a, b) => a.addedAt - b.addedAt))
      if (savedEndpoints?.length) setEndpointsState(savedEndpoints)

      // A refresh starts clean. The draft, its passes, the film context, the
      // plates and the clips are all WORK, and work that reappears by itself
      // is work you have to remember to throw away before you can trust what
      // is on the page. Only the CONFIGURATION persists: settings, providers,
      // skills, recipes and endpoints. Whatever an earlier visit wrote is
      // cleared here rather than merely ignored, so nothing lingers on disk.
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

  const setStory = useCallback((story: string) => setSession((s) => ({ ...s, story })), [])

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

  /** Set (or clear, with `null`) this session's "continue from an existing
   * video" choice — see `Session.externalVideo`'s module comment. Only ever
   * consumed by `renderChain` while `parentClipId` is unset. */
  const setLoraStack = useCallback((stack: LoraStackEntry[] | undefined) => {
    const next = { ...sessionRef.current, loraStack: stack }
    sessionRef.current = next
    setSession(next)
  }, [])

  const setExternalVideo = useCallback((v: { endpointId: string; filename: string; prependOriginal: boolean } | null) => {
    const next = { ...sessionRef.current, externalVideo: v }
    setSession(next)
    sessionRef.current = next
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

      const ctx = context ?? (await buildContext(skills, settings.selection))
      const template = templateFor(settings.stageTemplates, stage)
      const user = fillTemplate(template, {
        story: sourceStory,
        current: working,
        previous: previousPrompt,
        mode: settings.mode,
        film: filmBlock(override?.film ?? snap.film),
        notes: note,
        findings: findings.length ? findingsToText(findings) : undefined,
        critique: critiqueText,
        standing: standingToText(classifyInput(snap.story)),
      })

      if (!beginGpuUse('llm')) return null

      const ac = new AbortController()
      abortRef.current = ac
      setFailedReasoning(null)
      setInterruptedReasoning(null)
      setStreaming({ stage, text: '', reasoning: '', startedAt: Date.now(), continuations: 0, phase: 'thinking' })
      setError(null)

      try {
        const result = await streamChatComplete({
          provider,
          model: settings.model,
          temperature: settings.temperature,
          maxTokens: settings.maxTokens,
          thinkingBudget: resolveThinkingBudget(provider.id, settings.model, settings.thinkingBudgets),
          contextHash: ctx.hash,
          signal: ac.signal,
          // The cached block is always first and byte-identical between calls;
          // everything that varies goes in the user turn after it.
          // The skills stay first and byte-identical so the prefix cache holds;
          // the frame and the thread follow, which is what makes a composer
          // turn a continuation rather than a cold single-shot request.
          messages: [
            { role: 'system', content: buildH3SystemPrompt(ctx, 'studio', contentAuthoringMode) },
            { role: 'user', content: user },
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
        const wantsSplit = stage === 'draft' || stage === 'revise' || stage === 'rebuild' || stage === 'freeform'
        const strictReplacement = stage === 'revise' || stage === 'rebuild'
        const splitResult = wantsSplit
          ? strictReplacement
            ? splitPromptReplacement(result.text)
            : splitReply(result.text)
          : { prompt: result.text.trim(), explanation: '', changelog: [] as string[] }
        if (strictReplacement && !splitResult) {
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

  const rebuild = useCallback(async (mode?: AuthoringMode) => {
    const studioModeOverride = mode ?? authoringModeForContent(classifyInput(sessionRef.current.story).kind, breakIntoScenes)
    if (studioModeOverride === 'prompt') {
      // Prompt Rebuild is its own finite operation. It deliberately does not
      // route through the Scene/Clip Direct → Draft quality sequence.
      await run('rebuild', undefined, { studioMode: 'prompt' })
      return
    }
    const sheet = await run('direct', undefined, { studioMode: studioModeOverride })
    if (sheet) await run('draft', undefined, { studioMode: studioModeOverride, current: sheet.text })
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
    // Keep the ref in sync immediately. A continuation can reach Direct and
    // Draft before React paints the state update, and render must never see a
    // stale ending frame from an earlier clip in that gap.
    platesRef.current = carried
    setPlates(carried)
  }, [])

  const recipe = useMemo(
    () => recipes.find((r) => r.id === settings.recipeId) ?? recipes[0] ?? null,
    [recipes, settings.recipeId],
  )
  // No fallback to `recipes[0]` here, unlike `recipe` above: a single-clip
  // recipe silently standing in for the Contex-Loop one would build a graph
  // with none of the MiniMaxH3Chain* nodes `buildChainGraph` requires, and
  // `chainIssues` reports that plainly rather than this silently guessing.
  const chainRecipe = useMemo(
    () => recipes.find((r) => r.id === settings.chainRecipeId) ?? null,
    [recipes, settings.chainRecipeId],
  )
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
      // A continuation is never scene 1 — see `Session.externalVideo`'s module comment.
      externalVideo: null,
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

  const lastPromptText = useMemo(() => {
    // Rendering, linting and copying all consume the one canonical prompt.
    // Selecting a prose pass (Direct/Critique) for inspection must not make
    // that prose accidentally become the render payload.
    const selected = session.versions.find((x) => x.id === session.currentId)
    if (selected && PROMPT_STAGES.has(selected.stage)) return selected.text
    const v = [...session.versions].reverse().find((x) => PROMPT_STAGES.has(x.stage))
    return v?.text ?? (looksLikePrompt(session.story) ? session.story : '')
  }, [session.versions, session.currentId, session.story])

  const blockers = useMemo(() => {
    const out: string[] = []
    if (!endpoint) out.push('No ComfyUI endpoint. Add one under “Where it renders”.')
    else if (comfyProbes[endpoint.id] && comfyProbes[endpoint.id].state !== 'ok') {
      out.push(`${endpoint.label} is not reachable — ${comfyProbes[endpoint.id].detail}`)
    }
    out.push(...recipeIssues(recipe))
    if (!lastPromptText.trim()) out.push('No prompt to render yet. Run Draft, or paste one.')
    const jobless = plates.filter((p) => !p.job.trim())
    if (jobless.length) out.push(`${jobless.length} plate(s) have no job written. An unexplained reference drifts.`)
    return out
  }, [endpoint, comfyProbes, recipe, lastPromptText, plates])

  const warnings = useMemo(() => {
    const out: string[] = []
    // Every render now goes through `renderChain`, which builds against
    // `chainRecipe` — never the plain single-clip `recipe` — so the risk
    // check has to read the SAME geometry that would actually be submitted.
    // Checking `recipe` here left this silent for the studio's one real
    // render path whenever no single-clip recipe happened to be bound.
    if (chainRecipe) {
      const width = settings.width ?? chainRecipe.defaults.width
      const height = settings.height ?? chainRecipe.defaults.height
      const frames = framesForSeconds(settings.seconds, 24)
      if (oomRisk(width, height, frames)) {
        out.push(
          `${width}×${height} at ${frames} frames has been measured to OOM — the box runs out of memory around ` +
            `362 frames at this tier, and an OOM takes ComfyUI down and leaves no trace (\`/history\` comes back ` +
            `empty either way). Trade resolution for length, or accept the risk.`,
        )
      }
    }
    return out
  }, [chainRecipe, settings.width, settings.height, settings.seconds])

  /**
   * Gates the primary "Render scene N" action — the chain equivalent of
   * `blockers`, above. Every render now goes through `renderChain`, so this
   * checks `chainRecipe`, never the plain single-clip `recipe` — and checks
   * the COMPOSER'S text directly (`session.story`), since that is what
   * `renderChain` actually sends: nothing here gates rendering behind an
   * LLM stage having run.
   */
  const chainBlockers = useMemo(() => {
    const out: string[] = []
    if (!endpoint) out.push('No ComfyUI endpoint. Add one under “Where it renders”.')
    else if (comfyProbes[endpoint.id] && comfyProbes[endpoint.id].state !== 'ok') {
      out.push(`${endpoint.label} is not reachable — ${comfyProbes[endpoint.id].detail}`)
    }
    if (!chainRecipe) out.push('No Contex-Loop (chain) recipe loaded — drop the chain ComfyUI workflow saved in API format.')
    if (!session.story.trim()) out.push('Nothing to render yet — write or paste something in the composer.')
    const jobless = plates.filter((p) => !p.job.trim())
    if (jobless.length) out.push(`${jobless.length} plate(s) have no job written. An unexplained reference drifts.`)
    if (!session.parentClipId && session.externalVideo && endpoint && session.externalVideo.endpointId !== endpoint.id) {
      out.push(`“Continue from a video” was picked on a different endpoint — switch back to it, or pick the video again on ${endpoint.label}.`)
    }
    return out
  }, [endpoint, comfyProbes, chainRecipe, session.story, plates, session.parentClipId, session.externalVideo])

  /**
   * The clip plan's chain accounting and gate, recomputed on every prompt,
   * plate or geometry change so the frame accounting on screen never lags what
   * a submit would actually build. `runName` is deterministic — derived from
   * the breakdown's own timestamp — so a whole-plan submit and a later
   * single-scene redo always resume the same chain (see `renderChainPlan`).
   */
  const chainPlanPreview = useMemo<ChainPlanPreview | null>(() => {
    const b = session.breakdown
    if (!b || !b.clips.length) return null

    const plan = b.clips.map((c) => {
      const v = [...session.versions].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
      return { index: c.index, title: c.title || `clip ${c.index}`, seconds: c.seconds, prompt: v?.text ?? '' }
    })
    const imagePlateCount = plates.filter((p) => p.kind === 'image').length
    const padded = padForOverlap(plan.map((c) => ({ frames: framesForSeconds(c.seconds, 24) })), CHAIN_CONTEXT_LENGTH)
    const steps = settings.steps ?? chainMinSteps(chainRecipe?.graph)

    const issues = chainIssues({
      graph: chainRecipe?.graph ?? null,
      shots: plan.map((c) => ({ index: c.index, prompt: c.prompt })),
      plateCount: imagePlateCount,
      steps,
    })

    const width = settings.width ?? chainRecipe?.defaults.width ?? 0
    const height = settings.height ?? chainRecipe?.defaults.height ?? 0
    // Check the PADDED (rendered) frame count, not delivered — that is what
    // actually gets sampled and is what VRAM has to hold.
    const warn = plan
      .map((c, i) => (oomRisk(width, height, padded[i].rendered) ? `Clip ${c.index} renders ${padded[i].rendered} frames at ${width}×${height} — measured to OOM at this tier.` : null))
      .filter((x): x is string => x !== null)

    return {
      runName: `plan_${b.at.toString(36)}`,
      clips: plan.map((c, i) => ({ ...c, ...padded[i] })),
      totalSeconds: +(padded.reduce((sum, p) => sum + p.delivered, 0) / 24).toFixed(3),
      issues,
      warnings: warn,
    }
  }, [session.breakdown, session.versions, plates, chainRecipe, settings.steps, settings.width, settings.height])

  /**
   * Delivered/rendered/authored accounting for every RENDERED chain scene,
   * keyed by `Clip.id` — grouped by `chain.runName` (a session can hold more
   * than one chain; `New draft` clears the draft, not `clips`) and run
   * through `padForOverlap` in scene order, exactly the arithmetic
   * `buildChainGraph` itself applies before submit (its own `padded` result is
   * never stored back onto a `Clip` — see the module comment on `renderChain`
   * — so this recomputes it from what actually got recorded, rather than
   * needing a second write path into `Clip`).
   */
  const sceneAccounting = useMemo(() => {
    const byRun = new Map<string, Array<Clip & { chain: ClipChainInfo }>>()
    for (const c of clips) {
      if (!c.chain) continue
      const withChain = c as Clip & { chain: ClipChainInfo }
      const arr = byRun.get(c.chain.runName) ?? []
      arr.push(withChain)
      byRun.set(c.chain.runName, arr)
    }
    const out: Record<string, PaddedClip> = {}
    for (const group of byRun.values()) {
      const ordered = [...group].sort((a, b) => a.chain.sceneIndex - b.chain.sceneIndex)
      // Scene 1 of a chain that continued an external video pays the same
      // overlap tax any other continuation's first sampled scene pays — see
      // `padForOverlap`'s `firstHasPredecessor` and `ClipChainInfo.continuesExternalVideo`.
      const padded = padForOverlap(ordered.map((c) => ({ frames: c.frames ?? 0 })), CHAIN_CONTEXT_LENGTH, {
        firstHasPredecessor: !!ordered[0]?.chain.continuesExternalVideo,
      })
      ordered.forEach((c, i) => {
        out[c.id] = padded[i]
      })
    }
    return out
  }, [clips])

  /**
   * The ACTIVE chain — the one the currently selected clip belongs to, or
   * else the most recently touched chain in this session — as the chain-flow
   * UI shows it: the film so far belongs to the CHAIN (`filmClip`), never
   * presented as one scene's own clip; each scene's card gets its own
   * work-state label. See `ChainFilmInfo`'s module comment for the defect
   * this fixes.
   */
  const chainFilm = useMemo<ChainFilmInfo | null>(() => {
    const runName = clip?.chain?.runName ?? [...clips].reverse().find((c) => c.chain)?.chain?.runName
    if (!runName) return null
    const inChain = clips.filter((c): c is Clip & { chain: ClipChainInfo } => c.chain?.runName === runName)
    if (!inChain.length) return null
    const ordered = [...inChain].sort((a, b) => a.chain.sceneIndex - b.chain.sceneIndex)
    const chainIsRendering = rendering?.chain?.runName === runName
    const scenes: ChainSceneRow[] = ordered.map((c) => ({
      ...(sceneAccounting[c.id] ?? { authored: c.frames ?? 0, rendered: c.frames ?? 0, delivered: c.frames ?? 0 }),
      clip: c,
      sceneIndex: c.chain.sceneIndex,
      label: sceneWorkLabel(c.state, chainIsRendering),
    }))
    const totals = cumulativeFilm(scenes, 24)
    return {
      runName,
      scenes,
      filmClip: ordered[ordered.length - 1] ?? null,
      totalFrames: totals.frames,
      totalSeconds: totals.seconds,
    }
  }, [clips, clip, rendering, sceneAccounting])

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

  const addRecipe = useCallback(async (r: Recipe) => {
    await idb.set('recipes', r.id, r)
    setRecipes((prev) => [...prev.filter((x) => x.id !== r.id), r])
    setSettings((s) => ({ ...s, recipeId: r.id }))
  }, [])

  const deleteRecipe = useCallback(async (id: string) => {
    await idb.del('recipes', id)
    setRecipes((prev) => prev.filter((r) => r.id !== id))
    // Remember a deleted SHIPPED recipe, so the shipped-set top-up never puts
    // it back — see `dismissedShippedRecipes`. Deleting one of our own is the
    // only signal we get that the operator does not want it.
    if (SHIPPED_CHAIN_IDS.includes(id)) {
      patchSettings({ dismissedShippedRecipes: [...(settings.dismissedShippedRecipes ?? []), id] })
    }
  }, [settings.dismissedShippedRecipes, patchSettings])

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

  const render = useCallback(async () => {
    if (!endpoint || !recipe) {
      setError('Pick an endpoint and a recipe first.')
      return
    }
    const prompt = lastPromptText
    if (!prompt.trim()) {
      setError('Nothing to render — there is no prompt yet.')
      return
    }
    if (!beginGpuUse('render')) return

    const id = `c${Date.now().toString(36)}`
    const index = clipsRef.current.length + 1
    const seed = settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31)
    const frames = framesForSeconds(settings.seconds, 24)
    const snap = platesRef.current

    const draft: Clip = {
      id,
      index,
      parentId: sessionRef.current.parentClipId ?? null,
      state: 'queued',
      prompt,
      film: sessionRef.current.film,
      plateIds: snap.map((p) => p.id),
      recipeId: recipe.id,
      endpointId: endpoint.id,
      seed,
      frames,
      fps: 24,
      at: Date.now(),
    }
    setClips((prev) => [...prev, draft])
    setCurrentClipId(id)
    setRenderingId(id)
    setError(null)
    const t0 = Date.now()

    try {
      // Plates are uploaded once per box and then cited by name — and a plate
      // PICKED from the box is already there, so it is never sent back to it.
      const refs: Array<{ filename: string; subfolder: string }> = []
      const videoRefs: Array<{ filename: string; subfolder: string }> = []
      for (const p of snap) {
        const into = p.kind === 'video' ? videoRefs : refs
        if (p.boxFile?.endpointId === endpoint.id) {
          into.push({ filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
          continue
        }
        if (p.uploaded?.endpointId === endpoint.id) {
          into.push({ filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
          continue
        }
        if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
        const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
        into.push(up)
        await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
      }

      const graph = applyRecipe(recipe, {
        prompt,
        refs,
        videoRefs,
        width: settings.width ?? recipe.defaults.width,
        height: settings.height ?? recipe.defaults.height,
        frames,
        seed,
        steps: settings.steps,
      })

      const promptId = await submit(endpoint, graph)
      patchClip(id, { state: 'rendering', promptId })
      const output = await pollToDone(endpoint, promptId)
      patchClip(id, { state: 'done', output, ms: Date.now() - t0, loraStack: sessionRef.current.loraStack })
    } catch (e) {
      const msg = String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
      endGpuUse()
    }
  }, [
    endpoint, recipe, lastPromptText, settings.lockSeed, settings.seed, settings.seconds, settings.steps,
    settings.width, settings.height, patchClip, savePlate, beginGpuUse, endGpuUse,
  ])

  /**
   * Submit a clip plan as a Contex-Loop chain — the studio's only multi-clip
   * render path ("everything should be chainable through context loop,"
   * founder 2026-09-07, replacing the removed Long Media multiclip path).
   *
   * With no `sceneIndex`: every plan clip is submitted fresh. When every plan
   * clip wants the SAME style-stack (`BreakdownClip.loraStack` — unset counts
   * as its own value, see `planNeedsPerSceneLoraSplit`), that goes out as ONE
   * job with `scene_range` left blank — the fast path h3-shots itself uses for
   * a whole block (no per-clip resume cost, since nothing has rendered yet).
   * The moment two clips want DIFFERENT stacks, one job can no longer honour
   * both — a single ComfyUI job builds one graph with one
   * `LTX_lora_loader.stack_data`, sampled by every shot in it — so this
   * auto-splits into one job PER SCENE instead, submitted in order 1..N under
   * ONE held GPU claim (never parallel; see `beginGpuUse`/`endGpuUse` below).
   * Each such job is otherwise identical to a manual "redo this scene": every
   * OTHER clip resends exactly what was recorded for it earlier in this same
   * submit, so the chain resumes correctly scene to scene. Measured cost of
   * doing this instead of refusing: ~1.6% slower across a 5-clip chain.
   *
   * With a `sceneIndex`: redoes JUST that one plan clip, with that clip's own
   * style-stack. Every OTHER clip resends EXACTLY what was recorded for it on
   * an earlier submit of this SAME plan — never re-derived from current
   * settings/prompts, which is exactly the drift `verify_resume_history`
   * exists to catch (the same append-only contract `renderChain` already
   * keeps for manual continuation) — and `scene_range` limits sampling to the
   * redone scene alone. A style-stack change is safe on a redo: Contex-Loop's
   * own `_scene_dependency_record` hashes audio policy, context length, blend
   * frames, continuation mode, spatial proxy and visual source — no model or
   * LoRA field — so a differing stack never trips `verify_resume_history`.
   *
   * The plan's chain identity (`runName`) is derived from the breakdown's own
   * timestamp (`chainPlanPreview.runName`), so the first whole-plan submit
   * and every later single-scene redo resume the same chain rather than
   * starting a fresh one.
   */
  const renderChainPlan = useCallback(async (sceneIndex?: number) => {
    setError(null)
    if (!endpoint || !chainRecipe) {
      setError('Pick an endpoint and a Contex-Loop (chain) recipe first.')
      return
    }
    const b = sessionRef.current.breakdown
    if (!b || !b.clips.length) {
      setError('No clip plan — run Break down first.')
      return
    }

    const vs = sessionRef.current.versions
    const plan = b.clips.map((c) => {
      const v = [...vs].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
      return { index: c.index, seconds: c.seconds, prompt: v?.text ?? '', loraStack: c.loraStack }
    })

    const runName = `plan_${b.at.toString(36)}`
    const width = settings.width ?? chainRecipe.defaults.width
    const height = settings.height ?? chainRecipe.defaults.height
    const steps = settings.steps ?? chainMinSteps(chainRecipe.graph)

    const issues = chainIssues({
      graph: chainRecipe.graph,
      shots: plan.map((p) => ({ index: p.index, prompt: p.prompt })),
      plateCount: platesRef.current.filter((p) => p.kind === 'image').length,
      steps,
    })
    if (issues.length) {
      setError(issues.join(' '))
      return
    }

    // A clip NOT being (re)sampled THIS job must resend exactly what was
    // recorded when IT last rendered as part of THIS plan — see
    // `chainShotsForPlan`'s own module comment. A clip with no prior render
    // (the whole-plan fast path, or a scene added to the plan after the fact)
    // falls back to its current prompt/settings, same as a fresh submit.
    const priorClipFor = (index: number) =>
      clipsRef.current.filter((x) => x.chain?.runName === runName && x.chain.sceneIndex === index).sort((a, b) => b.at - a.at)[0]
    const priorOf = (index: number) => {
      const c = priorClipFor(index)
      return c ? { prompt: c.prompt, frames: c.frames ?? 0, steps: c.steps, seed: c.seed } : undefined
    }

    // Build, submit, poll and record ONE job — either the whole plan fresh
    // (`targetIndex` undefined, `scene_range` blank) or one scene of it
    // (`targetIndex` given, `scene_range` limited to it). `loraStackForJob` is
    // the ONE style-stack this job's graph gets stamped with.
    const submitOne = async (targetIndex: number | undefined, loraStackForJob: LoraStackEntry[] | undefined) => {
      const shots: ChainShot[] = chainShotsForPlan(plan, {
        sceneIndex: targetIndex,
        steps,
        nextSeed: () => (settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31)),
        priorOf,
      })

      const imagePlates = platesRef.current.filter((p) => p.kind === 'image')
      const jobId = `c${Date.now().toString(36)}`
      const t0 = Date.now()

      // One Clip record per plan clip, all sharing this job's promptId/output
      // once it lands — the same one-Clip-per-scene model `renderChain` uses
      // for manual continuation, so a later single-scene redo can read every
      // other scene's recorded prompt/frames/steps/seed straight off these.
      // A redo REPLACES the plan's earlier records rather than appending
      // beside them — the plan has exactly one Clip per index at a time. Only
      // the scene(s) THIS job actually sampled recorded `loraStackForJob`;
      // every other scene keeps whatever it was last recorded with.
      const draftClips: Clip[] = shots.map((s) => ({
        id: `${jobId}_${s.index}`,
        index: s.index,
        parentId: null,
        state: 'queued',
        prompt: s.prompt,
        film: sessionRef.current.film,
        plateIds: imagePlates.map((p) => p.id),
        recipeId: chainRecipe.id,
        endpointId: endpoint.id,
        seed: s.seed,
        frames: s.frames,
        fps: 24,
        steps: s.steps ?? steps,
        loraStack: targetIndex === undefined || s.index === targetIndex ? loraStackForJob : priorClipFor(s.index)?.loraStack,
        chain: { runName, sceneIndex: s.index },
        at: Date.now(),
      }))
      const draftIds = new Set(draftClips.map((c) => c.id))
      const patchPlanClips = (patch: Partial<Clip>) =>
        setClips((prev) => prev.map((c) => (draftIds.has(c.id) ? { ...c, ...patch } : c)))

      setClips((prev) => [...prev.filter((c) => c.chain?.runName !== runName), ...draftClips])
      setCurrentClipId(draftClips[draftClips.length - 1]?.id ?? null)
      setRenderingId(draftClips[0]?.id ?? null)

      try {
        // Same upload contract as `render()`/`renderChain`: a plate already on
        // THIS box (picked, or uploaded by an earlier submit) is cited by name
        // and never sent back.
        const chainPlates: ChainPlate[] = []
        for (const p of imagePlates) {
          if (p.boxFile?.endpointId === endpoint.id) {
            chainPlates.push({ id: p.id, filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
            continue
          }
          if (p.uploaded?.endpointId === endpoint.id) {
            chainPlates.push({ id: p.id, filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
            continue
          }
          if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
          const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
          chainPlates.push({ id: p.id, filename: up.filename, subfolder: up.subfolder })
          await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
        }

        const built = buildChainGraph({
          graph: chainRecipe.graph,
          shots,
          plates: chainPlates,
          opts: {
            runName, width, height, steps,
            sceneRange: targetIndex !== undefined ? String(targetIndex) : '',
            unetName: settings.chainUnetName || SINGULARITY_UNET,
            loraStack: loraStackForJob,
          },
        })

        const promptId = await submit(endpoint, built.graph)
        patchPlanClips({ state: 'rendering', promptId })
        const output = await pollToDone(endpoint, promptId, (e, p) => pollChain(e, p, runName))
        patchPlanClips({ state: 'done', output, ms: Date.now() - t0 })
      } catch (e) {
        const msg = e instanceof ChainError ? e.message : String((e as Error).message || e)
        patchPlanClips({ state: 'failed', error: msg, ms: Date.now() - t0 })
        throw e
      } finally {
        setRenderingId(null)
      }
    }

    if (!beginGpuUse('render')) return
    try {
      if (sceneIndex !== undefined) {
        await submitOne(sceneIndex, plan.find((p) => p.index === sceneIndex)?.loraStack)
      } else if (!planNeedsPerSceneLoraSplit(plan.map((p) => p.loraStack))) {
        // Uniform (including "nobody customized anything") — the fast, single-job path.
        await submitOne(undefined, plan[0]?.loraStack)
      } else {
        // Differing stacks — one job per scene, in order, still one held GPU claim.
        for (const p of plan) await submitOne(p.index, p.loraStack)
      }
    } catch (e) {
      setError(e instanceof ChainError ? e.message : String((e as Error).message || e))
    } finally {
      endGpuUse()
    }
  }, [
    endpoint, chainRecipe, settings.width, settings.height, settings.steps,
    settings.lockSeed, settings.seed, settings.chainUnetName, savePlate, beginGpuUse, endGpuUse,
  ])

  /**
   * Render the COMPOSER'S current text as ONE Contex-Loop chain scene —
   * resuming every earlier scene from its ComfyUI checkpoint and sampling
   * only this one, so a chain of N clips costs only the last one's render.
   * Nothing gates this on an LLM stage having run: `session.story` is the one
   * thing on screen, and it is always the render payload, typed, pasted, or
   * authored by "Draft it for me" — see the module comment on `Session`.
   *
   * Which chain this joins: the parent clip's `.chain` (set by an earlier
   * `renderChain` call) when the current session continues from one via
   * `continueFrom`/`prepareContinuation`; otherwise this STARTS a fresh
   * chain at scene 1. `verify_resume_history` on the ComfyUI side hashes
   * every earlier scene's prompt/frames/steps/seed, so the prior scenes are
   * always resent from what was actually recorded on their `Clip`s — never
   * re-derived from current settings, which may have since changed.
   *
   * `opts.seedOverride`/`opts.runNameOverride` exist for `replaceScene`: a
   * replace needs a FRESH seed regardless of `settings.lockSeed` (the same
   * seed on the same prompt reproduces the same clip, so a "replace" that
   * keeps both changes nothing) and, when replacing scene 1 specifically, the
   * ORIGINAL run's name rather than a new chain (there is no parent clip to
   * read it from). Every other caller passes neither and gets the ordinary
   * fresh-continuation behaviour.
   *
   * Append-only, in both directions this function can be asked to act on: a
   * scene that already exists at the target index is overwritten in place
   * (a Replace), and every scene AFTER the target index is dropped from
   * state (a Replace or a Continue-from-an-earlier-scene) — Contex-Loop
   * cannot verify a later scene's resume hash against a predecessor that no
   * longer matches what rendered it, so those clips are no longer valid and
   * would need to be re-rendered from here forward.
   */
  const renderChain = useCallback(async (opts?: { seedOverride?: number; runNameOverride?: string }) => {
    if (!endpoint || !chainRecipe) {
      setError('Pick an endpoint and a Contex-Loop (chain) recipe first.')
      return
    }
    const prompt = sessionRef.current.story
    if (!prompt.trim()) {
      setError('Nothing to render — write or paste something in the composer first.')
      return
    }

    const parentId = sessionRef.current.parentClipId ?? null
    const parent = parentId ? clipsRef.current.find((c) => c.id === parentId) : undefined
    const runName = opts?.runNameOverride ?? parent?.chain?.runName ?? `chain_${Date.now().toString(36)}`
    const sceneIndex = (parent?.chain?.sceneIndex ?? 0) + 1

    // Only meaningful on a fresh scene-1 chain — `_initial_state` only reads
    // `external_context` when the range starts there (see `buildChainGraph`'s
    // own guard), and only when it is still bound to THIS endpoint (a picked
    // box file, or an earlier upload, means nothing on a different box).
    const ev = sessionRef.current.externalVideo
    const externalVideo =
      !parentId && ev && ev.endpointId === endpoint.id
        ? { filename: ev.filename, prependOriginal: ev.prependOriginal }
        : undefined

    const width = settings.width ?? chainRecipe.defaults.width
    const height = settings.height ?? chainRecipe.defaults.height
    const steps = settings.steps ?? chainMinSteps(chainRecipe.graph)
    const seed = opts?.seedOverride ?? (settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31))
    const frames = framesForSeconds(settings.seconds, 24)

    // Append-only: every scene BEFORE the target is resent exactly as it was
    // recorded when IT rendered — never re-derived from whatever settings
    // happen to be current now, which is exactly the drift
    // `verify_resume_history` exists to catch. Scoped to `sceneIndex < target`
    // (not merely "same runName") so replacing or continuing from an EARLIER
    // scene never resends a later scene that is about to be invalidated below.
    const priorShots: ChainShot[] = parent?.chain
      ? scenesBefore(
          clipsRef.current.filter((c): c is Clip & { chain: ClipChainInfo } => !!c.chain),
          runName,
          sceneIndex,
        ).map((c) => ({
          index: c.chain.sceneIndex,
          prompt: c.prompt,
          frames: c.frames ?? 0,
          steps: c.steps ?? steps,
          seed: c.seed ?? 0,
        }))
      : []
    const shots: ChainShot[] = [...priorShots, { index: sceneIndex, prompt, frames, steps, seed }]

    const imagePlates = platesRef.current.filter((p) => p.kind === 'image')

    const issues = chainIssues({
      graph: chainRecipe.graph,
      shots: shots.map((s) => ({ index: s.index, prompt: s.prompt })),
      plateCount: imagePlates.length,
      steps,
    })
    if (issues.length) {
      setError(issues.join(' '))
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
      recipeId: chainRecipe.id,
      endpointId: endpoint.id,
      seed,
      frames,
      fps: 24,
      steps,
      chain: {
        runName,
        sceneIndex,
        continuesExternalVideo: !!externalVideo,
        externalVideo: externalVideo ? { ...externalVideo, endpointId: endpoint.id } : undefined,
      },
      at: Date.now(),
    }
    // Drop any existing scene at or after the target index before adding the
    // new one — see the module comment above. A fresh continuation (nothing
    // yet at `sceneIndex`) is a no-op filter, so this is the same append it
    // always was for the common case.
    setClips((prev) => [...dropFromIndex(prev, runName, sceneIndex), draft])
    setCurrentClipId(id)
    setRenderingId(id)

    try {
      // Same upload contract as `render()`/`renderChainPlan`: a plate
      // already on THIS box (picked, or uploaded by an earlier clip) is
      // cited by name and never sent back.
      const plates: ChainPlate[] = []
      for (const p of imagePlates) {
        if (p.boxFile?.endpointId === endpoint.id) {
          plates.push({ id: p.id, filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
          continue
        }
        if (p.uploaded?.endpointId === endpoint.id) {
          plates.push({ id: p.id, filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
          continue
        }
        if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
        const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
        plates.push({ id: p.id, filename: up.filename, subfolder: up.subfolder })
        await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
      }

      const built = buildChainGraph({
        graph: chainRecipe.graph,
        shots,
        plates,
        opts: {
          runName, width, height, steps, sceneRange: sceneRangeFor(sceneIndex),
          unetName: settings.chainUnetName || SINGULARITY_UNET,
          externalVideo,
          // Undefined leaves the bound graph's own baked stack alone; the
          // composer only stamps one once the operator has actually chosen.
          loraStack: sessionRef.current.loraStack,
        },
      })

      const promptId = await submit(endpoint, built.graph)
      patchClip(id, { state: 'rendering', promptId })
      const output = await pollToDone(endpoint, promptId, (e, p) => pollChain(e, p, runName))
      patchClip(id, { state: 'done', output, ms: Date.now() - t0 })
      // The composer is always "the next thing": once a scene lands, this
      // scene becomes the implicit predecessor for whatever gets typed next,
      // and the box clears so last scene's text is never mistaken for the
      // next one's. An explicit Replace/Continue-from-here on a DIFFERENT
      // scene overrides this the moment it is pressed.
      const advanced = { ...sessionRef.current, story: '', parentClipId: id, parentPrompt: prompt, externalVideo: null }
      setSession(advanced)
      sessionRef.current = advanced
    } catch (e) {
      const msg = e instanceof ChainError ? e.message : String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
      endGpuUse()
    }
  }, [
    endpoint, chainRecipe, settings.width, settings.height, settings.steps,
    settings.lockSeed, settings.seed, settings.seconds, settings.chainUnetName, patchClip, savePlate, beginGpuUse, endGpuUse,
  ])

  const selectClip = useCallback((id: string) => setCurrentClipId(id), [])

  /** How many scenes of the clip's chain, from `fromIndex` on, currently
   * exist — see the module comment on `Api.scenesFrom`. */
  const scenesFrom = useCallback((clipId: string, fromIndex: number): number => {
    const target = clipsRef.current.find((c) => c.id === clipId)
    const runName = target?.chain?.runName
    if (!runName) return 0
    return countFromIndex(clipsRef.current, runName, fromIndex)
  }, [])

  /** Replace one already-rendered scene in place — see the module comment on
   * `Api.replaceScene`. */
  const replaceScene = useCallback(async (clipId: string, opts?: { keepSeed?: boolean }) => {
    const target = clipsRef.current.find((c) => c.id === clipId)
    if (!target?.chain) {
      setError('That scene is not part of a chain.')
      return
    }
    const runName = target.chain.runName
    const sceneIndex = target.chain.sceneIndex
    const predecessor =
      sceneIndex > 1
        ? clipsRef.current.find((c) => c.chain?.runName === runName && c.chain.sceneIndex === sceneIndex - 1)
        : undefined

    const next = {
      ...sessionRef.current,
      story: target.prompt,
      film: target.film ?? sessionRef.current.film,
      parentClipId: predecessor?.id ?? null,
      parentPrompt: predecessor?.prompt,
      // Scene 1 alone may have an external-video predecessor to re-pass —
      // see `ClipChainInfo.externalVideo`'s module comment.
      externalVideo: externalVideoForReplace(target),
    }
    setSession(next)
    sessionRef.current = next
    setCurrentClipId(predecessor?.id ?? null)

    await renderChain({
      seedOverride: opts?.keepSeed ? target.seed : Math.floor(Math.random() * 2 ** 31),
      runNameOverride: runName,
    })
  }, [renderChain])

  /**
   * Close the loop end to end.
   *
   * The clip's last frame becomes the next clip's <Picture 1>, a hand-off
   * paragraph is written from the prompt that produced it, then Direct → Draft
   * authors the next prompt. The rendered parent clip remains in the filmstrip
   * and carries the parent prompt, plates, seed and film context into render.
   */
  const continueFrom = useCallback(
    async (clipId: string, note?: string) => {
      const c = clipsRef.current.find((x) => x.id === clipId)
      if (!c) return
      const url = clipUrl(c)
      if (!url && !c.lastFrame) {
        setError('That clip has no file yet.')
        return
      }

      // Continuation has work to cancel before the model is called: frame
      // extraction and hand-off are both asynchronous. Abort any stale run
      // before installing this run's controller so Stop/Escape always targets
      // the active action.
      continuationAbortRef.current?.abort()
      const controller = new AbortController()
      continuationAbortRef.current = controller
      const isCancelled = () => controller.signal.aborted
      const markCancelled = (phase: ContinuationPhase, source?: string) => {
        clearReplacedPlates()
        setContinuation({ clipId, phase, state: 'cancelled', source })
      }

      try {
      setError(null)
      setContinuation({ clipId, phase: 'frame', state: 'running' })
      let frameWarning: string | null = null

      try {
        if (isCancelled()) {
          markCancelled('frame')
          return
        }

        // Remove a replacement from an earlier clip before extraction begins.
        // If extraction is cancelled or fails, the current session must not be
        // able to cite a stale ending frame while continuing text-only.
        const before = platesRef.current
        const retained = before.filter((p) => continuationPlateIsFresh(p, clipId))
        if (retained.length !== before.length) {
          platesRef.current = retained
          setPlates(retained)
        }

        const frame = c.lastFrame ?? (url ? await lastFrameOf(url, controller.signal) : '')
        if (isCancelled()) {
          markCancelled('frame')
          return
        }
        if (!frame) throw new Error('The clip has no readable ending frame.')
        if (!c.lastFrame) patchClip(clipId, { lastFrame: frame })

        // One replaced plate at a time — otherwise every continuation adds
        // another last frame and the nine-reference budget is gone by clip 5.
        const previous = retained.find((p) => p.mode === 'replaced')
        const plate: Plate = {
          id: previous?.id ?? `p${Date.now().toString(36)}`,
          name: `clip ${c.index} · last frame`,
          kind: 'image',
          job: previous?.job?.trim()
            ? previous.job
            : 'Use it for the room, the light and where they are standing. Do not take expression from it.',
          dataUrl: frame,
          mode: 'replaced',
          fromClipId: clipId,
          addedAt: previous?.addedAt ?? 0, // stays first, so it is <Picture 1>
        }
        if (isCancelled()) {
          markCancelled('frame')
          return
        }
        // Keep the ref in sync immediately; Direct/Draft and a user pressing
        // Render as soon as the prompt is ready must see the same plate list.
        const nextPlates = [plate, ...retained.filter((p) => p.id !== plate.id)]
        platesRef.current = nextPlates
        setPlates(nextPlates)
      } catch (e) {
        if (isCancelled() || (e as Error).name === 'AbortError') {
          markCancelled('frame')
          return
        }
        // A frame we cannot read is not fatal — the hand-off is still worth
        // having, and the operator can drop a still in by hand. The stale
        // replacement was already removed above, so this remains text-only.
        clearReplacedPlates()
        frameWarning = 'Could not take the last frame: ' + String((e as Error).message || e)
      }

      if (isCancelled()) {
        markCancelled('frame')
        return
      }
      setContinuation({ clipId, phase: 'handoff', state: 'running' })
      // A user may have selected an older clip before pressing Continue. The
      // hand-off must read that clip's stored prompt and film context, never
      // the session's currently selected pass.
      const written = await run('handoff', undefined, { ...continuationContextOverride(c), studioMode: 'story' })
      if (isCancelled()) {
        markCancelled('handoff')
        return
      }
      // A failed hand-off must leave the current prompt/session intact. The
      // extracted replacement is also cleared because no next prompt exists
      // that could legitimately cite it.
      if (!written) {
        clearReplacedPlates()
        setContinuation({ clipId, phase: 'handoff', state: 'failed' })
        return
      }
      const parsed = splitHandoff(written.text)

      const nextSource = continuationSource(note, parsed)
      const previousSession = sessionRef.current
      const sourceFilm = c.film ?? previousSession.film
      if (isCancelled()) {
        markCancelled('handoff', nextSource)
        return
      }
      const nextSession: Session = {
        story: nextSource,
        // Append the hand-off to the existing lineage. Direct and Draft below
        // append too, so history/diffs can still inspect every prior pass.
        versions: appendContinuationHistory(previousSession.versions, written),
        currentId: written.id,
        chat: [],
        parentClipId: clipId,
        parentPrompt: c.prompt,
        film: {
          ...DEFAULT_FILM,
          ...sourceFilm,
          role: nextRole(sourceFilm?.role ?? 'standalone'),
          precedes: parsed.precedes || sourceFilm?.precedes || '',
          follows: parsed.follows || sourceFilm?.follows || '',
        },
        breakdown: previousSession.breakdown,
      }
      // `run()` snapshots sessionRef synchronously. Keep it in lockstep with
      // the state update so Direct starts from the new hand-off source rather
      // than the old prompt during this same async turn.
      setSession(nextSession)
      sessionRef.current = nextSession
      setCurrentClipId(clipId)

      let failedStage: 'direct' | 'draft' = 'direct'
      let authored: 'ready' | 'aborted'
      try {
        authored = await authorContinuation(async (stage, previous) => {
          if (isCancelled()) return null
          failedStage = stage
          setContinuation({ clipId, phase: stage, state: 'running', source: nextSource })
          const previousText = previous && typeof previous === 'object' && 'text' in previous && typeof previous.text === 'string'
            ? previous.text
            : undefined
          return run(stage, undefined, {
            studioMode: 'story',
            ...(stage === 'draft' && previousText ? { current: previousText } : {}),
          })
        }, isCancelled)
      } catch (e) {
        // `run()` normally turns provider failures into null, but preserve an
        // unexpected failure as a visible error and a failed receipt too.
        const message = String((e as Error).message || e)
        setError(message)
        setContinuation({ clipId, phase: failedStage, state: 'failed', source: nextSource })
        return
      }
      if (isCancelled()) {
        setContinuation({ clipId, phase: failedStage, state: 'cancelled', source: nextSource })
        return
      }
      if (authored !== 'ready') {
        setContinuation({ clipId, phase: failedStage, state: 'failed', source: nextSource })
        return
      }
      if (frameWarning) setError(frameWarning)
      setContinuation({ clipId, phase: 'ready', state: 'ready', source: nextSource })
      } catch (e) {
        if (isCancelled() || (e as Error).name === 'AbortError') {
          markCancelled('handoff')
        } else {
          const message = String((e as Error).message || e)
          setError(message)
          setContinuation({ clipId, phase: 'handoff', state: 'failed' })
        }
      } finally {
        if (continuationAbortRef.current === controller) continuationAbortRef.current = null
      }
    },
    [clearReplacedPlates, clipUrl, patchClip, run],
  )

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
    recipes,
    recipe,
    chainRecipe,
    endpoints,
    endpoint,
    comfyProbes,
    clips,
    clip,
    rendering,
    gpuBusy,
    blockers,
    warnings,
    chainBlockers,
    chainPlanPreview,
    sceneAccounting,
    chainFilm,
    addPlate,
    updatePlate,
    deletePlate,
    reorderPlate,
    addRecipe,
    deleteRecipe,
    setEndpoints,
    refreshComfyProbe,
    clipUrl,
    render,
    renderChainPlan,
    renderChain,
    selectClip,
    scenesFrom,
    replaceScene,
    continueFrom,
    appendPromptVersion,
    setBreakdown,
    setClipLoraStack,
    isFreshChainStart: !session.parentClipId,
    externalVideo: session.externalVideo ?? null,
    loraStack: session.loraStack,
    setExternalVideo,
    setLoraStack,
    prepareContinuation,
    cancel,
    selectVersion,
    clearError: () => {
      setError(null)
      setFailedReasoning(null)
      setInterruptedReasoning(null)
    },
    reset,
    beginGpuUse,
    endGpuUse,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
