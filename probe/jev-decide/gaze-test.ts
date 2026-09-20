/**
 * probe/jev-decide/gaze-test.ts — can a System One model make the DECISIONS
 * an H3 prompt needs, rather than only score finished prose?
 *
 * The proposal is to let Jev pick the enumerable choices (camera term, shot
 * size, gaze target, screen treatment) and leave an LLM only the prose. This
 * tests the premise on the two decisions we have GROUND TRUTH for.
 *
 * WHY NOT CAMERA. The obvious test — agreement with the human corpus on
 * camera movement — is dead on arrival: all 19 shots in `gyantv-pte-01`
 * chose `Static Shot`, so a model that always answers "Static Shot" scores
 * 100% and we learn nothing.
 *
 * RESULT, when read correctly. Pairwise, Jev ranked the correctly-rendered
 * arm above the other 4/4 on gaze and 3/4 (+1 tie) on exclusion, and the one
 * wrong screen call came back at confidence 0.36 while every correct call sat
 * at 0.93-1.00. The FIRST scorer written here thresholded each prompt at 0.5
 * independently and reported 5/8, 4/8, 4/8 — indistinguishable from chance.
 * The signal was ordinal the whole time. Do not re-introduce an absolute
 * threshold: this model is reliable about WHICH IS BETTER and much less so
 * about HOW GOOD.
 *
 * WHAT WE DO HAVE. Four B-vs-C pairs rendered at matched seed and watched by
 * the founder. On `gyantv-scene_9` preset C put the speaker's eyes on the
 * phone; preset B put them on the listener, and B was preferred. Across all
 * three gyantv pairs C described screen CONTENT and rendered the phone turned
 * to camera, while B described screen LIGHT and it stayed in the hand.
 *
 * So for these eight prompts we know which one is RIGHT, from the picture
 * rather than from a rubric. If Jev can separate them, it can make the
 * decision. If it cannot, the architecture does not survive its first test.
 */
import { readFileSync } from 'node:fs'
const KEY = process.env.LLM_JUDGE_API_KEY
if (!KEY) { console.error('LLM_JUDGE_API_KEY is not set'); process.exit(1) }
const URL = 'https://openrouter.ai/api/alpha/decisions'
const R = 'probe/gepa/runs/2026-09-19T13-37-05-426Z'

/** label -> [preset C path, preset B path]; B is the arm that rendered right. */
const PAIRS: [string, string][] = [
  ['gyantv-scene_9.v7', 'gyantv-scene_9.v7'],
  ['gyantv-scene_6.v5', 'gyantv-scene_6.v5'],
  ['gyantv-scene_3.v5', 'gyantv-scene_3.v5'],
  ['veyra-proof-payoff', 'veyra-proof-payoff'],
].map(([a]) => [a, a] as [string, string])

const QUESTIONS = {
  gaze_on_addressee: {
    type: 'noul',
    instructions: 'When a character in this prompt speaks while holding an object, does the prompt place their gaze on the person they are addressing?',
    criteria: {
      true: 'The speaker\'s gaze is placed on the other person\'s face.',
      false: 'The speaker\'s gaze is on the held object, on a screen, or is not placed at all.',
    },
  },
  object_excluded_by_name: {
    type: 'noul',
    instructions: 'Does the prompt explicitly state that a character is NOT looking at the object in their hands?',
    criteria: {
      true: 'The prompt names the held object and rules it out as a gaze target.',
      false: 'The held object is never excluded as a gaze target.',
    },
  },
  screen_treatment: {
    type: 'choice',
    instructions: 'How does this prompt treat the phone or device screen?',
    criteria: {
      light_on_face: 'The screen is described by the light or glow it casts, not by what is displayed.',
      readable_content: 'The screen is described by what is displayed on it — an interface, a number, a progress bar.',
      not_in_frame: 'No screen is described at all.',
    },
  },
} as const

async function ask(state: string) {
  const r = await fetch(URL, { method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model: '~typesafe/jev-latest', questions: QUESTIONS }) })
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`)
  return (await r.json()) as any
}

async function main() {
  console.log('GROUND TRUTH: preset B rendered correctly, preset C did not.\n')
  let gazeOk = 0, exclOk = 0, screenOk = 0, n = 0
  for (const [label] of PAIRS) {
    for (const arm of ['b', 'c'] as const) {
      const dir = arm === 'b' ? 'preset-b-heldout' : 'preset-c-heldout'
      let text: string
      try { text = readFileSync(`${R}/${dir}/${label}.txt`, 'utf8') } catch { continue }
      const j = await ask(text)
      const a = j.answers
      const gaze = a.gaze_on_addressee.noul
      const excl = a.object_excluded_by_name.noul
      const screen = a.screen_treatment.choice
      const conf = a.screen_treatment.confidence
      console.log(`${label.padEnd(20)} ${arm.toUpperCase()}  gaze=${gaze.toFixed(2)}  excluded=${excl.toFixed(2)}  screen=${screen} (conf ${conf.toFixed(2)})`)
      // scoring against what the render showed
      if (arm === 'b') { gazeOk += gaze > 0.5 ? 1 : 0; exclOk += excl > 0.5 ? 1 : 0; screenOk += screen === 'light_on_face' ? 1 : 0 }
      else { gazeOk += gaze <= 0.5 ? 1 : 0; exclOk += excl <= 0.5 ? 1 : 0; screenOk += screen === 'readable_content' ? 1 : 0 }
      n++
    }
    console.log('')
  }
  console.log(`agreement with what the render showed, over ${n} prompts:`)
  console.log(`  gaze on addressee   ${gazeOk}/${n}`)
  console.log(`  object excluded     ${exclOk}/${n}`)
  console.log(`  screen treatment    ${screenOk}/${n}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
