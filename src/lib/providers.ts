import { idb } from './db'
import type { Provider, ProbeResult } from './types'

export const DEFAULT_PROVIDERS: Provider[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    kind: 'openai',
    builtIn: true,
    corsHint: 'Restart Ollama so it accepts this page:\nOLLAMA_ORIGINS=<origin> ollama serve',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    baseUrl: 'http://localhost:1234/v1',
    kind: 'openai',
    builtIn: true,
    corsHint: 'Start the local server, then turn on “Enable CORS” in Developer ▸ Settings.',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp server',
    baseUrl: 'http://localhost:8080/v1',
    kind: 'openai',
    builtIn: true,
    sendCachePrompt: true,
    corsHint: 'Run llama-server with --host 0.0.0.0; it sends permissive CORS headers by default.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    kind: 'openai',
    builtIn: true,
  },
]

export function needsKey(p: Provider): boolean {
  return /openrouter\.ai|api\.openai\.com|anthropic\.com/.test(p.baseUrl)
}

/**
 * Is this endpoint reachable from this page at all?
 *
 * Browsers treat http://localhost (and 127.0.0.1 / ::1) as a secure origin, so
 * an HTTPS page may call them. That exemption does NOT extend to other hosts:
 * plain HTTP anywhere else is blocked as mixed content before the request is
 * ever sent, and no CORS header can change that. Catching it here means we can
 * say which failure it is instead of reporting a bare network error.
 */
export function mixedContentBlocked(baseUrl: string): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return false
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:') return false
  const h = u.hostname
  return !(h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1')
}

/** Safari is the one browser that does not treat http://localhost as secure. */
export function isSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)
}

export function localEndpoint(baseUrl: string): boolean {
  try {
    const h = new URL(baseUrl).hostname
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '::1'
  } catch {
    return false
  }
}

function headers(p: Provider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`
  return h
}

export async function probe(p: Provider, signal?: AbortSignal): Promise<ProbeResult> {
  const at = Date.now()
  if (mixedContentBlocked(p.baseUrl)) {
    return {
      state: 'mixed-content',
      detail:
        'This page is HTTPS and the endpoint is plain HTTP on a host that is not localhost. The browser refuses the request before it is sent — CORS headers cannot fix it.',
      models: [],
      at,
    }
  }
  if (needsKey(p) && !p.apiKey) {
    return { state: 'no-key', detail: 'Add an API key to use this provider.', models: [], at }
  }

  try {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, { headers: headers(p), signal })
    if (!res.ok) {
      return { state: 'error', detail: `HTTP ${res.status} ${res.statusText}`, models: [], at }
    }
    const body = (await res.json()) as { data?: { id: string }[] }
    const models = (body.data || []).map((m) => m.id).sort()
    return {
      state: 'ok',
      detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'reachable, no models listed',
      models,
      at,
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { state: 'unknown', detail: 'cancelled', models: [], at }
    // fetch() rejects with an opaque TypeError for both "nothing listening"
    // and "blocked by CORS" — the browser deliberately does not tell us which.
    return {
      state: 'unreachable',
      detail: localEndpoint(p.baseUrl)
        ? isSafari()
          ? 'Not reachable. Safari does not treat http://localhost as a secure origin — use Chrome, Edge or Firefox, or run this app locally.'
          : 'Not running, or not allowing this origin.'
        : 'Not reachable.',
      models: [],
      at,
    }
  }
}

export async function loadProviders(): Promise<Provider[]> {
  const saved = await idb.get<Provider[]>('settings', 'providers')
  if (!saved?.length) return DEFAULT_PROVIDERS.map((p) => ({ ...p }))
  // Keep built-ins current if their defaults change between versions, but
  // never clobber a URL or key the user set.
  const byId = new Map(saved.map((p) => [p.id, p]))
  const merged = DEFAULT_PROVIDERS.map((d) => {
    const s = byId.get(d.id)
    return s ? { ...d, baseUrl: s.baseUrl, apiKey: s.apiKey } : { ...d }
  })
  for (const s of saved) if (!s.builtIn) merged.push(s)
  return merged
}

export async function saveProviders(providers: Provider[]): Promise<void> {
  await idb.set('settings', 'providers', providers)
}
