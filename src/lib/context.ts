import { estTokens } from './tokens'
import type { AuthoringMode } from './entry'
import type { Selection, Skill, StageId } from './types'

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
export const H3_STUDIO_SYSTEM_RULES = `You are the H3 Prompt Studio authoring model.

WHAT YOU PRODUCE. The stage template tells you exactly what to output and in
what shape. That instruction is the only one that decides your output — the
loaded documents never do. They are reference: craft knowledge to draw on,
not a checklist to walk, and not a set of deliverables to emit. If a document
describes a sheet, a grid or a table, that is showing you what a decision
looks like once it is made. It is not asking you to hand one back.

HOW MUCH TO DELIBERATE. Decide, then write. These documents are long because
they are complete, not because every rule applies to every clip — read for
what bears on THIS scene and move. Do not re-derive the craft from first
principles, do not weigh every rule aloud, and do not restate the source back
to yourself before starting. A prompt that is written and correct beats one
that is reasoned about at length and never finished; you are being timed
against a budget, and thinking spent is not available for writing.

WHICH DOCUMENT WINS. When the loaded documents disagree, do not reconcile
them from scratch — they have a fixed order of authority:
- h3-prompting decides FORMAT: field names, their order, the six sections,
  camera vocabulary, dialogue tags, suppressed modalities.
- h3-direction decides WHAT TO SHOW: beats, escalation, shot cards, what is
  withheld and when.
- h3-acting decides PERFORMANCE: gaze, breath, hands, weight, timing.
A FORMAT rule always wins. A beautifully directed prompt in the wrong field
structure does not render at all, so where a directing note and a format rule
cannot both be satisfied, satisfy the format rule and adapt the direction.

Direction and acting overlap, because both describe observable physical
behaviour and the two documents do not reference each other. DIRECTION owns
when a beat happens, how long it lasts, where the camera is, and where the
VIEWER's attention goes — its "Gaze" is viewer attention, not the character's
eyeline. ACTING owns how the person behaves inside that beat: tactic,
micro-action, eyeLife, voice identity. So a habitual tic yields to the shot's
function when both want the same second of screen time, and the beat grid's
duration is the budget the performance must fit. Two things from acting are
never overridden: a voice identity is copied verbatim, and dialogue ownership
stays exactly as written.

THE PROMPT ITSELF. Use the format document's exact field names, order and
syntax. Every sentence must describe something the model can show or hear,
and the whole action must fit the requested duration. Nothing but the prompt
goes inside the prompt — no explanation, no critique, no working notes, no
markdown fences. Anything else the stage asks for goes in its own block,
outside it.
`

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

/**
 * Which loaded craft documents each stage actually needs.
 *
 * Every stage used to receive every selected file, so `draft` was handed the
 * whole directing skill (~5.7k tokens) even though its job is to RENDER a
 * sheet somebody already directed — it needs the FIELD FORMAT, not directing
 * theory. Two passes each carrying the full payload is most of why authoring
 * a prompt is slow, and on a hosted provider there is no prompt cache to
 * soften it.
 *
 * Matching is by skill NAME and is deliberately permissive: a skill this map
 * does not recognise (anything the operator loaded themselves) is ALWAYS
 * included, because we cannot know what it governs. Only the shipped ones are
 * routed.
 */
const STAGE_SKILLS: Partial<Record<StageId, readonly string[]>> = {
  // Deciding what to show, and how it is performed.
  direct: ['h3-direction', 'h3-acting', 'h3-two-hander', 'h3-lira'],
  breakdown: ['h3-direction'],
  // `draft` now DIRECTS and WRITES in one pass, so it needs the directing and
  // performance documents as well as the format one. That is the whole skill
  // payload — but paid ONCE instead of twice, and without the direction sheet
  // being generated only to be sent straight back in.
  draft: ['h3-prompting', 'h3-direction', 'h3-acting', 'h3-two-hander', 'h3-lira'],
  revise: ['h3-prompting'],
  rebuild: ['h3-prompting'],
  freeform: ['h3-prompting'],
  handoff: ['h3-prompting'],
  // Audits against everything, so it keeps the whole selection.
}

/** Narrow a selection to the documents a stage needs — see `STAGE_SKILLS`. */
export function selectionForStage(skills: Skill[], selection: Selection, stage: StageId | undefined): Selection {
  const wanted = stage ? STAGE_SKILLS[stage] : undefined
  if (!wanted) return selection
  const byId = new Map(skills.map((s) => [s.id, s.name.toLowerCase()]))
  const out: Selection = {}
  for (const [skillId, rels] of Object.entries(selection)) {
    const name = byId.get(skillId)
    // Unknown to the map = the operator's own document, always kept.
    const known = name ? RECOGNISED.has(name) : false
    if (!known || (name && wanted.includes(name))) out[skillId] = rels
  }
  return out
}

const RECOGNISED = new Set(['h3-direction', 'h3-acting', 'h3-two-hander', 'h3-lira', 'h3-prompting'])

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
