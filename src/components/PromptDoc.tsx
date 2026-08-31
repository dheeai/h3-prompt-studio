import type { ReactNode } from 'react'

/**
 * Light typographic highlighting for the prompt.
 *
 * Deliberately regex-shallow: the prompt is whatever the model wrote, not a
 * format we control, so anything it doesn't recognise must fall through as
 * plain text rather than disappear.
 */

const FIELD = /^([ \t]*)([a-z][a-z0-9_]{3,})([ \t]*:)/
const INLINE = /(@[a-z0-9_]+)|(\b\d+(?:\.\d+)?\s*[–—-]\s*\d+(?:\.\d+)?\s*s\b)|(\bN\/A\b)/gi

function inlineNodes(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  const rx = new RegExp(INLINE.source, INLINE.flags)
  while ((m = rx.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const cls = m[1] ? 'ref' : m[2] ? 'time' : 'na'
    out.push(
      <span key={`${keyBase}-${m.index}`} className={cls}>
        {m[0]}
      </span>,
    )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function PromptDoc({ text, streaming }: { text: string; streaming?: boolean }) {
  const lines = text.split('\n')
  return (
    <pre className="doc">
      {lines.map((line, i) => {
        const f = line.match(FIELD)
        if (f) {
          const rest = line.slice(f[0].length)
          return (
            <span key={i}>
              {f[1]}
              <span className="field">{f[2]}</span>
              {f[3]}
              {inlineNodes(rest, `l${i}`)}
              {i < lines.length - 1 ? '\n' : ''}
            </span>
          )
        }
        return (
          <span key={i}>
            {inlineNodes(line, `l${i}`)}
            {i < lines.length - 1 ? '\n' : ''}
          </span>
        )
      })}
      {streaming && <span className="caret" />}
    </pre>
  )
}
