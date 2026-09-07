import { streamChatComplete } from './llm'
import type { ChatMessage } from './llm'
import type { Provider, SubjectDefinition } from './types'

export type SubjectKind = 'male' | 'female' | 'other'

/**
 * The default `job` phrasing each subject-kind radio seeds — verbatim, per the
 * plate-editor spec. This is a SEED, not a lock: the caller writes it into
 * `job` only when the operator has not hand-edited the field since the last
 * seed (see `Plate.jobAuto`), and the plate editor must offer, never force,
 * applying a changed default over hand-edited text.
 */
export function defaultJobForSubjectKind(kind: SubjectKind): string {
  switch (kind) {
    case 'male':
      return 'his face, his body, his identity'
    case 'female':
      return 'her face, her body, her identity'
    case 'other':
      return 'identity from image'
  }
}

function possessivePronounFor(kind: SubjectKind): string {
  switch (kind) {
    case 'male':
      return 'He'
    case 'female':
      return 'She'
    case 'other':
      return 'The subject'
  }
}

function identityPhraseFor(kind: SubjectKind): string {
  return defaultJobForSubjectKind(kind)
}

/**
 * Compose the plate's `job` text from a structured subject definition.
 *
 * THE SUBSTITUTION RULE (Lara Croft -> saree): when `wardrobeOverride` is set,
 * `def.wardrobe` — the garment actually visible in the reference — is left
 * OUT of the composed text entirely. It is never negated ("not her shorts"),
 * because naming a thing instructs a generative model to produce it whether
 * or not a "don't" sits in front of it — the same failure already measured
 * for suppressing music and for denying dialogue in this codebase's H3 work.
 * The only safe fix is to omit the source garment and state the replacement
 * positively and completely; there is no negative-prompt channel on this path
 * to fall back on (Ref2VA here is guidance-distilled — no CFG, no negatives).
 *
 * With no override, the detected wardrobe is exactly what should appear on
 * screen, so it is stated positively too — describing it is not a negation of
 * anything and carries no risk.
 */
export function composeSubjectJob(opts: { subjectKind: SubjectKind; def: SubjectDefinition; wardrobeOverride?: string }): string {
  const { subjectKind, def } = opts
  const identity = identityPhraseFor(subjectKind)
  const pronoun = possessivePronounFor(subjectKind)

  const attrs = [
    def.apparentAge && `apparent age ${def.apparentAge}`,
    def.build && `build ${def.build}`,
    def.face && `face ${def.face}`,
    def.hair && `hair ${def.hair}`,
    def.skin && `skin ${def.skin}`,
    def.distinguishingMarks && `distinguishing marks: ${def.distinguishingMarks}`,
  ]
    .filter(Boolean)
    .join('; ')

  const wardrobeOverride = opts.wardrobeOverride?.trim()
  const wardrobeText = wardrobeOverride || def.wardrobe.trim()

  const lines = [`Take ${identity} from this image${attrs ? ` — ${attrs}.` : '.'}`]
  if (wardrobeText) lines.push(`${pronoun} wears ${wardrobeText}.`)
  return lines.join(' ')
}

/** The floor `analyzeSubjectImage` enforces on `max_tokens` — see the module comment below. */
export const MIN_VISION_MAX_TOKENS = 1500

/**
 * `settings.maxTokens` is an operator-wide ceiling meant for prose passes; a
 * reasoning model spends a chunk of it on thinking before it ever writes the
 * JSON answer, and a tight cap comes back as an EMPTY `content` string with
 * `finish_reason: "length"` rather than a short one (measured on
 * thinkingcap-27b at max_tokens: 64). 0 already means "no ceiling — send
 * nothing, let the server apply its own maximum" and is more generous than
 * any floor, so it is left alone; anything else is raised to the floor.
 */
export function resolveVisionMaxTokens(configured: number): number {
  if (configured <= 0) return 0
  return Math.max(configured, MIN_VISION_MAX_TOKENS)
}

const SUBJECT_ANALYSIS_INSTRUCTIONS = `Look at the attached image and describe the ONE person shown, for a reference plate in a video-generation prompt.

Return ONLY a JSON object, with exactly these string keys and nothing else — no prose before or after it, no markdown code fence:

{
  "apparentAge": "",
  "build": "",
  "face": "",
  "hair": "",
  "skin": "",
  "distinguishingMarks": "",
  "wardrobe": ""
}

Rules:
- Describe only what is visible. Do not guess a name or an ethnicity.
- "wardrobe" is EVERY garment and accessory actually worn in this image, and nothing else — no pose, no action, no background, no scene.
- Every field OTHER than "wardrobe" must never mention clothing — identity and wardrobe are kept apart on purpose.
- "distinguishingMarks" is a scar, tattoo, mole, birthmark or similar. Use an empty string if none are visible.
- If the image has no clear single person, still fill every field as best you can from what is visible; do not add a field explaining that.`

/** Strip a ```json fence (or a bare ``` fence) around a reply, if present. */
function stripJsonFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

/**
 * Parse a vision reply into a `SubjectDefinition`, tolerant of a wrapping code
 * fence or surrounding prose — the same tolerance `parseBreakdown` (stages.ts)
 * applies to its own JSON contract. Returns null on anything that is not a
 * JSON object, so the caller can surface a clear error rather than silently
 * accepting garbage into an identity field.
 */
export function parseSubjectDefinition(raw: string): SubjectDefinition | null {
  const stripped = stripJsonFence(raw.trim())
  const start = stripped.indexOf('{')
  const end = stripped.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  let obj: unknown
  try {
    obj = JSON.parse(stripped.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  return {
    apparentAge: str('apparentAge'),
    build: str('build'),
    face: str('face'),
    hair: str('hair'),
    skin: str('skin'),
    distinguishingMarks: str('distinguishingMarks'),
    wardrobe: str('wardrobe'),
  }
}

/** Build the multimodal request for a single image, per the standard OpenAI `image_url` content block. */
export function buildSubjectAnalysisMessages(imageDataUrl: string): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a precise visual describer. You answer in strict JSON only.' },
    {
      role: 'user',
      content: [
        { type: 'text', text: SUBJECT_ANALYSIS_INSTRUCTIONS },
        { type: 'image_url', image_url: { url: imageDataUrl } },
      ],
    },
  ]
}

/**
 * Send one plate's image to the configured vision model and parse its answer
 * into a `SubjectDefinition`.
 *
 * Caller's job, not this function's: claiming `gpuBusy` before calling this
 * (exactly like every other LLM path in `app/state.tsx`) and releasing it in
 * a `finally` — this function fires exactly one request (plus `llm.ts`'s own
 * bounded continuation recovery) and does not touch the mutex itself, so it
 * can be unit-tested without the app's React state.
 */
export async function analyzeSubjectImage(opts: {
  provider: Provider
  model: string
  imageDataUrl: string
  temperature?: number
  maxTokens: number
  signal?: AbortSignal
}): Promise<{ def: SubjectDefinition; reasoning: string }> {
  const messages = buildSubjectAnalysisMessages(opts.imageDataUrl)

  const result = await streamChatComplete({
    provider: opts.provider,
    model: opts.model,
    messages,
    temperature: opts.temperature ?? 0.2,
    maxTokens: resolveVisionMaxTokens(opts.maxTokens),
    signal: opts.signal,
    onDelta: () => {},
    maxContinuations: 2,
  })

  if (!result.text.trim()) {
    // Empty `content` is a distinct failure from a short one — see
    // MIN_VISION_MAX_TOKENS above — and must surface as an error, never as a
    // silently-accepted empty subject definition.
    const chars = result.reasoning.trim().length
    const thinking = chars ? `${chars.toLocaleString()} characters of thinking` : 'nothing'

    if (result.unterminatedThink) {
      throw new Error(
        `The model opened a <think> block and never closed it, so its whole reply (${thinking}) was counted as thinking and no answer came out. Re-running usually clears it.`,
      )
    }
    if (result.finishReason === 'length') {
      throw new Error(
        result.sentLimit
          ? `Cut off at the ${result.sentLimit.toLocaleString()}-token ceiling after ${thinking}, before any answer. Raise the output length in Settings.`
          : `The model ran out of room after ${thinking}, before writing an answer — the server's own limit, not one sent from here.`,
      )
    }
    throw new Error(`The model returned no content${result.finishReason ? ` (finish reason: ${result.finishReason})` : ''}.`)
  }

  const def = parseSubjectDefinition(result.text)
  if (!def) throw new Error('The model did not return the expected JSON subject definition — try again, or a smaller/different model.')
  return { def, reasoning: result.reasoning.trim() }
}
