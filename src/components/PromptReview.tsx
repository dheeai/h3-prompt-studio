import { useState } from 'react'
import { useApp } from '../app/state'
import { lint, summarise } from '../lib/lint'
import { extenderCostEstimate } from '../lib/extender'
import { planForTickedSubmission } from '../lib/shotScreens'

/**
 * Gate A — "approve the prompts, one or several, and submit together"
 * (2026-09-17 brief). Reads every authored-but-not-yet-rendered prompt side
 * by side, each with its own lint result (`lib/lint.ts` — no new checks) and
 * which shots it came from, and a per-prompt tick (default ON). Approving
 * ticks every ticked prompt (plus whatever is already validated, which
 * always rides along for free) into ONE `submitTickedPrompts` call, which is
 * `renderExtenderPlan('full_batch')` under a temporarily narrowed plan —
 * never a second submit path. The cost line reuses `extenderCostEstimate`
 * over exactly `toSubmit`, so what is shown is what is sent.
 */
export function PromptReview({ onOpenClipInHand }: { onOpenClipInHand: (groupIndex: number) => void }) {
  const app = useApp()
  const {
    extenderPlanPreview, shotList, shotGroups, settings, submitTickedPrompts, extenderReady, rendering,
    setEditingGroupIndex,
  } = app
  const [held, setHeld] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)

  if (!extenderPlanPreview) {
    return (
      <div style={{ padding: '24px 26px' }}>
        <span className="lbl">Approve the prompts</span>
        <div className="tok" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Nothing to review yet — approve a set in “Story &amp; shots” first.
        </div>
      </div>
    )
  }

  const pending = extenderPlanPreview.clips.filter((c) => !c.validated && c.prompt.trim())
  const tickedIndices = pending.filter((c) => !held.has(c.index)).map((c) => c.index)
  const { toSubmit } = planForTickedSubmission(extenderPlanPreview.clips, new Set(tickedIndices))
  const cost = extenderCostEstimate(toSubmit)
  const busyNow = busy || !!rendering

  const toggle = (i: number) =>
    setHeld((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const shotsFor = (groupIndex: number) => {
    const g = shotGroups.find((x) => x.index === groupIndex)
    if (!g || !shotList) return []
    return shotList.shots.filter((s) => g.shotIndices.includes(s.index))
  }

  const openInHand = (groupIndex: number) => {
    setEditingGroupIndex(groupIndex)
    onOpenClipInHand(groupIndex)
  }

  const submit = async () => {
    setBusy(true)
    try {
      await submitTickedPrompts(tickedIndices)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">Approve the prompts</span>
      </div>

      {!pending.length && (
        <div className="tok" style={{ marginTop: 12, display: 'block' }}>
          Nothing waiting on a decision — every authored prompt is already validated.
        </div>
      )}

      {pending.map((c) => {
        const findings = lint(c.prompt, settings.mode)
        const counts = summarise(findings)
        const shots = shotsFor(c.index)
        return (
          <div className="card" key={c.index} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
              <input type="checkbox" checked={!held.has(c.index)} onChange={() => toggle(c.index)} />
              <span className="tok">{c.index}</span>
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.title}</span>
              <span className="tok">{c.seconds.toFixed(1)}s</span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok">
                {counts.error > 0 && <span style={{ color: 'var(--ox)' }}>{counts.error} must fix · </span>}
                {counts.warn > 0 && <span style={{ color: 'var(--amb)' }}>{counts.warn} check · </span>}
                <span style={{ color: 'var(--grn)' }}>{counts.pass} pass</span>
              </span>
              <button className="btn sm ghost" onClick={() => openInHand(c.index)}>open in “the clip in hand”</button>
            </div>
            {shots.length > 0 && (
              <div className="tok" style={{ marginTop: 6, display: 'block', color: 'var(--ink3)' }}>
                from shot{shots.length === 1 ? '' : 's'} {shots.map((s) => s.index).join(', ')}
              </div>
            )}
            <div className="tok" style={{ marginTop: 8, display: 'block', whiteSpace: 'pre-wrap', lineHeight: 1.55, color: 'var(--ink2)' }}>
              {c.prompt}
            </div>
          </div>
        )
      })}

      {pending.length > 0 && (
        <div className="card" style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
            <span className="lbl">Submit as one Master Extender job</span>
            <div style={{ flexGrow: 1 }} />
            <span className="tok">
              {cost.totalSeconds.toFixed(1)}s · {cost.toSample} to sample · {cost.fromCache} from cache
            </span>
          </div>

          {extenderPlanPreview.issues.length > 0 && (
            <div className="alert warn" style={{ marginTop: 8 }}>
              {extenderPlanPreview.issues.map((i) => <div key={i}>{i}</div>)}
            </div>
          )}

          <button
            className="btn pri"
            style={{ marginTop: 10 }}
            disabled={!tickedIndices.length || !extenderReady || busyNow}
            onClick={() => void submit()}
          >
            {busyNow ? 'Rendering…' : `Approve ${tickedIndices.length} and render`}
          </button>
        </div>
      )}
    </div>
  )
}
