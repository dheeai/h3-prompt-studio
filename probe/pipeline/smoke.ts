import {
  BEAT_LIST_TEMPLATE, fillBeatListTemplate, beatListResponseFormat, parseBeatList,
  allocateBeatSeconds, planSubdivisionWindows,
  SHOT_SUBDIVIDE_TEMPLATE, fillShotSubdivideTemplate, shotSubdivideResponseFormat, parseSubdividedShots,
  groupShotsIntoClips, checkRuntimeCeiling, checkThinBrief,
} from '../src/lib/shotList'
import { DIRECTION_TEMPLATE, fillDirectionTemplate, directionResponseFormat, parseDirection, offVocabularyMovements, directionToPromptBlock } from '../src/lib/direction'
import { ACTING_TEMPLATE, fillActingTemplate, actingResponseFormat, parseActing, actingToPromptBlock } from '../src/lib/acting'
import { DEFAULT_TEMPLATES } from '../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../src/lib/schema'
import { splitPromptShots, promptShotIssues } from '../src/lib/promptShots'
import { injectFilmLook } from '../src/lib/filmLookInject'
import { describeFilmLook } from '../src/lib/filmLook'
import { FILM_LOOK_PRESETS } from '../src/lib/filmLook'
import { withQwenReasoningBudget, QWEN_REASONING_BUDGET_DEFAULT } from '../src/lib/thinking'

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The skill corpus each stage gets, mirroring `context.ts`'s STAGE_SKILLS —
 * so this run is faithful to what the app actually sends, not a stripped
 * version of it. The beats and subdivide calls deliberately get NOTHING (see
 * shotList.ts: "No skills, no system prompt — the template is the whole ask"). */
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
const RUNTIME = 60

let calls = 0
let totalMs = 0

async function ask(label: string, prompt: string, format: Record<string, unknown>, skills: string[] = []): Promise<string> {
  const t0 = Date.now()
  const system = corpus(skills)
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  // THE BOUND THE APP APPLIES, and which the first run of this script did not:
  // `reasoning_budget_tokens` + a stop-thinking message, for any model on a
  // local llama.cpp endpoint. Without it direction spent 14,127 completion
  // tokens and the draft 20,005, which is what made preset B look 3.8x over
  // the render budget. That was this harness, not the pipeline.
  const body = withQwenReasoningBudget(
    { id: 'localbox', label: 'box', baseUrl: URL } as any,
    MODEL,
    { model: MODEL, temperature: 0.35, messages, response_format: format },
    QWEN_REASONING_BUDGET_DEFAULT,
  )
  if (calls === 0) console.log(`  (reasoning budget applied: ${JSON.stringify((body as any).reasoning_budget_tokens)} · message: ${JSON.stringify((body as any).reasoning_budget_message)})`)
  const r = await fetch(`${URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  calls++; totalMs += ms
  if (!r.ok) { console.log(`  ✗ ${label}: HTTP ${r.status} ${(await r.text()).slice(0,200)}`); return '' }
  const j: any = await r.json()
  const text = j.choices?.[0]?.message?.content ?? ''
  const fin = j.choices?.[0]?.finish_reason
  console.log(`  ${text ? '✓' : '✗'} ${label}: ${(ms/1000).toFixed(1)}s, ${text.length}b, finish=${fin}, prompt_tok=${j.usage?.prompt_tokens}, completion_tok=${j.usage?.completion_tokens}`)
  return text
}

const PLOT = `Nusrat runs a small tailoring shop in a Surat cloth market. A supplier, Farid, delivers a bolt of raw silk she has already paid for. She unrolls it, and knows at once it is not the cloth she chose — the weave is wrong under her thumb. Farid stands in the doorway and insists it is the same. Neither of them says the word "switched". She names a price for the work that is far below what she would normally charge, and he agrees to it too quickly, which is how they both know he knows.`

const LOOK = { preset: FILM_LOOK_PRESETS[3].id }

async function main() {
  console.log(`model=${MODEL}  runtime=${RUNTIME}s\n`)

  // ── PASS 1: beats
  console.log('PASS 1 — beats')
  const beatsRaw = await ask('beats', fillBeatListTemplate(BEAT_LIST_TEMPLATE, PLOT), beatListResponseFormat())
  const beatList = parseBeatList(beatsRaw)
  if (!beatList) { console.log('  PARSE FAILED. raw:', beatsRaw.slice(0, 500)); return }
  console.log(`  parsed: ${beatList.beats.length} beats · spine: ${beatList.spine.slice(0,90)}`)
  for (const b of beatList.beats) console.log(`    beat ${b.index} (w=${b.weight}) ${b.covers.slice(0,80)}`)

  const allocated = allocateBeatSeconds(beatList.beats, RUNTIME)
  const sum = +allocated.reduce((n, b) => n + b.seconds, 0).toFixed(3)
  console.log(`  allocated: ${allocated.map((b) => b.seconds.toFixed(1)).join(' + ')} = ${sum}s (exact: ${sum === RUNTIME})`)
  const thin = checkThinBrief(beatList.beats, RUNTIME)
  console.log(`  thin brief: ${JSON.stringify(thin)}`)

  // ── PASS 2: subdivide every beat
  console.log('\nPASS 2 — subdivide')
  const shots: any[] = []
  for (const b of allocated) {
    const windows = planSubdivisionWindows(b.seconds)
    for (const w of windows) {
      const raw = await ask(`beat ${b.index} (${w.toFixed(1)}s target)`, fillShotSubdivideTemplate(SHOT_SUBDIVIDE_TEMPLATE, {
        spine: beatList.spine, beatCovers: b.covers, targetSeconds: w,
        minShotSeconds: 2, maxShotSeconds: 8, startIndex: shots.length + 1,
        already: shots.length ? shots.map((s) => `${s.index}. ${s.covers}`).join('\n') : '(none yet)',
      }), shotSubdivideResponseFormat())
      const parsed = parseSubdividedShots(raw)
      if (!parsed) { console.log(`    PARSE FAILED for beat ${b.index}. raw: ${raw.slice(0,300)}`); continue }
      const got = +parsed.reduce((n, s) => n + s.seconds, 0).toFixed(2)
      console.log(`    ${parsed.length} shots, ${got}s vs ${w.toFixed(1)}s target (off by ${(got - w).toFixed(2)}s)`)
      for (const s of parsed) shots.push({ ...s, index: shots.length + 1, beatIndex: b.index })
    }
  }
  const ceiling = checkRuntimeCeiling(shots, RUNTIME)
  console.log(`  TOTAL: ${shots.length} shots, ${ceiling.totalSeconds}s of ${RUNTIME}s · under=${ceiling.significantlyUnder} over=${ceiling.overBySeconds}`)
  const groups = groupShotsIntoClips(shots)
  console.log(`  grouped into ${groups.groups.length} clips: ${groups.groups.map((g: any) => g.seconds.toFixed(1) + 's').join(', ')}`)
  if (groups.issues?.length) console.log('  grouping issues:', groups.issues)

  // ── PRESET B, clip 1: direction
  const g1 = groups.groups[0]
  const clipShots = g1.shotIndices.map((i: number) => shots[i - 1])
  const covers = clipShots.map((s: any) => s.covers).join(' ')
  console.log(`\nPRESET B — clip 1 (${g1.seconds.toFixed(1)}s, shots ${g1.shotIndices.join(',')})`)

  const dirRaw = await ask('direction', fillDirectionTemplate(DIRECTION_TEMPLATE, {
    covers, shots: clipShots.map((s: any) => `${s.index}. ${s.covers} (${s.seconds}s)`).join('\n'),
    film: describeFilmLook(LOOK), plates: '',
  }), directionResponseFormat(), ['h3-direction'])
  const dir = parseDirection(dirRaw, 1)
  if (!dir) { console.log('  DIRECTION PARSE FAILED. raw:', dirRaw.slice(0,500)) }
  else {
    console.log(`  ${dir.shots.length} shots directed · off-vocabulary camera terms: ${JSON.stringify(offVocabularyMovements(dir))}`)
    for (const s of dir.shots) console.log(`    [${s.index}] ${s.cameraMovement} | ${s.optics.slice(0,44)} | 3 details filled: ${[s.environmentalPressure,s.physicalMicroAction,s.thirdConcreteFact].filter(Boolean).length}/3`)
    const empty = Object.entries(dir).filter(([k,v]) => typeof v === 'string' && !v).map(([k]) => k)
    console.log(`  empty clip-level fields: ${empty.length ? empty.join(', ') : 'none'}`)
  }

  // ── acting
  const actRaw = await ask('acting', fillActingTemplate(ACTING_TEMPLATE, {
    covers, direction: dir ? directionToPromptBlock(dir) : '', film: describeFilmLook(LOOK), plates: '',
  }), actingResponseFormat(), ['h3-acting'])
  const act = parseActing(actRaw, 1)
  if (!act) console.log('  ACTING PARSE FAILED. raw:', actRaw.slice(0,400))
  else for (const p of act.performances)
    console.log(`    ${p.characterId}: obj="${p.objective.slice(0,50)}" tactic="${p.tactic.slice(0,28)}" eyes=${p.eyeLife ? 'yes' : 'MISSING'}`)

  // ── directed draft
  const draftPrompt = DEFAULT_TEMPLATES.draftDirected
    .replace(/\{\{mode\}\}/g, 'Ref2VA').replace(/\{\{film\}\}/g, describeFilmLook(LOOK))
    .replace(/\{\{direction\}\}/g, dir ? directionToPromptBlock(dir) : '')
    .replace(/\{\{acting\}\}/g, act ? actingToPromptBlock(act) : '')
    .replace(/\{\{previous\}\}/g, '(none — this is the first clip)')
    .replace(/\{\{continuationFrame\}\}/g, '').replace(/\{\{standing\}\}/g, '')
    .replace(/\{\{plates\}\}/g, '').replace(/\{\{story\}\}/g, covers)
  const draftRaw = await ask('draftDirected', draftPrompt, h3ResponseFormat('Ref2VA'), ['h3-prompting'])
  let sections: any = null
  try { sections = JSON.parse(draftRaw.slice(draftRaw.indexOf('{'), draftRaw.lastIndexOf('}') + 1)) } catch (e) { console.log('  DRAFT JSON PARSE FAILED') }
  if (sections) {
    const want = ['subject_definitions','summary','retention_analysis','detailed_description','overall_soundscape','non_diegetic_music']
    console.log(`  sections present: ${want.filter((w) => sections[w]).length}/6 · missing: ${want.filter((w) => !sections[w]).join(', ') || 'none'}`)
    const injected = injectFilmLook(sections, 'Ref2VA', LOOK)
    const hasLook = injected.detailed_description.includes(FILM_LOOK_PRESETS[3].description)
    console.log(`  film look injected into detailed_description: ${hasLook}`)
    const split = splitPromptShots(injected.detailed_description)
    console.log(`  prompt splits into ${split.shots.length} shot fragments (plan had ${clipShots.length})`)
    console.log(`  shot-marker issues: ${JSON.stringify(promptShotIssues(split))}`)
    console.log(`\n  --- detailed_description, first 600 chars ---\n${injected.detailed_description.slice(0,600)}`)
  }

  console.log(`\n=== ${calls} calls, ${(totalMs/1000).toFixed(1)}s total authoring ===`)
}
main().catch((e) => console.log('FATAL', e))
