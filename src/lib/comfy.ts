import { mixedContentBlocked } from './providers'
import type { Clip, ComfyEndpoint, ComfyNode, ProbeResult } from './types'

export const DEFAULT_ENDPOINTS: ComfyEndpoint[] = [
  { id: 'local', label: 'localhost', baseUrl: 'http://127.0.0.1:8188', builtIn: true },
]

const trim = (u: string) => u.replace(/\/+$/, '')

/**
 * Probe a ComfyUI.
 *
 * Deliberately more than "did it answer": a box that responds but has no H3
 * nodes, or refuses uploads, will fail ninety seconds into a render instead of
 * here — and the whole point of a probe is to move that failure forward.
 */
export async function probeComfy(ep: ComfyEndpoint, signal?: AbortSignal): Promise<ProbeResult> {
  const base = trim(ep.baseUrl)
  const at = Date.now()

  if (mixedContentBlocked(base)) {
    return {
      state: 'mixed-content',
      detail: 'This page is on https and the box is on http.',
      hint:
        'Browsers make one exception for localhost, and a Tailscale or LAN name is not it. ' +
        'Nothing can be configured away here — run the studio over http (npm run dev, or the built copy) and it works.',
      models: [],
      at,
    }
  }

  try {
    const q = await fetch(`${base}/queue`, { signal })
    if (!q.ok) return { state: 'error', detail: `Queue check returned ${q.status}.`, models: [], at }
  } catch (e) {
    const msg = String((e as Error).message || e)
    return {
      state: 'unreachable',
      detail: msg,
      hint:
        'If the box is running, it is probably CORS: start ComfyUI with --enable-cors-header. ' +
        'A browser reports a blocked request and a dead host identically, so this may also just be off.',
      models: [],
      at,
    }
  }

  // Reachable. Now: does it actually have what a render needs?
  const found: string[] = []
  try {
    const r = await fetch(`${base}/object_info/MiniMaxH3ReferenceToVideo`, { signal })
    if (r.ok) {
      const j = (await r.json()) as Record<string, unknown>
      if (Object.keys(j).length) found.push('MiniMaxH3ReferenceToVideo')
    }
  } catch {
    /* the queue answered, so treat a node lookup failure as "unknown", not "down" */
  }

  return {
    state: 'ok',
    detail: found.length ? 'Reachable. H3 reference-to-video is installed.' : 'Reachable.',
    hint: found.length ? undefined : 'Could not confirm the H3 nodes are installed on this box.',
    models: found,
    at,
  }
}

/** Upload one image and return the name the graph must cite. */
export async function uploadImage(
  ep: ComfyEndpoint,
  dataUrl: string,
  filename: string,
): Promise<{ filename: string; subfolder: string }> {
  const blob = await (await fetch(dataUrl)).blob()
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  const r = await fetch(`${trim(ep.baseUrl)}/upload/image`, { method: 'POST', body: form })
  if (!r.ok) throw new Error(`Upload failed (${r.status}): ${(await r.text()).slice(0, 200)}`)
  const j = (await r.json()) as { name: string; subfolder?: string }
  return { filename: j.name, subfolder: j.subfolder ?? '' }
}

export async function submit(ep: ComfyEndpoint, graph: Record<string, ComfyNode>): Promise<string> {
  const r = await fetch(`${trim(ep.baseUrl)}/prompt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: graph }),
  })
  const text = await r.text()
  if (!r.ok) {
    // ComfyUI's validation errors are the useful ones — surface them whole
    // rather than as a status code, because they name the offending node.
    let msg = text.slice(0, 400)
    try {
      const j = JSON.parse(text)
      msg = j?.error?.message ? `${j.error.message}${j.error.details ? ` — ${j.error.details}` : ''}` : msg
      if (j?.node_errors && Object.keys(j.node_errors).length) {
        msg += ` (nodes: ${Object.keys(j.node_errors).join(', ')})`
      }
    } catch {
      /* not JSON; the raw text is what we have */
    }
    throw new Error(msg)
  }
  return (JSON.parse(text) as { prompt_id: string }).prompt_id
}

export interface PollResult {
  done: boolean
  failed?: string
  output?: Clip['output']
}

export async function poll(ep: ComfyEndpoint, promptId: string): Promise<PollResult> {
  const r = await fetch(`${trim(ep.baseUrl)}/history/${promptId}`)
  if (!r.ok) return { done: false }
  const h = (await r.json()) as Record<string, { status?: Record<string, unknown>; outputs?: Record<string, unknown> }>
  const entry = h[promptId]
  if (!entry) return { done: false }

  const status = entry.status ?? {}
  if (status.status_str === 'error') {
    const messages = JSON.stringify(status.messages ?? status).slice(0, 300)
    return { done: true, failed: messages }
  }
  if (!status.completed) return { done: false }

  // Any node may be the one that saved; take the last file-bearing output
  // rather than assuming a node id, so a graph with VHS or SaveVideo both work.
  let output: Clip['output'] | undefined
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const items of Object.values(out as Record<string, unknown>)) {
      if (!Array.isArray(items)) continue
      for (const it of items) {
        const f = it as { filename?: string; subfolder?: string; type?: string }
        if (f?.filename) output = { filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' }
      }
    }
  }
  return { done: true, output, failed: output ? undefined : 'The run finished but produced no file.' }
}

export function viewUrl(ep: ComfyEndpoint, o: NonNullable<Clip['output']>): string {
  const q = new URLSearchParams({ filename: o.filename, subfolder: o.subfolder, type: o.type })
  return `${trim(ep.baseUrl)}/view?${q}`
}

export async function interrupt(ep: ComfyEndpoint): Promise<void> {
  await fetch(`${trim(ep.baseUrl)}/interrupt`, { method: 'POST' }).catch(() => {})
}

/**
 * Grab a clip's final frame as a PNG data URL, in the browser.
 *
 * This is what closes the loop: the frame becomes the next clip's <Picture 1>.
 * Seeking exactly to `duration` lands past the last frame in some browsers and
 * paints black, so back off a hair.
 */
export function lastFrameOf(src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'auto'
    v.src = src

    const fail = (why: string) => () => reject(new Error(why))
    v.onerror = fail('Could not load the clip to read its last frame.')

    v.onloadeddata = () => {
      const t = Math.max(0, (v.duration || 0) - 0.05)
      const grab = () => {
        try {
          const c = document.createElement('canvas')
          c.width = v.videoWidth
          c.height = v.videoHeight
          const ctx = c.getContext('2d')
          if (!ctx) return reject(new Error('No 2D canvas context.'))
          ctx.drawImage(v, 0, 0)
          resolve(c.toDataURL('image/png'))
        } catch (e) {
          // A cross-origin video taints the canvas. ComfyUI sends
          // access-control-allow-origin:*, so this only bites a box that does not.
          reject(new Error(`Could not read the frame: ${(e as Error).message}`))
        }
      }
      if (Number.isFinite(t) && t > 0) {
        v.onseeked = grab
        v.currentTime = t
      } else grab()
    }
  })
}
