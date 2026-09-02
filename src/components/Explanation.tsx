import { useState } from 'react'
import { ProseDoc } from './ProseDoc'

/**
 * The explanation section that sits below the prompt — why the pass decided
 * what it decided, in terms of the loaded documents. Kept as its own block
 * so it never gets copied along with the prompt and never gets linted as one.
 */
export function Explanation({ text, changelog, streaming }: { text: string; changelog?: string[]; streaming?: boolean }) {
  const [open, setOpen] = useState(true)
  if (!text.trim() && !changelog?.length) return null

  return (
    <div style={{ marginTop: 18, borderTop: '1px solid var(--rule)', paddingTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 10 }}>
        <span className="pane-tag in">EXPLANATION</span>
        <div style={{ flexGrow: 1 }} />
        <button className="chip" onClick={() => setOpen((v) => !v)}>
          {open ? 'hide' : 'show'}
        </button>
      </div>
      {open && (
        <>
          {text.trim() && <ProseDoc text={text} streaming={streaming} />}
          {changelog && changelog.length > 0 && (
            <div className="changelog" style={{ marginTop: text.trim() ? 16 : 0, paddingTop: text.trim() ? 14 : 0, borderTop: text.trim() ? '1px solid var(--rule)' : 'none' }}>
              <div className="lbl" style={{ marginBottom: 8 }}>Changes</div>
              <ol>
                {changelog.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ol>
            </div>
          )}
        </>
      )}
    </div>
  )
}
