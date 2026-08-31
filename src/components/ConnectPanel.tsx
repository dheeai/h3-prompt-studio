import { useState } from 'react'
import { useApp } from '../app/state'
import { isSafari, localEndpoint, localNetworkTarget, mixedContentBlocked, needsKey, pageIsPublic } from '../lib/providers'
import type { Provider } from '../lib/types'

function StatusBadge({ state }: { state: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    ok: { cls: 'ok', label: 'connected' },
    probing: { cls: 'idle', label: 'checking…' },
    'mixed-content': { cls: 'err', label: 'blocked' },
    'local-network-blocked': { cls: 'err', label: 'blocked' },
    unreachable: { cls: 'idle', label: 'not reachable' },
    'no-key': { cls: 'warn', label: 'needs a key' },
    error: { cls: 'warn', label: 'error' },
    unknown: { cls: 'idle', label: '—' },
  }
  const s = map[state] ?? map.unknown
  return (
    <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span className={`dot ${s.cls}`} />
      {s.label}
    </span>
  )
}

function ProviderCard({ provider }: { provider: Provider }) {
  const { probes, providers, setProviders, refreshProbe, settings, patchSettings } = useApp()
  const probe = probes[provider.id]
  const [url, setUrl] = useState(provider.baseUrl)
  const [key, setKey] = useState(provider.apiKey ?? '')
  const [showKey, setShowKey] = useState(false)
  const selected = settings.providerId === provider.id
  const blocked = mixedContentBlocked(provider.baseUrl)
  const lanRisk = !blocked && pageIsPublic() && !!localNetworkTarget(provider.baseUrl)

  const save = async (patch: Partial<Provider>) => {
    await setProviders(providers.map((p) => (p.id === provider.id ? { ...p, ...patch } : p)))
  }

  return (
    <div className={`card${probe?.state === 'ok' ? ' ok' : blocked ? ' err' : ''}`}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600 }}>{provider.label}</span>
        {localEndpoint(provider.baseUrl) && <span className="tok" style={{ color: 'var(--grn)' }}>local</span>}
        <div style={{ flexGrow: 1 }} />
        {probe?.state === 'ok' && <span className="tok">{probe.detail}</span>}
        <StatusBadge state={probe?.state ?? 'unknown'} />
      </div>

      <div style={{ display: 'flex', gap: 7, marginTop: 9 }}>
        <input
          type="text"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => url !== provider.baseUrl && void save({ baseUrl: url.trim() })}
          spellCheck={false}
          style={{ flexGrow: 1, fontFamily: 'var(--mono)', fontSize: 11 }}
          aria-label={`${provider.label} endpoint`}
        />
        <button className="btn sm" onClick={() => void refreshProbe(provider.id)}>
          Check
        </button>
      </div>

      {needsKey(provider) && (
        <div style={{ display: 'flex', gap: 7, marginTop: 7 }}>
          <input
            type={showKey ? 'text' : 'password'}
            value={key}
            placeholder="API key — stored in this browser only"
            onChange={(e) => setKey(e.target.value)}
            onBlur={() => key !== (provider.apiKey ?? '') && void save({ apiKey: key.trim() || undefined })}
            spellCheck={false}
            style={{ flexGrow: 1, fontFamily: 'var(--mono)', fontSize: 11 }}
            aria-label={`${provider.label} API key`}
          />
          <button className="btn sm" onClick={() => setShowKey((v) => !v)}>
            {showKey ? 'Hide' : 'Show'}
          </button>
          {provider.apiKey && (
            <button className="btn sm" onClick={() => { setKey(''); void save({ apiKey: undefined }) }}>
              Forget
            </button>
          )}
        </div>
      )}

      {blocked && (
        <div className="alert err" style={{ marginTop: 9 }}>
          <strong>Mixed content — the request never leaves the browser.</strong>
          <div style={{ marginTop: 4 }}>
            This page is HTTPS and the endpoint is plain HTTP on a host that isn’t <code>localhost</code>. The localhost exemption doesn’t
            extend to other machines, so the browser refuses it before anything is sent. CORS headers cannot fix this.
          </div>
          <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
            <div>
              <div className="tok" style={{ color: 'var(--ox)', marginBottom: 3 }}>give the box an HTTPS name</div>
              <div className="code">tailscale serve --bg 9000</div>
            </div>
            <div>
              <div className="tok" style={{ color: 'var(--ox)', marginBottom: 3 }}>or run this app over http</div>
              <div className="code">npx h3-prompt-studio</div>
            </div>
          </div>
        </div>
      )}

      {probe?.state === 'local-network-blocked' && (
        <div className="alert err" style={{ marginTop: 9 }}>
          <strong>Blocked by the browser’s local-network rule.</strong>
          <div style={{ marginTop: 4 }}>{probe.detail}</div>
          {probe.hint && <div style={{ marginTop: 6 }}>{probe.hint}</div>}
          <div className="code" style={{ marginTop: 8 }}>npx h3-prompt-studio</div>
        </div>
      )}

      {probe?.state === 'unreachable' && !blocked && (
        <div className="alert warn" style={{ marginTop: 9 }}>
          <div>{probe.detail}</div>
          {probe.hint && <div style={{ marginTop: 5 }}>{probe.hint}</div>}
          {probe.suggest && (
            <button className="btn sm" style={{ marginTop: 7 }} onClick={() => { setUrl(probe.suggest!); void save({ baseUrl: probe.suggest! }) }}>
              Use {probe.suggest}
            </button>
          )}
          {!probe.suggest && localEndpoint(provider.baseUrl) && provider.corsHint && (
            <div className="code" style={{ marginTop: 6 }}>
              {provider.corsHint.replace('<origin>', location.origin)}
            </div>
          )}
        </div>
      )}

      {probe?.state === 'error' && (
        <div className="alert warn" style={{ marginTop: 9 }}>
          <div>{probe.detail}</div>
          {probe.hint && <div style={{ marginTop: 5 }}>{probe.hint}</div>}
        </div>
      )}

      {lanRisk && probe?.state === 'ok' && (
        <div className="tok" style={{ marginTop: 7, lineHeight: 1.5 }}>
          Reachable now, but this is a local-network address on a publicly-served page — if it starts hanging, that is the browser’s
          local-network rule, not your server.
        </div>
      )}

      {probe?.state === 'ok' && probe.models.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <select
            value={selected ? settings.model : ''}
            onChange={(e) => patchSettings({ providerId: provider.id, model: e.target.value })}
            style={{ flexGrow: 1, fontFamily: 'var(--mono)', fontSize: 11 }}
            aria-label={`${provider.label} model`}
          >
            <option value="">choose a model…</option>
            {probe.models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          {selected && settings.model && <span className="tok" style={{ color: 'var(--ox)' }}>in use</span>}
        </div>
      )}
    </div>
  )
}

export function ConnectPanel({ onClose }: { onClose: () => void }) {
  const { providers, setProviders, settings } = useApp()
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState({ label: '', baseUrl: '' })

  const addCustom = async () => {
    if (!draft.baseUrl.trim()) return
    const id = `custom-${Date.now().toString(36)}`
    await setProviders([
      ...providers,
      { id, label: draft.label.trim() || 'Custom endpoint', baseUrl: draft.baseUrl.trim(), kind: 'openai', builtIn: false },
    ])
    setDraft({ label: '', baseUrl: '' })
    setAdding(false)
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Connect a model</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              Everything runs in your browser. Your text goes only to the endpoint you pick.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} />
          ))}

          {adding ? (
            <div className="card" style={{ marginTop: 9 }}>
              <div className="lbl" style={{ marginBottom: 8 }}>Any OpenAI-compatible endpoint</div>
              <div style={{ display: 'flex', gap: 7 }}>
                <input
                  type="text"
                  placeholder="Name"
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  style={{ width: 150 }}
                />
                <input
                  type="text"
                  placeholder="https://host/v1"
                  value={draft.baseUrl}
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                  spellCheck={false}
                  style={{ flexGrow: 1, fontFamily: 'var(--mono)', fontSize: 11 }}
                />
                <button className="btn pri sm" onClick={() => void addCustom()}>Add</button>
                <button className="btn sm" onClick={() => setAdding(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn" style={{ marginTop: 10 }} onClick={() => setAdding(true)}>
              ＋ Add an endpoint
            </button>
          )}

          {isSafari() && (
            <div className="alert warn" style={{ marginTop: 14 }}>
              <strong>Safari can’t reach local models from a hosted page.</strong> It’s the one browser that doesn’t treat{' '}
              <code>http://localhost</code> as a secure origin. Use Chrome, Edge or Firefox — or run the app locally with{' '}
              <code>npx h3-prompt-studio</code>.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="tok">
            {settings.model ? `using ${settings.model}` : 'no model chosen yet'}
          </span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose} disabled={!settings.model}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
