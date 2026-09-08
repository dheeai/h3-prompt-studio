/**
 * Build BLIND pairwise judging packets.
 *
 * The judge must not know which authoring mode or reasoning budget produced a
 * prompt, so each pair is written as A.txt / B.txt with the side assignment
 * decided by a seeded shuffle. The key stays outside the packet directory.
 *
 * Content is copied VERBATIM — no cleanup. Scaffolding, thin bodies and stray
 * markers are exactly the quality signals under test; stripping them would
 * launder the difference we are trying to measure.
 *
 * Usage: node make-pairs.mjs <outRoot> <armName> <dirA> <modeA> <dirB> <modeB>
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const [outRoot, arm, dirA, modeA, dirB, modeB] = process.argv.slice(2)
if (!modeB) { console.error('usage: node make-pairs.mjs <outRoot> <arm> <dirA> <modeA> <dirB> <modeB>'); process.exit(1) }

const prefix = (m) => ({ json: 'json_schema-', text: 'text-', decomp: 'json_decomposed-' }[m] || `${m}-`)
const briefsIn = (dir, mode) =>
  existsSync(dir)
    ? readdirSync(dir).filter((f) => f.startsWith(prefix(mode)) && f.endsWith('.prompt.txt'))
        .map((f) => f.slice(prefix(mode).length).replace('-1.prompt.txt', ''))
    : []

const shared = briefsIn(dirA, modeA).filter((b) => briefsIn(dirB, modeB).includes(b)).sort()

// Deterministic per-brief coin flip: FNV-1a of the brief id, so a re-run
// produces the identical layout and the key stays valid.
const flip = (s) => {
  let h = 0x811c9dc5
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0 }
  return (h & 1) === 1
}

const key = []
for (const brief of shared) {
  const dir = join(outRoot, arm, brief)
  mkdirSync(dir, { recursive: true })
  const fileA = join(dirA, `${prefix(modeA)}${brief}-1.prompt.txt`)
  const fileB = join(dirB, `${prefix(modeB)}${brief}-1.prompt.txt`)
  const swap = flip(brief)
  const sideA = swap ? fileB : fileA
  const sideB = swap ? fileA : fileB
  writeFileSync(join(dir, 'A.txt'), readFileSync(sideA, 'utf8'))
  writeFileSync(join(dir, 'B.txt'), readFileSync(sideB, 'utf8'))
  key.push({ arm, brief, A: swap ? `${dirB}:${modeB}` : `${dirA}:${modeA}`, B: swap ? `${dirA}:${modeA}` : `${dirB}:${modeB}` })
}

writeFileSync(join(outRoot, `KEY-${arm}.json`), JSON.stringify(key, null, 2))
console.log(`${arm}: ${key.length} pairs → ${join(outRoot, arm)}   (key held at ${join(outRoot, `KEY-${arm}.json`)})`)
