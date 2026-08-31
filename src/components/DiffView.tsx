import { useMemo } from 'react'
import { collapse, diffLines, diffStats } from '../lib/diff'
import type { DiffRow, WordPart } from '../lib/diff'

function Parts({ parts, fallback }: { parts?: WordPart[]; fallback?: string }) {
  if (!parts) return <>{fallback}</>
  return (
    <>
      {parts.map((p, i) =>
        p.op === 'same' ? <span key={i}>{p.text}</span> : <mark key={i} className={`w ${p.op}`}>{p.text}</mark>,
      )}
    </>
  )
}

function Side({ row, side }: { row: DiffRow; side: 'left' | 'right' }) {
  const text = side === 'left' ? row.left : row.right
  const parts = side === 'left' ? row.leftParts : row.rightParts

  // A row that only exists on the other side leaves this one blank.
  if (text === undefined) return <div className="dcell empty" />

  const cls =
    row.op === 'same'
      ? 'dcell'
      : row.op === 'change'
        ? 'dcell change'
        : side === 'left'
          ? 'dcell del'
          : 'dcell add'

  return (
    <div className={cls}>
      <Parts parts={row.op === 'change' ? parts : undefined} fallback={text} />
      {text === '' && ' '}
    </div>
  )
}

export function DiffView({ before, after, changelog }: { before: string; after: string; changelog?: string[] }) {
  const rows = useMemo(() => diffLines(before, after), [before, after])
  const stats = useMemo(() => diffStats(rows), [rows])
  const shown = useMemo(() => collapse(rows, 2), [rows])
  const untouched = stats.added + stats.removed + stats.changed === 0

  return (
    <div>
      <div className="diff-summary">
        {untouched ? (
          <span className="tok">This pass changed nothing.</span>
        ) : (
          <>
            <span className="tok">
              <b style={{ color: 'var(--grn)' }}>+{stats.added}</b> added
            </span>
            <span className="tok">
              <b style={{ color: 'var(--ox)' }}>−{stats.removed}</b> removed
            </span>
            <span className="tok">
              <b style={{ color: 'var(--kw-picture)' }}>{stats.changed}</b> rewritten
            </span>
            <span className="tok" style={{ color: 'var(--ink3)' }}>{stats.same} lines untouched</span>
          </>
        )}
      </div>

      <div className="diff-head">
        <div className="dcol">Before</div>
        <div className="dcol">After</div>
      </div>

      <div className="diff-grid">
        {shown.map((row, i) =>
          'count' in row ? (
            <div className="dgap" key={`gap-${i}`}>
              {row.count} unchanged line{row.count === 1 ? '' : 's'}
            </div>
          ) : (
            <div className="drow" key={i}>
              <Side row={row} side="left" />
              <Side row={row} side="right" />
            </div>
          ),
        )}
      </div>

      {changelog?.length ? (
        <div className="changelog">
          <div className="lbl" style={{ marginBottom: 8 }}>What it changed, and why</div>
          <ol>
            {changelog.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="changelog">
          <div className="tok" style={{ lineHeight: 1.5 }}>
            No changelog for this pass — the model returned a prompt without one. The diff above is still exact.
          </div>
        </div>
      )}
    </div>
  )
}
