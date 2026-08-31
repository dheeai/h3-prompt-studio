import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../app/state'
import { inputUrl, listBoxInputs } from '../lib/comfy'
import { REF_CAPS } from '../lib/recipe'
import type { ComfyEndpoint, Plate } from '../lib/types'

const MAX_REFS = REF_CAPS.image

/** Downscale on the way in — a phone photo is 8 MB and the box wants pixels, not megabytes. */
function readImage(file: File, maxEdge = 1536): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onerror = () => reject(new Error('Could not read that file.'))
    fr.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('That file is not an image the browser can open.'))
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.width, img.height))
        if (scale === 1) return resolve(String(fr.result))
        const c = document.createElement('canvas')
        c.width = Math.round(img.width * scale)
        c.height = Math.round(img.height * scale)
        const ctx = c.getContext('2d')
        if (!ctx) return resolve(String(fr.result))
        ctx.drawImage(img, 0, 0, c.width, c.height)
        resolve(c.toDataURL('image/png'))
      }
      img.src = String(fr.result)
    }
    fr.readAsDataURL(file)
  })
}

/** Where a plate's picture comes from: this machine, or the box it lives on. */
function plateSrc(plate: Plate, endpoint: ComfyEndpoint | null): string | null {
  if (plate.dataUrl) return plate.dataUrl
  if (plate.boxFile && endpoint) return inputUrl(endpoint, plate.boxFile.filename)
  return null
}

function PlateRow({ plate, n }: { plate: Plate; n: number }) {
  const { updatePlate, deletePlate, reorderPlate, endpoint } = useApp()
  const [job, setJob] = useState(plate.job)
  const [name, setName] = useState(plate.name)

  return (
    <div style={{ display: 'flex', gap: 14, padding: '15px 0', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ width: 148, flex: '0 0 auto' }}>
        {(() => {
          const src = plateSrc(plate, endpoint)
          const border = `${plate.mode === 'replaced' ? 2 : 1}px solid ${plate.mode === 'replaced' ? 'var(--kw-picture)' : 'var(--rule2)'}`
          const box = { width: 148, height: 84, objectFit: 'cover' as const, border, display: 'block', background: 'var(--sunk)' }
          if (!src) return <div style={{ ...box, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span className="tok">no file</span></div>
          return plate.kind === 'video' ? <video src={src} muted preload="metadata" style={box} /> : <img src={src} alt="" style={box} />
        })()}
        <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
          <button className="btn sm ghost" title="Earlier — lower Picture number" onClick={() => void reorderPlate(plate.id, -1)}>↑</button>
          <button className="btn sm ghost" title="Later" onClick={() => void reorderPlate(plate.id, 1)}>↓</button>
          <div style={{ flexGrow: 1 }} />
          <button className="btn sm ghost" onClick={() => void deletePlate(plate.id)}>remove</button>
        </div>
      </div>

      <div style={{ flexGrow: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <span className="tok" style={{ color: 'var(--kw-picture)', background: 'var(--kw-picture-bg)', padding: '1px 5px' }}>
            &lt;{plate.kind === 'video' ? 'Video' : 'Picture'} {n}&gt;
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void updatePlate(plate.id, { name })}
            style={{ flexGrow: 1, border: 'none', background: 'transparent', padding: 0, fontSize: 12.5, fontWeight: 500 }}
          />
          <button
            className={`chip ${plate.mode === 'carried' ? '' : 'on'}`}
            style={{ padding: '2px 8px', fontSize: 10 }}
            title="Carried plates stay for every clip. A replaced plate is rewritten by Continue each time."
            onClick={() => void updatePlate(plate.id, { mode: plate.mode === 'carried' ? 'replaced' : 'carried' })}
          >
            {plate.mode === 'carried' ? 'carried' : 'replaced each clip'}
          </button>
        </div>

        <textarea
          value={job}
          onChange={(e) => setJob(e.target.value)}
          onBlur={() => void updatePlate(plate.id, { job })}
          placeholder="What must the model take from this image, and what must it ignore?"
          style={{ width: '100%', marginTop: 8, minHeight: 46, resize: 'vertical', lineHeight: 1.5 }}
        />
        {!job.trim() && (
          <div className="tok" style={{ color: 'var(--ox)', marginTop: 5 }}>
            No job written — an unexplained reference drifts. This blocks rendering.
          </div>
        )}
      </div>
    </div>
  )
}


/**
 * Pick from what is already on the box.
 *
 * Loaded ONLY when this opens: a listing is two /object_info calls and a few
 * hundred filenames, and there is no reason to pay for it on every probe.
 * ComfyUI has no directory API — each file-picking node publishes its folder as
 * a COMBO, so LoadImage is the image listing and VHS_LoadVideo the video one.
 */
function BoxPicker({ onClose }: { onClose: () => void }) {
  const { endpoint, plates, addPlate } = useApp()
  const [tab, setTab] = useState<'image' | 'video'>('image')
  const [data, setData] = useState<{ images: string[]; videos: string[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [q, setQ] = useState('')

  useEffect(() => {
    if (!endpoint) {
      setErr('No ComfyUI endpoint selected.')
      return
    }
    let live = true
    listBoxInputs(endpoint)
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(String((e as Error).message || e)))
    return () => {
      live = false
    }
  }, [endpoint])

  const files = useMemo(() => {
    const all = (tab === 'image' ? data?.images : data?.videos) ?? []
    const needle = q.trim().toLowerCase()
    return needle ? all.filter((f) => f.toLowerCase().includes(needle)) : all
  }, [data, tab, q])

  const used = plates.filter((p) => p.kind === tab).length
  const cap = tab === 'image' ? REF_CAPS.image : REF_CAPS.video
  const room = cap - used

  const take = async (filename: string) => {
    if (!endpoint || room <= 0) return
    await addPlate({
      name: filename.replace(/\.[^.]+$/, ''),
      job: '',
      kind: tab,
      mode: 'carried',
      boxFile: { endpointId: endpoint.id, filename, subfolder: '', type: 'input' },
    })
  }

  return (
    <div className="backdrop" style={{ zIndex: 60 }} onClick={onClose}>
      <div className="modal" style={{ maxWidth: 860, height: '82vh' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>On the box</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              Files already in {endpoint?.label ?? 'ComfyUI'}’s input folder. Picking one cites it where it is — nothing
              is uploaded.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', gap: 7 }}>
            <button className={`chip${tab === 'image' ? ' on' : ''}`} onClick={() => setTab('image')}>
              images {data ? `· ${data.images.length}` : ''}
            </button>
            <button className={`chip${tab === 'video' ? ' on' : ''}`} onClick={() => setTab('video')}>
              videos {data ? `· ${data.videos.length}` : ''}
            </button>
          </div>
        </div>

        <div className="modal-body">
          <div style={{ display: 'flex', gap: 9, alignItems: 'center', marginBottom: 14 }}>
            <input type="text" value={q} onChange={(e) => setQ(e.target.value)} placeholder="filter by name…" style={{ flexGrow: 1 }} />
            <span className="tok">
              {room > 0 ? `room for ${room} more ${tab}${room === 1 ? '' : 's'}` : `${tab} references are full (${cap})`}
            </span>
          </div>

          {err && <div className="card err">{err}</div>}
          {!data && !err && <div className="tok">reading the input folder…</div>}
          {data && !files.length && <div className="tok">Nothing here{q ? ' matches that' : ''}.</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(148px, 1fr))', gap: 12 }}>
            {endpoint &&
              files.map((f) => (
                <div key={f} style={{ cursor: room > 0 ? 'pointer' : 'not-allowed', opacity: room > 0 ? 1 : 0.4 }} onClick={() => void take(f)}>
                  {tab === 'image' ? (
                    <img
                      src={inputUrl(endpoint, f)}
                      alt=""
                      loading="lazy"
                      style={{ width: '100%', height: 92, objectFit: 'cover', border: '1px solid var(--rule2)', display: 'block', background: 'var(--sunk)' }}
                    />
                  ) : (
                    <video
                      src={inputUrl(endpoint, f)}
                      muted
                      preload="metadata"
                      style={{ width: '100%', height: 92, objectFit: 'cover', border: '1px solid var(--rule2)', display: 'block', background: 'var(--sunk)' }}
                    />
                  )}
                  <div className="tok" style={{ marginTop: 5, wordBreak: 'break-all', lineHeight: 1.35 }}>{f}</div>
                </div>
              ))}
          </div>
        </div>

        <div className="modal-foot">
          <span className="tok">H3 takes {REF_CAPS.image} image references and {REF_CAPS.video} video ones.</span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

export function PlatesPanel({ onClose }: { onClose: () => void }) {
  const { plates, addPlate, endpoint } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)

  async function take(files: FileList | null) {
    if (!files?.length) return
    setErr(null)
    for (const f of Array.from(files).slice(0, MAX_REFS - plates.length)) {
      try {
        const dataUrl = await readImage(f)
        await addPlate({ name: f.name.replace(/\.[^.]+$/, ''), job: '', kind: 'image', dataUrl, mode: 'carried' })
      } catch (e) {
        setErr(String((e as Error).message || e))
      }
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 780 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Plates</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              Every reference gets a job, or it drifts. The binding clause is built from this table, in this order.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <span className="tok">
            {plates.length} of {MAX_REFS}
          </span>
        </div>

        <div className="modal-body">
          {plates.map((p, i) => (
            <PlateRow key={p.id} plate={p} n={i + 1} />
          ))}

          <div style={{ display: 'flex', gap: 9, marginTop: 15 }}>
            <button className="btn" disabled={!endpoint} onClick={() => setPicking(true)}>
              Select from the box
            </button>
            <span className="tok" style={{ alignSelf: 'center' }}>
              {endpoint ? `browse ${endpoint.label}’s input folder — images and videos` : 'connect a ComfyUI to browse its files'}
            </span>
          </div>

          {plates.length < MAX_REFS ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault()
                void take(e.dataTransfer.files)
              }}
              onClick={() => fileRef.current?.click()}
              style={{
                border: '1px dashed var(--rule2)',
                padding: '18px 16px',
                marginTop: 9,
                textAlign: 'center',
                cursor: 'pointer',
                color: 'var(--ink3)',
                fontSize: 11.5,
              }}
            >
              Drop images here, or click to choose. They are uploaded to your ComfyUI once and reused by name.
            </div>
          ) : (
            <div className="tok" style={{ marginTop: 15 }}>
              Nine is H3's limit. Remove one before adding another.
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => void take(e.target.files)}
          />
          {err && <div className="card err" style={{ marginTop: 9 }}>{err}</div>}
        </div>

        {picking && <BoxPicker onClose={() => setPicking(false)} />}

        <div className="modal-foot">
          <span className="tok">Order is the numbering — move a plate and the clause renumbers with it.</span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
