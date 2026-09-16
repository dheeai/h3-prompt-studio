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
    // A bare host is what people actually type. Default it to http, since a
    // ComfyUI on a LAN or a tailnet is almost never behind TLS.
    let clean = url.trim().replace(/\/+$/, '')
    if (clean && !/^https?:\/\//.test(clean)) clean = `http://${clean}`
    if (!/^https?:\/\/[^/]+/.test(clean)) return
    let host: string
    try {
      const u = new URL(clean)
      // Keep the port in the label: :8188 and :9000 on one machine are two
      // different boxes as far as this panel is concerned.
      host = u.port ? `${u.hostname}:${u.port}` : u.hostname
    } catch {
      return
    }
    const ep: ComfyEndpoint = {
      id: `e${Date.now().toString(36)}`,
      label: host,
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
                  <span
                    style={{ fontSize: 12.5, fontWeight: 500, flex: '0 1 auto', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={ep.label}
                  >
                    {ep.label}
                  </span>
                  <span className="tok" style={{ flex: '1 1 auto', minWidth: 0, wordBreak: 'break-all' }}>{ep.baseUrl}</span>
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
                'Reachable, but the workflow’s models are missing',
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

