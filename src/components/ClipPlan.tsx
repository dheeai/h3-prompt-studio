import { useState } from 'react'
import { useApp } from '../app/state'
import type { Version } from '../lib/types'

/** Stages whose output is a prompt — the only ones that count as "ready" for a clip. */
const PROMPT_STAGES = new Set(['draft', 'revise', 'rebuild', 'freeform'])

/** The clip plan a Break down pass produced, and one way in per clip. */
export function ClipPlan() {
  const app = useApp()
  const { breakdown, versions, streaming, clips, chainPlanPreview, renderChainPlan, rendering } = app
  if (!breakdown) return null

  const latestFor = (clipIndex: number): Version | undefined =>
    [...versions].reverse().find((v) => v.clipIndex === clipIndex && PROMPT_STAGES.has(v.stage))

  // Whether THIS plan clip's scene has already landed as part of the plan's
  // own chain (as opposed to some other manually-continued chain) — the
  // signal that a "redo this scene alone" resubmit is even possible.
  const renderedFor = (clipIndex: number) =>
    chainPlanPreview &&
    clips.some((c) => c.chain?.runName === chainPlanPreview.runName && c.chain.sceneIndex === clipIndex && c.state === 'done')

  return (
    <div style={{ padding: '4px 26px 0' }}>
      <div className="lbl" style={{ marginBottom: 7 }}>
        Clip plan{breakdown.spine ? ` — ${breakdown.spine}` : ''}
      </div>
      {breakdown.clips.map((c) => {
        const ready = latestFor(c.index)
        const landed = renderedFor(c.index)
        return (
          <div className="card" key={c.index} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
              <span className="tok">{c.index}</span>
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.title || `clip ${c.index}`}</span>
              <span className="tok">
                {c.role} · {c.seconds}s
              </span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok" style={{ color: ready ? 'var(--grn)' : 'var(--ink3)' }}>
                {ready ? 'prompt ready' : 'no prompt yet'}
              </span>
              {ready && (
                <button className="btn sm ghost" onClick={() => app.selectVersion(ready.id)}>
                  read
                </button>
              )}
              <button
                className="btn sm"
                disabled={!!streaming}
                onClick={() => {
                  app.setFilm({
                    role: c.role,
                    spine: breakdown.spine,
                    precedes: c.precedes,
                    follows: c.follows,
                    covers: c.covers,
                    title: c.title,
                    clipIndex: c.index,
                  })
                  void app.rebuild('story')
                }}
              >
                Generate prompt
              </button>
              {landed && ready && (
                <button
                  className="btn sm ghost"
                  disabled={!!rendering}
                  title="Resample only this scene, resuming every other scene from its checkpoint"
                  onClick={() => void renderChainPlan(c.index)}
                >
                  Redo this scene
                </button>
              )}
            </div>
            {c.covers && (
              <div className="tok" style={{ marginTop: 6, lineHeight: 1.55, color: 'var(--ink2)' }}>
                {c.covers}
              </div>
            )}
          </div>
        )
      })}

      <ChainPlanSubmit />
    </div>
  )
}

/**
 * One Contex-Loop chain job for the whole plan — the studio's only multi-clip
 * render path (Long Media multiclip removed 2026-09-07).
 *
 * The frame accounting is shown BEFORE the submit button on purpose — the
 * delivered length differs from what the plan asked for (the overlap tax, see
 * chain.ts / frames.ts), and that surprise is the whole point of surfacing it
 * here rather than after a long render comes back short. A per-clip "Redo
 * this scene" action (above, once a clip has landed) resamples just one
 * scene via `scene_range`, without re-sampling its neighbours.
 */
function ChainPlanSubmit() {
  const app = useApp()
  const { chainPlanPreview, rendering, renderChainPlan } = app
  const [busy, setBusy] = useState(false)
  if (!chainPlanPreview) return null

  const { clips, totalSeconds, issues, warnings } = chainPlanPreview
  const blocked = issues.length > 0 || !!rendering || busy

  const submitAll = async () => {
    setBusy(true)
    try {
      await renderChainPlan()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Contex-Loop — the whole plan as one chain</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">{totalSeconds.toFixed(3)}s delivered</span>
      </div>

      <div style={{ marginTop: 10 }}>
        {clips.map((c) => (
          <div key={c.index} style={{ display: 'flex', alignItems: 'baseline', gap: 9, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}>
            <span className="tok" style={{ width: 18, flex: '0 0 auto' }}>{c.index}</span>
            <span style={{ fontSize: 11.5, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title}
            </span>
            <span className="tok">authored {c.authored}f</span>
            <span className="tok">rendered {c.rendered}f</span>
            <span className="tok" style={{ color: c.delivered < c.authored ? 'var(--ox)' : 'var(--ink2)' }}>
              delivered {c.delivered}f
            </span>
          </div>
        ))}
      </div>

      {issues.length > 0 && (
        <div className="card err" style={{ marginTop: 12 }}>
          {issues.map((i) => (
            <div key={i} style={{ fontSize: 11.5, lineHeight: 1.6 }}>{i}</div>
          ))}
        </div>
      )}
      {warnings.length > 0 && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
        <button className="btn pri" disabled={blocked} onClick={() => void submitAll()}>
          {rendering ? 'Rendering…' : `Submit all ${clips.length} as one chain`}
        </button>
      </div>
    </div>
  )
}
