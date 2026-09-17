import { useEffect, useState } from 'react'
import { useApp } from '../app/state'
import type { DraftingProgress } from '../lib/studio-workflow'
import type { ExtenderLiveProgress } from '../lib/extenderLiveProgress'

/**
 * What the model is doing, while it does it.
 *
 * `streaming` already carried `phase`, `reasoning`, `text` and `startedAt`,
 * but nothing rendered any of it — the only feedback was a greyed-out button,
 * so a long reasoning pass looked identical to a hang. thinkingcap in
 * particular thinks for a while before emitting a single visible token.
 *
 * Typed against `DraftingProgress` rather than `Api['streaming']` directly so
 * a caller with its own progress slot (the shots stage's `shotStreaming` —
 * see `state.tsx`'s module comment) can feed this same component; `Api`'s own
 * `streaming` (keyed to a `StageId`) is a subtype of it, so every existing
 * caller is unaffected.
 */
export function DraftingStatus({ streaming }: { streaming: DraftingProgress }) {
  const { cancel } = useApp()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [])
  const secs = Math.max(0, Math.round((now - streaming.startedAt) / 1000))
  const phase = streaming.phase ?? (streaming.text ? 'writing' : 'thinking')
  const label =
    phase === 'thinking' ? 'thinking'
    : phase === 'writing' ? 'writing the prompt'
    : phase === 'continuing' ? `continuing (round ${streaming.continuations})`
    : phase === 'thinking-recovery' ? 'recovering a truncated thought'
    : String(phase)
  // While thinking there is no prompt text yet, so show the reasoning tail —
  // otherwise the panel is empty for exactly the stretch it exists to cover.
  const body = streaming.text || streaming.reasoning
  const tail = body.slice(-400)
  return (
    <div className="composer-drafting">
      <div className="composer-drafting-head">
        <span className="dot err" />
        <span className="lbl">{streaming.stage} · {label}</span>
        {streaming.auto && (
          <span className="tok" style={{ color: 'var(--ink3)' }} title="Started automatically while a scene rendered — not something you clicked.">
            automatic
          </span>
        )}
        <span className="tok">{secs}s</span>
        {!streaming.text && streaming.reasoning ? <span className="tok">reasoning {streaming.reasoning.length} chars</span> : null}
        <span className="studio-grow" />
        {/* `cancel` already existed and even preserves the interrupted
            thought — it was simply never surfaced, so a pass that went off the
            rails could only be escaped by resetting the whole draft. */}
        <button className="btn sm" onClick={cancel}>Stop</button>
      </div>
      {tail ? <div className="composer-drafting-body tok">{tail}</div> : <div className="composer-drafting-body tok">waiting for the first token…</div>}
    </div>
  )
}

/**
 * A Master Extender render's live state, while it renders — the render-loop
 * counterpart of `DraftingStatus` above, and deliberately built from the
 * SAME primitives (`.composer-drafting`/`.dot`/`.lbl`/`.tok`) rather than a
 * second progress idiom invented for renders (2026-09-17 brief, issue #33).
 *
 * Fed by `watchExtenderProgress`'s `master_extender_progress` events
 * (`lib/extenderLiveProgress.ts`) — best-effort only. Nothing here is on the
 * path that actually finishes a render (the existing `/history`
 * poll-to-done in `comfy.ts` is); a caller with no live event yet (the
 * socket never connected, dropped, or the browser blocked it) simply never
 * renders this component, and the render completes exactly as it does
 * today. See `ClipPlan.tsx`'s and `ScenesStrip.tsx`'s own call sites for
 * what each shows in that fallback case.
 */
export function RenderProgress({ progress }: { progress: ExtenderLiveProgress }) {
  const pct = Math.round(progress.percent * 100)
  return (
    <div className="composer-drafting">
      <div className="composer-drafting-head">
        <span className="dot err" />
        <span className="lbl">clip {progress.clipIndex + 1} of {progress.totalClips}{progress.stage ? ` · ${progress.stage}` : ''}</span>
        <span className="studio-grow" />
        <span className="tok">{pct}%</span>
      </div>
      {progress.message ? <div className="composer-drafting-body tok">{progress.message}</div> : null}
    </div>
  )
}
