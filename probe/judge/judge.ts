/**
 * probe/judge/judge.ts — score one rendered H3 prompt against the GEPA
 * rubric, via Jev.
 *
 * The only place in this codebase a `judge.ts`/`judgeRubric.ts` request
 * actually leaves the process — both of those files are pure. This script
 * reads a prompt off disk, builds the scoped request(s) `buildJudgeRequest`
 * produces, sends each to `POST https://api.typesafe.ai/v1/systemone`, and
 * prints the resulting per-dimension vector plus the GEPA feedback string.
 *
 * THERE IS NO API KEY ON THIS MACHINE. This script makes a REAL network call
 * and refuses to run without `TYPESAFE_API_KEY` — it does not fall back to a
 * fake response, and nobody should hand-simulate one either; a made-up
 * `answers` map would validate the plumbing against nothing but itself.
 *
 * ```sh
 * TYPESAFE_API_KEY=... npx tsx probe/judge/judge.ts <prompt-file> [mode]
 * ```
 *
 * `mode` is any `H3Mode` (default `Ref2VA`). This probe has no plan file to
 * read `approvedShots`/`clipSeconds` from, so it judges the prompt alone —
 * every `'shot'`-scoped and per-shot-fan-out question then has nothing to
 * pair against and is skipped by `buildJudgeRequest`/`scoreJudge`, which is
 * the intended behaviour (see `judge.ts`'s `appliesWhen`/`shotIndex`
 * handling), not a bug in this script. A real caller — GEPA's own harness —
 * has the plan and should build a fuller `JudgeContext`.
 */

import { readFileSync } from 'node:fs'
import { buildJudgeRequest, judgeFeedback, scoreJudge, weightedTotal } from '../../src/lib/judge'
import type { JudgeContext, ScopedAnswers, SystemOneResponse } from '../../src/lib/judge'
import { buildFullRubric } from '../../src/lib/judgeRubric'
import { lint } from '../../src/lib/lint'
import type { H3Mode } from '../../src/lib/types'

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'

function usage(): never {
  console.error('usage: TYPESAFE_API_KEY=... npx tsx probe/judge/judge.ts <prompt-file> [mode]')
  process.exit(1)
}

async function main() {
  const apiKey = process.env.TYPESAFE_API_KEY
  if (!apiKey) {
    console.error(
      [
        'TYPESAFE_API_KEY is not set.',
        '',
        'There is no key for this on this machine. This probe makes a real network',
        'call to api.typesafe.ai and cannot run without one — set TYPESAFE_API_KEY',
        'and re-run. Do not fake a response to get past this: the point of a probe',
        'is to prove the real wire format works, and a hand-built answers map would',
        'only prove it works against itself.',
      ].join('\n'),
    )
    process.exit(1)
  }

  const file = process.argv[2]
  if (!file) usage()
  const promptText = readFileSync(file, 'utf8')
  const mode = (process.argv[3] as H3Mode | undefined) ?? 'Ref2VA'

  const ctx: JudgeContext = {
    promptText,
    mode,
    approvedShots: [],
    clipSeconds: 0,
    hasDialogue: /<d>/.test(promptText),
  }

  const rubric = buildFullRubric(ctx)
  const scopedRequests = buildJudgeRequest(ctx, rubric)

  const responses: ScopedAnswers[] = []
  for (const scoped of scopedRequests) {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(scoped.request),
    })
    if (!res.ok) {
      console.error(`Jev returned ${res.status} for a '${scoped.scope}' request: ${await res.text()}`)
      process.exit(1)
    }
    const body = (await res.json()) as SystemOneResponse
    responses.push({ scope: scoped.scope, shotIndex: scoped.shotIndex, answers: body.answers })
  }

  const score = scoreJudge(ctx, rubric, responses)
  const findings = lint(promptText, mode)

  console.log(JSON.stringify(score.dimensions, null, 2))
  console.log('')
  console.log('weighted total:', weightedTotal(score))
  console.log('')
  console.log(judgeFeedback(score, findings))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
