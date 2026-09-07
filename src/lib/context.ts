import { estTokens } from './tokens'
import type { AuthoringMode } from './entry'
import type { Selection, Skill } from './types'

/**
 * The cached layer.
 *
 * Assembly is deterministic — skills sorted by id, files sorted within a
 * skill, byte-identical wrapper text every time. That stability is the whole
 * point: an unchanged prefix is what lets llama.cpp / Ollama reuse their KV
 * cache instead of re-reading tens of thousands of tokens of skill on every
 * turn. Anything that varies per request (the story, the instruction) must go
 * AFTER this block, never inside it.
 */

const HEADER = `# Loaded skills

The blocks below are complete, authoritative reference documents. They are the
governing spec for this task: when a block states a rule, a measured failure
mode, a required field or an exact format, follow it literally rather than
substituting general knowledge. Where two blocks conflict, the more specific
one wins. Do not summarise these documents back to the user; apply them.
`

export interface BuiltContext {
  text: string
  hash: string
  tokens: number
  parts: { skillId: string; skillName: string; rel: string; tokens: number }[]
}

export type H3PromptSurface = 'studio' | 'agent'

/**
 * Rules that belong to the Studio surface rather than to an individual stage
 * template. Keeping them beside the skill-context assembler makes it
 * impossible for the Studio and Agent to silently drift into different
 * definitions of the canonical prompt.
 */
export const H3_STUDIO_SYSTEM_RULES = `You are the H3 Prompt Studio authoring model on the Studio authoring surface.

The selected skill documents above are the complete craft authority. Apply them
to the user's source and the current stage contract. The current stage contract
decides what is fixed: Revise remains conservative, while Rebuild explicitly
preserves only the invariants it names. The canonical prompt is the only text
that may be submitted to ComfyUI; explanations, critique, and working notes
stay outside it.

BUILDING THE CANONICAL H3 PROMPT

Use the selected skills' exact H3 field names, order, syntax, and modality rules.
When a prompt is being authored or rebuilt, specify the requested scene in this
order: resolve the fixed brief under the current stage contract, make the subject and observable action clear,
stage the temporal beat and ending, then make framing, lens feel, camera
movement, blocking, performance, lighting, texture, and sound concrete. Check
that every sentence describes something the model can show or hear and that the
action can fit the requested duration.

The submission-ready prompt must contain the skill-governed
integrated_multimodal_description and overall_soundscape fields when those
fields are part of the selected H3 mode's format. Keep them complete and
internally consistent; do not place explanations, critique, or markdown fences
inside the canonical prompt. Return any explanation or change log in its own
response block required by the current stage template.`

const H3_STUDIO_MODE_RULES: Record<AuthoringMode, string> = {
  story: `SCENE (MULTI-SHOT) MODE — NARRATIVE PLANNER AND CLIP AUTHOR

Treat the source as a film brief, story, beat sheet, or script whose narrative
intent must survive conversion into H3 clips. Work in this order:

1. Extract the narrative spine: the subject, goal, causal beats, turning point,
   ending state, dialogue, and what remains unresolved.
2. Divide the spine into continuity-safe clips. Each clip gets one observable
   dramatic unit, an inherited/open state, and a clear hand-off to the next
   unit. Do not silently generate every clip prompt when the requested action is
   only to plan; the operator explicitly starts full prompt generation.
3. Establish what each clip inherits from the preceding clip and what it must
   leave open for the following clip. Preserve characters, props, setting,
   dialogue, causal order, and outcomes across the sequence.
4. When a clip is being authored, build its canonical prompt from that clip's
   beat and continuity state using the field-building protocol above. Author
   only the requested clip unless the operator explicitly asks for all prompts.

Continuity is not a reason to invent a new event. The next clip must open from
the prior ending state and advance the story's next beat.` ,
  prompt: `PROMPT MODE — SURGICAL H3 EDITOR

Treat the source as an existing prompt or near-prompt. Work in one finite pass
for either Revise or Rebuild:

1. Identify the fixed intent under the operation being run. Revise preserves
   the existing brief and fixed details; Rebuild preserves only character
   identity/count/relationships, physical location, the core filmed action,
   and dialogue language.
2. Diagnose only material weaknesses against the selected skills: missing H3
   fields, vague observable action, weak temporal order, ungrounded camera or
   sound, modality violations, or contradictions.
3. Rebuild one complete replacement prompt in the skill-governed H3 order.
   Revise carries fixed details through; Rebuild freely re-directs every other
   creative choice while making the preserved invariants concrete and coherent.
4. Check the replacement for submission readiness, including the required
   integrated_multimodal_description and overall_soundscape fields where the
   mode format calls for them.

Be surgical and finite. Revise applies material findings while preserving
untouched writing where possible. Rebuild first extracts the characters,
location, core action, and dialogue language, then completely re-directs the
shot as a new treatment around those invariants. Do not accidentally carry
over incidental props, wardrobe, dialogue wording, blocking, timing, camera,
lighting, sound, or tone.
Do not turn either request into a new concept, story outline, or multi-clip plan
unless the operator explicitly asks for that. Return one complete canonical
replacement plus a concise explanation, never a patch, fragment, or endless
retry.` ,
  idea: `CLIP MODE — CREATIVE DIRECTOR AND H3 PROMPT AUTHOR

Treat the source as an underspecified creative idea. Resolve it into one
coherent, submission-ready scene in this order:

1. Resolve the core moment: what the audience sees happen, who or what acts,
   where it happens, and how the moment ends.
2. Select sensible, reversible craft decisions for subject presentation,
   environment, framing, lens feel, blocking, motion, lighting, texture, and
   sound. Make the action observable rather than naming an unfilmable emotion.
3. Specify the complete canonical H3 prompt using the selected skills' exact
   field order and syntax, including integrated_multimodal_description and
   overall_soundscape where required by the mode format.
4. Perform a coherence check: one clear subject/action, one readable temporal
   progression, no contradictions, and enough concrete detail to submit to
   ComfyUI at the requested duration.

Make creative choices that are easy for the operator to revise. Do not invent
identity, brand, dialogue, or factual claims that the source did not provide,
and do not expand one idea into a multi-clip plan unless asked.` ,
}

/**
 * Build the Studio contract for one of its explicit entry modes. The complete
 * selected skill prefix is inserted once, then shared prompt-construction
 * rules and the mode process follow it. Internal stages provide their own
 * mechanics in the user message; the visible Studio surface stays bounded.
 */
export function buildStudioSystemPrompt(context: BuiltContext | null | undefined, mode: AuthoringMode): string {
  const selectedSkills = context?.text || '# No selected H3 skills\n\nNo skill files are currently selected.'
  return `${selectedSkills}\n\n${H3_STUDIO_SYSTEM_RULES}\n\n${H3_STUDIO_MODE_RULES[mode]}`
}

/** Operational rules for the browser Agent; deterministic tools are the only
 * way it may mutate the shared Studio state. */
export const H3_AGENT_SYSTEM_RULES = `You are the H3 Prompt Studio browser Agent on the Agent surface.

The selected skill documents above are the complete craft authority. Use the
deterministic Studio tools to inspect or mutate the one shared session. If the
user asks for a prompt change, write the complete canonical H3 prompt and save
it through a prompt-version tool; never put commentary in the prompt field.
Never call Studio LLM stages, invent a render, or repeat a tool operation.
Render and chain submission require explicit confirmation. Stop after one
meaningful operation and report its result briefly.`

/**
 * Build the single system-message contract used by both LLM surfaces.
 * `BuiltContext.text` already contains the complete selected skill files in a
 * stable order, so it is inserted as one contiguous block exactly once.
 */
export function buildH3SystemPrompt(context: BuiltContext | null | undefined, surface: H3PromptSurface, studioMode?: AuthoringMode): string {
  if (surface === 'studio' && studioMode) return buildStudioSystemPrompt(context, studioMode)
  const selectedSkills = context?.text || '# No selected H3 skills\n\nNo skill files are currently selected.'
  const rules = surface === 'agent' ? H3_AGENT_SYSTEM_RULES : H3_STUDIO_SYSTEM_RULES
  return `${selectedSkills}\n\n${rules}`
}

async function sha256(text: string): Promise<string> {
  // crypto.subtle needs a secure context; localhost and https both qualify.
  if (!globalThis.crypto?.subtle) {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const cache = new Map<string, BuiltContext>()

export function selectionKey(selection: Selection): string {
  return Object.keys(selection)
    .filter((k) => selection[k]?.length)
    .sort()
    .map((k) => `${k}:${[...selection[k]].sort().join(',')}`)
    .join('|')
}

export async function buildContext(skills: Skill[], selection: Selection): Promise<BuiltContext> {
  const key = selectionKey(selection)
  const hit = cache.get(key)
  if (hit) return hit

  const index = new Map(skills.map((s) => [s.id, s]))
  const chunks: string[] = [HEADER]
  const parts: BuiltContext['parts'] = []

  for (const skillId of Object.keys(selection).sort()) {
    const skill = index.get(skillId)
    if (!skill) continue
    for (const rel of [...(selection[skillId] || [])].sort()) {
      const file = skill.files.find((f) => f.rel === rel)
      if (!file) continue
      chunks.push(`\n\n<skill name="${skill.name}" file="${rel}">\n${file.text.trim()}\n</skill>`)
      parts.push({ skillId: skill.id, skillName: skill.name, rel, tokens: file.tokens })
    }
  }

  const text = chunks.join('')
  const built: BuiltContext = { text, hash: await sha256(text), tokens: estTokens(text), parts }
  cache.set(key, built)
  return built
}

/** True once this exact prefix has been sent at least once this session. */
const sent = new Set<string>()
export function markSent(hash: string) {
  sent.add(hash)
}
export function wasSent(hash: string) {
  return sent.has(hash)
}
