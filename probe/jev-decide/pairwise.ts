/**
 * probe/jev-decide/pairwise.ts — ask the judge WHICH OF TWO is better,
 * instead of scoring each alone and subtracting.
 *
 * WHY. Measured 2026-09-19: on four B-vs-C pairs Jev ranked the
 * correctly-rendered arm above the other 4/4, while absolute thresholds on
 * the same answers agreed with the render only ~half the time. It is reliable
 * about WHICH IS BETTER and much less so about HOW GOOD — a reranker's
 * signature. The existing rubric leans entirely on the weak axis: it produces
 * absolute per-dimension scores which are then compared by subtracting means.
 *
 * THE CASE THAT DECIDES IT. On `gyantv-scene_9` absolute scoring gave preset
 * C a +0.115 margin; the founder watched both renders at matched seed and
 * preferred B, because C put the speaker's eyes on the phone. If pairwise
 * flips that call, the rubric is the wrong shape rather than merely noisy.
 *
 * POSITION BIAS is the classic failure of any judge asked to compare, so
 * every pair runs in BOTH orders and a verdict only counts when the two
 * agree. A judge that always picks "first" would otherwise look decisive.
 *
 * Uses prompts already on disk — nothing is re-authored.
 */
import { readFileSync, existsSync } from 'node:fs'
const KEY = process.env.LLM_JUDGE_API_KEY
if (!KEY) { console.error('LLM_JUDGE_API_KEY is not set'); process.exit(1) }
const URL = 'https://openrouter.ai/api/alpha/decisions'
const R = 'probe/gepa/runs/2026-09-19T13-37-05-426Z'

const CASES = ['sakhubai-scene_4','gyantv-scene_9.v7','gyantv-scene_6.v5','gyantv-scene_4.v5','veyra-proof-payoff','gyantv-scene_3.v5','gyantv-scene_11.v8']

/** Each asks which of the two is better; the option keys are positional so
 * the same question works in either order. */
const DIMENSIONS: Record<string, string> = {
  direction: 'Which prompt makes clearer what the driving character wants and what physically stops them?',
  acting: 'Which prompt conveys behaviour through observable physical action rather than naming emotions?',
  camera: 'Which prompt states camera work more concretely — position, movement, and what the camera follows?',
  gaze: 'In which prompt is a speaking character\'s gaze better placed — on the person addressed rather than on an object in their hands?',
  sound: 'Which prompt ties its sound to specific visible events rather than describing a mood?',
  overall: 'Which prompt would produce the better film?',
}

function questions() {
  const q: Record<string, unknown> = {}
  for (const [k, ask] of Object.entries(DIMENSIONS)) {
    q[k] = { type: 'choice', instructions: ask,
      criteria: { first: 'The prompt labelled FIRST is better on this.', second: 'The prompt labelled SECOND is better on this.' } }
  }
  return q
}

async function compare(a: string, b: string) {
  const state = `FIRST PROMPT:\n${a}\n\n====\n\nSECOND PROMPT:\n${b}`
  const r = await fetch(URL, { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: '~typesafe/jev-latest', questions: questions() }) })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return (await r.json()).answers as Record<string, { choice: string; confidence: number }>
}

async function main() {
  const tally: Record<string, { c: number; b: number; incons: number }> = {}
  for (const k of Object.keys(DIMENSIONS)) tally[k] = { c: 0, b: 0, incons: 0 }

  for (const label of CASES) {
    const cPath = `${R}/preset-c-heldout/${label}.txt`, bPath = `${R}/preset-b-heldout/${label}.txt`
    if (!existsSync(cPath) || !existsSync(bPath)) continue
    const C = readFileSync(cPath, 'utf8'), B = readFileSync(bPath, 'utf8')
    // both orders: C first, then B first
    const [cFirst, bFirst] = await Promise.all([compare(C, B), compare(B, C)])
    const line: string[] = []
    for (const k of Object.keys(DIMENSIONS)) {
      const w1 = cFirst[k].choice === 'first' ? 'C' : 'B'
      const w2 = bFirst[k].choice === 'first' ? 'B' : 'C'
      if (w1 !== w2) { tally[k].incons++; line.push(`${k}=?`) }
      else { tally[k][w1 === 'C' ? 'c' : 'b']++; line.push(`${k}=${w1}`) }
    }
    console.log(`  ${label.padEnd(20)} ${line.join('  ')}`)
  }
  console.log('\n  (? = the two orders disagreed — position bias, verdict discarded)\n')
  console.log('  dimension     C wins  B wins  inconsistent')
  for (const [k, t] of Object.entries(tally)) {
    console.log(`  ${k.padEnd(12)}  ${String(t.c).padStart(4)}  ${String(t.b).padStart(6)}  ${String(t.incons).padStart(10)}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
