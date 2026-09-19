/**
 * probe/pipeline/reauthor.ts — take a prompt authored by an OLDER pipeline,
 * rewrite it through preset A and preset B, and keep all three side by side
 * so the judge can compare them.
 *
 * WHY. `~/dhee-studios/*` holds prompts written before the six-section format
 * and before the direction/acting split. They are the only real corpus of
 * "what we used to produce", and the question worth answering is whether the
 * current pipeline actually improves on them or merely differs.
 *
 * ALL THREE ARMS ARE KEPT ON DISK, including the old one. The eval corpus at
 * `~/Projects/h3-prompt-eval` gitignored its `candidates/`, so 54
 * blind-judged prompts are gone and only the scores survive — ground truth
 * with nothing left to re-judge. Do not repeat that.
 *
 * THE PLAN IS DERIVED FROM THE OLD PROMPT, AND THAT IS DELIBERATE. All three
 * arms are judged against the same plan, and that plan comes from the old
 * prompt's own `[Shot N]` structure and duration. This BIASES THE TEST TOWARD
 * THE OLD ARM — it trivially matches a plan taken from itself, so
 * `shots.fragments-match-plan` is its best case and the new arms' worst. That
 * is on purpose: if a new preset wins anyway, the finding is robust. Judging
 * each arm against a plan derived from itself would make that question
 * meaningless for everyone, and drawing a fresh plan from the story would be
 * unfair to the old arm, which never saw it.
 *
 * FORMAT. The old files are camelCase and carry no `subject_definitions` or
 * `retention_analysis`. They are emitted here with H3's snake_case field
 * names so the same judge and linter can read all three arms, but the two
 * missing sections are NOT invented — their absence is a real difference
 * between the formats and the linter should say so.
 *
 * ```sh
 * LLM_URL=... LLM_MODEL=swift-qwen38-27b \
 *   npx tsx probe/pipeline/reauthor.ts --src <dir-of-json> --out <dir> [--label name]
 * ```
 */

import { DIRECTION_TEMPLATE, fillDirectionTemplate, directionResponseFormat, parseDirection, offVocabularyMovements, directionToPromptBlock } from '../../src/lib/direction'
import { ACTING_TEMPLATE, fillActingTemplate, actingResponseFormat, parseActing, actingToPromptBlock } from '../../src/lib/acting'
import { DEFAULT_TEMPLATES } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { splitPromptShots } from '../../src/lib/promptShots'
import { injectFilmLook } from '../../src/lib/filmLookInject'
import { describeFilmLook, FILM_LOOK_PRESETS } from '../../src/lib/filmLook'
import { withQwenReasoningBudget } from '../../src/lib/thinking'

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, basename } from 'node:path'

const SKILL_DIR = 'public/skills'
function corpus(dirs: string[]): string {
  if (!dirs.length) return ''
  const chunks: string[] = []
  for (const d of dirs) {
    const base = join(SKILL_DIR, d)
    const files = ['SKILL.md']
    try { for (const f of readdirSync(join(base, 'references'))) files.push(join('references', f)) } catch {}
    for (const f of files) {
      try { chunks.push(`<skill name="${d}" file="${f}">\n${readFileSync(join(base, f), 'utf8').trim()}\n</skill>`) } catch {}
    }
  }
  return chunks.join('\n\n')
}

const URL = process.env.LLM_URL!
const MODEL = process.env.LLM_MODEL!
function arg(n: string, d?: string) { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1] }

const SRC = arg('src')!
const OUT = arg('out', `probe/pipeline/runs/${new Date().toISOString().slice(0, 10)}-reauthor`)!
const LABEL = arg('label', basename(SRC))!
/** Write the old arm and the shared plan, author nothing. Lets a new source
 * schema's conversion be checked before it costs GPU calls. */
const DRY = process.argv.includes('--dry')

const LOOK = { preset: FILM_LOOK_PRESETS[3].id }
const MODE = 'Ref2VA' as const

const spend: Record<string, { calls: number; ms: number; tok: number }> = {}
async function ask(arm: string, label: string, prompt: string, format: Record<string, unknown>, skills: string[] = []): Promise<string> {
  const t0 = Date.now()
  const system = corpus(skills)
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }]
  const body = withQwenReasoningBudget({ id: 'localbox', label: 'box', baseUrl: URL } as any, MODEL,
    { model: MODEL, temperature: 0.35, messages, response_format: format })
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j: any = await res.json()
  const text: string = j.choices?.[0]?.message?.content ?? ''
  const s = (spend[arm] ??= { calls: 0, ms: 0, tok: 0 })
  s.calls++; s.ms += Date.now() - t0; s.tok += j.usage?.completion_tokens ?? 0
  console.log(`    ${text ? '✓' : '✗'} [${arm}] ${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  return text
}

/**
 * A SECOND old schema. `gyantv-pte-01` has no prose `detailedDescription` at
 * all — it carries a structured `shots[]` with `startTime`/`endTime`,
 * `composition`, `action`, `cameraMotion`, `sound` and `dialogue` per shot.
 * That is the richest of the old corpora and the closest ancestor of preset
 * B: it already made direction and per-shot sound design into artifacts.
 *
 * Composed here into the prose H3 expects, faithfully and without adding
 * anything the file did not say. `[Shot 1]` takes no timestamp, by rule; the
 * rest take theirs from `startTime`, which means this corpus yields EXACT
 * shot boundaries rather than boundaries inferred from markers.
 */
function isStructured(d: any): boolean {
  return Array.isArray(d.shots) && d.shots.length > 0 && typeof d.shots[0]?.startTime === 'number'
}

function stamp(sec: number): string {
  const mm = Math.floor(sec / 60), ss = sec - mm * 60
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(3).padStart(6, '0')}`
}

function structuredToText(d: any): string {
  const body: string[] = []
  if (d.style) body.push(String(d.style).trim())
  d.shots.forEach((sh: any, i: number) => {
    const marker = i === 0 ? '[Shot 1]' : `[Shot ${i + 1}] At ${stamp(Number(sh.startTime) || 0)},`
    // The source carries FULLY structured dialogue — `speakerId`, `language`,
    // `exactWords` — and H3 wants `(S1) <d>[Language] words</d>`. An earlier
    // version of this looked for a `line` key, found none, and silently
    // emitted NO dialogue, which then scored the old arm at 0.11-0.43 on the
    // dialogue dimension and made the old corpus look far worse than it is.
    // Read the real keys, and keep the original language rather than
    // translating it away.
    const lines = (sh.dialogue ?? []).map((x: any) => {
      if (typeof x === 'string') return x
      const words = x?.exactWords ?? x?.line ?? x?.text ?? ''
      if (!words) return ''
      const who = x?.speakerId ? `(${x.speakerId}) ` : ''
      const lang = x?.language ? `[${x.language}] ` : ''
      return `${who}<d>${lang}${words}</d>`
    }).filter(Boolean)
    body.push([marker, sh.composition, sh.action,
      sh.cameraMotion ? `Camera: ${sh.cameraMotion}.` : '',
      lines.length ? lines.join(' ') : ''].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim())
  })
  const perShotSound = d.shots.map((sh: any, i: number) => (sh.sound ? `[Shot ${i + 1}] ${sh.sound}` : '')).filter(Boolean)
  const parts: [string, string][] = [
    ['summary', d.summary ?? ''],
    ['detailed_description', body.join(' ')],
    ['overall_soundscape', [d.overallSoundscape ?? '', ...perShotSound].filter(Boolean).join(' ')],
    ['non_diegetic_music', d.nonDiegeticMusic ?? ''],
  ]
  return parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n\n')
}

/** The old file's own fields, under H3's names. Missing sections stay missing.
 *
 * `spokenLinesAudio` is carried through because these files already store it
 * in H3's own form (`<d>[English] (S1) ...</d>`) and dropping it left the old
 * arm with NO dialogue at all — which the judge then scored as a dialogue
 * failure that belonged to this converter, not to the prompt. Same class of
 * mistake as the structured path's `exactWords`. Convert losslessly or do not
 * claim to be comparing. */
function oldPromptText(d: any): string {
  const spoken = d.spokenLinesAudio
    ? String(d.spokenLinesAudio)
    : (d.spokenLines ?? []).map((l: string) => `<d>[English] ${l}</d>`).join(' ')
  const desc = [d.detailedDescription ?? '', spoken].filter(Boolean).join(' ')
  const parts: [string, string][] = [
    ['summary', d.summary ?? ''],
    ['detailed_description', desc],
    ['overall_soundscape', d.overallSoundscape ?? ''],
    ['non_diegetic_music', d.nonDiegeticMusic ?? ''],
  ]
  return parts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n\n')
}

function fillDraft(template: string, story: string, direction: string, acting: string): string {
  return template
    .replace(/\{\{mode\}\}/g, MODE).replace(/\{\{film\}\}/g, describeFilmLook(LOOK))
    .replace(/\{\{direction\}\}/g, direction).replace(/\{\{acting\}\}/g, acting)
    .replace(/\{\{previous\}\}/g, '(none — judge this clip on its own)')
    .replace(/\{\{continuationFrame\}\}/g, '').replace(/\{\{standing\}\}/g, '')
    .replace(/\{\{plates\}\}/g, '').replace(/\{\{story\}\}/g, story)
}

function write(raw: string, path: string, arm: string, planned: number): void {
  let obj: any = null
  try { obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) } catch {}
  if (!obj) { console.log(`    [${arm}] draft JSON parse failed`); return }
  const injected = injectFilmLook(obj, MODE, LOOK)
  const joined = joinH3Sections(JSON.stringify(injected), MODE)
  if (!joined) { console.log(`    [${arm}] a required section came back empty`); return }
  const frags = splitPromptShots(injected.detailed_description ?? '').shots.length
  console.log(`    [${arm}] ${frags} fragments for ${planned} planned shots`)
  writeFileSync(path, joined.prompt, 'utf8')
}

async function main() {
  mkdirSync(join(OUT, 'old'), { recursive: true })
  mkdirSync(join(OUT, 'new-A'), { recursive: true })
  mkdirSync(join(OUT, 'new-B'), { recursive: true })
  mkdirSync(join(OUT, 'plans'), { recursive: true })

  let files = readdirSync(SRC).filter((f) => f.endsWith('.json')).sort()
  // `--latest`: a corpus that versions its scenes (`scene_8.json`,
  // `scene_8.v1.json` ... `scene_8.v7.json`) would otherwise author every
  // draft ever written. Keep the highest version per stem — that is the one
  // the operator actually settled on.
  if (process.argv.includes('--latest')) {
    const best = new Map<string, { v: number; f: string }>()
    for (const f of files) {
      const m = f.match(/^(.*?)(?:\.v(\d+))?\.json$/)
      if (!m) continue
      const stem = m[1], v = Number(m[2] ?? 0)
      const cur = best.get(stem)
      if (!cur || v > cur.v) best.set(stem, { v, f })
    }
    files = [...best.values()].map((b) => b.f).sort()
  }
  console.log(`${LABEL}: ${files.length} prompts · model=${MODEL} · out=${OUT}\n`)

  for (const f of files) {
    const d = JSON.parse(readFileSync(join(SRC, f), 'utf8'))
    const name = `${LABEL}-${f.replace(/\.json$/, '')}`
    const structured = isStructured(d)
    const dd: string = structured ? structuredToText(d).split('detailed_description: ')[1]?.split('\n\n')[0] ?? '' : (d.detailedDescription ?? '')
    if (!dd.trim()) { console.log(`${name}: no prose and no structured shots — skipped`); continue }

    // Plan from the old prompt's own structure. See the header: this favours
    // the old arm, deliberately.
    const oldShots = splitPromptShots(dd).shots
    const duration = Number(d.duration) || 10
    // A structured file states its own shot boundaries, so use them rather
    // than dividing the duration evenly — that is real pacing data the prose
    // corpora simply do not have.
    const approvedShots = structured
      ? d.shots.map((sh: any, i: number) => ({
          index: i + 1,
          summary: String(sh.action || sh.composition || '').replace(/\s+/g, ' ').trim().slice(0, 160),
          seconds: +((Number(sh.endTime) - Number(sh.startTime)) || duration / d.shots.length).toFixed(2),
        }))
      : Array.from({ length: Math.max(1, oldShots.length) }, (_, i) => ({
          index: i + 1,
          summary: (oldShots[i]?.text ?? dd).replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0].slice(0, 160),
          seconds: +(duration / Math.max(1, oldShots.length)).toFixed(2),
        }))
    const n = approvedShots.length
    writeFileSync(join(OUT, 'plans', `${name}.json`), JSON.stringify({
      clipSeconds: duration, hasCharacters: true,
      // From the OLD prompt's brief, so an arm that drops required dialogue
      // is judged on it and fails, rather than escaping the dimension.
      hasDialogue: structured
        ? d.shots.some((sh: any) => (sh.dialogue ?? []).length > 0)
        : (d.spokenLines ?? []).length > 0 || /<d>/.test(dd),
      approvedShots,
    }, null, 2), 'utf8')

    writeFileSync(join(OUT, 'old', `${name}.txt`), structured ? structuredToText(d) : oldPromptText(d), 'utf8')
    console.log(`${name}: ${duration}s, ${n} shot(s) in the old prompt`)

    const story = [
      d.purpose ? `PURPOSE: ${d.purpose}` : '',
      d.summary ? `SUMMARY: ${d.summary}` : '',
      `WHAT HAPPENS IN THIS CLIP:\n${dd}`,
    ].filter(Boolean).join('\n\n')
    const covers = approvedShots.map((s) => `${s.index}. ${s.summary} (${s.seconds}s)`).join('\n')

    if (DRY) { console.log('    (dry — no authoring)\n'); continue }

    write(await ask('A', `${name} draft`, fillDraft(DEFAULT_TEMPLATES.draft, story, '', ''), h3ResponseFormat(MODE), ['h3-prompting']),
      join(OUT, 'new-A', `${name}.txt`), 'A', n)

    const dir = parseDirection(await ask('B', `${name} direction`, fillDirectionTemplate(DIRECTION_TEMPLATE, {
      covers: story, shots: covers, film: describeFilmLook(LOOK), plates: '',
    }), directionResponseFormat(), ['h3-direction']), 1)
    if (dir) console.log(`    [B] ${dir.shots.length} directed · off-vocabulary: ${JSON.stringify(offVocabularyMovements(dir))}`)
    const act = parseActing(await ask('B', `${name} acting`, fillActingTemplate(ACTING_TEMPLATE, {
      covers: story, direction: dir ? directionToPromptBlock(dir) : '', film: describeFilmLook(LOOK), plates: '',
    }), actingResponseFormat(), ['h3-acting']), 1)
    write(await ask('B', `${name} draftDirected`, fillDraft(DEFAULT_TEMPLATES.draftDirected, story,
      dir ? directionToPromptBlock(dir) : '', act ? actingToPromptBlock(act) : ''), h3ResponseFormat(MODE), ['h3-prompting']),
      join(OUT, 'new-B', `${name}.txt`), 'B', n)
    console.log('')
  }

  console.log('=== spend ===')
  for (const [arm, s] of Object.entries(spend)) console.log(`  ${arm}: ${s.calls} calls, ${(s.ms / 1000).toFixed(1)}s, ${s.tok} completion tokens`)
}

main().catch((e) => console.log('FATAL', e))
