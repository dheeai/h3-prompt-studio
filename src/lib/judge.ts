import type { Finding, H3Mode } from './types'
import { findingsToText } from './lint'
import { pairShotsWithPrompt, splitClipLevelSections, splitPromptShots } from './promptShots'

/**
 * JUDGE — score an H3 prompt against a rubric, via a System One model.
 *
 * PURE. No `fetch`, no network, no new dependency — the only place a request
 * actually leaves this process is `probe/judge/judge.ts`. This file just
 * builds the request body/bodies, and turns a model's response plus the
 * deterministic `lint()` findings into a score GEPA can optimise against.
 *
 * VENDOR-NEUTRAL ON PURPOSE. "System One" is TypeSafe's own name for this
 * class of model (`docs/concepts/system-one`) and it is not the only one:
 * Laya (`convaiinnovations/laya`, Apache-2.0, self-hosted) exposes the same
 * three primitives — a `{type, instructions, criteria}` question in a map
 * you key, an answer of the same `noul`/`score`/`choice` shape back under
 * that key. Only the transport and the `model` field differ, so nothing in
 * this file or `judgeRubric.ts` names either vendor: `buildJudgeRequest`
 * takes `model` as a parameter (default `'jev-latest'`, since Jev is what we
 * actually have a key for), and `SystemOneAnswer`/`SystemOneAnswers` name the
 * one answer shape both vendors return.
 *
 * THE ONE HARD DIFFERENCE: CONTEXT BUDGET. Jev allows 64k tokens per request
 * (32k for `state` plus the single longest question). Laya's English
 * checkpoint allows **512 tokens total** — question + criteria + `state`
 * combined (1024 for its multilingual and typed-decisions checkpoints). An H3
 * clip prompt runs ~2,500-3,000 tokens, so it does not fit Laya as whole-
 * prompt state at all; Laya would have to be fed one shot's fragment
 * (`splitPromptShots`) at a time. That is the entire reason a question
 * declares a `scope`: `'prompt'` questions need the whole clip (continuity
 * across shots, "does every approved beat appear," anything comparing one
 * shot to another); `'shot'` questions need only one shot's own fragment
 * (does THIS shot's action read as a chain, is THIS shot's camera move
 * motivated). `buildJudgeRequest` partitions the rubric by scope and returns
 * one request per scope-instance — a single `'prompt'` request plus one
 * `'shot'` request per approved shot — so a `'shot'`-only rubric run against
 * Laya never has to send more than one shot's text at a time, while the very
 * same rubric run against Jev still works exactly as before (Jev's budget
 * has room to spare either way).
 *
 * WHY A VECTOR, NOT A SCALAR. `scoreJudge` returns one number PER DIMENSION,
 * weight-normalised to [0,1] — never a single blended score as the primary
 * result. GEPA exists to exploit a Pareto front (a candidate that trades
 * `camera` for `dialogue` is a genuinely different candidate, not a worse
 * one), and collapsing the vector before GEPA sees it throws that away.
 * `weightedTotal` is a separate, clearly-opt-in helper for the cases that
 * really do want one number — a status line, a leaderboard, an optimiser
 * that demands a scalar and does its own weighting.
 *
 * WHY `expect: true | false`, NEVER A SIGNED WEIGHT. A Noul question always
 * asks a "does this hold" question; `expect` says which answer (true or
 * false) is the GOOD one. Contribution is `expect ? p : 1 - p` — continuous
 * in [0,1], which is the entire reason to use a System One judge rather than
 * a yes/no one: it gives GEPA a gradient (0.51 vs 0.94) instead of a cliff (0
 * vs 1). A SIGNED weight (+1/-1 multiplied into `p`) would silently invert a
 * dimension on a copy-paste error and read exactly like a correct one at a
 * glance; `expect: false` reads wrong out loud when someone reviews the
 * rubric.
 *
 * WHY SCORE QUESTIONS SUM PROBABILITY MASS, NEVER READ `.score`. The Jev
 * jaggedness doc is explicit: its score levels are not calibrated finely
 * enough to reconstruct a magnitude between two levels, so `scoreJudge`
 * never looks at the API's own interpolated `score` field. It reads
 * `probabilities` and sums the mass sitting on whichever levels the rubric
 * names as "good" (`ScoreQuestion.goodLevels`) — a coarser read, but the one
 * the model actually supports.
 *
 * WHAT NEVER REACHES A MODEL. `ExactQuestion.check(ctx)` runs entirely in
 * this process and returns a number in [0,1] or `null` (not applicable —
 * kept OUT of a dimension's denominator, never scored as zero). Anything
 * countable — shot counts, frame/duration arithmetic, marker hygiene,
 * literal vocabulary presence — is an Exact question calling existing code
 * (`promptShots.ts`, `geometry.ts`), per the jaggedness doc's "these models
 * cannot count" and "keep the arithmetic in code". `buildJudgeRequest` drops
 * every Exact question before it can leave the process.
 */

// ── the seven dimensions ────────────────────────────────────────────────────

export type JudgeDimension = 'direction' | 'acting' | 'camera' | 'shots' | 'dialogue' | 'pacing' | 'sound'

export const JUDGE_DIMENSIONS: readonly JudgeDimension[] = ['direction', 'acting', 'camera', 'shots', 'dialogue', 'pacing', 'sound']

/**
 * What slice of the clip a question needs as `state` — see the module
 * comment's "ONE HARD DIFFERENCE" section. `'prompt'` gets the whole
 * rendered prompt; `'shot'` gets one shot's own fragment, never the rest of
 * the clip.
 */
export type QuestionScope = 'prompt' | 'shot'

// ── context — the minimum each question needs ──────────────────────────────

/**
 * One approved shot from the clip's plan. Deliberately just these three
 * fields — camera/acting decisions already made for it are judged through
 * the rendered PROMPT text (`JudgeContext.promptText`), never re-fed here.
 * The jaggedness doc penalises a large state full of detail a given question
 * does not need; carrying a whole `DirectedShot` into every judge call would
 * be exactly that.
 */
export interface JudgeShot {
  /** 1-based, matching the `[Shot N]` marker this shot should appear under. */
  index: number
  summary: string
  seconds: number
}

export interface JudgeContext {
  /** The rendered H3 prompt under judgement — the six-section Ref2VA body,
   * or a base mode's three-field body. This is a `'prompt'`-scoped
   * question's `state`; a `'shot'`-scoped question gets one fragment of it. */
  promptText: string
  mode: H3Mode
  approvedShots: JudgeShot[]
  /** The clip's authored length, in seconds — from the plan, not parsed back
   * out of the prose. */
  clipSeconds: number
  /** False for a silent clip. Gates every dialogue question and the
   * dialogue Exact check off entirely via `appliesWhen`, rather than letting
   * them score a manufactured zero against a clip that was never meant to speak. */
  hasDialogue: boolean
  /** False for a clip with no people in it (an architectural flythrough, a
   * landscape, a product shot with no hands). Gates every acting question,
   * plus `direction.objective-stated`/`direction.obstacle-concrete`, off
   * entirely via `appliesWhen` — the same "leave the denominator, never score
   * a manufactured zero" treatment `hasDialogue` gets. Measured: an
   * architectural FPV drone brief scored `acting` 0.237 with `hand-detail`
   * 0.03 and `attention-stated` 0.05 — there were no hands or eyes to find. */
  hasCharacters: boolean
}

// ── question definitions ────────────────────────────────────────────────────

interface QuestionBase {
  /** Chosen by us, never by the model — the same id names the request entry,
   * the response lookup and the breakdown row, so there is exactly one place
   * a typo could hide. */
  id: string
  dimension: JudgeDimension
  scope: QuestionScope
  /**
   * Meaningful only when `scope === 'shot'`. Set (by the generated per-shot
   * fan-out) to pin a question to exactly one approved shot. Left unset on a
   * generic shot-scoped template (e.g. "is the camera move motivated") to
   * mean "ask this same question against every approved shot's own
   * fragment" — `buildJudgeRequest`/`scoreJudge` instantiate it once per shot.
   */
  shotIndex?: number
  /**
   * Skipped — front and back — when this returns false. A dropped question
   * is removed from its dimension's denominator entirely; it is never scored
   * as zero. This is how a silent clip's dialogue questions, or a question
   * that needs at least one approved shot, opt out without manufacturing
   * noise (the brief's own phrase for what a forced dialogue answer would be).
   */
  appliesWhen?(ctx: JudgeContext): boolean
  /** Relative weight within its dimension. Defaults to 1. */
  weight?: number
}

export interface NoulQuestion extends QuestionBase {
  kind: 'noul'
  instructions: string
  /** Aligned with `instructions`, never contradicting it — jaggedness #7. */
  criteria?: { true?: string; false?: string }
  /** The GOOD answer. See the module comment: never a signed weight. */
  expect: boolean
}

export interface ScoreQuestion extends QuestionBase {
  kind: 'score'
  instructions: string
  /** Ordered level descriptions — index 0..n-1, the same order the API
   * echoes back under `legend`/`probabilities`. At least two levels. */
  criteria: string[]
  /** Indices into `criteria` whose probability mass counts as "good".
   * Summed, never interpolated between levels — see the module comment. */
  goodLevels: number[]
}

export interface ExactQuestion extends QuestionBase {
  kind: 'exact'
  /** Runs in THIS process. Returns a number in [0,1], or `null` meaning not
   * applicable — never sent to a model. */
  check(ctx: JudgeContext): number | null
}

export type JudgeQuestion = NoulQuestion | ScoreQuestion | ExactQuestion
/** The subset that actually leaves the process, sent to a System One model. */
export type ModelQuestion = NoulQuestion | ScoreQuestion

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0
  return Math.min(1, Math.max(0, n))
}

// ── the request — api.md's exact wire shape, model-agnostic ────────────────

export interface NoulRequestQuestion {
  type: 'noul'
  instructions: string
  criteria?: { true?: string; false?: string }
}

export interface ScoreRequestQuestion {
  type: 'score'
  instructions: string
  criteria: string[]
}

export type RequestQuestion = NoulRequestQuestion | ScoreRequestQuestion

export interface SystemOneRequest {
  state: string
  model: string
  questions: Record<string, RequestQuestion>
}

/** One request, tagged with the scope (and, for `'shot'`, which approved
 * shot) it was built for — a caller (the probe CLI) needs this to know which
 * `ScopedAnswers` entry a given response belongs to. */
export interface ScopedRequest {
  scope: QuestionScope
  shotIndex?: number
  request: SystemOneRequest
}

function toRequestQuestion(q: ModelQuestion): RequestQuestion {
  return q.kind === 'noul'
    ? { type: 'noul', instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
    : { type: 'score', instructions: q.instructions, criteria: q.criteria }
}

function toRequest(state: string, questions: readonly ModelQuestion[], model: string): SystemOneRequest {
  const map: Record<string, RequestQuestion> = {}
  for (const q of questions) map[q.id] = toRequestQuestion(q)
  return { state, model, questions: map }
}

/**
 * The exact `{ state, model, questions }` body/bodies from `api.md`,
 * containing ONLY the noul/score questions — an Exact question never leaves
 * this function, and a question whose `appliesWhen` fails is dropped before
 * it is ever built, not sent and discarded.
 *
 * Returns ONE `'prompt'`-scoped request (when any prompt-scoped question
 * applies) plus one `'shot'`-scoped request PER approved shot that actually
 * has a matching `[Shot N]` fragment in the prompt (when any shot-scoped
 * question applies) — never a single request mixing both scopes, since a
 * `'shot'` request's `state` must be that one shot's fragment alone, not the
 * whole clip. `model` defaults to `'jev-latest'`; pass a different id (or a
 * self-hosted Laya endpoint's own model name) to target another System One
 * service with the identical rubric.
 */
export function buildJudgeRequest(ctx: JudgeContext, rubric: readonly JudgeQuestion[], model = 'jev-latest'): ScopedRequest[] {
  const applicable = rubric.filter((q): q is ModelQuestion => q.kind !== 'exact' && (!q.appliesWhen || q.appliesWhen(ctx)))
  const requests: ScopedRequest[] = []

  const promptScoped = applicable.filter((q) => q.scope === 'prompt')
  if (promptScoped.length) {
    requests.push({ scope: 'prompt', request: toRequest(ctx.promptText, promptScoped, model) })
  }

  const shotScoped = applicable.filter((q) => q.scope === 'shot')
  if (shotScoped.length) {
    const split = splitPromptShots(splitClipLevelSections(ctx.promptText).shotSectionBody)
    const { pairs } = pairShotsWithPrompt(ctx.approvedShots, split)
    for (const pair of pairs) {
      if (!pair.fragment) continue
      const qs = shotScoped.filter((q) => q.shotIndex === undefined || q.shotIndex === pair.shot.index)
      if (!qs.length) continue
      const state = pair.fragment.marker + pair.fragment.text
      requests.push({ scope: 'shot', shotIndex: pair.shot.index, request: toRequest(state, qs, model) })
    }
  }

  return requests
}

// ── the response — parsed defensively, never re-validated past that ────────

export interface NoulAnswer {
  type: 'noul'
  noul: number
}

export interface ScoreAnswer {
  type: 'score'
  score: number
  legend: Record<string, string>
  probabilities: Record<string, number>
  confidence: number
}

export interface ChoiceAnswer {
  type: 'choice'
  choice: string
  probabilities: Record<string, number>
  confidence: number
}

/**
 * Every answer shape a System One model can return — Jev's `POST
 * /v1/systemone` or a self-hosted Laya's `agent.predict`, both alike. Named
 * generically because it IS the shared boundary: `scoreJudge` only ever
 * looks for `noul`/`score`. `choice` has no rubric question that produces it
 * today, but the type is complete because the wire shape is.
 */
export type SystemOneAnswer = NoulAnswer | ScoreAnswer | ChoiceAnswer

/** One vendor response's `answers` map, keyed by the question ids from the
 * matching `ScopedRequest`. The boundary a caller parses network JSON into
 * before handing it to `scoreJudge` — deliberately untyped past this map's
 * shape, since that map IS what both vendors guarantee and nothing more. */
export type SystemOneAnswers = Record<string, SystemOneAnswer | undefined>

export interface SystemOneUsage {
  input_tokens: number
  output_tokens: number
}

export interface SystemOneResponse {
  model: string
  answers: SystemOneAnswers
  usage: SystemOneUsage
}

/** One response, tagged the same way its `ScopedRequest` was — so
 * `scoreJudge` can route each shot's answers back to the right shot. */
export interface ScopedAnswers {
  scope: QuestionScope
  shotIndex?: number
  answers: SystemOneAnswers
}

// ── scoring ──────────────────────────────────────────────────────────────

export interface QuestionResult {
  /** The rubric question's own id, UNLESS this row is one instantiation of a
   * generic shot-scoped template across several shots — then `#shot<N>` is
   * appended, so e.g. `camera.motivated` asked against four approved shots
   * produces four distinguishable rows rather than overwriting one another. */
  id: string
  dimension: JudgeDimension
  kind: 'noul' | 'score' | 'exact'
  /** False when `appliesWhen` opted this out, an Exact check returned
   * `null`, no shot ever supplied an answer for a shot-scoped template, or
   * the answer for a sent question never came back (or came back malformed)
   * — the cases that must NOT be silently read as zero. */
  applied: boolean
  weight: number
  /** The raw read off the answer: a Noul's `noul`, a Score's summed
   * good-level mass, or an Exact check's own [0,1]. Unset when not applied. */
  probability?: number
  /** In [0,1], oriented so higher is always better — `expect:false` inverts
   * a Noul HERE, once, never at the rubric-authoring source. Unset when not
   * applied. */
  contribution?: number
}

export interface DimensionScore {
  /** Weight-normalised [0,1]. `null` when nothing in this dimension applied
   * — never a fabricated 0. */
  score: number | null
  /** Sum of weights that actually applied (the denominator `score` used). */
  weight: number
  questionCount: number
  appliedCount: number
}

export interface JudgeScore {
  dimensions: Record<JudgeDimension, DimensionScore>
  /** Every question the rubric named, applied or not — the audit trail. A
   * generic shot-scoped template contributes one row per shot it reached. */
  questions: QuestionResult[]
}

function notApplied(q: JudgeQuestion, weight: number, id: string): QuestionResult {
  return { id, dimension: q.dimension, kind: q.kind, applied: false, weight }
}

function pushAnswerResult(out: QuestionResult[], q: ModelQuestion, weight: number, id: string, answer: SystemOneAnswer | undefined): void {
  if (!answer) {
    out.push({ id, dimension: q.dimension, kind: q.kind, applied: false, weight })
    return
  }
  if (q.kind === 'noul') {
    if (answer.type !== 'noul' || typeof answer.noul !== 'number') {
      out.push({ id, dimension: q.dimension, kind: 'noul', applied: false, weight })
      return
    }
    const p = clamp01(answer.noul)
    out.push({ id, dimension: q.dimension, kind: 'noul', applied: true, weight, probability: p, contribution: q.expect ? p : 1 - p })
    return
  }
  if (answer.type !== 'score' || !answer.probabilities) {
    out.push({ id, dimension: q.dimension, kind: 'score', applied: false, weight })
    return
  }
  const mass = q.goodLevels.reduce((sum, level) => sum + (answer.probabilities[String(level)] ?? 0), 0)
  const c = clamp01(mass)
  out.push({ id, dimension: q.dimension, kind: 'score', applied: true, weight, probability: c, contribution: c })
}

/**
 * The per-dimension vector, plus the per-question breakdown. Defensive at the
 * boundary — a missing or malformed answer is treated as not-applied, never
 * as a zero — but does not re-validate what the API guarantees (id
 * correspondence, `probabilities` summing to 1, etc.).
 *
 * `responses` is every `ScopedAnswers` the caller collected — normally
 * exactly the answers to whatever `buildJudgeRequest` returned, in any
 * order. A generic shot-scoped template (no `shotIndex` of its own) is
 * looked up in EVERY `'shot'` response that reached it, producing one row
 * per shot; a question pinned to one shot (the generated fan-out) is looked
 * up only in that shot's own response.
 */
export function scoreJudge(ctx: JudgeContext, rubric: readonly JudgeQuestion[], responses: readonly ScopedAnswers[]): JudgeScore {
  const promptAnswers: SystemOneAnswers = responses.find((r) => r.scope === 'prompt')?.answers ?? {}
  const shotAnswers = new Map<number, SystemOneAnswers>()
  for (const r of responses) {
    if (r.scope === 'shot' && r.shotIndex !== undefined) shotAnswers.set(r.shotIndex, r.answers)
  }

  const questions: QuestionResult[] = []

  for (const q of rubric) {
    const weight = q.weight ?? 1
    if (q.appliesWhen && !q.appliesWhen(ctx)) {
      questions.push(notApplied(q, weight, q.id))
      continue
    }

    if (q.kind === 'exact') {
      const value = q.check(ctx)
      if (value === null) {
        questions.push(notApplied(q, weight, q.id))
      } else {
        const c = clamp01(value)
        questions.push({ id: q.id, dimension: q.dimension, kind: 'exact', applied: true, weight, probability: c, contribution: c })
      }
      continue
    }

    if (q.scope === 'prompt') {
      pushAnswerResult(questions, q, weight, q.id, promptAnswers[q.id])
      continue
    }

    // scope === 'shot'
    if (q.shotIndex !== undefined) {
      pushAnswerResult(questions, q, weight, q.id, shotAnswers.get(q.shotIndex)?.[q.id])
      continue
    }

    let reachedAnyShot = false
    for (const shot of ctx.approvedShots) {
      const answers = shotAnswers.get(shot.index)
      if (!answers) continue
      reachedAnyShot = true
      pushAnswerResult(questions, q, weight, `${q.id}#shot${shot.index}`, answers[q.id])
    }
    if (!reachedAnyShot) questions.push(notApplied(q, weight, q.id))
  }

  const dimensions = {} as Record<JudgeDimension, DimensionScore>
  for (const dim of JUDGE_DIMENSIONS) {
    const inDim = questions.filter((q) => q.dimension === dim)
    const applied = inDim.filter((q) => q.applied && q.contribution !== undefined)
    const totalWeight = applied.reduce((s, q) => s + q.weight, 0)
    const score = totalWeight > 0 ? applied.reduce((s, q) => s + q.weight * (q.contribution ?? 0), 0) / totalWeight : null
    dimensions[dim] = { score, weight: totalWeight, questionCount: inDim.length, appliedCount: applied.length }
  }

  return { dimensions, questions }
}

/**
 * A single scalar, for a status line or an optimiser that demands one — NOT
 * what `scoreJudge` returns, and not what GEPA should reflect on. See the
 * module comment for why the vector is the primary result.
 */
export function weightedTotal(score: JudgeScore): number | null {
  const applied = JUDGE_DIMENSIONS.map((d) => score.dimensions[d]).filter((d) => d.score !== null)
  const totalWeight = applied.reduce((s, d) => s + d.weight, 0)
  if (!applied.length || totalWeight === 0) return null
  return applied.reduce((s, d) => s + d.weight * (d.score as number), 0) / totalWeight
}

// ── feedback — the text GEPA actually reflects on ──────────────────────────

/**
 * Assemble the natural-language feedback GEPA reflects on. A System One
 * model never produces text, so this is built entirely in code: the weakest
 * dimensions, the lowest-scoring questions named with their probabilities,
 * then `findingsToText(findings)` — which already quotes the offending spans
 * from the deterministic check. Deterministic and length-bounded: fixed caps
 * on how many dimensions/questions are named, and `findings` comes from
 * `lint()`, whose own check list is finite.
 */
export function judgeFeedback(score: JudgeScore, findings: Finding[]): string {
  const lines: string[] = []

  const dims = JUDGE_DIMENSIONS.map((dim) => ({ dim, ...score.dimensions[dim] }))
    .filter((d) => d.score !== null)
    .sort((a, b) => (a.score as number) - (b.score as number))

  if (dims.length) {
    lines.push('Weakest dimensions:')
    for (const d of dims.slice(0, 3)) {
      lines.push(`  ${d.dim}: ${(d.score as number).toFixed(2)} (${d.appliedCount}/${d.questionCount} questions applied)`)
    }
  }

  const weakestQuestions = score.questions
    .filter((q): q is QuestionResult & { contribution: number } => q.applied && q.contribution !== undefined)
    .sort((a, b) => a.contribution - b.contribution)
    .slice(0, 5)

  if (weakestQuestions.length) {
    lines.push('Lowest-scoring questions:')
    for (const q of weakestQuestions) {
      const p = q.kind !== 'exact' && q.probability !== undefined ? ` (p=${q.probability.toFixed(2)})` : ''
      lines.push(`  [${q.dimension}] ${q.id}: ${q.contribution.toFixed(2)}${p}`)
    }
  }

  lines.push('')
  lines.push('Deterministic findings:')
  lines.push(findingsToText(findings))

  return lines.join('\n')
}
