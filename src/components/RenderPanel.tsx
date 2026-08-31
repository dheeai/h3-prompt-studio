import { useState } from 'react'
import { useApp } from '../app/state'
import type { ComfyEndpoint } from '../lib/types'

const BADGE: Record<string, { cls: string; label: string }> = {
  ok: { cls: 'ok', label: 'reachable' },
  probing: { cls: 'idle', label: 'checking…' },
  'mixed-content': { cls: 'err', label: 'blocked' },
  'local-network-blocked': { cls: 'err', label: 'blocked' },
  unreachable: { cls: 'idle', label: 'not reachable' },
  error: { cls: 'warn', label: 'error' },
  unknown: { cls: 'idle', label: '—' },
}

export function EndpointPanel({ onClose }: { onClose: () => void }) {
  const { endpoints, setEndpoints, comfyProbes, refreshComfyProbe, settings, patchSettings } = useApp()
  const [url, setUrl] = useState('http://')

  const add = async () => {
    const clean = url.trim().replace(/\/+$/, '')
    if (!/^https?:\/\/.+/.test(clean)) return
    const ep: ComfyEndpoint = {
      id: `e${Date.now().toString(36)}`,
      label: new URL(clean).hostname,
      baseUrl: clean,
      builtIn: false,
    }
    await setEndpoints([...endpoints, ep])
    patchSettings({ comfyEndpointId: ep.id })
    setUrl('http://')
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Where it renders</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              This browser talks to your ComfyUI directly. No account, and no server of ours in between.
            </div>
          </div>
        </div>

        <div className="modal-body">
          {endpoints.map((ep) => {
            const probe = comfyProbes[ep.id]
            const b = BADGE[probe?.state ?? 'unknown'] ?? BADGE.unknown
            const chosen = ep.id === (settings.comfyEndpointId ?? endpoints[0]?.id)
            return (
              <div key={ep.id} className={`card${probe?.state === 'ok' ? ' ok' : probe?.state === 'mixed-content' ? ' err' : ''}`}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                  <span className={`dot ${b.cls}`} />
                  <span style={{ fontSize: 12.5, fontWeight: 500, width: 96 }}>{ep.label}</span>
                  <span className="tok" style={{ flexGrow: 1, minWidth: 0, wordBreak: 'break-all' }}>{ep.baseUrl}</span>
                  <span className="tok">{b.label}</span>
                </div>

                {probe?.detail && (
                  <div style={{ fontSize: 11.5, color: 'var(--ink2)', lineHeight: 1.6, marginTop: 7 }}>{probe.detail}</div>
                )}
                {probe?.hint && (
                  <div style={{ fontSize: 11.5, color: 'var(--ink2)', lineHeight: 1.6, marginTop: 6, paddingLeft: 11, borderLeft: '2px solid var(--rule2)' }}>
                    {probe.hint}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
                  <button className={`chip${chosen ? ' on' : ''}`} onClick={() => patchSettings({ comfyEndpointId: ep.id })}>
                    {chosen ? 'rendering here' : 'use this one'}
                  </button>
                  <button className="btn sm ghost" onClick={() => void refreshComfyProbe(ep.id)}>check again</button>
                  <div style={{ flexGrow: 1 }} />
                  {!ep.builtIn && (
                    <button className="btn sm ghost" onClick={() => void setEndpoints(endpoints.filter((x) => x.id !== ep.id))}>
                      remove
                    </button>
                  )}
                </div>
              </div>
            )
          })}

          <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flexGrow: 1 }} placeholder="http://host:8188" />
            <button className="btn" onClick={() => void add()}>Add an endpoint</button>
          </div>

          <div style={{ marginTop: 22, paddingTop: 16, borderTop: '1px solid var(--rule)' }}>
            <div className="lbl" style={{ marginBottom: 10 }}>If it says blocked</div>
            {[
              [
                'The page is on https and the box is on http',
                'Browsers make one exception for localhost, and a Tailscale or LAN name is not it. Nothing can be configured away — run the studio over http and it works. A hosted copy will still drive a ComfyUI on your own machine.',
                'var(--ox)',
              ],
              [
                'Reachable, but no CORS header',
                'Start ComfyUI with --enable-cors-header.',
                'var(--amb)',
              ],
              [
                'Reachable, but the recipe’s models are missing',
                'The graph is passed through untouched, so a checkpoint that is not on the box fails inside the render rather than here.',
                'var(--amb)',
              ],
            ].map(([title, body, colour]) => (
              <div key={title} style={{ display: 'flex', gap: 13, padding: '13px 0', borderBottom: '1px solid var(--rule)' }}>
                <span className="dot" style={{ background: colour, marginTop: 6 }} />
                <div>
                  <div style={{ fontSize: 12, color: 'var(--ink)', fontWeight: 500 }}>{title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink2)', lineHeight: 1.6, marginTop: 4 }}>{body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="tok">The clips are files on your box; the studio only holds their addresses.</span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

/** The right-hand rail: what this render will be, and the button that starts it. */
export function RenderRail({ onOpen }: { onOpen: (m: 'recipe' | 'plates' | 'endpoint') => void }) {
  const { endpoint, comfyProbes, recipe, plates, settings, blockers, render, rendering, clips } = useApp()
  const probe = endpoint ? comfyProbes[endpoint.id] : undefined
  const recent = [...clips].reverse().slice(0, 4)

  const Row = ({ k, children, onClick }: { k: string; children: React.ReactNode; onClick?: () => void }) => (
    <div className="kvrow" onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }}>
      <span className="k">{k}</span>
      <span className="v">{children}</span>
    </div>
  )

  return (
    <>
      <div className="lbl" style={{ marginBottom: 4 }}>Render</div>

      <Row k="Recipe" onClick={() => onOpen('recipe')}>
        {recipe ? recipe.name : <span style={{ color: 'var(--ox)' }}>none — drop a workflow</span>}
      </Row>
      <Row k="Endpoint" onClick={() => onOpen('endpoint')}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {endpoint ? endpoint.label : 'none'}
          <span className={`dot ${BADGE[probe?.state ?? 'unknown']?.cls ?? 'idle'}`} />
        </span>
      </Row>
      <Row k="Plates" onClick={() => onOpen('plates')}>
        {plates.length} bound <span className="tok">of 9</span>
      </Row>
      <Row k="Seed">
        {settings.seed} <span className="tok">{settings.lockSeed ? 'locked across clips' : 'random each clip'}</span>
      </Row>
      <Row k="Length">
        {settings.seconds}s <span className="tok">snapped to the grid</span>
      </Row>

      <div style={{ marginTop: 14 }}>
        <button
          className="btn pri"
          style={{ width: '100%', justifyContent: 'center' }}
          disabled={!!rendering || blockers.length > 0}
          onClick={() => void render()}
        >
          {rendering ? `Rendering clip ${rendering.index}…` : 'Render this prompt'}
        </button>
        {blockers.length > 0 && (
          <div style={{ marginTop: 9 }}>
            {blockers.map((b) => (
              <div key={b} className="tok" style={{ display: 'block', color: 'var(--ox)', lineHeight: 1.55, marginTop: 4 }}>
                {b}
              </div>
            ))}
          </div>
        )}
      </div>

      {recent.length > 0 && (
        <>
          <div className="lbl" style={{ margin: '18px 0 7px' }}>Queue</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recent.map((c) => (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  className={`dot ${c.state === 'done' ? 'ok' : c.state === 'failed' ? 'err' : c.state === 'rendering' ? 'warn' : 'idle'}`}
                />
                <span style={{ fontSize: 11.5, color: 'var(--ink2)', flexGrow: 1 }}>clip {c.index}</span>
                <span className="tok">{c.ms ? `${Math.round(c.ms / 1000)}s` : c.state}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  )
}
