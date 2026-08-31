import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './state'
import { Marginalia } from '../components/Marginalia'
import { Legend, PromptDoc } from '../components/PromptDoc'
import { DiffView } from '../components/DiffView'
import { ProseDoc } from '../components/ProseDoc'
import { ConnectPanel } from '../components/ConnectPanel'
import { SkillsPanel } from '../components/SkillsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { PlatesPanel } from '../components/PlatesPanel'
import { RecipePanel } from '../components/RecipePanel'
import { EndpointPanel, RenderRail } from '../components/RenderPanel'
import { ClipPlayer, FilmStrip } from '../components/ClipDeck'
import { STAGE_INFO, STAGE_LABEL, STAGE_ORDER } from '../lib/stages'
import { skillTokens } from '../lib/skills'
import { estTokens, fmtTokens } from '../lib/tokens'
import { wasSent } from '../lib/context'
import { looksLikePrompt } from '../lib/lint'
import type { StageId, Version } from '../lib/types'

/** Stages whose output is a prompt — the only things worth diffing together. */
const PROMPT_STAGES_UI = new Set<StageId>(['draft', 'revise', 'freeform'])

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
  const { ready, skills, settings, providers, probes, story, versions, current, streaming, chat, film, error, failedReasoning, context } = app
  const { clips, rendering } = app
  const [modal, setModal] = useState<'connect' | 'skills' | 'settings' | 'plates' | 'recipe' | 'endpoint' | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const [editingSource, setEditingSource] = useState(false)
  const [hoveredStage, setHoveredStage] = useState<StageId | null>(null)
  const [thinkOpen, setThinkOpen] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [view, setView] = useState<'result' | 'diff'>('result')
  const [filmOpen, setFilmOpen] = useState(false)
  const thinkRef = useRef<HTMLDivElement>(null)
  const storyRef = useRef<HTMLTextAreaElement>(null)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const docRef = useRef<HTMLDivElement>(null)

  const provider = providers.find((p) => p.id === settings.providerId)
  const probe = provider ? probes[provider.id] : undefined
  const connected = probe?.state === 'ok' && !!settings.model
  const busy = !!streaming

  // A pasted prompt does not need directing — the useful next move is a
  // critique of what is already there.
  const pastedPrompt = !current && !streaming && looksLikePrompt(story)

  const nextStage: StageId = useMemo(() => {
    if (!current) return pastedPrompt ? 'critique' : 'direct'
    const i = STAGE_ORDER.indexOf(current.stage)
    if (i === -1) return 'revise'
    return STAGE_ORDER[Math.min(i + 1, STAGE_ORDER.length - 1)]
  }, [current, pastedPrompt])

  // The rail is a timeline of passes, so clicking one navigates to it. Running
  // is the button's job — conflating the two meant a completed pass could only
  // ever be re-run, never re-read.
  const passesByStage = useMemo(() => {
    const m = new Map<StageId, Version[]>()
    for (const v of versions) m.set(v.stage, [...(m.get(v.stage) ?? []), v])
    return m
  }, [versions])

  const reached = useMemo(() => new Set(versions.map((v) => v.stage)), [versions])
  const viewingStage = current?.stage ?? null

  // Critique and Revise operate on a prompt. A direction sheet is prose, and
  // auditing it for prompt fields produces confident nonsense — so say what is
  // missing rather than letting it run.
  const documentIsPrompt = current ? current.stage !== 'direct' : looksLikePrompt(story)
  const blockedReason = (stage: StageId): string | null => {
    const needs = STAGE_INFO[stage].needs
    if (needs === 'story' && !story.trim()) return 'Paste something first.'
    if (needs === 'anything' && !story.trim() && !current) return 'Paste something first.'
    if (needs === 'prompt' && !documentIsPrompt) {
      return current ? 'Needs a prompt — the page currently holds a direction sheet. Run Draft first.' : 'Needs a prompt. Paste one, or run Direct then Draft.'
    }
    return null
  }

  const openStage = (s: StageId) => {
    const passes = passesByStage.get(s)
    if (passes?.length) {
      app.selectVersion(passes[passes.length - 1].id)
      return
    }
    if (!busy && connected && !blockedReason(s)) void app.run(s)
  }

  const stageNote = (s: StageId): string => {
    const passes = passesByStage.get(s)?.length ?? 0
    if (passes && s === viewingStage) return 'You are reading this pass.'
    if (passes) return `Click to read ${passes > 1 ? `the latest of ${passes} passes` : 'this pass'}.`
    const blocked = blockedReason(s)
    if (blocked) return blocked
    if (!connected) return 'Connect a model to run it.'
    return 'Not run yet — click to run it.'
  }

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault()
        if (!busy && connected) void app.run(nextStage)
      }
      if (e.key === 'Escape' && busy) app.cancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [app, busy, connected, nextStage])

  const send = () => {
    const text = note.trim()
    if (!text || busy || !connected) return
    setNote('')
    void app.run('freeform', text)
  }

  // When a finished prompt is pasted it IS the document — show it typeset
  // rather than leaving the page looking empty below a wall of source text.
  // `||` rather than `??` on purpose: at the instant a run starts the stream
  // holds an empty string, which `??` would happily show — blanking the page
  // until the first token lands. Keep the previous pass up until then.
  const shown = streaming?.text || current?.text || (pastedPrompt ? story : '')
  const reasoning = streaming ? streaming.reasoning : (failedReasoning ?? current?.reasoning ?? '')
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
  const shownStage: StageId = streaming?.stage ?? current?.stage ?? (pastedPrompt ? 'draft' : 'direct')
  const shownIsProse = shownStage === 'direct' || shownStage === 'critique'
  const longSource = story.length > 600
  const collapseSource = (pastedPrompt || longSource) && !editingSource
  const loadedSkills = skills.filter((s) => settings.selection[s.id]?.length)

  const copy = async () => {
    if (!shown) return
    await navigator.clipboard.writeText(shown)
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
    <div className="app">
      {/* ── masthead ─────────────────────────────────────────────────── */}
      <div className="masthead">
        <div className="serif" style={{ fontSize: 21, letterSpacing: '-0.005em' }}>
          H3 Prompt Studio
        </div>
        <div className="serif" style={{ fontStyle: 'italic', fontSize: 15, color: 'var(--ink3)' }}>
          {current ? `${STAGE_LABEL[current.stage]} · pass ${versions.length}` : 'a new draft'}
        </div>
        <div style={{ flexGrow: 1 }} />
        <button className="chip" onClick={() => setModal('connect')} title="Connect a model">
          <span className={`dot ${connected ? 'ok' : probe?.state === 'mixed-content' ? 'err' : 'idle'}`} />
          {settings.model || 'no model'}
        </button>
        {confirmClear ? (
          <>
            <span className="tok" style={{ color: 'var(--ox)' }}>discard {versions.length} pass{versions.length === 1 ? '' : 'es'}?</span>
            <button
              className="btn pri"
              onClick={() => {
                void app.reset()
                setConfirmClear(false)
                setEditingSource(false)
              }}
            >
              Discard
            </button>
            <button className="btn ghost" onClick={() => setConfirmClear(false)}>
              Keep
            </button>
          </>
        ) : (
          <button
            className="btn ghost"
            onClick={() => (versions.length || story ? setConfirmClear(true) : undefined)}
            disabled={!versions.length && !story}
            title="Clear the source and every pass, and start again"
          >
            New draft
          </button>
        )}
        <button className="btn ghost" onClick={() => setModal('settings')}>
          Settings
        </button>
        <button className="btn ghost" onClick={() => setModal('endpoint')} title="Where clips render">
          {rendering ? `Rendering clip ${rendering.index}…` : 'Render'}
        </button>
        <button className="btn" onClick={() => void copy()} disabled={!shown}>
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
      </div>

      {/* ── reading strip ────────────────────────────────────────────── */}
      <div className="reading">
        <span className="lbl" style={{ marginRight: 3 }}>Reading</span>
        {skills.map((s) => {
          const sel = settings.selection[s.id] || []
          const cls = sel.length === 0 ? 'off' : sel.length === s.files.length ? 'on' : 'part'
          return (
            <button key={s.id} className={`chip ${cls}`} onClick={() => app.toggleSkill(s)} title={s.description}>
              {s.name}
              {sel.length > 0 && <span className="tok" style={{ color: 'var(--ox)', opacity: 0.8 }}>{fmtTokens(skillTokens(s, sel))}</span>}
            </button>
          )
        })}
        <button className="chip off" onClick={() => setModal('skills')}>
          ＋ {skills.length ? 'manage' : 'add skills'}
        </button>
        <div style={{ flexGrow: 1, minWidth: 12 }} />
        {context && (
          <span className="tok" style={{ whiteSpace: 'nowrap' }}>
            {fmtTokens(context.tokens)} est. · {loadedSkills.length} skill{loadedSkills.length === 1 ? '' : 's'} ·{' '}
            <span style={{ color: wasSent(context.hash) ? 'var(--grn)' : 'var(--ink3)' }}>
              {wasSent(context.hash) ? 'cached' : 'not sent yet'}
            </span>
          </span>
        )}
      </div>

      <div className="body">
        <div className="column">
          {/* ── stage line ───────────────────────────────────────────── */}
          <div className="stageline">
            <div className="stagerow">
              {STAGE_ORDER.map((s, i) => {
                const blocked = blockedReason(s)
                const done = reached.has(s)
                const isNext = nextStage === s
                return (
                  <span key={s} style={{ display: 'contents' }}>
                    {i > 0 && <span className={`stage-sep${isNext ? ' on' : ''}`} />}
                    {/* The hover handlers sit on the wrapper, not the button:
                        a disabled button receives no pointer events, and a
                        blocked pass is precisely the one needing explanation. */}
                    <span
                      className={`stage-wrap${isNext ? ' on' : done ? ' done' : ''}`}
                      onMouseEnter={() => setHoveredStage(s)}
                      onMouseLeave={() => setHoveredStage(null)}
                      title={blocked ?? (connected ? `${STAGE_LABEL[s]} — ${STAGE_INFO[s].blurb}` : 'Connect a model first')}
                    >
                      <span className="stage-num">{done ? '✓' : i + 1}</span>
                      <button
                        className={`stage${isNext ? ' on' : done ? ' done' : ''}${s === viewingStage ? ' viewing' : ''}`}
                        onClick={() => openStage(s)}
                        disabled={busy || (!done && (!connected || !!blocked))}
                      >
                        {STAGE_LABEL[s]}
                      </button>
                    </span>
                  </span>
                )
              })}
              <div style={{ flexGrow: 1 }} />
              {busy ? (
                <>
                  <span className="spin" style={{ marginRight: 9 }} />
                  <button className="btn" onClick={app.cancel}>Stop</button>
                </>
              ) : (
                <>
                  {documentIsPrompt && (
                    <button
                      className="btn"
                      style={{ marginRight: 7 }}
                      onClick={() => void app.rebuild()}
                      disabled={!connected || !story.trim()}
                      title="Re-read what is here, re-decide the film, and write the prompt again from scratch — not an edit"
                    >
                      Rebuild
                    </button>
                  )}
                  {current && (
                    <button
                      className="btn"
                      style={{ marginRight: 7 }}
                      onClick={() => void app.run(current.stage)}
                      disabled={!connected || !!blockedReason(current.stage)}
                      title={`Run ${STAGE_LABEL[current.stage]} again on the same input`}
                    >
                      Re-run {STAGE_LABEL[current.stage]}
                    </button>
                  )}
                  <button
                    className="btn pri"
                    onClick={() => void app.run(nextStage)}
                    disabled={!connected || !!blockedReason(nextStage)}
                    title={blockedReason(nextStage) ?? `Continue from the pass you are reading`}
                  >
                    {connected ? `Run ${STAGE_LABEL[nextStage]}` : 'Connect a model'}
                  </button>
                </>
              )}
            </div>

            <div className="stagenote">
              {(() => {
                const s = hoveredStage ?? viewingStage ?? nextStage
                return (
                  <>
                    <b>
                      {STAGE_LABEL[s]} → {STAGE_INFO[s].produces}
                    </b>{' '}
                    {STAGE_INFO[s].blurb} <span style={{ color: 'var(--ink3)' }}>{stageNote(s)}</span>
                    {!versions.length && ' Run them in order, or jump straight to the one you need.'}
                    {documentIsPrompt && (s === 'revise' || s === 'direct') && (
                      <span style={{ color: 'var(--ink3)' }}>
                        {' '}Revise edits surgically; Direct → Draft rebuilds from scratch.
                      </span>
                    )}
                  </>
                )
              })()}
            </div>
          </div>

          {/* ── source ───────────────────────────────────────────────── */}
          <div style={{ flex: '0 0 auto', padding: '16px 26px 0', minHeight: 0 }}>
            <div className="pane input">
              <div className="pane-head">
                <span className="pane-tag in">INPUT</span>
                <span className="tok" style={{ color: 'var(--ink2)' }}>
                  {pastedPrompt ? 'a prompt you pasted' : 'your source'} · {story.length.toLocaleString()} characters
                </span>
                <div style={{ flexGrow: 1 }} />
                <button
                  className={`btn sm ${film.role === 'standalone' ? 'ghost' : ''}`}
                  onClick={() => setFilmOpen((v) => !v)}
                  title="Tell it where this clip sits in a longer film"
                >
                  {film.role === 'standalone' ? 'standalone clip' : `part of a film · ${film.role}`}
                </button>
                {(pastedPrompt || longSource) && (
                  <button className="btn sm ghost" onClick={() => setEditingSource((v) => !v)}>
                    {collapseSource ? 'expand' : 'collapse'}
                  </button>
                )}
              </div>

              {filmOpen && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--rule)', background: 'var(--paper)' }}>
                  <div className="tok" style={{ lineHeight: 1.5, marginBottom: 10 }}>
                    A clip inside a film should not hook, escalate and resolve on its own — that makes a row of little
                    complete films rather than one. Say where this one sits and it will be directed as a part.
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>
                    {(['standalone', 'opening', 'rising', 'turn', 'falling', 'closing'] as const).map((r) => (
                      <button key={r} className={`chip${film.role === r ? ' on' : ''}`} onClick={() => app.setFilm({ role: r })}>
                        {r}
                      </button>
                    ))}
                  </div>
                  {film.role !== 'standalone' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                      <input
                        type="text"
                        value={film.spine}
                        onChange={(e) => app.setFilm({ spine: e.target.value })}
                        placeholder="The whole film, in one line"
                        style={{ width: '100%' }}
                      />
                      <input
                        type="text"
                        value={film.precedes}
                        onChange={(e) => app.setFilm({ precedes: e.target.value })}
                        placeholder="What the audience has just seen"
                        style={{ width: '100%' }}
                      />
                      <input
                        type="text"
                        value={film.follows}
                        onChange={(e) => app.setFilm({ follows: e.target.value })}
                        placeholder="What the next clip has to open on"
                        style={{ width: '100%' }}
                      />
                    </div>
                  )}
                </div>
              )}
              <div className="pane-body" style={{ paddingTop: 10, paddingBottom: 10 }}>
                {collapseSource ? (
                  <div className={`epigraph-preview ${pastedPrompt ? 'one' : 'two'}`} onClick={() => setEditingSource(true)}>
                    {story}
                  </div>
                ) : (
                  <textarea
                    ref={storyRef}
                    value={story}
                    onChange={(e) => app.setStory(e.target.value)}
                    placeholder="Paste a story, a beat sheet, a script, or a half-written prompt…"
                    rows={1}
                    aria-label="Source story"
                  />
                )}
                {!story && (
                  <div className="tok" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span>try</span>
                    {EXAMPLES.map((ex) => (
                      <button key={ex.label} className="btn sm ghost" style={{ padding: '1px 6px' }} onClick={() => app.setStory(ex.text)}>
                        {ex.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* ── the document ─────────────────────────────────────────── */}
          <div className="scroll" ref={docRef} style={{ flex: '1 1 auto', padding: '0 26px', minHeight: 0 }}>
            <div style={{ paddingTop: 14, paddingBottom: 20 }}>
              {shown || reasoning ? (
                <div className="pane output">
                  <div className="pane-head">
                    <span className="pane-tag out">OUTPUT</span>
                    <span className="tok" style={{ color: 'var(--ink2)' }}>
                      {streaming
                        ? `${STAGE_LABEL[streaming.stage]} · ${live!.answer ? `~${fmtTokens(live!.answer)} tokens · ${live!.rate}/s` : 'thinking…'}`
                        : current
                          ? `${settings.mode} · ${STAGE_LABEL[current.stage]} · pass ${versions.findIndex((v) => v.id === current.id) + 1}`
                          : `${settings.mode} · unrefined — this is still your input`}
                    </span>
                    {current && !streaming && (
                      <span className="tok" title="The model that produced this pass">
                        written by {current.model} · {(current.ms / 1000).toFixed(1)}s
                        {current.tokens
                          ? ` · ${current.tokensEstimated ? '~' : ''}${fmtTokens(current.tokens)} tokens · ${Math.round(
                              current.tokens / Math.max(0.001, current.ms / 1000),
                            )}/s`
                          : ''}
                        {settings.model && current.model !== settings.model && (
                          <span style={{ color: 'var(--amb)' }}> · you are now on {settings.model}</span>
                        )}
                      </span>
                    )}
                    <div style={{ flexGrow: 1 }} />
                    {diffable && (
                      <div style={{ display: 'flex', gap: 4, marginRight: 4 }}>
                        <button className={`chip${view === 'result' ? ' on' : ''}`} onClick={() => setView('result')}>
                          Result
                        </button>
                        <button
                          className={`chip${view === 'diff' ? ' on' : ''}`}
                          onClick={() => setView('diff')}
                          title="What this pass changed, side by side"
                        >
                          Diff{current?.changelog?.length ? ` · ${current.changelog.length}` : ''}
                        </button>
                      </div>
                    )}
                    {!streaming && (
                      <button className="btn sm" onClick={() => void copy()}>
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    )}
                  </div>
                  {reasoning && (
                    <div className="think">
                      <div className="think-head" onClick={() => setThinkOpen((v) => !v)}>
                        <span className="tok" style={{ color: 'var(--ink3)' }}>{thinkOpen ? '▾' : '▸'}</span>
                        <span className="lbl">Thinking</span>
                        <span className="tok">
                          {streaming
                            ? `~${fmtTokens(live!.think)} tokens · ${live!.rate}/s · ${live!.secs.toFixed(0)}s`
                            : `~${fmtTokens(estTokens(reasoning))} tokens, not part of the prompt`}
                        </span>
                        {reasoningStreaming && <span className="spin" />}
                      </div>
                      {thinkOpen && (
                        <div className="think-body" ref={thinkRef}>
                          {reasoning}
                          {reasoningStreaming && <span className="think-caret" />}
                        </div>
                      )}
                    </div>
                  )}
                  {!streaming && !shownIsProse && (
                    <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--rule)', background: 'var(--paper)' }}>
                      <Legend text={shown} />
                    </div>
                  )}
                  <div className="pane-body">
                    {diffable && view === 'diff' ? (
                      <DiffView before={diffable.before} after={diffable.after} beforeLabel={diffable.label} changelog={current?.changelog} />
                    ) : shownIsProse ? (
                      <ProseDoc text={shown} streaming={!!streaming} />
                    ) : (
                      <PromptDoc text={shown} streaming={!!streaming} />
                    )}
                  </div>
                </div>
              ) : (
                <div style={{ maxWidth: 520 }}>
                  <div className="lbl" style={{ marginBottom: 9 }}>What comes back</div>
                  <div style={{ fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.7, color: 'var(--ink3)' }}>
                    <span style={{ color: 'var(--ox)' }}>integrated_multimodal_description:</span> timed cuts, camera, blocking
                    <br />
                    <span style={{ color: 'var(--ox)' }}>overall_soundscape:</span> concrete sources, placed in time
                    <br />
                    <span style={{ color: 'var(--ox)' }}>non_diegetic_music:</span> <span style={{ color: 'var(--grn)' }}>N/A</span>
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 12, lineHeight: 1.6, borderTop: '1px solid var(--rule)', paddingTop: 11 }}>
                    Checked against the rules before you copy it — including the ones that only show up after you’ve wasted a render.
                  </div>
                </div>
              )}

              {chat.length > 0 && (
                <div className="thread">
                  <div className="lbl" style={{ marginBottom: 2 }}>Conversation</div>
                  {chat.map((t, i) => (
                    <div className={`turn${t.role === 'user' ? ' you' : ''}`} key={i}>
                      <div className="turn-role">
                        {t.role === 'user' ? 'You' : 'Reply'}
                        {t.versionId && <span className="turn-badge">updated the prompt · pass {versions.findIndex((v) => v.id === t.versionId) + 1}</span>}
                      </div>
                      <div className="turn-body">
                        {t.role === 'user' ? t.text : <ProseDoc text={t.text} />}
                      </div>
                    </div>
                  ))}
                  {streaming?.stage === 'freeform' && (
                    <div className="turn">
                      <div className="turn-role">Reply</div>
                      <div className="turn-body">
                        <ProseDoc text={streaming.text} streaming />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {error && (
                <div className="alert err" style={{ marginTop: 16, maxWidth: 660 }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <span style={{ flexGrow: 1 }}>{error}</span>
                    <button className="btn sm ghost" onClick={app.clearError}>dismiss</button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── composer ─────────────────────────────────────────────── */}
          <div className="composer">
            <textarea
              ref={noteRef}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={connected ? 'lose the second cut, hold on her hand longer…' : 'connect a model to begin'}
              rows={1}
              disabled={!connected || (!current && !pastedPrompt)}
              aria-label="Refinement instruction"
            />
            <button className="btn" onClick={send} disabled={!note.trim() || busy || !connected || (!current && !pastedPrompt)}>
              Send
            </button>
          </div>
        </div>

        {/* ── the clip, and what it starts ─────────────────────────── */}
        <div className="clipcol">
          <ClipPlayer />
          <div style={{ flexGrow: 1 }} />
        </div>

        <div className="renderrail">
          <RenderRail onOpen={setModal} />
        </div>

        <Marginalia />
      </div>

      <FilmStrip />

      {modal === 'connect' && <ConnectPanel onClose={() => setModal(null)} />}
      {modal === 'skills' && <SkillsPanel onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsPanel onClose={() => setModal(null)} />}
      {modal === 'plates' && <PlatesPanel onClose={() => setModal(null)} />}
      {modal === 'recipe' && <RecipePanel onClose={() => setModal(null)} />}
      {modal === 'endpoint' && <EndpointPanel onClose={() => setModal(null)} />}
    </div>
  )
}
