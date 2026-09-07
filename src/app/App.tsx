import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './state'
import { Marginalia } from '../components/Marginalia'
import { Legend, PromptDoc } from '../components/PromptDoc'
import { Explanation } from '../components/Explanation'
import { ClipPlan } from '../components/ClipPlan'
import { DiffView } from '../components/DiffView'
import { ProseDoc } from '../components/ProseDoc'
import { ConnectPanel } from '../components/ConnectPanel'
import { SkillsPanel } from '../components/SkillsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { PlatesPanel } from '../components/PlatesPanel'
import { RecipePanel } from '../components/RecipePanel'
import { EndpointPanel } from '../components/RenderPanel'
import { ClipPlayer, FilmStrip } from '../components/ClipDeck'
import { AgentPanel } from '../components/AgentPanel'
import { STAGE_LABEL, splitReply } from '../lib/stages'
import { skillTokens } from '../lib/skills'
import { estTokens, fmtTokens } from '../lib/tokens'
import { wasSent } from '../lib/context'
import { classifyInput, looksLikePrompt } from '../lib/lint'
import { ENTRY_MODES, entryMode, entryStartCopy, entryWorkflow, shouldContinueStoryLoop, type EntryModeId } from '../lib/entry'
import { displayedStudioPass, runStatusText, studioActions, type StudioActionId } from '../lib/studio-workflow'
import type { StageId } from '../lib/types'

/** Stages whose output is a prompt — the only things worth diffing together. */
const PROMPT_STAGES_UI = new Set<StageId>(['draft', 'revise', 'rebuild', 'freeform'])

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: 'quiet drama',
    text: 'Lira finds the last fragment in the gantry bay. She already knows what it means — the layer never closed. She doesn’t say anything about it. She just stops moving, and the cold does the rest.',
  },
  {
    label: 'product film',
    text: 'A pair of hands unboxes a small brushed-aluminium sensor, sets it on a workbench, and taps once. A row of lights wakes across it. The bench is dark; the light is the only event.',
  },
  {
    label: 'title sequence',
    text: 'Nine seconds of flat-vector motion that spells out a studio name one letter at a time, each letter arriving on a hard colour-field wipe, ending on a locked-off lockup.',
  },
]

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

export function App() {
  const app = useApp()
  const { ready, skills, settings, providers, probes, story, versions, current, streaming, chat, film, error, failedReasoning, interruptedReasoning, continuation, context, studioMode: entryModeId } = app
  const { clips, rendering } = app
  const [modal, setModal] = useState<'connect' | 'skills' | 'settings' | 'plates' | 'recipe' | 'endpoint' | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const [editingSource, setEditingSource] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [view, setView] = useState<'result' | 'diff'>('result')
  const [filmOpen, setFilmOpen] = useState(false)
  const [workspace, setWorkspace] = useState<'studio' | 'agent'>('studio')
  const [promptLoop, setPromptLoop] = useState<{ index: number; total: number; stage: 'direct' | 'draft' } | null>(null)
  const promptLoopStopRef = useRef(false)
  const thinkRef = useRef<HTMLDivElement>(null)
  const storyRef = useRef<HTMLTextAreaElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const docRef = useRef<HTMLDivElement>(null)

  const provider = providers.find((p) => p.id === settings.providerId)
  const probe = provider ? probes[provider.id] : undefined
  const connected = probe?.state === 'ok' && !!settings.model
  const busy = !!streaming
  const activeContinuation = app.clip && continuation?.clipId === app.clip.id ? continuation : null

  // A pasted prompt does not need directing — the useful next move is a
  // critique of what is already there.
  const pastedPrompt = !current && !streaming && looksLikePrompt(story)

  // A deterministic read of what has been pasted — no model involved. It is
  // shown to the operator directly (the Standing strip) and handed to the
  // model as {{standing}} so Direct can confirm or correct it.
  const standing = useMemo(() => classifyInput(story), [story])

  useEffect(() => autosize(storyRef.current), [story, ready, editingSource])

  // The serif loads from Google Fonts after first paint, so the first measure
  // is taken against the fallback metrics and leaves the box the wrong height.
  useEffect(() => {
    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) autosize(storyRef.current)
    })
    return () => {
      cancelled = true
    }
  }, [ready])
  useEffect(() => autosize(noteRef.current), [note])
  useEffect(() => setView('result'), [current?.id])

  // Deltas can arrive in bursts, so the rate would freeze between them
  // without a clock of its own.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!streaming) return
    const t = setInterval(() => setTick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [streaming])

  // While the model is still thinking there is nothing else to look at, so the
  // panel opens itself — and folds away once real output starts arriving.
  useEffect(() => {
    if (streaming?.reasoning && !streaming.text) setThinkOpen(true)
    if (streaming?.text) setThinkOpen(false)
  }, [streaming?.reasoning, streaming?.text])

  useEffect(() => {
    const el = thinkRef.current
    if (el && thinkOpen) el.scrollTop = el.scrollHeight
  }, [streaming?.reasoning, thinkOpen])

  // Follow the stream, but only while the user is already at the bottom.
  useEffect(() => {
    const el = docRef.current
    if (!el || !streaming) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    if (nearBottom) el.scrollTop = el.scrollHeight
  }, [streaming])

  const send = () => {
    const text = note.trim()
    if (!text || busy || !connected) return
    setNote('')
    void app.run('freeform', text, { studioMode: entryModeId })
  }

  const startFromEntry = async () => {
    if (!story.trim() || busy || !connected) return
    const workflow = entryWorkflow(entryModeId)
    if (workflow === 'story-plan') {
      // Story's primary action deliberately stops at the clip plan. A
      // separate explicit action below starts the multi-call authoring loop.
      await app.run('breakdown', undefined, { studioMode: 'story' })
    } else if (workflow === 'prompt-revise') {
      await app.run('revise', undefined, { studioMode: 'prompt' })
    } else {
      // Idea mode is a single guided action: Direct gives the model a
      // direction sheet, then Draft turns that sheet into the canonical H3
      // prompt. Both passes remain in history for inspection.
      await app.rebuild('idea')
    }
  }

  const generateAllPrompts = async () => {
    const plan = app.breakdown
    if (!plan?.clips.length || busy || !connected) return
    promptLoopStopRef.current = false
    try {
      for (const [i, clip] of plan.clips.entries()) {
        if (promptLoopStopRef.current) break
        app.setFilm({
          role: clip.role,
          spine: plan.spine,
          precedes: clip.precedes,
          follows: clip.follows,
          covers: clip.covers,
          title: clip.title,
          clipIndex: clip.index,
        })
        setPromptLoop({ index: i + 1, total: plan.clips.length, stage: 'direct' })
        const sheet = await app.run('direct', undefined, { studioMode: 'story' })
        if (promptLoopStopRef.current || !sheet || !shouldContinueStoryLoop({ status: 'ok' })) break
        setPromptLoop({ index: i + 1, total: plan.clips.length, stage: 'draft' })
        const prompt = await app.run('draft', undefined, { studioMode: 'story', current: sheet.text })
        if (promptLoopStopRef.current || !shouldContinueStoryLoop({ status: prompt ? 'ok' : 'null' })) break
      }
    } finally {
      setPromptLoop(null)
    }
  }

  const stopPromptLoop = () => {
    promptLoopStopRef.current = true
    if (busy) app.cancel()
    setPromptLoop(null)
  }

  const activeEntry = entryMode(entryModeId)
  const visibleActions = useMemo(() => studioActions(entryModeId, !!app.breakdown), [entryModeId, app.breakdown])
  const primaryAction = visibleActions[0]

  const generateSelectedPrompt = async () => {
    const plan = app.breakdown
    if (!plan?.clips.length || busy || !connected) return
    const selected = plan.clips.find((clip) => clip.index === film.clipIndex) ?? plan.clips[0]
    app.setFilm({
      role: selected.role,
      spine: plan.spine,
      precedes: selected.precedes,
      follows: selected.follows,
      covers: selected.covers,
      title: selected.title,
      clipIndex: selected.index,
    })
    await app.rebuild('story')
  }

  const runVisibleAction = async (id: StudioActionId) => {
    if (id === 'generate-selected') return generateSelectedPrompt()
    if (id === 'generate-all') return generateAllPrompts()
    if (id === 'rebuild') return app.rebuild('prompt')
    return startFromEntry()
  }

  const focusEntryTab = (id: EntryModeId) => {
    app.setStudioMode(id)
    // Roving tab stops are only useful when the newly selected tab also owns
    // DOM focus. Defer until React has committed the selected tab's tabIndex.
    window.requestAnimationFrame(() => document.getElementById(`entry-${id}-tab`)?.focus())
  }

  // The visible entry CTA and Cmd/Ctrl+Enter intentionally share this one
  // dispatcher so the keyboard shortcut cannot silently run a different
  // stage than the selected Story/Prompt/Idea workflow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (primaryAction) void runVisibleAction(primaryAction.id)
      }
      if (e.key === 'Escape' && promptLoop) stopPromptLoop()
      else if (e.key === 'Escape' && busy) app.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app, busy, primaryAction, promptLoop, runVisibleAction, stopPromptLoop])

  // When a finished prompt is pasted it IS the document — show it typeset
  // rather than leaving the page looking empty below a wall of source text.
  // `||` rather than `??` on purpose: at the instant a run starts the stream
  // holds an empty string, which `??` would happily show — blanking the page
  // until the first token lands. Keep the previous pass up until then.
  const displayedPass = displayedStudioPass(
    streaming ? { stage: streaming.stage, text: streaming.text } : null,
    current ? { stage: current.stage, text: current.text } : null,
    pastedPrompt ? 'draft' : 'direct',
  )
  const shown = displayedPass.text || (!streaming && pastedPrompt ? story : '')
  const reasoningInterrupted = !streaming && !!interruptedReasoning
  const reasoning = streaming ? streaming.reasoning : (interruptedReasoning ?? failedReasoning ?? current?.reasoning ?? '')
  const reasoningStreaming = !!streaming && !streaming.text

  // Live counts. Estimated while streaming — servers only report real usage at
  // the end, if at all — so the number is always labelled as such.
  const live = streaming
    ? (() => {
        const secs = Math.max(0.001, (Date.now() - streaming.startedAt) / 1000)
        const think = estTokens(streaming.reasoning)
        const answer = estTokens(streaming.text)
        return { think, answer, total: think + answer, rate: Math.round((think + answer) / secs), secs }
      })()
    : null
  // A pass can only be diffed against what it actually worked from.
  // What a pass should be compared against is the previous PROMPT, not
  // whatever it happened to consume. A rebuild reads a direction sheet, so
  // diffing against its input compared a sheet to a prompt — the one case
  // where the diff matters most produced nothing worth reading.
  const diffable = useMemo(() => {
    if (streaming || !current) return null
    if (PROMPT_STAGES_UI.has(current.stage)) {
      const i = versions.findIndex((v) => v.id === current.id)
      const prev = [...versions.slice(0, i)].reverse().find((v) => PROMPT_STAGES_UI.has(v.stage))
      if (prev) {
        return { before: prev.text, after: current.text, label: `pass ${versions.indexOf(prev) + 1} · ${STAGE_LABEL[prev.stage]}` }
      }
      if (looksLikePrompt(story)) return { before: story, after: current.text, label: 'the prompt you pasted' }
      // Nothing to compare a first draft against — it came from a story.
      return null
    }
    return current.fromText ? { before: current.fromText, after: current.text, label: 'its input' } : null
  }, [streaming, current, versions, story])

  // Direct and Critique return prose. Rendering markdown as one monospace
  // block made a structured critique read as an undifferentiated wall.
  const shownStage: StageId = displayedPass.stage
  const shownIsProse = shownStage !== 'draft' && shownStage !== 'revise' && shownStage !== 'rebuild' && shownStage !== 'freeform'
  const longSource = story.length > 600
  const collapseSource = (pastedPrompt || longSource) && !editingSource
  const loadedSkills = skills.filter((s) => settings.selection[s.id]?.length)

  // Draft, Revise and freeform return the prompt and its explanation as two
  // marked (or JSON) blocks. While streaming those markers are still sitting
  // in the raw text, so the live text is split too — this is what keeps the
  // prompt section filling in first and the explanation arriving separately,
  // rather than showing the reader the markers themselves.
  const isSplitStage = shownStage === 'draft' || shownStage === 'revise' || shownStage === 'rebuild' || shownStage === 'freeform'
  const liveSplit = useMemo(() => (isSplitStage && streaming?.text ? splitReply(streaming.text) : null), [isSplitStage, streaming])
  const canonicalVersion = useMemo(() => {
    if (current && PROMPT_STAGES_UI.has(current.stage)) return current
    return [...versions].reverse().find((v) => PROMPT_STAGES_UI.has(v.stage)) ?? null
  }, [current, versions])
  const canonicalPrompt = canonicalVersion?.text ?? (looksLikePrompt(story) ? story : '')
  // The canonical prompt is the only copy/lint/render payload. The visible
  // document may be a direction sheet, critique, hand-off, or clip plan, but
  // those are never valid substitutes for the current H3 prompt.
  const promptText = liveSplit ? liveSplit.prompt : canonicalPrompt
  const explanationText = liveSplit ? liveSplit.explanation : canonicalVersion?.explanation ?? ''
  const changelogList = liveSplit ? liveSplit.changelog : canonicalVersion?.changelog

  // What "Copy prompt" copies, and what the linter runs on, must be the
  // prompt alone — never the explanation, never a raw marker.
  const copy = async () => {
    if (!promptText || streaming) return
    await navigator.clipboard.writeText(promptText)
    setCopied(true)
    setTimeout(() => setCopied(false), 1400)
  }

  if (!ready) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="tok">loading…</span>
      </div>
    )
  }

  return (
    <div className="app studio-app">
      <header className="studio-topbar">
        <div className="studio-wordmark"><span className="studio-mark">H3</span><span>Prompt Studio</span></div>
        <nav className="workspace-tabs" aria-label="Workspace">
          <button className={workspace === 'studio' ? 'active' : ''} aria-current={workspace === 'studio' ? 'page' : undefined} onClick={() => setWorkspace('studio')}>Studio</button>
          <button className={workspace === 'agent' ? 'active' : ''} aria-current={workspace === 'agent' ? 'page' : undefined} onClick={() => setWorkspace('agent')}>Agent <span>(beta)</span></button>
        </nav>
        <div className="studio-project">{film.spine || (current ? `${STAGE_LABEL[current.stage]} · pass ${versions.length}` : '')}</div>
        <div className="studio-grow" />
        <button className="studio-health" onClick={() => setModal('connect')} title="Connect a model">
          <span className={`studio-health-dot ${connected ? 'ok' : 'idle'}`} />
          {connected ? `${settings.model} ready` : 'Connect model'}
        </button>
        <button className="studio-top-action" onClick={() => setModal('skills')}>Skills <span>{loadedSkills.length}</span></button>
        <button className="studio-top-action" onClick={() => setModal('settings')}>Settings</button>
        {confirmClear ? (
          <div className="studio-clear-confirm" role="status">
            <span className="tok">discard {versions.length} pass{versions.length === 1 ? '' : 'es'}?</span>
            <button className="btn pri sm" onClick={() => { void app.reset(); setConfirmClear(false); setEditingSource(false) }}>Discard</button>
            <button className="btn ghost sm" onClick={() => setConfirmClear(false)}>Keep</button>
          </div>
        ) : (
          <button className="studio-top-action" onClick={() => (versions.length || story ? setConfirmClear(true) : undefined)} disabled={!versions.length && !story}>New draft</button>
        )}
      </header>

      <div className={`workspace-view ${workspace === 'studio' ? 'is-active' : 'is-hidden'}`} aria-hidden={workspace !== 'studio'}>
      <nav className="entry-tabs" role="tablist" aria-label="Choose how to start">
        <div className="entry-label">Start with</div>
        {ENTRY_MODES.map((mode) => (
          <button
            key={mode.id}
            id={`entry-${mode.id}-tab`}
            className="entry-tab"
            role="tab"
            aria-selected={entryModeId === mode.id}
            aria-controls="studio-workspace"
            tabIndex={entryModeId === mode.id ? 0 : -1}
            onClick={() => focusEntryTab(mode.id)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                e.preventDefault()
                focusEntryTab(ENTRY_MODES[(ENTRY_MODES.findIndex((m) => m.id === mode.id) + 1) % ENTRY_MODES.length].id)
              }
              if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                e.preventDefault()
                focusEntryTab(ENTRY_MODES[(ENTRY_MODES.findIndex((m) => m.id === mode.id) + ENTRY_MODES.length - 1) % ENTRY_MODES.length].id)
              }
            }}
          >
            <strong>{mode.label}</strong><span>{mode.description}</span>
          </button>
        ))}
      </nav>

      <div className="studio-reading">
        <span className="lbl">Reading</span>
        <div className="studio-skill-list">
          {skills.map((s) => {
            const sel = settings.selection[s.id] || []
            const cls = sel.length === 0 ? 'off' : sel.length === s.files.length ? 'on' : 'part'
            return (
              <button key={s.id} className={`chip ${cls}`} onClick={() => app.toggleSkill(s)} title={s.description}>
                {s.name}{sel.length > 0 && <span className="tok">{fmtTokens(skillTokens(s, sel))}</span>}
              </button>
            )
          })}
        </div>
        <button className="chip off" onClick={() => setModal('skills')}>＋ manage skills</button>
        <div className="studio-grow" />
        {context && <span className="tok studio-context">{fmtTokens(context.tokens)} est. · {loadedSkills.length} loaded · {wasSent(context.hash) ? 'cached' : 'not sent yet'}</span>}
      </div>

      <main className="studio-main" id="studio-workspace" role="tabpanel" aria-labelledby={`entry-${entryModeId}-tab`}>
        <section className="studio-source" aria-label="Source and clip plan">
          <div className="studio-panel-head">
            <div className="studio-kicker">01 · SOURCE</div>
            <div className="studio-title-row"><h2>{activeEntry.title}</h2><span className="studio-kicker">{story.length.toLocaleString()} chars</span></div>
          </div>
          <div className="studio-source-editor">
            {collapseSource ? (
              <div className={`studio-source-preview ${pastedPrompt ? 'one' : 'two'}`} onClick={() => setEditingSource(true)} role="textbox" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setEditingSource(true) }}>
                {story || activeEntry.placeholder}
              </div>
            ) : (
              <textarea ref={storyRef} value={story} onChange={(e) => app.setStory(e.target.value)} placeholder={activeEntry.placeholder} rows={4} aria-label={activeEntry.title} />
            )}
            <div className="studio-source-hint">{activeEntry.id === 'story' ? 'H3 will divide this into dramatic units, then keep continuity across the resulting prompts.' : activeEntry.id === 'prompt' ? 'Skills preserve your intent while repairing structure, timing, and model-specific weaknesses.' : 'One sentence is enough; the skills will supply shot logic and sound.'}</div>
            <button className="studio-source-action" onClick={() => primaryAction && void runVisibleAction(primaryAction.id)} disabled={!story.trim() || busy || !connected}>
              <span>{busy && streaming ? runStatusText(streaming.stage, streaming.phase, streaming.continuations) : primaryAction?.label ?? activeEntry.action}</span><span className="tok">⌘ ↵</span>
            </button>
            <div className="studio-source-secondary">
              {busy ? <button className="btn sm ghost" onClick={promptLoop ? stopPromptLoop : app.cancel}>Stop</button> : visibleActions.slice(1).map((action) => (
                <button key={action.id} className="btn sm ghost" onClick={() => void runVisibleAction(action.id)} disabled={!story.trim() || !connected}>
                  {action.label}
                </button>
              ))}
              <span className="tok">{entryModeId === 'story' ? 'Plan first, then author selected or all prompts.' : entryModeId === 'prompt' ? 'Both operations return one canonical prompt.' : 'The generated prompt becomes the current render payload.'}</span>
            </div>
            {promptLoop && <div className="studio-loop-progress" role="status" aria-live="polite"><span>Prompt {promptLoop.index}/{promptLoop.total}</span><strong>Authoring</strong><span className="tok">Stop to leave the last successful prompt in place.</span></div>}
            {!story && <div className="studio-examples"><span className="tok">try</span>{EXAMPLES.map((ex) => <button key={ex.label} className="btn sm ghost" onClick={() => app.setStory(ex.text)}>{ex.label}</button>)}</div>}
          </div>

          {story.trim() && <div className="studio-standing"><div className="studio-standing-head"><span className="studio-kicker">STANDING</span><strong>{standing.kind}</strong><span className="tok">{standing.confidence} confidence</span></div><div className="studio-standing-copy">{standing.stands}</div><div className="studio-standing-facts"><span><b>has</b> {standing.has.length ? standing.has.join(', ') : 'nothing yet'}</span><span><b>lacks</b> {standing.lacks.length ? standing.lacks.join(', ') : 'nothing'}</span></div><button className="chip" disabled={busy || !connected || !primaryAction} onClick={() => primaryAction && void runVisibleAction(primaryAction.id)}>next: {primaryAction?.label ?? activeEntry.action} →</button></div>}

          {filmOpen && (
            <div className="studio-film-context">
              <div className="tok">A clip inside a film should carry the film forward. Set its role and hand-off context here.</div>
              <div className="studio-role-row">{(['standalone', 'opening', 'rising', 'turn', 'falling', 'closing'] as const).map((r) => <button key={r} className={`chip${film.role === r ? ' on' : ''}`} onClick={() => app.setFilm({ role: r })}>{r}</button>)}</div>
              {film.role !== 'standalone' && <div className="studio-film-inputs"><input value={film.spine} onChange={(e) => app.setFilm({ spine: e.target.value })} placeholder="The whole film, in one line" /><input value={film.precedes} onChange={(e) => app.setFilm({ precedes: e.target.value })} placeholder="What the audience has just seen" /><input value={film.follows} onChange={(e) => app.setFilm({ follows: e.target.value })} placeholder="What the next clip has to open on" /></div>}
            </div>
          )}

          <div className="studio-clip-rail">
            <div className="studio-clips-head"><span>CLIP PLAN</span><button className="chip off" onClick={() => setFilmOpen((v) => !v)}>{film.role === 'standalone' ? 'standalone' : `film · ${film.role}`}</button></div>
            {app.breakdown?.clips.map((c) => {
              const v = [...versions].reverse().find((x) => x.clipIndex === c.index && PROMPT_STAGES_UI.has(x.stage))
              const active = film.clipIndex === c.index
              return <button className="studio-clip-row" key={c.index} aria-current={active} onClick={() => { if (v) app.selectVersion(v.id); app.setFilm({ role: c.role, spine: app.breakdown?.spine ?? '', precedes: c.precedes, follows: c.follows, covers: c.covers, title: c.title, clipIndex: c.index }) }}><span className="studio-clip-no">{String(c.index).padStart(2, '0')}</span><span className="studio-clip-copy"><strong>{c.title || `Clip ${c.index}`}</strong><span>{c.covers || c.role}</span></span><span className={`studio-clip-state ${v ? 'ready' : ''}`}>{v ? 'ready' : `${c.seconds}s`}</span></button>
            })}
            {!app.breakdown && clips.length === 0 && <div className="studio-empty-rail">Generate a plan or render a prompt to start a clip rail.</div>}
            {!app.breakdown && clips.map((c) => <button className="studio-clip-row" key={c.id} aria-current={c.id === app.clip?.id} onClick={() => app.selectClip(c.id)}><span className="studio-clip-no">{String(c.index).padStart(2, '0')}</span><span className="studio-clip-copy"><strong>Clip {c.index}</strong><span>{c.film?.role || 'standalone'} · {c.state}</span></span><span className="studio-clip-state">{c.frames ? `${(c.frames / (c.fps || 24)).toFixed(1)}s` : 'draft'}</span></button>)}
          </div>

          {app.breakdown && <div className="studio-plan-details"><ClipPlan /></div>}
          <div className="studio-source-clip"><ClipPlayer /></div>
        </section>

        <section className="studio-prompt" aria-label="Current H3 prompt">
          <div className="studio-prompt-head">
            <div>
              <div className="studio-kicker">02 · CANONICAL PROMPT</div>
              <div className="studio-title-row"><h2>{current && PROMPT_STAGES_UI.has(current.stage) ? STAGE_LABEL[current.stage] : 'Current H3 prompt'}</h2><span className="studio-pass-count">{current ? `v${versions.findIndex((v) => v.id === current.id) + 1}` : 'unrefined'}</span></div>
              <div className="studio-canonical"><span className="studio-canonical-dot" />Current prompt · this is what Copy, Lint, and Render use</div>
              <div className="studio-context-line">Context: {film.role === 'standalone' ? 'standalone clip' : `${film.role} · ${film.spine || 'film context'}`}{film.precedes ? ' + previous ending state' : ''}</div>
            </div>
            <div className="studio-version-menu" aria-label="Prompt history">
              {versions.length > 0 && <select value={current?.id ?? ''} onChange={(e) => app.selectVersion(e.target.value)} aria-label="Select prompt version">{versions.map((v, i) => <option key={v.id} value={v.id}>v{i + 1} · {STAGE_LABEL[v.stage]}{v.note ? ` · ${v.note.slice(0, 18)}` : ''}</option>)}</select>}
            </div>
          </div>

          <div className="studio-workflow-tools" aria-label={`${activeEntry.label} workflow`}>
            <div>
              <div className="studio-kicker">WORKFLOW</div>
              <div className="studio-workflow-summary">
                {entryModeId === 'story'
                  ? app.breakdown ? 'Plan ready · choose a prompt to author' : 'Source → clip plan'
                  : entryModeId === 'prompt' ? 'Source → canonical replacement' : 'Idea → canonical prompt'}
              </div>
            </div>
            <div className="studio-workflow-note">
              {entryModeId === 'prompt' ? 'Revise and Rebuild each run once; chat continues from the latest canonical prompt.' : 'Quality passes stay bounded and internal; the current prompt is always the render payload.'}
            </div>
            {streaming && <div className="studio-run-status" role="status" aria-live="polite"><span className="spin" /><strong>{runStatusText(streaming.stage, streaming.phase, streaming.continuations)}</strong></div>}
          </div>

          <div className="studio-doc-tools"><button className={`studio-quiet-action${view === 'result' ? ' active' : ''}`} onClick={() => setView('result')}>Result</button>{diffable && <button className={`studio-quiet-action${view === 'diff' ? ' active' : ''}`} onClick={() => setView('diff')}>Compare{current?.changelog?.length ? ` · ${current.changelog.length}` : ''}</button>}<button className="studio-quiet-action" onClick={() => void copy()} disabled={!!streaming || !promptText}>{copied ? 'Copied' : 'Copy prompt'}</button></div>

          <div className="studio-doc" ref={docRef}>
            {reasoning && <div className="think"><div className="think-head" onClick={() => setThinkOpen((v) => !v)}><span className="tok">{thinkOpen ? '▾' : '▸'}</span><span className="lbl">{reasoningInterrupted ? 'Interrupted thinking' : 'Thinking'}</span><span className="tok">{streaming ? `~${fmtTokens(live!.think)} tokens · ${live!.secs.toFixed(0)}s` : reasoningInterrupted ? 'stopped · not part of the prompt' : `~${fmtTokens(estTokens(reasoning))} tokens, not part of the prompt`}</span>{reasoningStreaming && <span className="spin" />}</div>{thinkOpen && <div className="think-body" ref={thinkRef}>{reasoning}{reasoningStreaming && <span className="think-caret" />}</div>}</div>}
            {current?.truncated && !streaming && <div className="alert warn">Cut off by the server’s output cap after {current.continuations ?? 0} continuation{current.continuations === 1 ? '' : 's'} — this text may be incomplete.</div>}
            {promptText ? (
              <div className="studio-canonical-document">
                <div className="studio-canonical-document-label">CURRENT PROMPT PAYLOAD · copy / lint / render</div>
                <Legend text={promptText} />
                <PromptDoc text={promptText} streaming={!!streaming && !shownIsProse} />
                <Explanation text={explanationText} changelog={changelogList} streaming={!!streaming && !shownIsProse} />
              </div>
            ) : !shown && !reasoning ? (
              <div className="studio-empty-prompt"><div className="studio-kicker">THE CANONICAL PROMPT APPEARS HERE</div><p>{entryStartCopy()} Your current version stays singular and is the only text sent to Render.</p><div className="studio-format-preview"><span>integrated_multimodal_description:</span> timed cuts, camera, blocking<br /><span>overall_soundscape:</span> concrete sources, placed in time<br /><span>non_diegetic_music:</span> <em>N/A</em></div></div>
            ) : null}
            {shownIsProse && shown && <div className="studio-pass-preview"><div className="studio-canonical-document-label">PASS OUTPUT · {STAGE_LABEL[shownStage]} · inspect-only</div><ProseDoc text={shown} streaming={!!streaming} /></div>}
            {diffable && view === 'diff' && <div className="studio-pass-preview"><div className="studio-canonical-document-label">COMPARISON · inspect-only</div><DiffView before={diffable.before} after={diffable.after} beforeLabel={diffable.label} changelog={current?.changelog} /></div>}
            {error && <div className="alert err studio-error"><span>{error}</span><button className="btn sm ghost" onClick={app.clearError}>dismiss</button></div>}
          </div>
        </section>

        <aside className="studio-side" aria-label="Refine and render">
          <section className="studio-chat">
            <div className="studio-panel-head"><div className="studio-kicker">03 · REFINE</div><div className="studio-title-row"><h3>Direct with chat</h3><span className="studio-kicker">{loadedSkills.length} skills</span></div></div>
            <div className="studio-chat-feed" aria-live="polite"><p className="studio-chat-note">Every accepted refinement becomes the new current prompt. Old versions stay in history.</p>{chat.map((t, i) => <div className={`studio-message${t.role === 'user' ? ' user' : ''}`} key={i}><div className="studio-message-role">{t.role === 'user' ? 'You' : 'Studio'}</div><div className="studio-message-body">{t.role === 'user' ? t.text : <ProseDoc text={t.text} />}</div>{t.versionId && <div className="studio-change">✓ v{versions.findIndex((v) => v.id === t.versionId) + 1} is now current</div>}</div>)}{streaming?.stage === 'freeform' && <div className="studio-message"><div className="studio-message-role">Studio</div><ProseDoc text={streaming.text} streaming /></div>}</div>
            <div className="studio-chat-compose"><textarea ref={noteRef} value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }} placeholder={connected ? 'Change the camera, action, dialogue, mood…' : 'Connect a model to refine'} rows={3} disabled={!connected || (!current && !pastedPrompt)} aria-label="Refinement instruction" /><div className="studio-compose-row"><span>Updates the current prompt</span><button className="studio-send" onClick={send} disabled={!note.trim() || busy || !connected || (!current && !pastedPrompt)}>{busy ? 'Working…' : 'Refine prompt'}</button></div></div>
          </section>
          <section className="studio-render">
            <div className="studio-kicker">04 · RENDER</div><div className="studio-title-row"><h3>ComfyUI</h3><button className="studio-render-ready" onClick={() => setModal('endpoint')}><span className={`studio-health-dot ${app.comfyProbes[app.endpoint?.id ?? '']?.state === 'ok' ? 'ok' : 'idle'}`} />{app.endpoint?.label || 'configure endpoint'}</button></div>
            <div className="studio-render-grid"><div><span>Recipe</span><strong>{app.recipe?.name || 'not configured'}</strong></div><div><span>References</span><strong>{app.plates.length} of 9 bound</strong></div><div><span>Geometry</span><strong>{app.recipe ? `${settings.width ?? app.recipe.defaults.width} × ${settings.height ?? app.recipe.defaults.height}` : '—'}</strong></div><div><span>Seed</span><strong>{settings.seed} · {settings.lockSeed ? 'locked' : 'random'}</strong></div></div>
            {activeContinuation?.state === 'ready' && <div className="studio-context-receipt"><strong>Next prompt is ready</strong>Direct → Draft used the ending frame, current prompt, film context, and bound references. Refine it in chat or render it as the next clip.</div>}
            {activeContinuation?.state === 'failed' && <div className="studio-context-receipt studio-context-failed"><strong>Continuation stopped during {activeContinuation.phase}</strong>{error || 'The previous successful prompt and rendered clip remain available.'}</div>}
            {activeContinuation?.state === 'cancelled' && <div className="studio-context-receipt studio-context-failed"><strong>Continuation cancelled during {activeContinuation.phase}</strong>The previous prompt and rendered clip remain available; no new clip was rendered.</div>}
            {activeContinuation?.state === 'running' && <div className="studio-context-receipt" role="status" aria-live="polite"><strong>Continuing · {activeContinuation.phase}</strong>{activeContinuation.phase === 'frame' ? 'Taking the ending frame as Picture 1.' : activeContinuation.phase === 'handoff' ? 'Writing the next clip hand-off.' : activeContinuation.phase === 'direct' ? 'Directing the next clip.' : 'Drafting the next canonical prompt.'}</div>}
            <button className="studio-render-current" disabled={busy || !!rendering || activeContinuation?.state === 'running' || app.blockers.length > 0} onClick={() => void app.render()}><span>{rendering ? `Rendering clip ${rendering.index}…` : 'Render current prompt'}</span><span>current →</span></button>
            {app.clip?.state === 'done' && <button className="studio-continue" disabled={busy || !!rendering || activeContinuation?.state === 'running' || activeContinuation?.state === 'ready'} onClick={() => void app.continueFrom(app.clip!.id)}><span>Continue from this clip</span><span>{activeContinuation?.state === 'running' ? `${activeContinuation.phase}…` : activeContinuation?.state === 'ready' ? 'next prompt ready' : 'next prompt →'}</span></button>}
            {app.blockers.length > 0 && <div className="studio-render-issues">{app.blockers.map((b) => <div key={b}>{b}</div>)}</div>}
            {app.warnings.length > 0 && <div className="studio-render-warnings">{app.warnings.map((w) => <div key={w}>{w}</div>)}</div>}
            <div className="studio-render-links"><button className="btn sm ghost" onClick={() => setModal('recipe')}>Recipe & geometry</button><button className="btn sm ghost" onClick={() => setModal('plates')}>Bind plates</button></div>
          </section>
          <section className="studio-audit"><Marginalia /></section>
        </aside>
      </main>

      <FilmStrip />
      </div>

      <div className={`workspace-view ${workspace === 'agent' ? 'is-active' : 'is-hidden'}`} aria-hidden={workspace !== 'agent'}>
        <AgentPanel onOpenStudio={() => setWorkspace('studio')} />
      </div>

      {modal === 'connect' && <ConnectPanel onClose={() => setModal(null)} />}
      {modal === 'skills' && <SkillsPanel onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsPanel onClose={() => setModal(null)} />}
      {modal === 'plates' && <PlatesPanel onClose={() => setModal(null)} />}
      {modal === 'recipe' && <RecipePanel onClose={() => setModal(null)} />}
      {modal === 'endpoint' && <EndpointPanel onClose={() => setModal(null)} />}
    </div>
  )
}
