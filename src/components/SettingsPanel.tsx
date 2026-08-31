import { useState } from 'react'
import { useApp } from '../app/state'
import { DEFAULT_TEMPLATES, STAGE_LABEL, templateFor } from '../lib/stages'
import type { H3Mode, StageId } from '../lib/types'

const MODES: { id: H3Mode; note: string }[] = [
  { id: 'T2VA', note: 'text only' },
  { id: 'I2VA', note: 'first image' },
  { id: 'FL2VA', note: 'first + last' },
  { id: 'L2VA', note: 'toward a last frame' },
  { id: 'Ref2VA', note: 'full reference' },
  { id: 'MoGr', note: 'motion graphics' },
]

const EDITABLE: StageId[] = ['direct', 'draft', 'critique', 'revise', 'freeform']

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, patchSettings, reset, versions } = useApp()
  const [tab, setTab] = useState<'output' | 'stages'>('output')
  const [editing, setEditing] = useState<StageId>('direct')

  const template = templateFor(settings.stageTemplates, editing)
  const modified = settings.stageTemplates[editing] !== undefined

  const clearOverride = (stage: StageId) => {
    const next = { ...settings.stageTemplates }
    delete next[stage]
    patchSettings({ stageTemplates: next })
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 760, height: '86%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Settings</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>Saved in this browser.</div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <button className={`btn${tab === 'output' ? ' pri' : ''}`} onClick={() => setTab('output')}>Output</button>
          <button className={`btn${tab === 'stages' ? ' pri' : ''}`} onClick={() => setTab('stages')}>Stage prompts</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          {tab === 'output' ? (
            <>
              <div className="lbl" style={{ marginBottom: 9 }}>H3 mode</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6 }}>
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={`chip${settings.mode === m.id ? ' on' : ''}`}
                    style={{ justifyContent: 'space-between' }}
                    onClick={() => patchSettings({ mode: m.id })}
                  >
                    <span style={{ fontFamily: 'var(--mono)' }}>{m.id}</span>
                    <span className="tok" style={{ color: 'inherit', opacity: 0.65 }}>{m.note}</span>
                  </button>
                ))}
              </div>

              <div className="lbl" style={{ margin: '20px 0 10px' }}>Model parameters</div>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
                <span style={{ fontSize: 11.5, width: 96 }}>temperature</span>
                <input
                  type="range"
                  min={0}
                  max={1.2}
                  step={0.05}
                  value={settings.temperature}
                  onChange={(e) => patchSettings({ temperature: Number(e.target.value) })}
                  style={{ flexGrow: 1 }}
                />
                <span className="tok" style={{ width: 34, textAlign: 'right', color: 'var(--ink)' }}>{settings.temperature.toFixed(2)}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 12 }}>
                <span style={{ fontSize: 11.5, width: 96 }}>output length</span>
                <button
                  className={`chip${settings.maxTokens === 0 ? ' on' : ''}`}
                  onClick={() => patchSettings({ maxTokens: 0 })}
                >
                  No limit
                </button>
                <button
                  className={`chip${settings.maxTokens > 0 ? ' on' : ''}`}
                  onClick={() => patchSettings({ maxTokens: settings.maxTokens > 0 ? settings.maxTokens : 16384 })}
                >
                  Cap it
                </button>
                <div style={{ flexGrow: 1 }} />
                <span className="tok" style={{ color: 'var(--ink)' }}>
                  {settings.maxTokens === 0 ? 'the model’s own maximum' : `${Math.round(settings.maxTokens / 1024)}k`}
                </span>
              </div>

              {settings.maxTokens > 0 && (
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
                  <span style={{ fontSize: 11.5, width: 96 }} />
                  <input
                    type="range"
                    min={1024}
                    max={131072}
                    step={1024}
                    value={settings.maxTokens}
                    onChange={(e) => patchSettings({ maxTokens: Number(e.target.value) })}
                    style={{ flexGrow: 1 }}
                  />
                  <span className="tok" style={{ width: 48, textAlign: 'right', color: 'var(--ink)' }}>
                    {Math.round(settings.maxTokens / 1024)}k
                  </span>
                </div>
              )}

              <div className="tok" style={{ marginTop: 8, lineHeight: 1.55 }}>
                {settings.maxTokens === 0
                  ? 'No ceiling is sent, so the model may write until it reaches the end of its own context. This is the default because any fixed number is a guess that eventually truncates something — and a ceiling costs nothing when the answer is short anyway.'
                  : 'A cap is only worth setting to bound cost on a metered provider. Reasoning models spend tokens thinking before they write, so a cap that lands mid-thought returns a truncated or empty answer rather than a shorter one.'}{' '}
                Whichever a server disagrees with — a value larger than its context, or a missing one it requires — the request is retried
                the other way automatically.
              </div>

              <div className="lbl" style={{ margin: '22px 0 9px' }}>This draft</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span className="tok" style={{ flexGrow: 1 }}>
                  {versions.length} pass{versions.length === 1 ? '' : 'es'} recorded
                </span>
                <button
                  className="btn"
                  onClick={() => {
                    void reset()
                    onClose()
                  }}
                >
                  Start a new draft
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 5, marginBottom: 12, flexWrap: 'wrap' }}>
                {EDITABLE.map((s) => (
                  <button key={s} className={`chip${editing === s ? ' on' : ''}`} onClick={() => setEditing(s)}>
                    {STAGE_LABEL[s]}
                    {settings.stageTemplates[s] !== undefined && <span className="tok" style={{ color: 'inherit' }}>·edited</span>}
                  </button>
                ))}
              </div>

              <div className="tok" style={{ marginBottom: 7, lineHeight: 1.5 }}>
                Placeholders: <code>{'{{story}}'}</code> <code>{'{{current}}'}</code> <code>{'{{mode}}'}</code> <code>{'{{notes}}'}</code>{' '}
                <code>{'{{critique}}'}</code> <code>{'{{findings}}'}</code>. Editing one pins it — it will no longer track improvements to
                the shipped prompt until you restore the default. The loaded skills are sent separately, ahead of this — don’t repeat them here or you break
                the cached prefix.
              </div>

              <textarea
                value={template}
                onChange={(e) => patchSettings({ stageTemplates: { ...settings.stageTemplates, [editing]: e.target.value } })}
                spellCheck={false}
                style={{ width: '100%', minHeight: 340, fontFamily: 'var(--mono)', fontSize: 11.5, lineHeight: 1.6, resize: 'vertical' }}
              />

              {modified && (
                <button
                  className="btn sm"
                  style={{ marginTop: 8 }}
                  onClick={() => clearOverride(editing)}
                >
                  Restore the default
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
