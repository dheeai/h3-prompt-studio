import type { ComfyEndpoint } from './types'

/**
 * Live per-clip progress off the Master Extender node's own
 * `master_extender_progress` event, measured directly off `master_node.py`
 * on the box (issue #33, corrected scope — 2026-09-17):
 *
 *   PromptServer.instance.send_sync(EVENT_PROGRESS, {
 *     "owner": str(owner), "clip_index": int(clip_index), "total_clips": int(total_clips),
 *     "stage": str(stage), "message": str(message), "percent": float(pct),
 *   })
 *
 * where `EVENT_PROGRESS = "master_extender_progress"`. This is what turns a
 * six-clip batch's bare "Rendering… 71.0s" into "clip 4 of 6 · sampling ·
 * 40%" — the node broadcasts it over the SAME ComfyUI websocket the gateway
 * proxies at `/comfyui/ws`, so no polling is needed (or wanted: the event
 * stream exists precisely so nothing has to poll for this).
 *
 * `clip_index` is 0-based, as the node sends it — `h3-step-by-step`'s working
 * consumer (`submit.mjs`'s `watchProgress()`, the reference this was measured
 * against) displays it as `clip_index + 1`; callers here do the same.
 */
export interface ExtenderLiveProgress {
  /** The extender node's own id (`str(unique_id)` on the box) — the same
   * string this app already tracks as `Clip.extender.nodeId`/the graph's
   * `nodeId`. Used to tell this film's events apart from anyone else's job
   * on the same box (`matchesOwner`). */
  ownerId: string
  /** 0-based. */
  clipIndex: number
  totalClips: number
  stage: string
  message: string
  /** 0..1, clamped. */
  percent: number
}

/**
 * Validate an untrusted websocket message into a progress event, or `null`.
 *
 * The socket is a raw, unauthenticated ComfyUI feed carrying every event for
 * every job on the box — a hostile or simply malformed message must never
 * throw or produce a value with the wrong shape. `owner`/`clip_index`/
 * `total_clips` are checked strictly (they drive identity and arithmetic
 * downstream); `stage`/`message` fall back to `''` rather than rejecting the
 * whole event, the same tolerant contract `extender.ts`'s
 * `parseExtenderPreviewInfo` already uses for `cache_mode`.
 */
export function parseExtenderProgressEvent(raw: unknown): ExtenderLiveProgress | null {
  if (typeof raw !== 'object' || raw === null) return null
  const envelope = raw as Record<string, unknown>
  if (envelope.type !== 'master_extender_progress') return null

  const data = envelope.data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  if (typeof d.owner !== 'string' || !d.owner) return null
  if (typeof d.clip_index !== 'number' || !Number.isFinite(d.clip_index)) return null
  if (typeof d.total_clips !== 'number' || !Number.isFinite(d.total_clips)) return null

  const percent = typeof d.percent === 'number' && Number.isFinite(d.percent) ? d.percent : 0
  return {
    ownerId: d.owner,
    clipIndex: d.clip_index,
    totalClips: d.total_clips,
    stage: typeof d.stage === 'string' ? d.stage : '',
    message: typeof d.message === 'string' ? d.message : '',
    percent: Math.min(1, Math.max(0, percent)),
  }
}

/** Whether a validated progress event belongs to THIS render's job — an
 * event for someone else's film (another tab, another node id still on the
 * box) must never overwrite this one's progress panel. */
export function matchesOwner(evt: ExtenderLiveProgress, ownerId: string): boolean {
  return evt.ownerId === ownerId
}

/**
 * ws(s) URL for the gateway's ComfyUI websocket bridge — the same endpoint
 * every other call in `comfy.ts` uses, `http(s)` swapped for `ws(s)`, exactly
 * as `h3-step-by-step/submit.mjs`'s `watchProgress()` (the working reference
 * this was measured against) connects: `ENDPOINT.replace(/^http/, 'ws') +
 * '/ws?clientId=...'`.
 */
export function extenderWsUrl(ep: ComfyEndpoint, clientId: string): string {
  const base = ep.baseUrl.replace(/\/+$/, '').replace(/^http/, 'ws')
  return `${base}/ws?${new URLSearchParams({ clientId })}`
}

export interface ExtenderProgressHandle {
  close: () => void
}

/** The slice of the DOM `WebSocket` this module actually uses — kept minimal
 * and structural (rather than importing the DOM lib type) so a fake can be
 * injected in a plain `node:test` run with no browser/jsdom present. */
export interface MinimalSocket {
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  close: () => void
}

export type SocketCtor = new (url: string) => MinimalSocket

const NOOP_HANDLE: ExtenderProgressHandle = { close: () => {} }

/**
 * Subscribe to live per-clip progress for one Master Extender job.
 *
 * BEST-EFFORT, never load-bearing (2026-09-17 brief: progress is decoration
 * on top of the existing poll-to-done, never a replacement for it). Every
 * failure mode is swallowed into the no-op handle rather than thrown:
 * `wsCtor` missing (no `WebSocket` global), construction itself throwing, a
 * connection that never opens, or one that drops mid-render — none of it
 * reaches the caller, which keeps polling `/history` exactly as it always
 * has. `wsCtor` defaults to the runtime's own `WebSocket` but is injectable so
 * this file's connect/parse/filter/disconnect lifecycle can be proven without
 * a live socket — see `extenderLiveProgress.test.ts`'s own note on what stays
 * unverified (the founder's GPU was not used to check this against a real
 * render).
 */
export function watchExtenderProgress(
  ep: ComfyEndpoint,
  ownerId: string,
  onProgress: (evt: ExtenderLiveProgress) => void,
  opts: { clientId?: string; wsCtor?: SocketCtor } = {},
): ExtenderProgressHandle {
  const Ctor = opts.wsCtor ?? (typeof WebSocket !== 'undefined' ? (WebSocket as unknown as SocketCtor) : undefined)
  if (!Ctor) return NOOP_HANDLE

  let socket: MinimalSocket
  try {
    socket = new Ctor(extenderWsUrl(ep, opts.clientId ?? 'h3-prompt-studio'))
  } catch {
    return NOOP_HANDLE
  }

  socket.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return
    let parsed: unknown
    try {
      parsed = JSON.parse(ev.data)
    } catch {
      return
    }
    const evt = parseExtenderProgressEvent(parsed)
    if (evt && matchesOwner(evt, ownerId)) onProgress(evt)
  }
  socket.onerror = () => {
    /* best-effort — the poll loop is what actually finishes the render */
  }

  return {
    close: () => {
      try {
        socket.close()
      } catch {
        /* the box may already be gone */
      }
    },
  }
}
