/**
 * probe/render/renderStudioAuthored.ts — ONE headless render through the
 * STUDIO-authored path: a single already-written six-section prompt (e.g.
 * one of `draftRewriterSmoke.ts`'s saved outputs) submitted with
 * `EXTENDER_STUDIO_AUTHORING_OVERRIDES` (`rewrite_mode: "off"`) explicitly
 * applied — the exact override `state.tsx`'s `renderExtenderPlan` merges in
 * whenever `settings.authoringMode !== 'rewriter'`. Confirms the shipped
 * graph's baked `rewrite_mode: "pending clips"` default (needed for the
 * ComfyUI-rewriter path) does NOT leak into a Studio-authored render and
 * get treated as a raw ask by the node's own rewriter.
 *
 * UNLOAD LLAMA FIRST — same contention warning as `probe/render/render.ts`.
 *
 * ```sh
 * COMFY_URL=http://<box>:9000/comfyui \
 *   npx tsx probe/render/renderStudioAuthored.ts --prompt path/to/six-section.txt --seconds 15 --name "studio probe"
 * ```
 */

import { readFileSync } from 'node:fs'
import { buildExtenderGraph } from '../../src/lib/extender'
import { EXTENDER_STUDIO_AUTHORING_OVERRIDES } from '../../src/lib/extenderSettings'
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
  const promptFile = arg('prompt')
  const seconds = Number(arg('seconds') ?? 15)
  const name = arg('name') ?? 'studio-authored probe'
  const seed = Number(arg('seed') ?? 7)
  if (!promptFile) { console.error('usage: --prompt <file> --seconds N --name "..."'); process.exit(1) }
  const baseUrl = process.env.COMFY_URL
  if (!baseUrl) { console.error('COMFY_URL is not set'); process.exit(1) }
  const ep: ComfyEndpoint = { id: 'probe', label: 'probe', baseUrl: baseUrl.replace(/\/$/, ''), builtIn: false }

  const prompt = readFileSync(promptFile, 'utf8')
  const graph = JSON.parse(readFileSync(WORKFLOW, 'utf8')) as Record<string, ComfyNode>
  const nodeId = findMaster(graph)

  console.log(`overrides: ${JSON.stringify(EXTENDER_STUDIO_AUTHORING_OVERRIDES)}`)
  const built = buildExtenderGraph({
    graph,
    nodeId,
    clips: [{ title: name, prompt, seconds, seed, seedMode: 'fixed', validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    overrides: EXTENDER_STUDIO_AUTHORING_OVERRIDES,
    validatedCount: 0,
    filmName: name,
  })

  console.log(`submitting "${name}" · ${seconds}s · seed ${seed} · ${prompt.length}b of prompt · rewrite_mode=${built.graph[nodeId].inputs.rewrite_mode}`)
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
