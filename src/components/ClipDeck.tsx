import { useEffect, useState } from 'react'
import { useApp } from '../app/state'
import { CHAIN_CONTEXT_LENGTH } from '../lib/chain'
import {
  SCENE_LENGTH_CHIPS,
  cumulativeSceneStarts,
  deliveredVsAskedLine,
  isOnSceneLengthGrid,
  secondsLabel,
} from '../lib/chainDisplay'
import type { ChainSceneRow } from '../app/state'
import { padForOverlap } from '../lib/frames'
import { framesForSeconds } from '../lib/recipe'
import type { Clip } from '../lib/types'

/** A plain (non-chain) clip's thumbnail — the pre-chain filmstrip tile. Kept
 * for whatever this session rendered OUTSIDE a chain (the Agent's `render_current`
 * tool still uses the single-clip `render()` path — see the module comment on
 * `FilmStrip`), so an old-style clip still has somewhere to live. */
function Thumb({ clip, active, onClick }: { clip: Clip; active: boolean; onClick: () => void }) {
  const { clipUrl } = useApp()
  const url = clipUrl(clip)
  const border = active ? '2px solid var(--ox)' : '1px solid var(--rule2)'
  return (
    <button
      type="button"
      style={{ width: 152, flex: '0 0 auto', padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
      onClick={onClick}
      aria-label={`Select clip ${clip.index}, ${clip.state}${clip.film?.role ? `, ${clip.film.role}` : ''}`}
      aria-current={active ? 'true' : undefined}
    >
      <div style={{ height: 66, border, background: 'var(--sunk)', overflow: 'hidden', position: 'relative' }}>
        {url && clip.state === 'done' ? (
          <video src={`${url}#t=0.1`} preload="metadata" muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <span className="tok">{clip.state === 'failed' ? 'failed' : clip.state}</span>
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
        <span className="tok" style={{ color: active ? 'var(--ox)' : 'var(--ink2)' }}>{clip.index}</span>
        <span style={{ fontSize: 11, color: active ? 'var(--ox)' : 'var(--ink3)' }}>{clip.film?.role ?? 'standalone'}</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">{clip.frames ? secondsLabel(clip.frames, clip.fps || 24) : ''}</span>
      </div>
    </button>
  )
}

const WORK_DOT: Record<string, string> = {
  checkpointed: 'ok',
  restored: 'ok',
  sampling: 'warn',
  queued: 'idle',
  failed: 'err',
}

const WORK_TEXT_COLOR: Record<string, string> = {
  checkpointed: 'var(--ink2)',
  restored: 'var(--grn)',
  sampling: 'var(--ox)',
  queued: 'var(--ink3)',
  failed: 'var(--ox)',
}

/** One scene of the spine — a placeholder tile (this studio has no per-scene
 * segment file to preview; see the module comment on `FilmStrip`), its work
 * state, its seed, and its delivered-vs-asked length. Never plays a video —
 * that is what caused every scene's card to silently show a different
 * cumulative cut (the defect this whole redesign exists to fix). */
function SceneCard({ row, active, onClick }: { row: ChainSceneRow; active: boolean; onClick: () => void }) {
  const border = active ? '2px solid var(--ox)' : row.label === 'sampling' ? '1px solid var(--ox)' : '1px solid var(--rule2)'
  return (
    <button
      type="button"
      style={{ width: 148, flex: '0 0 auto', padding: 0, border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
    >
      <div style={{ border, background: 'var(--paper)' }}>
        <div style={{ height: 66, background: 'var(--sunk)', borderBottom: border, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="tok" style={{ fontSize: 18, color: 'var(--rule2)' }}>{row.sceneIndex}</span>
        </div>
        <div style={{ padding: '7px 8px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
            <span className={`dot ${WORK_DOT[row.label]}`} />
            <span className="lbl" style={{ color: active ? 'var(--ox)' : 'var(--ink2)' }}>Scene {row.sceneIndex}</span>
          </div>
          <div className="tok" style={{ lineHeight: 1.5 }}>
            {secondsLabel(row.delivered)} · {row.delivered}f
            <br />
            {deliveredVsAskedLine(row)}
            {row.clip.seed !== undefined && ` · seed ${row.clip.seed}`}
          </div>
          <div className="tok" style={{ marginTop: 5, color: WORK_TEXT_COLOR[row.label] }}>{row.label}</div>
        </div>
      </div>
    </button>
  )
}

/** The `22f` join between two adjacent scenes — the motion context carried
 * across it, and the only reason a continued scene delivers more than it
 * asked for. Dashed while the scene it leads to has not landed yet. */
function SceneLink({ pending }: { pending: boolean }) {
  return (
    <div style={{ width: 40, flex: '0 0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3 }}>
      <div style={{ width: '100%', height: 1, background: 'var(--rule2)', borderTop: pending ? '1px dashed var(--rule2)' : undefined }} />
      <span className="tok" style={{ fontSize: 9 }}>{CHAIN_CONTEXT_LENGTH}f</span>
    </div>
  )
}

/**
 * "The film so far" + the scene spine — the studio's ONE chain-level view.
 *
 * THE FIX this redesign exists for: `renderChain`/`pollChain` store the
 * assembled film as the NEWEST scene's own `Clip.output` (measured live
 * 2026-09-06 — a chain's file grows from `studio_chain_smoke.mp4` at 124
 * frames to `studio_chain_smoke_001.mp4` at 260 once scene 2 lands), so
 * every earlier scene's `Clip` record is left holding a STALE, smaller cut
 * of its own — playing any one of them as "clip N's own video" is
 * meaningless. This component never does that: the assembled film is shown
 * ONCE, named as the chain's, sourced from `chainFilm.filmClip` (the newest
 * scene's Clip, but presented as the chain's own film — see `ChainFilmInfo`'s
 * module comment in state.tsx); every scene below it is a metadata card with
 * no video at all.
 *
 * A clip with no `.chain` — the Agent's `render_current` tool still renders
 * through the plain single-clip `render()` path (kept; see the redesign's own
 * report for what depends on it) — has nothing to do with any of this and
 * keeps the old plain filmstrip treatment, appended below.
 */
export function FilmStrip() {
  const { clips, clip, selectClip, film, clipUrl, chainFilm, rendering, gpuBusy } = useApp()
  const standalone = clips.filter((c) => !c.chain)
  if (!clips.length) return null

  const filmUrl = chainFilm?.filmClip ? clipUrl(chainFilm.filmClip) : null
  const padded = chainFilm?.scenes ?? []
  const starts = cumulativeSceneStarts(padded, 24)
  const totalSeconds = chainFilm?.totalSeconds ?? 0
  const chainIsRendering = !!chainFilm && rendering?.chain?.runName === chainFilm.runName

  return (
    <div style={{ flex: '0 0 auto', borderTop: '1px solid var(--rule2)', background: 'var(--panel)', padding: '13px 30px 16px' }}>
      {chainFilm && (
        <>
          {chainIsRendering && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 9, padding: '7px 10px', border: '1px solid var(--ox)', background: 'var(--ox-soft)' }}>
              <span className="spin" />
              <span className="lbl" style={{ color: 'var(--ox)' }}>
                Sampling scene {rendering?.chain?.sceneIndex} only
              </span>
              <span className="tok" style={{ color: 'var(--ox)' }}>
                {chainFilm.scenes.filter((s) => s.label === 'restored').length} scene{chainFilm.scenes.filter((s) => s.label === 'restored').length === 1 ? '' : 's'} restored from checkpoint, not resampled
              </span>
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <span className="lbl">The film so far</span>
            <span className="tok" style={{ color: 'var(--ink2)' }}>
              {chainFilm.scenes.length} scene{chainFilm.scenes.length === 1 ? '' : 's'} joined · {chainFilm.totalFrames}f · {totalSeconds.toFixed(1)}s
            </span>
            <div style={{ flexGrow: 1 }} />
            {film.spine && (
              <span className="serif" style={{ fontStyle: 'italic', fontSize: 13, color: 'var(--ink2)' }}>{film.spine}</span>
            )}
          </div>

          {filmUrl && chainFilm.filmClip?.state === 'done' ? (
            <video src={filmUrl} controls style={{ width: '100%', maxHeight: 260, border: '1px solid var(--rule2)', display: 'block', background: 'var(--sunk)' }} />
          ) : (
            <div style={{ width: '100%', height: 120, border: '1px solid var(--rule2)', background: 'var(--sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <span className="tok">{chainIsRendering ? 'rebuilding to the newest scene…' : 'the film so far'}</span>
            </div>
          )}

          {padded.length > 0 && totalSeconds > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', height: 5, border: '1px solid var(--rule2)', borderBottom: 'none' }}>
                {padded.map((p, i) => (
                  <div
                    key={p.clip.id}
                    style={{
                      width: `${(p.delivered / (chainFilm.totalFrames || 1)) * 100}%`,
                      background: 'var(--ox-soft)',
                      borderRight: i < padded.length - 1 ? '1px solid var(--rule2)' : undefined,
                    }}
                  />
                ))}
              </div>
              <div style={{ display: 'flex', borderTop: '1px solid var(--rule2)' }}>
                {padded.map((p, i) => (
                  <div key={p.clip.id} style={{ width: `${(p.delivered / (chainFilm.totalFrames || 1)) * 100}%`, paddingTop: 4 }} className="tok">
                    {p.sceneIndex} · {starts[i].toFixed(1)}s
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="tok" style={{ marginTop: 9, lineHeight: 1.6, color: 'var(--ink2)' }}>
            {(() => {
              const last = chainFilm.scenes[chainFilm.scenes.length - 1]?.sceneIndex ?? 1
              if (gpuBusy === 'render' && !chainIsRendering) return 'One file, rebuilt every time a scene lands. Another chain is rendering right now.'
              if (last <= 1) return 'One file, rebuilt every time a scene lands. It is scene 1 alone — not yet continued.'
              return `One file, rebuilt every time a scene lands. It is not scene ${last} — it is scenes 1–${last} joined.`
            })()}
          </div>

          <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--rule)' }}>
            <div className="lbl" style={{ marginBottom: 9 }}>Scenes in this chain</div>
            <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', paddingBottom: 2 }}>
              {chainFilm.scenes.map((row, i) => (
                <div key={row.clip.id} style={{ display: 'flex', alignItems: 'stretch' }}>
                  <SceneCard row={row} active={row.clip.id === clip?.id} onClick={() => selectClip(row.clip.id)} />
                  {i < chainFilm.scenes.length - 1 && <SceneLink pending={chainFilm.scenes[i + 1].label === 'queued'} />}
                </div>
              ))}
            </div>
            <div className="tok" style={{ marginTop: 10, lineHeight: 1.6 }}>
              The {CHAIN_CONTEXT_LENGTH}f between two scenes is the motion context carried across the join — the last {CHAIN_CONTEXT_LENGTH} frames
              of the earlier scene condition the start of the next, which is also why a continued scene DELIVERS more than it asked for.
            </div>
          </div>
        </>
      )}

      {standalone.length > 0 && (
        <div style={{ marginTop: chainFilm ? 16 : 0, paddingTop: chainFilm ? 12 : 0, borderTop: chainFilm ? '1px solid var(--rule)' : undefined }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
            <span className="lbl">Standalone clips</span>
            <span className="tok">not part of a chain · {standalone.length} clip{standalone.length === 1 ? '' : 's'}</span>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 2 }}>
            {standalone.map((c) => (
              <Thumb key={c.id} clip={c} active={c.id === clip?.id} onClick={() => selectClip(c.id)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** H3's Contex-Loop scene-length grid, as quick-pick chips — see the module
 * comment on `SCENE_LENGTH_CHIPS`. Used on the pre-render (Start) state and
 * wherever a length is chosen before a chain exists to append to. */
function SceneLengthChips() {
  const { settings, patchSettings } = useApp()
  const current = framesForSeconds(settings.seconds, 24)
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
        <span className="lbl">Scene length</span>
        <span className="tok">H3 only renders these lengths · {CHAIN_CONTEXT_LENGTH - 5}-frame steps</span>
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
        {SCENE_LENGTH_CHIPS.map((f) => (
          <button
            key={f}
            className={`chip${f === current ? ' on' : ''}`}
            style={{ fontSize: 10.5, padding: '3px 8px' }}
            onClick={() => patchSettings({ seconds: f / 24 })}
          >
            {secondsLabel(f)}
            <span className="tok" style={{ fontSize: 9, color: f === current ? 'var(--ox)' : undefined }}>{f}f</span>
          </button>
        ))}
      </div>
      <div className="tok" style={{ marginTop: 7, lineHeight: 1.6, display: 'block' }}>
        {isOnSceneLengthGrid(current) ? '124f is the shortest H3 will make.' : `${current}f is off H3's grid and will be snapped up silently.`}{' '}
        Every scene in a chain sets its own length — they do not have to match.
      </div>
    </div>
  )
}

/** The pre-render projection: what THIS render costs, and what it would cost
 * if a second scene continued it at the same authored length — the overlap
 * tax, disclosed before the surprise of a render coming back longer than asked. */
function LengthProjection() {
  const { settings } = useApp()
  const authored = framesForSeconds(settings.seconds, 24)
  const [scene1, continued] = padForOverlap([{ frames: authored }, { frames: authored }], CHAIN_CONTEXT_LENGTH)
  return (
    <div style={{ display: 'flex', gap: 20, marginTop: 13 }}>
      <div>
        <div className="lbl" style={{ marginBottom: 4 }}>This render</div>
        <div className="tok" style={{ lineHeight: 1.6 }}>{scene1.rendered}f · {secondsLabel(scene1.rendered)}</div>
      </div>
      <div>
        <div className="lbl" style={{ marginBottom: 4 }}>Same length, continued</div>
        <div className="tok" style={{ lineHeight: 1.6 }}>
          renders {continued.rendered}f, delivers {continued.delivered}f · {secondsLabel(continued.delivered)}
          <br />
          the join costs {CHAIN_CONTEXT_LENGTH}f, so it lands longer
        </div>
      </div>
    </div>
  )
}

/** The current clip, plus the action that authors its next prompt. */
export function ClipPlayer({ onOpenPlates }: { onOpenPlates?: () => void } = {}) {
  const {
    clip, clipUrl, continueFrom, rendering, film, continuation, chainRecipe, renderChain, gpuBusy,
    chainFilm, chainBlockers, endpoint, comfyProbes, plates,
  } = useApp()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [chainBusy, setChainBusy] = useState(false)
  const [, setTick] = useState(0)

  // The elapsed-time readout on a render in flight needs a clock of its own —
  // nothing else in this component re-renders on a plain interval.
  useEffect(() => {
    if (!rendering) return
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [rendering])

  const url = clip ? clipUrl(clip) : null
  const continuing = !!clip && continuation?.clipId === clip.id && continuation.state === 'running'
  const nextPromptReady = !!clip && continuation?.clipId === clip.id && continuation.state === 'ready'
  const gpuHeldElsewhere = gpuBusy !== 'idle' && !(gpuBusy === 'render' && !!rendering)
  const chainDisabled = chainBusy || !!rendering || gpuHeldElsewhere || chainBlockers.length > 0
  const nextSceneIndex = (clip?.chain?.sceneIndex ?? 0) + 1
  const isNewestInChain = !!clip?.chain && chainFilm?.filmClip?.id === clip.id
  const elapsedSeconds = rendering ? Math.round((Date.now() - rendering.at) / 1000) : 0

  const goChain = async () => {
    setChainBusy(true)
    try {
      await renderChain()
    } finally {
      setChainBusy(false)
    }
  }

  const heldWhileRendering = gpuBusy === 'render' && (
    <div style={{ border: '1px solid var(--rule2)', background: 'var(--panel)', marginBottom: 13 }}>
      <div style={{ padding: '9px 11px', borderBottom: '1px solid var(--rule)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="dot idle" style={{ marginTop: 5 }} />
          <div>
            <div style={{ color: 'var(--ink3)' }}>Authoring the next prompt</div>
            <div className="tok">the model and the render share one GPU</div>
          </div>
        </div>
      </div>
      <div style={{ padding: '9px 11px' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <span className="dot idle" style={{ marginTop: 5 }} />
          <div>
            <div style={{ color: 'var(--ink3)' }}>Starting another render</div>
            <div className="tok">one scene at a time</div>
          </div>
        </div>
      </div>
      <div className="tok" style={{ padding: '0 11px 10px', lineHeight: 1.6 }}>
        Asking the model for anything right now would take the GPU away mid-scene — a chat completion fired mid-render
        forces a backend switch, and ComfyUI is evicted via a <code>free</code> it cannot honour mid-sample and gets
        hard-killed. That destroyed a real render on 2026-09-06. The studio holds authoring rather than let that happen.
        {rendering && <> Scene {rendering.chain?.sceneIndex ?? rendering.index} has been sampling for ~{elapsedSeconds}s.</>}
      </div>
    </div>
  )

  if (!clip) {
    const chainWorkflowReady = !!chainRecipe
    const endpointOk = endpoint ? comfyProbes[endpoint.id]?.state === 'ok' : false
    return (
      <div style={{ padding: '13px 22px' }}>
        {heldWhileRendering}
        <div className="lbl">No chain yet</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink3)', lineHeight: 1.6, marginTop: 8, maxWidth: 380 }}>
          There is no choice to make here any more. Every render is scene 1 of a chain, so this clip is continuable
          whether or not it ever becomes a film — keep it as a one-off, or write what happens next and add scene 2.
        </div>

        <div style={{ marginTop: 15 }}>
          <SceneLengthChips />
        </div>
        <LengthProjection />

        <div style={{ marginTop: 16, border: '1px solid var(--rule2)', background: 'var(--panel)' }}>
          <div style={{ display: 'flex', gap: 9, padding: '9px 10px', borderBottom: '1px solid var(--rule)' }}>
            <span className={`dot ${chainWorkflowReady ? 'ok' : 'idle'}`} style={{ marginTop: 5 }} />
            <div>
              <div>A Contex-Loop workflow</div>
              <div className="tok">{chainWorkflowReady ? `bound · ${chainRecipe!.name}` : 'none loaded yet'}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 9, padding: '9px 10px' }}>
            <span className={`dot ${endpointOk ? 'ok' : 'idle'}`} style={{ marginTop: 5 }} />
            <div>
              <div>A reachable ComfyUI</div>
              <div className="tok">{endpoint ? endpoint.label : 'none configured'}</div>
            </div>
          </div>
        </div>

        {plates.length === 0 && (
          <div style={{ marginTop: 12, border: '1px solid var(--rule2)', background: 'var(--paper)', padding: '10px 11px' }}>
            <div style={{ display: 'flex', gap: 9 }}>
              <span className="dot idle" style={{ marginTop: 5 }} />
              <div>
                <div>Reference plates · none bound</div>
                <div style={{ color: 'var(--ink2)', lineHeight: 1.6, marginTop: 4, fontSize: 11.5 }}>
                  A chain renders fine without one. But only {CHAIN_CONTEXT_LENGTH} frames carry across each join, so
                  with nothing to anchor to, H3 re-invents the subject every scene and identity drifts as the film grows.
                </div>
                {onOpenPlates && (
                  <div style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={onOpenPlates}>Add a plate</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 12, border: '1px solid var(--amb)', background: 'var(--amb-soft)', padding: '10px 11px' }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span className="dot warn" style={{ marginTop: 5 }} />
            <div>
              <div style={{ fontWeight: 500 }}>Scenes are added, not edited</div>
              <div style={{ color: 'var(--ink2)', lineHeight: 1.6, marginTop: 3, fontSize: 11.5 }}>
                A chain grows at the end. Re-rendering an earlier scene once a later one exists also re-renders every
                scene after it — the moment to judge a scene is before continuing past it, not after.
              </div>
            </div>
          </div>
        </div>

        {chainRecipe && (
          <div style={{ marginTop: 15 }}>
            <button className="btn pri" style={{ width: '100%', justifyContent: 'center' }} disabled={chainDisabled} onClick={() => void goChain()}>
              {rendering ? 'Rendering…' : 'Render scene 1'}
            </button>
            {chainBlockers.length > 0 && (
              <div style={{ marginTop: 8 }}>
                {chainBlockers.map((b) => (
                  <div key={b} className="tok" style={{ display: 'block', color: 'var(--ox)', lineHeight: 1.55, marginTop: 4 }}>{b}</div>
                ))}
              </div>
            )}
            <div className="tok" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
              Kept as a checkpoint on the box, so continuing later costs one scene — not a re-render of this one.
            </div>
          </div>
        )}
        <div className="tok" style={{ marginTop: 14, lineHeight: 1.6, display: 'block' }}>
          Refreshing this page clears the chain from view. The rendered scenes stay on the box, but the studio cannot
          re-attach to them yet.
        </div>
      </div>
    )
  }

  const go = async () => {
    setBusy(true)
    try {
      await continueFrom(clip.id, note)
      setNote('')
    } finally {
      setBusy(false)
    }
  }

  const acc = clip.chain ? { authored: clip.frames ?? 0, rendered: clip.frames ?? 0, delivered: clip.frames ?? 0 } : null

  return (
    <>
      <div style={{ flex: '0 0 auto', padding: '13px 22px 0', display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">{clip.chain ? `Scene ${clip.chain.sceneIndex}` : `Clip ${clip.index}`}</span>
        <span className="tok" style={{ color: clip.state === 'done' ? 'var(--grn)' : clip.state === 'failed' ? 'var(--ox)' : 'var(--amb)' }}>
          {clip.state}
        </span>
        <div style={{ flexGrow: 1 }} />
        {clip.ms && <span className="tok">{Math.round(clip.ms / 1000)}s to render</span>}
      </div>

      <div style={{ flex: '0 0 auto', padding: '11px 22px 0' }}>
        {clip.chain && !isNewestInChain ? (
          <div style={{ width: '100%', aspectRatio: '16 / 9', border: '1px solid var(--rule2)', background: 'var(--sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, textAlign: 'center' }}>
            <span className="tok" style={{ lineHeight: 1.6 }}>
              This scene's own footage isn't kept separately — its checkpoint lives on the box.
              <br />Watch “the film so far” below to see this moment in context.
            </span>
          </div>
        ) : url && clip.state === 'done' ? (
          <video src={url} controls style={{ width: '100%', border: '1px solid var(--rule2)', display: 'block', background: 'var(--sunk)' }} />
        ) : (
          <div style={{ width: '100%', aspectRatio: '16 / 9', border: '1px solid var(--rule2)', background: 'var(--sunk)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="tok">{clip.state === 'failed' ? 'this clip failed' : 'rendering…'}</span>
          </div>
        )}
        {clip.chain && isNewestInChain && clip.state === 'done' && (
          <div className="tok" style={{ display: 'block', marginTop: 6 }}>This is the film so far, through scene {clip.chain.sceneIndex} — not just this scene alone.</div>
        )}
        <div className="tok" style={{ display: 'block', marginTop: 7 }}>
          {acc ? `${deliveredVsAskedLine(acc)} (delivered ${acc.delivered}f)` : `${clip.frames} frames`} · {clip.fps ?? 24}fps · seed {clip.seed}
        </div>
        {clip.error && (
          <div className="card err" style={{ marginTop: 9, fontSize: 11.5, lineHeight: 1.6 }}>{clip.error}</div>
        )}
      </div>

      {gpuBusy === 'render' && <div style={{ padding: '13px 22px 0' }}>{heldWhileRendering}</div>}

      {clip.state === 'done' && (
        <div style={{ flex: '0 0 auto', padding: '13px 22px 0' }}>
          <div style={{ borderTop: '1px solid var(--rule)', paddingTop: 13 }}>
            <div className="lbl" style={{ marginBottom: 8 }}>Continue from this scene</div>
            {continuing && <div className="tok studio-continuation-progress" role="status" aria-live="polite">
              {continuation.phase === 'frame' ? 'Taking the ending frame…' : continuation.phase === 'handoff' ? 'Writing the hand-off…' : continuation.phase === 'direct' ? 'Directing the next clip…' : 'Drafting the next prompt…'}
            </div>}
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Optional direction for the next scene…"
              style={{ width: '100%', minHeight: 68, resize: 'vertical', fontFamily: 'var(--serif)', fontSize: 15, lineHeight: 1.5 }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn pri" style={{ flexGrow: 1, justifyContent: 'center' }} disabled={busy || !!rendering || continuing || nextPromptReady} onClick={() => void go()}>
                {busy || continuing ? 'Continuing…' : nextPromptReady ? 'Next prompt ready' : 'Author scene ' + nextSceneIndex}
              </button>
            </div>
            <div className="tok" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
              Takes the last frame as <span style={{ color: 'var(--kw-picture)' }}>&lt;Picture 1&gt;</span>, writes the
              hand-off, advances the role from <b>{film.role}</b>, and authors the next prompt. It does not render until
              you choose to render.
            </div>
            {chainRecipe && clip.chain && (
              <div style={{ marginTop: 14, paddingTop: 13, borderTop: '1px solid var(--rule)' }}>
                <button
                  className="btn pri"
                  style={{ width: '100%', justifyContent: 'center' }}
                  disabled={!nextPromptReady || chainDisabled}
                  onClick={() => void goChain()}
                >
                  {chainBusy || (rendering && gpuBusy === 'render')
                    ? `Rendering scene ${nextSceneIndex}…`
                    : `Render scene ${nextSceneIndex}`}
                </button>
                <div className="tok" style={{ display: 'block', marginTop: 8, lineHeight: 1.5 }}>
                  Resumes scene {clip.chain.sceneIndex} (run <code>{clip.chain.runName}</code>) from its checkpoint and
                  samples only scene {nextSceneIndex} — one scene's worth of render, not the whole chain's. Every
                  scene already sampled is locked: redoing one also redoes every scene after it.
                  {!nextPromptReady && ' Continue from this scene first to author the next prompt.'}
                </div>
                {chainBlockers.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {chainBlockers.map((b) => (
                      <div key={b} className="tok" style={{ display: 'block', color: 'var(--ox)', lineHeight: 1.55, marginTop: 4 }}>{b}</div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}
