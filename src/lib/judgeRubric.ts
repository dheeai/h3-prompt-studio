import { CAMERA_TERMS } from './direction'
import { hasPromptShotIssues, pairShotsWithPrompt, promptShotIssues, splitClipLevelSections, splitPromptShots, type SplitPrompt } from './promptShots'
import { framesForSeconds } from './geometry'
import type { ExactQuestion, JudgeContext, JudgeQuestion, NoulQuestion } from './judge'

/**
 * THE RUBRIC — one reviewable file, per TypeSafe's own guidance: questions
 * and thresholds live together so a human (the founder) can review them
 * without spelunking. This file is the one meant to be edited by hand.
 *
 * Sourced from `singularity_spec.md` (§8 action chains, §9 camera, §10
 * physical feedback, §13 observable acting, §14 dialogue/speakers, §16
 * failure modes) and from the `h3-prompting`/`h3-acting` skills bundled at
 * `public/skills/`. Every judgement question below asks something a READER
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

// ── direction ────────────────────────────────────────────────────────────

const DIRECTION_QUESTIONS: JudgeQuestion[] = [
  {
    kind: 'noul',
    id: 'direction.objective-stated',
    dimension: 'direction',
    scope: 'prompt',
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
    kind: 'noul',
    id: 'pacing.varied-rhythm',
    dimension: 'pacing',
    scope: 'prompt',
    instructions: 'Does the pace vary across the clip — some shots held, others quicker?',
    criteria: {
      true: 'The pace visibly varies between shots.',
      false: 'Every shot reads as the same length and weight, with no variation.',
    },
    expect: true,
  },
  {
    kind: 'score',
    id: 'pacing.escalation',
    dimension: 'pacing',
    scope: 'prompt',
    instructions: 'How clearly does tension or stakes build across the clip toward a turn?',
    criteria: ['Flat — no escalation across the clip.', 'Some rise in tension or stakes.', 'A clear escalation building to a turn.'],
    goodLevels: [2],
  },
  {
    kind: 'exact',
    id: 'pacing.duration-matches-plan',
    dimension: 'pacing',
    scope: 'prompt',
    // Frame-grid arithmetic via `framesForSeconds` — never asked of a model,
    // per the jaggedness doc's "Math and Numbers". A gap within one
    // 17-frame grid step is the render grid's own tolerance, not an
    // arbitrary threshold.
    check(ctx) {
      if (!ctx.approvedShots.length || !ctx.clipSeconds) return null
      const plannedFrames = framesForSeconds(ctx.approvedShots.reduce((s, sh) => s + sh.seconds, 0))
      const clipFrames = framesForSeconds(ctx.clipSeconds)
      const diff = Math.abs(plannedFrames - clipFrames)
      if (diff <= 17) return 1
      return Math.max(0, 1 - diff / clipFrames)
    },
  },
]

/** The static rubric — every question except the per-shot fan-out, which is
 * generated per-clip by `buildPerShotQuestions`. */
export const JUDGE_RUBRIC: readonly JudgeQuestion[] = [
  ...DIRECTION_QUESTIONS,
  ...ACTING_QUESTIONS,
  ...CAMERA_QUESTIONS,
  ...SHOTS_QUESTIONS,
  ...DIALOGUE_QUESTIONS,
  ...PACING_QUESTIONS,
]

export type JudgeQuestionId = (typeof JUDGE_RUBRIC)[number]['id']

/** The whole rubric for ONE clip: the static questions plus that clip's own
 * per-shot fan-out. Pass this to `buildJudgeRequest`/`scoreJudge` together —
 * both need the same complete set to agree on which ids exist. */
export function buildFullRubric(ctx: JudgeContext): JudgeQuestion[] {
  return [...JUDGE_RUBRIC, ...buildPerShotQuestions(ctx)]
}
