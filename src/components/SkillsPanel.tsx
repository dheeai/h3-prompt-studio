import { useRef, useState } from 'react'
import { useApp } from '../app/state'
import { estimateUsage } from '../lib/db'
import { exportSkills, importSkills, skillFromUrl, skillTokens, skillsFromFileList } from '../lib/skills'
import { fmtBytes, fmtTokens } from '../lib/tokens'
import type { Skill } from '../lib/types'

function SkillRow({ skill }: { skill: Skill }) {
  const { settings, toggleSkill, toggleFile, deleteSkill } = useApp()
  const [open, setOpen] = useState(false)
  const selected = settings.selection[skill.id] || []
  const state = selected.length === 0 ? 'off' : selected.length === skill.files.length ? 'on' : 'part'

  return (
    <div style={{ borderBottom: '1px solid var(--rule)' }}>
      <div className="trow" style={{ borderBottom: 'none' }}>
        <button
          className={`box ${state === 'on' ? 'on' : state === 'part' ? 'part' : ''}`}
          onClick={() => toggleSkill(skill)}
          aria-label={`Toggle ${skill.name}`}
          style={{ cursor: 'pointer' }}
        />
        <button
          onClick={() => setOpen((v) => !v)}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexGrow: 1, textAlign: 'left', minWidth: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{skill.name}</span>
            <span className="tok">
              {skill.files.length} file{skill.files.length === 1 ? '' : 's'}
            </span>
          </div>
          {skill.description && (
            <div style={{ fontSize: 11, color: 'var(--ink3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {skill.description}
            </div>
          )}
        </button>
        <span className="tok" style={{ width: 52, textAlign: 'right', color: selected.length ? 'var(--ox)' : undefined }}>
          {fmtTokens(skillTokens(skill, selected.length ? selected : undefined))}
        </span>
        <span className="tok" style={{ width: 72 }}>
          {skill.source}
        </span>
        <span style={{ width: 54, textAlign: 'right' }}>
          {skill.source !== 'bundled' ? (
            <button className="btn sm ghost" onClick={() => void deleteSkill(skill.id)}>
              remove
            </button>
          ) : (
            <span className="tok">—</span>
          )}
        </span>
      </div>

      {open && (
        <div style={{ padding: '0 12px 10px 12px', background: 'var(--panel)' }}>
          {skill.files.map((f) => (
            <div className="filerow" key={f.rel} onClick={() => toggleFile(skill, f.rel)}>
              <span className={`box ${selected.includes(f.rel) ? 'on' : ''}`} />
              <span className="tok" style={{ flexGrow: 1, color: selected.includes(f.rel) ? 'var(--ink2)' : undefined }}>
                {f.rel}
              </span>
              <span className="tok">{fmtTokens(f.tokens)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function SkillsPanel({ onClose }: { onClose: () => void }) {
  const { skills, addSkills, context } = useApp()
  const [hot, setHot] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)

  useState(() => {
    void estimateUsage().then(setUsage)
    return undefined
  })

  const ingest = async (files: FileList | File[]) => {
    setBusy('Reading…')
    setErr(null)
    try {
      const found = await skillsFromFileList(files)
      if (!found.length) throw new Error('No markdown found. Drop a folder with a SKILL.md, loose .md files, or a .zip.')
      await addSkills(found)
      void estimateUsage().then(setUsage)
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  const addUrl = async () => {
    if (!url.trim()) return
    setBusy('Fetching…')
    setErr(null)
    try {
      await addSkills([await skillFromUrl(url.trim())])
      setUrl('')
    } catch (e) {
      setErr(`Could not fetch that URL — ${String((e as Error).message || e)}. The host must allow cross-origin reads.`)
    } finally {
      setBusy(null)
    }
  }

  const doExport = () => {
    const url = URL.createObjectURL(exportSkills(skills))
    const a = document.createElement('a')
    a.href = url
    a.download = 'h3-studio-skills.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  const doImport = async (file: File) => {
    setBusy('Importing…')
    setErr(null)
    try {
      await addSkills(importSkills(await file.text()))
    } catch (e) {
      setErr(String((e as Error).message || e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Skills</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              Kept in this browser. They’ll be here next time you open the page.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          <button className="btn" onClick={doExport} disabled={!skills.length}>Export all</button>
          <button className="btn" onClick={() => importRef.current?.click()}>Import…</button>
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          <div
            className={`dropzone${hot ? ' hot' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setHot(true)
            }}
            onDragLeave={() => setHot(false)}
            onDrop={(e) => {
              e.preventDefault()
              setHot(false)
              if (e.dataTransfer.files.length) void ingest(e.dataTransfer.files)
            }}
          >
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--ox)" strokeWidth="1.3" style={{ flex: '0 0 auto' }}>
              <path d="M12 15.5V4M12 4L7.5 8.5M12 4l4.5 4.5" />
              <path d="M3.5 15v3.5a1.5 1.5 0 001.5 1.5h14a1.5 1.5 0 001.5-1.5V15" stroke="var(--rule2)" />
            </svg>
            <div style={{ flexGrow: 1 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{busy ?? 'Drop a skill folder, a .md file, or a .zip'}</div>
              <div style={{ fontSize: 11.5, color: 'var(--ink2)', marginTop: 4, lineHeight: 1.5 }}>
                A folder with a <code style={{ fontFamily: 'var(--mono)' }}>SKILL.md</code> at its root becomes one skill with its references
                intact. Loose markdown files each become a skill of their own.
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button className="btn pri sm" onClick={() => folderRef.current?.click()}>Choose folder</button>
              <button className="btn sm" onClick={() => fileRef.current?.click()}>Choose files</button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
            <input
              type="text"
              placeholder="…or paste a URL to a raw .md file or a skill manifest"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addUrl()}
              spellCheck={false}
              style={{ flexGrow: 1, fontFamily: 'var(--mono)', fontSize: 11 }}
            />
            <button className="btn sm" onClick={() => void addUrl()} disabled={!url.trim()}>Add</button>
          </div>

          {err && <div className="alert err" style={{ marginTop: 10 }}>{err}</div>}

          <div style={{ marginTop: 16, border: '1px solid var(--rule)' }}>
            <div className="trow" style={{ background: 'var(--panel)' }}>
              <span className="lbl" style={{ flexGrow: 1, paddingLeft: 22 }}>Installed</span>
              <span className="lbl" style={{ width: 52, textAlign: 'right' }}>Tokens</span>
              <span className="lbl" style={{ width: 72 }}>Source</span>
              <span style={{ width: 54 }} />
            </div>
            {skills.length ? (
              skills.map((s) => <SkillRow key={s.id} skill={s} />)
            ) : (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--ink3)', fontSize: 11.5 }}>
                Nothing loaded yet. Drop a folder above to begin.
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          <span className="tok">
            {usage ? `${fmtBytes(usage.used)} used · ` : ''}
            {skills.length} skill{skills.length === 1 ? '' : 's'}
            {context ? ` · ${fmtTokens(context.tokens)} est. loaded` : ''}
          </span>
          <div style={{ flexGrow: 1 }} />
          <span className="tok" style={{ maxWidth: 300, lineHeight: 1.4, textAlign: 'right' }}>
            Clearing site data removes uploaded skills. Export first if they only exist here.
          </span>
        </div>

        <input
          ref={folderRef}
          type="file"
          hidden
          multiple
          // @ts-expect-error non-standard but supported in every browser this app targets
          webkitdirectory=""
          directory=""
          onChange={(e) => e.target.files && void ingest(e.target.files)}
        />
        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.txt,.zip" onChange={(e) => e.target.files && void ingest(e.target.files)} />
        <input ref={importRef} type="file" hidden accept=".json" onChange={(e) => e.target.files?.[0] && void doImport(e.target.files[0])} />
      </div>
    </div>
  )
}
