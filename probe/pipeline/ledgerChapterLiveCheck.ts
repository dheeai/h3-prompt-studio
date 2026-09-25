/**
 * probe/pipeline/ledgerChapterLiveCheck.ts — the ONE live check for the
 * "paste a chapter -> arbitrary-length video, with plates generated" task:
 * a 2-clip chapter (auto runtime mode), the ledger-aware breakdown call,
 * one generated character plate + one generated location plate (Qwen Image
 * 2.1, via the official rewrite system prompt), then ONE Studio-authored
 * (preset D) render with the REFERENCES block wired in and the citation
 * audit run against the result.
 *
 * Local models only — swift-uncensored-27b for every LLM call (breakdown,
 * plate-prompt authoring, plate analysis, the six-section write), the local
 * ComfyUI box for both the Qwen Image 2.1 plates and the H3 render.
 *
 * ```sh
 * LLM_URL=<box>/llama/v1 LLM_MODEL=swift-uncensored-27b COMFY_URL=<box>/comfyui \
 *   npx tsx probe/pipeline/ledgerChapterLiveCheck.ts
 * ```
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAPTER_BREAKDOWN_TEMPLATE, auditClipPromptCitations, chapterBreakdownResponseFormat,
  checkChapterBreakdown, fillChapterBreakdownTemplate, parseChapterBreakdown,
} from '../../src/lib/chapterBreakdown'
import { referenceContextForClip } from '../../src/lib/referenceContext'
import { fillPlateBrief, parsePlatePromptRewrite, platePromptKindForLedgerKind, PLATE_SIZES } from '../../src/lib/platePrompting'
import { describeEntityForPlate } from '../../src/lib/plateMatching'
import { QWEN_REWRITE_SYSTEM_PROMPT_T2I } from '../../src/lib/qwenRewriteSystemPromptT2i'
import { buildQwenPlateGraph } from '../../src/lib/qwenPlateGraph'
import { DEFAULT_TEMPLATES, durationBlock, filmBlock, fillTemplateWithDuration } from '../../src/lib/stages'
import { h3ResponseFormat, joinH3Sections } from '../../src/lib/schema'
import { DEFAULT_REWRITE_SYSTEM_PROMPT } from '../../src/lib/rewriteSystemPrompt'
import { framesForSeconds } from '../../src/lib/geometry'
import { withQwenReasoningBudget, QWEN_REASONING_BUDGET_DEFAULT } from '../../src/lib/thinking'
import { buildExtenderGraph } from '../../src/lib/extender'
import { EXTENDER_STUDIO_AUTHORING_OVERRIDES } from '../../src/lib/extenderSettings'
import { submit, pollExtender, viewUrl } from '../../src/lib/comfy'
import { poll } from '../../src/lib/comfy'
import type { ComfyEndpoint, ComfyNode, FilmContext } from '../../src/lib/types'

const LLM_URL = process.env.LLM_URL!
const LLM_MODEL = process.env.LLM_MODEL!
const COMFY_URL = process.env.COMFY_URL!

const CHAPTER = `Nusrat runs a small tailoring shop in a Surat cloth market. A supplier, Farid, delivers a bolt of raw silk she has already paid for. She unrolls it on the counter and knows at once, under her thumb, that the weave is wrong — not the cloth she chose. Farid stands in the doorway and insists it is the same bolt.`

const outDir = join(import.meta.dirname, 'out')
mkdirSync(outDir, { recursive: true })

async function llmCall(system: string | undefined, user: string, format?: Record<string, unknown>): Promise<{ text: string; ms: number; usage: any }> {
  const messages = system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }]
  const body = withQwenReasoningBudget(
    { id: 'localbox', label: 'box', baseUrl: LLM_URL } as any,
    LLM_MODEL,
    { model: LLM_MODEL, temperature: 0.35, messages, response_format: format, max_tokens: 12000 },
    QWEN_REASONING_BUDGET_DEFAULT,
  )
  const t0 = Date.now()
  const r = await fetch(`${LLM_URL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const ms = Date.now() - t0
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 500)}`)
  const j: any = await r.json()
  return { text: j.choices?.[0]?.message?.content ?? '', ms, usage: j.usage }
}

async function main() {
  if (!LLM_URL || !LLM_MODEL || !COMFY_URL) {
    console.error('set LLM_URL, LLM_MODEL, COMFY_URL first')
    process.exit(1)
  }
  const ep: ComfyEndpoint = { id: 'probe', label: 'probe', baseUrl: COMFY_URL.replace(/\/$/, ''), builtIn: false }

  // ── 1. Ledger-aware breakdown, auto mode ──────────────────────────────
  console.log('=== 1. chapter breakdown (auto mode, ledger) ===')
  const user = fillChapterBreakdownTemplate(CHAPTER_BREAKDOWN_TEMPLATE, CHAPTER, 'auto')
  const t0 = Date.now()
  const breakdownReply = await llmCall(undefined, user, chapterBreakdownResponseFormat())
  console.log(`  wall time: ${((Date.now() - t0) / 1000).toFixed(1)}s, completion_tokens=${breakdownReply.usage?.completion_tokens}`)
  const parsed = parseChapterBreakdown(breakdownReply.text)
  if (!parsed) {
    console.error('PARSE FAILED:', breakdownReply.text.slice(0, 2000))
    process.exit(1)
  }
  writeFileSync(join(outDir, 'ledger-chapter-breakdown.json'), JSON.stringify(parsed, null, 2))
  console.log(`  parsed: ${parsed.clips.length} clip(s), ${parsed.ledger.entities.length} ledger entit${parsed.ledger.entities.length === 1 ? 'y' : 'ies'}`)
  for (const e of parsed.ledger.entities) console.log(`    entity ${e.id} (${e.kind}): axes=${e.axes.map((a) => a.axis).join(',') || '(none)'}`)
  const issues = checkChapterBreakdown(parsed)
  console.log(`  deterministic checks: ${issues.length === 0 ? 'ALL PASS' : issues.length + ' issue(s)'}`)
  for (const i of issues) console.log(`    - ${i}`)

  const characterEntity = parsed.ledger.entities.find((e) => e.kind === 'character')
  const locationEntity = parsed.ledger.entities.find((e) => e.kind === 'environment') ?? parsed.ledger.entities.find((e) => e.kind !== 'character')

  // ── 2. Generate plates ────────────────────────────────────────────────
  const qwenTti = JSON.parse(readFileSync(join(process.cwd(), 'public/workflows/qwen21_tti.json'), 'utf8')) as Record<string, ComfyNode>
  const resolvedPlates: Record<string, string | null> = {}
  const platesById: Record<string, { name: string; job: string }> = {}

  async function generatePlate(entityId: string | undefined, label: string) {
    if (!entityId) { console.log(`  (no ${label} entity in this ledger — skipped)`); return }
    const entity = parsed.ledger.entities.find((e) => e.id === entityId)!
    const kind = platePromptKindForLedgerKind(entity.kind)
    console.log(`\n=== generating ${label} plate for '${entity.name}' (${kind}) ===`)
    const brief = fillPlateBrief(kind, { name: entity.name, description: describeEntityForPlate(entity), chapter: CHAPTER })
    const t1 = Date.now()
    const rewriteReply = await llmCall(QWEN_REWRITE_SYSTEM_PROMPT_T2I, brief)
    console.log(`  prompt-rewrite: ${((Date.now() - t1) / 1000).toFixed(1)}s, completion_tokens=${rewriteReply.usage?.completion_tokens}`)
    const rewritten = parsePlatePromptRewrite(rewriteReply.text)
    if (!rewritten) { console.error('  COULD NOT PARSE rewritten_prompt:', rewriteReply.text.slice(0, 1000)); return }
    console.log(`  rewritten prompt (${rewritten.length} chars): ${rewritten.slice(0, 200)}...`)

    const size = PLATE_SIZES[kind]
    const graph = buildQwenPlateGraph({ graph: qwenTti, prompt: rewritten, width: size.width, height: size.height, seed: 7, filenamePrefix: `plates/${entity.id}` })
    const promptId = await submit(ep, graph)
    console.log(`  submitted plate render, prompt_id ${promptId}`)
    let output
    for (;;) {
      await new Promise((r) => setTimeout(r, 3000))
      const res = await poll(ep, promptId)
      if (!res.done) continue
      if (res.failed) throw new Error(res.failed)
      output = res.output
      break
    }
    console.log(`  plate rendered -> ${JSON.stringify(output)}`)
    // For this probe, skip the vision analysis round-trip (it's already
    // validated live in the prior installment's Studio-authored render
    // check) and use a plain description for the REFERENCES registry.
    const job = describeEntityForPlate(entity)
    resolvedPlates[entity.id] = entity.id
    platesById[entity.id] = { name: entity.name, job }
  }

  await generatePlate(characterEntity?.id, 'character')
  await generatePlate(locationEntity?.id, 'location')

  // ── 3. One Studio-authored (preset D) clip, REFERENCES-aware ─────────
  const clip1 = parsed.clips[0]
  if (!clip1) { console.error('no clip 1 in the breakdown'); process.exit(1) }
  console.log(`\n=== 3. draftRewriter write for clip ${clip1.clip}, REFERENCES-aware ===`)
  const ctx = referenceContextForClip(parsed, clip1.clip, resolvedPlates, [])
  // referenceContextForClip reads plate.job off a real Plate[]; this probe
  // has no Plate objects (no PlatesPanel), so build the registry directly
  // from the same descriptions generatePlate recorded, keeping the exact
  // same shape rawAskForClipIndexWithReferences expects.
  const registry: Record<string, { name: string; role: string; description: string; clipIds: number[] }> = {}
  for (const [id, info] of Object.entries(platesById)) {
    const entity = parsed.ledger.entities.find((e) => e.id === id)!
    registry[id] = { name: info.name, role: entity.kind, description: info.job, clipIds: entity.clipIds }
  }
  const { rawAskForClipIndexWithReferences } = await import('../../src/lib/chapterBreakdown')
  const rawAsk = rawAskForClipIndexWithReferences(parsed, clip1.clip, ctx.refSlots, registry) ?? ''
  console.log(`  raw ask (${rawAsk.length} chars):\n${rawAsk}`)

  const seconds = clip1.shots.reduce((s, x) => s + x.seconds, 0)
  const film: FilmContext = { role: 'standalone', spine: parsed.chapter, precedes: '', follows: clip1.forwardPull }
  const userTemplate = fillTemplateWithDuration(DEFAULT_TEMPLATES.draftRewriter, {
    duration: durationBlock(seconds, framesForSeconds(seconds)),
    current: rawAsk,
    previous: undefined,
    film: filmBlock(film),
    plates: '',
    continuationFrame: '',
  })
  const t2 = Date.now()
  const writeReply = await llmCall(DEFAULT_REWRITE_SYSTEM_PROMPT, userTemplate, h3ResponseFormat('Ref2VA'))
  console.log(`  write: ${((Date.now() - t2) / 1000).toFixed(1)}s, completion_tokens=${writeReply.usage?.completion_tokens}`)
  const schemaResult = joinH3Sections(writeReply.text, 'Ref2VA')
  if (!schemaResult) { console.error('  COULD NOT JOIN SIX SECTIONS:', writeReply.text.slice(0, 1500)); process.exit(1) }
  writeFileSync(join(outDir, 'ledger-chapter-clip1-prompt.txt'), schemaResult.prompt)
  const auditIssues = auditClipPromptCitations(schemaResult.prompt, ctx.refSlots, registry, clip1.clip)
  console.log(`  citation audit: ${auditIssues.length === 0 ? 'PASS' : auditIssues.length + ' issue(s)'}`)
  for (const i of auditIssues) console.log(`    - ${i}`)

  // ── 4. ONE render, Studio-authored path, rewrite_mode: off ───────────
  console.log('\n=== 4. rendering clip 1, Studio-authored (rewrite_mode: off) ===')
  const extenderGraph = JSON.parse(readFileSync(join(process.cwd(), 'public/workflows/minimax_h3_master_extender_api.json'), 'utf8')) as Record<string, ComfyNode>
  const nodeId = Object.keys(extenderGraph).find((k) => extenderGraph[k].class_type === 'MiniMaxH3MasterExtender')!
  const built = buildExtenderGraph({
    graph: extenderGraph,
    nodeId,
    clips: [{ title: `Clip ${clip1.clip}`, prompt: schemaResult.prompt, seconds, seed: 7, seedMode: 'fixed', validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    overrides: EXTENDER_STUDIO_AUTHORING_OVERRIDES,
    validatedCount: 0,
    filmName: 'ledger-chapter-probe',
  })
  console.log(`  rewrite_mode on the built graph: ${built.graph[nodeId].inputs.rewrite_mode}`)
  const promptId = await submit(ep, built.graph)
  console.log(`  submitted render, prompt_id ${promptId}`)
  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await pollExtender(ep, promptId)
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    if (res.output) {
      console.log(`  done in ${secs}s -> ${JSON.stringify(res.output)}`)
      console.log(`  view: ${viewUrl(ep, res.output)}`)
      break
    }
    if (res.failed) { console.error(`  FAILED after ${secs}s: ${res.failed}`); process.exit(1) }
    console.log(`  ${secs}s running`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
