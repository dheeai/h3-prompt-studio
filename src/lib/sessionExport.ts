import { slugifyFilmName } from './extender'
import { filmLookPreset } from './filmLook'
import { pipelinePreset } from './pipeline'
import type { PipelinePresetId } from './pipeline'
import { sectionsFor } from './schema'
import { latestPromptForClip } from './stages'
import type { ClipRole, FilmLook, H3Mode, LoraStackEntry, ShotGroup, ShotList, Version } from './types'

/**
 * Turning a film into files on disk (the founder's "can I save the prompts
 * locally" ask). Kept entirely pure — no `window`, no IndexedDB, no
 * `FileSystemDirectoryHandle` — so every shape here is exercisable with
 * `node:test` the way `db.ts`'s `migrate()` and `extender.ts`'s graph
 * builder already are. The effectful half (actually writing to a granted
 * folder, or falling back to a download) lives in `fsExport.ts`, which is a
 * thin loop over the `ExportFile[]` `buildExportPlan` returns here.
 *
 * HARD CONSTRAINT (see the studio's own repo-hygiene guard,
 * `repoHygiene.test.ts`, and `checkExtenderSignature`'s neighbourhood in
 * `extender.ts`): nothing in this module ever takes a `ComfyEndpoint`, a
 * `Provider`, or a raw `LoraStackEntry.lora` filename as input. That is not
 * a filter applied to the output — it is a fact about the function
 * signatures below, which structurally cannot reach any of those fields.
 * The one place a LoRA stack shows up in a film's plan (`filmLoraStack`,
 * `BreakdownClip.loraStack`) is reduced through `redactLoraStack` to a count
 * and a strength/on-off list before it ever reaches a template string —
 * the filename itself is discarded, not merely hidden.
 */

export interface ExportFile {
  /** Relative to the film's own export root, e.g. `prompts/clip01.md`. */
  path: string
  content: string
}

/** What a LoRA stack becomes once it is safe to write to disk — see the
 * module comment. `null` for "no stack at all", never for "one entry". */
export interface RedactedLoraStack {
  count: number
  entries: { strength: number; on: boolean }[]
}

export function redactLoraStack(stack: LoraStackEntry[] | undefined): RedactedLoraStack | null {
  if (!stack || !stack.length) return null
  return { count: stack.length, entries: stack.map((e) => ({ strength: e.strength, on: e.on })) }
}

/** `clip01`, `clip02`, … `clip12` — never truncated, always at least 2
 * digits. This is the one place clip file numbering is decided; both the
 * plan and the per-clip file share it so they can never drift apart. */
export function clipFileBase(index: number): string {
  return `clip${String(index).padStart(2, '0')}`
}

const SECTION_HEADINGS: Record<string, string> = {
  subject_definitions: 'Subject definitions',
  summary: 'Summary',
  retention_analysis: 'Retention analysis',
  detailed_description: 'Detailed description',
  overall_soundscape: 'Overall soundscape',
  non_diegetic_music: 'Non-diegetic music',
  integrated_multimodal_description: 'Integrated multimodal description',
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Reverse `joinH3Sections` (`schema.ts`): a `Version.text` for a prompt
 * stage is always `field: value` blocks joined with a blank line, in the
 * mode's fixed field order. Returns `null` when the text doesn't actually
 * have that shape — a freeform edit, or a reply that skipped the schema —
 * so the caller can fall back to writing the raw text rather than silently
 * mangling it.
 */
export function splitH3PromptSections(promptText: string, mode: H3Mode): { field: string; heading: string; value: string }[] | null {
  const fields = sectionsFor(mode)
  const pattern = new RegExp(`(^|\\n\\n)(${fields.map(escapeRegExp).join('|')}): `, 'g')
  const hits: { field: string; labelStart: number; valueStart: number }[] = []
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = pattern.exec(promptText))) {
    hits.push({ field: m[2], labelStart: m.index + m[1].length, valueStart: m.index + m[0].length })
  }
  if (hits.length !== fields.length) return null
  const seen = new Set<string>()
  for (const h of hits) {
    if (seen.has(h.field)) return null
    seen.add(h.field)
  }
  return hits.map((h, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].labelStart : promptText.length
    return { field: h.field, heading: SECTION_HEADINGS[h.field] ?? h.field, value: promptText.slice(h.valueStart, end).trim() }
  })
}

function fmtSeconds(n: number): string {
  return `${n.toFixed(1)}s`
}

function squashBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

function loraStackLines(stack: LoraStackEntry[] | undefined): string[] {
  const redacted = redactLoraStack(stack)
  if (!redacted) return ['No film-wide style LoRA stack chosen — clips render on the box’s own default.']
  const parts = redacted.entries.map((e, i) => `#${i + 1} strength ${e.strength.toFixed(2)} (${e.on ? 'on' : 'off'})`)
  return [
    `${redacted.count} style LoRA${redacted.count === 1 ? '' : 's'} configured: ${parts.join(', ')}`,
    '(filenames are box-local paths and are withheld from every exported file — see this module’s own comment)',
  ]
}

export interface BreakdownClipLike {
  index: number
  title: string
  role: ClipRole
  seconds: number
  covers: string
  precedes: string
  follows: string
  loraStack?: LoraStackEntry[]
}

export interface PlanInput {
  filmName: string
  mode: H3Mode
  plot: string
  maxRuntimeSeconds: number
  filmLook: FilmLook | undefined
  filmLoraStack: LoraStackEntry[] | undefined
  shotList: ShotList | null | undefined
  shotGroups: ShotGroup[] | undefined
  breakdown: { spine: string; clips: BreakdownClipLike[] } | null | undefined
  versions: Version[]
  exportedAt: number
}

/** The whole film's plan — plot, beats, shots, clip groups, film look, the
 * film-wide LoRA stack (redacted) — as readable Markdown. One file per
 * film, `plan.md`. */
export function planMarkdown(input: PlanInput): string {
  const lines: string[] = []
  lines.push(`# ${input.filmName || '(untitled film)'}`, '', `Exported ${new Date(input.exportedAt).toISOString()}`, '')

  lines.push('## Plot', '', input.plot.trim() || '_(no plot written yet)_', '')

  lines.push('## Film-wide look', '')
  const look = input.filmLook
  if (look && (look.preset?.trim() || look.freeText?.trim())) {
    if (look.preset?.trim()) {
      const preset = filmLookPreset(look.preset)
      lines.push(preset ? `- ${preset.name} — ${preset.description}` : `- ${look.preset.trim()}`)
    }
    if (look.freeText?.trim()) lines.push(`- ${look.freeText.trim()}`)
  } else {
    lines.push('_No film-wide look chosen._')
  }
  lines.push('')

  lines.push('## Style LoRA stack (film-wide)', '', ...loraStackLines(input.filmLoraStack), '')

  lines.push(`## Beats — runtime ceiling ${fmtSeconds(input.maxRuntimeSeconds)}`, '')
  const beats = input.shotList?.beats ?? []
  if (beats.length) {
    for (const b of beats) lines.push(`${b.index}. (weight ${b.weight}, ~${fmtSeconds(b.seconds)}) ${b.covers}`)
  } else {
    lines.push('_(no beats yet)_')
  }
  lines.push('')

  lines.push('## Shots', '')
  const shots = input.shotList?.shots ?? []
  if (shots.length) {
    for (const s of shots) lines.push(`${s.index}. ${s.beatIndex != null ? `[beat ${s.beatIndex}] ` : ''}${fmtSeconds(s.seconds)} — ${s.covers}`)
  } else {
    lines.push('_(no shots yet)_')
  }
  lines.push('')

  lines.push('## Clip groups', '')
  const groups = input.shotGroups ?? []
  if (groups.length) {
    for (const g of groups) {
      const shotRange = g.shotIndices.length ? `shots ${g.shotIndices[0]}-${g.shotIndices[g.shotIndices.length - 1]}` : 'no shots'
      lines.push(`- ${clipFileBase(g.index)} — ${shotRange} — ${fmtSeconds(g.seconds)}`)
    }
  } else {
    lines.push('_(no clip groups yet)_')
  }
  lines.push('')

  lines.push('## Clips', '')
  const clips = input.breakdown?.clips ?? []
  if (clips.length) {
    for (const c of [...clips].sort((a, b) => a.index - b.index)) {
      const v = latestPromptForClip(input.versions, c.index)
      const status = v ? `prompt approved — see \`prompts/${clipFileBase(c.index)}.md\`` : 'prompt not yet authored'
      lines.push(`### ${clipFileBase(c.index)} — ${c.title || '(untitled)'} — ${c.role} — ${fmtSeconds(c.seconds)}`, '', c.covers, '', `_${status}_`, '')
    }
  } else {
    lines.push('_(no clips approved into the plan yet)_')
  }

  return squashBlankLines(lines.join('\n'))
}

export interface ClipMdInput {
  clip: BreakdownClipLike
  mode: H3Mode
  promptText: string
  explanation?: string
  approvedAt: number
  /** Which pipeline preset (`lib/pipeline.ts`) authored this prompt — the
   * A/B's own provenance. Unset for a prompt written before presets existed. */
  pipelinePreset?: PipelinePresetId
}

/** One clip's approved prompt — the six (or three) H3 sections, as
 * readable Markdown rather than a JSON dump. One file per clip,
 * `prompts/clipNN.md`. */
export function clipMarkdown(input: ClipMdInput): string {
  const { clip, mode, promptText, explanation, approvedAt, pipelinePreset: presetId } = input
  const lines: string[] = []
  lines.push(`# Clip ${String(clip.index).padStart(2, '0')} — ${clip.title || '(untitled)'}`, '')
  lines.push(`Role: ${clip.role} · ${fmtSeconds(clip.seconds)}`, '')
  // Unset (a prompt written before presets existed) says nothing rather than
  // guessing which preset produced it — see `Version.pipelinePreset`'s
  // module comment for why provenance is never backfilled.
  if (presetId) lines.push(`Pipeline preset: ${pipelinePreset(presetId).name}`, '')
  if (clip.covers.trim()) lines.push(clip.covers.trim(), '')

  const sections = splitH3PromptSections(promptText, mode)
  if (sections) {
    for (const s of sections) lines.push(`## ${s.heading}`, '', s.value || '_(empty)_', '')
  } else {
    lines.push('## Prompt', '', '_(sections could not be parsed — raw prompt below)_', '', promptText.trim(), '')
  }

  if (explanation?.trim()) lines.push('## Notes', '', explanation.trim(), '')

  lines.push('---', `Approved ${new Date(approvedAt).toISOString()}`, '')
  return squashBlankLines(lines.join('\n'))
}

export interface ExportedBreakdownClip {
  index: number
  title: string
  role: ClipRole
  seconds: number
  covers: string
  precedes: string
  follows: string
  loraStack: RedactedLoraStack | null
  prompt: string | null
  explanation: string | null
  /** See `ClipMdInput.pipelinePreset` — carried into `project.json` so the
   * A/B is attributable from the machine-readable export too, not only the
   * human-readable `plan.md`/`clipNN.md`. */
  pipelinePreset: PipelinePresetId | null
}

export interface ExportedProjectV1 {
  formatVersion: 1
  exportedAt: number
  filmName: string
  mode: H3Mode
  plot: string
  maxRuntimeSeconds: number
  filmLook: FilmLook | null
  filmLoraStack: RedactedLoraStack | null
  shotList: ShotList | null
  shotGroups: ShotGroup[]
  shotGroupIssues: string[]
  breakdown: { spine: string; clips: ExportedBreakdownClip[] } | null
}

export interface BuildProjectInput {
  filmName: string
  mode: H3Mode
  plot: string
  maxRuntimeSeconds: number
  filmLook: FilmLook | undefined
  filmLoraStack: LoraStackEntry[] | undefined
  shotList: ShotList | null | undefined
  shotGroups: ShotGroup[] | undefined
  shotGroupIssues: string[] | undefined
  breakdown: { spine: string; clips: BreakdownClipLike[] } | null | undefined
  versions: Version[]
  exportedAt: number
}

/** The whole plan, machine-readable — for re-import later (not built yet;
 * this is the write side only). See the module comment for why a LoRA
 * stack survives only as a redacted count/strength/on-off list. */
export function buildProjectJson(input: BuildProjectInput): ExportedProjectV1 {
  return {
    formatVersion: 1,
    exportedAt: input.exportedAt,
    filmName: input.filmName,
    mode: input.mode,
    plot: input.plot,
    maxRuntimeSeconds: input.maxRuntimeSeconds,
    filmLook: input.filmLook ?? null,
    filmLoraStack: redactLoraStack(input.filmLoraStack),
    shotList: input.shotList ?? null,
    shotGroups: input.shotGroups ?? [],
    shotGroupIssues: input.shotGroupIssues ?? [],
    breakdown: input.breakdown
      ? {
          spine: input.breakdown.spine,
          clips: [...input.breakdown.clips]
            .sort((a, b) => a.index - b.index)
            .map((c) => {
              const v = latestPromptForClip(input.versions, c.index)
              return {
                index: c.index,
                title: c.title,
                role: c.role,
                seconds: c.seconds,
                covers: c.covers,
                precedes: c.precedes,
                follows: c.follows,
                loraStack: redactLoraStack(c.loraStack),
                prompt: v?.text ?? null,
                explanation: v?.explanation ?? null,
                pipelinePreset: v?.pipelinePreset ?? null,
              }
            }),
        }
      : null,
  }
}

/** Parse a `project.json` written by `buildProjectJson`. Returns `null` for
 * anything that isn't recognisably one of ours, rather than throwing — a
 * caller offering re-import should say "not a project file", not crash. */
export function parseProjectJson(raw: string): ExportedProjectV1 | null {
  try {
    const obj: unknown = JSON.parse(raw)
    if (obj && typeof obj === 'object' && (obj as { formatVersion?: unknown }).formatVersion === 1) return obj as ExportedProjectV1
    return null
  } catch {
    return null
  }
}

export interface BuildExportPlanInput extends BuildProjectInput {
  /** Restrict which clips get their own `prompts/clipNN.md` — default is
   * every breakdown clip that already has an authored prompt. */
  approvedClipIndices?: number[]
}

/**
 * The write PLAN, as data: given a session's export-relevant fields and
 * (optionally) which clips count as approved, exactly which paths get
 * written and with what content — never any effectful I/O. `fsExport.ts`'s
 * `writeFilesToDirectory` is a thin loop over this list, and the
 * single-file fallback (`buildFallbackBundle`) is built FROM it, so there
 * is exactly one place that decides content.
 */
export function buildExportPlan(input: BuildExportPlanInput): ExportFile[] {
  const files: ExportFile[] = []
  files.push({ path: 'plan.md', content: planMarkdown(input) })
  files.push({ path: 'project.json', content: JSON.stringify(buildProjectJson(input), null, 2) })

  const clips = input.breakdown?.clips ?? []
  const wanted = input.approvedClipIndices ? new Set(input.approvedClipIndices) : null
  for (const c of [...clips].sort((a, b) => a.index - b.index)) {
    if (wanted && !wanted.has(c.index)) continue
    const v = latestPromptForClip(input.versions, c.index)
    if (!v) continue
    files.push({
      path: `prompts/${clipFileBase(c.index)}.md`,
      content: clipMarkdown({ clip: c, mode: input.mode, promptText: v.text, explanation: v.explanation, approvedAt: v.at, pipelinePreset: v.pipelinePreset }),
    })
  }
  return files
}

/**
 * The no-`showDirectoryPicker` fallback (Safari, Firefox): ONE Markdown
 * download (the plan plus every approved clip's prompt, under clear
 * headings) plus the `project.json` — two downloads, never twenty. Built
 * FROM `buildExportPlan`'s own output so the fallback can never show
 * different content than the folder-write path would have written.
 */
export function buildFallbackBundle(
  files: ExportFile[],
  filmName: string,
): { markdownFilename: string; markdown: string; jsonFilename: string; json: string } {
  const slug = slugifyFilmName(filmName)
  const plan = files.find((f) => f.path === 'plan.md')
  const project = files.find((f) => f.path === 'project.json')
  const prompts = files.filter((f) => f.path.startsWith('prompts/')).sort((a, b) => a.path.localeCompare(b.path))
  const markdown = [plan?.content.trim() ?? '', ...prompts.map((p) => `\n\n---\n\n${p.content.trim()}`)].join('')
  return {
    markdownFilename: `${slug}-plan.md`,
    markdown: `${markdown.trim()}\n`,
    jsonFilename: `${slug}-project.json`,
    json: project?.content ?? '{}',
  }
}

/** The film's own export root folder name — reuses `slugifyFilmName`
 * (`extender.ts`) rather than a second sanitiser, so "Act 2 / the door"
 * cannot create a nested folder here any more than it can in a
 * `filename_prefix`. */
export function exportRootName(filmName: string): string {
  return slugifyFilmName(filmName)
}
