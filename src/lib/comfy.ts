import { mixedContentBlocked } from './providers'
import { pickAssembledVideo } from './chain'
import type { Clip, ComfyEndpoint, ComfyNode, ProbeResult } from './types'

/**
 * The operator's own ComfyUI, supplied by a gitignored `.env.local`.
 *
 * This exists because the alternative — hardcoding the gateway URL — publishes
 * it: `public/` and the bundle are served from a PUBLIC GitHub Pages site, so a
 * baked hostname is a permanent disclosure. Vite inlines `VITE_*` at BUILD
 * time and the Pages workflow builds from a fresh checkout with no
 * `.env.local`, so this is present on the operator's machine and absent from
 * the published bundle. It also survives the thing that keeps losing config:
 * browser storage is ORIGIN-scoped and the port is part of the origin, so a
 * dev-server port change starts from these defaults again.
 */
export const LOCAL_COMFY_URL: string | undefined = import.meta.env?.VITE_LOCAL_COMFY_URL

export const DEFAULT_ENDPOINTS: ComfyEndpoint[] = [
  ...(LOCAL_COMFY_URL
    ? [{ id: 'localbox', label: 'my box', baseUrl: LOCAL_COMFY_URL, builtIn: true } as ComfyEndpoint]
    : []),
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
    if (q.status === 403) {
      // MEASURED on our own gateway, 2026-08-31. ComfyUI validates the Origin
      // header against its OWN host and returns an EMPTY 403 when they differ.
      // Behind a reverse proxy that can never match — the proxy's ComfyUI sees
      // itself as 127.0.0.1:8188, so only `Origin: http://127.0.0.1:8188` is
      // accepted, which no browser will ever send. Worse, a proxy that adds
      // `access-control-allow-origin: *` itself makes the box look correctly
      // configured while every request is still refused, so this must be
      // diagnosed by the STATUS, never by the header.
      return {
        state: 'error',
        detail: 'ComfyUI refused the request because it carried an Origin header (403, empty body).',
        hint:
          'This is ComfyUI\'s own origin check, not a network problem — the same URL works from curl. ' +
          'Start ComfyUI with --enable-cors-header. Behind a reverse proxy, having the proxy drop or rewrite ' +
          'the Origin header works too. A CORS header added by the proxy does not fix this.',
        models: [],
        at,
      }
    }
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

/**
 * Upload one video and return the name the graph must cite.
 *
 * Same endpoint ComfyUI's own image upload uses (`/upload/image`) — measured
 * live on this box 2026-09-07 that it takes a video's bytes unchanged (the
 * handler is content-agnostic) and the file is immediately selectable by
 * `LoadVideo`/`VHS_LoadVideo`'s own folder-listing combo. Named separately
 * from `uploadImage`, and takes the `File` directly rather than a data URL —
 * a plate's data-URL contract exists so it survives a reload without the box,
 * which a video picked fresh off disk for one chain start never needs, and a
 * 20s+ video is commonly tens to hundreds of MB, not worth serializing twice.
 */
export async function uploadVideo(ep: ComfyEndpoint, file: File): Promise<{ filename: string; subfolder: string }> {
  const form = new FormData()
  form.append('image', file, file.name)
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
      // "(nodes: 136)" tells an operator nothing. ComfyUI already says exactly
      // which input on which node it objects to — pass that through.
      const nodeErrors = j?.node_errors as Record<string, { class_type?: string; errors?: Array<{ message?: string; details?: string }> }> | undefined
      if (nodeErrors && Object.keys(nodeErrors).length) {
        const lines = Object.entries(nodeErrors).flatMap(([node, info]) =>
          (info.errors ?? []).map((err) => {
            const what = [err.message, err.details].filter(Boolean).join(': ')
            return `node ${node}${info.class_type ? ` (${info.class_type})` : ''} — ${what || 'rejected'}`
          }),
        )
        if (lines.length) msg += `\n${lines.join('\n')}`
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

type HistoryEntry = { status?: Record<string, unknown>; outputs?: Record<string, unknown> }

/** Every file any node in this history entry reported as an output, in the
 * order `/history` returned them — whatever node produced it. */
function collectOutputFiles(entry: HistoryEntry): NonNullable<Clip['output']>[] {
  const files: NonNullable<Clip['output']>[] = []
  for (const out of Object.values(entry.outputs ?? {})) {
    for (const items of Object.values(out as Record<string, unknown>)) {
      if (!Array.isArray(items)) continue
      for (const it of items) {
        const f = it as { filename?: string; subfolder?: string; type?: string }
        if (f?.filename) files.push({ filename: f.filename, subfolder: f.subfolder ?? '', type: f.type ?? 'output' })
      }
    }
  }
  return files
}

async function fetchHistoryEntry(ep: ComfyEndpoint, promptId: string): Promise<HistoryEntry | null> {
  const r = await fetch(`${trim(ep.baseUrl)}/history/${promptId}`)
  if (!r.ok) return null
  const h = (await r.json()) as Record<string, HistoryEntry>
  return h[promptId] ?? null
}

export async function poll(ep: ComfyEndpoint, promptId: string): Promise<PollResult> {
  const entry = await fetchHistoryEntry(ep, promptId)
  if (!entry) return { done: false }

  const status = entry.status ?? {}
  if (status.status_str === 'error') {
    const messages = JSON.stringify(status.messages ?? status).slice(0, 300)
    return { done: true, failed: messages }
  }
  if (!status.completed) return { done: false }

  // Any node may be the one that saved; take the last file-bearing output
  // rather than assuming a node id, so a graph with VHS or SaveVideo both work.
  const files = collectOutputFiles(entry)
  const output = files[files.length - 1]
  return { done: true, output, failed: output ? undefined : 'The run finished but produced no file.' }
}

/**
 * Poll a Contex-Loop chain job. Unlike `poll()`, this cannot just take
 * whichever file came back — a chain job's history carries every scene's
 * checkpoint MP4 alongside the assembled film, and picking the wrong one
 * looks exactly like success (a valid, playable file at a plausible path).
 * `pickAssembledVideo` (chain.ts) is what tells them apart.
 */
export async function pollChain(ep: ComfyEndpoint, promptId: string, runName: string): Promise<PollResult> {
  const entry = await fetchHistoryEntry(ep, promptId)
  if (!entry) return { done: false }

  const status = entry.status ?? {}
  if (status.status_str === 'error') {
    const messages = JSON.stringify(status.messages ?? status).slice(0, 300)
    return { done: true, failed: messages }
  }
  if (!status.completed) return { done: false }

  const files = collectOutputFiles(entry)
  const output = pickAssembledVideo(files, runName)
  return {
    done: true,
    output,
    failed: output
      ? undefined
      : `The chain job finished, but no assembled film matching run '${runName}' was found among ${files.length} output(s) — ` +
        `check ComfyUI's output/h3_chains/${runName}/ directly.`,
  }
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
export function lastFrameOf(src: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finishResolve = (value: string) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (value: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(value)
    }
    const onAbort = () => {
      if (settled) return
      v.pause()
      v.removeAttribute('src')
      v.load()
      finishReject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.preload = 'auto'
    v.src = src

    const fail = (why: string) => () => finishReject(new Error(why))
    v.onerror = fail('Could not load the clip to read its last frame.')

    v.onloadeddata = () => {
      const t = Math.max(0, (v.duration || 0) - 0.05)
      const grab = () => {
        try {
          const c = document.createElement('canvas')
          c.width = v.videoWidth
          c.height = v.videoHeight
          const ctx = c.getContext('2d')
          if (!ctx) return finishReject(new Error('No 2D canvas context.'))
          ctx.drawImage(v, 0, 0)
          finishResolve(c.toDataURL('image/png'))
        } catch (e) {
          // A cross-origin video taints the canvas. ComfyUI sends
          // access-control-allow-origin:*, so this only bites a box that does not.
          finishReject(new Error(`Could not read the frame: ${(e as Error).message}`))
        }
      }
      if (Number.isFinite(t) && t > 0) {
        v.onseeked = grab
        v.currentTime = t
      } else grab()
    }
  })
}

export interface VideoMetadata {
  durationSeconds: number
  width: number
  height: number
}

/**
 * Read a video's own duration/geometry in the browser, without downloading
 * it — `preload="metadata"` asks for just the container header. This is what
 * lets the video door's "what you will get" table state a source's real
 * length (56.928s for `dhee_src.mp4`, measured live 2026-09-07) instead of
 * asking the operator to already know it.
 */
export function videoMetadata(src: string, signal?: AbortSignal): Promise<VideoMetadata> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const finish = (value: VideoMetadata) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const fail = (e: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(e)
    }
    const onAbort = () => {
      v.pause()
      v.removeAttribute('src')
      v.load()
      fail(new DOMException('The operation was aborted.', 'AbortError'))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    v.preload = 'metadata'
    v.muted = true
    v.src = src
    v.onerror = () => fail(new Error('Could not read that video.'))
    v.onloadedmetadata = () => finish({ durationSeconds: v.duration || 0, width: v.videoWidth, height: v.videoHeight })
  })
}

/** ComfyUI rejected the request for carrying an Origin header. */
export class OriginRefused extends Error {
  constructor() {
    super(
      'ComfyUI refused the listing because the request came from a browser (403). ' +
        'Start it with --enable-cors-header, or have the proxy in front of it drop the Origin header.',
    )
  }
}

/**
 * What is already sitting in ComfyUI's input folder.
 *
 * Every file-picking node publishes its folder listing as a COMBO in
 * /object_info, which is the only enumeration ComfyUI offers — there is no
 * directory API. LoadImage carries the images; VHS_LoadVideo the videos.
 * Assets a person already built on the box should never have to be uploaded
 * back to it from here.
 */
export async function listBoxInputs(ep: ComfyEndpoint): Promise<{ images: string[]; videos: string[] }> {
  const base = trim(ep.baseUrl)
  const combo = async (node: string, field: string): Promise<string[]> => {
    try {
      const r = await fetch(`${base}/object_info/${node}`)
      // A refused request must not read as an empty folder. Everything else
      // (a node this box does not have) legitimately means "no files".
      if (r.status === 403) throw new OriginRefused()
      if (!r.ok) return []
      const j = (await r.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>
      const spec = j[node]?.input?.required?.[field]
      const list = Array.isArray(spec) ? spec[0] : null
      return Array.isArray(list) ? (list as string[]).filter((x) => typeof x === 'string') : []
    } catch (e) {
      if (e instanceof OriginRefused) throw e
      return []
    }
  }
  const [images, videos] = await Promise.all([combo('LoadImage', 'image'), combo('VHS_LoadVideo', 'video')])
  return { images, videos }
}

/** A file already on the box, addressed for display. */
/**
 * `preview` is for VISUAL FEEDBACK ONLY — a browse tile or a plate's thumbnail.
 *
 * ComfyUI's `/view?preview=<format>;<quality>` re-encodes but never RESIZES
 * (server.py: `img.save(buffer, format, quality)`, no thumbnail/resize call), so
 * this buys bytes, not pixels. Measured against this box on 2026-09-07 — a
 * 2.5 MB input PNG comes back as 86 KB at `webp;60`, ~29x smaller, while a single
 * image's latency is unchanged (~0.4s either way; `webp;90` is actually SLOWER
 * than raw because the encode costs more than the transfer it saves). The win is
 * therefore aggregate: a browse grid of a few hundred inputs is ~720 MB raw.
 *
 * NEVER pass `preview` for an image that conditions a render or feeds the vision
 * analysis. Reference fidelity is paid for deliberately elsewhere (H3's
 * `ref_image_size: max` buys identity fidelity at several times the cost because
 * reference tokens ride through every sampling step); handing that path a lossy
 * re-encode silently spends that money on nothing. A `boxFile` plate is safe by
 * construction — the graph cites it by filename on the box, not through this URL.
 */
export function inputUrl(ep: ComfyEndpoint, filename: string, preview?: string): string {
  const q = new URLSearchParams({ filename, subfolder: '', type: 'input' })
  if (preview) q.set('preview', preview)
  return `${trim(ep.baseUrl)}/view?${q}`
}

/** Byte-cheapest re-encode that still reads fine in a 92px tile. */
export const THUMB_PREVIEW = 'webp;60'

/**
 * Every LoRA filename ComfyUI's `LoraLoaderModelOnly` node offers — the
 * box's whole LoRA folder, unfiltered. Filtering out the accelerator family
 * and gating explicit-content ones is a UI-layer decision (`chain.ts`'s
 * `selectableStyleLoras`), not this fetch's job.
 *
 * On the `light_paths` list alongside `/queue` and `/object_info`, so this is
 * safe to call any time — it never forces a GPU backend switch.
 *
 * Filenames may be percent-encoded (`HMBreasts%20-%20...`); never decode or
 * re-encode them here or anywhere downstream, or ComfyUI will not find the
 * file on disk.
 */
export async function listLoraNames(ep: ComfyEndpoint): Promise<string[]> {
  const base = trim(ep.baseUrl)
  const r = await fetch(`${base}/object_info/LoraLoaderModelOnly`)
  if (r.status === 403) throw new OriginRefused()
  if (!r.ok) return []
  const j = (await r.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>
  const spec = j.LoraLoaderModelOnly?.input?.required?.lora_name
  const list = Array.isArray(spec) ? spec[0] : null
  return Array.isArray(list) ? (list as string[]).filter((x) => typeof x === 'string') : []
}
