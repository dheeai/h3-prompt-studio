import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { idb } from '../lib/db'
import { buildContext, type BuiltContext } from '../lib/context'
import { findingsToText, lint, looksLikePrompt } from '../lib/lint'
import { streamChat } from '../lib/llm'
import { DEFAULT_PROVIDERS, loadProviders, probe, saveProviders } from '../lib/providers'
import { DEFAULT_TEMPLATES, STAGE_LABEL, fillTemplate, hasPromptBlock, splitReply, templateFor } from '../lib/stages'
import { fetchBundledSkills, loadSkills, removeSkill, saveSkill } from '../lib/skills'
import { estTokens } from '../lib/tokens'
import type { ChatTurn, Finding, ProbeResult, Provider, Selection, Settings, Skill, StageId, Version } from '../lib/types'

const SETTINGS_SCHEMA = 4

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
}

interface Session {
  story: string
  versions: Version[]
  currentId: string | null
  /** The composer thread. Carried into every freeform turn so it continues. */
  chat?: ChatTurn[]
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
  error: string | null
  /** Thinking from a run that produced no answer, kept so it is not lost. */
  failedReasoning: string | null
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
  const [session, setSession] = useState<Session>({ story: '', versions: [], currentId: null, chat: [] })
  const [streaming, setStreaming] = useState<{ stage: StageId; text: string; reasoning: string; startedAt: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [context, setContext] = useState<BuiltContext | null>(null)
  const [failedReasoning, setFailedReasoning] = useState<string | null>(null)
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
      // Each stage wants a particular KIND of document, not simply whichever
      // pass ran last. Feeding it `current` blindly meant that after Critique,
      // Revise received the critique prose in the slot labelled PROMPT — and
      // never saw the prompt at all.
      const lastOf = (st: StageId) => [...session.versions].reverse().find((v) => v.stage === st) ?? null
      const lastPrompt = () => [...session.versions].reverse().find((v) => PROMPT_STAGES.has(v.stage)) ?? null

      let working: string
      if (stage === 'direct') {
        working = ''
      } else if (stage === 'draft') {
        // Prefer a direction sheet — the one you are reading, else the latest.
        working = (current?.stage === 'direct' ? current.text : lastOf('direct')?.text) ?? session.story
      } else {
        // Critique, Revise and a freeform note all operate on the prompt.
        working =
          (current && PROMPT_STAGES.has(current.stage) ? current.text : lastPrompt()?.text) ??
          (looksLikePrompt(session.story) ? session.story : '')
      }

      if (!session.story.trim() && !session.versions.length) return setError('Paste something first.')
      if (stage !== 'direct' && !working.trim()) {
        return setError(
          stage === 'draft'
            ? 'Nothing to draft from yet.'
            : `${STAGE_LABEL[stage]} works on a prompt, and there isn’t one yet. Paste one, or run Draft first.`,
        )
      }

      // The model's review against the loaded skills is the substance of a
      // revise pass; the deterministic rules are a small mechanical extra.
      const critiqueText = lastOf('critique')?.text ?? ''

      const ctx = context ?? (await buildContext(skills, settings.selection))
      const template = templateFor(settings.stageTemplates, stage)
      const user = fillTemplate(template, {
        story: session.story,
        current: working,
        mode: settings.mode,
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
                  ...(session.chat ?? []).map((t) => ({ role: t.role, content: t.text })),
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
          return
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
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(null)
    setError(null)
    setSession({ story: '', versions: [], currentId: null, chat: [] })
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
    chat: session.chat ?? [],
    error,
    failedReasoning,
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
    clearError: () => {
      setError(null)
      setFailedReasoning(null)
    },
    reset,
  }

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}
