import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from './state'
import { Marginalia } from '../components/Marginalia'
import { PromptDoc } from '../components/PromptDoc'
import { ConnectPanel } from '../components/ConnectPanel'
import { SkillsPanel } from '../components/SkillsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { STAGE_LABEL, STAGE_ORDER } from '../lib/stages'
import { skillTokens } from '../lib/skills'
import { fmtTokens } from '../lib/tokens'
import { wasSent } from '../lib/context'
import { looksLikePrompt } from '../lib/lint'
import type { StageId } from '../lib/types'

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
  const { ready, skills, settings, providers, probes, story, versions, current, streaming, error, context } = app
  const [modal, setModal] = useState<'connect' | 'skills' | 'settings' | null>(null)
  const [copied, setCopied] = useState(false)
  const [note, setNote] = useState('')
  const [editingSource, setEditingSource] = useState(false)
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

  const reached = useMemo(() => new Set(versions.map((v) => v.stage)), [versions])

  useEffect(() => autosize(storyRef.current), [story, ready])
  useEffect(() => autosize(noteRef.current), [note])

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
  const shown = streaming?.text ?? current?.text ?? (pastedPrompt ? story : '')
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
        <button className="btn ghost" onClick={() => setModal('settings')}>
          Settings
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
            {STAGE_ORDER.map((s, i) => (
              <span key={s} style={{ display: 'contents' }}>
                {i > 0 && <span className={`stage-sep${nextStage === s ? ' on' : ''}`} />}
                <button
                  className={`stage${nextStage === s ? ' on' : reached.has(s) ? ' done' : ''}`}
                  onClick={() => !busy && connected && void app.run(s)}
                  disabled={busy || !connected}
                  title={connected ? `Run ${STAGE_LABEL[s]}` : 'Connect a model first'}
                >
                  {STAGE_LABEL[s]}
                </button>
              </span>
            ))}
            <div style={{ flexGrow: 1 }} />
            {current && !busy && (
              <span className="tok" style={{ marginRight: 12 }}>
                {current.model} · {(current.ms / 1000).toFixed(1)}s
              </span>
            )}
            {busy ? (
              <>
                <span className="spin" style={{ marginRight: 9 }} />
                <button className="btn" onClick={app.cancel}>Stop</button>
              </>
            ) : (
              <button className="btn pri" onClick={() => void app.run(nextStage)} disabled={!connected || (!story.trim() && !current)}>
                {connected ? `Run ${STAGE_LABEL[nextStage]}` : 'Connect a model'}
              </button>
            )}
          </div>

          {/* ── source ───────────────────────────────────────────────── */}
          <div style={{ flex: '0 0 auto', padding: '22px 26px 18px', minHeight: 0 }}>
            <div className="epigraph">
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
              <div className="tok" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span>
                  source · {pastedPrompt ? 'a prompt already' : 'story'} · {story.length.toLocaleString()} characters
                </span>
                {(pastedPrompt || longSource) && (
                  <button className="btn sm ghost" style={{ padding: '1px 6px' }} onClick={() => setEditingSource((v) => !v)}>
                    {collapseSource ? 'edit' : 'collapse'}
                  </button>
                )}
                {!story && (
                  <>
                    <span>·</span>
                    {EXAMPLES.map((ex) => (
                      <button key={ex.label} className="btn sm ghost" style={{ padding: '1px 6px' }} onClick={() => app.setStory(ex.text)}>
                        {ex.label}
                      </button>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>

          {/* ── the document ─────────────────────────────────────────── */}
          <div className="scroll" ref={docRef} style={{ flex: '1 1 auto', padding: '0 26px', minHeight: 0 }}>
            <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 16, paddingBottom: 20 }}>
              {shown ? (
                <>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 13 }}>
                    <span className="lbl">
                      {streaming
                        ? STAGE_LABEL[streaming.stage]
                        : current
                          ? `${settings.mode} · ${STAGE_LABEL[current.stage]}`
                          : `${settings.mode} · as pasted`}
                    </span>
                    <div style={{ flexGrow: 1 }} />
                    <span className="tok">
                      {streaming ? 'writing…' : current ? `pass ${versions.findIndex((v) => v.id === current.id) + 1}` : 'not yet refined'}
                    </span>
                  </div>
                  <PromptDoc text={shown} streaming={!!streaming} />
                </>
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

        <Marginalia />
      </div>

      {modal === 'connect' && <ConnectPanel onClose={() => setModal(null)} />}
      {modal === 'skills' && <SkillsPanel onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsPanel onClose={() => setModal(null)} />}
    </div>
  )
}
