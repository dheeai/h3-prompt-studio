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
  /** ONLY this clip's own state changes — a sparse delta, never a full
   * snapshot. See the module comment on the state ledger, below. */
  stateChanges: StateChange[]
}

export interface ChapterBreakdown {
  /** The chapter's own spine/title, in one line. */
  chapter: string
  /** Entities + axes + chapter-opening values — see the module comment on
   * the state ledger, below. Always present (an empty `entities: []]` for a
   * chapter this planner decided needs no tracked state). */
  ledger: Ledger
  clips: ChapterBreakdownClip[]
  at: number
}

// ── the state ledger (character/prop/creature/environment axes) ──────────
//
// Design: `~/Projects/dhee-cofounder/memory/2026-09-21-character-and-prop-
// state-ledger.md`. Ported to match `~/.kshana/bundles/h3_chapter`'s
// `schemas/chapter_breakdown.schema.json` / `validators/
// chapter_breakdown_checks.mjs` / `runners/dhee-runner-h3-chapter-plan/src/
// text.ts` EXACTLY (types, field names on the wire, `foldLedger`/
// `formatStateBlocks` logic) — that bundle and this file both author from
// the same one-call contract, and must not drift apart. TS uses camelCase
// (`clipIds`, `plateVisible`) the same way this file already does for
// `forwardPull`/`hasDialogue`-equivalents; the WIRE schema below uses the
// bundle's own snake_case (`clip_ids`, `plate_visible`) — that pairing is
// this file's own existing convention, not a departure from it.
//
// Folded into the SAME one breakdown call, per the founder's 2026-09-24
// simplification (no separate state-ledger LLM call): `ledger.entities[]`
// proposes axes + initial values FIRST (the model writes top to bottom, so
// it must decide the axes before it can reference them in `state_changes`);
// each clip then carries ONLY its own `stateChanges` — a sparse delta,
// never a full per-clip snapshot, which is what keeps the reply small. CODE
// (`foldLedger`), never the model, folds `initial` + the ordered
// `state_changes` forward into each clip's START-of-clip state, so a clip's
// start state is a pure function of everything before it and can never
// drift from the model's own account of "what changed when".

export interface StateAxis {
  axis: string
  options: string[]
  /** True only when this axis can never move BACKWARDS through its own
   * options list within this chapter (an injury does not un-happen). */
  progressive: boolean
  /** True only when this axis is something the entity's OWN reference plate
   * would show (wardrobe, a carried object, a visible marking). */
  plateVisible: boolean
}

export interface LedgerEntity {
  id: string
  name: string
  kind: 'character' | 'prop' | 'creature' | 'environment'
  /** Every clip (1-based clip number) this entity is on screen in, or — for
   * kind:'environment' — every clip set at that location. */
  clipIds: number[]
  axes: StateAxis[]
  /** This entity's value on every axis at the chapter's opening, before
   * clip 1. One entry per axis declared above. */
  initial: Array<{ axis: string; value: string }>
}

export interface StateChange {
  /** One of `ledger.entities[].id`. */
  entity: string
  /** One of that entity's own declared axes. */
  axis: string
  /** The new value — must be one of that axis's declared options. */
  to: string
  /** The 1-based shot WITHIN THIS CLIP where the change happens. */
  shot: number
}

export interface Ledger {
  entities: LedgerEntity[]
}

/** entityId -> axis -> value, as of a point in the fold. */
export type StateMap = Map<string, Map<string, string>>

export const CHAPTER_BREAKDOWN_SHOT_MIN = 3
export const CHAPTER_BREAKDOWN_SHOT_MAX = 6
export const CHAPTER_BREAKDOWN_CLIP_SECONDS = 15
/** How far a clip's shot-seconds may drift from exactly 15 before
 * `checkChapterBreakdown` flags it — the task brief's own "(±0.5)". */
export const CHAPTER_BREAKDOWN_SECONDS_TOLERANCE = 0.5

/**
 * The skill, adapted to demand data rather than prose — `{{chapter}}` and
 * `{{runtimeInstruction}}` are the two placeholders, filled by
 * `fillChapterBreakdownTemplate`. No skills, no system prompt: same
 * discipline as `shotList.ts`'s `BEAT_LIST_TEMPLATE` — "the template is the
 * whole ask" — because the shape is already carried by
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

{{runtimeInstruction}}

STATE LEDGER — before writing the clips, propose a small ledger of what actually CHANGES visibly during this chapter:
- One entry per character, prop, creature, or location-as-environment whose visible state changes (wardrobe, condition, possession, consciousness, restraint for people; configuration, integrity, fill, activation for objects/environments — a lamp lit or not, a door open or not). Do NOT track a permanent trait as an axis, and do NOT invent an entity with nothing that changes.
- Each entity declares its own small set of axes, each axis a short ordered list of options (least to most, for anything that can only move one way — an injury does not heal mid-chapter) and whether it is progressive (can never move backwards) and whether it would show on that entity's own reference plate (wardrobe, a visible marking — never posture or mood).
- Give every entity its value on every one of its own axes at the chapter's OPENING, before clip 1.
- Then, per clip, list ONLY the state changes that actually happen in THAT clip (which entity, which axis, its new value, and which shot causes it) — never restate a value that did not change, and never repeat earlier clips' changes.

CHAPTER:
{{chapter}}

Return the breakdown as data: the state ledger first (entities, their axes, their opening values), then every clip in order with its beat, its shots (camera, subject, the physical action, and — only on the shot where someone actually speaks — the speaker and their exact line), its own state changes if any, and the forward pull that closes it.`

/**
 * Auto lets the model decide how many clips the chapter needs; Target
 * demands EXACTLY N, reached by re-grained coverage of the SAME events
 * rather than compression/padding or invented events. See
 * `chapterBreakdownRuntimeInstruction`.
 */
export type ChapterBreakdownRuntimeMode = 'auto' | 'target'

/**
 * The one clause that varies between the two runtime modes — everything
 * else in `CHAPTER_BREAKDOWN_TEMPLATE` is shared. Target mode's wording is
 * the SAME "reach it by finer/coarser grain, never invented events" contract
 * `shotList.ts`'s `SHOT_SUBDIVIDE_TEMPLATE` already uses for beat->shot
 * subdivision, applied one level up (chapter->clip): the two must not read
 * as different rules for the same idea.
 */
export function chapterBreakdownRuntimeInstruction(mode: ChapterBreakdownRuntimeMode, targetClips?: number): string {
  if (mode === 'target' && targetClips && targetClips > 0) {
    return `RUNTIME — TARGET, NOT A CEILING OR A FLOOR: this chapter must become EXACTLY ${targetClips} clip${targetClips === 1 ? '' : 's'} of 15 seconds each (${targetClips * 15}s total) — not one more, not one fewer. Reach EXACTLY ${targetClips} by covering the SAME events at a finer or coarser grain — more or fewer clips, longer or shorter dwell on each beat — never by inventing events the chapter does not contain, and never by compressing two distinct dramatic beats into one clip or stretching one beat thin across several just to fill the count.`
  }
  return `RUNTIME — AUTO: decide how many 15-second clips this chapter genuinely needs, one clip per distinct dramatic beat. Do not compress two beats into one clip, and do not pad a single beat across several clips just to run longer. The clip count follows the STORY, not a target.`
}

export function fillChapterBreakdownTemplate(template: string, chapter: string, mode: ChapterBreakdownRuntimeMode = 'auto', targetClips?: number): string {
  return template
    .replace('{{runtimeInstruction}}', chapterBreakdownRuntimeInstruction(mode, targetClips))
    .replace('{{chapter}}', chapter.trim())
}

/**
 * Target mode's own deterministic check — outside `checkChapterBreakdown`
 * (which knows nothing about runtime mode) because it is the ONE check this
 * planner retries on: `state.tsx`'s `runChapterBreakdown` calls this right
 * after parsing and, on a mismatch, resubmits ONCE with the complaint
 * appended, mirroring `shotList.ts`'s own retry-on-miss discipline for a
 * runtime target. Empty (no complaint) in auto mode, or when the count
 * already matches.
 */
export function checkClipCount(b: ChapterBreakdown, mode: ChapterBreakdownRuntimeMode, targetClips?: number): string[] {
  if (mode !== 'target' || !targetClips) return []
  const actual = b.clips.length
  if (actual === targetClips) return []
  return [`This chapter came back as ${actual} clip${actual === 1 ? '' : 's'} — the target is EXACTLY ${targetClips}. Reach ${targetClips} by covering the same events at a finer or coarser grain, never by inventing or dropping events.`]
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
        // `ledger` BEFORE `clips` — the model writes top to bottom, and
        // `clips[].state_changes` cites `ledger.entities[].id`/axis/option,
        // so the ledger has to exist in the reply before anything can
        // reference it. Matches `~/.kshana/bundles/h3_chapter/schemas/
        // chapter_breakdown.schema.json`'s own property order exactly.
        required: ['chapter', 'ledger', 'clips'],
        properties: {
          chapter: { type: 'string', description: "The chapter's own spine, in one line." },
          ledger: {
            type: 'object',
            additionalProperties: false,
            required: ['entities'],
            description: 'Entities whose visible state changes during this chapter — see the module comment on the state ledger. Empty entities array when nothing worth tracking changes.',
            properties: {
              entities: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['id', 'name', 'kind', 'clip_ids', 'axes', 'initial'],
                  properties: {
                    id: { type: 'string', description: 'A short stable slug for this entity.' },
                    name: { type: 'string' },
                    kind: { type: 'string', enum: ['character', 'prop', 'creature', 'environment'] },
                    clip_ids: { type: 'array', items: { type: 'integer' }, description: "Every clip (1-based) this entity is on screen in, or — for kind:'environment' — set at that location." },
                    axes: {
                      type: 'array',
                      description: 'Only axes that actually change during this chapter and are visible when they do. May be empty for an entity tracked only for presence.',
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['axis', 'options', 'progressive', 'plate_visible'],
                        properties: {
                          axis: { type: 'string', description: 'Short name, e.g. wardrobe, condition, possession, consciousness, configuration, activation.' },
                          options: { type: 'array', items: { type: 'string' }, description: "This axis's own values, least to most for a progressive axis." },
                          progressive: { type: 'boolean', description: 'True only when this axis can never move backwards through its own options within this chapter.' },
                          plate_visible: { type: 'boolean', description: "True only when this axis is something the entity's own reference plate would show." },
                        },
                      },
                    },
                    initial: {
                      type: 'array',
                      description: "This entity's value on every axis at the chapter's opening, before clip 1. One entry per axis declared above.",
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['axis', 'value'],
                        properties: { axis: { type: 'string' }, value: { type: 'string', description: "Must be one of that axis's own options." } },
                      },
                    },
                  },
                },
              },
            },
          },
          clips: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['clip', 'beat', 'shots', 'forward_pull', 'state_changes'],
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
                state_changes: {
                  type: 'array',
                  description: 'ONLY this clip\'s own changes — a sparse delta, never a full snapshot of every entity\'s every axis. Empty when nothing changes in this clip.',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['entity', 'axis', 'to', 'shot'],
                    properties: {
                      entity: { type: 'string', description: 'One of ledger.entities[].id.' },
                      axis: { type: 'string', description: "One of that entity's own declared axes." },
                      to: { type: 'string', description: "The new value — must be one of that axis's declared options." },
                      shot: { type: 'integer', description: 'The 1-based shot WITHIN THIS CLIP where the change happens.' },
                    },
                  },
                },
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

function coerceStateChange(v: unknown): StateChange | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.entity !== 'string' || typeof o.axis !== 'string' || typeof o.to !== 'string') return null
  return { entity: o.entity.trim(), axis: o.axis.trim(), to: o.to.trim(), shot: Number.isFinite(Number(o.shot)) ? Number(o.shot) : 0 }
}

function coerceClip(v: unknown, fallbackClip: number): ChapterBreakdownClip | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.shots) || !o.shots.length) return null
  const shots = o.shots
    .map((s, i) => coerceShot(s, i + 1))
    .filter((s): s is ChapterBreakdownShot => !!s)
  if (!shots.length) return null
  const stateChanges = (Array.isArray(o.state_changes) ? o.state_changes : [])
    .map(coerceStateChange)
    .filter((c): c is StateChange => !!c)
  return {
    clip: Number.isFinite(Number(o.clip)) ? Number(o.clip) : fallbackClip,
    beat: typeof o.beat === 'string' ? o.beat.trim() : '',
    shots,
    forwardPull: typeof o.forward_pull === 'string' ? o.forward_pull.trim() : '',
    stateChanges,
  }
}

function coerceAxis(v: unknown): StateAxis | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.axis !== 'string') return null
  const options = (Array.isArray(o.options) ? o.options : []).filter((x): x is string => typeof x === 'string')
  return { axis: o.axis.trim(), options, progressive: o.progressive === true, plateVisible: o.plate_visible === true }
}

function coerceEntity(v: unknown): LedgerEntity | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.id !== 'string' || !o.id.trim()) return null
  const KINDS = ['character', 'prop', 'creature', 'environment'] as const
  const kind = KINDS.includes(o.kind as (typeof KINDS)[number]) ? (o.kind as LedgerEntity['kind']) : 'character'
  const clipIds = (Array.isArray(o.clip_ids) ? o.clip_ids : []).map(Number).filter((n) => Number.isFinite(n))
  const axes = (Array.isArray(o.axes) ? o.axes : []).map(coerceAxis).filter((a): a is StateAxis => !!a)
  const initial = (Array.isArray(o.initial) ? o.initial : [])
    .map((i) => {
      if (!i || typeof i !== 'object') return null
      const io = i as Record<string, unknown>
      return typeof io.axis === 'string' && typeof io.value === 'string' ? { axis: io.axis.trim(), value: io.value.trim() } : null
    })
    .filter((i): i is { axis: string; value: string } => !!i)
  return { id: o.id.trim(), name: typeof o.name === 'string' ? o.name.trim() : o.id.trim(), kind, clipIds, axes, initial }
}

function coerceLedger(v: unknown): Ledger {
  if (!v || typeof v !== 'object') return { entities: [] }
  const o = v as Record<string, unknown>
  const entities = (Array.isArray(o.entities) ? o.entities : []).map(coerceEntity).filter((e): e is LedgerEntity => !!e)
  return { entities }
}

/**
 * Validate-and-coerce, never throw — same discipline as `shotList.ts`'s
 * `parseBeatList`/`extractJsonObject`. Returns `null` only when the reply
 * carries no usable clip at all (a truncated or garbled reply); a clip with
 * a malformed field still comes back with that field defaulted, since a
 * missing camera term is a fact for `checkChapterBreakdown` to surface, not
 * a reason to discard the whole chapter. A missing/malformed `ledger`
 * defaults to `{ entities: [] }` — the same "not tracked" state a chapter
 * genuinely needing no ledger would produce, so an older reply (or a
 * provider without schema support) still parses.
 */
export function parseChapterBreakdown(raw: string): ChapterBreakdown | null {
  const obj = extractJsonObject(raw)
  if (!obj) return null
  if (typeof obj.chapter !== 'string' || !Array.isArray(obj.clips) || !obj.clips.length) return null
  const clips = obj.clips
    .map((c, i) => coerceClip(c, i + 1))
    .filter((c): c is ChapterBreakdownClip => !!c)
  if (!clips.length) return null
  return { chapter: obj.chapter.trim(), ledger: coerceLedger(obj.ledger), clips, at: Date.now() }
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
  const entityById = new Map(b.ledger.entities.map((e) => [e.id, e]))

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

    // ── state_changes referential integrity — ported verbatim (semantics)
    // from ~/.kshana/bundles/h3_chapter/validators/chapter_breakdown_checks.mjs
    const shotNumbers = new Set(clip.shots.map((s) => s.shot))
    for (const change of clip.stateChanges) {
      const entity = entityById.get(change.entity)
      if (!entity) {
        issues.push(`clip ${clip.clip} state_changes cites entity '${change.entity}', which is not in ledger.entities[].id.`)
        continue
      }
      const axis = entity.axes.find((a) => a.axis === change.axis)
      if (!axis) {
        issues.push(`clip ${clip.clip} state_changes: entity '${change.entity}' has no axis '${change.axis}' declared in the ledger.`)
        continue
      }
      if (!axis.options.includes(change.to)) {
        issues.push(`clip ${clip.clip} state_changes: '${change.to}' is not one of ${entity.id}.${axis.axis}'s declared options (${axis.options.join(', ')}).`)
      }
      if (!shotNumbers.has(change.shot)) {
        issues.push(`clip ${clip.clip} state_changes cites shot ${change.shot}, which is not one of this clip's own shots (${[...shotNumbers].join(', ')}).`)
      }
    }
  }

  // ── progressive axes never move backwards, across the WHOLE chapter ──
  const sortedClips = [...b.clips].sort((a, c) => a.clip - c.clip)
  for (const entity of b.ledger.entities) {
    for (const axis of entity.axes) {
      if (!axis.progressive) continue
      const options = axis.options
      let lastIndex = options.indexOf(entity.initial.find((i) => i.axis === axis.axis)?.value ?? '')
      for (const clip of sortedClips) {
        const change = clip.stateChanges.find((c) => c.entity === entity.id && c.axis === axis.axis)
        if (!change) continue
        const idx = options.indexOf(change.to)
        if (idx === -1) continue // already flagged above
        if (lastIndex !== -1 && idx < lastIndex) {
          issues.push(`${entity.id}.${axis.axis} moves backwards at clip ${clip.clip} (from '${options[lastIndex]}' to '${change.to}') — this axis is progressive and its options are ordered least to most.`)
        }
        lastIndex = idx
      }
    }
  }

  issues.push(...checkRawAsksDistinct(b))
  return issues
}

/**
 * The lesson from the h3_chapter bundle's first live run
 * (dhee-runner-h3-chapter-plan#1): a per-clip step that cannot find its own
 * clip must never emit placeholder text — a walker scoping bug there handed
 * every clip the SAME upstream document, and a silent fallback wrote clip
 * 1's raw ask to disk for clips 2-5, all HASHING IDENTICALLY (the box's own
 * caching then compounded it). The Studio's per-clip lookups
 * (`rawAskForClipIndex`, keyed off `clipIndex` directly, no shared walker
 * cache) do not have that exact bug, but this is the same-shaped guard: a
 * pairwise check that two DIFFERENT clips' fully-assembled raw asks (shots +
 * state blocks) are never byte-identical, since that can only mean a
 * lookup/indexing bug, never a genuine coincidence — two real clips always
 * differ in at least their shot count, their camera sequence or their
 * dialogue. Called from `checkChapterBreakdown` (surfaced as an ordinary
 * disclosed issue at breakdown time) AND from `renderExtenderPlan`
 * (`state.tsx`), which REFUSES to submit — the actual "throw" moment,
 * because THAT is the step that would otherwise send corrupted, collided
 * text to the box.
 */
export function checkRawAsksDistinct(b: ChapterBreakdown): string[] {
  const issues: string[] = []
  const seenAt = new Map<string, number>()
  for (const clip of b.clips) {
    const text = rawAskForClipIndex(b, clip.clip)
    if (!text) {
      issues.push(`clip ${clip.clip}: could not build a raw ask at all — refusing to treat this as "nothing to say".`)
      continue
    }
    const priorClip = seenAt.get(text)
    if (priorClip !== undefined) {
      issues.push(`clip ${clip.clip}'s raw ask is byte-identical to clip ${priorClip}'s — almost certainly a lookup/indexing bug, not a real coincidence between two 15s clips.`)
    } else {
      seenAt.set(text, clip.clip)
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
  const subject = s.subject.trim()
  const action = s.action.trim()
  // `action` is usually a bare predicate continuing `subject` as ONE
  // sentence ("Nusrat's thumb" + "presses against the weave" -> "Nusrat's
  // thumb presses against the weave") — those join with a plain space, no
  // punctuation inserted between them. But `action` is sometimes a
  // SEPARATE, already-complete sentence of its own (a scene-setting
  // `subject` — "Nusrat's tailoring shop in the Surat cloth market" —
  // followed by "The shop is visible: …", itself a full sentence with its
  // OWN subject) — bug seen live: joined with a bare space this reads as
  // one run-on clause with no seam at all. A capitalised first letter of
  // `action` is what a model actually writes for "this starts a new
  // sentence" (a bare predicate never opens capitalised mid-shot), so it is
  // the deterministic signal this uses to choose ". " instead of " ".
  let body: string
  if (subject && action) {
    const startsNewSentence = /^[A-Z]/.test(action)
    const sep = startsNewSentence ? (/[.!?]$/.test(subject) ? '' : '.') + ' ' : ' '
    body = `${subject}${sep}${action}`
  } else {
    body = subject || action
  }
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

// ── the state ledger: fold + format — ported verbatim from
// ~/.kshana/runners/dhee-runner-h3-chapter-plan/src/text.ts (same function
// names, same logic) so the bundle and the Studio cannot drift apart. ─────

function initialStateMap(ledger: Ledger): StateMap {
  const map: StateMap = new Map()
  for (const e of ledger.entities) {
    const axisMap = new Map<string, string>()
    for (const a of e.initial) axisMap.set(a.axis, a.value)
    map.set(e.id, axisMap)
  }
  return map
}

function cloneStateMap(src: StateMap): StateMap {
  const out: StateMap = new Map()
  for (const [id, axisMap] of src) out.set(id, new Map(axisMap))
  return out
}

/**
 * Fold `ledger.initial` forward through every clip's `stateChanges`, in clip
 * order. Returns, per clip number, the state as of the START of that clip
 * (the running total from every PRIOR clip's changes) — this clip's own
 * changes are what moves it to its END state, available as that clip's own
 * `stateChanges`.
 */
export function foldLedger(ledger: Ledger, clips: Array<{ clip: number; stateChanges: StateChange[] }>): Map<number, StateMap> {
  const byClip = new Map<number, StateMap>()
  let running = initialStateMap(ledger)
  for (const c of [...clips].sort((a, b) => a.clip - b.clip)) {
    byClip.set(c.clip, cloneStateMap(running))
    const next = cloneStateMap(running)
    for (const change of c.stateChanges) {
      if (!next.has(change.entity)) next.set(change.entity, new Map())
      next.get(change.entity)!.set(change.axis, change.to)
    }
    running = next
  }
  return byClip
}

/**
 * Format the two raw-ask blocks for ONE clip, over only entities present in
 * it (`clipIds` includes this clip number). Every axis of an ON-SCREEN
 * entity is shown, at its CURRENT (start-of-clip) value, regardless of
 * whether that axis has ever changed from `initial` — the writer cannot see
 * the ledger, so an entity that enters the chapter already off its plate's
 * default (e.g. a soaked garment from clip 1, never "changed" because it
 * was never dry on screen) would otherwise never be told, silently dropping
 * a fact the render needs.
 *
 * Superseded 2026-09-25, matching `~/.kshana/runners/dhee-runner-h3-chapter-
 * plan/src/text.ts` commit `164e70c`: the PRIOR rule (mention an axis only
 * when it differs from `initial` or changes this clip) relied on every
 * plate-relevant axis being correctly tagged, and a single missed tag
 * silently dropped a permanent, never-changing, non-default state. An
 * entity NOT on screen this clip is never in this block at all — its own
 * changes still surface in the separate CHANGES block below, which is not
 * gated on on-screen-ness.
 */
export function formatStateBlocks(ledger: Ledger, startState: StateMap, clipChanges: StateChange[], clip: number): string {
  const byId = new Map(ledger.entities.map((e) => [e.id, e]))
  const onScreen = ledger.entities.filter((e) => e.clipIds.includes(clip))
  if (!onScreen.length) return ''

  const startLines: string[] = []
  for (const entity of onScreen) {
    if (!entity.axes.length) continue
    const axisMap = startState.get(entity.id) ?? new Map<string, string>()
    const line = entity.axes
      .map((a) => `${a.axis}=${axisMap.get(a.axis) ?? entity.initial.find((i) => i.axis === a.axis)?.value ?? ''}`)
      .join(', ')
    startLines.push(`${entity.name} (${entity.kind}): ${line}`)
  }

  const changeLines = clipChanges
    .filter((c) => byId.has(c.entity))
    .map((c) => `${byId.get(c.entity)!.name}.${c.axis} -> ${c.to} (shot ${c.shot})`)

  const parts: string[] = []
  if (startLines.length) parts.push(['STATE AT THE START OF THIS CLIP:', ...startLines].join('\n'))
  if (changeLines.length) parts.push(['CHANGES DURING THIS CLIP:', ...changeLines].join('\n'))
  return parts.join('\n\n')
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
    covers: rawAskForClipIndex(b, clip.clip) ?? formatClipRawAsk(clip),
    precedes: '',
    follows: clip.forwardPull,
  }))
  return { spine: b.chapter, clips, at: b.at }
}

/**
 * The raw ask for one clip of a `ChapterBreakdown`, by `BreakdownClip.index`
 * — what the rewriter-authored render path sends as `clips_json[i].prompt`,
 * and what `state.tsx`'s `rebuild()` hands preset D's `{{current}}`.
 * `undefined` when this film's plan did not come from this planner (a plain
 * `covers` fallback is the caller's job — see `extenderSettings.ts`'s
 * module comment on `authoringMode`).
 *
 * State-aware: when `b.ledger` has entities, the STATE AT THE START OF THIS
 * CLIP / CHANGES DURING THIS CLIP blocks (`formatStateBlocks`, folded via
 * `foldLedger`) are prepended, so BOTH writer paths — preset D and the
 * ComfyUI rewriter — see the ledger without either needing a second edge
 * to it. A breakdown with no ledger (or one whose model reply never
 * populated it) is unaffected: `formatStateBlocks` returns '' and this is
 * exactly `formatClipRawAsk`'s own output, unchanged.
 */
export function rawAskForClipIndex(b: ChapterBreakdown | undefined, clipIndex: number): string | undefined {
  const clip = b?.clips.find((c) => c.clip === clipIndex)
  if (!clip || !b) return undefined
  let text = formatClipRawAsk(clip)
  if (b.ledger.entities.length) {
    const byClip = foldLedger(b.ledger, b.clips)
    const startState = byClip.get(clipIndex)
    if (startState) {
      const stateText = formatStateBlocks(b.ledger, startState, clip.stateChanges, clipIndex)
      if (stateText) text = `${stateText}\n\n${text}`
    }
  }
  return text
}
