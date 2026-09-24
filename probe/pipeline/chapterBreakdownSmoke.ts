/**
 * probe/pipeline/chapterBreakdownSmoke.ts — one live call of the
 * `structured-json` breakdown planner (`lib/chapterBreakdown.ts`) against
 * the real box, on a short invented 2-clip (~30s) story. Reports wall time,
 * completion tokens, and whether the deterministic checks pass, and saves
 * the raw + parsed JSON next to this script.
 *
 * ```sh
 * LLM_URL=http://<box>:9000/llama/v1 \
 *   LLM_MODEL=swift-uncensored-27b \
 *   npx tsx probe/pipeline/chapterBreakdownSmoke.ts
 * ```
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAPTER_BREAKDOWN_TEMPLATE, chapterBreakdownResponseFormat, checkChapterBreakdown,
  fillChapterBreakdownTemplate, formatClipRawAsk, parseChapterBreakdown,
} from '../../src/lib/chapterBreakdown'
import { withQwenReasoningBudget, QWEN_REASONING_BUDGET_DEFAULT } from '../../src/lib/thinking'

const URL = process.env.LLM_URL!
const MODEL = process.env.LLM_MODEL!

// Two clips, ~30s — small enough to read by eye, big enough to exercise the
// dialogue-in-its-own-shot and forward-pull rules.
const CHAPTER = `Nusrat runs a small tailoring shop in a Surat cloth market. A supplier, Farid, delivers a bolt of raw silk she has already paid for. She unrolls it on the counter and knows at once, under her thumb, that the weave is wrong — not the cloth she chose. Farid stands in the doorway and insists it is the same bolt. Neither of them says the word "switched." Nusrat folds the cloth back over, meets his eyes, and names a price for the work far below what she would normally charge. Farid agrees to it too quickly, which is how they both know he knows.`

async function main() {
  if (!URL || !MODEL) {
    console.error('set LLM_URL and LLM_MODEL first')
    process.exit(1)
  }
  const user = fillChapterBreakdownTemplate(CHAPTER_BREAKDOWN_TEMPLATE, CHAPTER)
  const format = chapterBreakdownResponseFormat()
  const body = withQwenReasoningBudget(
    { id: 'localbox', label: 'box', baseUrl: URL } as any,
    MODEL,
    { model: MODEL, temperature: 0.35, messages: [{ role: 'user', content: user }], response_format: format, max_tokens: 12000 },
    QWEN_REASONING_BUDGET_DEFAULT,
  )
  console.log(`model=${MODEL} url=${URL}`)
  console.log(`reasoning_budget_tokens=${JSON.stringify((body as any).reasoning_budget_tokens)}`)

  const t0 = Date.now()
  const r = await fetch(`${URL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ms = Date.now() - t0
  if (!r.ok) {
    console.error(`HTTP ${r.status}: ${(await r.text()).slice(0, 1000)}`)
    process.exit(1)
  }
  const j: any = await r.json()
  const text = j.choices?.[0]?.message?.content ?? ''
  const finish = j.choices?.[0]?.finish_reason
  const usage = j.usage ?? {}
  console.log(`wall time: ${(ms / 1000).toFixed(1)}s`)
  console.log(`finish_reason: ${finish}`)
  console.log(`prompt_tokens=${usage.prompt_tokens} completion_tokens=${usage.completion_tokens}`)
  console.log(`reply length: ${text.length} chars`)

  const outDir = join(import.meta.dirname, 'out')
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'chapter-breakdown-raw.json'), JSON.stringify(j, null, 2))

  const parsed = parseChapterBreakdown(text)
  if (!parsed) {
    console.error('PARSE FAILED. raw text:')
    console.error(text.slice(0, 2000))
    process.exit(1)
  }
  writeFileSync(join(outDir, 'chapter-breakdown-parsed.json'), JSON.stringify(parsed, null, 2))

  console.log(`\nparsed: chapter="${parsed.chapter}", ${parsed.clips.length} clip(s)`)
  for (const clip of parsed.clips) {
    console.log(`  clip ${clip.clip} — ${clip.shots.length} shots, beat: ${clip.beat.slice(0, 90)}`)
  }

  const issues = checkChapterBreakdown(parsed)
  console.log(`\ndeterministic checks: ${issues.length === 0 ? 'ALL PASS' : `${issues.length} issue(s)`}`)
  for (const i of issues) console.log(`  - ${i}`)

  console.log('\nraw-ask text per clip (what would go into clips_json[i].prompt):')
  for (const clip of parsed.clips) {
    console.log(`\n--- clip ${clip.clip} ---`)
    console.log(formatClipRawAsk(clip))
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
