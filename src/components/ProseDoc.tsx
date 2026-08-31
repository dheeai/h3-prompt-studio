import type { ReactNode } from 'react'
import { TOKEN_LABEL, tokenize } from '../lib/highlight'

/**
 * A small markdown renderer.
 *
 * Direct and Critique return prose — headings, numbered findings, quoted
 * fragments — and rendering that as one monospace block made a structured
 * critique read as a wall. This covers what those stages actually emit and
 * lets anything it does not recognise fall through as text.
 *
 * The H3 keyword highlighting runs inside the prose too, so a critique that
 * quotes <Subject 1> or a timecode marks it the same way the prompt does.
 */

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = []
  // Code first: its contents must not be re-parsed as emphasis.
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|(?<![*\w])\*([^*\n]+)\*(?![*\w])|(?<![_\w])_([^_\n]+)_(?![_\w])/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...keywords(text.slice(last, m.index), `${key}-t${m.index}`))
    if (m[1] !== undefined) out.push(<code key={`${key}-c${m.index}`}>{m[1]}</code>)
    else if (m[2] ?? m[3]) out.push(<strong key={`${key}-b${m.index}`}>{m[2] ?? m[3]}</strong>)
    else out.push(<em key={`${key}-i${m.index}`}>{m[4] ?? m[5]}</em>)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...keywords(text.slice(last), `${key}-t${last}`))
  return out
}

function keywords(text: string, key: string): ReactNode[] {
  return tokenize(text).map((t, i) =>
    typeof t === 'string' ? (
      <span key={`${key}-${i}`}>{t}</span>
    ) : (
      <span key={`${key}-${i}`} className={`kw ${t.kind}`} title={TOKEN_LABEL[t.kind]}>
        {t.text}
      </span>
    ),
  )
}

type Block =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[]; start?: number }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'hr' }

function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (!line.trim()) {
      i++
      continue
    }

    const fence = line.match(/^\s*```/)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++])
      i++
      blocks.push({ kind: 'code', text: body.join('\n') })
      continue
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr' })
      i++
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      blocks.push({ kind: 'h', level: h[1].length, text: h[2].trim() })
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      const body: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''))
      blocks.push({ kind: 'quote', text: body.join('\n') })
      continue
    }

    const ol = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    if (ol) {
      const items: string[] = []
      const start = Number(ol[1])
      while (i < lines.length) {
        const m = lines[i].match(/^\s*\d+[.)]\s+(.*)$/)
        if (m) {
          items.push(m[1])
          i++
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          // A wrapped continuation line belongs to the item above it.
          items[items.length - 1] += ` ${lines[i].trim()}`
          i++
        } else break
      }
      blocks.push({ kind: 'ol', items, start })
      continue
    }

    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length) {
        const m = lines[i].match(/^\s*[-*•]\s+(.*)$/)
        if (m) {
          items.push(m[1])
          i++
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1] += ` ${lines[i].trim()}`
          i++
        } else break
      }
      blocks.push({ kind: 'ul', items })
      continue
    }

    const body: string[] = []
    while (i < lines.length && lines[i].trim() && !/^\s*(#{1,6}\s|>|```|[-*•]\s|\d+[.)]\s)/.test(lines[i])) {
      body.push(lines[i++])
    }
    blocks.push({ kind: 'p', text: body.join('\n') })
  }

  return blocks
}

export function ProseDoc({ text, streaming }: { text: string; streaming?: boolean }) {
  const blocks = parse(text)
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        const k = `b${i}`
        switch (b.kind) {
          case 'h': {
            const Tag = (`h${Math.min(b.level + 2, 6)}`) as 'h3' | 'h4' | 'h5' | 'h6'
            return <Tag key={k}>{inline(b.text, k)}</Tag>
          }
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((t, j) => (
                  <li key={j}>{inline(t, `${k}-${j}`)}</li>
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol key={k} start={b.start}>
                {b.items.map((t, j) => (
                  <li key={j}>{inline(t, `${k}-${j}`)}</li>
                ))}
              </ol>
            )
          case 'quote':
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>
          case 'code':
            return (
              <pre key={k} className="prose-code">
                {b.text}
              </pre>
            )
          case 'hr':
            return <hr key={k} />
          default:
            return <p key={k}>{inline(b.text, k)}</p>
        }
      })}
      {streaming && <span className="caret" />}
    </div>
  )
}
