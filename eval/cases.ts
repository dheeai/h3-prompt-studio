import { readFile } from 'node:fs/promises'
import { buildContext, buildStudioSystemPrompt } from '../src/lib/context'
import { filmBlock, fillTemplate, templateFor } from '../src/lib/stages'
import { estTokens } from '../src/lib/tokens'
import type { ChatMessage } from '../src/lib/llm'
import type { Skill } from '../src/lib/types'
import type { EvalModel, ThinkingEvalCase } from './types'

export const EVAL_MODELS: readonly EvalModel[] = [
  'default',
  'thinkingcap-27b',
  'qwen38-heretic-27b-fast',
]

export const EVAL_ARMS: readonly boolean[] = [true, false]

const LANTERN_SPINE =
  'Maya crosses an empty railway platform at dawn, hears a train that never arrives, finds a child’s drawing pinned to the bench, and leaves a red paper lantern lit beside it as first light reaches the tracks.'

const LANTERN_PRECEDES = 'Maya has found the drawing and is holding the unlit lantern beside the bench.'
const LANTERN_COVERS = 'She listens for the absent train, unfolds the drawing, and understands it.'
const LANTERN_FOLLOWS = 'She carries the lantern to the end of the platform and leaves it lit.'

const greenhouseSource =
  'A woman opens a greenhouse door at night. A moth lands on her wrist. Her hand turns the latch at the end. No dialogue.'

const greenhousePrompt = `subject_definitions:
<Subject 1> is the woman at the greenhouse door, with her face and hands clearly visible.
<Subject 2> is the glass greenhouse door and its metal latch.
<Subject 3> is a pale moth that lands on the woman’s wrist.

summary: reference generation — At night, a woman opens the greenhouse door, a moth lands on her wrist, and the scene ends on her hand turning the latch.

retention_analysis:
<Subject 1>: fully_preserved
<Subject 2>: fully_preserved
<Subject 3>: fully_preserved

detailed_description:
[Shot 1 — 0.0–2.5 seconds] A woman opens the greenhouse door at night. Begin in a chest-up medium shot as her hand reaches the metal handle and pulls the door open; the cool interior glass and dark garden remain visible behind her.
[Shot 2 — 2.5–5.0 seconds] Hold a close-up on her wrist as the pale moth lands there. Her breath catches, her fingers stop, and her eyes track the moth so the reaction is readable without dialogue.
[Shot 3 — 5.0–7.0 seconds] Stay close on her hand as it turns the latch. End on the latch rotating under her fingers, with the moth still on her wrist.

overall_soundscape: Night insects outside, a soft hinge creak as the greenhouse door opens, one small breath catch, and the metal latch clicking under her hand; no voices.
non_diegetic_music: no music.`

const previousLanternPrompt =
  'PREVIOUS_CANONICAL_PROMPT: At dawn on the empty railway platform, Maya carries the red paper lantern to the bench and leaves the lantern lit beside the drawing.'

const continuationDirectionSheet = `WHERE THE SOURCE STANDS
- The previous clip has already placed the red paper lantern beside the child’s drawing.

WHAT THE BRIEF FIXES
- The next clip opens on the flame bending in the wind.
- The train remains absent.
- Maya walks away while the flame stays visible.

DIRECTION SHEET
- Open on the bending flame beside the drawing.
- Let Maya recede down the platform without repeating the placement action.
- End with the lantern still visible and the absent train unresolved.`

export const EVAL_CASES: readonly ThinkingEvalCase[] = [
  {
    id: 'scene-breakdown',
    family: 'scene',
    stage: 'breakdown',
    studioMode: 'story',
    h3Mode: 'Ref2VA',
    story:
      'At dawn, Maya crosses an empty railway platform carrying a red paper lantern. She hears a train that never arrives, finds a child’s drawing pinned to the bench, and leaves the lantern lit beside it as first light reaches the tracks. No dialogue. Divide it into exactly three clips of 3 seconds.',
    current: '',
    previous: '',
    film: {
      role: 'standalone',
      spine: LANTERN_SPINE,
      precedes: '',
      follows: '',
      title: 'Lantern at first light',
    },
    notes: '',
    findings: '',
    standing: 'a narrative story brief with one silent subject, ordered actions, and an explicit three-clip duration constraint',
    validators: ['breakdown-json', 'fixed-facts', 'neighboring-states'],
  },
  {
    id: 'scene-middle-closing-direction',
    family: 'scene',
    stage: 'direct',
    studioMode: 'story',
    h3Mode: 'Ref2VA',
    story: 'Lantern-film spine.',
    current: '',
    previous: '',
    film: {
      role: 'rising',
      spine: LANTERN_SPINE,
      precedes: LANTERN_PRECEDES,
      follows: LANTERN_FOLLOWS,
      title: 'The absent train',
      covers: LANTERN_COVERS,
      clipIndex: 1,
    },
    notes: '',
    findings: '',
    standing: 'a middle clip in an established silent lantern film; the platform and drawing are already established',
    validators: ['fixed-facts', 'neighboring-states', 'continuity'],
  },
  {
    id: 'clip-direction-acting-heavy-two-hander',
    family: 'clip',
    stage: 'direct',
    studioMode: 'idea',
    h3Mode: 'Ref2VA',
    story:
      'In a quiet kitchen after their father’s funeral, two adult sisters argue over who will take his worn blue coat. The older sister says, verbatim, ‘You only want it because he forgave you.’ The younger sister takes the coat, cannot put it on, and sets it back down. One continuous 7-second shot.',
    current: '',
    previous: '',
    film: {
      role: 'standalone',
      spine: 'Two adult sisters argue in a quiet kitchen over their father’s worn blue coat, and the younger sister cannot put it on.',
      precedes: '',
      follows: '',
      title: 'The blue coat',
    },
    notes: '',
    findings: '',
    standing: 'a single-shot two-hander with fixed verbatim dialogue, two performers, and a constrained physical outcome',
    validators: ['fixed-facts', 'dialogue-acting'],
  },
  {
    id: 'clip-t2va-draft-from-direction-sheet',
    family: 'clip',
    stage: 'draft',
    studioMode: 'idea',
    h3Mode: 'T2VA',
    story:
      'Direction sheet for a street magician hiding a coin from a skeptical child; no references; 6 seconds; the child stays skeptical and the coin ends in the magician’s closed fist.',
    current: `WHERE THE SOURCE STANDS
- The direction sheet has fixed one street magician, one skeptical child, one coin, no references, and a six-second clip.

WHAT THE BRIEF FIXES
- The magician hides the coin from the child.
- The child remains skeptical.
- The coin ends in the magician’s closed fist.

DIRECTION SHEET
- 0.0–1.5 seconds: The magician displays an empty palm and watches the skeptical child’s eyes.
- 1.5–4.5 seconds: In one continuous chest-up action, the magician closes the other hand around the coin while the child leans in but keeps a doubtful expression.
- 4.5–6.0 seconds: The magician opens the empty palm, then holds the closed fist in frame; the child remains skeptical and the coin stays hidden.
- Sound anchors: a coin click against the palm, fabric movement, and the child’s quiet breath; no music.
`,
    previous: '',
    film: {
      role: 'standalone',
      spine: 'A street magician hides a coin from a skeptical child.',
      precedes: '',
      follows: '',
      title: 'The closed fist',
    },
    notes: '',
    findings: '',
    standing: 'a direction sheet for one text-only six-second clip with a fixed skeptical reaction and closed-fist ending',
    validators: ['required-h3-fields', 'fixed-facts', 'continuity'],
  },
  {
    id: 'prompt-revise',
    family: 'prompt',
    stage: 'revise',
    studioMode: 'prompt',
    h3Mode: 'Ref2VA',
    story: greenhouseSource,
    current: greenhousePrompt,
    previous: '',
    film: {
      role: 'standalone',
      spine: greenhouseSource,
      precedes: '',
      follows: '',
      title: 'Moth on the wrist',
    },
    notes: 'Make the reaction readable in the middle beat; preserve the action, ending, and all named objects.',
    findings: 'The middle beat does not make the woman’s reaction readable enough to observe.',
    standing: 'a structured Ref2VA prompt with a fixed woman, greenhouse door, moth, wrist landing, latch ending, and no dialogue',
    validators: ['prompt-replacement-blocks', 'fixed-facts'],
  },
  {
    id: 'prompt-rebuild',
    family: 'prompt',
    stage: 'rebuild',
    studioMode: 'prompt',
    h3Mode: 'Ref2VA',
    story: greenhouseSource,
    current: greenhousePrompt,
    previous: '',
    film: {
      role: 'standalone',
      spine: greenhouseSource,
      precedes: '',
      follows: '',
      title: 'Moth on the wrist',
    },
    notes:
      'Rebuild the direction for stronger acting and camera motivation, but keep the woman, greenhouse, night, moth, wrist landing, latch ending, and no dialogue.',
    findings: '',
    standing: 'a structured Ref2VA prompt whose fixed brief must survive a finite directing rebuild',
    validators: ['prompt-replacement-blocks', 'fixed-facts'],
  },
  {
    id: 'continuation-planning',
    family: 'continuation',
    stage: 'handoff',
    studioMode: 'story',
    h3Mode: 'Ref2VA',
    story:
      'Continue the lantern film. The previous canonical prompt ends with Maya’s lantern beside the drawing. The next clip opens on the flame bending in the wind while the train remains absent.',
    current: `${previousLanternPrompt}\nThe final image is Maya’s red lantern lit beside the child’s drawing on the empty platform.`,
    previous: '',
    film: {
      role: 'rising',
      spine: LANTERN_SPINE,
      precedes: 'Maya has left the red lantern lit beside the child’s drawing on the bench.',
      follows: 'The flame bends in the wind while Maya walks away and the train remains absent.',
      title: 'The flame in the wind',
      covers: 'The next clip opens on the flame bending in the wind while the train remains absent.',
      clipIndex: 2,
    },
    notes: '',
    findings: '',
    standing: 'a continuation hand-off from a completed lantern placement; the next state must remain open and must not resolve the absent train',
    validators: ['handoff-blocks', 'continuity', 'neighboring-states'],
  },
  {
    id: 'continuation-prompt-authoring',
    family: 'continuation',
    stage: 'draft',
    studioMode: 'story',
    h3Mode: 'Ref2VA',
    story:
      'Continue from the lantern beside the drawing: the flame bends in the wind, Maya walks away, the flame remains visible, and the train stays absent.',
    current: continuationDirectionSheet,
    previous: 'PREVIOUS_CANONICAL_SENTINEL: Maya leaves the lantern lit beside the drawing.',
    film: {
      role: 'rising',
      spine: LANTERN_SPINE,
      precedes: 'The red lantern flame bends in the wind beside the child’s drawing while the train remains absent.',
      follows: 'Maya walks away down the platform while the lantern flame remains visible; the train is still absent.',
      title: 'Maya walks away',
      covers: 'Maya walks away while the flame remains visible beside the drawing.',
      clipIndex: 3,
    },
    notes: '',
    findings: '',
    standing: 'a continuation direction sheet that inherits the flame, lantern, drawing, and absent train as fixed opening state',
    validators: ['required-h3-fields', 'fixed-facts', 'continuity'],
  },
]

const SELECTED_SKILL_IDS = ['h3-acting', 'h3-direction', 'h3-prompting'] as const
const EVAL_SELECTION = Object.fromEntries(SELECTED_SKILL_IDS.map((id) => [id, ['SKILL.md']]))

interface SkillIndexEntry {
  dir: string
  files: string[]
}

interface SkillIndexManifest {
  skills: SkillIndexEntry[]
}

function frontmatter(text: string, key: 'name' | 'description', fallback: string): string {
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? ''
  const value = header.match(new RegExp(`^${key}\\s*:\\s*(.*?)\\s*$`, 'm'))?.[1]?.trim()
  if (!value) return fallback
  return value.replace(/^("|')(.*)\1$/, '$2')
}

/**
 * Resolve the shipped skill asset root without depending on a local build.
 * `dist/skills` is the production preference, while `public/skills` is the
 * tracked source tree available on a clean checkout before Vite has run.
 */
export async function evalSkillRoot(projectRoot = new URL('../', import.meta.url)): Promise<URL> {
  for (const relative of ['dist/skills/', 'public/skills/']) {
    const root = new URL(relative, projectRoot)
    try {
      const manifest = JSON.parse(await readFile(new URL('index.json', root), 'utf8')) as SkillIndexManifest
      for (const id of SELECTED_SKILL_IDS) {
        const entry = manifest.skills.find((candidate) => candidate.dir === id)
        if (!entry || !entry.files.includes('SKILL.md')) throw new Error(`Missing bundled skill ${id}/SKILL.md`)
        await readFile(new URL(`${entry.dir}/SKILL.md`, root), 'utf8')
      }
      return root
    } catch {
      // Try the tracked source assets when the ignored build output is absent
      // or incomplete. The actual error is reported only if both roots fail.
    }
  }
  throw new Error('Missing eval skill assets in dist/skills and public/skills')
}

async function loadEvalContext() {
  const skillsRoot = await evalSkillRoot()
  const manifest = JSON.parse(await readFile(new URL('index.json', skillsRoot), 'utf8')) as SkillIndexManifest
  const skills: Skill[] = []

  for (const id of SELECTED_SKILL_IDS) {
    const entry = manifest.skills.find((candidate) => candidate.dir === id)
    if (!entry || !entry.files.includes('SKILL.md')) throw new Error(`Missing bundled skill ${id}/SKILL.md`)
    const text = await readFile(new URL(`${entry.dir}/SKILL.md`, skillsRoot), 'utf8')
    skills.push({
      id,
      name: frontmatter(text, 'name', id),
      description: frontmatter(text, 'description', ''),
      source: 'bundled',
      addedAt: 0,
      files: [{ rel: 'SKILL.md', text, tokens: estTokens(text) }],
    })
  }

  return buildContext(skills, EVAL_SELECTION)
}

let evalContextPromise: ReturnType<typeof loadEvalContext> | undefined

function evalContext() {
  evalContextPromise ??= loadEvalContext()
  return evalContextPromise
}

export async function buildEvalMessages(testCase: ThinkingEvalCase): Promise<ChatMessage[]> {
  const context = await evalContext()
  return [
    { role: 'system', content: buildStudioSystemPrompt(context, testCase.studioMode) },
    {
      role: 'user',
      content: fillTemplate(templateFor({}, testCase.stage), {
        story: testCase.story,
        current: testCase.current,
        previous: testCase.previous,
        film: filmBlock(testCase.film),
        notes: testCase.notes,
        findings: testCase.findings,
        standing: testCase.standing,
        mode: testCase.h3Mode,
      }),
    },
  ]
}

export function evalVariants(): { caseId: string; model: EvalModel; enableThinking: boolean }[] {
  return EVAL_MODELS.flatMap((model) =>
    EVAL_CASES.flatMap((testCase) =>
      EVAL_ARMS.map((enableThinking) => ({ caseId: testCase.id, model, enableThinking })),
    ),
  )
}
