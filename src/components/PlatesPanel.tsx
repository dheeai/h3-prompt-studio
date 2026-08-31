import { useRef, useState } from 'react'
import { useApp } from '../app/state'
import type { Plate } from '../lib/types'

const MAX_REFS = 9

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

function PlateRow({ plate, n }: { plate: Plate; n: number }) {
  const { updatePlate, deletePlate, reorderPlate } = useApp()
  const [job, setJob] = useState(plate.job)
  const [name, setName] = useState(plate.name)

  return (
    <div style={{ display: 'flex', gap: 14, padding: '15px 0', borderBottom: '1px solid var(--rule)' }}>
      <div style={{ width: 148, flex: '0 0 auto' }}>
        <img
          src={plate.dataUrl}
          alt=""
          style={{ width: 148, height: 84, objectFit: 'cover', border: `${plate.mode === 'replaced' ? 2 : 1}px solid ${plate.mode === 'replaced' ? 'var(--kw-picture)' : 'var(--rule2)'}`, display: 'block' }}
        />
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
            &lt;Picture {n}&gt;
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

export function PlatesPanel({ onClose }: { onClose: () => void }) {
  const { plates, addPlate } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string | null>(null)

  async function take(files: FileList | null) {
    if (!files?.length) return
    setErr(null)
    for (const f of Array.from(files).slice(0, MAX_REFS - plates.length)) {
      try {
        const dataUrl = await readImage(f)
        await addPlate({ name: f.name.replace(/\.[^.]+$/, ''), job: '', dataUrl, mode: 'carried' })
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
                marginTop: 15,
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

        <div className="modal-foot">
          <span className="tok">Order is the numbering — move a plate and the clause renumbers with it.</span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
