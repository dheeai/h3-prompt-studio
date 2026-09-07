import { useEffect, useState } from 'react'
import { useApp } from '../app/state'

/**
 * What the model is doing, while it does it.
 *
 * `streaming` already carried `phase`, `reasoning`, `text` and `startedAt`,
 * but nothing rendered any of it — the only feedback was a greyed-out button,
 * so a long reasoning pass looked identical to a hang. thinkingcap in
 * particular thinks for a while before emitting a single visible token.
 */
export function DraftingStatus({ streaming }: { streaming: NonNullable<ReturnType<typeof useApp>['streaming']> }) {
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
        <span className="tok">{secs}s</span>
        {!streaming.text && streaming.reasoning ? <span className="tok">reasoning {streaming.reasoning.length} chars</span> : null}
      </div>
      {tail ? <div className="composer-drafting-body tok">{tail}</div> : <div className="composer-drafting-body tok">waiting for the first token…</div>}
    </div>
  )
}
