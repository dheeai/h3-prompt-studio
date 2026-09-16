import type { ComfyNode } from './types'

/**
 * Reading a ComfyUI API-format workflow graph off disk.
 *
 * Salvaged out of the deleted `recipe.ts` (2026-09-16): parsing a graph was
 * never Recipe-specific, only what `recipe.ts` went on to DO with the result
 * (detect bindings, write slots) was. The Master Extender's own shipped-graph
 * fetch (`state.tsx`'s boot effect) is this function's other caller, and now
 * its only one.
 */

export class WorkflowError extends Error {}

/** Accept only API-format graphs, and say plainly when handed the other one. */
export function parseWorkflow(text: string): Record<string, ComfyNode> {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch (e) {
    throw new WorkflowError(`That file is not valid JSON — ${(e as Error).message}`)
  }
  if (!j || typeof j !== 'object') throw new WorkflowError('That file is not a workflow.')

  const o = j as Record<string, unknown>
  if (Array.isArray(o.nodes)) {
    throw new WorkflowError(
      'That is the UI workflow, which cannot be run directly. In ComfyUI use Workflow ▸ Export (API) and drop that file instead.',
    )
  }

  const entries = Object.entries(o).filter(
    ([, v]) => v && typeof v === 'object' && typeof (v as ComfyNode).class_type === 'string',
  )
  if (!entries.length) throw new WorkflowError('No nodes found. This does not look like an API-format workflow.')
  return Object.fromEntries(entries) as Record<string, ComfyNode>
}
