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

/** Is this page itself served from a public origin? */
export function pageIsPublic(): boolean {
  if (typeof location === 'undefined') return false
  const h = location.hostname
  return !(h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]' || h === '')
}

// RFC1918, loopback, link-local, and CGNAT 100.64.0.0/10 — the last one is
// where Tailscale hands out addresses.
const PRIVATE_IP =
  /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

/**
 * Will a browser treat this target as being on the local network?
 *
 * Chrome gates requests from a PUBLIC origin to a private-range address behind
 * Local Network Access, independently of scheme. HTTPS does not lift it — so a
 * `tailscale serve` endpoint clears mixed content and is still blocked. Only
 * localhost is exempt from both. We cannot resolve DNS here, so hostname
 * suffixes stand in for the addresses we know they map to.
 */
export function localNetworkTarget(baseUrl: string): 'ip' | 'tailscale' | 'mdns' | null {
  let h: string
  try {
    h = new URL(baseUrl).hostname
  } catch {
    return null
  }
  if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]') return null
  if (PRIVATE_IP.test(h)) return 'ip'
  if (h.endsWith('.ts.net')) return 'tailscale'
  if (h.endsWith('.local')) return 'mdns'
  return null
}

/**
 * Chrome gates public→local-network requests behind a PERMISSION, not a block.
 * Until it is granted the request hangs waiting for a prompt — and a prompt is
 * only shown off a user gesture, so a probe fired on page load silently stalls.
 */
export async function localNetworkPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> {
  try {
    const status = await navigator.permissions.query({ name: 'local-network-access' as PermissionName })
    return status.state
  } catch {
    return 'unsupported'
  }
}

/** https:// pointed at an explicit non-443 port is usually a plaintext port. */
export function schemePortMismatch(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'https:' || !u.port || u.port === '443') return null
    const fixed = new URL(baseUrl)
    fixed.port = ''
    return fixed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

/** The base must end in the version segment; we append /models and /chat/completions. */
export function missingVersionSegment(baseUrl: string): boolean {
  try {
    return !/\/v\d+$/.test(new URL(baseUrl).pathname.replace(/\/$/, ''))
  } catch {
    return false
  }
}

function headers(p: Provider): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (p.apiKey) h.Authorization = `Bearer ${p.apiKey}`
  return h
}

const PROBE_TIMEOUT_MS = 8000

/** A corrected URL that fixes every mistake we can see, not just the first. */
function repair(baseUrl: string): string | null {
  const stripped = schemePortMismatch(baseUrl)
  const needsVersion = missingVersionSegment(baseUrl)
  if (!stripped && !needsVersion) return null
  const fixed = (stripped ?? baseUrl).replace(/\/$/, '')
  return needsVersion ? `${fixed}/v1` : fixed
}

export async function probe(p: Provider, signal?: AbortSignal): Promise<ProbeResult> {
  const at = Date.now()
  const suggest = repair(p.baseUrl) ?? undefined
  const versionHint = missingVersionSegment(p.baseUrl)
    ? 'The base URL should end in /v1 — this app appends /models and /chat/completions to it.'
    : undefined

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

  // Without a deadline a gated request hangs indefinitely and the UI sits on
  // "checking…" forever, which reads as a bug in the app rather than a block.
  const timer = new AbortController()
  const timeout = setTimeout(() => timer.abort(), PROBE_TIMEOUT_MS)
  const onOuterAbort = () => timer.abort()
  signal?.addEventListener('abort', onOuterAbort)

  try {
    const res = await fetch(`${p.baseUrl.replace(/\/$/, '')}/models`, { headers: headers(p), signal: timer.signal })
    if (!res.ok) {
      return {
        state: 'error',
        detail: `HTTP ${res.status} ${res.statusText}`,
        hint: res.status === 404 ? versionHint : undefined,
        models: [],
        at,
      }
    }
    const body = (await res.json()) as { data?: { id: string }[] }
    const models = (body.data || []).map((m) => m.id).sort()
    return {
      state: 'ok',
      detail: models.length ? `${models.length} model${models.length === 1 ? '' : 's'}` : 'reachable, no models listed',
      hint: models.length ? undefined : versionHint,
      models,
      at,
    }
  } catch (e) {
    if (signal?.aborted) return { state: 'unknown', detail: 'cancelled', models: [], at }

    const timedOut = timer.signal.aborted
    const lan = localNetworkTarget(p.baseUrl)

    // A public page reaching a private-range address, hanging rather than
    // failing fast, is the signature of Chrome's Local Network Access gate.
    if (timedOut && lan && pageIsPublic()) {
      const permission = await localNetworkPermission()
      const what =
        lan === 'tailscale'
          ? 'A Tailscale address is on the local network as far as the browser is concerned'
          : 'This is a private-network address'
      if (permission === 'denied') {
        return {
          state: 'local-network-blocked',
          detail: `${what}, and local network access is currently blocked for this site.`,
          hint: 'Re-allow it from the settings icon at the left of the address bar, then press Check again.',
          models: [],
          at,
        }
      }
      return {
        state: 'local-network-blocked',
        detail: `${what}, and this page is served from a public origin. The browser needs your permission before it will connect — until you give it, the request just waits.`,
        hint:
          'Press Check and allow local network access when the browser asks. The prompt only appears when you click something, which is why it never showed on its own. Running the app locally (`npx h3-prompt-studio`) skips the prompt entirely.',
        models: [],
        at,
      }
    }

    if (suggest) {
      const portWrong = !!schemePortMismatch(p.baseUrl)
      return {
        state: 'unreachable',
        detail: portWrong
          ? 'The connection failed immediately, which usually means https:// is pointed at a plaintext port. A tailscale serve or reverse-proxy front-end listens on 443, not the application’s own port.'
          : 'Not reachable.',
        hint: versionHint,
        suggest,
        models: [],
        at,
      }
    }

    return {
      state: 'unreachable',
      detail: timedOut
        ? 'No response within 8 seconds.'
        : localEndpoint(p.baseUrl)
          ? isSafari()
            ? 'Not reachable. Safari does not treat http://localhost as a secure origin — use Chrome, Edge or Firefox, or run this app locally.'
            : 'Not running, or not allowing this origin.'
          : 'Not reachable.',
      hint: versionHint,
      models: [],
      at,
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', onOuterAbort)
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
