/**
 * probe/gepa/compare-b.ts — run preset B on a named subset of the trainset,
 * so preset C can be compared against it on the SAME cases, the SAME model
 * and the SAME server configuration.
 *
 * The corpus comparison put B at 0.698, but that was `swift-qwen38-27b` over
 * all 19 cases. C's held-out 0.760 is `swift-uncensored-27b` over 7. Those
 * two numbers cannot be put in a table together, and doing so would be the
 * easiest possible way to claim a result that is not there.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DIRECTION_TEMPLATE, fillDirectionTemplate, directionResponseFormat, parseDirection, directionToPromptBlock } from '../../src/lib/direction'
import { ACTING_TEMPLATE, fillActingTemplate, actingResponseFormat, parseActing, actingToPromptBlock } from '../../src/lib/acting'
import { DEFAULT_TEMPLATES } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { injectFilmLook } from '../../src/lib/filmLookInject'
import { describeFilmLook, FILM_LOOK_PRESETS } from '../../src/lib/filmLook'
import { withQwenReasoningBudget } from '../../src/lib/thinking'
import { buildJudgeRequest, scoreJudge, weightedTotal } from '../../src/lib/judge'
import type { JudgeContext, ScopedAnswers, SystemOneResponse } from '../../src/lib/judge'
import { buildFullRubric } from '../../src/lib/judgeRubric'
import { TASK_MODEL, taskEndpoint } from './models'
import { readdirSync } from 'node:fs'

const LOOK = { preset: FILM_LOOK_PRESETS[3].id }
const MODE = 'Ref2VA' as const
const JUDGE_URL = 'https://openrouter.ai/api/alpha/decisions'
const JUDGE_MODEL = '~typesafe/jev-latest'

function corpus(dirs: string[]): string {
  const out: string[] = []
  for (const d of dirs) {
    const base = join('public/skills', d)
    const files = ['SKILL.md']
    try { for (const f of readdirSync(join(base, 'references'))) files.push(join('references', f)) } catch {}
    for (const f of files) { try { out.push(readFileSync(join(base, f), 'utf8')) } catch {} }
  }
  return out.join('\n\n')
}

async function ask(prompt: string, format: Record<string, unknown>, skills: string[]): Promise<string> {
  const sys = corpus(skills)
  const body = withQwenReasoningBudget({ id: 'box', label: 'box', baseUrl: taskEndpoint() } as any, TASK_MODEL, {
    model: TASK_MODEL, temperature: 0.35, response_format: format,
    messages: sys ? [{ role: 'system', content: sys }, { role: 'user', content: prompt }] : [{ role: 'user', content: prompt }],
  })
  const r = await fetch(taskEndpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return (await r.json() as any).choices?.[0]?.message?.content ?? ''
}

async function judge(ctx: JudgeContext): Promise<number | null> {
  const rubric = buildFullRubric(ctx)
  const responses: ScopedAnswers[] = []
  for (const s of buildJudgeRequest(ctx, rubric, JUDGE_MODEL)) {
    const r = await fetch(JUDGE_URL, { method: 'POST',
      headers: { Authorization: `Bearer ${process.env.LLM_JUDGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(s.request) })
    if (!r.ok) throw new Error(`judge ${r.status}`)
    responses.push({ scope: s.scope, shotIndex: s.shotIndex, answers: (await r.json() as SystemOneResponse).answers })
  }
  return weightedTotal(scoreJudge(ctx, rubric, responses))
}

function fill(t: string, story: string, direction: string, acting: string): string {
  return t.replace(/\{\{mode\}\}/g, MODE).replace(/\{\{film\}\}/g, describeFilmLook(LOOK))
    .replace(/\{\{direction\}\}/g, direction).replace(/\{\{acting\}\}/g, acting)
    .replace(/\{\{previous\}\}/g, '(none — judge this clip on its own)')
    .replace(/\{\{continuationFrame\}\}/g, '').replace(/\{\{standing\}\}/g, '')
    .replace(/\{\{plates\}\}/g, '').replace(/\{\{story\}\}/g, story)
}

async function main() {
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? undefined : process.argv[i + 1] }
  const cases = JSON.parse(readFileSync(arg('trainset') ?? 'probe/gepa/trainset.json', 'utf8')) as any[]
  const only = new Set((arg('labels') ?? '').split(',').filter(Boolean))
  const out = arg('out') ?? 'probe/gepa/runs/preset-b-heldout'
  mkdirSync(out, { recursive: true })
  const picked = cases.filter((c) => only.has(c.label))
  console.log(`preset B on ${picked.length} cases · model=${TASK_MODEL}\n`)
  const scores: [string, number | null][] = []
  for (const c of picked) {
    const covers = c.plan.approvedShots.map((s: any) => `${s.index}. ${s.summary} (${s.seconds}s)`).join('\n')
    const dir = parseDirection(await ask(fillDirectionTemplate(DIRECTION_TEMPLATE, {
      covers: c.story, shots: covers, film: describeFilmLook(LOOK), plates: '' }), directionResponseFormat(), ['h3-direction']), 1)
    const act = parseActing(await ask(fillActingTemplate(ACTING_TEMPLATE, {
      covers: c.story, direction: dir ? directionToPromptBlock(dir) : '', film: describeFilmLook(LOOK), plates: '' }), actingResponseFormat(), ['h3-acting']), 1)
    const raw = await ask(fill(DEFAULT_TEMPLATES.draftDirected, c.story,
      dir ? directionToPromptBlock(dir) : '', act ? actingToPromptBlock(act) : ''), h3ResponseFormat(MODE), ['h3-prompting'])
    let score: number | null = 0
    let promptText = ''
    try {
      const obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
      const joined = joinH3Sections(JSON.stringify(injectFilmLook(obj, MODE, LOOK)), MODE)
      if (joined) { promptText = joined.prompt; score = await judge({ promptText, mode: MODE, ...c.plan }) }
    } catch { score = 0 }
    if (promptText) writeFileSync(join(out, `${c.label}.txt`), promptText, 'utf8')
    scores.push([c.label, score])
    console.log(`  ${c.label.padEnd(24)} ${score === null ? ' n/a ' : score.toFixed(3)}`)
  }
  const vals = scores.map(([, s]) => s).filter((s): s is number => s !== null)
  console.log(`\npreset B mean over ${vals.length}: ${(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)}`)
  writeFileSync(join(out, 'scores.json'), JSON.stringify(scores, null, 2), 'utf8')
}
main().catch((e) => { console.error(e); process.exit(1) })
