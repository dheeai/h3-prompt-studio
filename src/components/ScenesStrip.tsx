import { useState } from 'react'
import { useApp } from '../app/state'
import type { ChainSceneRow } from '../app/state'
import { deliveredVsAskedLine, secondsLabel } from '../lib/chainDisplay'

const WORK_DOT: Record<string, string> = {
  checkpointed: 'ok',
  restored: 'ok',
  sampling: 'warn',
  queued: 'idle',
  failed: 'err',
}

/**
 * "2. THE SCENES" — a horizontal strip beneath the film. Selecting a scene
 * puts its actions ON it: Replace, Continue from here, Prompt. There is no
 * separate panel for any of this — see the module comment on `canvas.json`'s
 * "four-places" annotation this component implements.
 *
 * Every scene is replaceable, not just the newest (founder addition,
 * 2026-09-07: "Continue from here should be allowed on any clip, not just
 * the latest scene"). Both actions are append-only: replacing scene N or
 * continuing from scene N discards every scene after the one they write —
 * Contex-Loop cannot verify a later scene's resume hash against a
 * predecessor that no longer matches what rendered it. The count is shown
 * and confirmed before anything is sent, free when there is nothing to lose.
 */
export function ScenesStrip() {
  const { chainFilm, rendering, gpuBusy, scenesFrom, replaceScene, prepareContinuation } = useApp()
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<{ clipId: string; action: 'replace' } | null>(null)
  const [keepSeed, setKeepSeed] = useState(false)
  const [showPrompt, setShowPrompt] = useState<string | null>(null)
  const [working, setWorking] = useState<string | null>(null)

  if (!chainFilm) return null
  const scenes = chainFilm.scenes
  const chainIsRendering = rendering?.chain?.runName === chainFilm.runName
  const busy = !!rendering || gpuBusy !== 'idle'

  const doReplace = async (row: ChainSceneRow) => {
    setWorking(row.clip.id)
    try {
      await replaceScene(row.clip.id, { keepSeed })
    } finally {
      setWorking(null)
      setConfirming(null)
      setExpanded(null)
    }
  }

  const doContinue = (row: ChainSceneRow) => {
    prepareContinuation(row.clip.id)
    setExpanded(null)
  }

  return (
    <div className="scenes-strip">
      <div className="scenes-strip-head">
        <span className="lbl">Scenes</span>
        <span className="tok">click one to replace it or continue from it</span>
        <div className="studio-grow" />
        <span className="tok">{scenes.length} scene{scenes.length === 1 ? '' : 's'} · {chainFilm.totalFrames}f · {chainFilm.totalSeconds.toFixed(1)}s</span>
      </div>
      <div className="scenes-strip-row">
        {scenes.map((row) => {
          const isOpen = expanded === row.clip.id
          const laterAfterReplace = scenesFrom(row.clip.id, row.sceneIndex + 1)
          const isConfirmingThis = confirming?.clipId === row.clip.id
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
              {isOpen && (
                <div className="scene-card-actions">
                  <div className="tok" style={{ marginBottom: 7 }}>
                    {deliveredVsAskedLine(row)} · seed {row.clip.seed} · {row.label}
                  </div>
                  {!isConfirmingThis ? (
                    <div className="scene-card-buttons">
                      <button
                        className="btn sm"
                        disabled={busy || working === row.clip.id}
                        onClick={() => (laterAfterReplace > 0 ? setConfirming({ clipId: row.clip.id, action: 'replace' }) : void doReplace(row))}
                      >
                        Replace
                      </button>
                      <button className="btn sm" disabled={busy} onClick={() => doContinue(row)}>
                        Continue from here
                      </button>
                      <button className="btn sm ghost" onClick={() => setShowPrompt(showPrompt === row.clip.id ? null : row.clip.id)}>
                        {showPrompt === row.clip.id ? 'Hide prompt' : 'Prompt'}
                      </button>
                    </div>
                  ) : (
                    <div className="scene-card-confirm">
                      <div className="tok" style={{ color: 'var(--ox)', lineHeight: 1.5 }}>
                        Replacing scene {row.sceneIndex} also discards {laterAfterReplace} later scene{laterAfterReplace === 1 ? '' : 's'} —
                        they no longer resume against a checkpoint that will still exist.
                        {row.sceneIndex === 1 && row.clip.chain?.externalVideo && (
                          <> Re-attaches the original footage <code>{row.clip.chain.externalVideo.filename}</code>.</>
                        )}
                      </div>
                      <label className="tok" style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                        <input type="checkbox" checked={keepSeed} onChange={(e) => setKeepSeed(e.target.checked)} />
                        keep the same seed (reproduces the same clip)
                      </label>
                      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                        <button className="btn sm pri" disabled={working === row.clip.id} onClick={() => void doReplace(row)}>
                          {working === row.clip.id ? 'Replacing…' : `Discard ${laterAfterReplace} and replace`}
                        </button>
                        <button className="btn sm ghost" onClick={() => setConfirming(null)}>Cancel</button>
                      </div>
                    </div>
                  )}
                  {showPrompt === row.clip.id && (
                    <div className="scene-card-prompt tok">{row.clip.prompt}</div>
                  )}
                </div>
              )}
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
      {chainIsRendering && (
        <div className="scenes-strip-note tok">
          Sampling scene {rendering?.chain?.sceneIndex} only — every earlier scene above is restored from checkpoint, not resampled.
        </div>
      )}
    </div>
  )
}
