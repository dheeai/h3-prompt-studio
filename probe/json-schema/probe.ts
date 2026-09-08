/**
 * Does schema-constrained decoding produce a better H3 prompt than free text?
 *
 * A throwaway A/B against one endpoint. It is deliberately built out of the
 * app's OWN modules — the real system prompt, the real draft template, the
 * real linter — because a probe that sends a paraphrased prompt and scores it
 * with hand-rolled checks measures the probe, not the change.
 *
 * Run:  node_modules/.bin/tsx probe/json-schema/probe.ts
 * See:  probe/json-schema/README.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildContext, buildStudioSystemPrompt, selectionForStage } from '../../src/lib/context'
import { DEFAULT_TEMPLATES, fillTemplate } from '../../src/lib/stages'
import { classifyInput, standingToText, lint, summarise } from '../../src/lib/lint'
import { withQwenReasoningBudget } from '../../src/lib/thinking'
import { estTokens } from '../../src/lib/tokens'
import type { Provider, Skill, Selection, H3Mode, Finding } from '../../src/lib/types'
import { REF_SIX, REF_SHOTS, BASE_THREE, REF_ORDER, BASE_ORDER, REF_DECOMPOSED } from './schemas'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
let OUT = join(HERE, 'out')

// ── endpoint ──────────────────────────────────────────────────────────────
// Read from the gitignored .env.local rather than hardcoding anything: this
// repo is public with a live Pages deploy, so no host belongs in source.
function envLocal(): Record<string, string> {
  const path = join(REPO, '.env.local')
  if (!existsSync(path)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}
const local = envLocal()
const BASE_URL = process.env.LLM_URL || local.VITE_LOCAL_LLM_URL
const MODEL = process.env.LLM_MODEL || local.VITE_LOCAL_LLM_MODEL
const API_KEY = process.env.LLM_KEY || undefined

if (!BASE_URL || !MODEL) {
  console.error(
    'No endpoint. Set LLM_URL and LLM_MODEL, or put VITE_LOCAL_LLM_URL / VITE_LOCAL_LLM_MODEL in .env.local.',
  )
  process.exit(1)
}

const MODEL_OVERRIDE = (() => {
  const i = process.argv.indexOf('--model')
  return i >= 0 ? process.argv[i + 1] : undefined
})()
const USE_MODEL = MODEL_OVERRIDE || MODEL

const provider: Provider = {
  id: 'probe',
  label: 'probe',
  baseUrl: BASE_URL,
  kind: 'openai',
  builtIn: false,
  sendCachePrompt: !API_KEY, // llama.cpp understands it; hosted providers reject it
  apiKey: API_KEY,
}

// ── cli ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name: string, dflt: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const MODES = flag('modes', 'text,json_object,json_schema,json_schema_shots').split(',')
const REPEATS = Number(flag('repeats', '1'))
const H3MODE = flag('h3mode', 'Ref2VA') as H3Mode
const ONLY_BRIEF = flag('brief', '')
const MAX_TOKENS = Number(flag('max-tokens', '6000'))
const BRIEFS_FILE = flag('briefs', '')
/** Same seed across modes, so a difference is the constraint and not the dice. */
const SEED = Number(flag('seed', '20260908'))
/** Reasoning ceiling for this run. `withQwenReasoningBudget` clamps to 8192. */
const REASONING = Number(flag('reasoning', '8192'))
/** Keep a prior run's artifacts by writing this one somewhere else. */
const OUT_DIR = flag('out-dir', '')
const TEMPERATURE = Number(flag('temp', '0.7'))
/** Build and dump every request body without sending one. */
const DRY = argv.includes('--dry')
/**
 * Every request streams. This is deliberately NOT configurable.
 *
 * A non-streaming request sends NOTHING until generation completes, so a long
 * call looks like an idle connection to anything in the path. Measured
 * 2026-09-08: `huihui-thinkingcap-27b` lost briefs 01 and 02 to
 * `TypeError: fetch failed` that way, and — because a reset request keeps
 * generating server-side while still holding its slot, and that preset
 * declares no `parallel` line so it has only ONE — every later request queued
 * behind the zombies forever. Streaming keeps bytes flowing, so the idle timer
 * never fires. There is no flag to turn this off: a run that silently used
 * the fragile transport would produce failures indistinguishable from model
 * defects, which is exactly what happened.
 */
/** Attempts allowed for the warm-up request, which absorbs the cold load. */
const WARMUP_TRIES = Number(flag('warmup-tries', '4'))

if (OUT_DIR) OUT = OUT_DIR.startsWith('/') ? OUT_DIR : join(HERE, OUT_DIR)

// ── the two hard briefs ───────────────────────────────────────────────────
// One with dialogue, one deliberately silent. These are the two failure modes
// the h3-prompting skill calls out by name: a spoken line with no <d> tag
// garbles the audio, and a silent scene picks up invented speech from any
// speech verb in the prose — including one inside a denial.
type Brief = { id: string; text: string; why?: string; mode?: H3Mode }

const BRIEFS_BUILTIN: Brief[] = [
  {
    id: 'dialogue',
    text: `A woman in her late thirties waits in a hospital corridor at night. A younger nurse comes out of a room and tells her the surgery went well. The woman does not react the way the nurse expects. About 10 seconds.`,
  },
  {
    id: 'silent',
    text: `A man alone in a workshop before dawn finishes repairing a wooden chair, sets the chisel down, and looks at it. Nobody speaks. About 10 seconds.`,
  },
]

const BRIEFS: Brief[] = BRIEFS_FILE
  ? (JSON.parse(readFileSync(BRIEFS_FILE, 'utf8')) as Brief[])
  : BRIEFS_BUILTIN

// ── skills, loaded off disk the way the app loads them over http ───────────
function loadSkills(): Skill[] {
  const index = JSON.parse(readFileSync(join(REPO, 'public/skills/index.json'), 'utf8')) as {
    skills: { dir: string; files: string[] }[]
  }
  return index.skills.map((s) => {
    const files = s.files.map((rel) => {
      const text = readFileSync(join(REPO, 'public/skills', s.dir, rel), 'utf8')
      return { rel, text, tokens: estTokens(text) }
    })
    return {
      id: s.dir,
      name: s.dir,
      description: '',
      source: 'bundled' as Skill['source'],
      addedAt: 0,
      files,
    }
  })
}

// ── request bodies ────────────────────────────────────────────────────────
type ModeName = string

function responseFormatFor(mode: ModeName): Record<string, unknown> | null {
  if (mode === 'text') return null
  if (mode === 'json_object') return { response_format: { type: 'json_object' } }
  const schema =
    mode === 'json_decomposed' ? REF_DECOMPOSED
    : mode === 'json_schema_shots' ? REF_SHOTS
    : H3MODE === 'Ref2VA' ? REF_SIX : BASE_THREE
  return {
    response_format: {
      type: 'json_schema',
      // llama.cpp reads json_schema.schema; OpenRouter also wants name+strict.
      json_schema: { name: 'h3_prompt', strict: true, schema },
    },
    // OpenRouter silently routes to a provider that DROPS response_format
    // unless told not to. Only it understands the field, so only it gets it.
    ...(/openrouter\.ai/.test(BASE_URL!) ? { provider: { require_parameters: true } } : {}),
  }
}

/** What the model is told about shape, when the grammar is not doing it. */
function shapeInstruction(mode: ModeName): string {
  if (mode === 'text') return ''
  if (mode === 'json_decomposed') {
    return `\n\nOUTPUT FORMAT OVERRIDE: return a single JSON object matching the provided schema and nothing else — no prose around it, no markdown fence.

The canonical six-section H3 prompt is ASSEMBLED from your JSON; you do not write it. Consequences you must work with:

- Do NOT write the bracketed task-type prefix, the "[Shot N]" markers, the timestamps for the first shot, "<d>" tags, "(Sx)" ids, or the "N/A" music sentinel. All of these are generated from your structured fields.
- A character speaks ONLY by adding an entry to that shot's \`dialogue\` array. Never write a speech verb in \`action\` — the speech sentence is generated from the dialogue entry, so describing it as well produces it twice.
- \`sound\` is the synchronised sound of that one shot. \`overall_soundscape\` is ambience under the whole video. Neither may contain anything that conveys words.
- Do NOT write prohibitions anywhere ("No subtitles", "no music", "she does not speak"). Naming a thing instructs the model to produce it. Simply do not mention what you do not want; for a silent character state that the lips stay closed.
- Write \`action\` at 40-80 words per shot so the assembled body carries real detail.`
  }
  const fields = mode === 'json_schema_shots' ? REF_SHOTS.required : H3MODE === 'Ref2VA' ? REF_ORDER : BASE_ORDER
  return `\n\nOUTPUT FORMAT OVERRIDE: return a single JSON object and nothing else — no prose around it, no markdown fence. Keys, exactly these and in this order: ${fields.join(', ')}. Each value is the section's content as a plain string${
    mode === 'json_schema_shots' ? ', except `shots`, which is an array of {at, prose} objects' : ''
  }. Do not put the section label inside its own value.`
}

// ── assembling JSON back into a canonical prompt ──────────────────────────
/** Render the decomposed object into the canonical six-section prompt. */
function assembleDecomposed(o: any): string {
  const defs = (o.subject_definitions || []).map((d: any) => `${d.label} ${String(d.definition || '').trim()}`)
  const tasks = (o.task_types || []).join(' + ')
  const retention = (o.retention_analysis || []).map(
    (r: any) => `${r.label} (${String(r.shots || '').trim()}): ${r.marker} - ${String(r.note || '').trim()}`)

  // The cast table: one id -> one label + one fixed vocal identity. The identity
  // is emitted exactly ONCE, immediately before that speaker's first line,
  // which is what the acting skill requires and what a model asked to restate
  // it per line reliably gets wrong.
  const cast = new Map<string, { label: string; voice: string }>()
  for (const sp of o.speakers || []) {
    if (sp?.id) cast.set(sp.id, { label: String(sp.subject_label || '').trim(), voice: String(sp.vocal_identity || '').trim() })
  }
  const voiced = new Set<string>()

  const shots: string[] = []
  ;(o.shots || []).forEach((sh: any, i: number) => {
    const cam = [sh.camera, sh.camera_modifier].filter((x: string) => x && x.trim()).join(' ')
    const placed = (sh.subjects_in_frame || []).join('; ')
    const lines = (sh.dialogue || []).map((d: any) => {
      const who = cast.get(d.speaker_id)
      const label = who?.label || ''
      // vocal identity once per speaker, before their first line
      const ident = who?.voice && !voiced.has(d.speaker_id) ? ` — ${who.voice} — ` : ' '
      if (who?.voice) voiced.add(d.speaker_id)
      const vo = d.delivery === 'off-screen voiceover'
      const verb = vo ? 'says in an off-screen voiceover' : 'says'
      const tail = vo ? ' Their lips stay closed on camera.' : ''
      return `${label} (${d.speaker_id})${ident}${verb}: <d>[${d.language}] ${String(d.words || '').trim()}</d>${tail}`
    })
    // [Shot 1] never carries a timestamp: the model's `at` is ignored here.
    const head = i === 0 ? '[Shot 1]' : `[Shot ${i + 1}] At ${String(sh.at || '').trim()},`
    // opening_state carries the bridge in; closing_state hands it to the next shot.
    shots.push([head, String(sh.composition || '').trim(), placed,
                i === 0 ? '' : String(sh.opening_state || '').trim(),
                String(sh.action || '').trim(),
                `The camera holds a ${cam}.`, String(sh.sound || '').trim(), ...lines,
                String(sh.closing_state || '').trim()]
      .filter(Boolean).join(' '))
  })

  const crowdSources = o.crowd?.present && o.crowd?.rendering === 'non_vocal_texture'
    ? (o.crowd.sources || []) : []
  const sound = [...(o.overall_soundscape || []).map((e: any) => String(e.source || '').trim()), ...crowdSources]
    .filter(Boolean).join('. ')
  const music = o.non_diegetic_music?.present
    ? String(o.non_diegetic_music.description || '').trim() || 'N/A'
    : 'N/A'   // the sentinel, structurally — never a sentence describing absence

  return [
    `subject_definitions: ${defs.join('\n')}`,
    `summary: [${tasks}] ${String(o.summary || '').trim()}`,
    `retention_analysis: ${retention.join('\n')}`,
    `detailed_description: ${String(o.style || '').trim()}\n\n${shots.join('\n\n')}`,
    `overall_soundscape: ${sound}`,
    `non_diegetic_music: ${music}`,
  ].join('\n\n')
}

function assemble(mode: ModeName, obj: Record<string, unknown>): string {
  if (mode === 'json_decomposed') return assembleDecomposed(obj)
  if (mode === 'json_schema_shots') {
    const shots = Array.isArray(obj.shots) ? (obj.shots as { at?: string; prose?: string }[]) : []
    const body = [
      String(obj.style || '').trim(),
      ...shots.map((s, i) =>
        i === 0
          ? `[Shot 1] ${String(s.prose || '').trim()}`
          : `[Shot ${i + 1}] At ${String(s.at || '').trim()}, ${String(s.prose || '').trim()}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n')
    return [
      `subject_definitions: ${obj.subject_definitions ?? ''}`,
      `summary: ${obj.summary ?? ''}`,
      `retention_analysis: ${obj.retention_analysis ?? ''}`,
      `detailed_description: ${body}`,
      `overall_soundscape: ${obj.overall_soundscape ?? ''}`,
      `non_diegetic_music: ${obj.non_diegetic_music ?? ''}`,
    ].join('\n\n')
  }
  const order = H3MODE === 'Ref2VA' ? REF_ORDER : BASE_ORDER
  return order.map((k) => `${k}: ${String(obj[k as string] ?? '').trim()}`).join('\n\n')
}

/** Strip a fence, then take the first { to the last } — same tolerance as parseBreakdown. */
function parseLoose(raw: string): Record<string, unknown> | null {
  const s = raw.replace(/```(?:json)?/gi, '')
  const a = s.indexOf('{')
  const b = s.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(s.slice(a, b + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

// ── one call ──────────────────────────────────────────────────────────────
interface Run {
  mode: ModeName
  brief: string
  n: number
  ms: number
  httpError?: string
  finishReason: string | null
  promptTokens?: number
  completionTokens?: number
  reasoningTokens?: number
  /** Did the model think at all? The question a grammar might silently answer "no". */
  thought: boolean
  parsed: boolean
  fieldsPresent: number
  fieldsExpected: number
  bodyWords: number
  findings: Finding[]
  raw: string
  assembled: string
}

function buildPayload(mode: ModeName, brief: Brief, system: string) {
  const standing = standingToText(classifyInput(brief.text))
  const user =
    fillTemplate(DEFAULT_TEMPLATES.draft, { story: brief.text, standing, mode: H3MODE }) + shapeInstruction(mode)

  const body: Record<string, unknown> = {
    model: USE_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: TEMPERATURE,
    seed: SEED,
    stream: true,
    // usage arrives in the final chunk rather than a whole-body reply
    stream_options: { include_usage: true },
    ...(MAX_TOKENS > 0 ? { max_tokens: MAX_TOKENS } : {}),
    ...(provider.sendCachePrompt ? { cache_prompt: true } : {}),
    ...(responseFormatFor(mode) || {}),
  }
  return withQwenReasoningBudget(provider, USE_MODEL!, body, REASONING)
}

interface Wire {
  content: string
  reasoning: string
  finishReason: string | null
  usage: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null
}

/** Collect an OpenAI-compatible SSE stream into one reply. */
async function readStream(res: Response): Promise<Wire> {
  const out: Wire = { content: '', reasoning: '', finishReason: null, usage: null }
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    // SSE frames are separated by a blank line; keep any partial tail.
    let nl: number
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      let j: any
      try {
        j = JSON.parse(payload)
      } catch {
        continue // a half-frame split across reads; the next loop picks it up
      }
      // An error frame can arrive AFTER headers — the gateway emits one on an
      // upstream stream failure, which would otherwise look like a clean end.
      if (j.error) throw new Error(`upstream error frame: ${JSON.stringify(j.error).slice(0, 300)}`)
      const ch = j.choices?.[0]
      if (ch?.delta?.content) out.content += ch.delta.content
      const r = ch?.delta?.reasoning_content ?? ch?.delta?.reasoning
      if (r) out.reasoning += r
      if (ch?.finish_reason) out.finishReason = ch.finish_reason
      if (j.usage) out.usage = j.usage
    }
  }
  return out
}

/**
 * Absorb the cold model load OUTSIDE the measured requests.
 *
 * The load is the risky part: the request that triggers it waits through the
 * whole thing with no bytes moving, and if that socket is reset the request
 * keeps generating and holds a slot. So spend it here, on a tiny call whose
 * zombie (if it happens) finishes immediately, and retry until one lands.
 */
async function warmup(model: string): Promise<boolean> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    // Tiny on purpose: a reset warm-up must not sit in a slot generating.
    max_tokens: 24,
    stream: true,
    // usage arrives in the final chunk rather than a whole-body reply
    stream_options: { include_usage: true },
    reasoning_budget_tokens: 32,
    reasoning_budget_message: 'Time to stop thinking. Give the final answer.',
  }
  for (let attempt = 1; attempt <= WARMUP_TRIES; attempt++) {
    const started = Date.now()
    try {
      const res = await fetch(`${BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', headers, body: JSON.stringify(body),
      })
      if (!res.ok) {
        console.log(`  warm-up ${attempt}/${WARMUP_TRIES}: HTTP ${res.status} after ${((Date.now() - started) / 1000).toFixed(0)}s`)
        continue
      }
      const w = await readStream(res)
      console.log(`  warm-up ${attempt}/${WARMUP_TRIES}: model hot after ${((Date.now() - started) / 1000).toFixed(0)}s (${JSON.stringify(w.content.trim().slice(0, 20))})`)
      return true
    } catch (e) {
      // Expected on the attempt that eats the load: the socket dies while the
      // server is still bringing weights up. The next attempt usually lands.
      console.log(`  warm-up ${attempt}/${WARMUP_TRIES}: ${String(e).slice(0, 80)} after ${((Date.now() - started) / 1000).toFixed(0)}s`)
    }
  }
  return false
}

async function once(mode: ModeName, brief: Brief, n: number, system: string): Promise<Run> {
  const payload = buildPayload(mode, brief, system)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`

  const started = Date.now()
  const res = await fetch(`${BASE_URL!.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  // NOT the elapsed time: with stream: true, fetch resolves as soon as the
  // HEADERS arrive, so this is only time-to-first-byte and is used for the
  // error path alone. The real duration is measured after the body is drained.
  const headerMs = Date.now() - started

  const base = { mode, brief: brief.id, n, thought: false, parsed: false, fieldsPresent: 0, findings: [] as Finding[] }

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 600)
    return {
      ...base,
      ms: headerMs,
      httpError: `HTTP ${res.status} ${res.statusText} — ${detail}`,
      finishReason: null,
      fieldsExpected: 0,
      bodyWords: 0,
      raw: detail,
      assembled: '',
    }
  }

  const wire = await readStream(res)
  // Now the body is fully drained, so this is the real wall-clock duration.
  const ms = Date.now() - started
  const json = { usage: wire.usage } as any
  const choice = { finish_reason: wire.finishReason } as any
  const content: string = wire.content
  const reasoning: string = wire.reasoning
  const inlineThink = /<think>/.test(content)

  const order = mode === 'json_decomposed' ? REF_DECOMPOSED.required
    : mode === 'json_schema_shots' ? REF_SHOTS.required
    : H3MODE === 'Ref2VA' ? REF_ORDER : BASE_ORDER
  let assembled = content
  let parsed = false
  let present = 0

  if (mode !== 'text') {
    const obj = parseLoose(content)
    if (obj) {
      parsed = true
      present = order.filter((k) => {
        const v = obj[k as string]
        return Array.isArray(v) ? v.length > 0 : typeof v === 'string' && v.trim().length > 0
      }).length
      assembled = assemble(mode, obj)
    }
  } else {
    const fields = H3MODE === 'Ref2VA' ? REF_ORDER : BASE_ORDER
    present = fields.filter((k) => new RegExp(`(^|\\n)\\s*${k}\\s*:`, 'i').test(content)).length
  }

  const bodyKey = H3MODE === 'Ref2VA' ? 'detailed_description' : 'integrated_multimodal_description'
  const bodyMatch = new RegExp(`${bodyKey}\\s*:([\\s\\S]*?)(?=\\n\\s*(?:overall_soundscape|non_diegetic_music)\\s*:|$)`, 'i').exec(
    assembled,
  )
  const bodyWords = bodyMatch ? bodyMatch[1].trim().split(/\s+/).filter(Boolean).length : 0

  return {
    ...base,
    ms,
    finishReason: choice.finish_reason ?? null,
    promptTokens: json.usage?.prompt_tokens,
    completionTokens: json.usage?.completion_tokens,
    reasoningTokens: json.usage?.completion_tokens_details?.reasoning_tokens,
    thought: !!reasoning.trim() || inlineThink,
    parsed: mode === 'text' ? true : parsed,
    fieldsPresent: present,
    fieldsExpected: order.length,
    bodyWords,
    findings: lint(assembled, H3MODE),
    raw: reasoning ? `<<<REASONING>>>\n${reasoning}\n<<<CONTENT>>>\n${content}` : content,
    assembled,
  }
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT, { recursive: true })
  const skills = loadSkills()
  // Everything selected, then narrowed the way the app narrows it for `draft`.
  const all: Selection = Object.fromEntries(skills.map((s) => [s.id, s.files.map((f) => f.rel)]))
  const selection = selectionForStage(skills, all, 'draft')
  const context = await buildContext(skills, selection)
  const system = buildStudioSystemPrompt(context, 'story')

  console.log(`endpoint  ${BASE_URL!.replace(/\/\/[^/]+/, '//<host>')}`)
  console.log(`model     ${USE_MODEL}`)
  console.log(`h3 mode   ${H3MODE}`)
  console.log(`reasoning ${REASONING} tok ceiling`)
  console.log(`out       ${OUT}`)
  console.log(`system    ~${estTokens(system)} tok  (${context.parts.length} skill files)`)
  console.log(`matrix    ${MODES.join(', ')} x ${BRIEFS.length} briefs x ${REPEATS}\n`)

  const runs: Run[] = []
  const briefs = ONLY_BRIEF ? BRIEFS.filter((b) => b.id === ONLY_BRIEF) : BRIEFS

  if (DRY) {
    // Everything except the network: proves the bodies, the schemas and the
    // reasoning-budget decoration are what we think they are.
    for (const mode of MODES) {
      const payload = buildPayload(mode, briefs[0], system) as Record<string, unknown>
      const stem = join(OUT, `DRY-${mode}.request.json`)
      writeFileSync(stem, JSON.stringify(payload, null, 2))
      const msgs = payload.messages as { role: string; content: string }[]
      console.log(
        `${mode.padEnd(20)} system ~${estTokens(msgs[0].content)}tok  user ~${estTokens(msgs[1].content)}tok  ` +
          `response_format ${payload.response_format ? (payload.response_format as any).type : 'none'}  ` +
          `reasoning_budget ${payload.reasoning_budget_tokens ?? '—'}`,
      )
    }
    console.log(`\nrequest bodies written to ${OUT}/DRY-*.request.json — nothing was sent`)
    return
  }

  // Spend the cold load here, not inside a measured request.
  if (!(await warmup(USE_MODEL!))) {
    console.error(`\nwarm-up failed after ${WARMUP_TRIES} attempts — the model never came up. Aborting rather than`)
    console.error('reporting load failures as model defects. Check the gateway and that no request is wedged in a slot.')
    process.exit(1)
  }
  console.log('')

  for (const brief of briefs) {
    for (const mode of MODES) {
      for (let n = 1; n <= REPEATS; n++) {
        process.stdout.write(`… ${mode} / ${brief.id} / ${n} `)
        let r: Run
        try {
          r = await once(mode, brief, n, system)
        } catch (e) {
          console.log(`EXCEPTION ${e}`)
          continue
        }
        runs.push(r)
        const stem = join(OUT, `${mode}-${brief.id}-${n}`)
        writeFileSync(`${stem}.raw.txt`, r.raw)
        if (r.assembled) writeFileSync(`${stem}.prompt.txt`, r.assembled)
        const s = summarise(r.findings)
        console.log(
          r.httpError
            ? `FAILED ${r.httpError.slice(0, 120)}`
            : `${(r.ms / 1000).toFixed(1)}s  ${r.completionTokens ?? '?'}tok  fields ${r.fieldsPresent}/${r.fieldsExpected}  body ${r.bodyWords}w  lint ${s.error}E/${s.warn}W  ${r.thought ? 'thought' : 'NO-THINK'}${r.parsed ? '' : '  UNPARSEABLE'}${r.finishReason === 'length' ? '  CUT-OFF' : ''}`,
        )
      }
    }
  }

  // summary table
  console.log('\n' + '─'.repeat(104))
  console.log(
    ['mode', 'brief', 'sec', 'compl', 'reason', 'fields', 'body', 'errs', 'warns', 'think', 'json']
      .map((h, i) => h.padEnd([20, 10, 6, 7, 7, 8, 6, 6, 6, 7, 5][i]))
      .join(''),
  )
  console.log('─'.repeat(104))
  for (const r of runs) {
    const s = summarise(r.findings)
    console.log(
      [
        r.mode.padEnd(20),
        r.brief.padEnd(10),
        (r.httpError ? '—' : (r.ms / 1000).toFixed(1)).padEnd(6),
        String(r.completionTokens ?? '—').padEnd(7),
        String(r.reasoningTokens ?? '—').padEnd(7),
        `${r.fieldsPresent}/${r.fieldsExpected}`.padEnd(8),
        String(r.bodyWords).padEnd(6),
        String(s.error).padEnd(6),
        String(s.warn).padEnd(6),
        (r.thought ? 'yes' : 'NO').padEnd(7),
        r.parsed ? 'ok' : 'FAIL',
      ].join(''),
    )
  }
  console.log('─'.repeat(104))

  writeFileSync(
    join(OUT, 'runs.json'),
    JSON.stringify(
      runs.map(({ raw, assembled, ...rest }) => ({ ...rest, findings: rest.findings.map((f) => f.id) })),
      null,
      2,
    ),
  )

  const failures = runs.filter((r) => r.httpError)
  if (failures.length) {
    console.log('\nENDPOINT REFUSALS (this is the answer to "does it support the field"):')
    for (const f of failures) console.log(`  ${f.mode}/${f.brief}: ${f.httpError}`)
  }

  console.log(`\nprompts written to ${OUT}`)
  console.log('Read the .prompt.txt files — the lint columns say whether it is WELL FORMED,')
  console.log('not whether it is any GOOD. That judgement is yours.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
