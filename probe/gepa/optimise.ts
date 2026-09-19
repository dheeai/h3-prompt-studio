/**
 * probe/gepa/optimise.ts — GEPA: optimise ONE instruction (preset A's
 * `DEFAULT_TEMPLATES.draft`) against the judge, over the 19-case trainset.
 *
 * Read `probe/gepa/README.md` first — the three model roles, the cost, the
 * budget rationale. This file wires them together:
 *
 *   TASK MODEL        `models.ts` — authors the candidate prompt, on the
 *                      local box. The prompt IS optimised for this model.
 *   REFLECTION MODEL   `reflect.ts` — `claude -p`, rewrites the losing
 *                      instruction from the judge's own failure text.
 *   JUDGE              `src/lib/judge.ts` + `judgeRubric.ts`, via OpenRouter's
 *                      `~typesafe/jev-latest` decisions endpoint — never the
 *                      `probe/judge/judge.ts` CLI; the same pure functions
 *                      are reused directly, as the brief requires.
 *
 * Preset A is FROZEN. Nothing here ever imports or writes `src/lib/stages.ts`
 * except to read the seed instruction (`DEFAULT_TEMPLATES.draft`); the output
 * of a run is a new file, "preset C", never a change to that template.
 *
 * THE AUTHORING CALL SHAPE is copied from `probe/pipeline/reauthor.ts`
 * verbatim (the skills-corpus loader, `withQwenReasoningBudget`,
 * `h3ResponseFormat`, `injectFilmLook`, `joinH3Sections`) — that file is
 * off-limits to edit, so the shape is duplicated here rather than imported.
 *
 * CACHE. GEPA re-evaluates survivors constantly and authoring is ~30s a
 * call, so every authored prompt is cached under `probe/gepa/.cache/` keyed
 * on `sha256(instruction + '\0' + story)`. Only a SUCCESSFUL parse is
 * cached — the authoring call is stochastic (temperature 0.35), so caching a
 * failure would freeze in a bad roll of the dice rather than a property of
 * the instruction. The judge is never cached: it is comparatively cheap
 * (network, not GPU) and the brief wants a judge change to be re-scoreable
 * without re-authoring, which a prompt-only cache already gives for free.
 *
 * PLACEHOLDER GUARD. The required set is extracted from the seed template
 * itself (never hardcoded), and a reflection child missing one is rejected
 * before it is ever authored against — see `missingPlaceholders`.
 *
 * ```sh
 * LLM_URL=... LLM_JUDGE_API_KEY=... \
 *   npx tsx probe/gepa/optimise.ts [--iterations 10] [--minibatch 4] \
 *     [--seed 42] [--trainset probe/gepa/trainset.json] [--out DIR] \
 *     [--concurrency 4] [--dry]
 * ```
 *
 * CONCURRENCY. Evaluating one candidate over the train split is N independent
 * (author, judge) rollouts with no ordering requirement, so they run through
 * a small bounded worker pool (`poolMap`, below) instead of one at a time.
 * `--concurrency` (default 4) MUST track the local llama.cpp server's
 * `--parallel` slot count: asking for more than the server has slots just
 * re-queues requests server-side (harmless but pointless — no extra
 * throughput), and asking for more than the slots that are actually free
 * *while they're busy* can push a request past its per-slot `-c` context.
 * Results are still collected into a fixed-size array indexed by input
 * position (never by completion/push order), so a run is byte-identical to a
 * serial one regardless of which worker finishes first — see `poolMap`'s
 * self-checks under `--dry`.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { DEFAULT_TEMPLATES } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { injectFilmLook } from '../../src/lib/filmLookInject'
import { describeFilmLook, FILM_LOOK_PRESETS } from '../../src/lib/filmLook'
import { withQwenReasoningBudget } from '../../src/lib/thinking'
import {
  buildJudgeRequest,
  judgeFeedback,
  scoreJudge,
  weightedTotal,
  JUDGE_DIMENSIONS,
} from '../../src/lib/judge'
import type { JudgeContext, JudgeDimension, ScopedAnswers, SystemOneResponse } from '../../src/lib/judge'
import { buildFullRubric } from '../../src/lib/judgeRubric'
import { lint } from '../../src/lib/lint'
import type { H3Mode } from '../../src/lib/types'

import { TASK_MODEL, taskEndpoint } from './models'
import { buildReflectionPrompt, reflect } from './reflect'
import type { TrainCase } from './trainset'

// ── bounded concurrency ─────────────────────────────────────────────────────

/** Set once in `main()` from `--concurrency` (default 4). Read by every place
 * that evaluates a SET of cases. See the header note on why the default must
 * track the server's `--parallel` slot count. */
let CONCURRENCY = 4

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, and
 * returns results in INPUT ORDER regardless of completion order — a fixed
 * -size array indexed by position, written once each, never accumulated by
 * push. This is what keeps a pooled run byte-identical to a serial one given
 * identical model output. See the `poolMap` self-checks under `--dry`.
 */
async function poolMap<T, R>(items: readonly T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(concurrency, items.length))
  async function drain(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, drain))
  return results
}

/**
 * De-duplicates concurrent requests for the same key against a shared
 * in-flight map: the first caller runs `work()` and every concurrent caller
 * for the same key joins that same promise instead of starting its own. The
 * entry is removed once `work()` settles (success or failure) so a later,
 * non-concurrent call re-runs `work()` normally.
 */
function dedupeInFlight<T>(inFlight: Map<string, Promise<T>>, key: string, work: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key)
  if (existing) return existing
  const created = work().finally(() => inFlight.delete(key))
  inFlight.set(key, created)
  return created
}

// ── fixed authoring context — same as reauthor.ts's preset-A arm ───────────

const MODE: H3Mode = 'Ref2VA'
const LOOK = { preset: FILM_LOOK_PRESETS[3].id }
const SEED_INSTRUCTION = DEFAULT_TEMPLATES.draft

const SKILL_DIR = 'public/skills'
/** Byte-identical to reauthor.ts's `corpus()` — duplicated because that file
 * is off-limits to edit and does not export it. */
function corpus(dirs: string[]): string {
  if (!dirs.length) return ''
  const chunks: string[] = []
  for (const d of dirs) {
    const base = join(SKILL_DIR, d)
    const files = ['SKILL.md']
    try {
      for (const f of readdirSync(join(base, 'references'))) files.push(join('references', f))
    } catch {}
    for (const f of files) {
      try {
        chunks.push(`<skill name="${d}" file="${f}">\n${readFileSync(join(base, f), 'utf8').trim()}\n</skill>`)
      } catch {}
    }
  }
  return chunks.join('\n\n')
}

/** Same substitutions as reauthor.ts's `fillDraft`, minus `{{direction}}` /
 * `{{acting}}` — preset A's draft template never contains those tokens, so
 * they were no-ops there too. */
function fillTemplate(template: string, story: string): string {
  return template
    .replace(/\{\{mode\}\}/g, MODE)
    .replace(/\{\{film\}\}/g, describeFilmLook(LOOK))
    .replace(/\{\{previous\}\}/g, '(none — judge this clip on its own)')
    .replace(/\{\{continuationFrame\}\}/g, '')
    .replace(/\{\{standing\}\}/g, '')
    .replace(/\{\{plates\}\}/g, '')
    .replace(/\{\{story\}\}/g, story)
}

// ── placeholder guard ───────────────────────────────────────────────────────

/** Extracted from the SEED, never hardcoded — see the brief's "this is
 * load-bearing" note. Order is first-appearance order in the template. */
const REQUIRED_PLACEHOLDERS: string[] = Array.from(
  new Set(Array.from(SEED_INSTRUCTION.matchAll(/\{\{(\w+)\}\}/g)).map((m) => m[1])),
)

/** Placeholders the seed had that `candidate` dropped. Empty = passes. */
function missingPlaceholders(candidate: string): string[] {
  return REQUIRED_PLACEHOLDERS.filter((p) => !candidate.includes(`{{${p}}}`))
}

// ── authoring (task model) ──────────────────────────────────────────────────

/** Same shape as reauthor.ts's `ask()` for the 'A' arm: skills corpus as a
 * system message, `withQwenReasoningBudget`, the H3 JSON schema. */
async function author(prompt: string): Promise<{ text: string; ms: number }> {
  const url = taskEndpoint()
  const t0 = Date.now()
  const system = corpus(['h3-prompting'])
  const messages = system
    ? [{ role: 'system', content: system }, { role: 'user', content: prompt }]
    : [{ role: 'user', content: prompt }]
  const body = withQwenReasoningBudget({ id: 'localbox', baseUrl: url } as any, TASK_MODEL, {
    model: TASK_MODEL,
    temperature: 0.35,
    messages,
    response_format: h3ResponseFormat(MODE),
  })
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j: any = await res.json()
  const text: string = j.choices?.[0]?.message?.content ?? ''
  return { text, ms: Date.now() - t0 }
}

/** Same two lines as reauthor.ts's `write()`, minus the file write — returns
 * the joined prompt text, or null on any parse/section failure. */
function parseAuthored(raw: string): string | null {
  let obj: any = null
  try {
    obj = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1))
  } catch {}
  if (!obj) return null
  const injected = injectFilmLook(obj, MODE, LOOK)
  const joined = joinH3Sections(JSON.stringify(injected), MODE)
  return joined ? joined.prompt : null
}

// ── cache — authored PROMPT TEXT only, keyed on instruction+story ─────────

const CACHE_DIR = 'probe/gepa/.cache'

function cacheKeyFor(instruction: string, story: string): string {
  return createHash('sha256').update(instruction + '\0' + story).digest('hex')
}

function cachePath(dir: string, key: string): string {
  return join(dir, `${key}.json`)
}

function readCache(dir: string, key: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(cachePath(dir, key), 'utf8'))
    return typeof raw.prompt === 'string' ? raw.prompt : null
  } catch {
    return null
  }
}

/** Atomic: write to a per-writer temp file, then rename over the final path.
 * A rename onto an existing path is atomic on the same filesystem, so a
 * reader never observes a partially-written cache file, and two concurrent
 * writers (which can only happen for two DIFFERENT keys — see
 * `authorWithCache`'s in-flight de-dup for the same-key case) never
 * interleave into the same temp file because each gets a unique name. */
function writeCache(dir: string, key: string, prompt: string): void {
  mkdirSync(dir, { recursive: true })
  const finalPath = cachePath(dir, key)
  const tmpPath = `${finalPath}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmpPath, JSON.stringify({ prompt }, null, 2), 'utf8')
  renameSync(tmpPath, finalPath)
}

// ── in-flight authoring de-dup ──────────────────────────────────────────────

/** Keyed the same as the disk cache. When two concurrent `evaluate()` calls
 * ask for the same (instruction, story) — e.g. a case that appears in both a
 * minibatch and a full-train pass evaluated back-to-back with overlapping
 * in-flight tails — the second joins the first's promise instead of issuing
 * a second authoring call and racing it into the cache file. */
const inFlightAuth = new Map<string, Promise<{ promptText: string | null; failure?: string; authorMs: number }>>()

async function doAuthor(instruction: string, story: string, key: string): Promise<{ promptText: string | null; failure?: string; authorMs: number }> {
  try {
    const filled = fillTemplate(instruction, story)
    const { text: raw, ms } = await author(filled)
    const parsed = parseAuthored(raw)
    if (!parsed) {
      return { promptText: null, failure: 'authoring produced unparseable output (no valid JSON, or a required H3 section came back empty)', authorMs: ms }
    }
    writeCache(CACHE_DIR, key, parsed)
    return { promptText: parsed, authorMs: ms }
  } catch (e) {
    return { promptText: null, failure: `authoring call failed: ${(e as Error).message}`, authorMs: 0 }
  }
}

/**
 * Cache-checked, in-flight-de-duped authoring for one (instruction, story).
 * `stats.cacheHits`/`cacheMisses` count a joined in-flight call as a hit
 * (like a disk cache hit, it costs no additional authoring call and adds no
 * `authorMs` of its own — the creator's call already accounted for that
 * time), so `stats.authorMs` always reflects only real, unique authoring
 * calls regardless of how many callers shared the result.
 */
async function authorWithCache(instruction: string, story: string, stats: RunStats): Promise<{ promptText: string | null; failure?: string; cacheHit: boolean; authorMs: number }> {
  const key = cacheKeyFor(instruction, story)
  const cached = readCache(CACHE_DIR, key)
  if (cached !== null) {
    stats.cacheHits++
    return { promptText: cached, cacheHit: true, authorMs: 0 }
  }

  const isCreator = !inFlightAuth.has(key)
  const result = await dedupeInFlight(inFlightAuth, key, () => doAuthor(instruction, story, key))
  if (isCreator) {
    stats.cacheMisses++
    stats.authorMs += result.authorMs
    return { promptText: result.promptText, failure: result.failure, cacheHit: false, authorMs: result.authorMs }
  }
  stats.cacheHits++
  return { promptText: result.promptText, failure: result.failure, cacheHit: true, authorMs: 0 }
}

// ── judge — reuses src/lib/judge.ts's pure functions directly ─────────────

const JUDGE_URL = 'https://openrouter.ai/api/alpha/decisions'
const JUDGE_MODEL = '~typesafe/jev-latest'

function judgeApiKey(): string {
  const key = process.env.LLM_JUDGE_API_KEY
  if (!key) throw new Error('LLM_JUDGE_API_KEY is not set (the OpenRouter key for the jev-latest System One judge)')
  return key
}

async function judgeCall(
  ctx: JudgeContext,
): Promise<{ score: number; feedback: string; perDimension: Record<JudgeDimension, number | null>; ms: number }> {
  const rubric = buildFullRubric(ctx)
  const scopedRequests = buildJudgeRequest(ctx, rubric, JUDGE_MODEL)
  const apiKey = judgeApiKey()
  const t0 = Date.now()
  const responses: ScopedAnswers[] = []
  for (const scoped of scopedRequests) {
    const res = await fetch(JUDGE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(scoped.request),
    })
    if (!res.ok) {
      throw new Error(`judge transport returned ${res.status} for a '${scoped.scope}' request: ${await res.text()}`)
    }
    const responseBody = (await res.json()) as SystemOneResponse
    responses.push({ scope: scoped.scope, shotIndex: scoped.shotIndex, answers: responseBody.answers })
  }
  const score = scoreJudge(ctx, rubric, responses)
  const total = weightedTotal(score) ?? 0
  const findings = lint(ctx.promptText, ctx.mode)
  const feedback = judgeFeedback(score, findings)
  const perDimension = {} as Record<JudgeDimension, number | null>
  for (const dim of JUDGE_DIMENSIONS) perDimension[dim] = score.dimensions[dim].score
  return { score: total, feedback, perDimension, ms: Date.now() - t0 }
}

// ── evaluate(instruction, case) ────────────────────────────────────────────

interface RunStats {
  cacheHits: number
  cacheMisses: number
  authorMs: number
  judgeMs: number
  reflectMs: number
  reflectCostUsd: number
  reflectCalls: number
  /** Wall-clock elapsed inside pooled batches of `evaluate()` calls (the
   * baseline eval, every minibatch, every full-train re-eval, every held-out
   * eval) — summed across batches. Compared against `authorMs + judgeMs`
   * (the serial sum of the same calls) to report achieved parallelism. */
  poolWallMs: number
}

function freshStats(): RunStats {
  return { cacheHits: 0, cacheMisses: 0, authorMs: 0, judgeMs: 0, reflectMs: 0, reflectCostUsd: 0, reflectCalls: 0, poolWallMs: 0 }
}

export interface CaseEvalResult {
  label: string
  score: number
  feedback: string
  perDimension: Record<JudgeDimension, number | null>
  cacheHit: boolean
  authorMs: number
  judgeMs: number
  /** Set only when authoring/parsing failed — the case was scored 0, not skipped. */
  failure?: string
}

/**
 * One (instruction, case) rollout: fill -> author -> parse -> judge.
 *
 * An authoring or parse failure scores 0 with a feedback string explaining
 * why — never skipped, per the brief: "a candidate that produces unparseable
 * output must be punished, not skipped." Only a genuine authoring/parse
 * failure is punished this way; a judge transport failure is an
 * infrastructure fault and is allowed to throw and stop the run rather than
 * being silently scored.
 */
export async function evaluate(instruction: string, tcase: TrainCase, stats: RunStats): Promise<CaseEvalResult> {
  const { promptText, failure, cacheHit, authorMs } = await authorWithCache(instruction, tcase.story, stats)

  const zeroDims = Object.fromEntries(JUDGE_DIMENSIONS.map((d) => [d, null])) as Record<JudgeDimension, number | null>
  if (failure || promptText === null) {
    return { label: tcase.label, score: 0, feedback: `SCORED 0 — ${failure}`, perDimension: zeroDims, cacheHit, authorMs, judgeMs: 0, failure }
  }

  const ctx: JudgeContext = {
    promptText,
    mode: MODE,
    approvedShots: tcase.plan.approvedShots,
    clipSeconds: tcase.plan.clipSeconds,
    hasDialogue: tcase.plan.hasDialogue,
    hasCharacters: tcase.plan.hasCharacters,
  }
  const { score, feedback, perDimension, ms: judgeMs } = await judgeCall(ctx)
  stats.judgeMs += judgeMs
  return { label: tcase.label, score, feedback, perDimension, cacheHit, authorMs, judgeMs }
}

// ── deterministic seeded split ──────────────────────────────────────────────

/** mulberry32 — small, dependency-free, seeded PRNG. One instance is created
 * in `main()` and threaded through the whole run (the split, then the
 * per-iteration minibatch sampling), so a `--seed` reproduces the entire run's
 * random draws given the same evaluation outcomes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seededShuffle<T>(arr: readonly T[], rng: () => number): T[] {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function seededSample<T>(arr: readonly T[], n: number, rng: () => number): T[] {
  return seededShuffle(arr, rng).slice(0, Math.max(0, n))
}

function isMultiShot(c: TrainCase): boolean {
  return c.plan.approvedShots.length > 1
}

function groupKey(c: TrainCase): string {
  return `multi=${isMultiShot(c)}|dlg=${c.plan.hasDialogue}`
}

/**
 * Stratified on (multi-shot × has-dialogue) so BOTH sides get multi-shot
 * cases and dialogue cases, per the brief — a split that puts every
 * multi-shot case on one side measures nothing. `12/19` is this brief's own
 * ratio ("roughly 12 train / 7 held-out" for the 19-case corpus); kept as a
 * fraction so a differently-sized `--trainset` still gets a sensible split.
 *
 * Within each stratum: seeded-shuffle, then take `round(size * fraction)`
 * for train, clamped to `[1, size-1]` whenever the stratum has 2+ members so
 * neither side is starved of it. A size-1 stratum cannot appear on both
 * sides at once and goes wherever the rounded fraction points (train, at
 * this ratio) — acceptable because the multi-shot/dialogue balance itself is
 * carried by the larger strata, not by that singleton.
 */
export function stratifiedSplit(cases: readonly TrainCase[], rng: () => number): { train: TrainCase[]; held: TrainCase[] } {
  const TRAIN_FRACTION = 12 / 19
  const groups = new Map<string, TrainCase[]>()
  for (const c of cases) {
    const key = groupKey(c)
    const g = groups.get(key)
    if (g) g.push(c)
    else groups.set(key, [c])
  }

  const train: TrainCase[] = []
  const held: TrainCase[] = []
  for (const group of groups.values()) {
    const shuffled = seededShuffle(group, rng)
    let trainCount = Math.round(shuffled.length * TRAIN_FRACTION)
    if (shuffled.length >= 2) trainCount = Math.min(shuffled.length - 1, Math.max(1, trainCount))
    train.push(...shuffled.slice(0, trainCount))
    held.push(...shuffled.slice(trainCount))
  }
  return { train, held }
}

function printSplit(train: TrainCase[], held: TrainCase[]): void {
  const describe = (cs: TrainCase[]) => cs.map((c) => `${c.label}${isMultiShot(c) ? ' [multi]' : ''}${c.plan.hasDialogue ? ' [dlg]' : ''}`)
  const multi = (cs: TrainCase[]) => cs.filter(isMultiShot).length
  const dlg = (cs: TrainCase[]) => cs.filter((c) => c.plan.hasDialogue).length

  console.log(`\nSPLIT — ${train.length} train / ${held.length} held-out (of ${train.length + held.length})`)
  console.log(`  train: ${multi(train)} multi-shot, ${dlg(train)} with dialogue`)
  describe(train).forEach((l) => console.log(`    ${l}`))
  console.log(`  held-out: ${multi(held)} multi-shot, ${dlg(held)} with dialogue`)
  describe(held).forEach((l) => console.log(`    ${l}`))
  console.log('')
}

// ── candidate pool / Pareto front ──────────────────────────────────────────

interface Candidate {
  id: string
  instruction: string
  parentId: string | null
  /** Full train-split results — every pool member has ALL train cases scored. */
  results: Map<string, CaseEvalResult>
  trainMean: number
  heldOutResults?: Map<string, CaseEvalResult>
  heldOutMean?: number
}

interface RejectedChild {
  id: string
  instruction: string
  parentId: string
  /** Minibatch-only — a rejected child is never fully evaluated. */
  results: Map<string, CaseEvalResult>
  minibatchDelta: number
}

interface GuardRejection {
  attempt: number
  parentId: string
  missing: string[]
}

interface HistoryEntry {
  iteration: number
  parentId: string
  childId: string
  accepted: boolean
  minibatchDelta: number
  childTrainMean?: number
}

function mean(xs: readonly number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0
}

/** A candidate is on the front if it is the best on at least one train case.
 * Only pool members are considered (rejected children never enter the pool). */
function computeFront(pool: readonly Candidate[]): Candidate[] {
  const bestForCase = new Map<string, { id: string; score: number }>()
  for (const c of pool) {
    for (const [label, r] of c.results) {
      const cur = bestForCase.get(label)
      if (!cur || r.score > cur.score) bestForCase.set(label, { id: c.id, score: r.score })
    }
  }
  const frontIds = new Set([...bestForCase.values()].map((v) => v.id))
  return pool.filter((c) => frontIds.has(c.id)).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Evaluates every case not already in `reuse`, through the bounded pool, then
 * inserts results into the output map IN THE SAME ORDER a serial
 * left-to-right scan of `cases` would have — i.e. by scan position, never by
 * completion order — so the map's iteration order (and therefore
 * `candidates.jsonl`'s `train`/`heldOut` arrays, which are `[...map.values()]`)
 * is identical to a serial run regardless of which worker finishes first.
 */
async function evaluateFullSplit(instruction: string, cases: readonly TrainCase[], stats: RunStats, reuse?: Map<string, CaseEvalResult>): Promise<Map<string, CaseEvalResult>> {
  const out = new Map<string, CaseEvalResult>(reuse ?? [])
  const todo = cases.filter((c) => !out.has(c.label))
  if (todo.length) {
    const t0 = Date.now()
    const results = await poolMap(todo, CONCURRENCY, (c) => evaluate(instruction, c, stats))
    stats.poolWallMs += Date.now() - t0
    todo.forEach((c, i) => out.set(c.label, results[i]))
  }
  return out
}

// ── self-check (pure parts) — run only under --dry, no network ────────────

/**
 * `src/lib/**` may not be touched, and this optimiser's own pure parts (the
 * split, the placeholder guard, the cache key, the template fill) are
 * GEPA-specific rather than belonging in that shared library — so they get
 * no `.test.ts` under `npm test`'s `src`-only glob. This is the brief's own
 * documented fallback: "put a small self-check behind --dry and say so."
 */
async function selfCheck(cases: readonly TrainCase[]): Promise<{ name: string; pass: boolean; detail?: string }[]> {
  const results: { name: string; pass: boolean; detail?: string }[] = []
  const check = async (name: string, fn: () => void | Promise<void>) => {
    try {
      await fn()
      results.push({ name, pass: true })
    } catch (e) {
      results.push({ name, pass: false, detail: (e as Error).message })
    }
  }

  await check('poolMap: returns results in input order despite out-of-order completion', async () => {
    // Deliberately finishes out of order: item 3 resolves first (0ms), item 0 last (30ms).
    const items = [0, 1, 2, 3]
    const delays = [30, 10, 20, 0]
    const results = await poolMap(items, 4, (i) => new Promise<number>((resolve) => setTimeout(() => resolve(i), delays[i])))
    assert.deepEqual(results, items)
  })
  await check('poolMap: preserves input order under concurrency < item count', async () => {
    const items = [5, 1, 4, 2, 3]
    const order: number[] = []
    const results = await poolMap(items, 2, async (v) => {
      await new Promise((r) => setTimeout(r, v))
      order.push(v)
      return v * 10
    })
    assert.deepEqual(results, items.map((v) => v * 10))
    assert.notDeepEqual(order, items, 'test is meaningless if items happened to complete in input order')
  })
  await check("poolMap: one item's result does not affect sibling results", async () => {
    const items = [1, 2, 3, 4]
    const results = await poolMap(items, 2, async (v) => {
      if (v === 3) return { ok: false, v }
      await new Promise((r) => setTimeout(r, v))
      return { ok: true, v }
    })
    assert.deepEqual(results.map((r) => r.v), items)
    assert.equal(results[2].ok, false)
    assert.equal(results.filter((r) => r.ok).length, 3)
  })
  await check('dedupeInFlight: concurrent identical keys share exactly one underlying call', async () => {
    const map = new Map<string, Promise<number>>()
    let calls = 0
    const work = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 10))
      return 42
    }
    const [a, b, c] = await Promise.all([dedupeInFlight(map, 'k', work), dedupeInFlight(map, 'k', work), dedupeInFlight(map, 'k', work)])
    assert.equal(calls, 1)
    assert.deepEqual([a, b, c], [42, 42, 42])
    assert.equal(map.size, 0, 'in-flight entry must be cleaned up once settled')
  })
  await check('dedupeInFlight: a later, non-concurrent call for the same key re-runs work()', async () => {
    const map = new Map<string, Promise<number>>()
    let calls = 0
    const work = async () => {
      calls++
      return calls
    }
    const first = await dedupeInFlight(map, 'k', work)
    const second = await dedupeInFlight(map, 'k', work)
    assert.equal(calls, 2)
    assert.deepEqual([first, second], [1, 2])
  })
  await check('writeCache: atomic write is readable and leaves no temp file behind', () => {
    const dir = join(CACHE_DIR, '.selfcheck-tmp')
    try {
      writeCache(dir, 'selfcheck', 'hello world')
      assert.equal(readCache(dir, 'selfcheck'), 'hello world')
      const leftover = readdirSync(dir).filter((f) => f.includes('.tmp'))
      assert.deepEqual(leftover, [])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('stratifiedSplit: exhaustive and disjoint', () => {
    const { train, held } = stratifiedSplit(cases, mulberry32(42))
    assert.equal(train.length + held.length, cases.length)
    const labels = new Set([...train, ...held].map((c) => c.label))
    assert.equal(labels.size, cases.length)
  })
  await check('stratifiedSplit: both sides carry multi-shot and dialogue cases', () => {
    const { train, held } = stratifiedSplit(cases, mulberry32(42))
    assert.ok(train.some(isMultiShot), 'train has no multi-shot case')
    assert.ok(held.some(isMultiShot), 'held-out has no multi-shot case')
    assert.ok(train.some((c) => c.plan.hasDialogue), 'train has no dialogue case')
    assert.ok(held.some((c) => c.plan.hasDialogue), 'held-out has no dialogue case')
  })
  await check('stratifiedSplit: deterministic for a fixed seed', () => {
    const a = stratifiedSplit(cases, mulberry32(7))
    const b = stratifiedSplit(cases, mulberry32(7))
    assert.deepEqual(a.train.map((c) => c.label), b.train.map((c) => c.label))
  })
  await check('REQUIRED_PLACEHOLDERS matches the seed template', () => {
    assert.ok(REQUIRED_PLACEHOLDERS.length >= 7, `expected at least 7, got ${REQUIRED_PLACEHOLDERS.length}`)
    for (const p of REQUIRED_PLACEHOLDERS) assert.ok(SEED_INSTRUCTION.includes(`{{${p}}}`))
  })
  await check('missingPlaceholders: a full instruction has none missing', () => {
    assert.deepEqual(missingPlaceholders(SEED_INSTRUCTION), [])
  })
  await check('missingPlaceholders: dropping one is detected', () => {
    const withoutStory = SEED_INSTRUCTION.replace(/\{\{story\}\}/g, '')
    assert.deepEqual(missingPlaceholders(withoutStory), ['story'])
  })
  await check('cacheKeyFor: stable and content-addressed', () => {
    const k1 = cacheKeyFor('instr', 'story')
    const k2 = cacheKeyFor('instr', 'story')
    const k3 = cacheKeyFor('instr', 'other story')
    assert.equal(k1, k2)
    assert.notEqual(k1, k3)
  })
  await check('fillTemplate: substitutes every placeholder, leaves none behind', () => {
    const filled = fillTemplate(SEED_INSTRUCTION, 'THE STORY TEXT')
    assert.ok(filled.includes('THE STORY TEXT'))
    assert.ok(filled.includes('Ref2VA'))
    assert.equal(/\{\{\w+\}\}/.test(filled), false, 'a placeholder survived fillTemplate')
  })
  await check('computeFront: every case winner is represented, ties broken deterministically', () => {
    const a: Candidate = { id: 'a', instruction: '', parentId: null, results: new Map([['x', { label: 'x', score: 0.9, feedback: '', perDimension: {} as any, cacheHit: false, authorMs: 0, judgeMs: 0 }]]), trainMean: 0.9 }
    const b: Candidate = { id: 'b', instruction: '', parentId: null, results: new Map([['x', { label: 'x', score: 0.5, feedback: '', perDimension: {} as any, cacheHit: false, authorMs: 0, judgeMs: 0 }], ['y', { label: 'y', score: 0.8, feedback: '', perDimension: {} as any, cacheHit: false, authorMs: 0, judgeMs: 0 }]]), trainMean: 0.65 }
    const front = computeFront([a, b])
    assert.deepEqual(front.map((c) => c.id), ['a', 'b'])
  })

  return results
}

// ── budget estimate (--dry) ─────────────────────────────────────────────────

function printBudgetEstimate(trainSize: number, heldSize: number, iterations: number, minibatch: number, concurrency: number): void {
  const baseline = trainSize
  const iterRollouts = iterations * minibatch
  // Heuristic only — the README's own worked example (20 iterations, minibatch
  // 4) implies a Pareto front around 5 members by the end; scaled down for
  // fewer iterations. Printed explicitly so it reads as an assumption, not a
  // measurement.
  const frontEstimate = Math.min(5, Math.max(1, Math.ceil(iterations / 2)))
  const finalEval = frontEstimate * heldSize
  const totalRollouts = baseline + iterRollouts + finalEval
  const gpuMinutesSerial = (totalRollouts * 30) / 60
  // Same rollout count, wall-clock only — each batch of N cases (baseline,
  // one minibatch, one full re-eval, one held-out pass) runs through the
  // bounded pool, so its wall-clock is roughly 1/concurrency of running it
  // serially. This assumes every batch is at least `concurrency` cases wide,
  // which is an assumption, not a measurement — hence "≈".
  const gpuMinutesConcurrent = gpuMinutesSerial / concurrency
  const reflectCalls = iterations
  const reflectCostUsd = 0.32 + Math.max(0, reflectCalls - 1) * 0.02

  console.log('BUDGET ESTIMATE (--dry, no calls made)')
  console.log(`  concurrency: ${concurrency} (must track the llama.cpp server's --parallel slot count — see the header note)`)
  console.log(`  baseline eval on the trainset        ${baseline} rollouts`)
  console.log(`  ${iterations} iterations x minibatch ${minibatch}       ${iterRollouts} rollouts`)
  console.log(`  final eval of the Pareto front        ${finalEval} rollouts  (assuming a front of ~${frontEstimate})`)
  console.log(`  ----`)
  console.log(`  total                                 ${totalRollouts} rollouts`)
  console.log(`    ≈ ${gpuMinutesSerial.toFixed(0)} min GPU serial (task model, ~30s/call)`)
  console.log(`    ≈ ${gpuMinutesConcurrent.toFixed(0)} min GPU at concurrency ${concurrency}`)
  console.log(`  reflection                             ~${reflectCalls} claude -p calls  ≈ $${reflectCostUsd.toFixed(2)} (cache-warm, always serial)`)
  console.log('')
}

function printSeedEvalPlan(train: TrainCase[], held: TrainCase[]): void {
  console.log('SEED EVALUATION PLAN')
  console.log(`  1. evaluate(seed instruction, case) for each of the ${train.length} train cases -> seed's full train scores`)
  console.log(`  2. evaluate(seed instruction, case) for each of the ${held.length} held-out cases -> seed's held-out score, for the honest baseline`)
  console.log(`  each evaluate() = fill -> author on ${TASK_MODEL} -> parse -> judge on ${JUDGE_MODEL} (cache-checked first)`)
  console.log('')
}

// ── CLI ──────────────────────────────────────────────────────────────────

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? def : process.argv[i + 1]
}

function timestampedOutDir(): string {
  return join('probe/gepa/runs', new Date().toISOString().replace(/[:.]/g, '-'))
}

async function main() {
  const iterations = Number(arg('iterations', '10'))
  const minibatch = Number(arg('minibatch', '4'))
  const seed = Number(arg('seed', '42'))
  const trainsetPath = arg('trainset', 'probe/gepa/trainset.json')!
  const outDir = arg('out', timestampedOutDir())!
  const dry = process.argv.includes('--dry')

  const concurrency = Number(arg('concurrency', '4'))
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    console.error(`--concurrency must be a positive integer, got: ${arg('concurrency')}`)
    process.exit(1)
  }
  CONCURRENCY = concurrency

  if (!existsSync(trainsetPath)) {
    console.error(`trainset not found: ${trainsetPath} (build it with: npx tsx probe/gepa/trainset.ts)`)
    process.exit(1)
  }
  const cases: TrainCase[] = JSON.parse(readFileSync(trainsetPath, 'utf8'))
  if (!cases.length) {
    console.error(`trainset at ${trainsetPath} is empty`)
    process.exit(1)
  }

  const rng = mulberry32(seed)
  const { train, held } = stratifiedSplit(cases, rng)
  printSplit(train, held)

  if (dry) {
    console.log(`self-check (pure parts, no network):`)
    const checks = await selfCheck(cases)
    for (const c of checks) console.log(`  ${c.pass ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`)
    const failed = checks.filter((c) => !c.pass)
    console.log(`  ${checks.length - failed.length}/${checks.length} passed\n`)

    printSeedEvalPlan(train, held)
    printBudgetEstimate(train.length, held.length, iterations, minibatch, concurrency)
    if (failed.length) process.exit(1)
    return
  }

  // Fail fast, naming the missing variable — never fabricate a model.
  taskEndpoint()
  judgeApiKey()

  mkdirSync(CACHE_DIR, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  const stats = freshStats()

  console.log(`baseline: evaluating the seed instruction on ${train.length} train cases...`)
  const seedResults = await evaluateFullSplit(SEED_INSTRUCTION, train, stats)
  const seed_: Candidate = { id: 'seed', instruction: SEED_INSTRUCTION, parentId: null, results: seedResults, trainMean: mean([...seedResults.values()].map((r) => r.score)) }
  console.log(`  seed train mean: ${seed_.trainMean.toFixed(3)}`)

  const pool: Candidate[] = [seed_]
  const rejectedChildren: RejectedChild[] = []
  const guardRejections: GuardRejection[] = []
  const history: HistoryEntry[] = []

  let frontPointer = 0
  let nextChildId = 1
  let counter = 0
  let attempts = 0
  const maxAttempts = iterations * 5

  while (counter < iterations && attempts < maxAttempts) {
    attempts++
    const front = computeFront(pool)
    const parent = front[frontPointer % front.length]
    frontPointer++

    const worst3 = [...parent.results.values()].sort((a, b) => a.score - b.score).slice(0, 3)
    const failures = worst3.map((r) => ({ label: r.label, score: r.score, feedback: r.feedback }))

    console.log(`\n[attempt ${attempts}] reflecting off parent '${parent.id}' (worst: ${worst3.map((r) => r.label).join(', ')})`)
    const reflection = await reflect(buildReflectionPrompt({ currentInstruction: parent.instruction, failures }))
    stats.reflectMs += reflection.ms
    stats.reflectCostUsd += reflection.costUsd
    stats.reflectCalls++
    const childInstruction = reflection.text

    const missing = missingPlaceholders(childInstruction)
    if (missing.length) {
      console.log(`  REJECTED (placeholder guard) — missing: ${missing.join(', ')}`)
      guardRejections.push({ attempt: attempts, parentId: parent.id, missing })
      continue // does not consume the iteration budget
    }

    counter++
    const childId = `c${nextChildId++}`

    const worstLabels = new Set(worst3.map((r) => r.label))
    const others = train.filter((c) => !worstLabels.has(c.label))
    const extraCount = Math.max(0, minibatch - 3)
    const randomOthers = seededSample(others, extraCount, rng)
    const minibatchCases = [...worst3.map((r) => train.find((c) => c.label === r.label)!), ...randomOthers]

    const minibatchT0 = Date.now()
    const minibatchResults = await poolMap(minibatchCases, CONCURRENCY, (c) => evaluate(childInstruction, c, stats))
    stats.poolWallMs += Date.now() - minibatchT0
    const childMinibatch = new Map<string, CaseEvalResult>()
    minibatchCases.forEach((c, i) => childMinibatch.set(c.label, minibatchResults[i]))

    const childMinibatchMean = mean([...childMinibatch.values()].map((r) => r.score))
    const parentMinibatchMean = mean(minibatchCases.map((c) => parent.results.get(c.label)!.score))
    const delta = childMinibatchMean - parentMinibatchMean
    const accepted = childMinibatchMean > parentMinibatchMean

    console.log(`  [${childId}] minibatch mean ${childMinibatchMean.toFixed(3)} vs parent ${parentMinibatchMean.toFixed(3)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}) -> ${accepted ? 'ACCEPT, evaluating full train split' : 'discard'}`)

    if (accepted) {
      const fullResults = await evaluateFullSplit(childInstruction, train, stats, childMinibatch)
      const child: Candidate = { id: childId, instruction: childInstruction, parentId: parent.id, results: fullResults, trainMean: mean([...fullResults.values()].map((r) => r.score)) }
      pool.push(child)
      console.log(`  [${childId}] full train mean: ${child.trainMean.toFixed(3)}`)
      history.push({ iteration: counter, parentId: parent.id, childId, accepted: true, minibatchDelta: delta, childTrainMean: child.trainMean })
    } else {
      rejectedChildren.push({ id: childId, instruction: childInstruction, parentId: parent.id, results: childMinibatch, minibatchDelta: delta })
      history.push({ iteration: counter, parentId: parent.id, childId, accepted: false, minibatchDelta: delta })
    }
  }

  if (counter < iterations) {
    console.log(`\nSTOPPED EARLY at ${attempts} attempts: the placeholder guard kept rejecting reflections before reaching ${iterations} counted iterations.`)
  }

  // ── held-out ────────────────────────────────────────────────────────────
  console.log(`\nevaluating seed on ${held.length} held-out cases...`)
  seed_.heldOutResults = await evaluateFullSplit(SEED_INSTRUCTION, held, stats)
  seed_.heldOutMean = mean([...seed_.heldOutResults.values()].map((r) => r.score))

  const finalFront = computeFront(pool)
  console.log(`final Pareto front: ${finalFront.map((c) => c.id).join(', ')}`)
  for (const c of finalFront) {
    if (c.id === 'seed') continue
    console.log(`evaluating '${c.id}' on ${held.length} held-out cases...`)
    c.heldOutResults = await evaluateFullSplit(c.instruction, held, stats)
    c.heldOutMean = mean([...c.heldOutResults.values()].map((r) => r.score))
  }

  const winner = pool.reduce((best, c) => (c.trainMean > best.trainMean ? c : best), pool[0])
  if (!winner.heldOutResults) {
    console.log(`evaluating winner '${winner.id}' on ${held.length} held-out cases (not on the final front)...`)
    winner.heldOutResults = await evaluateFullSplit(winner.instruction, held, stats)
    winner.heldOutMean = mean([...winner.heldOutResults.values()].map((r) => r.score))
  }

  // ── output ──────────────────────────────────────────────────────────────
  writeFileSync(join(outDir, 'preset-c.txt'), winner.instruction, 'utf8')

  const lines: string[] = []
  const pushCandidate = (c: Candidate, evaluatedOn: 'full-train') => {
    lines.push(
      JSON.stringify({
        id: c.id,
        parentId: c.parentId,
        instruction: c.instruction,
        evaluatedOn,
        trainMean: c.trainMean,
        train: [...c.results.values()],
        heldOutMean: c.heldOutMean ?? null,
        heldOut: c.heldOutResults ? [...c.heldOutResults.values()] : null,
      }),
    )
  }
  for (const c of pool) pushCandidate(c, 'full-train')
  for (const r of rejectedChildren) {
    lines.push(
      JSON.stringify({
        id: r.id,
        parentId: r.parentId,
        instruction: r.instruction,
        evaluatedOn: 'minibatch',
        minibatchDelta: r.minibatchDelta,
        minibatch: [...r.results.values()],
      }),
    )
  }
  writeFileSync(join(outDir, 'candidates.jsonl'), lines.join('\n') + '\n', 'utf8')

  const cacheTotal = stats.cacheHits + stats.cacheMisses
  const cacheHitRate = cacheTotal ? stats.cacheHits / cacheTotal : 0
  const overfit = winner.trainMean > seed_.trainMean && (winner.heldOutMean ?? 0) <= (seed_.heldOutMean ?? 0)

  const report: string[] = []
  report.push(`# GEPA run — ${new Date().toISOString()}`)
  report.push('')
  report.push(`task model: ${TASK_MODEL} · judge: ${JUDGE_MODEL} · seed: ${seed} · iterations requested: ${iterations} · minibatch: ${minibatch}`)
  report.push('')
  report.push('## Split')
  report.push(`Train (${train.length}): ${train.map((c) => c.label).join(', ')}`)
  report.push(`Held-out (${held.length}): ${held.map((c) => c.label).join(', ')}`)
  report.push(`Train: ${train.filter(isMultiShot).length} multi-shot, ${train.filter((c) => c.plan.hasDialogue).length} with dialogue.`)
  report.push(`Held-out: ${held.filter(isMultiShot).length} multi-shot, ${held.filter((c) => c.plan.hasDialogue).length} with dialogue.`)
  report.push('')
  report.push('## Seed (preset A)')
  report.push(`train mean: ${seed_.trainMean.toFixed(3)} · held-out mean: ${(seed_.heldOutMean ?? 0).toFixed(3)}`)
  report.push('')
  report.push('## Winner (preset C) — chosen by train mean')
  report.push(`id: ${winner.id} (parent chain: ${(() => { const chain: string[] = []; let cur: Candidate | undefined = winner; while (cur) { chain.push(cur.id); cur = cur.parentId ? pool.find((p) => p.id === cur!.parentId) : undefined }; return chain.reverse().join(' -> ') })()})`)
  report.push(`train mean: ${winner.trainMean.toFixed(3)} · held-out mean: ${(winner.heldOutMean ?? 0).toFixed(3)}`)
  if (winner.id === 'seed') {
    report.push('The seed itself won on train mean — no reflection produced an improvement.')
  } else if (overfit) {
    report.push('**OVERFITTING**: train mean improved over the seed but the held-out mean did not. This is the expected failure mode at n≈12 — trust the held-out number, not the train one.')
  } else {
    report.push('Held-out improved along with train — the gain generalises past the 12 train cases.')
  }
  report.push('')
  report.push('## Final Pareto front (held-out evaluated)')
  report.push('| candidate | parent | train mean | held-out mean |')
  report.push('|---|---|---|---|')
  for (const c of finalFront) report.push(`| ${c.id} | ${c.parentId ?? '—'} | ${c.trainMean.toFixed(3)} | ${(c.heldOutMean ?? 0).toFixed(3)} |`)
  report.push('')
  report.push('## Iteration history')
  report.push('| iter | parent | child | outcome | minibatch Δ | child train mean |')
  report.push('|---|---|---|---|---|---|')
  for (const h of history) {
    report.push(`| ${h.iteration} | ${h.parentId} | ${h.childId} | ${h.accepted ? 'accepted' : 'rejected (minibatch regression)'} | ${h.minibatchDelta >= 0 ? '+' : ''}${h.minibatchDelta.toFixed(3)} | ${h.childTrainMean !== undefined ? h.childTrainMean.toFixed(3) : '—'} |`)
  }
  report.push('')
  if (guardRejections.length) {
    report.push('## Placeholder-guard rejections (not counted as iterations)')
    report.push('| attempt | parent | missing placeholders |')
    report.push('|---|---|---|')
    for (const g of guardRejections) report.push(`| ${g.attempt} | ${g.parentId} | ${g.missing.join(', ')} |`)
    report.push('')
  }
  report.push('## Cost')
  report.push(`GPU wall-clock (task-model authoring only): ${(stats.authorMs / 1000 / 60).toFixed(1)} min (${stats.authorMs} ms across ${cacheTotal} evaluate() calls, ${stats.cacheMisses} of which authored)`)
  report.push(`Judge wall-clock (network, not GPU): ${(stats.judgeMs / 1000 / 60).toFixed(1)} min`)
  report.push(`Reflection: ${stats.reflectCalls} calls, ${(stats.reflectMs / 1000 / 60).toFixed(1)} min, $${stats.reflectCostUsd.toFixed(4)}`)
  report.push(`Cache hit rate: ${(cacheHitRate * 100).toFixed(1)}% (${stats.cacheHits}/${cacheTotal})`)
  report.push('')
  const summedCallMs = stats.authorMs + stats.judgeMs
  const parallelism = stats.poolWallMs > 0 ? summedCallMs / stats.poolWallMs : 1
  report.push('## Concurrency')
  report.push(`Bound: ${CONCURRENCY} (must track the llama.cpp server's --parallel slot count)`)
  report.push(
    `Pool wall-clock: ${(stats.poolWallMs / 1000 / 60).toFixed(1)} min · summed call time (author + judge): ${(summedCallMs / 1000 / 60).toFixed(1)} min · achieved parallelism: ${parallelism.toFixed(2)}x`,
  )
  report.push('(Reflection is excluded — it is one serial `claude -p` call per iteration, never pooled.)')
  report.push('')
  writeFileSync(join(outDir, 'report.md'), report.join('\n'), 'utf8')

  console.log(`\nwrote ${outDir}/preset-c.txt, report.md, candidates.jsonl`)
  console.log(`seed train/held-out: ${seed_.trainMean.toFixed(3)} / ${(seed_.heldOutMean ?? 0).toFixed(3)}`)
  console.log(`winner (${winner.id}) train/held-out: ${winner.trainMean.toFixed(3)} / ${(winner.heldOutMean ?? 0).toFixed(3)}${overfit ? '  [OVERFIT — held-out did not improve]' : ''}`)
  console.log(`cache hit rate: ${(cacheHitRate * 100).toFixed(1)}%`)
  console.log(
    `concurrency ${CONCURRENCY}: pool wall-clock ${(stats.poolWallMs / 1000 / 60).toFixed(1)} min vs summed call time ${(summedCallMs / 1000 / 60).toFixed(1)} min -> ${parallelism.toFixed(2)}x achieved parallelism`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
