/**
 * probe/gepa/trainset.ts — freeze the 19 re-authoring cases into one JSON
 * file so the optimiser has a fixed, cacheable input.
 *
 * Each case is what preset A needs to write a prompt — a story and a plan —
 * plus the plan the judge scores against. Both come from the OLD project
 * files, exactly as `probe/pipeline/reauthor.ts` derives them, so a GEPA run
 * and the A/B comparison are talking about the same 19 cases.
 *
 * WHY A FILE RATHER THAN RE-DERIVING. The optimiser caches authoring calls by
 * hash(instruction + story). If the story were rebuilt each run and any
 * detail of the derivation changed, every cache entry would silently miss and
 * a 65-minute run would become a four-hour one without saying why.
 *
 * ```sh
 * npx tsx probe/gepa/trainset.ts --out probe/gepa/trainset.json
 * ```
 *
 * No GPU, no network.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { splitPromptShots } from '../../src/lib/promptShots'

export interface TrainCase {
  label: string
  /** What the author pass is given as `{{story}}`. */
  story: string
  /** The judge's `--plan`: clipSeconds, approvedShots, hasCharacters, hasDialogue. */
  plan: {
    clipSeconds: number
    hasCharacters: boolean
    hasDialogue: boolean
    approvedShots: { index: number; summary: string; seconds: number }[]
  }
}

const SOURCES: { dir: string; label: string; latest?: boolean }[] = [
  { dir: join(homedir(), 'dhee-studios/sakhubai_h3/prompts/scenes'), label: 'sakhubai' },
  { dir: join(homedir(), 'dhee-studios/veyra-cloudsilk-ugc-60s-draft/prompts/sections'), label: 'veyra' },
  { dir: join(homedir(), 'dhee-studios/gyantv-pte-01/prompts/scenes'), label: 'gyantv', latest: true },
]

function isStructured(d: any): boolean {
  return Array.isArray(d.shots) && d.shots.length > 0 && typeof d.shots[0]?.startTime === 'number'
}

function stamp(sec: number): string {
  const mm = Math.floor(sec / 60), ss = sec - mm * 60
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(3).padStart(6, '0')}`
}

/** The structured corpus's own shots, composed into the prose H3 expects.
 * Dialogue keeps its speaker id and its ORIGINAL language — dropping either
 * is what made the old arm look far worse than it was. */
function structuredDescription(d: any): string {
  const body: string[] = []
  if (d.style) body.push(String(d.style).trim())
  d.shots.forEach((sh: any, i: number) => {
    const marker = i === 0 ? '[Shot 1]' : `[Shot ${i + 1}] At ${stamp(Number(sh.startTime) || 0)},`
    const lines = (sh.dialogue ?? []).map((x: any) => {
      if (typeof x === 'string') return x
      const words = x?.exactWords ?? x?.line ?? x?.text ?? ''
      if (!words) return ''
      return `${x?.speakerId ? `(${x.speakerId}) ` : ''}<d>${x?.language ? `[${x.language}] ` : ''}${words}</d>`
    }).filter(Boolean)
    body.push([marker, sh.composition, sh.action,
      sh.cameraMotion ? `Camera: ${sh.cameraMotion}.` : '',
      lines.join(' ')].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
  })
  return body.join(' ')
}

function proseDescription(d: any): string {
  const spoken = d.spokenLinesAudio
    ? String(d.spokenLinesAudio)
    : (d.spokenLines ?? []).map((l: string) => `<d>[English] ${l}</d>`).join(' ')
  return [d.detailedDescription ?? '', spoken].filter(Boolean).join(' ')
}

export function buildCase(d: any, label: string): TrainCase | null {
  const structured = isStructured(d)
  const desc = structured ? structuredDescription(d) : proseDescription(d)
  if (!desc.trim()) return null

  const duration = Number(d.duration) || 10
  const oldShots = splitPromptShots(desc).shots
  const approvedShots = structured
    ? d.shots.map((sh: any, i: number) => ({
        index: i + 1,
        summary: String(sh.action || sh.composition || '').replace(/\s+/g, ' ').trim().slice(0, 160),
        seconds: +((Number(sh.endTime) - Number(sh.startTime)) || duration / d.shots.length).toFixed(2),
      }))
    : Array.from({ length: Math.max(1, oldShots.length) }, (_, i) => ({
        index: i + 1,
        summary: (oldShots[i]?.text ?? desc).replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0].slice(0, 160),
        seconds: +(duration / Math.max(1, oldShots.length)).toFixed(2),
      }))

  const hasDialogue = structured
    ? d.shots.some((sh: any) => (sh.dialogue ?? []).length > 0)
    : (d.spokenLines ?? []).length > 0 || /<d>/.test(desc)

  const story = [
    d.purpose ? `PURPOSE: ${d.purpose}` : '',
    d.summary ? `SUMMARY: ${d.summary}` : '',
    `WHAT HAPPENS IN THIS CLIP:\n${desc}`,
  ].filter(Boolean).join('\n\n')

  return { label, story, plan: { clipSeconds: duration, hasCharacters: true, hasDialogue, approvedShots } }
}

/** Highest version per stem — a corpus that keeps every draft would otherwise
 * train on drafts the operator already rejected. */
function latestOnly(files: string[]): string[] {
  const best = new Map<string, { v: number; f: string }>()
  for (const f of files) {
    const m = f.match(/^(.*?)(?:\.v(\d+))?\.json$/)
    if (!m) continue
    const cur = best.get(m[1])
    const v = Number(m[2] ?? 0)
    if (!cur || v > cur.v) best.set(m[1], { v, f })
  }
  return [...best.values()].map((b) => b.f).sort()
}

function main() {
  const i = process.argv.indexOf('--out')
  const out = i === -1 ? 'probe/gepa/trainset.json' : process.argv[i + 1]
  const cases: TrainCase[] = []
  for (const src of SOURCES) {
    let files = readdirSync(src.dir).filter((f) => f.endsWith('.json')).sort()
    if (src.latest) files = latestOnly(files)
    for (const f of files) {
      const c = buildCase(JSON.parse(readFileSync(join(src.dir, f), 'utf8')), `${src.label}-${f.replace(/\.json$/, '')}`)
      if (c) cases.push(c)
      else console.log(`  skipped ${src.label}-${f} (no description)`)
    }
  }
  writeFileSync(out, JSON.stringify(cases, null, 2), 'utf8')
  const dlg = cases.filter((c) => c.plan.hasDialogue).length
  const shots = cases.reduce((n, c) => n + c.plan.approvedShots.length, 0)
  console.log(`${cases.length} cases -> ${out}`)
  console.log(`  ${dlg} with dialogue, ${shots} approved shots total, ${cases.filter((c) => c.plan.approvedShots.length > 1).length} multi-shot`)
}

if (basename(process.argv[1] ?? '') === 'trainset.ts') main()
