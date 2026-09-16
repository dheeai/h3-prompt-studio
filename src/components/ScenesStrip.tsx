import { useState } from 'react'
import { useApp } from '../app/state'
import type { FilmSceneRow } from '../app/state'
import { deliveredVsAskedLine, secondsLabel } from '../lib/filmDisplay'

const WORK_DOT: Record<string, string> = {
  checkpointed: 'ok',
  restored: 'ok',
  sampling: 'warn',
  queued: 'idle',
  failed: 'err',
}

/**
 * "2. THE SCENES" — a horizontal strip beneath the film. Selecting a scene
 * puts its actions ON it: Continue from here, Redo this scene, Prompt.
 * There is no separate panel for any of this.
 *
 * Every scene is a valid Continue-from-here target, not just the newest
 * (founder addition, 2026-09-07: "Continue from here should be allowed on
 * any clip, not just the latest scene"). Continuing from scene N discards
 * every scene after it — the Master Extender's own validated-clip cache is
 * a linear prefix, so a scene that no longer follows what actually rendered
 * before it can no longer be trusted as "already sampled" either. The count
 * is shown and confirmed before anything is sent, free when there is
 * nothing to lose.
 *
 * "Redo this scene" (brought back 2026-09-16 — it existed for Contex-Loop as
 * "Replace scene" and was wrongly dropped with it) is the SAME discard, aimed
 * at this scene itself rather than the one after it: `redoScene` loads the
 * composer with this scene's OWN prompt and this film's PARENT clip as the
 * new render's parent, so the composer's existing "Discard K and make scene
 * N" gate — unchanged — is what actually confirms and sends it. Nothing here
 * sends anything by itself.
 */
export function ScenesStrip() {
  const { extenderFilm: film, rendering, gpuBusy, scenesFrom, prepareContinuation, redoScene, pendingAutoDraft } = useApp()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [showPrompt, setShowPrompt] = useState<string | null>(null)
  const [keepSeedFor, setKeepSeedFor] = useState<Record<string, boolean>>({})

  if (!film) return null
  const scenes = film.scenes
  const filmIsRendering = rendering?.extender?.nodeId === film.runName
  const busy = !!rendering || gpuBusy !== 'idle'

  const doContinue = (row: FilmSceneRow) => {
    prepareContinuation(row.clip.id)
    setExpanded(null)
  }

  const doRedo = (row: FilmSceneRow) => {
    redoScene(row.clip.id, { keepSeed: !!keepSeedFor[row.clip.id] })
    setExpanded(null)
  }

  return (
    <div className="scenes-strip">
      <div className="scenes-strip-head">
        <span className="lbl">Scenes</span>
        <span className="tok">click one to continue from it</span>
        <div className="studio-grow" />
        <span className="tok">{scenes.length} scene{scenes.length === 1 ? '' : 's'} · {film.totalFrames}f · {film.totalSeconds.toFixed(1)}s</span>
      </div>
      <div className="scenes-strip-row">
        {scenes.map((row) => {
          const isOpen = expanded === row.clip.id
          const laterAfterContinue = scenesFrom(row.clip.id, row.sceneIndex + 1)
          return (
            <div key={row.clip.id} className={`scene-card${isOpen ? ' open' : ''}`}>
              <button
                type="button"
                className="scene-card-face"
                onClick={() => setExpanded(isOpen ? null : row.clip.id)}
                aria-expanded={isOpen}
              >
                <div className="scene-card-thumb">
                  <span className="tok" style={{ fontSize: 18, color: 'var(--rule2)' }}>{row.sceneIndex}</span>
                </div>
                <div className="scene-card-meta">
                  <span className={`dot ${WORK_DOT[row.label]}`} />
                  <span className="lbl">Scene {row.sceneIndex}</span>
                  <div className="studio-grow" />
                  <span className="tok">{secondsLabel(row.delivered)}</span>
                </div>
              </button>
              {isOpen && (() => {
                // Inclusive of this scene itself — redoing it resamples it
                // AND every scene after it (append-only; see the module
                // comment), while every scene before it is served from cache.
                const toResample = scenesFrom(row.clip.id, row.sceneIndex)
                const fromCache = scenes.length - toResample
                return (
                <div className="scene-card-actions">
                  <div className="tok" style={{ marginBottom: 7 }}>
                    {deliveredVsAskedLine(row)} · seed {row.clip.seed} · {row.label}
                  </div>
                  <div className="scene-card-buttons">
                    <button className="btn sm" disabled={busy} onClick={() => doContinue(row)}>
                      Continue from here
                    </button>
                    <button className="btn sm ghost" disabled={busy} onClick={() => doRedo(row)}>
                      Redo this scene
                    </button>
                    <button className="btn sm ghost" onClick={() => setShowPrompt(showPrompt === row.clip.id ? null : row.clip.id)}>
                      {showPrompt === row.clip.id ? 'Hide prompt' : 'Prompt'}
                    </button>
                  </div>
                  <label className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 6 }}>
                    <input
                      type="checkbox"
                      checked={!!keepSeedFor[row.clip.id]}
                      onChange={(e) => setKeepSeedFor((prev) => ({ ...prev, [row.clip.id]: e.target.checked }))}
                    />
                    keep seed {row.clip.seed} on redo (unchecked draws a fresh one)
                  </label>
                  <div className="tok" style={{ display: 'block', marginTop: 4 }}>
                    Redo resamples scene {row.sceneIndex}
                    {toResample > 1 ? `-${scenes.length}` : ''} ({toResample} clip{toResample === 1 ? '' : 's'}) ·{' '}
                    {fromCache} from cache
                  </div>
                  {laterAfterContinue > 0 && (
                    <div className="tok" style={{ color: 'var(--ox)', marginTop: 6, display: 'block' }}>
                      Continuing from here discards {laterAfterContinue} later scene{laterAfterContinue === 1 ? '' : 's'} —
                      they no longer follow what would render next.
                      {pendingAutoDraft && pendingAutoDraft.sceneIndex > row.sceneIndex && (
                        <> It also discards the prompt already drafted for scene {pendingAutoDraft.sceneIndex} — it was written
                        against this scene's old ending.</>
                      )}
                    </div>
                  )}
                  {showPrompt === row.clip.id && (
                    <div className="scene-card-prompt tok">{row.clip.prompt}</div>
                  )}
                </div>
                )
              })()}
            </div>
          )
        })}
        <div className="scene-card next">
          <span className="tok" style={{ textAlign: 'center', lineHeight: 1.6 }}>
            scene {scenes.length + 1}
            <br />
            next
          </span>
        </div>
      </div>
      {filmIsRendering && (
        <div className="scenes-strip-note tok">
          Sampling scene {rendering?.extender?.sceneIndex} only — every earlier scene above is served from the box's own validated-clip cache, not resampled.
        </div>
      )}
    </div>
  )
}
