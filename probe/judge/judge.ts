/**
 * probe/judge/judge.ts — score one rendered H3 prompt against the GEPA
 * rubric, on a System One model.
 *
 * The only place in this codebase a `judge.ts`/`judgeRubric.ts` request
 * actually leaves the process — both of those files are pure. This script
 * reads a prompt off disk, builds the scoped request(s) `buildJudgeRequest`
 * produces, sends each one, and prints the per-dimension vector plus the
 * GEPA feedback string.
 *
 * TWO TRANSPORTS, ONE BODY. Jev is reachable either directly or through
 * OpenRouter, and the request body is byte-identical between them — only the
 * URL, the key and the model id differ, which is exactly why
 * `buildJudgeRequest` takes the model as a parameter:
 *
 *   typesafe    POST api.typesafe.ai/v1/systemone          model `jev-latest`
 *   openrouter  POST openrouter.ai/api/alpha/decisions     model `~typesafe/jev-latest`
 *
 * The OpenRouter route is NOT the chat API and a decisions model is refused
 * by `/chat/completions` with a 400 saying so; it also never appears in
 * `GET /v1/models`, which lists chat models only. Looking there and
 * concluding the model does not exist is a mistake this comment exists to
 * stop someone repeating. OpenRouter additionally returns `usage.cost`,
 * which the native endpoint does not.
 *
 * ```sh
 * npx tsx probe/judge/judge.ts <prompt-file> [--mode Ref2VA] [--plan plan.json]
 *                              [--via typesafe|openrouter] [--repeat N]
 * ```
 *
 * WITHOUT `--plan`, the prompt is judged alone: there are no `approvedShots`,
 * so every `'shot'`-scoped question and the whole per-shot fan-out has
 * nothing to pair against and is skipped. That is `appliesWhen`/`shotIndex`
 * working as designed, not a failure — but it silently drops a third of the
 * rubric, so pass a plan whenever one exists. The plan file is
 * `{ clipSeconds: number, approvedShots: [{ index, summary, seconds }], hasCharacters?: boolean }`.
 * `hasCharacters` defaults to `true` when omitted — most clips have people in
 * them, so a caller opts OUT deliberately.
 *
 * `--repeat N` re-sends the identical request N times. Jev is NOT
 * deterministic: measured here across three runs of one prompt, a single
 * question moved p = 0.28 / 0.33 / 0.30 and another 0.35 / 0.38 / 0.38 —
 * about ±0.05. GEPA comparing two candidates that differ by less than the
 * spread is reading sampling noise, so measure it on your own rubric before
 * trusting a small delta.
 */

import { readFileSync } from 'node:fs'
import { buildJudgeRequest, judgeFeedback, scoreJudge, weightedTotal } from '../../src/lib/judge'
import type { JudgeContext, JudgeShot, ScopedAnswers, SystemOneResponse } from '../../src/lib/judge'
import { buildFullRubric } from '../../src/lib/judgeRubric'
import { lint } from '../../src/lib/lint'
import type { H3Mode } from '../../src/lib/types'

/** A transport is a URL, a model id, and the env vars that might hold its
 * key — in preference order, since a machine may carry more than one. */
interface Transport {
  id: 'typesafe' | 'openrouter'
  url: string
  model: string
  keyVars: string[]
}

const TRANSPORTS: Transport[] = [
  { id: 'typesafe', url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', keyVars: ['TYPESAFE_API_KEY'] },
  {
    id: 'openrouter',
    url: 'https://openrouter.ai/api/alpha/decisions',
    model: '~typesafe/jev-latest',
    // LLM_JUDGE_API_KEY first: on this operator's machine that is the
    // OpenRouter key already provisioned for judging. OPENAI_API_KEY is
    // deliberately NOT consulted — it is routinely repointed at a local
    // llama.cpp gateway and then holds a placeholder, not a usable key.
    keyVars: ['LLM_JUDGE_API_KEY', 'OPENROUTER_API_KEY'],
  },
]

function keyFor(t: Transport): string | undefined {
  for (const v of t.keyVars) {
    const value = process.env[v]
    // A value beginning "local" is a local-gateway placeholder (this repo's
    // sibling projects set OPENAI_API_KEY=local-no-key when pointed at
    // llama.cpp), so it is treated as absent rather than sent and rejected.
    if (value && !value.startsWith('local')) return value
  }
  return undefined
}

function usage(): never {
  console.error(
    [
      'usage: npx tsx probe/judge/judge.ts <prompt-file> [options]',
      '',
      '  --mode <H3Mode>      default Ref2VA',
      '  --plan <file.json>   { clipSeconds, approvedShots: [{index, summary, seconds}], hasCharacters? }',
      '                       hasCharacters defaults to true when the plan omits it',
      '                       without it, every shot-scoped question is skipped',
      '  --via <transport>    typesafe | openrouter   (default: whichever key is set)',
      '  --repeat <N>         re-send the same request N times to measure spread',
      '',
      'keys, by transport:',
      '  typesafe    TYPESAFE_API_KEY',
      '  openrouter  LLM_JUDGE_API_KEY or OPENROUTER_API_KEY',
    ].join('\n'),
  )
  process.exit(1)
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

interface Plan {
  clipSeconds?: number
  approvedShots?: JudgeShot[]
  /** Defaults to `true` when the plan omits it — most clips have people in
   * them, so a caller opts OUT deliberately (a landscape flythrough, a
   * product shot with no hands) rather than opting in. */
  hasCharacters?: boolean
}

async function main() {
  const file = process.argv[2]
  if (!file || file.startsWith('--')) usage()

  const via = arg('via')
  const chosen = via
    ? TRANSPORTS.find((t) => t.id === via)
    : TRANSPORTS.find((t) => keyFor(t))
  if (!chosen) {
    console.error(via ? `unknown transport '${via}' — expected typesafe or openrouter` : 'no usable key found')
    usage()
  }
  const apiKey = keyFor(chosen)
  if (!apiKey) {
    console.error(
      [
        `No key for the '${chosen.id}' transport — looked at ${chosen.keyVars.join(', ')}.`,
        '',
        'This probe makes a REAL network call and will not run without one. Do not',
        'fake a response to get past this: the point of a probe is to prove the real',
        'wire format works, and a hand-built answers map only proves it works against',
        'itself. Note that a value beginning "local" is rejected on purpose — that is',
        'a local-gateway placeholder, not a key.',
      ].join('\n'),
    )
    process.exit(1)
  }

  const promptText = readFileSync(file, 'utf8')
  const mode = (arg('mode') as H3Mode | undefined) ?? 'Ref2VA'
  const repeat = Math.max(1, Number(arg('repeat') ?? 1))

  const planFile = arg('plan')
  const plan: Plan = planFile ? (JSON.parse(readFileSync(planFile, 'utf8')) as Plan) : {}

  const ctx: JudgeContext = {
    promptText,
    mode,
    approvedShots: plan.approvedShots ?? [],
    clipSeconds: plan.clipSeconds ?? 0,
    hasDialogue: /<d>/.test(promptText),
    hasCharacters: plan.hasCharacters ?? true,
  }

  const rubric = buildFullRubric(ctx)
  const scopedRequests = buildJudgeRequest(ctx, rubric, chosen.model)

  if (!plan.approvedShots?.length) {
    console.error('note: no --plan given, so shot-scoped questions and the per-shot fan-out are skipped.\n')
  }

  const findings = lint(promptText, mode)
  const totals: number[] = []

  for (let run = 1; run <= repeat; run++) {
    const responses: ScopedAnswers[] = []
    let cost = 0
    let inputTokens = 0
    const started = Date.now()

    for (const scoped of scopedRequests) {
      const res = await fetch(chosen.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(scoped.request),
      })
      if (!res.ok) {
        console.error(`${chosen.id} returned ${res.status} for a '${scoped.scope}' request: ${await res.text()}`)
        process.exit(1)
      }
      const body = (await res.json()) as SystemOneResponse & { usage?: { cost?: number } }
      cost += body.usage?.cost ?? 0
      inputTokens += body.usage?.input_tokens ?? 0
      responses.push({ scope: scoped.scope, shotIndex: scoped.shotIndex, answers: body.answers })
    }

    const score = scoreJudge(ctx, rubric, responses)
    const total = weightedTotal(score)
    if (total !== null) totals.push(total)

    const elapsed = Date.now() - started
    const costNote = cost > 0 ? `, $${cost.toFixed(6)}` : ''
    console.log(
      `run ${run}/${repeat} · ${chosen.id} · ${scopedRequests.length} request(s) · ` +
        `${inputTokens} input tokens${costNote} · ${elapsed}ms`,
    )

    // Only the last run's full breakdown is printed — with --repeat the point
    // is the spread, reported below, not N copies of the same table.
    if (run === repeat) {
      console.log('')
      for (const [dim, v] of Object.entries(score.dimensions)) {
        console.log(`${dim.padEnd(10)} ${v.score === null ? '— not applied —' : v.score.toFixed(3)}  (${v.appliedCount}/${v.questionCount} applied)`)
        for (const q of score.questions.filter((r) => r.dimension === dim)) {
          if (!q.applied) {
            console.log(`   ---   ${q.id}  (not applied)`)
            continue
          }
          const how = q.kind === 'exact' ? '[code]' : `p=${q.probability!.toFixed(2)}`
          console.log(`  ${q.contribution!.toFixed(2)}   ${q.id.padEnd(40)} ${how}`)
        }
      }
      console.log('')
      console.log('weighted total:', total)
      console.log('')
      console.log(judgeFeedback(score, findings))
    }
  }

  if (totals.length > 1) {
    const lo = Math.min(...totals)
    const hi = Math.max(...totals)
    console.log('')
    console.log(
      `spread over ${totals.length} runs: ${lo.toFixed(3)} – ${hi.toFixed(3)} ` +
        `(±${((hi - lo) / 2).toFixed(3)}). A GEPA delta smaller than this is noise.`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
