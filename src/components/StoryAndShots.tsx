import { useState } from 'react'
import { useApp } from '../app/state'
import { checkRuntimeCeiling, groupsAffectedByCut, parsePartialShotList } from '../lib/shotList'
import { ceilingAlert, groupBandState } from '../lib/shotScreens'
import type { GroupBandState } from '../lib/shotScreens'
import { EXTENDER_REF_SLOTS } from '../lib/extender'
import { DraftingStatus } from './DraftingStatus'

function bandColor(state: GroupBandState): string {
  if (state === 'kept') return 'var(--grn)'
  if (state === 'waiting') return 'var(--amb)'
  return 'var(--rule2)'
}

function bandLabel(state: GroupBandState): string {
  if (state === 'kept') return 'kept · validated'
  if (state === 'waiting') return 'rendered-and-waiting'
  return 'not yet written'
}

/**
 * Screen 1 — "Story & shots" (2026-09-17 brief). The plot and the runtime
 * ceiling live HERE; a rendered clip reports its own state back onto the
 * SAME list, so this stays the one map of the film. Approving a set derives
 * a `BreakdownClip` and hands it straight to the EXISTING per-clip
 * Direct/Draft path (`app.approveShotGroups`) — nothing here writes camera,
 * performance or an H3 prompt.
 */
export function StoryAndShots({
  onOpenClipInHand,
  onOpenPlates,
}: {
  onOpenClipInHand: (groupIndex: number) => void
  onOpenPlates: () => void
}) {
  const app = useApp()
  const {
    plot, setPlot, maxRuntimeSeconds, setMaxRuntimeSeconds, shotList, shotGroups, shotGroupIssues,
    shotListBusy, shotStreaming, makeShotList, reviseShotsFrom, approveShotGroups, breakdown, extenderPlanPreview,
    setEditingGroupIndex, streaming, plates, platesFrozenReason,
  } = app

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [revFrom, setRevFrom] = useState(1)
  const [revOpen, setRevOpen] = useState(false)

  const bandFor = (groupIndex: number): GroupBandState => {
    const approved = !!breakdown?.clips.some((c) => c.index === groupIndex)
    const validated = extenderPlanPreview?.clips.find((c) => c.index === groupIndex)?.validated ?? false
    return groupBandState(approved, validated)
  }

  const busy = shotListBusy || !!streaming

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const doApprove = async () => {
    const indices = [...selected].sort((a, b) => a - b)
    setSelected(new Set())
    await approveShotGroups(indices)
  }

  const ceiling = shotList ? checkRuntimeCeiling(shotList.shots, maxRuntimeSeconds) : null
  const alert = ceiling ? ceilingAlert(ceiling) : null

  const revPreview = shotGroups.length ? groupsAffectedByCut(shotGroups, revFrom) : null
  const revDiscardCount = revPreview
    ? revPreview.discardedGroupIndices.filter((i) => extenderPlanPreview?.clips.find((c) => c.index === i)?.validated).length
    : 0

  const openInHand = (groupIndex: number) => {
    setEditingGroupIndex(groupIndex)
    onOpenClipInHand(groupIndex)
  }

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">Story &amp; shots</span>
      </div>

      <div className="card">
        <div className="lbl">The plot</div>
        <textarea
          className="composer-textarea"
          style={{ minHeight: 120, marginTop: 6 }}
          value={plot}
          onChange={(e) => setPlot(e.target.value)}
          placeholder="What happens, start to finish…"
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 9, flexWrap: 'wrap' }}>
          <label className="tok" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            maximum runtime
            <input
              type="number"
              min={5}
              value={maxRuntimeSeconds}
              onChange={(e) => setMaxRuntimeSeconds(Number(e.target.value) || maxRuntimeSeconds)}
              style={{ width: 64 }}
            />
            seconds
          </label>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" disabled={!plot.trim() || busy} onClick={() => void makeShotList()}>
            {shotListBusy ? 'Making the shot list…' : shotList ? 'Remake the shot list' : 'Make the shot list'}
          </button>
        </div>
      </div>

      <div className="card" style={{ marginTop: 9 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <div className="lbl">Plates</div>
          <div style={{ flexGrow: 1 }} />
          <span className="tok">{plates.length} of {EXTENDER_REF_SLOTS}</span>
          <button className="btn sm" onClick={onOpenPlates}>Manage plates</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 4 }}>
          Recurring characters need a plate to stay the same person across clips — a prompt cites one as
          &lt;Picture N&gt;, so position here is what a prompt means by N.
        </div>
        {plates.length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 9 }}>
            {plates.map((p, i) => (
              <span key={p.id} className="chip" title={p.job.trim() || 'No job written yet.'}>
                &lt;{p.kind === 'video' ? 'Video' : 'Picture'} {i + 1}&gt; {p.name}
                {!p.job.trim() && <span style={{ color: 'var(--ox)' }}> · no job</span>}
              </span>
            ))}
          </div>
        )}
        {platesFrozenReason && <div className="alert warn" style={{ marginTop: 9 }}>{platesFrozenReason}</div>}
      </div>

      {shotStreaming && (
        <div className="card" style={{ marginTop: 9 }}>
          <DraftingStatus streaming={shotStreaming} />
          {(() => {
            // Shots close off in ARRIVAL order and never get rewritten once
            // closed (the model is a forward-only token stream), so — unlike
            // a band that reflects render/approval state and can flip
            // colors — a running total here only ever grows. Showing it live
            // is a plain "how far in are we", not something that can jitter;
            // see `parsePartialShotList`'s module comment for why a shot only
            // appears once its object has fully closed.
            const partial = parsePartialShotList(shotStreaming.text)
            if (!partial.shots.length) return null
            const total = partial.shots.reduce((sum, s) => sum + s.seconds, 0)
            return (
              <div style={{ marginTop: 9 }}>
                <div className="tok">
                  {partial.shots.length} shot{partial.shots.length === 1 ? '' : 's'} so far · {total.toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s
                </div>
                {partial.shots.map((s) => (
                  <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0', color: 'var(--ink2)' }}>
                    <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                    <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                    <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {shotList && (
        <>
          <div className="card" style={{ marginTop: 9 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
              <span className="lbl">Authored vs. ceiling</span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok">
                {ceiling?.totalSeconds.toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s
              </span>
            </div>
            <div style={{ display: 'flex', height: 8, border: '1px solid var(--rule)', background: 'var(--sunk)', overflow: 'hidden', marginTop: 8 }}>
              {shotGroups.map((g) => {
                const state = bandFor(g.index)
                const pct = maxRuntimeSeconds > 0 ? Math.min(100, (g.seconds / maxRuntimeSeconds) * 100) : 0
                return <div key={g.index} style={{ width: `${pct}%`, background: bandColor(state) }} title={`clip ${g.index} · ${bandLabel(state)} · ${g.seconds}s`} />
              })}
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 7 }}>
              {(['kept', 'waiting', 'unwritten'] as const).map((state) => (
                <span key={state} className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: bandColor(state), display: 'inline-block', flex: '0 0 auto' }} />
                  {bandLabel(state)}
                </span>
              ))}
            </div>
            {alert && <div className="alert warn" style={{ marginTop: 9 }}>{alert}</div>}
          </div>

          {shotGroupIssues.length > 0 && (
            <div className="alert warn" style={{ marginTop: 9 }}>
              {shotGroupIssues.map((i) => <div key={i}>{i}</div>)}
            </div>
          )}

          <div className="card" style={{ marginTop: 9 }}>
            <div className="lbl">Revise from a shot</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7 }}>
              <span className="tok">from shot</span>
              <input type="number" min={1} value={revFrom} onChange={(e) => { setRevFrom(Number(e.target.value) || 1); setRevOpen(false) }} style={{ width: 56 }} />
              <span className="tok">— edit the plot above first, then</span>
              <button className="btn sm" disabled={busy} onClick={() => setRevOpen(true)}>Preview revision</button>
            </div>
            {revOpen && (
              <div style={{ marginTop: 9 }}>
                {revDiscardCount > 0 ? (
                  <div className="alert warn">
                    Regenerating from shot {revFrom} discards {revDiscardCount} rendered clip{revDiscardCount === 1 ? '' : 's'} — they no longer
                    follow what the shot list will say.
                  </div>
                ) : (
                  <div className="tok">Nothing rendered yet is affected by this cut.</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn pri sm"
                    disabled={busy}
                    onClick={() => { setRevOpen(false); void reviseShotsFrom(revFrom) }}
                  >
                    {revDiscardCount > 0 ? `Discard ${revDiscardCount} and regenerate` : 'Regenerate from here'}
                  </button>
                  <button className="btn sm ghost" onClick={() => setRevOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            {shotGroups.map((g) => {
              const state = bandFor(g.index)
              const groupShots = shotList.shots.filter((s) => g.shotIndices.includes(s.index))
              return (
                <div className="card" key={g.index} style={{ marginBottom: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                    {state === 'unwritten' && (
                      <input type="checkbox" checked={selected.has(g.index)} onChange={() => toggle(g.index)} />
                    )}
                    <span className="tok">{g.index}</span>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>clip {g.index}</span>
                    <span className="tok">{g.seconds.toFixed(1)}s</span>
                    <div style={{ flexGrow: 1 }} />
                    <span className="tok" style={{ color: bandColor(state) }}>{bandLabel(state)}</span>
                    {state !== 'unwritten' && (
                      <button className="btn sm ghost" onClick={() => openInHand(g.index)}>open in “the clip in hand”</button>
                    )}
                  </div>
                  <div style={{ marginTop: 7 }}>
                    {groupShots.map((s) => (
                      <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0', color: 'var(--ink2)' }}>
                        <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                        <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                        <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {selected.size > 0 && (
            <button className="btn pri" disabled={busy} onClick={() => void doApprove()} style={{ marginTop: 4 }}>
              Approve {selected.size} and generate {selected.size === 1 ? 'its prompt' : 'their prompts'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
