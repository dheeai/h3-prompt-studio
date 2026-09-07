import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../app/state'
import { inputUrl, listBoxInputs, uploadVideo, videoMetadata, THUMB_PREVIEW } from '../lib/comfy'
import type { VideoMetadata } from '../lib/comfy'
import { videoDoorEstimate } from '../lib/chainDisplay'
import { CHAIN_CONTEXT_LENGTH } from '../lib/chain'
import { framesForSeconds } from '../lib/recipe'

/**
 * "Start a chain from an existing video" — pick a video already sitting in
 * the box's input folder, or upload one, then it becomes scene 1's visual
 * and audio predecessor (`buildChainGraph`'s `opts.externalVideo`: `LoadVideo
 * -> MiniMaxH3ChainExternalVideo -> LoopStart.external_context`).
 *
 * This is the video DOOR's own screen (`FromVideo.dc.html`) — promoted from
 * an 11px optional row in the render panel to one of the three equal
 * starting points. Only means anything for a FRESH chain at scene 1 — a
 * continuation already has its own predecessor (the parent clip), so this
 * panel says so plainly rather than silently accepting a choice `renderChain`
 * would then ignore.
 */
export function ExternalVideoPanel({ onClose, onOpenPlates }: { onClose: () => void; onOpenPlates?: () => void }) {
  const { endpoint, isFreshChainStart, externalVideo, setExternalVideo, settings, plates } = useApp()
  const [videos, setVideos] = useState<string[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [uploading, setUploading] = useState(false)
  const [uploadedSrc, setUploadedSrc] = useState<string | null>(null)
  const [meta, setMeta] = useState<VideoMetadata | null>(null)
  const [metaErr, setMetaErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!endpoint) return
    let live = true
    listBoxInputs(endpoint)
      .then((d) => live && setVideos(d.videos))
      .catch((e) => live && setErr(String((e as Error).message || e)))
    return () => {
      live = false
    }
  }, [endpoint])

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return needle ? (videos ?? []).filter((f) => f.toLowerCase().includes(needle)) : videos ?? []
  }, [videos, q])

  const chosenHere = !!(externalVideo && endpoint && externalVideo.endpointId === endpoint.id)

  // Read the chosen file's own duration/geometry — a locally uploaded file
  // straight off disk (an object URL), or one already on the box (streamed
  // through the same `/view` endpoint the thumbnail grid uses).
  const videoSrc = chosenHere
    ? uploadedSrc ?? (endpoint ? inputUrl(endpoint, externalVideo!.filename) : null)
    : null
  useEffect(() => {
    setMeta(null)
    setMetaErr(null)
    if (!videoSrc) return
    let live = true
    videoMetadata(videoSrc)
      .then((m) => live && setMeta(m))
      .catch((e) => live && setMetaErr(String((e as Error).message || e)))
    return () => {
      live = false
    }
  }, [videoSrc])

  const pick = (filename: string) => {
    if (!endpoint) return
    setUploadedSrc(null)
    setExternalVideo({ endpointId: endpoint.id, filename, prependOriginal: externalVideo?.prependOriginal ?? true })
  }

  const upload = async (files: FileList | null) => {
    const file = files?.[0]
    if (!file || !endpoint) return
    setErr(null)
    setUploading(true)
    try {
      const up = await uploadVideo(endpoint, file)
      setUploadedSrc(URL.createObjectURL(file))
      setExternalVideo({ endpointId: endpoint.id, filename: up.filename, prependOriginal: externalVideo?.prependOriginal ?? true })
      // The box now has it too — refresh the listing so it shows selected among the tiles.
      setVideos((prev) => (prev && !prev.includes(up.filename) ? [...prev, up.filename] : prev))
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setUploading(false)
    }
  }

  const imagePlates = plates.filter((p) => p.kind === 'image')
  const askedFrames = framesForSeconds(settings.seconds, 24)
  const estimate = meta ? videoDoorEstimate(meta.durationSeconds, askedFrames, CHAIN_CONTEXT_LENGTH) : null

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900, height: '86vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Continue from a video</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              H3 reads only the tail of what you pick — a source can be 20 seconds or much longer at no extra render
              cost. This only applies to a fresh chain's scene 1.
            </div>
          </div>
        </div>

        <div className="modal-body">
          {!isFreshChainStart && (
            <div className="alert warn" style={{ marginBottom: 14 }}>
              This session is already continuing from a rendered clip, so a picked video would be ignored — Contex-Loop
              only reads an imported video's context on scene 1. Start a New draft to begin a chain from a video instead.
            </div>
          )}

          <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginBottom: 14 }}>
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by name…" style={{ flexGrow: 1 }} />
            <button className="btn sm" disabled={!endpoint || uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? 'Uploading…' : 'Choose a file'}
            </button>
            <input ref={fileRef} type="file" accept="video/*" style={{ display: 'none' }} onChange={(e) => void upload(e.target.files)} />
          </div>

          {!endpoint && <div className="tok">connect a ComfyUI to browse or upload its files</div>}
          {err && <div className="card err">{err}</div>}
          {endpoint && !videos && !err && <div className="tok">reading the input folder…</div>}
          {endpoint && videos && !filtered.length && <div className="tok">Nothing here{q ? ' matches that' : ''}.</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 12, marginTop: 4 }}>
            {endpoint &&
              filtered.map((f) => {
                const selected = chosenHere && externalVideo!.filename === f
                return (
                  <div key={f} style={{ cursor: 'pointer' }} onClick={() => pick(f)}>
                    <video
                      src={inputUrl(endpoint, f)}
                      muted
                      preload="metadata"
                      style={{
                        width: '100%', height: 92, objectFit: 'cover', display: 'block', background: 'var(--sunk)',
                        border: `${selected ? 2 : 1}px solid ${selected ? 'var(--grn)' : 'var(--rule2)'}`,
                      }}
                    />
                    <div className="tok" style={{ marginTop: 5, wordBreak: 'break-all', lineHeight: 1.35 }}>{f}</div>
                  </div>
                )
              })}
          </div>

          {chosenHere && (
            <div className="card ok" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span className="dot ok" />
                <span style={{ fontSize: 12.5, fontWeight: 500 }}>{externalVideo!.filename}</span>
                <div style={{ flexGrow: 1 }} />
                <button className="btn sm ghost" onClick={() => { setExternalVideo(null); setUploadedSrc(null) }}>clear</button>
              </div>

              <div style={{ display: 'flex', gap: 22, marginTop: 11 }}>
                <div>
                  <div className="lbl" style={{ marginBottom: 4 }}>Your file</div>
                  <div className="tok" style={{ lineHeight: 1.6 }}>
                    {metaErr
                      ? metaErr
                      : meta
                        ? <>{meta.width}×{meta.height} · {meta.durationSeconds.toFixed(1)}s</>
                        : 'reading…'}
                  </div>
                </div>
                <div>
                  <div className="lbl" style={{ marginBottom: 4 }}>Audio</div>
                  <div className="tok" style={{ lineHeight: 1.6 }}>kept · carried through</div>
                </div>
              </div>

              {/* The prepend choice, as two explicit options rather than a
                  checkbox — what each one produces is the whole decision, so
                  it is stated in full rather than abbreviated to on/off. */}
              <div style={{ marginTop: 14 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>What the film should contain</div>
                <div
                  className={`card${externalVideo!.prependOriginal ? ' ok' : ''}`}
                  style={{ cursor: 'pointer', borderColor: externalVideo!.prependOriginal ? 'var(--ox)' : undefined, background: externalVideo!.prependOriginal ? 'var(--ox-soft)' : undefined }}
                  onClick={() => setExternalVideo({ ...externalVideo!, prependOriginal: true })}
                >
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span className="dot ok" style={{ marginTop: 5 }} />
                    <div>
                      <div style={{ fontWeight: 500, color: externalVideo!.prependOriginal ? 'var(--ox)' : undefined }}>Your video, then the new scenes</div>
                      <div className="tok" style={{ lineHeight: 1.6, marginTop: 3 }}>
                        All of your footage, followed by everything you add. One file, rebuilt each time a scene lands.
                      </div>
                    </div>
                  </div>
                </div>
                <div
                  className="card"
                  style={{ marginTop: 8, cursor: 'pointer' }}
                  onClick={() => setExternalVideo({ ...externalVideo!, prependOriginal: false })}
                >
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span className={`dot ${!externalVideo!.prependOriginal ? 'ok' : 'idle'}`} style={{ marginTop: 5 }} />
                    <div>
                      <div>Only the new scenes</div>
                      <div className="tok" style={{ lineHeight: 1.6, marginTop: 3 }}>
                        Your footage is used as the starting point but left out of the result — useful when you already
                        have the original elsewhere.
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {estimate && (
                <div style={{ marginTop: 14 }}>
                  <div className="lbl" style={{ marginBottom: 7 }}>What you will get</div>
                  <div style={{ border: '1px solid var(--rule2)', background: 'var(--panel)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 11px', borderBottom: '1px solid var(--rule)' }}>
                      <span style={{ color: 'var(--ink2)' }}>Your footage</span><span className="tok">{estimate.sourceSeconds.toFixed(1)}s</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 11px', borderBottom: '1px solid var(--rule)' }}>
                      <span style={{ color: 'var(--ink2)' }}>Scene 1, asked for</span><span className="tok">{(estimate.askedFrames / 24).toFixed(1)}s</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 11px', borderBottom: '1px solid var(--rule)' }}>
                      <span style={{ color: 'var(--ink2)' }}>Scene 1, lands as</span><span className="tok">{estimate.deliveredSeconds.toFixed(1)}s</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 11px', background: 'var(--paper)' }}>
                      <span style={{ fontWeight: 500 }}>Film</span><span className="tok" style={{ color: 'var(--ox)' }}>{estimate.filmSeconds.toFixed(1)}s</span>
                    </div>
                  </div>
                  <div className="tok" style={{ marginTop: 8, lineHeight: 1.6 }}>
                    The join overlaps the last {CHAIN_CONTEXT_LENGTH} frames of your footage, so a scene lands slightly
                    shorter than you ask for.
                  </div>
                </div>
              )}

              {/* Founder addition, 2026-09-07: only 22 frames carry across the
                  join, so a face turned away (or small, or backlit) at the
                  tail of the footage gives H3 no identity anchor and the
                  subject is re-invented in scene 1. Offer a reference plate
                  here — the moment it actually matters — rather than only
                  behind the separate "Bind plates" affordance. Verified live
                  2026-09-07: `externalVideo` and a plate compose with no
                  guard — `buildChainGraph` wires both `MiniMaxH3ChainExternalVideo`
                  and the Tagged reference path side by side. */}
              <div style={{ marginTop: 14, borderTop: '1px solid var(--rule)', paddingTop: 13 }}>
                <div className="lbl" style={{ marginBottom: 7 }}>Reference plates — optional, but worth it for a face</div>
                <div className="tok" style={{ lineHeight: 1.6, marginBottom: 9 }}>
                  Only {CHAIN_CONTEXT_LENGTH} frames of your footage carry across the join. If the person is turned
                  away, small, or backlit at the end of it, H3 has nothing to anchor identity to and re-invents them —
                  a reference plate fixes that independently of what the last frame happens to show. A plateless
                  continuation still works.
                </div>
                {imagePlates.length > 0 ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {imagePlates.map((p, i) => (
                      <span key={p.id} className="chip on" style={{ fontSize: 10.5 }}>
                        &lt;Picture {i + 1}&gt; {p.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="tok">no reference plates bound yet</div>
                )}
                {onOpenPlates && (
                  <div style={{ marginTop: 9 }}>
                    <button className="btn sm" onClick={onOpenPlates}>{imagePlates.length ? 'Manage reference plates' : 'Add a reference'}</button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-foot">
          <span className="tok">Geometry/fps mismatch against this chain's own recipe is not checked here — Contex-Loop normalizes to the plan's canvas at render time.</span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
