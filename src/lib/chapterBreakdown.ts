import type { Breakdown, BreakdownClip, ClipRole, Shot, ShotGroup, ShotList } from './types'

/**
 * A whole-chapter, ONE-CALL breakdown into fixed-15s H3 clips of 3-6 named-
 * camera shots — the founder's own hand-run workflow, made structured.
 *
 * ── Why this exists alongside `shotList.ts`'s two-pass planner ───────────
 *
 * `shotList.ts` decides beats and shots but deliberately leaves camera,
 * performance and sound to a LATER per-clip expansion call (`Shot.covers` is
 * "no camera" by contract — see its own module doc). This planner is the
 * opposite: the skill it implements
 * (`clip-shot-breakdown-skill.md`, carried in `CHAPTER_BREAKDOWN_TEMPLATE`)
 * decides the camera per shot INSIDE the same call that decides the shots,
 * because its whole point is to hand a ComfyUI-side rewriter (`rewrite_mode:
 * "pending clips"`) a plain-English "raw ask" per clip that already reads
 * like a shot list, not a plot summary — see `formatClipRawAsk`.
 *
 * So this is a THIRD route to a `Breakdown` (`shotList.ts`'s two-pass beats→
 * subdivide→group pipeline is the second; the old single-call `breakdown`
 * stage in `stages.ts` is the first), selected by `breakdownPlanner.ts`'s
 * switch. It still derives a `ShotList`/`ShotGroup[]` too — one shot per
 * skill shot, one group per skill clip, groups already exactly clip-sized —
 * purely so the REST of Full Story mode (the shot-list panel, "the clip in
 * hand", `approveShotGroups`/`takeShotGroups`) needs no branching at all: it
 * cannot tell this plan apart from one `groupShotsIntoClips` packed.
 *
 * ── The GBNF-safety choices in `chapterBreakdownResponseFormat` ──────────
 *
 * Two things this repo has already paid for, kept in mind here (memory:
 * `gbnf-breaks-local-runs`, `2026-09-10-gbnf-guarantees-shape-never-
 * semantics`, and `schema.ts`'s own module comment about a decomposed
 * variant inducing structural-token leakage):
 *
 *   1. No `pattern` anywhere, and no `maxLength` at all (not "under 1000" —
 *      simply absent; nothing here needs a length cap the grammar would have
 *      to expand).
 *   2. `dialogue` is NOT encoded as a nullable object (`type: ["object",
 *      "null"]`) or a `oneOf`. Both are unmeasured on this box, and the
 *      decomposed-shot probe already showed this exact grammar inventing
 *      structural tokens (`'},{'`, `'>=1'`) in a free string slot the moment
 *      a field needed a FORMAT rather than plain prose. A nullable-object
 *      union is exactly that shape: "sometimes an object, sometimes a bare
 *      null token." Instead `dialogue` is FLATTENED into three plain,
 *      always-present fields — `hasDialogue: boolean`, `dialogueSpeaker:
 *      string`, `dialogueLine: string` — and `parseChapterBreakdown` folds
 *      them back into the ergonomic `{speaker, line} | null` shape the rest
 *      of this file and its callers actually use. Flat booleans and strings
 *      are the two primitives this codebase has already measured as safe.
 */

export const CAMERA_SHOTS = [
  'wide_establishing',
  'medium',
  'medium_close',
  'close_up',
  'extreme_close_up_macro',
  'tracking_following',
  'over_the_shoulder',
  'top_down_overhead',
  'low_angle',
  'high_angle',
] as const

export type CameraShot = (typeof CAMERA_SHOTS)[number]

/** Operator-facing label for the raw-ask formatter — the skill's own
 * wording (`clip-shot-breakdown-skill.md`'s "Camera Language to Use"),
 * never the snake_case wire value. */
export const CAMERA_LABELS: Record<CameraShot, string> = {
  wide_establishing: 'Wide',
  medium: 'Medium',
  medium_close: 'Medium Close',
  close_up: 'Close Up',
  extreme_close_up_macro: 'Extreme Close Up / Macro',
  tracking_following: 'Tracking',
  over_the_shoulder: 'Over-the-shoulder',
  top_down_overhead: 'Top Down / Overhead',
  low_angle: 'Low Angle',
  high_angle: 'High Angle',
}

export interface ChapterBreakdownDialogue {
  speaker: string
  line: string
}

export interface ChapterBreakdownShot {
  /** 1-based, within this clip. */
  shot: number
  seconds: number
  camera: CameraShot
  subject: string
  action: string
  dialogue: ChapterBreakdownDialogue | null
}

export interface ChapterBreakdownClip {
  /** 1-based, within this chapter. */
  clip: number
  /** The beat/role this clip covers in one line — the skill's own "what
   * dramatic unit is this" note, not a duration or a camera decision. */
  beat: string
  shots: ChapterBreakdownShot[]
  /** "End every clip with tension, a question, or a forward pull into the
   * next clip" — the skill's own phrase for it. */
  forwardPull: string
}

export interface ChapterBreakdown {
  /** The chapter's own spine/title, in one line. */
  chapter: string
  clips: ChapterBreakdownClip[]
  at: number
}

export const CHAPTER_BREAKDOWN_SHOT_MIN = 3
export const CHAPTER_BREAKDOWN_SHOT_MAX = 6
export const CHAPTER_BREAKDOWN_CLIP_SECONDS = 15
/** How far a clip's shot-seconds may drift from exactly 15 before
 * `checkChapterBreakdown` flags it — the task brief's own "(±0.5)". */
export const CHAPTER_BREAKDOWN_SECONDS_TOLERANCE = 0.5

/**
 * The skill, adapted to demand data rather than prose — `{{chapter}}` is the
 * one placeholder, filled by `fillChapterBreakdownTemplate`. No skills, no
 * system prompt: same discipline as `shotList.ts`'s `BEAT_LIST_TEMPLATE` —
 * "the template is the whole ask" — because the shape is already carried by
 * `chapterBreakdownResponseFormat`, not by prose the model has to remember.
 */
export const CHAPTER_BREAKDOWN_TEMPLATE = `Break the chapter below into fixed 15-second video clips, each built from 3-6 shots.

RULES — a clip is one continuous narrative beat; a shot is one discrete camera angle inside it.

- Every clip is exactly 15 seconds of shots (they must sum to 15, plus or minus half a second).
- 3-4 shots per clip by default. Only use 5-6 when the beat truly demands rapid cuts. Never fewer than 3, never more than 6.
- Follow a setup -> action -> reaction -> payoff arc, compressed to fit the shot count: shot 1 establishes where/who/what state; the middle shot(s) carry the action that moves the beat forward; the last shot is the reaction or the payoff — usually a line of dialogue, a held look, or a final gesture.
- Vary the camera between consecutive shots in the SAME clip — never the same camera term twice in a row.
- One action per shot. If a character does two distinct things, that's two shots.
- Dialogue gets its OWN shot (or is attached to the payoff shot) — never buried inside a multi-action shot. Dialogue is in the target language/script only, verbatim, no translation or gloss.
- End every clip with tension, a question, or a forward pull into the next clip — the last shot should make the audience need the next 15 seconds.
- No shot should require having seen a previous clip to make sense — each clip is visually self-contained.
- Camera per shot must be exactly one of these terms (spelled verbatim, snake_case): ${CAMERA_SHOTS.join(', ')}.

CHAPTER:
{{chapter}}

Return the breakdown as data: the chapter's own spine in one line, then every clip in order with its beat, its shots (camera, subject, the physical action, and — only on the shot where someone actually speaks — the speaker and their exact line), and the forward pull that closes it.`

export function fillChapterBreakdownTemplate(template: string, chapter: string): string {
  return template.replace('{{chapter}}', chapter.trim())
}

/**
 * The `response_format` for the whole-chapter call — nested arrays,
 * `minItems`/`maxItems` on `shots` (a first for this codebase; see the
 * module comment), a `camera` enum, and dialogue flattened to plain
 * booleans/strings rather than a nullable object. `strict: true` +
 * `additionalProperties: false` throughout, same contract as every other
 * `*ResponseFormat` in this codebase (`shotList.ts`, `direction.ts`).
 */
export function chapterBreakdownResponseFormat(): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'chapter_breakdown',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['chapter', 'clips'],
        properties: {
          chapter: { type: 'string', description: "The chapter's own spine, in one line." },
          clips: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['clip', 'beat', 'shots', 'forward_pull'],
              properties: {
                clip: { type: 'integer', description: '1-based position of this clip in the chapter.' },
                beat: { type: 'string', description: 'What dramatic beat/unit this 15s clip covers, in one line. No camera, no shot-by-shot detail — that is the shots array.' },
                shots: {
                  type: 'array',
                  minItems: CHAPTER_BREAKDOWN_SHOT_MIN,
                  maxItems: CHAPTER_BREAKDOWN_SHOT_MAX,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['shot', 'seconds', 'camera', 'subject', 'action', 'has_dialogue', 'dialogue_speaker', 'dialogue_line'],
                    properties: {
                      shot: { type: 'integer', description: '1-based position of this shot within the clip.' },
                      seconds: { type: 'number', description: "This shot's own length. Every clip's shots must sum to 15." },
                      camera: { type: 'string', enum: [...CAMERA_SHOTS], description: 'Exactly one term from the fixed camera list, spelled verbatim.' },
                      subject: { type: 'string', description: 'Who or what is on screen — no camera language here.' },
                      action: { type: 'string', description: 'The one physical action or state this shot shows — one verb, not several.' },
                      has_dialogue: { type: 'boolean', description: 'True only on the shot where a line is actually spoken.' },
                      dialogue_speaker: { type: 'string', description: 'Who speaks, when has_dialogue is true. Empty string otherwise.' },
                      dialogue_line: { type: 'string', description: 'The exact spoken line, verbatim, target language/script only, when has_dialogue is true. Empty string otherwise.' },
                    },
                  },
                },
                forward_pull: { type: 'string', description: "The tension, question or forward pull this clip closes on — what makes the audience need the next 15 seconds." },
              },
            },
          },
        },
      },
    },
  }
}

function stripFence(raw: string): string {
  return raw.replace(/```(?:json)?/gi, '')
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const s = stripFence(raw.trim())
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const v = JSON.parse(s.slice(a, b + 1)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function coerceCamera(v: unknown): CameraShot {
  return (CAMERA_SHOTS as readonly string[]).includes(v as string) ? (v as CameraShot) : 'medium'
}

function coerceShot(v: unknown, fallbackShot: number): ChapterBreakdownShot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const hasDialogue = o.has_dialogue === true
  const speaker = typeof o.dialogue_speaker === 'string' ? o.dialogue_speaker.trim() : ''
  const line = typeof o.dialogue_line === 'string' ? o.dialogue_line.trim() : ''
  return {
    shot: Number.isFinite(Number(o.shot)) ? Number(o.shot) : fallbackShot,
    seconds: Number(o.seconds) || 0,
    camera: coerceCamera(o.camera),
    subject: typeof o.subject === 'string' ? o.subject.trim() : '',
    action: typeof o.action === 'string' ? o.action.trim() : '',
    dialogue: hasDialogue && (speaker || line) ? { speaker, line } : null,
  }
}

function coerceClip(v: unknown, fallbackClip: number): ChapterBreakdownClip | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.shots) || !o.shots.length) return null
  const shots = o.shots
    .map((s, i) => coerceShot(s, i + 1))
    .filter((s): s is ChapterBreakdownShot => !!s)
  if (!shots.length) return null
  return {
    clip: Number.isFinite(Number(o.clip)) ? Number(o.clip) : fallbackClip,
    beat: typeof o.beat === 'string' ? o.beat.trim() : '',
    shots,
    forwardPull: typeof o.forward_pull === 'string' ? o.forward_pull.trim() : '',
  }
}

/**
 * Validate-and-coerce, never throw — same discipline as `shotList.ts`'s
 * `parseBeatList`/`extractJsonObject`. Returns `null` only when the reply
 * carries no usable clip at all (a truncated or garbled reply); a clip with
 * a malformed field still comes back with that field defaulted, since a
 * missing camera term is a fact for `checkChapterBreakdown` to surface, not
 * a reason to discard the whole chapter.
 */
export function parseChapterBreakdown(raw: string): ChapterBreakdown | null {
  const obj = extractJsonObject(raw)
  if (!obj) return null
  if (typeof obj.chapter !== 'string' || !Array.isArray(obj.clips) || !obj.clips.length) return null
  const clips = obj.clips
    .map((c, i) => coerceClip(c, i + 1))
    .filter((c): c is ChapterBreakdownClip => !!c)
  if (!clips.length) return null
  return { chapter: obj.chapter.trim(), clips, at: Date.now() }
}

// ── deterministic checks — plain fact strings, never a throw ─────────────
//
// Same contract as `shotList.ts`'s `groupShotsIntoClips`/`checkThinBrief`:
// disclose a hazard, never block or refuse. The grammar guarantees SHAPE
// (3-6 shots, a real camera term) — these catch SEMANTICS the grammar
// cannot: whether the seconds actually add to 15, whether the camera
// actually varies shot to shot, whether a dialogue line fits its shot.

/** Budget from `h3-vocal-performance`'s own "Words per second" contract:
 * 1.5-2 words/second for an average speaker: slow delivery needs the low
 * end, so a line above the HIGH end of that (with a margin, since punctuation
 * and short interjections count as words here too) is the one worth
 * flagging — it is the direction that mangles audio, per that skill. */
export const DIALOGUE_WORDS_PER_SECOND_MAX = 2.2

function wordCount(line: string): number {
  return line.trim().split(/\s+/).filter(Boolean).length
}

export function checkChapterBreakdown(b: ChapterBreakdown): string[] {
  const issues: string[] = []
  for (const clip of b.clips) {
    const n = clip.shots.length
    if (n < CHAPTER_BREAKDOWN_SHOT_MIN || n > CHAPTER_BREAKDOWN_SHOT_MAX) {
      issues.push(`clip ${clip.clip} has ${n} shot${n === 1 ? '' : 's'} — outside the ${CHAPTER_BREAKDOWN_SHOT_MIN}-${CHAPTER_BREAKDOWN_SHOT_MAX} range.`)
    }
    const total = clip.shots.reduce((sum, s) => sum + s.seconds, 0)
    const drift = Math.abs(total - CHAPTER_BREAKDOWN_CLIP_SECONDS)
    if (drift > CHAPTER_BREAKDOWN_SECONDS_TOLERANCE) {
      issues.push(`clip ${clip.clip}'s shots sum to ${total.toFixed(1)}s — ${drift.toFixed(1)}s off the ${CHAPTER_BREAKDOWN_CLIP_SECONDS}s target.`)
    }
    for (let i = 1; i < clip.shots.length; i++) {
      if (clip.shots[i].camera === clip.shots[i - 1].camera) {
        issues.push(`clip ${clip.clip}, shots ${clip.shots[i - 1].shot}-${clip.shots[i].shot} repeat the same camera (${CAMERA_LABELS[clip.shots[i].camera]}) back-to-back.`)
      }
    }
    for (const s of clip.shots) {
      if (!s.dialogue?.line) continue
      const words = wordCount(s.dialogue.line)
      const wps = s.seconds > 0 ? words / s.seconds : Infinity
      if (wps > DIALOGUE_WORDS_PER_SECOND_MAX) {
        issues.push(`clip ${clip.clip} shot ${s.shot}: ${words} words in ${s.seconds.toFixed(1)}s is ${wps.toFixed(1)} words/s — over the ${DIALOGUE_WORDS_PER_SECOND_MAX} words/s ceiling H3 dialogue tends to mangle past.`)
      }
    }
  }
  return issues
}

// ── the raw-ask formatter ─────────────────────────────────────────────────

function formatSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1)
}

/**
 * One shot, in the skill's own quick-reference form: "Shot N – [Camera] as
 * [subject] [action]. (Ns)", dialogue quoted verbatim on the shot that
 * carries it — this is deterministic reconstruction, not a second model
 * call, so the same clip always renders to the same text.
 */
export function formatShotLine(s: ChapterBreakdownShot): string {
  const camera = CAMERA_LABELS[s.camera] ?? s.camera
  let body = [s.subject, s.action].map((x) => x.trim()).filter(Boolean).join(' ')
  if (s.dialogue?.line) {
    const sep = /[.!?,]$/.test(body) ? '' : ','
    const speaker = s.dialogue.speaker ? `${s.dialogue.speaker} says` : 'says'
    body = body ? `${body}${sep} ${speaker} "${s.dialogue.line}"` : `${speaker} "${s.dialogue.line}"`
  }
  if (!/[.!?]$/.test(body)) body += '.'
  return `Shot ${s.shot} – ${camera} as ${body} (${formatSeconds(s.seconds)}s)`
}

/**
 * A whole clip as the plain-text "raw ask" the founder used to hand-paste
 * into the Master Extender's `clips_json.prompt` before this existed — the
 * exact text the rewriter-authored path (`extenderSettings.ts`'s
 * `rewrite_mode: "pending clips"`) sends per clip, and what a Studio-authored
 * clip falls back to as `BreakdownClip.covers` via `chapterBreakdownToPlan`.
 */
export function formatClipRawAsk(clip: ChapterBreakdownClip): string {
  const lines = [`Clip ${clip.clip}:`, '', ...clip.shots.map(formatShotLine)]
  if (clip.forwardPull.trim()) lines.push('', clip.forwardPull.trim())
  return lines.join('\n')
}

// ── mapping into the rest of Full Story mode ──────────────────────────────

function roleForPosition(i: number, n: number): ClipRole {
  if (n <= 1) return 'standalone'
  if (i === 0) return 'opening'
  if (i === n - 1) return 'closing'
  return 'rising'
}

/**
 * `ShotList` + one `ShotGroup` per clip (already exactly clip-sized — no
 * packing to do, the model already decided the boundaries) — so every
 * existing Full Story screen (the shot-list panel, "the clip in hand",
 * `approveShotGroups`/`takeShotGroups`) sees exactly the shape
 * `groupShotsIntoClips` would have produced, and cannot tell this plan
 * apart from that one. `Shot.covers` is `formatShotLine` — camera included,
 * unlike the beats/subdivide planner's shots, which is a deliberate
 * divergence: this planner's whole point is deciding camera up front (see
 * the module comment).
 */
export function chapterBreakdownToShotList(b: ChapterBreakdown): { shotList: ShotList; groups: ShotGroup[] } {
  const shots: Shot[] = []
  const groups: ShotGroup[] = []
  let globalIndex = 0
  for (const clip of b.clips) {
    const shotIndices: number[] = []
    let seconds = 0
    for (const s of clip.shots) {
      globalIndex++
      shots.push({ index: globalIndex, covers: formatShotLine(s), seconds: s.seconds })
      shotIndices.push(globalIndex)
      seconds += s.seconds
    }
    groups.push({ index: clip.clip, shotIndices, seconds })
  }
  const maxRuntimeSeconds = groups.reduce((sum, g) => sum + g.seconds, 0)
  return {
    shotList: { spine: b.chapter, maxRuntimeSeconds, shots, at: b.at },
    groups,
  }
}

/**
 * `Breakdown` derived DIRECTLY from a `ChapterBreakdown` — used only where
 * the full multi-line raw-ask text (header + forward pull, not just the
 * space-joined shot lines `takeShotGroups`/`breakdownClipsFromShotGroups`
 * would produce) is wanted as `covers`, e.g. a one-shot preview before the
 * operator ever approves a group. The normal Full Story path goes through
 * `chapterBreakdownToShotList` + the existing `approveShotGroups` instead,
 * so this is a convenience, not the primary wiring.
 */
export function chapterBreakdownToBreakdown(b: ChapterBreakdown): Breakdown {
  const n = b.clips.length
  const clips: BreakdownClip[] = b.clips.map((clip, i) => ({
    index: clip.clip,
    title: `Clip ${clip.clip}`,
    role: roleForPosition(i, n),
    seconds: clip.shots.reduce((sum, s) => sum + s.seconds, 0),
    covers: formatClipRawAsk(clip),
    precedes: '',
    follows: clip.forwardPull,
  }))
  return { spine: b.chapter, clips, at: b.at }
}

/** The raw ask for one clip of a `ChapterBreakdown`, by `BreakdownClip.index`
 * — what the rewriter-authored render path sends as `clips_json[i].prompt`.
 * `undefined` when this film's plan did not come from this planner (a plain
 * `covers` fallback is the caller's job — see `extenderSettings.ts`'s
 * module comment on `authoringMode`). */
export function rawAskForClipIndex(b: ChapterBreakdown | undefined, clipIndex: number): string | undefined {
  const clip = b?.clips.find((c) => c.clip === clipIndex)
  return clip ? formatClipRawAsk(clip) : undefined
}
