import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, type BuiltContext } from '../lib/context'
import { findingsToText, lint, looksLikePrompt } from '../lib/lint'
import { streamChat } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders } from '../lib/providers'
import { DEFAULT_TEMPLATES, STAGE_LABEL, fillTemplate, filmBlock, hasPromptBlock, nextRole, splitHandoff, splitReply, templateFor } from '../lib/stages'
import { DEFAULT_ENDPOINTS, lastFrameOf, poll, probeComfy, submit, uploadImage, viewUrl } from '../lib/comfy'
import { applyRecipe, framesForSeconds, recipeIssues } from '../lib/recipe'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import { estTokens } from '../lib/tokens'
import type {
  ChatTurn, Clip, ComfyEndpoint, FilmContext, Finding, Plate, ProbeResult, Provider,
  Recipe, Selection, Settings, Skill, StageId, Version,
} from '../lib/types'

const SETTINGS_SCHEMA = 4

const DEFAULT_FILM: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '' }

/** Stages whose output is a prompt, as opposed to a direction sheet or notes. */
const PROMPT_STAGES = new Set<StageId>(['draft', 'revise', 'freeform'])

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
}

interface Api {
  ready: boolean
  skills: Skill[]
  settings: Settings
  providers: Provider[]
  probes: Record<string, ProbeResult>
  story: string
  versions: Version[]
  current: Version | null
  streaming: { stage: StageId; text: string; reasoning: string; startedAt: number } | null
  chat: ChatTurn[]
  film: FilmContext
  error: string | null
  /** Thinking from a run that produced no answer, kept so it is not lost. */
  failedReasoning: string | null
  findings: Finding[]
  context: BuiltContext | null

  setStory: (s: string) => void
  setFilm: (f: Partial<FilmContext>) => void
  patchSettings: (p: Partial<Settings>) => void
  toggleSkill: (skill: Skill) => void
  toggleFile: (skill: Skill, rel: string) => void
  addSkills: (skills: Skill[]) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  setProviders: (p: Provider[]) => Promise<void>
  refreshProbe: (id: string) => Promise<void>
  run: (stage: StageId, note?: string) => Promise<Version | null>
  /** Direct then Draft — a full re-synthesis rather than an edit. */
  rebuild: () => Promise<void>

  // ── the render loop ─────────────────────────────────────────────────
  plates: Plate[]
  recipes: Recipe[]
  recipe: Recipe | null
  endpoints: ComfyEndpoint[]
  endpoint: ComfyEndpoint | null
  comfyProbes: Record<string, ProbeResult>
  clips: Clip[]
  clip: Clip | null
  rendering: Clip | null
  /** Why a render cannot start yet — empty when it can. */
  blockers: string[]
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
  selectClip: (id: string) => void
  /** Take a landed clip's last frame and hand-off, and start the next clip. */
  continueFrom: (clipId: string, note?: string) => Promise<void>
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
  const [providers, setProvidersState] = useState<Provider[]>(DEFAULT_PROVIDERS)
  const [probes, setProbes] = useState<Record<string, ProbeResult>>({})
  const [session, setSession] = useState<Session>({ story: '', versions: [], currentId: null, chat: [] })
  const [clips, setClips] = useState<Clip[]>([])
  const [currentClipId, setCurrentClipId] = useState<string | null>(null)
  const [streaming, setStreaming] = useState<{ stage: StageId; text: string; reasoning: string; startedAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const [failedReasoning, setFailedReasoning] = useState<string | null>(null)
  const [plates, setPlates] = useState<Plate[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [endpoints, setEndpointsState] = useState<ComfyEndpoint[]>(DEFAULT_ENDPOINTS)
  const [comfyProbes, setComfyProbes] = useState<Record<string, ProbeResult>>({})
  const [renderingId, setRenderingId] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  // run() closes over session, so chaining two stages in one turn would read
  // state from before the first one finished. The ref always holds the latest.
  const sessionRef = useRef(session)
  sessionRef.current = session

  // ── boot ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      let bundledIds: string[] = []
      const [savedSettings, savedSession, savedProviders] = await Promise.all([
        idb.get<Settings>('settings', 'settings'),
        idb.get<Session>('sessions', 'current'),
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

      const [savedPlates, savedRecipes, savedClips, savedEndpoints] = await Promise.all([
        idb.all<Plate>('plates'),
        idb.all<Recipe>('recipes'),
        idb.get<Clip[]>('clips', 'current'),
        idb.get<ComfyEndpoint[]>('settings', 'comfyEndpoints'),
      ])
      setPlates(savedPlates.sort((a, b) => a.addedAt - b.addedAt))
      setRecipes(savedRecipes.sort((a, b) => a.addedAt - b.addedAt))
      if (savedEndpoints?.length) setEndpointsState(savedEndpoints)
      if (savedClips?.length) setClips(savedClips)

      setSkills(stored)
      setSettings(merged)
      setProvidersState(savedProviders)
      if (savedSession) setSession(savedSession)
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

  useEffect(() => {
    if (ready) void idb.set('sessions', 'current', session)
  }, [ready, session])

  useEffect(() => {
    if (ready) void idb.set('clips', 'current', clips)
  }, [ready, clips])

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
    // sheet, and not on critique notes, which are prose about a prompt and
    // will "fail" every structural rule they are measured against.
    if (streaming?.text) return PROMPT_STAGES.has(streaming.stage) ? lint(streaming.text, settings.mode) : []
    if (current && PROMPT_STAGES.has(current.stage)) return lint(current.text, settings.mode)
    const lastPrompt = [...session.versions].reverse().find((v) => PROMPT_STAGES.has(v.stage))
    if (lastPrompt) return lint(lastPrompt.text, settings.mode)
    return looksLikePrompt(session.story) ? lint(session.story, settings.mode) : []
  }, [current, streaming, settings.mode, session.story, session.versions])

  // ── actions ───────────────────────────────────────────────────────────
  const patchSettings = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])

  const setStory = useCallback((story: string) => setSession((s) => ({ ...s, story })), [])

  const setFilm = useCallback(
    (f: Partial<FilmContext>) =>
      setSession((s) => ({ ...s, film: { ...DEFAULT_FILM, ...s.film, ...f } })),
    [],
  )

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

  const selectVersion = useCallback((id: string) => setSession((s) => ({ ...s, currentId: id })), [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(null)
  }, [])

  const run = useCallback(
    async (stage: StageId, note?: string): Promise<Version | null> => {
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

      let working: string
      if (stage === 'direct') {
        working = ''
      } else if (stage === 'draft') {
        // Prefer a direction sheet — the one you are reading, else the latest.
        working = (cur?.stage === 'direct' ? cur.text : lastOf('direct')?.text) ?? snap.story
      } else {
        // Critique, Revise and a freeform note all operate on the prompt.
        working =
          (cur && PROMPT_STAGES.has(cur.stage) ? cur.text : lastPrompt()?.text) ??
          (looksLikePrompt(snap.story) ? snap.story : '')
      }

      if (!snap.story.trim() && !snap.versions.length) {
        setError('Paste something first.')
        return null
      }
      if (stage !== 'direct' && !working.trim()) {
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
        story: snap.story,
        current: working,
        mode: settings.mode,
        film: filmBlock(snap.film),
        notes: note,
        findings: findings.length ? findingsToText(findings) : undefined,
        critique: critiqueText,
      })

      const ac = new AbortController()
      abortRef.current = ac
      setStreaming({ stage, text: '', reasoning: '', startedAt: Date.now() })
      setError(null)

      try {
        const result = await streamChat({
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
            { role: 'system', content: ctx.text },
            { role: 'user', content: user },
            ...(stage === 'freeform'
              ? [
                  ...(snap.chat ?? []).map((t) => ({ role: t.role, content: t.text })),
                  { role: 'user' as const, content: note ?? '' },
                ]
              : []),
          ],
          onDelta: (chunk) => setStreaming((s) => (s ? { ...s, text: s.text + chunk } : s)),
          onReasoning: (chunk) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + chunk } : s)),
        })

        if (!result.text.trim()) {
          // Keep the thinking visible — it is the only evidence of what went
          // wrong, and discarding it on failure loses the whole run.
          setFailedReasoning(result.reasoning.trim() || null)
          const chars = result.reasoning.trim().length
          const thinking = chars ? `${chars.toLocaleString()} characters of thinking` : 'nothing'

          if (result.unterminatedThink) {
            throw new Error(
              `The model opened a <think> block and never closed it, so its whole reply (${thinking}) was counted as thinking and no answer came out. That is a model or chat-template quirk rather than a limit — re-running usually clears it.`,
            )
          }
          if (result.finishReason === 'length') {
            throw new Error(
              result.sentLimit
                ? `Cut off at the ${result.sentLimit.toLocaleString()}-token ceiling after ${thinking}, before any answer. Raise it, or set output length to “No limit” in Settings.`
                : `The model ran out of room after ${thinking}, before writing an answer. No ceiling was sent, so this is its own context limit — shorten the source or load fewer skill files.`,
            )
          }
          throw new Error(
            chars
              ? `The model produced ${thinking} and then stopped without an answer${result.finishReason ? ` (finish reason: ${result.finishReason})` : ''}. Its thinking is kept above. Re-running usually helps; a smaller skill selection helps more.`
              : `The model returned nothing at all${result.finishReason ? ` (finish reason: ${result.finishReason})` : ''}.`,
          )
        }
        setFailedReasoning(null)

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

        // Revise and freeform are asked for a prompt plus a changelog; the
        // other stages return one document.
        const wantsChangelog = stage === 'revise' || stage === 'freeform'
        const { prompt: bodyText, changelog } = wantsChangelog
          ? splitReply(result.text)
          : { prompt: result.text.trim(), changelog: [] as string[] }

        const version: Version = {
          id: `v${Date.now().toString(36)}`,
          stage,
          label: STAGE_LABEL[stage],
          text: bodyText || result.text.trim(),
          fromText: working || undefined,
          changelog: changelog.length ? changelog : undefined,
          model: settings.model,
          providerId: provider.id,
          at: Date.now(),
          ms: result.ms,
          reasoning: result.reasoning.trim() || undefined,
          tokens: result.usage?.completion ?? estTokens(result.text + result.reasoning),
          tokensEstimated: result.usage?.completion === undefined,
          note,
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
        return version
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(String((e as Error).message || e))
        return null
      } finally {
        abortRef.current = null
        setStreaming(null)
      }
    },
    [providers, settings, context, skills, findings],
  )

  const rebuild = useCallback(async () => {
    const sheet = await run('direct')
    if (sheet) await run('draft')
  }, [run])

  const reset = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(null)
    setError(null)
    // Clears the draft, not the film: clips, plates and the film context are
    // the production and survive a reset of the page you are writing on.
    setSession((s) => ({ story: '', versions: [], currentId: null, chat: [], film: s.film, parentClipId: s.parentClipId }))
    await idb.del('sessions', 'current')
  }, [])

  // ── the render loop ───────────────────────────────────────────────────

  const clipsRef = useRef(clips)
  clipsRef.current = clips
  const platesRef = useRef(plates)
  platesRef.current = plates

  const recipe = useMemo(
    () => recipes.find((r) => r.id === settings.recipeId) ?? recipes[0] ?? null,
    [recipes, settings.recipeId],
  )
  const endpoint = useMemo(
    () => endpoints.find((e) => e.id === settings.comfyEndpointId) ?? endpoints[0] ?? null,
    [endpoints, settings.comfyEndpointId],
  )
  const clip = useMemo(
    () => clips.find((c) => c.id === currentClipId) ?? clips[clips.length - 1] ?? null,
    [clips, currentClipId],
  )
  const rendering = useMemo(() => clips.find((c) => c.id === renderingId) ?? null, [clips, renderingId])

  const lastPromptText = useMemo(() => {
    const v = [...session.versions].reverse().find((x) => PROMPT_STAGES.has(x.stage))
    return v?.text ?? (looksLikePrompt(session.story) ? session.story : '')
  }, [session.versions, session.story])

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

  const savePlate = useCallback(async (p: Plate) => {
    await idb.set('plates', p.id, p)
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
    await idb.del('plates', id)
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
    for (const p of stamped) await idb.set('plates', p.id, p)
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
      // Plates are uploaded once per box and then cited by name.
      const refs: Array<{ filename: string; subfolder: string }> = []
      for (const p of snap) {
        if (p.uploaded?.endpointId === endpoint.id) {
          refs.push({ filename: p.uploaded.filename, subfolder: p.uploaded.subfolder })
          continue
        }
        const safe = `${p.id}_${p.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 40) || 'plate'}.png`
        const up = await uploadImage(endpoint, p.dataUrl, safe)
        refs.push(up)
        await savePlate({ ...p, uploaded: { endpointId: endpoint.id, ...up } })
      }

      const graph = applyRecipe(recipe, {
        prompt,
        refs,
        width: recipe.defaults.width,
        height: recipe.defaults.height,
        frames,
        seed,
        steps: settings.steps,
      })

      const promptId = await submit(endpoint, graph)
      patchClip(id, { state: 'rendering', promptId })

      // Poll rather than hold a websocket: a dropped link must not lose a
      // render that the box is still perfectly happily producing.
      const deadline = Date.now() + 60 * 60 * 1000
      let misses = 0
      for (;;) {
        await new Promise((r) => setTimeout(r, 2500))
        if (Date.now() > deadline) throw new Error('Gave up waiting after an hour.')
        let res
        try {
          res = await poll(endpoint, promptId)
          misses = 0
        } catch {
          // The box can drop off a network and come back. Only give up when it
          // has been gone long enough to be a real outage.
          if (++misses > 120) throw new Error('Lost contact with the box for five minutes.')
          continue
        }
        if (!res.done) continue
        if (res.failed) throw new Error(res.failed)
        patchClip(id, { state: 'done', output: res.output, ms: Date.now() - t0 })
        break
      }
    } catch (e) {
      const msg = String((e as Error).message || e)
      patchClip(id, { state: 'failed', error: msg, ms: Date.now() - t0 })
      setError(msg)
    } finally {
      setRenderingId(null)
    }
  }, [endpoint, recipe, lastPromptText, settings.lockSeed, settings.seed, settings.seconds, settings.steps, patchClip, savePlate])

  const selectClip = useCallback((id: string) => setCurrentClipId(id), [])

  /**
   * Close the loop.
   *
   * The clip's last frame becomes the next clip's <Picture 1>, a hand-off
   * paragraph is written from the prompt that produced it, the role advances,
   * and the page is cleared for the next clip — with the film context, the
   * plates and the seed all carried.
   */
  const continueFrom = useCallback(
    async (clipId: string, note?: string) => {
      const c = clipsRef.current.find((x) => x.id === clipId)
      if (!c) return
      const url = clipUrl(c)
      if (!url) {
        setError('That clip has no file yet.')
        return
      }

      setError(null)
      try {
        const frame = c.lastFrame ?? (await lastFrameOf(url))
        if (!c.lastFrame) patchClip(clipId, { lastFrame: frame })

        // One replaced plate at a time — otherwise every continuation adds
        // another last frame and the nine-reference budget is gone by clip 5.
        const previous = platesRef.current.find((p) => p.mode === 'replaced')
        const plate: Plate = {
          id: previous?.id ?? `p${Date.now().toString(36)}`,
          name: `clip ${c.index} · last frame`,
          job: previous?.job?.trim()
            ? previous.job
            : 'Use it for the room, the light and where they are standing. Do not take expression from it.',
          dataUrl: frame,
          mode: 'replaced',
          fromClipId: clipId,
          addedAt: previous?.addedAt ?? 0, // stays first, so it is <Picture 1>
        }
        await savePlate(plate)
      } catch (e) {
        // A frame we cannot read is not fatal — the hand-off is still worth
        // having, and the operator can drop a still in by hand.
        setError(`Could not take the last frame: ${(e as Error).message}`)
      }

      const written = await run('handoff')
      const parsed = written ? splitHandoff(written.text) : null

      setSession((sn) => ({
        story: note?.trim() ? note.trim() : '',
        versions: [],
        currentId: null,
        chat: [],
        parentClipId: clipId,
        film: {
          ...DEFAULT_FILM,
          ...sn.film,
          role: nextRole(sn.film?.role ?? 'standalone'),
          precedes: parsed?.precedes || sn.film?.precedes || '',
          follows: parsed?.follows || '',
        },
      }))
      setCurrentClipId(clipId)
    },
    [clipUrl, patchClip, savePlate, run],
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
    error,
    failedReasoning,
    findings,
    context,
    setStory,
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
    endpoints,
    endpoint,
    comfyProbes,
    clips,
    clip,
    rendering,
    blockers,
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
    selectClip,
    continueFrom,
    cancel,
    selectVersion,
    clearError: () => {
      setError(null)
      setFailedReasoning(null)
    },
    reset,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
