import { useApp } from '../app/state'
import { cumulativeSceneStarts } from '../lib/chainDisplay'

/**
 * "1. THE FILM" — the top region, the artifact itself. Player, a scene-ticked
 * scrubber (each tick is where a scene begins in the joined file), and the
 * running total. One file, rebuilt every time a scene lands or an earlier
 * one is replaced — see the module comment on `ChainFilmInfo` for why this
 * is sourced from the newest scene's `Clip.output` but presented as the
 * chain's own film, never one scene's.
 */
export function FilmRegion() {
  const { chainFilm, clipUrl, rendering } = useApp()

  if (!chainFilm) {
    return (
      <div className="film-region film-region-empty">
        <div className="film-player film-player-empty">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--ink3)" strokeWidth="1.1">
            <circle cx="12" cy="12" r="9.2" />
            <path d="M10.2 8.6 L15.6 12 L10.2 15.4 Z" strokeLinejoin="round" />
          </svg>
        </div>
        <div className="tok film-region-caption">Nothing rendered yet. Every scene you make lands here, and the film builds itself as you go.</div>
      </div>
    )
  }

  const filmUrl = chainFilm.filmClip ? clipUrl(chainFilm.filmClip) : null
  const starts = cumulativeSceneStarts(chainFilm.scenes, 24)
  const chainIsRendering = rendering?.chain?.runName === chainFilm.runName
  const last = chainFilm.scenes[chainFilm.scenes.length - 1]?.sceneIndex ?? 1

  return (
    <div className="film-region">
      <div className="film-player">
        {filmUrl && chainFilm.filmClip?.state === 'done' ? (
          <video src={filmUrl} controls style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <span className="tok">{chainIsRendering ? 'rebuilding to the newest scene…' : 'the film so far'}</span>
        )}
      </div>
      {chainFilm.totalSeconds > 0 && (
        <div className="film-scrubber">
          {chainFilm.scenes.map((p, i) => (
            <div
              key={p.clip.id}
              className="film-scrubber-tick"
              style={{ width: `${(p.delivered / (chainFilm.totalFrames || 1)) * 100}%` }}
              title={`Scene ${p.sceneIndex} · starts ${starts[i].toFixed(1)}s`}
            />
          ))}
        </div>
      )}
      <div className="film-region-foot">
        <div>
          <span className="serif film-region-title">Your film</span>
          <span className="tok" style={{ marginLeft: 10 }}>
            {chainFilm.scenes.length} scene{chainFilm.scenes.length === 1 ? '' : 's'} · {chainFilm.totalSeconds.toFixed(1)}s · {chainFilm.totalFrames}f
          </span>
        </div>
        <div style={{ display: 'flex', gap: 7 }}>
          {filmUrl && <a className="btn sm" href={filmUrl} download target="_blank" rel="noreferrer">Download</a>}
          {filmUrl && <a className="btn sm" href={filmUrl} target="_blank" rel="noreferrer">Open full size</a>}
        </div>
      </div>
      <div className="tok film-region-caption">{gpuBusyCaption(chainIsRendering, last)}</div>
    </div>
  )
}

function gpuBusyCaption(chainIsRendering: boolean, last: number): string {
  if (chainIsRendering) return 'One file, rebuilt every time a scene lands. Rendering the next scene now…'
  if (last <= 1) return 'One file, rebuilt every time a scene lands. It is scene 1 alone — not yet continued.'
  return `One file, rebuilt every time a scene lands. It is not scene ${last} — it is scenes 1–${last} joined.`
}
