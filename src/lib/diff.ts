/**
 * A small line diff with word-level detail inside changed lines.
 *
 * Prompts are long, mostly-unchanged prose, so a plain line diff reports a
 * whole paragraph as replaced when one clause moved. Pairing removed lines
 * with added ones and diffing the words inside shows what actually changed.
 */

export type Op = 'same' | 'add' | 'del'

export interface WordPart {
  op: Op
  text: string
}

export interface DiffRow {
  op: Op | 'change'
  left?: string
  right?: string
  /** Word-level detail, present only on a `change` row. */
  leftParts?: WordPart[]
  rightParts?: WordPart[]
}

function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length
  const n = b.length
  const t: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1])
    }
  }
  return t
}

function rawDiff(a: string[], b: string[]): { op: Op; text: string }[] {
  const t = lcsTable(a, b)
  const out: { op: Op; text: string }[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] })
      i++
      j++
    } else if (t[i + 1][j] >= t[i][j + 1]) {
      out.push({ op: 'del', text: a[i++] })
    } else {
      out.push({ op: 'add', text: b[j++] })
    }
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++] })
  while (j < b.length) out.push({ op: 'add', text: b[j++] })
  return out
}

// Split on whitespace but keep it, so rebuilt text spaces correctly.
const splitWords = (s: string) => s.match(/\S+\s*/g) ?? []

export function wordDiff(before: string, after: string): { left: WordPart[]; right: WordPart[] } {
  const parts = rawDiff(splitWords(before), splitWords(after))
  const left: WordPart[] = []
  const right: WordPart[] = []
  for (const p of parts) {
    if (p.op === 'same') {
      left.push({ op: 'same', text: p.text })
      right.push({ op: 'same', text: p.text })
    } else if (p.op === 'del') {
      left.push({ op: 'del', text: p.text })
    } else {
      right.push({ op: 'add', text: p.text })
    }
  }
  return { left, right }
}

/** How much of two lines is shared, 0..1 — used to decide if they are a pair. */
function similarity(a: string, b: string): number {
  const aw = splitWords(a).map((w) => w.trim())
  const bw = splitWords(b).map((w) => w.trim())
  if (!aw.length && !bw.length) return 1
  const pool = new Map<string, number>()
  for (const w of aw) pool.set(w, (pool.get(w) ?? 0) + 1)
  let shared = 0
  for (const w of bw) {
    const n = pool.get(w) ?? 0
    if (n > 0) {
      shared++
      pool.set(w, n - 1)
    }
  }
  return (2 * shared) / (aw.length + bw.length)
}

const PAIR_THRESHOLD = 0.35

export function diffLines(before: string, after: string): DiffRow[] {
  const parts = rawDiff(before.split('\n'), after.split('\n'))
  const rows: DiffRow[] = []

  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.op === 'same') {
      rows.push({ op: 'same', left: p.text, right: p.text })
      continue
    }

    // Gather this run of deletions and additions, then pair them up.
    const dels: string[] = []
    const adds: string[] = []
    let k = i
    while (k < parts.length && parts[k].op !== 'same') {
      if (parts[k].op === 'del') dels.push(parts[k].text)
      else adds.push(parts[k].text)
      k++
    }
    i = k - 1

    const used = new Set<number>()
    for (const del of dels) {
      let best = -1
      let bestScore = PAIR_THRESHOLD
      for (let a = 0; a < adds.length; a++) {
        if (used.has(a)) continue
        const score = similarity(del, adds[a])
        if (score > bestScore) {
          bestScore = score
          best = a
        }
      }
      if (best === -1) {
        rows.push({ op: 'del', left: del })
      } else {
        used.add(best)
        const { left, right } = wordDiff(del, adds[best])
        rows.push({ op: 'change', left: del, right: adds[best], leftParts: left, rightParts: right })
      }
    }
    adds.forEach((line, a) => {
      if (!used.has(a)) rows.push({ op: 'add', right: line })
    })
  }

  return rows
}

export function diffStats(rows: DiffRow[]) {
  return {
    added: rows.filter((r) => r.op === 'add').length,
    removed: rows.filter((r) => r.op === 'del').length,
    changed: rows.filter((r) => r.op === 'change').length,
    same: rows.filter((r) => r.op === 'same').length,
  }
}

/** Collapse long unchanged stretches so the changes are findable. */
export function collapse(rows: DiffRow[], context = 2): (DiffRow | { op: 'gap'; count: number })[] {
  const keep = new Set<number>()
  rows.forEach((r, i) => {
    if (r.op === 'same') return
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep.add(j)
  })
  const out: (DiffRow | { op: 'gap'; count: number })[] = []
  let run = 0
  rows.forEach((r, i) => {
    if (keep.has(i)) {
      if (run) {
        out.push({ op: 'gap', count: run })
        run = 0
      }
      out.push(r)
    } else {
      run++
    }
  })
  if (run) out.push({ op: 'gap', count: run })
  return out
}
