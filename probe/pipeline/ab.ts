/**
 * probe/pipeline/ab.ts — author the SAME clips under preset A and preset B,
 * then leave both prompts on disk for `probe/judge/judge.ts` to score.
 *
 * WHY THIS EXISTS. The A/B has been run by eye once (A produced 3 shot
 * markers for 5 approved shots, B produced 5) and that is the whole evidence
 * base for a fork in the pipeline. The judge now gives a number, so the
 * comparison can be repeated and argued with instead of remembered.
 *
 * THE ONE THING THAT MAKES IT A FAIR TEST: both arms author from ONE shared
 * plan. Beats and subdivision run exactly once, and both presets are handed
 * the identical clip, the identical shot list, the identical film look and
 * the identical mode. `DEFAULT_TEMPLATES.draftDirected` is
 * `DEFAULT_TEMPLATES.draft` plus `{{direction}}` and `{{acting}}` and nothing
 * else, so the two arms differ by exactly the two extra calls and the two
 * extra blocks they produce. Re-planning per arm would confound the result
 * with planner variance, and `shots.fragments-match-plan` would be scoring
 * each arm against a different plan.
 *
 * WHAT IT WRITES, per clip, into `--out`:
 *   clipN-A.txt      the six sections joined, film look injected
 *   clipN-B.txt      the same, from the directed path
 *   clipN-plan.json  the shared plan, in the shape `judge.ts --plan` wants
 *
 * ```sh
 * LLM_URL=http://<box>:9000/llama/v1/chat/completions LLM_MODEL=swift-qwen38-27b \
 *   npx tsx probe/pipeline/ab.ts --runtime 30 --out /some/dir
 * ```
 *
 * Costs GPU. The reasoning budget from `withQwenReasoningBudget` is applied
 * to every call, as the app does — without it an earlier run of the sibling
 * smoke probe spent 14,127 completion tokens on direction alone and made
 * preset B look 3.8x over the render budget, which was the harness's fault
 * and not the pipeline's.
 */

import {
  BEAT_LIST_TEMPLATE, fillBeatListTemplate, beatListResponseFormat, parseBeatList,
  allocateBeatSeconds, planSubdivisionWindows,
  SHOT_SUBDIVIDE_TEMPLATE, fillShotSubdivideTemplate, shotSubdivideResponseFormat, parseSubdividedShots,
  groupShotsIntoClips,
} from '../../src/lib/shotList'
import { DIRECTION_TEMPLATE, fillDirectionTemplate, directionResponseFormat, parseDirection, offVocabularyMovements, directionToPromptBlock } from '../../src/lib/direction'
import { ACTING_TEMPLATE, fillActingTemplate, actingResponseFormat, parseActing, actingToPromptBlock } from '../../src/lib/acting'
import { DEFAULT_TEMPLATES } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { splitPromptShots } from '../../src/lib/promptShots'
import { injectFilmLook } from '../../src/lib/filmLookInject'
import { describeFilmLook, FILM_LOOK_PRESETS } from '../../src/lib/filmLook'
import { withQwenReasoningBudget } from '../../src/lib/thinking'

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

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

function arg(n: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? d : process.argv[i + 1]
}
const RUNTIME = Number(arg('runtime', '30'))
// Default under the repo, NOT /tmp. Every prompt this produces is training
// data for the judge rubric and for any later fine-tune, and a scratch dir
// gets wiped. `~/Projects/h3-prompt-eval` learned this the expensive way: its
// `candidates/` was gitignored, so 54 blind-judged prompts are gone and only
// the SCORES survive — ground truth with nothing left to re-judge.
const OUT = arg('out', `probe/pipeline/runs/${new Date().toISOString().slice(0, 10)}-run`)!

/** Per-arm accounting, so "prompt production under render time" stays
 * measurable rather than asserted. */
const spend: Record<string, { calls: number; ms: number; completion: number }> = {}
function note(arm: string, ms: number, completion: number) {
  const s = (spend[arm] ??= { calls: 0, ms: 0, completion: 0 })
  s.calls++; s.ms += ms; s.completion += completion
}

async function ask(arm: string, label: string, prompt: string, format: Record<string, unknown>, skills: string[] = []): Promise<string> {
  const t0 = Date.now()
  const system = corpus(skills)
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  const body = withQwenReasoningBudget(
    { id: 'localbox', label: 'box', baseUrl: URL } as any,
    MODEL,
    { model: MODEL, temperature: 0.35, messages, response_format: format },
  )
  const res = await fetch(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j: any = await res.json()
  const text: string = j.choices?.[0]?.message?.content ?? ''
  const ms = Date.now() - t0
  note(arm, ms, j.usage?.completion_tokens ?? 0)
  console.log(`  ${text ? '✓' : '✗'} [${arm}] ${label}: ${(ms / 1000).toFixed(1)}s, ${j.usage?.completion_tokens ?? '?'} completion tok`)
  return text
}

const PLOT = `Nusrat runs a small tailoring shop in a Surat cloth market. A supplier, Farid, delivers a bolt of raw silk she has already paid for. She unrolls it, and knows at once it is not the cloth she chose — the weave is wrong under her thumb. Farid stands in the doorway and insists it is the same. Neither of them says the word "switched". She names a price for the work that is far below what she would normally charge, and he agrees to it too quickly, which is how they both know he knows.`

const LOOK = { preset: FILM_LOOK_PRESETS[3].id }
const MODE = 'Ref2VA' as const

/** Fill everything both templates share. The two arms differ only by the
 * `direction`/`acting` blocks appended for B. */
function fillDraft(template: string, story: string, direction: string, acting: string): string {
  return template
    .replace(/\{\{mode\}\}/g, MODE)
    .replace(/\{\{film\}\}/g, describeFilmLook(LOOK))
    .replace(/\{\{direction\}\}/g, direction)
    .replace(/\{\{acting\}\}/g, acting)
    .replace(/\{\{previous\}\}/g, '(none — this is the first clip)')
    .replace(/\{\{continuationFrame\}\}/g, '')
    .replace(/\{\{standing\}\}/g, '')
    .replace(/\{\{plates\}\}/g, '')
    .replace(/\{\{story\}\}/g, story)
}

function sectionsToFile(raw: string, path: string, arm: string, planned: number): boolean {
  let sections: any = null
  try { sections = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)) } catch { /* below */ }
  if (!sections) { console.log(`  [${arm}] DRAFT JSON PARSE FAILED`); return false }
  const injected = injectFilmLook(sections, MODE, LOOK)
  const split = splitPromptShots(injected.detailed_description ?? '')
  console.log(`  [${arm}] ${split.shots.length} shot fragments for ${planned} planned shots`)
  // Re-serialise so the REAL joiner does the work, including its own check
  // that no section came back empty — `injectFilmLook` returns the sections
  // object, but `joinH3Sections` is written against the raw model reply.
  const joined = joinH3Sections(JSON.stringify(injected), MODE)
  if (!joined) { console.log(`  [${arm}] a required section came back empty — nothing written`); return false }
  writeFileSync(path, joined.prompt, 'utf8')
  return true
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`model=${MODEL} runtime=${RUNTIME}s out=${OUT}\n`)

  console.log('SHARED PLAN — beats')
  const beatList = parseBeatList(await ask('plan', 'beats', fillBeatListTemplate(BEAT_LIST_TEMPLATE, PLOT), beatListResponseFormat()))
  if (!beatList) { console.log('beat parse failed'); return }
  const allocated = allocateBeatSeconds(beatList.beats, RUNTIME)
  console.log(`  ${beatList.beats.length} beats -> ${allocated.map((b) => b.seconds.toFixed(1)).join(' + ')}s`)

  console.log('SHARED PLAN — subdivide')
  const shots: any[] = []
  for (const b of allocated) {
    for (const w of planSubdivisionWindows(b.seconds)) {
      const parsed = parseSubdividedShots(await ask('plan', `beat ${b.index}`, fillShotSubdivideTemplate(SHOT_SUBDIVIDE_TEMPLATE, {
        spine: beatList.spine, beatCovers: b.covers, targetSeconds: w,
        minShotSeconds: 2, maxShotSeconds: 8, startIndex: shots.length + 1,
        already: shots.length ? shots.map((s) => `${s.index}. ${s.covers}`).join('\n') : '(none yet)',
      }), shotSubdivideResponseFormat()))
      if (!parsed) continue
      for (const s of parsed) shots.push({ ...s, index: shots.length + 1, beatIndex: b.index })
    }
  }
  const groups = groupShotsIntoClips(shots)
  console.log(`  ${shots.length} shots -> ${groups.groups.length} clips: ${groups.groups.map((g: any) => g.seconds.toFixed(1) + 's').join(', ')}\n`)

  const wanted = Number(arg('clips', '2'))
  for (let ci = 0; ci < Math.min(wanted, groups.groups.length); ci++) {
    const g = groups.groups[ci]
    const clipShots = g.shotIndices.map((i: number) => shots[i - 1])
    const covers = clipShots.map((s: any) => s.covers).join(' ')
    const n = ci + 1
    console.log(`CLIP ${n} — ${g.seconds.toFixed(1)}s, shots ${g.shotIndices.join(',')}`)

    writeFileSync(join(OUT, `clip${n}-plan.json`), JSON.stringify({
      clipSeconds: Number(g.seconds.toFixed(2)),
      hasCharacters: true,
      approvedShots: clipShots.map((s: any, i: number) => ({ index: i + 1, summary: s.covers, seconds: s.seconds })),
    }, null, 2), 'utf8')

    // ── ARM A: one call, no direction, no acting.
    const aRaw = await ask('A', `clip ${n} draft`, fillDraft(DEFAULT_TEMPLATES.draft, covers, '', ''), h3ResponseFormat(MODE), ['h3-prompting'])
    sectionsToFile(aRaw, join(OUT, `clip${n}-A.txt`), 'A', clipShots.length)

    // ── ARM B: direction, then acting, then the directed draft.
    const dir = parseDirection(await ask('B', `clip ${n} direction`, fillDirectionTemplate(DIRECTION_TEMPLATE, {
      covers, shots: clipShots.map((s: any) => `${s.index}. ${s.covers} (${s.seconds}s)`).join('\n'),
      film: describeFilmLook(LOOK), plates: '',
    }), directionResponseFormat(), ['h3-direction']), n)
    if (dir) console.log(`  [B] ${dir.shots.length} shots directed · off-vocabulary camera terms: ${JSON.stringify(offVocabularyMovements(dir))}`)

    const act = parseActing(await ask('B', `clip ${n} acting`, fillActingTemplate(ACTING_TEMPLATE, {
      covers, direction: dir ? directionToPromptBlock(dir) : '', film: describeFilmLook(LOOK), plates: '',
    }), actingResponseFormat(), ['h3-acting']), n)

    const bRaw = await ask('B', `clip ${n} draftDirected`, fillDraft(
      DEFAULT_TEMPLATES.draftDirected, covers,
      dir ? directionToPromptBlock(dir) : '', act ? actingToPromptBlock(act) : '',
    ), h3ResponseFormat(MODE), ['h3-prompting'])
    sectionsToFile(bRaw, join(OUT, `clip${n}-B.txt`), 'B', clipShots.length)
    console.log('')
  }

  console.log('=== spend ===')
  for (const [arm, s] of Object.entries(spend)) {
    console.log(`  ${arm}: ${s.calls} calls, ${(s.ms / 1000).toFixed(1)}s, ${s.completion} completion tokens`)
  }
}

main().catch((e) => console.log('FATAL', e))
