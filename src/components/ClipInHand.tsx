import { useState } from 'react'
import { useApp } from '../app/state'

/**
 * Screen 2 — "The clip in hand" (2026-09-17 brief). The set currently open,
 * on its own, with a link back to Story & shots. Editing here never touches
 * an H3 prompt — it only edits `shotList.shots`/`shotGroups` (via
 * `shotScreens.ts`'s pure editors, wired through `state.tsx`). Approving
 * writes the prompt through the EXISTING per-clip Direct/Draft path
 * (`app.approveShotGroups`), same as Screen 1's own approve.
 */
export function ClipInHand({ onOpenStoryAndShots }: { onOpenStoryAndShots: () => void }) {
  const app = useApp()
  const {
    shotList, shotGroups, editingGroupIndex, setEditingGroupIndex, breakdown,
    rewordShotText, retimeShotSeconds, addShotInGroup, dropShotByIndex, pullShotIntoGroup, pushShotOutOfGroup,
    approveShotGroups, shotListBusy, streaming,
  } = app
  const [newCovers, setNewCovers] = useState('')
  const [newSeconds, setNewSeconds] = useState(4)

  const busy = shotListBusy || !!streaming
  const groupPos = shotGroups.findIndex((g) => g.index === editingGroupIndex)
  const group = groupPos === -1 ? null : shotGroups[groupPos]

  if (!shotList || !group) {
    return (
      <div style={{ padding: '24px 26px' }}>
        <span className="lbl">The clip in hand</span>
        <div className="tok" style={{ marginTop: 12, lineHeight: 1.6 }}>
          No set is open. <button className="btn sm ghost" onClick={onOpenStoryAndShots}>Go to Story &amp; shots</button> and open one from its list.
        </div>
      </div>
    )
  }

  const groupShots = shotList.shots.filter((s) => group.shotIndices.includes(s.index))
  const approvedClip = breakdown?.clips.find((c) => c.index === group.index)
  const hasPrev = groupPos > 0
  const hasNext = groupPos < shotGroups.length - 1

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">The clip in hand</span>
        <div style={{ flexGrow: 1 }} />
        <button className="btn sm ghost" onClick={onOpenStoryAndShots}>&larr; Story &amp; shots</button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <button className="btn sm ghost" disabled={!hasPrev} onClick={() => setEditingGroupIndex(shotGroups[groupPos - 1].index)}>‹ prev set</button>
          <span className="tok">{group.index}</span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>clip {group.index}</span>
          <span className="tok">{group.seconds.toFixed(1)}s</span>
          {approvedClip && <span className="tok" style={{ color: 'var(--grn)' }}>approved · “{approvedClip.title}”</span>}
          <div style={{ flexGrow: 1 }} />
          <button className="btn sm ghost" disabled={!hasNext} onClick={() => setEditingGroupIndex(shotGroups[groupPos + 1].index)}>next set ›</button>
        </div>

        <div style={{ marginTop: 10 }}>
          {groupShots.map((s) => (
            <div key={s.index} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
              <span className="tok" style={{ width: 20, flex: '0 0 auto', marginTop: 7 }}>{s.index}</span>
              <textarea
                className="composer-textarea"
                style={{ minHeight: 40, flex: '1 1 auto' }}
                value={s.covers}
                onChange={(e) => rewordShotText(s.index, e.target.value)}
              />
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={s.seconds}
                onChange={(e) => retimeShotSeconds(s.index, Number(e.target.value) || s.seconds)}
                style={{ width: 56, marginTop: 7 }}
              />
              <button
                className="btn sm ghost"
                disabled={groupShots.length <= 1}
                onClick={() => dropShotByIndex(s.index)}
                style={{ marginTop: 5 }}
                title={groupShots.length <= 1 ? 'a set cannot be emptied to zero shots' : 'drop this shot'}
              >
                drop
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
          <textarea
            className="composer-textarea"
            style={{ minHeight: 36, flex: '1 1 auto' }}
            placeholder="a new shot — what happens"
            value={newCovers}
            onChange={(e) => setNewCovers(e.target.value)}
          />
          <input type="number" min={0.5} step={0.5} value={newSeconds} onChange={(e) => setNewSeconds(Number(e.target.value) || 4)} style={{ width: 56 }} />
          <button
            className="btn sm"
            disabled={!newCovers.trim()}
            onClick={() => { addShotInGroup(group.index, newCovers.trim(), newSeconds); setNewCovers('') }}
          >
            add shot
          </button>
        </div>

        {(hasNext) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn sm ghost" onClick={() => pullShotIntoGroup(group.index)}>pull a shot in from the next clip</button>
            <button className="btn sm ghost" disabled={groupShots.length <= 1} onClick={() => pushShotOutOfGroup(group.index)}>push the last shot out to the next clip</button>
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button className="btn pri" disabled={busy} onClick={() => void approveShotGroups([group.index])}>
            {approvedClip ? 'Re-approve and rewrite the prompt' : 'Approve and write the prompt'}
          </button>
        </div>
      </div>
    </div>
  )
}
