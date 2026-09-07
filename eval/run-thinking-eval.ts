import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildEvalMessages, EVAL_CASES, EVAL_MODELS } from './cases'
import { streamOneResponse } from './stream'
import type { ChatMessage } from '../src/lib/llm'
import type { EvalModel, RawEvalRecord, ThinkingEvalCase } from './types'

export type ThinkingArm = 'on' | 'off'

export interface RunOptions {
  baseUrl: string
  outputDir: string
  thinking: ThinkingArm | undefined
  model: EvalModel | undefined
  caseId: string | undefined
  /** Exposed for the CLI self-test; callers may omit it and derive from thinking. */
  arms?: readonly boolean[]
}

const DEFAULT_BASE_URL = 'https://YOUR_GATEWAY_HOST/llama/v1'
const DEFAULT_OUTPUT_DIR = 'eval/out/2026-09-03-thinking-toggle'
const SELECTED_SKILLS = ['h3-acting', 'h3-direction', 'h3-prompting']

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function responseDefaults(elapsedMs: number): RawEvalRecord['response'] {
  return {
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    elapsedMs,
    timeToFirstTokenMs: null,
    unterminatedThink: false,
    requestCount: 1 as const,
    continuations: 0 as const,
  }
}

function makeRecord(
  testCase: ThinkingEvalCase,
  model: EvalModel,
  enableThinking: boolean,
  body: Record<string, unknown>,
  url: string,
  messages: ChatMessage[],
  response: RawEvalRecord['response'],
  errors: string[],
): RawEvalRecord {
  return {
    eval: 'studio-thinking-v1',
    caseId: testCase.id,
    family: testCase.family,
    stage: testCase.stage,
    studioMode: testCase.studioMode,
    model,
    chatTemplateKwargs: { enable_thinking: enableThinking },
    settings: {
      temperature: 0.2,
      maxTokens: 8192,
      h3Mode: testCase.h3Mode,
      selectedSkills: [...SELECTED_SKILLS],
      inputHash: sha256(messages[1]?.content ?? ''),
      systemHash: sha256(messages[0]?.content ?? ''),
    },
    request: { url, body },
    response,
    // Task 3 fills the contract findings. Keeping a transport-success marker
    // here makes every Task 2 record shape-complete without importing a future
    // scorer or changing the production app.
    deterministic: { passed: errors.length === 0, findings: [] },
    qualitative: null,
    errors,
  }
}

/** Run exactly one direct POST and capture exactly that response. */
export async function runOneVariant(
  baseUrl: string,
  testCase: ThinkingEvalCase,
  model: EvalModel,
  enableThinking: boolean,
): Promise<RawEvalRecord> {
  const started = performance.now()
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`
  let messages: ChatMessage[] = []
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 8192,
    stream: true,
    chat_template_kwargs: { enable_thinking: enableThinking },
  }
  try {
    messages = await buildEvalMessages(testCase)
    body.messages = messages
  } catch (error) {
    const errors = [`message assembly failed: ${errorText(error)}`]
    return makeRecord(testCase, model, enableThinking, body, url, messages, responseDefaults(Math.round(performance.now() - started)), errors)
  }
  const requestInit: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }

  let response: Response
  try {
    // This is intentionally the only fetch in the variant function. There is
    // no retry, output-limit fallback, or continuation path in this harness.
    response = await fetch(url, requestInit)
  } catch (error) {
    const errors = [errorText(error)]
    return makeRecord(testCase, model, enableThinking, body, url, messages, responseDefaults(Math.round(performance.now() - started)), errors)
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
    const errors = [`${status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`]
    const failedResponse = responseDefaults(Math.round(performance.now() - started))
    return makeRecord(testCase, model, enableThinking, body, url, messages, failedResponse, errors)
  }

  try {
    const captured = await streamOneResponse(response, () => {})
    const responseWithBudget = { ...captured, requestCount: 1 as const, continuations: 0 as const }
    return makeRecord(testCase, model, enableThinking, body, url, messages, responseWithBudget, [])
  } catch (error) {
    const errors = [errorText(error)]
    const failedResponse = responseDefaults(Math.round(performance.now() - started))
    return makeRecord(testCase, model, enableThinking, body, url, messages, failedResponse, errors)
  }
}

function selectedCases(caseId: string | undefined): readonly ThinkingEvalCase[] {
  if (!caseId) return EVAL_CASES
  const testCase = EVAL_CASES.find((candidate) => candidate.id === caseId)
  if (!testCase) throw new Error(`Unknown eval case: ${caseId}`)
  return [testCase]
}

function selectedModels(model: EvalModel | undefined): readonly EvalModel[] {
  if (!model) return EVAL_MODELS
  if (!EVAL_MODELS.includes(model)) throw new Error(`Unknown eval model: ${model}`)
  return [model]
}

function selectedArms(options: RunOptions): readonly boolean[] {
  if (options.arms && options.arms.length > 0) return options.arms
  return options.thinking ? [options.thinking === 'on'] : [true, false]
}

/** Run the selected variants sequentially and flush one JSONL record per variant. */
export async function runThinkingEval(options: RunOptions): Promise<{ planned: number; written: number; failures: number }> {
  const models = selectedModels(options.model)
  const cases = selectedCases(options.caseId)
  const arms = selectedArms(options)
  if (arms.some((arm) => typeof arm !== 'boolean')) throw new Error('Thinking arms must be booleans')

  const planned = models.length * cases.length * arms.length
  await mkdir(options.outputDir, { recursive: true })
  const outputPath = join(options.outputDir, 'raw.jsonl')
  const output = await open(outputPath, 'w')
  let written = 0
  let failures = 0
  try {
    for (const model of models) {
      for (const testCase of cases) {
        for (const enableThinking of arms) {
          const record = await runOneVariant(options.baseUrl, testCase, model, enableThinking)
          await output.write(`${JSON.stringify(record)}\n`)
          await output.sync()
          written++
          if (record.errors.length > 0) failures++
        }
      }
    }
  } finally {
    await output.close()
  }
  return { planned, written, failures }
}

function takeValue(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return [value, index + 1]
}

function parseThinking(value: string): ThinkingArm {
  if (value === 'on' || value === 'off') return value
  throw new Error(`--thinking must be on or off, got: ${value}`)
}

/** Parse CLI filters without touching the network or filesystem. */
export function parseCli(argv: string[]): RunOptions & { arms: readonly boolean[] } {
  let baseUrl = process.env.H3_EVAL_BASE_URL ?? DEFAULT_BASE_URL
  let outputDir = DEFAULT_OUTPUT_DIR
  let thinking: ThinkingArm | undefined
  let model: EvalModel | undefined
  let caseId: string | undefined

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const [flag, inlineValue] = arg.split(/=(.*)/s, 2)
    if (flag === '--thinking') {
      const [value, next] = inlineValue === undefined ? takeValue(argv, index, '--thinking') : [inlineValue, index]
      thinking = parseThinking(value)
      index = next
    } else if (flag === '--model') {
      const [value, next] = inlineValue === undefined ? takeValue(argv, index, '--model') : [inlineValue, index]
      if (!EVAL_MODELS.includes(value as EvalModel)) throw new Error(`Unknown eval model: ${value}`)
      model = value as EvalModel
      index = next
    } else if (flag === '--case') {
      const [value, next] = inlineValue === undefined ? takeValue(argv, index, '--case') : [inlineValue, index]
      if (!EVAL_CASES.some((candidate) => candidate.id === value)) throw new Error(`Unknown eval case: ${value}`)
      caseId = value
      index = next
    } else if (flag === '--out' || flag === '--output-dir') {
      const [value, next] = inlineValue === undefined ? takeValue(argv, index, flag) : [inlineValue, index]
      outputDir = value
      index = next
    } else if (flag === '--base-url') {
      const [value, next] = inlineValue === undefined ? takeValue(argv, index, '--base-url') : [inlineValue, index]
      baseUrl = value
      index = next
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }

  return {
    baseUrl,
    outputDir,
    thinking,
    model,
    caseId,
    arms: thinking ? [thinking === 'on'] : [true, false],
  }
}

async function main(): Promise<void> {
  const result = await runThinkingEval(parseCli(process.argv.slice(2)))
  console.log(`planned=${result.planned} written=${result.written} failures=${result.failures}`)
}

const entryPath = process.argv[1] ? fileURLToPath(pathToFileURL(process.argv[1])) : ''
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  main().catch((error) => {
    console.error(errorText(error))
    process.exitCode = 1
  })
}
