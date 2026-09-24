/**
 * probe/render/renderRewriter.ts — ONE headless render through the
 * rewriter-authored path: two clips' RAW ASKS (`chapterBreakdown.ts`'s
 * `formatClipRawAsk`, read from a saved `chapterBreakdownSmoke.ts` output)
 * submitted as `clips_json[i].prompt`, with `rewrite_mode: "pending clips"`
 * and `rewrite_system_prompt` set to `rewriteSystemPrompt.ts`'s
 * `DEFAULT_REWRITE_SYSTEM_PROMPT` — the Master Extender's OWN rewriter turns
 * each raw ask into the six-section prompt on the box before rendering.
 *
 * UNLOAD LLAMA FIRST. Same contention warning as `probe/render/render.ts`:
 * check `/status` on the gateway shows no `llama` inflight request before
 * running this — a render submitted while llama is mid-request is ~150x
 * slower, not merely queued behind it.
 *
 * ```sh
 * COMFY_URL=http://<box>:9000/comfyui \
 *   npx tsx probe/render/renderRewriter.ts --clips probe/pipeline/out/chapter-breakdown-parsed.json --take 1,2 --name "rewriter probe"
 * ```
 */

import { readFileSync } from 'node:fs'
import { buildExtenderGraph } from '../../src/lib/extender'
import { extenderRewriteOverrides } from '../../src/lib/extenderSettings'
import { formatClipRawAsk } from '../../src/lib/chapterBreakdown'
import type { ChapterBreakdown } from '../../src/lib/chapterBreakdown'
import { submit, pollExtender } from '../../src/lib/comfy'
import type { ComfyEndpoint, ComfyNode } from '../../src/lib/types'

const WORKFLOW = process.env.EXTENDER_WORKFLOW ?? `${process.cwd()}/public/workflows/minimax_h3_master_extender_api.json`

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

const EXTENDER_CLASS = 'MiniMaxH3MasterExtender'

function findMaster(g: Record<string, ComfyNode>): string {
  for (const [id, n] of Object.entries(g)) if (n.class_type === EXTENDER_CLASS) return id
  throw new Error(`no ${EXTENDER_CLASS} node in ${WORKFLOW}`)
}

async function main() {
  const clipsFile = arg('clips')
  const take = (arg('take') ?? '1,2').split(',').map((s) => Number(s.trim()))
  const name = arg('name') ?? 'rewriter probe'
  if (!clipsFile) { console.error('usage: --clips <chapter-breakdown-parsed.json> --take 1,2 --name "..."'); process.exit(1) }
  const baseUrl = process.env.COMFY_URL
  if (!baseUrl) { console.error('COMFY_URL is not set'); process.exit(1) }
  const ep: ComfyEndpoint = { id: 'probe', label: 'probe', baseUrl: baseUrl.replace(/\/$/, ''), builtIn: false }

  const breakdown = JSON.parse(readFileSync(clipsFile, 'utf8')) as ChapterBreakdown
  const chosen = breakdown.clips.filter((c) => take.includes(c.clip))
  if (chosen.length !== take.length) throw new Error(`could not find clip(s) ${take.join(',')} in ${clipsFile}`)

  const graph = JSON.parse(readFileSync(WORKFLOW, 'utf8')) as Record<string, ComfyNode>
  const nodeId = findMaster(graph)

  const clips = chosen.map((c) => ({
    title: `Clip ${c.clip}`,
    prompt: formatClipRawAsk(c),
    seconds: c.shots.reduce((sum, s) => sum + s.seconds, 0),
    seed: 7,
    seedMode: 'fixed' as const,
    validated: false,
  }))

  for (const c of clips) {
    console.log(`\n--- ${c.title} raw ask (${c.seconds}s) ---`)
    console.log(c.prompt)
  }

  const overrides = extenderRewriteOverrides(undefined)
  console.log(`\noverrides: ${JSON.stringify(overrides, null, 2).slice(0, 200)}...`)

  const built = buildExtenderGraph({
    graph,
    nodeId,
    clips,
    plates: [],
    runMode: 'full_batch',
    overrides,
    validatedCount: 0,
    filmName: name,
  })

  console.log(`\nsubmitting "${name}" — ${clips.length} clip(s), ${clips.reduce((s, c) => s + c.seconds, 0)}s total`)
  const id = await submit(ep, built.graph)
  console.log(`  prompt_id ${id}`)

  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await pollExtender(ep, id)
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    if (res.output) {
      console.log(`  done in ${secs}s -> ${JSON.stringify(res.output)}`)
      return
    }
    if (res.failed) { console.error(`  FAILED after ${secs}s: ${res.failed}`); process.exit(1) }
    const p = res.preview ? ` · ${JSON.stringify(res.preview)}` : ''
    console.log(`  ${secs}s ${res.done ? 'done (no output?)' : 'running'}${p}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
