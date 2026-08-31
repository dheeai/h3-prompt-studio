import { useState } from 'react'
import { useApp } from '../app/state'
import type { Clip } from '../lib/types'

function Thumb({ clip, active, onClick }: { clip: Clip; active: boolean; onClick: () => void }) {
  const { clipUrl } = useApp()
  const url = clipUrl(clip)
  const border = active ? '2px solid var(--ox)' : '1px solid var(--rule2)'
  return (
    <div style={{ width: 152, flex: '0 0 auto' }} onClick={onClick}>
      <div style={{ height: 66, border, background: 'var(--sunk)', overflow: 'hidden', cursor: 'pointer', position: 'relative' }}>
        {url && clip.state === 'done' ? (
          <video src={`${url}#t=0.1`} preload="metadata" muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span className="tok">{clip.state === 'failed' ? 'failed' : clip.state}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span className="tok" style={{ color: active ? 'var(--ox)' : 'var(--ink2)' }}>{clip.index}</span>
        <span style={{ fontSize: 11, color: active ? 'var(--ox)' : 'var(--ink3)' }}>{clip.film?.role ?? 'standalone'}</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">{clip.frames ? `${(clip.frames / (clip.fps || 24)).toFixed(1)}s` : ''}</span>
      </div>
    </div>
  )
}

/** The current clip, and the one control that starts the next one. */
export function ClipPlayer() {
  const { clip, clipUrl, continueFrom, rendering, film } = useApp()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const url = clip ? clipUrl(clip) : null

  if (!clip) {
    return (
      <div style={{ padding: '13px 22px' }}>
        <div className="lbl">No clip yet</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink3)', lineHeight: 1.6, marginTop: 8, maxWidth: 330 }}>
          Write a prompt, then Render. When a clip lands it plays here, and Continue takes its last frame as the next
          clip’s <span style={{ color: 'var(--kw-picture)' }}>&lt;Picture 1&gt;</span>.
        </div>
      </div>
    )
  }

  const go = async () => {
    setBusy(true)
    try {
      await continueFrom(clip.id, note)
      setNote('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ flex: '0 0 auto', padding: '13px 22px 0', display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Clip {clip.index}</span>
        <span className="tok" style={{ color: clip.state === 'done' ? 'var(--grn)' : clip.state === 'failed' ? 'var(--ox)' : 'var(--amb)' }}>
          {clip.state}
        </span>
        <div style={{ flexGrow: 1 }} />
        {clip.ms && <span className="tok">{Math.round(clip.ms / 1000)}s to render</span>}
      </div>

      <div style={{ flex: '0 0 auto', padding: '11px 22px 0' }}>
        {url && clip.state === 'done' ? (
          <video src={url} controls style={{ width: '100%', border: '1px solid var(--rule2)', display: 'block', background: 'var(--sunk)' }} />
        ) : (
          <div style={{ width: '100%', aspectRatio: '16 / 9', border: '1px solid var(--rule2)', background: 'var(--sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="tok">{clip.state === 'failed' ? 'this clip failed' : 'rendering…'}</span>
          </div>
        )}
        <div className="tok" style={{ display: 'block', marginTop: 7 }}>
          {clip.frames} frames · {clip.fps ?? 24}fps · seed {clip.seed}
        </div>
        {clip.error && (
          <div className="card err" style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.6 }}>{clip.error}</div>
        )}
      </div>

      {clip.state === 'done' && (
        <div style={{ flex: '0 0 auto', padding: '13px 22px 0' }}>
          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 13 }}>
            <div className="lbl" style={{ marginBottom: 8 }}>Direct the next one</div>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What should change? A note here outranks the hand-off…"
              style={{ width: '100%', minHeight: 68, resize: 'vertical', fontFamily: 'var(--serif)', fontSize: 15, lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn pri" style={{ flexGrow: 1, justifyContent: 'center' }} disabled={busy || !!rendering} onClick={() => void go()}>
                {busy ? 'Reading the frame…' : 'Continue from here'}
              </button>
            </div>
            <div className="tok" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
              Takes the last frame as <span style={{ color: 'var(--kw-picture)' }}>&lt;Picture 1&gt;</span>, writes the
              hand-off, advances the role from <b>{film.role}</b>, then Direct.
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function FilmStrip() {
  const { clips, clip, selectClip, film } = useApp()
  if (!clips.length) return null

  const delivered = clips
    .filter((c) => c.state === 'done')
    .reduce((n, c) => n + (c.frames ?? 0) / (c.fps || 24), 0)

  return (
    <div style={{ flex: '0 0 auto', borderTop: '1px solid var(--rule2)', background: 'var(--panel)', padding: '11px 30px 14px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">The film</span>
        <span className="tok">
          {clips.length} clip{clips.length === 1 ? '' : 's'} · {delivered.toFixed(1)}s delivered
        </span>
        <div style={{ flexGrow: 1 }} />
        {film.spine && (
          <span className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink2)', maxWidth: 420, textAlign: 'right' }}>
            {film.spine}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 2 }}>
        {clips.map((c) => (
          <Thumb key={c.id} clip={c} active={c.id === clip?.id} onClick={() => selectClip(c.id)} />
        ))}
      </div>
    </div>
  )
}
