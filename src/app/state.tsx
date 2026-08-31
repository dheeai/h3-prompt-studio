import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, type BuiltContext } from '../lib/context'
import { findingsToText, lint, looksLikePrompt } from '../lib/lint'
import { streamChat } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders } from '../lib/providers'
import { DEFAULT_TEMPLATES, STAGE_LABEL, fillTemplate } from '../lib/stages'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import type { Finding, ProbeResult, Provider, Selection, Settings, Skill, StageId, Version } from '../lib/types'

const SETTINGS_SCHEMA = 2

const DEFAULT_SETTINGS: Settings = {
  schema: SETTINGS_SCHEMA,
  providerId: 'ollama',
  model: '',
  temperature: 0.35,
  // A six-section Ref2VA prompt is long, and a reasoning model spends tokens
  // thinking before it writes a word. A tight ceiling does not shorten the
  // answer — it cuts the model off mid-thought and returns a truncated or
  // empty string.
  maxTokens: 65536,
  mode: 'Ref2VA',
  selection: {},
  stageTemplates: { ...DEFAULT_TEMPLATES },
  onboarded: false,
}

interface Session {
  story: string
  versions: Version[]
  currentId: string | null
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
  streaming: { stage: StageId; text: string; reasoning: string } | null
  error: string | null
  findings: Finding[]
  context: BuiltContext | null

  setStory: (s: string) => void
  patchSettings: (p: Partial<Settings>) => void
  toggleSkill: (skill: Skill) => void
  toggleFile: (skill: Skill, rel: string) => void
  addSkills: (skills: Skill[]) => Promise<void>
  deleteSkill: (id: string) => Promise<void>
  setProviders: (p: Provider[]) => Promise<void>
  refreshProbe: (id: string) => Promise<void>
  run: (stage: StageId, note?: string) => Promise<void>
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
  const [session, setSession] = useState<Session>({ story: '', versions: [], currentId: null })
  const [streaming, setStreaming] = useState<{ stage: StageId; text: string; reasoning: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const abortRef = useRef<AbortController | null>(null)

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
        stageTemplates: { ...DEFAULT_TEMPLATES, ...(savedSettings?.stageTemplates || {}) },
        seenBundled: [...new Set([...(savedSettings?.seenBundled ?? []), ...bundledIds])],
      }

      // Settings persist per browser, so raising a default only reaches people
      // who have never opened the app. Anyone already carrying the old 4096
      // ceiling needs it lifted explicitly — once, without stamping on a limit
      // they set deliberately later.
      if ((savedSettings?.schema ?? 1) < SETTINGS_SCHEMA) {
        if (merged.maxTokens < 16384) merged.maxTokens = DEFAULT_SETTINGS.maxTokens
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
    if (streaming?.text) return lint(streaming.text, settings.mode)
    // A direction sheet is not a prompt, so the prompt rules do not apply.
    if (current) return current.stage === 'direct' ? [] : lint(current.text, settings.mode)
    // No pass has run yet. If what was pasted is already a prompt, check it
    // now rather than making the user run a stage to find that out.
    return looksLikePrompt(session.story) ? lint(session.story, settings.mode) : []
  }, [current, streaming, settings.mode, session.story])

  // ── actions ───────────────────────────────────────────────────────────
  const patchSettings = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])

  const setStory = useCallback((story: string) => setSession((s) => ({ ...s, story })), [])

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
    async (stage: StageId, note?: string) => {
      const provider = providers.find((p) => p.id === settings.providerId)
      if (!provider) return setError('Pick a provider first.')
      if (!settings.model) return setError('Pick a model first.')

      // Stages after Direct work on a document. Usually that is the previous
      // pass — but when someone pastes a finished prompt and asks for a
      // critique straight away, the source IS the document. Without this the
      // template's PROMPT section went out empty and the model was asked to
      // audit nothing.
      const working = current?.text ?? (stage === 'direct' ? '' : session.story)
      if (!session.story.trim() && !current) return setError('Paste something first.')
      if (stage !== 'direct' && !working.trim()) return setError('Nothing to work on yet.')

      // Critique and Revise audit a prompt's field structure. Pointed at a
      // direction sheet they produce confident findings about fields that were
      // never supposed to be there.
      if (stage === 'critique' || stage === 'revise' || stage === 'freeform') {
        const isPrompt = current ? current.stage !== 'direct' : looksLikePrompt(session.story)
        if (!isPrompt) {
          return setError(
            current
              ? `${STAGE_LABEL[stage]} works on a prompt, but the page currently holds a direction sheet. Run Draft first.`
              : `${STAGE_LABEL[stage]} works on a prompt. Paste one, or run Direct and then Draft.`,
          )
        }
      }

      const ctx = context ?? (await buildContext(skills, settings.selection))
      const template = settings.stageTemplates[stage] || DEFAULT_TEMPLATES[stage]
      const user = fillTemplate(template, {
        story: session.story,
        current: working,
        mode: settings.mode,
        notes: note,
        findings: findings.length ? findingsToText(findings) : undefined,
      })

      const ac = new AbortController()
      abortRef.current = ac
      setStreaming({ stage, text: '', reasoning: '' })
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
          messages: [
            { role: 'system', content: ctx.text },
            { role: 'user', content: user },
          ],
          onDelta: (chunk) => setStreaming((s) => (s ? { ...s, text: s.text + chunk } : s)),
          onReasoning: (chunk) => setStreaming((s) => (s ? { ...s, reasoning: s.reasoning + chunk } : s)),
        })

        if (!result.text.trim()) {
          throw new Error(
            result.reasoning.trim()
              ? 'The model spent its whole budget thinking and never wrote an answer. Raise max tokens.'
              : 'The model returned nothing.',
          )
        }

        const version: Version = {
          id: `v${Date.now().toString(36)}`,
          stage,
          label: STAGE_LABEL[stage],
          text: result.text.trim(),
          model: settings.model,
          providerId: provider.id,
          at: Date.now(),
          ms: result.ms,
          reasoning: result.reasoning.trim() || undefined,
          note,
        }
        setSession((s) => ({ ...s, versions: [...s.versions, version], currentId: version.id }))
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(String((e as Error).message || e))
      } finally {
        abortRef.current = null
        setStreaming(null)
      }
    },
    [providers, settings, session.story, current, context, skills, findings],
  )

  const reset = useCallback(async () => {
    setSession({ story: '', versions: [], currentId: null })
    await idb.del('sessions', 'current')
  }, [])

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
    error,
    findings,
    context,
    setStory,
    patchSettings,
    toggleSkill,
    toggleFile,
    addSkills,
    deleteSkill,
    setProviders,
    refreshProbe,
    run,
    cancel,
    selectVersion,
    clearError: () => setError(null),
    reset,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
