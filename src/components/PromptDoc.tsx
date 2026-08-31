import { KNOWN_SECTIONS, TOKEN_LABEL, kindsPresent, splitSections, tokenize } from '../lib/highlight'
import type { TokenKind } from '../lib/highlight'

function Inline({ text }: { text: string }) {
  return (
    <>
      {tokenize(text).map((t, i) =>
        typeof t === 'string' ? (
          <span key={i}>{t}</span>
        ) : (
          <span key={i} className={`kw ${t.kind}`} title={TOKEN_LABEL[t.kind]}>
            {t.text}
          </span>
        ),
      )}
    </>
  )
}

export function Legend({ text }: { text: string }) {
  const kinds = kindsPresent(text)
  if (!kinds.length) return null
  return (
    <div className="legend">
      {kinds.map((k: TokenKind) => (
        <span key={k} className="legend-item">
          <span className={`kw ${k} swatch`} />
          {TOKEN_LABEL[k]}
        </span>
      ))}
    </div>
  )
}

export function PromptDoc({ text, streaming }: { text: string; streaming?: boolean }) {
  const sections = splitSections(text)

  return (
    <div className="doc">
      {sections.map((s, i) => (
        <div className="sec" key={`${s.name ?? 'head'}-${i}`}>
          {s.name && (
            <div className="sec-head">
              <span className={`sec-name${KNOWN_SECTIONS.includes(s.name.toLowerCase()) ? '' : ' unknown'}`}>{s.name}</span>
              <span className="sec-rule" />
            </div>
          )}
          <div className="sec-body">
            <Inline text={s.body} />
            {streaming && i === sections.length - 1 && <span className="caret" />}
          </div>
        </div>
      ))}
    </div>
  )
}
