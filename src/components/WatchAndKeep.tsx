import { useState } from 'react'
import { useApp } from '../app/state'
import { FilmRegion } from './FilmRegion'
import { ScenesStrip } from './ScenesStrip'
import { nextUnwrittenGroupIndex } from '../lib/shotScreens'

/**
 * Gate B — "watch, then keep" (2026-09-17 brief). `FilmRegion`/`ScenesStrip`
 * are reused exactly as they are — the film and its per-scene actions
 * already live there — and this adds the three exits over the newest
 * landed set:
 *
 * - **it stands** — the clip is already validated the instant it landed
 *   `done` (`validatedClipAt`); this exit's only job is to bring up the
 *   next shots (`nextUnwrittenGroupIndex`), never a second validation
 *   mechanism.
 * - **right idea, bad take** — redo on a fresh seed: `redoPlanClip` (drops
 *   the cached record) then `renderExtenderPlan('clip_by_clip')` — the
 *   SAME redo machinery `ClipPlan`'s own "Redo this scene" already uses,
 *   reused rather than reinvented.
 * - **wrong shots** — `discardGroupRender`: the prompt AND this render are
 *   discarded, back to "the clip in hand" to fix the shots themselves.
 *
 * "Keeping a clip is what makes the next set available" (the brief):
 * nothing here authors the next clip automatically — `autoAuthorNext` stays
 * off — "it stands" only surfaces the UI for it.
 */
export function WatchAndKeep({
  onOpenStoryAndShots,
  onOpenClipInHand,
}: {
  onOpenStoryAndShots: () => void
  onOpenClipInHand: (groupIndex: number) => void
}) {
  const app = useApp()
  const { extenderFilm, breakdown, shotGroups, redoPlanClip, renderExtenderPlan, discardGroupRender, rendering, setEditingGroupIndex } = app
  const [busy, setBusy] = useState(false)
  const [confirmingWrong, setConfirmingWrong] = useState(false)
  const [keepSeed, setKeepSeed] = useState(false)

  if (!extenderFilm || !extenderFilm.scenes.length) {
    return (
      <div style={{ padding: '24px 26px' }}>
        <span className="lbl">Watch, then keep</span>
        <div className="tok" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Nothing rendered yet — approve a set and submit it in “Approve the prompts” first.
        </div>
      </div>
    )
  }

  const newest = extenderFilm.scenes[extenderFilm.scenes.length - 1]
  const groupIndex = newest.sceneIndex
  const clipTitle = breakdown?.clips.find((c) => c.index === groupIndex)?.title || `clip ${groupIndex}`
  const busyNow = busy || !!rendering

  const keep = () => {
    const next = nextUnwrittenGroupIndex(shotGroups, breakdown)
    if (next !== undefined) {
      setEditingGroupIndex(next)
      onOpenClipInHand(next)
    } else {
      onOpenStoryAndShots()
    }
  }

  const redo = async () => {
    setBusy(true)
    try {
      redoPlanClip(groupIndex, { keepSeed })
      await renderExtenderPlan('clip_by_clip')
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    discardGroupRender(groupIndex)
    setConfirmingWrong(false)
    onOpenClipInHand(groupIndex)
  }

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">Watch, then keep</span>
      </div>

      <FilmRegion />
      <ScenesStrip />

      <div className="card" style={{ marginTop: 9 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <span className="tok">{groupIndex}</span>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{clipTitle}</span>
          <div style={{ flexGrow: 1 }} />
          <span className="tok">watch it above, then decide</span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button className="btn pri" disabled={busyNow} onClick={keep}>
            It stands — keep it
          </button>
          <button className="btn" disabled={busyNow} onClick={() => void redo()}>
            {busyNow ? 'Rendering…' : 'Right idea, bad take — redo'}
          </button>
          <button className="btn ghost" disabled={busyNow} onClick={() => setConfirmingWrong(true)}>
            Wrong shots — back to the set
          </button>
        </div>

        <label className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 8 }}>
          <input type="checkbox" checked={keepSeed} onChange={(e) => setKeepSeed(e.target.checked)} />
          keep the same seed on redo (unchecked draws a fresh one)
        </label>

        {confirmingWrong && (
          <div className="alert warn" style={{ marginTop: 9 }}>
            Discards clip {groupIndex}’s prompt and this render — every later clip too, since the render
            cache is a linear prefix. Back to “the clip in hand” to fix the shots.
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <button className="btn sm" onClick={discard}>Discard and go fix it</button>
              <button className="btn sm ghost" onClick={() => setConfirmingWrong(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
