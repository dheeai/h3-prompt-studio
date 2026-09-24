/**
 * probe/pipeline/draftRewriterSmoke.ts — one live call PER CLIP of the new
 * Studio writer stage (`draftRewriter`, preset D "Raw ask") against the real
 * box, over the 3 clips already saved by `chapterBreakdownSmoke.ts`. Builds
 * the exact request `state.tsx`'s `run()` would build for this stage
 * (`DEFAULT_REWRITE_SYSTEM_PROMPT` as the system message, `DEFAULT_TEMPLATES
 * .draftRewriter` filled with this clip's raw ask + the PREVIOUS clip's raw
 * ask + film context, `h3ResponseFormat('Ref2VA')` as the schema), then runs
 * `lint.ts`'s deterministic check on the result — the same two steps
 * `joinH3Sections`/`lint` would run inside the app. Reports wall time and
 * completion tokens per clip, and saves each prompt.
 *
 * ```sh
 * LLM_URL=http://<box>:9000/llama/v1 \
 *   LLM_MODEL=swift-uncensored-27b \
 *   npx tsx probe/pipeline/draftRewriterSmoke.ts --clips probe/pipeline/out/chapter-breakdown-parsed.json
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_TEMPLATES, continuationFrameBlock, durationBlock, filmBlock, fillTemplateWithDuration, platesBlock } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { lint } from '../../src/lib/lint'
import { DEFAULT_REWRITE_SYSTEM_PROMPT } from '../../src/lib/rewriteSystemPrompt'
import { formatClipRawAsk } from '../../src/lib/chapterBreakdown'
import type { ChapterBreakdown, ChapterBreakdownClip } from '../../src/lib/chapterBreakdown'
import { framesForSeconds } from '../../src/lib/geometry'
import { withQwenReasoningBudget, QWEN_REASONING_BUDGET_DEFAULT } from '../../src/lib/thinking'
import type { FilmContext } from '../../src/lib/types'

const URL = process.env.LLM_URL!
const MODEL = process.env.LLM_MODEL!

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

function roleForPosition(i: number, n: number): FilmContext['role'] {
  if (n <= 1) return 'standalone'
  if (i === 0) return 'opening'
  if (i === n - 1) return 'closing'
  return 'rising'
}

async function callOne(clip: ChapterBreakdownClip, previous: ChapterBreakdownClip | undefined, chapter: string, i: number, n: number) {
  const seconds = clip.shots.reduce((sum, s) => sum + s.seconds, 0)
  const frames = framesForSeconds(seconds)
  const currentRawAsk = formatClipRawAsk(clip)
  const previousRawAsk = previous ? formatClipRawAsk(previous) : undefined

  const film: FilmContext = { role: roleForPosition(i, n), spine: chapter, precedes: '', follows: clip.forwardPull, covers: currentRawAsk }

  const user = fillTemplateWithDuration(DEFAULT_TEMPLATES.draftRewriter, {
    duration: durationBlock(seconds, frames),
    current: currentRawAsk,
    previous: previousRawAsk,
    film: filmBlock(film),
    plates: platesBlock([]),
    continuationFrame: continuationFrameBlock(false),
  })

  const format = h3ResponseFormat('Ref2VA')
  const body = withQwenReasoningBudget(
    { id: 'localbox', label: 'box', baseUrl: URL } as any,
    MODEL,
    { model: MODEL, temperature: 0.35, messages: [{ role: 'system', content: DEFAULT_REWRITE_SYSTEM_PROMPT }, { role: 'user', content: user }], response_format: format, max_tokens: 12000 },
    QWEN_REASONING_BUDGET_DEFAULT,
  )

  console.log(`\n=== clip ${clip.clip} (${seconds}s) ===`)
  const t0 = Date.now()
  const r = await fetch(`${URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const ms = Date.now() - t0
  if (!r.ok) {
    console.error(`  HTTP ${r.status}: ${(await r.text()).slice(0, 1000)}`)
    return null
  }
  const j: any = await r.json()
  const text = j.choices?.[0]?.message?.content ?? ''
  const usage = j.usage ?? {}
  console.log(`  wall time: ${(ms / 1000).toFixed(1)}s`)
  console.log(`  finish_reason: ${j.choices?.[0]?.finish_reason}`)
  console.log(`  prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}`)

  const schemaResult = joinH3Sections(text, 'Ref2VA')
  if (!schemaResult) {
    console.error('  COULD NOT JOIN SIX SECTIONS. raw text:')
    console.error(text.slice(0, 1500))
    return { clip: clip.clip, ms, usage, prompt: null }
  }
  const findings = lint(schemaResult.prompt, 'Ref2VA')
  console.log(`  lint: ${findings.length === 0 ? 'CLEAN' : `${findings.length} finding(s)`}`)
  for (const f of findings) console.log(`    [${f.severity}] ${f.title}: ${f.detail.slice(0, 140)}`)

  return { clip: clip.clip, ms, usage, prompt: schemaResult.prompt, explanation: schemaResult.explanation, findings }
}

async function main() {
  const clipsFile = arg('clips')
  if (!URL || !MODEL || !clipsFile) {
    console.error('usage: LLM_URL=... LLM_MODEL=... npx tsx probe/pipeline/draftRewriterSmoke.ts --clips <chapter-breakdown-parsed.json>')
    process.exit(1)
  }
  const breakdown = JSON.parse(readFileSync(clipsFile, 'utf8')) as ChapterBreakdown
  const results: any[] = []
  for (let i = 0; i < breakdown.clips.length; i++) {
    const result = await callOne(breakdown.clips[i], breakdown.clips[i - 1], breakdown.chapter, i, breakdown.clips.length)
    results.push(result)
  }

  const outDir = join(import.meta.dirname, 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'draft-rewriter-results.json'), JSON.stringify(results, null, 2))

  console.log('\n=== summary ===')
  for (const r of results) {
    if (!r) continue
    console.log(`clip ${r.clip}: ${(r.ms / 1000).toFixed(1)}s, ${r.usage.completion_tokens} completion tokens, ${r.prompt ? (r.findings?.length ?? 0) + ' lint finding(s)' : 'PARSE FAILED'}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
