import { CAMERA_TERMS } from './direction'
import { hasPromptShotIssues, pairShotsWithPrompt, promptShotIssues, splitClipLevelSections, splitPromptShots, type SplitPrompt } from './promptShots'
import { framesForSeconds } from './geometry'
import { lint } from './lint'
import type { ExactQuestion, JudgeContext, JudgeQuestion, NoulQuestion } from './judge'

/**
 * THE RUBRIC — one reviewable file, per TypeSafe's own guidance: questions
 * and thresholds live together so a human (the founder) can review them
 * without spelunking. This file is the one meant to be edited by hand.
 *
 * Sourced from `singularity_spec.md` (§8 action chains, §9 camera, §10
 * physical feedback, §13 observable acting, §14 dialogue/speakers and sound
 * effects, §16 failure modes) and from the `h3-prompting`/`h3-acting` skills
 * bundled at `public/skills/`. Every judgement question below asks something a READER
 * must decide — whether an action reads as a chain, whether a camera move is
 * motivated, whether acting is behaviour rather than a label. Anything
 * countable (shot counts, marker hygiene, frame/duration arithmetic, literal
 * vocabulary presence) is an `exact` question that calls existing code
 * instead — see `judge.ts`'s module comment, "Jev cannot count".
 *
 * SCOPE, assigned honestly per question (`judge.ts`'s module comment has the
 * budget reason this exists at all): a question that only needs to look at
 * ONE shot's own fragment is `'shot'` — action-chain, camera-motivation and
 * whether emotion reads as observable behaviour, since each is a fact about
 * one shot at a time. A question that has to compare shots to each other, or
 * asks whether something is true ANYWHERE across the whole clip ("does at
 * least one shot..."), cannot be answered from a single fragment and stays
 * `'prompt'`.
 */

// ── shared helpers over the rendered prompt (for the Exact questions) ──────

/** The one section that actually carries `[Shot N]` markup, split into its
 * per-shot fragments. Every exact question below that needs to look at a
 * shot works off this, rather than re-deriving it. */
function shotSplit(ctx: JudgeContext): SplitPrompt {
  return splitPromptShots(splitClipLevelSections(ctx.promptText).shotSectionBody)
}

// ── pacing thresholds — SEEDED GUESSES, not measured values ────────────────
//
// Every constant below was chosen by inspection, not derived from data, and
// exists to be tuned once real films are scored against it — see the
// pacing-rework brief this file was rewritten for (`pacing` used to fail to
// discriminate a careful prompt from a deliberately terrible one; the exact
// checks below are its measured replacement).

/** Below this many timeline segments, "rhythm variance" and "one shot
 * dominating" are not meaningful questions — a one-take clip's single
 * segment cannot vary against itself, and calling it "the monolith" would
 * punish a deliberate choice. Applies whether the segments came from
 * `[Shot N]` markers or from explicit time ranges in the prose — see
 * `pacingTimeline` below. */
export const PACING_MIN_SEGMENTS_FOR_VARIANCE = 3

/** A segment duration below this many milliseconds is a flash frame — too
 * brief for H3 to meaningfully render, whatever it is trying to show. */
export const PACING_FLASH_FLOOR_MS = 1000

/** The coefficient-of-variation endpoints `pacing.rhythm-variance` maps to
 * [0,1]: at or below FLOOR the pacing reads as perfectly uniform (0); at or
 * above HEALTHY it reads as healthily varied (1). Linear between them. */
export const PACING_RHYTHM_CV_FLOOR = 0
export const PACING_RHYTHM_CV_HEALTHY = 0.5

/** The fraction of the clip's total duration one segment can occupy before
 * it reads as "the monolith" dragging the rest of the clip along with it. */
export const PACING_MONOLITH_MAX_SHARE = 0.6

/**
 * A timeline extracted from the rendered prompt, for the pacing exact
 * checks below — durations in milliseconds, in playback order.
 *
 * TWO WAYS A PROMPT STATES ITS OWN TIMELINE, tried in order:
 *
 *  1. `[Shot N] At MM:SS.mmm` markers (`splitPromptShots`) — the common
 *     case. `[Shot 1]` legitimately carries no timestamp and means 0; the
 *     final segment runs to `ctx.clipSeconds`.
 *  2. Failing that (no `[Shot N]` markers at all), explicit time ranges
 *     written directly in the prose — `M:SS-M:SS` / `MM:SS-MM:SS`,
 *     tolerating a hyphen, en dash or em dash and optional surrounding
 *     spaces. Measured: an FPV drone brief with no shot markers wrote its
 *     entire timeline this way ("0:00-0:03 Start low...", "0:03-0:06 Follow
 *     the path upward...", six segments, durations 3,3,3,2,2,2s, CV ≈ 0.20).
 *     At least two matches are required before trusting it as a timeline
 *     rather than one incidental number that happens to look like a range.
 *
 * THREE OUTCOMES, KEPT DISTINCT — this is the part worth reading carefully,
 * because the two failure states look identical at the call site (both mean
 * "the caller gets nothing usable") but must NOT be scored the same way:
 *
 *  - `{ ok: true, durationsMs }` — a timeline was found. 3+ segments is
 *    enough to compute a distribution statistic (variance, dominant share);
 *    1-2 is not, and a caller that needs 3+ must return `null` itself
 *    (structurally not applicable — a declared one-take is legitimately one
 *    shot and must not be punished for it).
 *  - `{ ok: false, reason: 'insufficient-context' }` — the prompt DOES carry
 *    `[Shot N]` markers, but the caller never supplied `ctx.clipSeconds`, so
 *    the final segment's end is unknowable. This is a gap in what the
 *    CALLER gave us, not a defect in the prompt — a check should read this
 *    as `null`, same as any other missing-context case.
 *  - `{ ok: false, reason: 'no-timeline' }` — NEITHER notation produced
 *    anything at all. This is a real defect in the prompt itself (it has no
 *    legible time structure for an H3-destined clip), and a check MUST
 *    score this **0, never `null`**. Scoring it `null` would drop the
 *    question out of its dimension's denominator — exactly like `camera`
 *    used to go dark on a clip with no `[Shot N]` markers — and a defect
 *    that removes itself from the average makes the overall score go UP,
 *    which a missing artifact must never do.
 */
export type PacingTimeline = { ok: true; durationsMs: number[] } | { ok: false; reason: 'insufficient-context' | 'no-timeline' }

/** `M:SS-M:SS` / `MM:SS-MM:SS`, dash-tolerant. No fractional seconds — the
 * measured range notation doesn't carry them; `[Shot N] At MM:SS.mmm` is the
 * notation that does, and that path is handled separately above. */
const RANGE_RE = /(\d{1,3}):(\d{2})\s*[-–—]\s*(\d{1,3}):(\d{2})/g

function rangeMs(mm: string, ss: string): number {
  return Number(mm) * 60_000 + Number(ss) * 1000
}

function pacingTimeline(ctx: JudgeContext): PacingTimeline {
  const split = shotSplit(ctx)
  if (split.shots.length > 0) {
    if (!ctx.clipSeconds) return { ok: false, reason: 'insufficient-context' }
    const totalMs = ctx.clipSeconds * 1000
    const durationsMs = split.shots.map((shot, i) => {
      const start = shot.atMs ?? 0
      const end = i + 1 < split.shots.length ? (split.shots[i + 1].atMs ?? start) : totalMs
      return end - start
    })
    return { ok: true, durationsMs }
  }

  const matches = [...ctx.promptText.matchAll(RANGE_RE)]
  if (matches.length < 2) return { ok: false, reason: 'no-timeline' }
  const durationsMs = matches.map((m) => rangeMs(m[3], m[4]) - rangeMs(m[1], m[2]))
  return { ok: true, durationsMs }
}

/** Population coefficient of variation (stddev / mean). `null` when the mean
 * is not positive — a degenerate timeline no ratio can describe. */
function coefficientOfVariation(valuesMs: number[]): number | null {
  const mean = valuesMs.reduce((s, v) => s + v, 0) / valuesMs.length
  if (mean <= 0) return null
  const variance = valuesMs.reduce((s, v) => s + (v - mean) ** 2, 0) / valuesMs.length
  return Math.sqrt(variance) / mean
}

// ── direction ────────────────────────────────────────────────────────────

const DIRECTION_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'noul',
    id: 'direction.objective-stated',
    dimension: 'direction',
    scope: 'prompt',
    // Gated on `hasCharacters`: a drone flight over a city has no one who
    // wants anything, and asking for a goal there manufactures a zero rather
    // than reporting "not applicable" — see `JudgeContext.hasCharacters`.
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions: 'Does the detailed_description make clear what the driving character wants right now in this clip?',
    criteria: {
      true: 'A concrete, specific goal is stated or clearly dramatized for the character driving the scene.',
      false: 'No goal is stated; the shot reads as mood or scenery with no one wanting anything.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'direction.obstacle-concrete',
    dimension: 'direction',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions:
      'Does the prompt name a concrete thing that is stopping the character from getting what they want, rather than only describing a mood or feeling?',
    criteria: {
      true: 'A specific obstacle is named — another person, an object, a physical barrier, a rule.',
      false: 'Only a mood or feeling is described, with nothing concrete in the way.',
    },
    expect: true,
  },
  {
    kind: 'score',
    id: 'direction.geometry-clarity',
    dimension: 'direction',
    scope: 'prompt',
    instructions:
      'How clearly does the prompt state where the people and the camera stand in relation to each other, using directional language (e.g. left of, behind, facing away, above)?',
    criteria: [
      'No spatial relationship is stated at all.',
      'A spatial relationship is implied but not stated with directional words.',
      'A spatial relationship is stated explicitly with directional words.',
    ],
    goodLevels: [2],
  },
  {
    kind: 'noul',
    id: 'direction.single-throughline',
    dimension: 'direction',
    scope: 'prompt',
    instructions:
      'Does the detailed_description read as one continuous throughline — a single thing that is wanted and a single thing stopping it — rather than a list of disconnected beats with no throughline connecting them?',
    criteria: {
      true: 'The shots connect to one throughline.',
      false: 'The shots read as a disconnected list with no throughline.',
    },
    expect: true,
  },
  {
    // §16's first-listed failure mode, and the canonical negative question:
    // asked POSITIVELY with `expect: false`, because Jev reads literally and
    // a question phrased "does it avoid X" is a negation it answers less
    // reliably. Polarity belongs in code, where it is type-checked.
    kind: 'noul',
    id: 'direction.generic-filler',
    dimension: 'direction',
    scope: 'prompt',
    instructions:
      "Does the prompt rely on generic quality adjectives — 'cinematic', 'epic', 'dynamic', 'high-quality', 'masterpiece' — in place of observable visual detail?",
    criteria: {
      true: 'Generic quality adjectives carry description that names nothing observable.',
      false: 'Every visual claim names something observable; generic adjectives are absent or merely decorate concrete detail.',
    },
    expect: false,
    weight: 2,
  },
  {
    // MOVED from `pacing.escalation` (wording unchanged) — it asks whether
    // tension/stakes build across the clip, which is a dramaturgy question,
    // not a pacing one. Filed under pacing it was scoring things like
    // "Dramatic and epic ending" well as if that were rhythm; it belongs
    // here. Not gated on `hasCharacters` — a flythrough or a chase can
    // escalate in speed or danger with no one in frame to want anything.
    kind: 'score',
    id: 'direction.escalation',
    dimension: 'direction',
    scope: 'prompt',
    instructions: 'How clearly does tension or stakes build across the clip toward a turn?',
    criteria: ['Flat — no escalation across the clip.', 'Some rise in tension or stakes.', 'A clear escalation building to a turn.'],
    goodLevels: [2],
  },
]

// ── acting ───────────────────────────────────────────────────────────────

const ACTING_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'noul',
    id: 'acting.observable-not-labeled',
    dimension: 'acting',
    // Coordinator-named "acting-observable" — a fact about one shot's own
    // text, so it is asked once per approved shot against just that
    // fragment, never the whole clip.
    scope: 'shot',
    // Gated on `hasCharacters` — see `JudgeContext.hasCharacters`. All four
    // acting questions carry this gate: a landscape or product clip with no
    // people has no hands, no gaze, no emotion to find, and scoring that as
    // a failure punishes the film for a genre choice rather than a defect.
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions:
      "Within this shot, is the character's emotional state (if any is shown) conveyed only through observable behaviour (gaze, breathing, posture, hand movement) rather than by naming the emotion directly (e.g. 'nervous', 'angry', 'sad')?",
    criteria: {
      true: 'Emotion is shown entirely through described physical behaviour, with no emotion word naming it directly.',
      false: 'This shot names an emotion directly instead of, or in addition to, describing the behaviour.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'acting.hand-detail',
    dimension: 'acting',
    // Existential across the whole clip ("at least one shot") — cannot be
    // answered from a single fragment, so this stays prompt-scoped.
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions:
      'Does at least one shot describe a specific hand action or gesture — grip tension, a hesitation, a release, a repeated tic — rather than leaving the hands undescribed?',
    criteria: {
      true: 'At least one shot describes a specific hand action.',
      false: 'No shot describes what any character\'s hands are doing.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'acting.attention-stated',
    dimension: 'acting',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions: 'Does the prompt explicitly state what a character is looking at or reacting to?',
    criteria: {
      true: "At least one character's gaze target or what they are reacting to is named explicitly.",
      false: "No character's gaze target or reaction is named.",
    },
    expect: true,
  },
  {
    kind: 'score',
    id: 'acting.specificity',
    dimension: 'acting',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasCharacters,
    instructions:
      'How specific is the acting described — could it belong only to this exact scene, or could it be pasted into almost any other scene unchanged?',
    criteria: [
      'Generic behaviour that could belong to almost any scene.',
      'Somewhat specific, with at least one detail tied to this scene.',
      'Highly specific — the described behaviour could not plausibly belong to a different scene.',
    ],
    goodLevels: [2],
  },
]

// ── camera ───────────────────────────────────────────────────────────────

const CAMERA_QUESTIONS: JudgeQuestion[] = [
  {
    // The one PROMPT-scoped camera question — every other camera question is
    // shot-scoped, which leaves a clip with no `[Shot N]` markers (a brief
    // with no shot breakdown at all) with the entire dimension reporting "not
    // applied", 0 of 4, no matter how good its camera writing is. Measured:
    // an architectural FPV drone brief over Mumbai had no shot markers, and
    // its camera prose ("realistic banking turns, believable acceleration and
    // inertia, motion blur from speed") was the strongest thing in it — and
    // scored nothing. This question can be answered from the whole prompt
    // even when there is no per-shot breakdown to hang the other four on.
    kind: 'noul',
    id: 'camera.specified-overall',
    dimension: 'camera',
    scope: 'prompt',
    instructions:
      'Does the prompt state concrete camera movement overall — named moves with a stated direction and speed or amplitude — rather than leaving the camera unspecified or described only in general terms?',
    criteria: {
      true: 'Concrete camera movement is named, with a direction and a speed or amplitude stated.',
      false: 'The camera is left unspecified, or described only in vague general terms with no named movement.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'camera.motivated',
    dimension: 'camera',
    // Coordinator-named "camera-motivation" — a fact about one shot's own
    // camera clause and its own action.
    scope: 'shot',
    instructions:
      "In this shot, is the camera movement tied to something happening in the action (e.g. a push-in timed to a moment of impact, a tracking shot matched to a character's running speed), rather than stated with no connection to the action?",
    criteria: {
      true: 'Camera movement is tied to a specific moment or speed in the action.',
      false: 'Camera movement is stated with no stated connection to the action.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'camera.vague-language',
    dimension: 'camera',
    scope: 'shot',
    instructions: "Does this shot use vague camera language such as 'dynamic camera' or 'cinematic camera' without naming an actual movement?",
    criteria: {
      true: "A vague camera phrase like 'dynamic camera' or 'cinematic camera' appears with no specific movement named.",
      false: 'Every camera phrase that appears names a specific movement.',
    },
    expect: false,
  },
  {
    kind: 'score',
    id: 'camera.five-elements',
    dimension: 'camera',
    scope: 'shot',
    instructions:
      "How completely does this shot's camera description state all five elements: camera position or shot size, movement type, direction, speed or amplitude, and which subject the camera follows?",
    criteria: ['States one or none of the five elements.', 'States some but not all of the five elements.', 'States all five elements.'],
    goodLevels: [2],
  },
  {
    kind: 'exact',
    id: 'camera.controlled-vocab-per-shot',
    dimension: 'camera',
    // Conceptually a per-shot fact (computed over every shot in one pass),
    // so tagged 'shot' for consistency even though, as an Exact question, it
    // never actually travels anywhere and this tag is documentation only.
    scope: 'shot',
    // Reuses `direction.ts`'s own `CAMERA_TERMS` vocabulary rather than
    // `offVocabularyMovements`: that function reads a `DirectionDoc`'s
    // `DirectedShot[]`, which this module deliberately does not carry (see
    // `JudgeContext`'s comment on keeping state minimal) — the judge only
    // ever sees the RENDERED prompt. This checks the same vocabulary against
    // what actually made it into each `[Shot N]` fragment.
    check(ctx) {
      const split = shotSplit(ctx)
      if (!split.shots.length) return null
      const withTerm = split.shots.filter((s) => CAMERA_TERMS.some((term) => s.text.includes(term))).length
      return withTerm / split.shots.length
    },
  },
]

// ── shots ────────────────────────────────────────────────────────────────

const SHOTS_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'noul',
    id: 'shots.new-information',
    dimension: 'shots',
    // Comparing a cut to the one before it needs both shots at once.
    scope: 'prompt',
    instructions:
      'Does every cut after the first bring genuinely new information — a new angle, a new distance, or new visible content — rather than repeating what the previous shot already showed?',
    criteria: {
      true: 'Every cut after the first adds new angle, distance or content.',
      false: 'At least one cut repeats the same angle, distance and content as the shot before it.',
    },
    expect: true,
  },
  {
    kind: 'score',
    id: 'shots.continuity',
    dimension: 'shots',
    scope: 'prompt',
    instructions:
      'How well does the prompt preserve continuity between shots — consistent screen direction, consistent prop and weapon position, damage or dirt carried forward when it should be?',
    criteria: ['Continuity breaks are visible between shots.', 'Mostly consistent, with a minor gap.', 'Fully consistent across every shot.'],
    goodLevels: [2],
  },
  {
    kind: 'exact',
    id: 'shots.fragments-match-plan',
    dimension: 'shots',
    scope: 'prompt',
    // `pairShotsWithPrompt` is the existing positional pairing — reused
    // rather than re-walking `[Shot N]` markers a second time. An orphan
    // fragment (more shots in the prompt than were planned) costs half a
    // match each, so a prompt that pads out extra shots is not scored the
    // same as one that matches the plan exactly.
    check(ctx) {
      if (!ctx.approvedShots.length) return null
      const { pairs, orphans } = pairShotsWithPrompt(ctx.approvedShots, shotSplit(ctx))
      const matched = pairs.filter((p) => p.fragment !== null).length
      return (matched - orphans.length * 0.5) / pairs.length
    },
  },
  {
    kind: 'exact',
    id: 'shots.marker-hygiene',
    dimension: 'shots',
    scope: 'prompt',
    // `promptShotIssues`/`hasPromptShotIssues` are the existing structural
    // check (numbering, timestamps, ordering) — never reimplemented here.
    // Graded by how many of the five checks fail, not a bare pass/fail, so a
    // single missing timestamp does not read the same as a fully broken body.
    check(ctx) {
      const split = shotSplit(ctx)
      if (!ctx.approvedShots.length && split.shots.length === 0) return null
      const issues = promptShotIssues(split)
      if (!hasPromptShotIssues(issues)) return 1
      const flags = [issues.noMarkers, issues.numbering.length > 0, issues.missingTimestamps.length > 0, issues.outOfOrder.length > 0, issues.firstShotTimestamped]
      const bad = flags.filter(Boolean).length
      return 1 - bad / flags.length
    },
  },
]

/**
 * The per-approved-shot fan-out — GENERATED, not a hand-written list, so the
 * question count always matches however many shots this clip's plan
 * actually has. One literal Noul per shot ("action-chain"), identifying it
 * BY NAME (the `[Shot N]` marker already in its own fragment) rather than
 * re-describing it in the instruction — the jaggedness doc's fix for
 * indirection: point at the relevant state, don't paraphrase it. Pinned to
 * its own shot via `shotIndex`, and `scope: 'shot'` so it is asked against
 * that one fragment alone.
 */
export function buildPerShotQuestions(ctx: JudgeContext): NoulQuestion[] {
  return ctx.approvedShots.map((shot) => ({
    kind: 'noul',
    id: `shots.chain.${shot.index}`,
    dimension: 'shots',
    scope: 'shot',
    shotIndex: shot.index,
    instructions: `Does the shot marked [Shot ${shot.index}] read as a continuous causal chain — an opening state, a trigger, a primary action, and a reaction or settled ending state?`,
    criteria: {
      true: 'The shot is written as a chain: an opening state, what triggers it, the primary action, and how it resolves.',
      false: 'The shot is written as a single isolated action label with no opening state, trigger, or resolution.',
    },
    expect: true,
  }))
}

// ── dialogue — skippable; a silent clip has none of this ────────────────────

const DIALOGUE_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'noul',
    id: 'dialogue.words-transcribed',
    dimension: 'dialogue',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasDialogue,
    instructions:
      "Is every spoken line given as an exact transcribed line of words, rather than only described as speech without the actual words present (e.g. 'her voice trembles' with no words given)?",
    criteria: {
      true: 'Every spoken line has the actual words written out.',
      false: 'At least one place describes someone speaking without giving the actual words.',
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'dialogue.voice-identity-established',
    dimension: 'dialogue',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasDialogue,
    instructions:
      "Is each speaking character's vocal identity (age, register, pace, or accent) established in the description before or alongside their first line, rather than left unstated?",
    criteria: {
      true: "Each speaker's vocal identity is described before or alongside their first line.",
      false: "At least one speaker's vocal identity is never described.",
    },
    expect: true,
  },
  {
    kind: 'noul',
    id: 'dialogue.soundscape-voice-leak',
    dimension: 'dialogue',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasDialogue,
    instructions: "Does the ambient soundscape description describe anyone's voice or speech quality?",
    criteria: {
      true: "The soundscape describes a voice or speech quality (e.g. 'a trembling voice').",
      false: 'The soundscape describes only non-voice sound — ambience, footsteps, objects, weather.',
    },
    expect: false,
  },
  {
    kind: 'score',
    id: 'dialogue.naturalness',
    dimension: 'dialogue',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasDialogue,
    instructions: 'How natural does the dialogue read as something a real person would actually say, versus sounding expository or robotic?',
    criteria: ['Robotic or purely expository — no person would say this.', 'Adequate but stiff.', 'Natural, in-character speech.'],
    goodLevels: [2],
  },
  {
    kind: 'exact',
    id: 'dialogue.tags-present',
    dimension: 'dialogue',
    scope: 'prompt',
    appliesWhen: (ctx) => ctx.hasDialogue,
    // A literal count of `<d>` tags — regex, not judgement, so it stays in
    // code even though it lives in the "dialogue is present" question the
    // brief calls out as skippable.
    check(ctx) {
      const tagCount = (ctx.promptText.match(/<d>/g) || []).length
      return tagCount > 0 ? 1 : 0
    },
  } satisfies ExactQuestion,
]

// ── pacing ───────────────────────────────────────────────────────────────

const PACING_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'exact',
    id: 'pacing.duration-matches-plan',
    dimension: 'pacing',
    scope: 'prompt',
    // Frame-grid arithmetic via `framesForSeconds` — never asked of a model,
    // per the jaggedness doc's "Math and Numbers". A gap within one
    // 17-frame grid step is the render grid's own tolerance, not an
    // arbitrary threshold. Unlike the three checks below, this one measures
    // the plan against the DECLARED clip length, not the prompt's own
    // internal timeline, so it is untouched by `pacingTimeline`.
    check(ctx) {
      if (!ctx.approvedShots.length || !ctx.clipSeconds) return null
      const plannedFrames = framesForSeconds(ctx.approvedShots.reduce((s, sh) => s + sh.seconds, 0))
      const clipFrames = framesForSeconds(ctx.clipSeconds)
      const diff = Math.abs(plannedFrames - clipFrames)
      if (diff <= 17) return 1
      return Math.max(0, 1 - diff / clipFrames)
    },
  },
  {
    // The measured replacement for the deleted `pacing.varied-rhythm` noul,
    // which scored a careful prompt 0.697, a deliberately terrible one
    // 0.727, and a prompt with no shot markers at all 0.857 — it ranked
    // worse prompts higher, because it asked a model to infer tempo from
    // prose instead of computing it from the timestamps already in the text.
    kind: 'exact',
    id: 'pacing.rhythm-variance',
    dimension: 'pacing',
    scope: 'prompt',
    check(ctx) {
      const tl = pacingTimeline(ctx)
      if (!tl.ok) return tl.reason === 'no-timeline' ? 0 : null
      if (tl.durationsMs.length < PACING_MIN_SEGMENTS_FOR_VARIANCE) return null
      const cv = coefficientOfVariation(tl.durationsMs)
      if (cv === null) return null
      return (cv - PACING_RHYTHM_CV_FLOOR) / (PACING_RHYTHM_CV_HEALTHY - PACING_RHYTHM_CV_FLOOR)
    },
  },
  {
    kind: 'exact',
    id: 'pacing.no-flash-frames',
    dimension: 'pacing',
    scope: 'prompt',
    // No minimum-segment gate here, unlike its two siblings below: this
    // checks each available segment on its own terms, so it is just as
    // meaningful against a one-take clip's single segment as against a
    // twelve-shot one. It still reads `pacingTimeline`'s `no-timeline` vs
    // `insufficient-context` distinction — see that type's own comment.
    check(ctx) {
      const tl = pacingTimeline(ctx)
      if (!tl.ok) return tl.reason === 'no-timeline' ? 0 : null
      const withinFloor = tl.durationsMs.filter((d) => d >= PACING_FLASH_FLOOR_MS).length
      return withinFloor / tl.durationsMs.length
    },
  },
  {
    kind: 'exact',
    id: 'pacing.no-monolith',
    dimension: 'pacing',
    scope: 'prompt',
    check(ctx) {
      const tl = pacingTimeline(ctx)
      if (!tl.ok) return tl.reason === 'no-timeline' ? 0 : null
      if (tl.durationsMs.length < PACING_MIN_SEGMENTS_FOR_VARIANCE) return null
      const total = tl.durationsMs.reduce((s, d) => s + d, 0)
      if (total <= 0) return null
      const maxShare = Math.max(...tl.durationsMs) / total
      if (maxShare <= PACING_MONOLITH_MAX_SHARE) return 1
      return 1 - (maxShare - PACING_MONOLITH_MAX_SHARE) / (1 - PACING_MONOLITH_MAX_SHARE)
    },
  },
  {
    // The one genuine judgement pacing still needs: whether a shot's held
    // length is EARNED by what happens inside it, which no arithmetic over
    // timestamps can answer. Deliberately carries no numbers, durations or
    // arithmetic in the instruction — that is precisely what Jev cannot do
    // (see the module comment's "Jev cannot count"); it is asked purely
    // qualitatively, the same as `camera.motivated`'s "is this tied to the
    // action" framing. A generic shot-scoped template (no `shotIndex`), so
    // it is instantiated once per approved shot automatically.
    kind: 'noul',
    id: 'pacing.shot-earns-its-length',
    dimension: 'pacing',
    scope: 'shot',
    instructions:
      'Within this shot, is there enough distinct action or development described to justify the shot being held on screen, rather than a single static instant simply stretched out?',
    criteria: {
      true: 'The shot describes enough distinct action or development to sustain being held.',
      false: 'The shot describes a single static instant with no further development, merely stretched out.',
    },
    expect: true,
  },
]

// ── sound — a shot's sound is its own claim, not a footnote on the clip ────

const SOUND_QUESTIONS: JudgeQuestion[] = [
  {
    // The Singularity spec's §14 requirement: an effect should be tied to a
    // specific visible event (a footfall, an impact, a latch, a door), not
    // floated as generic ambience with nothing in frame causing it.
    kind: 'noul',
    id: 'sound.synced-to-events',
    dimension: 'sound',
    scope: 'prompt',
    instructions:
      'Are the sound effects named in the soundscape tied to specific visible events in the shots — a footfall, an impact, a latch, a door — rather than listed as generic ambience with no event to anchor them?',
    criteria: {
      true: 'At least the prominent effects are each tied to a specific visible event.',
      false: 'Effects are listed as generic ambience, with no visible event named for them.',
    },
    expect: true,
  },
  {
    // Phrased unconditionally on purpose — NOT "where there is silence, is it
    // deliberate", which would be a vacuously-true conditional on a clip with
    // no silence at all. Jev evaluates each question independently, and a
    // conditional like that is exactly the indirection jaggedness #4 warns
    // about. This asks the same thing directly: is the clip's sound, taken as
    // a whole, fully accounted for.
    kind: 'noul',
    id: 'sound.every-moment-accounted',
    dimension: 'sound',
    scope: 'prompt',
    instructions:
      'Across the whole clip, is every moment accounted for by sound — either an audible sound described somewhere, or a silence the prompt explicitly and deliberately states is intended?',
    criteria: {
      true: 'Every part of the clip is covered, either by a described sound or by an explicitly deliberate silence.',
      false: 'At least part of the clip has no sound described and no silence stated for it — it is simply unaddressed.',
    },
    expect: true,
  },
  {
    kind: 'exact',
    id: 'sound.sources-concrete',
    dimension: 'sound',
    scope: 'prompt',
    // Wraps the existing linter's own `audio/concrete` finding rather than
    // re-implementing it — `lint()` already checks whether
    // `overall_soundscape` names timed or comma-separated concrete sources
    // versus describing a mood. It is a CRUDE proxy (it passes on a bare
    // timed number or three comma-separated clauses, whatever they say) so
    // it anchors this dimension cheaply but is not the real judgement —
    // `sound.synced-to-events` and `sound.every-moment-accounted` are.
    // `null`, not 0, when the rule never fired at all (no `overall_soundscape`
    // field present to check).
    check(ctx) {
      const finding = lint(ctx.promptText, ctx.mode).find((f) => f.id === 'audio/concrete')
      if (!finding) return null
      return finding.severity === 'pass' ? 1 : 0
    },
  },
]

/**
 * The per-approved-shot sound-coverage fan-out — a SEPARATE family from
 * `buildPerShotQuestions`' `shots.chain.N`, generated the same way (one
 * question per approved shot) but different in two ways:
 *
 *  - `scope: 'prompt'`, not `'shot'`. Sound coverage inherently needs two
 *    parts of the document at once — the beat's own action and the
 *    clip-level `overall_soundscape` (plus any dialogue) — and a shot-scoped
 *    state holds only that shot's own fragment, which is not enough to
 *    answer this. All the per-shot sound questions therefore ride together
 *    in the ONE `'prompt'`-scoped request; that request already sends the
 *    whole clip as `state`, so N extra questions cost almost nothing.
 *  - Each beat is named by its PLAN SUMMARY (`shot.summary`), never by a
 *    `[Shot N]` marker. `shots.chain.N` deliberately points at a marker
 *    because that marker names a REAL span of the text being judged
 *    (`scope: 'shot'` sends exactly that fragment). This question has no
 *    such fragment to point at — some prompts carry no `[Shot N]` markers at
 *    all (an FPV drone brief that instead wrote `0:00-0:03` time ranges) —
 *    and sound coverage is a property of the BEAT the plan describes, not of
 *    whatever notation the prompt happened to use for it. Marker presence
 *    itself is already measured separately, by `shots.fragments-match-plan`.
 */
export function buildSoundCoverageQuestions(ctx: JudgeContext): NoulQuestion[] {
  return ctx.approvedShots.map((shot) => ({
    kind: 'noul',
    id: `sound.shot-covered.${shot.index}`,
    dimension: 'sound',
    scope: 'prompt',
    instructions: `Consider the beat described as: "${shot.summary}". Does the prompt give this beat a sound that matches what happens in it, or explicitly and deliberately state that this beat is silent?`,
    criteria: {
      true:
        "Sound is given for this beat — either in the ambient soundscape or through its own spoken dialogue, since dialogue is part of a shot's sound — and it matches what happens in it; or the prompt explicitly and deliberately states this beat is silent.",
      false:
        'No sound is given for this beat in either the soundscape or dialogue, and no silence is deliberately stated for it — it is simply left unaddressed. Or a sound is given but does not match what happens.',
    },
    expect: true,
  }))
}

/** The static rubric — every question except the two per-clip fan-outs,
 * which are generated per-clip by `buildPerShotQuestions` (action-chain) and
 * `buildSoundCoverageQuestions` (sound coverage). */
export const JUDGE_RUBRIC: readonly JudgeQuestion[] = [
  ...DIRECTION_QUESTIONS,
  ...ACTING_QUESTIONS,
  ...CAMERA_QUESTIONS,
  ...SHOTS_QUESTIONS,
  ...DIALOGUE_QUESTIONS,
  ...PACING_QUESTIONS,
  ...SOUND_QUESTIONS,
]

export type JudgeQuestionId = (typeof JUDGE_RUBRIC)[number]['id']

/** The whole rubric for ONE clip: the static questions plus that clip's own
 * two per-shot fan-outs (action-chain and sound coverage). Pass this to
 * `buildJudgeRequest`/`scoreJudge` together — both need the same complete
 * set to agree on which ids exist. */
export function buildFullRubric(ctx: JudgeContext): JudgeQuestion[] {
  return [...JUDGE_RUBRIC, ...buildPerShotQuestions(ctx), ...buildSoundCoverageQuestions(ctx)]
}
