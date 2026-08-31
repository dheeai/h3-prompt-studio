import { useApp } from '../app/state'
import { summarise } from '../lib/lint'
import { STAGE_LABEL } from '../lib/stages'

function ago(t: number) {
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function Marginalia() {
  const { findings, versions, current, selectVersion, run, streaming, settings } = useApp()
  const counts = summarise(findings)
  const actionable = findings.filter((f) => f.severity !== 'pass')
  const passes = findings.filter((f) => f.severity === 'pass')
  const earlier = [...versions].reverse().filter((v) => v.id !== current?.id)

  return (
    <div className="margin">
      <div className="scroll" style={{ flex: '1 1 auto', padding: '15px 22px 0' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="lbl">Notes on this draft</span>
          <div style={{ flexGrow: 1 }} />
          {findings.length > 0 && (
            <span className="tok">
              {counts.error > 0 && <span style={{ color: 'var(--ox)' }}>{counts.error} must fix · </span>}
              {counts.warn > 0 && <span style={{ color: 'var(--amb)' }}>{counts.warn} check · </span>}
              <span style={{ color: 'var(--grn)' }}>{counts.pass} pass</span>
            </span>
          )}
        </div>

        {!findings.length && (
          <div className="note" style={{ borderBottom: 'none' }}>
            <div className="note-body" style={{ color: 'var(--ink3)' }}>
              {current?.stage === 'direct'
                ? 'A direction sheet isn’t checked — the rules apply to a prompt. Run Draft next.'
                : 'Nothing to check yet. The rules run on every prompt as it arrives.'}
            </div>
          </div>
        )}

        {actionable.map((f) => (
          <div className="note" key={f.id}>
            <div className="note-head">
              <span className={`note-title${f.severity === 'error' ? ' err' : ''}`}>{f.title}</span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok" style={{ color: f.severity === 'error' ? 'var(--ox)' : 'var(--amb)' }}>
                {f.severity === 'error' ? 'must fix' : f.metric || 'check'}
              </span>
            </div>
            {f.detail && <div className="note-body">{f.detail}</div>}
            {f.matches.slice(0, 4).map((m, i) => (
              <div className="note-quote" key={i}>
                {m}
              </div>
            ))}
          </div>
        ))}

        {passes.length > 0 && (
          <div className="note">
            <div className="note-head">
              <span className="note-title" style={{ color: 'var(--ink2)' }}>
                Holding up
              </span>
            </div>
            <div style={{ marginTop: 7, display: 'flex', flexDirection: 'column', gap: 5 }}>
              {passes.map((f) => (
                <div key={f.id} style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--grn)" strokeWidth="1.7" style={{ flex: '0 0 auto' }}>
                    <path d="M1.5 5.2L4 7.6 8.5 2.4" />
                  </svg>
                  <span style={{ fontSize: 11.5, color: 'var(--ink2)', flexGrow: 1, lineHeight: 1.4 }}>{f.title}</span>
                  {f.metric && <span className="tok">{f.metric}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {earlier.length > 0 && (
          <div className="note" style={{ borderBottom: 'none' }}>
            <div className="note-title" style={{ marginBottom: 7 }}>
              Earlier passes
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {earlier.map((v) => (
                <button
                  key={v.id}
                  onClick={() => selectVersion(v.id)}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 8,
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 11.5, color: 'var(--ink2)', flexGrow: 1 }}>
                    {STAGE_LABEL[v.stage]}
                    {v.note ? <span style={{ color: 'var(--ink3)' }}> · {v.note.slice(0, 30)}</span> : null}
                  </span>
                  <span className="tok">{ago(v.at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div style={{ flex: '0 0 auto', padding: 14, borderTop: '1px solid var(--rule)' }}>
        <button
          className="btn"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={!current || !!streaming || !actionable.length || !settings.model}
          onClick={() => void run('revise')}
          title={actionable.length ? 'Send these findings to the Revise stage' : 'Nothing to apply'}
        >
          {actionable.length ? `Apply ${actionable.length} note${actionable.length === 1 ? '' : 's'} and revise` : 'Nothing to apply'}
        </button>
      </div>
    </div>
  )
}
