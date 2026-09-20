/**
 * probe/render/render.ts — render ONE prompt file through the Master
 * Extender, headlessly, so two prompts can be watched side by side.
 *
 * WHY. The judge is a number and we are several measurement bugs into
 * trusting it. Preset C beats preset B 7/7 on the rubric; nobody has looked
 * at a frame. This is the check that the score and the film agree.
 *
 * UNLOAD LLAMA FIRST. `llama-server` holds ~31.8 of the card's 32 GB, and the
 * gateway swaps backends per request — measured 2026-09-05, renders that take
 * 1.3-4 s on a free card took 241-581 s under contention. That is a ~150x
 * penalty of pure swap overhead, not compute.
 *
 * ```sh
 * COMFY_URL=http://<box>:9000/comfyui \
 *   npx tsx probe/render/render.ts --prompt path/to.txt --seconds 15 --name "C veyra" [--seed 7]
 * ```
 */

import { readFileSync } from 'node:fs'
import { buildExtenderGraph } from '../../src/lib/extender'
import { submit, pollExtender, viewUrl } from '../../src/lib/comfy'
import type { ComfyEndpoint, ComfyNode } from '../../src/lib/types'

const WORKFLOW = process.env.EXTENDER_WORKFLOW
  ?? `${process.env.HOME}/Downloads/MiniMax-H3-Master-Extender-15092026.json`

function arg(n: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

/** `extender.ts` keeps EXTENDER_CLASS module-private, so the literal is
 * repeated here rather than widening that module's surface for a probe. */
const EXTENDER_CLASS = 'MiniMaxH3MasterExtender'

/** The master node's own id in the shipped graph — found by class rather than
 * assumed, since `renumberExtenderNode` moves it. */
function findMaster(g: Record<string, ComfyNode>): string {
  for (const [id, n] of Object.entries(g)) if (n.class_type === EXTENDER_CLASS) return id
  throw new Error(`no ${EXTENDER_CLASS} node in ${WORKFLOW} — is this the Master Extender workflow?`)
}

async function main() {
  const promptFile = arg('prompt')
  const seconds = Number(arg('seconds') ?? 15)
  const name = arg('name') ?? 'probe'
  const seed = Number(arg('seed') ?? 7)
  if (!promptFile) { console.error('usage: --prompt <file> --seconds N --name "..." [--seed N]'); process.exit(1) }

  const baseUrl = process.env.COMFY_URL
  if (!baseUrl) { console.error('COMFY_URL is not set (the ComfyUI base, e.g. http://<box>:9000/comfyui)'); process.exit(1) }
  const ep: ComfyEndpoint = { id: 'probe', label: 'probe', baseUrl: baseUrl.replace(/\/$/, ''), builtIn: false }

  const prompt = readFileSync(promptFile, 'utf8')
  const graph = JSON.parse(readFileSync(WORKFLOW, 'utf8')) as Record<string, ComfyNode>

  // A single-clip film. `validatedCount: 0` means the signature guard cannot
  // fire (there is nothing validated to lose), and `priorMasterInputs` is
  // undefined because every probe render is a film's first submit.
  const built = buildExtenderGraph({
    graph,
    nodeId: findMaster(graph),
    clips: [{ title: name, prompt, seconds, seed, seedMode: 'fixed', validated: false }],
    plates: [],
    runMode: 'clip_by_clip',
    validatedCount: 0,
    filmName: name,
  })

  console.log(`submitting "${name}" · ${seconds}s · seed ${seed} · ${prompt.length}b of prompt`)
  const id = await submit(ep, built.graph)
  console.log(`  prompt_id ${id}`)

  const started = Date.now()
  for (;;) {
    await new Promise((r) => setTimeout(r, 5000))
    const res = await pollExtender(ep, id)
    const secs = ((Date.now() - started) / 1000).toFixed(0)
    if (res.output) {
      console.log(`  done in ${secs}s -> ${viewUrl(ep, res.output)}`)
      console.log(`  file: ${JSON.stringify(res.output)}`)
      return
    }
    if (res.failed) { console.error(`  FAILED after ${secs}s: ${res.failed}`); process.exit(1) }
    const p = res.preview ? ` · ${JSON.stringify(res.preview)}` : ''
    console.log(`  ${secs}s ${res.done ? 'done (no output?)' : 'running'}${p}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
