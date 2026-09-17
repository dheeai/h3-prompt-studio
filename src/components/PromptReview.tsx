import { useState } from 'react'
import { useApp } from '../app/state'
import { lint, summarise } from '../lib/lint'
import { extenderCostEstimate } from '../lib/extender'
import { planForTickedSubmission, promptIsStale, shotsForGroup, toggledSet } from '../lib/shotScreens'
import { PromptDoc } from './PromptDoc'

/**
 * Gate A — "approve the prompts, one or several, and submit together"
 * (2026-09-17 brief; inverted 2026-09-17 per issue #32). Leads with the
 * shots each prompt came from — the index, what happens, and its
 * duration — the same band+shot-row treatment `StoryAndShots` already uses,
 * so the two screens read as one product. The six-section prompt
 * (`PromptDoc`, otherwise unused since the Full Story rewrite — see its own
 * file) collapses by default and opens PER PROMPT, never globally, via
 * `toggledSet` keyed on the prompt's own index. Everything Gate A already
 * did rides along unchanged: the per-prompt tick, the lint result
 * (`lib/lint.ts` — no new checks), the cost line
 * (`extenderCostEstimate`), and ONE `submitTickedPrompts` call
 * (`renderExtenderPlan('full_batch')` under a temporarily narrowed plan) —
 * never a second submit path.
 */
export function PromptReview({ onOpenClipInHand }: { onOpenClipInHand: (groupIndex: number) => void }) {
  const app = useApp()
  const {
    extenderPlanPreview, shotList, shotGroups, breakdown, settings, submitTickedPrompts, extenderReady, rendering,
    setEditingGroupIndex,
  } = app
  const [held, setHeld] = useState<Set<number>>(new Set())
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
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

  const toggle = (i: number) => setHeld((prev) => toggledSet(prev, i))
  const toggleExpanded = (i: number) => setExpanded((prev) => toggledSet(prev, i))

  const shotsFor = (groupIndex: number) => {
    const g = shotGroups.find((x) => x.index === groupIndex)
    if (!g || !shotList) return []
    return shotsForGroup(shotList.shots, g)
  }

  const staleFor = (groupIndex: number): boolean => {
    const g = shotGroups.find((x) => x.index === groupIndex)
    const bc = breakdown?.clips.find((x) => x.index === groupIndex)
    if (!g || !bc || !shotList) return false
    return promptIsStale(bc, shotList.shots, g)
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
        const stale = staleFor(c.index)
        const isExpanded = expanded.has(c.index)
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

            <div style={{ marginTop: 7 }}>
              {shots.map((s) => (
                <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0', color: 'var(--ink2)' }}>
                  <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                  <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                  <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                </div>
              ))}
            </div>

            {stale && (
              <div className="alert warn" style={{ marginTop: 8 }}>
                Clip {c.index}’s shots have changed since this prompt was written — reopen it in “the clip in hand” to
                rewrite it against what they say now.
              </div>
            )}

            <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={() => toggleExpanded(c.index)}>
              {isExpanded ? 'hide the full prompt' : 'show the full prompt'}
            </button>
            {isExpanded && (
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
                <PromptDoc text={c.prompt} />
              </div>
            )}
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
