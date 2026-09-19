/**
 * probe/gepa/reflect.ts — the REFLECTION model for GEPA, run as `claude -p`.
 *
 * GEPA uses two models and conflating them is the trap:
 *
 *   TASK MODEL       runs the prompt being optimised. MUST stay on the local
 *                    box (`swift-qwen38-27b`), because the whole premise is
 *                    that we are learning THAT model's failure modes. Tune
 *                    against a different model and you keep only the generic
 *                    half of the improvement, with no way to tell which half
 *                    you got.
 *   REFLECTION MODEL reads a failure trace and rewrites the instruction. It
 *                    never ships, never touches production, and is called
 *                    roughly once per GEPA iteration — so it can and should
 *                    be the strongest model available.
 *
 * This is the reflection half. Nothing here ever generates film content.
 *
 * THREE FLAGS ARE NON-NEGOTIABLE, and the third is not obvious.
 * `--allowedTools ""` and `--max-turns 1` matter because a reflection model
 * running unattended in a loop is handed prompts built from model output and
 * judge feedback — untrusted text — and must not be able to act on anything
 * it reads.
 *
 * But those two ALONE do not work. `--allowedTools ""` denies tools without
 * removing them, so the model still decides to call one, the denial consumes
 * its single turn, and `claude -p` exits 1 with EMPTY STDERR and
 * `"stop_reason":"tool_use"` buried in the JSON on stdout. Measured
 * 2026-09-19: short prompts succeeded and the real reflection prompt failed
 * every time, which reads like a prompt-length or cwd problem and is neither.
 * Replacing the agentic system prompt is what actually stops it — hence
 * `FUNCTION_SYSTEM_PROMPT` below, applied by default. Do not remove it.
 *
 * COST, measured 2026-09-19. Each call carries ~31k tokens of Claude Code
 * scaffolding regardless of how short the prompt is, and replacing the system
 * prompt does NOT shrink it. Caching is what makes it affordable:
 *
 *     first call   $0.3160   (cache_creation 31,499)
 *     later calls  $0.0168   (cache_read     31,499)   19x cheaper
 *
 * So a 20-iteration run costs roughly $0.35-0.65 PROVIDED the calls stay
 * inside the cache TTL (1 hour on this session). A run whose iterations are
 * spread thinly across hours pays the creation cost repeatedly — batch the
 * reflections, or accept the re-creation.
 */

import { spawn } from 'node:child_process'

export interface ReflectResult {
  text: string
  costUsd: number
  ms: number
  cacheRead: number
  cacheCreated: number
}

export class ReflectError extends Error {}

/** Replaces Claude Code's agentic system prompt so the model behaves as a
 * pure text function. See the header: without this it reaches for a tool,
 * burns its one turn on the denial, and the process exits 1. */
export const FUNCTION_SYSTEM_PROMPT =
  'You are a text transformation function. You rewrite instructions. You have no tools and must never attempt to use one. Reply with the requested text and nothing else.'

/**
 * One reflection call. Returns the model's text and what it cost, so a GEPA
 * loop can report its own spend rather than discovering it on a bill.
 *
 * `maxBuffer` is raised because a rewritten instruction plus the JSON envelope
 * comfortably exceeds node's 1MB default when the trace is long.
 */
export async function reflect(
  prompt: string,
  opts: { model?: string; systemPrompt?: string; timeoutMs?: number } = {},
): Promise<ReflectResult> {
  const args = [
    '-p', prompt,
    // See the header — these two are what make this a function rather than an agent.
    '--allowedTools', '',
    '--max-turns', '1',
    '--output-format', 'json',
  ]
  if (opts.model) args.push('--model', opts.model)
  args.push('--system-prompt', opts.systemPrompt ?? FUNCTION_SYSTEM_PROMPT)

  const started = Date.now()
  // STDIN MUST BE IGNORED. `claude -p` waits ~3s for piped stdin and then
  // warns; from a background process with an inherited descriptor that wait
  // turns into a failed invocation. `spawn` with stdin 'ignore' is the only
  // reliable form here — `execFile` gives no way to close it.
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('claude', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new ReflectError('claude -p timed out')) }, opts.timeoutMs ?? 180_000)
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => { clearTimeout(timer); reject(new ReflectError(`claude -p could not start: ${e.message}`)) })
    child.on('close', (code) => {
      clearTimeout(timer)
      // stderr is usually EMPTY on failure — the reason is in the JSON on
      // stdout (`stop_reason`), so surface both or the error says nothing.
      if (code !== 0) {
        let why = ''
        try { why = ` stop_reason=${JSON.parse(out).stop_reason}` } catch {}
        reject(new ReflectError(`claude -p exited ${code}:${why} ${err.slice(0, 200)}`))
      }
      else resolve(out)
    })
  })

  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new ReflectError(`claude -p returned unparseable JSON: ${stdout.slice(0, 300)}`)
  }
  if (parsed.is_error) throw new ReflectError(`claude -p reported an error: ${String(parsed.result).slice(0, 300)}`)
  const text = typeof parsed.result === 'string' ? parsed.result.trim() : ''
  if (!text) throw new ReflectError('claude -p returned an empty result')

  return {
    text,
    costUsd: Number(parsed.total_cost_usd) || 0,
    ms: Date.now() - started,
    cacheRead: Number(parsed.usage?.cache_read_input_tokens) || 0,
    cacheCreated: Number(parsed.usage?.cache_creation_input_tokens) || 0,
  }
}

/**
 * The reflection prompt GEPA sends: the instruction that underperformed, the
 * examples it failed on, and the judge's own feedback string.
 *
 * `judgeFeedback` already emits exactly what is wanted here — the weakest
 * dimensions, the lowest-scoring questions with their probabilities, and the
 * deterministic findings with the offending spans quoted. A System One judge
 * writes no prose of its own, so this assembled text IS the signal.
 *
 * The output contract is deliberately narrow: the rewritten instruction and
 * nothing else. A reflection model that explains itself produces an
 * instruction with commentary baked into it, which then goes into production.
 */
export function buildReflectionPrompt(args: {
  currentInstruction: string
  failures: { label: string; score: number; feedback: string }[]
}): string {
  const cases = args.failures
    .map((f) => `--- ${f.label} (scored ${f.score.toFixed(3)})\n${f.feedback}`)
    .join('\n\n')
  return `You are improving ONE instruction used to make a model write a video prompt.

Below is the instruction as it stands, then the cases where it scored worst,
each with an automated judge's findings. The judge reports calibrated
probabilities per question; a low score means the written prompt did not
satisfy that question.

Rewrite the instruction so those failures stop happening, while keeping
everything it already does well. Do not address the specific examples — they
are evidence of a general weakness, and your rewrite is applied to unseen
cases. Keep it roughly the same length; a longer instruction is not
automatically a better one.

CURRENT INSTRUCTION
${args.currentInstruction}

WORST CASES
${cases}

Reply with the rewritten instruction and nothing else. No preamble, no
explanation, no surrounding quotes or code fences.`
}
