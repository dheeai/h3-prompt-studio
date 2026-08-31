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

const DEFAULT_SETTINGS: Settings = {
  providerId: 'ollama',
  model: '',
  temperature: 0.35,
  maxTokens: 4096,
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
  streaming: { stage: StageId; text: string } | null
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
  const [streaming, setStreaming] = useState<{ stage: StageId; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // ── boot ──────────────────────────────────────────────────────────────
  useEffect(() => {
    ;(async () => {
      const [savedSettings, savedSession, savedProviders] = await Promise.all([
        idb.get<Settings>('settings', 'settings'),
        idb.get<Session>('sessions', 'current'),
        loadProviders(),
      ])
      let stored = await loadSkills()

      // First visit: pull in whatever this deployment ships with.
      if (!stored.length) {
        const bundled = await fetchBundledSkills()
        for (const s of bundled) await saveSkill(s)
        stored = bundled
      }

      const merged: Settings = {
        ...DEFAULT_SETTINGS,
        ...savedSettings,
        stageTemplates: { ...DEFAULT_TEMPLATES, ...(savedSettings?.stageTemplates || {}) },
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
      setStreaming({ stage, text: '' })
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
        })

        if (!result.text.trim()) throw new Error('The model returned nothing. Reasoning models truncate badly — try raising max tokens.')

        const version: Version = {
          id: `v${Date.now().toString(36)}`,
          stage,
          label: STAGE_LABEL[stage],
          text: result.text.trim(),
          model: settings.model,
          providerId: provider.id,
          at: Date.now(),
          ms: result.ms,
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
