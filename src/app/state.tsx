import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, buildH3SystemPrompt, type BuiltContext } from '../lib/context'
import { classifyInput, findingsToText, lint, looksLikePrompt, standingToText } from '../lib/lint'
import { continuationBudgetFor, streamChatComplete } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders } from '../lib/providers'
import { STAGE_LABEL, fillTemplate, filmBlock, hasPromptBlock, nextRole, parseBreakdown, splitHandoff, splitPromptReplacement, splitReply, templateFor } from '../lib/stages'
import { DEFAULT_ENDPOINTS, lastFrameOf, poll, probeComfy, submit, uploadImage, viewUrl } from '../lib/comfy'
import { applyRecipe, framesForSeconds, oomRisk, recipeIssues } from '../lib/recipe'
import { buildMulticlipGraph, multiclipIssues, multiclipWarnings, overlapFramesOf, padForOverlap, schedulerStepsOf } from '../lib/multiclip'
import type { MulticlipClip, PaddedClip } from '../lib/multiclip'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import { estTokens } from '../lib/tokens'
import { appendContinuationHistory, authorContinuation, clearDraftContext, continuationContextOverride, continuationPlateIsFresh, continuationSource, interruptedReasoningText, previousPromptForClip, promptSourceForEntryMode } from '../lib/entry'
import type { EntryModeId } from '../lib/entry'
import { isSingleRequestStage, type StudioRunPhase } from '../lib/studio-workflow'
import type {
  Breakdown, ChatTurn, Clip, ComfyEndpoint, FilmContext, Finding, Plate, ProbeResult, Provider,
  Recipe, Selection, Settings, Skill, StageId, Version,
} from '../lib/types'

const SETTINGS_SCHEMA = 4

const DEFAULT_FILM: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '' }

/** Stages whose output is a prompt, as opposed to a direction sheet or notes. */
const PROMPT_STAGES = new Set<StageId>(['draft', 'revise', 'rebuild', 'freeform'])

const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  providerId: 'ollama',
  model: '',
  temperature: 0.35,
  // 0 = no ceiling. A six-section Ref2VA prompt is long, and a reasoning model
  // spends tokens thinking before it writes a word — so any fixed number is a
  // guess that eventually truncates someone. Sending nothing lets the server
  // apply the real limit, which is its context minus the prompt.
  maxTokens: 0,
  mode: 'Ref2VA',
  selection: {},
  stageTemplates: {},
  onboarded: false,
  seconds: 7.3,
  lockSeed: true,
  seed: 42,
}

/** The deterministic name a plate uploads under — shared so the multiclip path
 * predicts the exact filename a real upload will produce, without uploading. */
function plateFilename(p: Plate): string {
  return `${p.id}_${p.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'plate'}.png`
}

/**
 * Poll a submitted render to completion or failure.
 *
 * Poll rather than hold a websocket: a dropped link must not lose a render the
 * box is still perfectly happily producing. Shared by the single-clip and
 * multiclip render paths — the retry/deadline behaviour is the same either way.
 */
async function pollToDone(ep: ComfyEndpoint, promptId: string): Promise<Clip['output']> {
  const deadline = Date.now() + 60 * 60 * 1000
  let misses = 0
  for (;;) {
    await new Promise((r) => setTimeout(r, 2500))
    if (Date.now() > deadline) throw new Error('Gave up waiting after an hour.')
    let res
    try {
      res = await poll(ep, promptId)
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
  /** Explicit Studio entry contract for this pass. */
  studioMode?: EntryModeId
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

/** One plan clip's prompt and frame accounting, for the "Submit all as one job" panel. */
interface MulticlipPreviewClip extends PaddedClip {
  index: number
  title: string
  prompt: string
  seconds: number
}

interface MulticlipPreview {
  clips: MulticlipPreviewClip[]
  /** Delivered seconds, summed — what the film actually runs. */
  totalSeconds: number
  /** Every blocking problem — same contract as `blockers`. */
  issues: string[]
  /** Non-blocking — an OOM risk at the chosen geometry, named per clip. */
  warnings: string[]
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
  /** Current Studio entry mode; Agent has its own fixed contract. */
  studioMode: EntryModeId

  setStory: (s: string) => void
  setStudioMode: (mode: EntryModeId) => void
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
  rebuild: (studioMode?: EntryModeId) => Promise<void>

  // ── the render loop ─────────────────────────────────────────────────
  plates: Plate[]
  recipes: Recipe[]
  recipe: Recipe | null
  /** The Long Media (multiclip) workflow — a DIFFERENT stored recipe from `recipe`. */
  multiclipRecipe: Recipe | null
  endpoints: ComfyEndpoint[]
  endpoint: ComfyEndpoint | null
  comfyProbes: Record<string, ProbeResult>
  clips: Clip[]
  clip: Clip | null
  rendering: Clip | null
  /** Why a render cannot start yet — empty when it can. */
  blockers: string[]
  /** Non-blocking — an OOM risk at the chosen geometry for the single-clip render. */
  warnings: string[]
  /** The current clip plan's multiclip accounting and gate, or null with no plan yet. */
  multiclipPreview: MulticlipPreview | null
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
  /** Submit the whole clip plan as one Long Media multiclip job. */
  renderMulticlip: () => Promise<void>
  /** Build the multiclip graph and copy it to the clipboard — no submit, no render. */
  copyMulticlipGraph: () => Promise<void>
  selectClip: (id: string) => void
  /** Author the next prompt from a landed clip; rendering remains a separate action. */
  continueFrom: (clipId: string, note?: string) => Promise<void>
  /** Append a canonical prompt version without invoking an LLM stage. */
  appendPromptVersion: (input: PromptVersionInput) => Version | null
  /** Save the clip plan without invoking an LLM stage. */
  setBreakdown: (breakdown: Breakdown) => void
  /** Select a clip and stage its deterministic continuation context. */
  prepareContinuation: (clipId: string) => PreparedContinuation | null
  cancel: () => void
  selectVersion: (id: string) => void
  clearError: () => void
  reset: () => Promise<void>
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
  const [studioMode, setStudioMode] = useState<EntryModeId>('story')
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
        seenBundled: [...new Set([...(savedSettings?.seenBundled ?? []), ...bundledIds])],
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
      setRecipes(savedRecipes.sort((a, b) => a.addedAt - b.addedAt))
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
        working = promptSourceForEntryMode(
          override?.studioMode ?? studioMode,
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
          contextHash: ctx.hash,
          signal: ac.signal,
          // The cached block is always first and byte-identical between calls;
          // everything that varies goes in the user turn after it.
          // The skills stay first and byte-identical so the prefix cache holds;
          // the frame and the thread follow, which is what makes a composer
          // turn a continuation rather than a cold single-shot request.
          messages: [
            { role: 'system', content: buildH3SystemPrompt(ctx, 'studio', override?.studioMode ?? studioMode) },
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
          const nextSession = {
            ...sessionRef.current,
            versions: [...sessionRef.current.versions, version],
            currentId: version.id,
            breakdown: parsed ?? sessionRef.current.breakdown,
          }
          setSession((s) => ({
            ...s,
            versions: [...s.versions, version],
            currentId: version.id,
            breakdown: parsed ?? s.breakdown,
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
        const nextSession = {
          ...sessionRef.current,
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
      }
    },
    [providers, settings, context, skills, findings, studioMode],
  )

  const rebuild = useCallback(async (mode?: EntryModeId) => {
    const studioModeOverride = mode ?? studioMode
    if (studioModeOverride === 'prompt') {
      // Prompt Rebuild is its own finite operation. It deliberately does not
      // route through the Scene/Clip Direct → Draft quality sequence.
      await run('rebuild', undefined, { studioMode: 'prompt' })
      return
    }
    const sheet = await run('direct', undefined, { studioMode: studioModeOverride })
    if (sheet) await run('draft', undefined, { studioMode: studioModeOverride, current: sheet.text })
  }, [run, studioMode])

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
  // recipe silently standing in for the Long Media one would build a graph
  // with none of the multiclip nodes on it, and multiclipIssues would have to
  // guess whether that was really the operator's intent.
  const multiclipRecipe = useMemo(
    () => recipes.find((r) => r.id === settings.multiclipRecipeId) ?? null,
    [recipes, settings.multiclipRecipeId],
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
    if (recipe) {
      const width = settings.width ?? recipe.defaults.width
      const height = settings.height ?? recipe.defaults.height
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
  }, [recipe, settings.width, settings.height, settings.seconds])

  /**
   * The clip plan's multiclip accounting and gate, recomputed on every prompt,
   * plate or geometry change so the frame accounting on screen never lags what
   * a submit would actually build.
   */
  const multiclipPreview = useMemo<MulticlipPreview | null>(() => {
    const b = session.breakdown
    if (!b || !b.clips.length) return null

    const plan = b.clips.map((c) => {
      const v = [...session.versions].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
      return { index: c.index, title: c.title || `clip ${c.index}`, seconds: c.seconds, prompt: v?.text ?? '' }
    })
    const imagePlateCount = plates.filter((p) => p.kind === 'image').length
    const graph = multiclipRecipe?.graph ?? null
    const overlap = overlapFramesOf(graph)
    const padded = padForOverlap(plan.map((c) => ({ frames: framesForSeconds(c.seconds, 24) })), overlap)
    const steps = settings.steps ?? schedulerStepsOf(graph) ?? 0

    const issues = multiclipIssues({
      graph,
      clips: plan.map((c) => ({ index: c.index, prompt: c.prompt })),
      plateCount: imagePlateCount,
      steps,
    })

    const width = settings.width ?? multiclipRecipe?.defaults.width ?? 0
    const height = settings.height ?? multiclipRecipe?.defaults.height ?? 0
    // Check the PADDED (rendered) frame count, not delivered — that is what
    // actually gets sampled and is what VRAM has to hold.
    const warn = plan
      .map((c, i) => (oomRisk(width, height, padded[i].rendered) ? `Clip ${c.index} renders ${padded[i].rendered} frames at ${width}×${height} — measured to OOM at this tier.` : null))
      .filter((x): x is string => x !== null)

    return {
      clips: plan.map((c, i) => ({ ...c, ...padded[i] })),
      totalSeconds: +(padded.reduce((sum, p) => sum + p.delivered, 0) / 24).toFixed(3),
      issues,
      warnings: [...warn, ...multiclipWarnings(graph)],
    }
  }, [session.breakdown, session.versions, plates, multiclipRecipe, settings.steps, settings.width, settings.height])

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
      patchClip(id, { state: 'done', output, ms: Date.now() - t0 })
    } catch (e) {
      const msg = String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
    }
  }, [
    endpoint, recipe, lastPromptText, settings.lockSeed, settings.seed, settings.seconds, settings.steps,
    settings.width, settings.height, patchClip, savePlate,
  ])

  /**
   * Gather what a multiclip submit needs and build the graph, WITHOUT
   * submitting it — shared by `renderMulticlip` (which then submits) and
   * `copyMulticlipGraph` (which stops here). Plates are uploaded for real:
   * that costs a few small requests, not the 466s a render costs, so both
   * callers pay it and both see the graph exactly as it will actually go out.
   */
  const buildMulticlipPayload = useCallback(async () => {
    if (!endpoint) throw new Error('No ComfyUI endpoint. Add one under “Where it renders”.')
    if (!multiclipRecipe) throw new Error('No Long Media recipe — drop the multiclip workflow and pick it as the Long Media recipe.')
    const b = sessionRef.current.breakdown
    if (!b || !b.clips.length) throw new Error('No clip plan — run Break down first.')

    const vs = sessionRef.current.versions
    const plan = b.clips.map((c) => {
      const v = [...vs].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES.has(x.stage))
      return { index: c.index, seconds: c.seconds, prompt: v?.text ?? '' }
    })

    // Plates are uploaded once per box and cited by name, same as render()
    // above — and only image plates: Long Media multiclip's global references
    // are image_1..image_9, there is no video-reference slot on this path.
    const imagePlates = platesRef.current.filter((p) => p.kind === 'image')
    const refs: Array<{ filename: string; subfolder: string }> = []
    for (const p of imagePlates) {
      if (p.boxFile?.endpointId === endpoint.id) {
        refs.push({ filename: p.boxFile.filename, subfolder: p.boxFile.subfolder })
        continue
      }
      if (p.uploaded?.endpointId === endpoint.id) {
        refs.push({ filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
        continue
      }
      if (!p.dataUrl) throw new Error(`Plate “${p.name}” has no file on this box and nothing to upload.`)
      const up = await uploadImage(endpoint, p.dataUrl, plateFilename(p))
      refs.push(up)
      await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
    }

    const steps = settings.steps ?? schedulerStepsOf(multiclipRecipe.graph) ?? 0
    const seed = settings.lockSeed ? settings.seed : Math.floor(Math.random() * 2 ** 31)
    const clips: MulticlipClip[] = plan.map((c) => ({ prompt: c.prompt, seconds: c.seconds, seed }))

    const built = buildMulticlipGraph({
      graph: multiclipRecipe.graph,
      clips,
      plates: refs,
      width: settings.width ?? multiclipRecipe.defaults.width,
      height: settings.height ?? multiclipRecipe.defaults.height,
      steps,
      seed,
      filenamePrefix: `multiclip_${Date.now().toString(36)}`,
    })

    return { plan, built, seed }
  }, [endpoint, multiclipRecipe, settings.steps, settings.lockSeed, settings.seed, settings.width, settings.height, savePlate])

  const renderMulticlip = useCallback(async () => {
    setError(null)
    const id = `c${Date.now().toString(36)}`
    const t0 = Date.now()

    let payload: Awaited<ReturnType<typeof buildMulticlipPayload>>
    try {
      payload = await buildMulticlipPayload()
    } catch (e) {
      setError(String((e as Error).message || e))
      return
    }
    const { plan, built, seed } = payload

    const draft: Clip = {
      id,
      index: clipsRef.current.length + 1,
      parentId: sessionRef.current.parentClipId ?? null,
      state: 'queued',
      // The whole job's prompt IS the first clip's — the same rule the setup
      // node's own `prompt` field follows in multiclip mode (see multiclip.ts).
      prompt: plan[0]?.prompt ?? '',
      film: sessionRef.current.film,
      plateIds: platesRef.current.filter((p) => p.kind === 'image').map((p) => p.id),
      recipeId: multiclipRecipe!.id,
      endpointId: endpoint!.id,
      seed,
      frames: built.padded.reduce((sum, p) => sum + p.delivered, 0),
      fps: 24,
      multiclip: {
        clipIndexes: plan.map((c) => c.index),
        perClip: plan.map((c, i) => ({ index: c.index, ...built.padded[i] })),
        totalSeconds: built.totalSeconds,
      },
      at: Date.now(),
    }
    setClips((prev) => [...prev, draft])
    setCurrentClipId(id)
    setRenderingId(id)

    try {
      const promptId = await submit(endpoint!, built.graph)
      patchClip(id, { state: 'rendering', promptId })
      const output = await pollToDone(endpoint!, promptId)
      patchClip(id, { state: 'done', output, ms: Date.now() - t0 })
    } catch (e) {
      const msg = String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
    }
  }, [buildMulticlipPayload, endpoint, multiclipRecipe, patchClip])

  const copyMulticlipGraph = useCallback(async () => {
    setError(null)
    try {
      const { built } = await buildMulticlipPayload()
      await navigator.clipboard.writeText(JSON.stringify(built.graph, null, 2))
    } catch (e) {
      setError(String((e as Error).message || e))
    }
  }, [buildMulticlipPayload])

  const selectClip = useCallback((id: string) => setCurrentClipId(id), [])

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
    studioMode,
    setStory,
    setStudioMode,
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
    multiclipRecipe,
    endpoints,
    endpoint,
    comfyProbes,
    clips,
    clip,
    rendering,
    blockers,
    warnings,
    multiclipPreview,
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
    renderMulticlip,
    copyMulticlipGraph,
    selectClip,
    continueFrom,
    appendPromptVersion,
    setBreakdown,
    prepareContinuation,
    cancel,
    selectVersion,
    clearError: () => {
      setError(null)
      setFailedReasoning(null)
      setInterruptedReasoning(null)
    },
    reset,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
