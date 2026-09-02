import { useState } from 'react'
import { useApp } from '../app/state'
import type { Version } from '../lib/types'

/** Stages whose output is a prompt — the only ones that count as "ready" for a clip. */
const PROMPT_STAGES = new Set(['draft', 'revise', 'rebuild', 'freeform'])

/** The clip plan a Break down pass produced, and one way in per clip. */
export function ClipPlan() {
  const app = useApp()
  const { breakdown, versions, streaming } = app
  if (!breakdown) return null

  const latestFor = (clipIndex: number): Version | undefined =>
    [...versions].reverse().find((v) => v.clipIndex === clipIndex && PROMPT_STAGES.has(v.stage))

  return (
    <div style={{ padding: '4px 26px 0' }}>
      <div className="lbl" style={{ marginBottom: 7 }}>
        Clip plan{breakdown.spine ? ` — ${breakdown.spine}` : ''}
      </div>
      {breakdown.clips.map((c) => {
        const ready = latestFor(c.index)
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
            </div>
            {c.covers && (
              <div className="tok" style={{ marginTop: 6, lineHeight: 1.55, color: 'var(--ink2)' }}>
                {c.covers}
              </div>
            )}
          </div>
        )
      })}

      <MulticlipSubmit />
    </div>
  )
}

/**
 * One job for the whole plan: MiniMax H3 Long Media, `workflow_mode: 'multiclip'`.
 *
 * The frame accounting is shown BEFORE the submit button on purpose — the
 * delivered length differs from what the plan asked for (the overlap tax, see
 * multiclip.ts), and that surprise is the whole point of surfacing it here
 * rather than after a 466-second render comes back short.
 */
function MulticlipSubmit() {
  const app = useApp()
  const { multiclipPreview, rendering, renderMulticlip, copyMulticlipGraph } = app
  const [copied, setCopied] = useState(false)
  if (!multiclipPreview) return null

  const { clips, totalSeconds, issues, warnings } = multiclipPreview
  const blocked = issues.length > 0 || !!rendering

  const copy = async () => {
    await copyMulticlipGraph()
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Long Media — the whole plan as one job</span>
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
        <button className="btn pri" disabled={blocked} onClick={() => void renderMulticlip()}>
          {rendering ? 'Rendering…' : `Submit all ${clips.length} as one job`}
        </button>
        <button className="btn ghost" disabled={issues.length > 0} onClick={() => void copy()}>
          {copied ? 'copied' : 'Copy the built graph'}
        </button>
      </div>
    </div>
  )
}
