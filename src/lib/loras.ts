import type { ComfyNode, LoraStackEntry } from './types'

/**
 * The style-LoRA stack: which LoRAs are worth offering in the picker, how a
 * selection is serialized onto a graph's `LTX_lora_loader.stack_data`, and
 * the operator's own machine-local default. Split out of `chain.ts` (removed
 * with Contex-Loop, 2026-09-16) because these are generic LoRA-stack helpers
 * that were filed in the wrong module — every render path with an
 * `LTX_lora_loader` node in its graph (the Master Extender's shipped workflow
 * included) can read/write this same shape.
 */

/** The pack's SELECTABLE LoRA stack node — separate from an accelerator LoRA
 * loader, and never confused with it (see `LoraStackEntry`'s module comment
 * in types.ts). */
const LORA_STYLE_STACK_CLASS = 'LTX_lora_loader'

const byClass = (g: Record<string, ComfyNode>, cls: string): string | undefined =>
  Object.keys(g).find((k) => g[k]?.class_type === cls)

/**
 * Every LoRA name matching this is an ACCELERATOR — distilled-step or
 * turbo-family — never a style choice. Offering one of these in the
 * selectable style stack risks sampling it at the wrong step count for its
 * distillation, so this is checked at the UI layer (`selectableStyleLoras`).
 */
export const ACCELERATOR_LORA_RE = /turbo|lightx2v/i

/** The style LoRAs worth offering in the picker: never an accelerator. Any
 * other LoRA the box offers is selectable — there is no content gate here. */
export function selectableStyleLoras(all: string[]): string[] {
  return all.filter((name) => !ACCELERATOR_LORA_RE.test(name))
}

/** The exact per-entry shape an `LTX_lora_loader` node parses — `str`/`v`/`a`/`t`,
 * not `strength` — shared by `serializeLoraStack` (the graph's own baked
 * `stack_data`, stringified) and `loraStackToWire` (one plan clip's resolved
 * stack, embedded directly as an array inside `clips_json[i].loras` — never a
 * second stringified layer). A filename with `%20` in it survives either path
 * untouched. */
function loraWireEntry(e: LoraStackEntry) {
  return { on: e.on, lora: e.lora, str: e.strength, v: 1, a: 1, t: 1 }
}

/** Serialize a style-stack selection into the exact `stack_data` shape an
 * `LTX_lora_loader` node parses. */
export function serializeLoraStack(stack: LoraStackEntry[]): string {
  return JSON.stringify(stack.map(loraWireEntry))
}

/** The same wire shape as `serializeLoraStack`, but as a plain array rather
 * than a JSON string — what `ExtenderClipInput.loras` (`extender.ts`) expects
 * for one clip's entry inside `clips_json`. */
export function loraStackToWire(stack: LoraStackEntry[]): Array<ReturnType<typeof loraWireEntry>> {
  return stack.map(loraWireEntry)
}

/** Parse a `stack_data`-shaped JSON string (`serializeLoraStack`'s own output,
 * or whatever a workflow file / env var already carries) into `LoraStackEntry[]`.
 * Never throws: anything malformed, or not an array, just reads as empty. Shared
 * by `readBakedLoraStack` (a graph's own baked default) and `localLoraStackOverride`
 * (the operator's own machine-local default). */
function parseLoraStackData(raw: string): LoraStackEntry[] {
  try {
    const parsed = JSON.parse(raw) as Array<{ on?: unknown; lora?: unknown; str?: unknown }>
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((e) => typeof e.lora === 'string')
      .map((e) => ({ lora: e.lora as string, strength: typeof e.str === 'number' ? e.str : 0.5, on: e.on !== false }))
  } catch {
    return []
  }
}

/** The inverse of `serializeLoraStack` — read back whatever a graph's
 * `LTX_lora_loader.stack_data` already carries (the workflow file's OWN
 * baked default), so the studio can show and seed an edit from it rather
 * than starting a customization from nothing. Never throws: a graph with no
 * style-stack node, or malformed JSON, just reads as empty. */
export function readBakedLoraStack(graph: Record<string, ComfyNode> | null | undefined): LoraStackEntry[] {
  if (!graph) return []
  const id = byClass(graph, LORA_STYLE_STACK_CLASS)
  if (!id) return []
  return parseLoraStackData(String(graph[id].inputs.stack_data ?? '[]'))
}

/**
 * The operator's OWN machine-local default style stack — sourced from
 * `VITE_LOCAL_LORA_STACK` in a gitignored `.env.local`, never from the
 * shipped workflow.
 *
 * Vite inlines `VITE_*` vars at BUILD time, and the GitHub Pages build runs
 * from a fresh checkout with no `.env.local` present, so this is empty on the
 * public site regardless of what any operator's own machine has configured —
 * the shipped `LTX_lora_loader.stack_data` is what every visitor actually
 * gets. `raw` is `import.meta.env.VITE_LOCAL_LORA_STACK` — passed in rather
 * than read directly so this stays testable outside Vite.
 */
export function localLoraStackOverride(raw: string | undefined): LoraStackEntry[] {
  if (!raw) return []
  return parseLoraStackData(raw)
}

/**
 * A stable comparison key for a plan clip's style-stack selection —
 * `undefined` ("leave the workflow's own baked stack alone") is its OWN
 * distinct value, never treated as equal to an explicit stack even one with
 * identical content, because the two mean different things at build time
 * (one stamps nothing, the other stamps exactly that array).
 */
export function loraStackKey(stack: LoraStackEntry[] | undefined): string {
  if (stack === undefined) return '\0default'
  return JSON.stringify(stack.map((e) => ({ on: e.on, lora: e.lora, str: e.strength })))
}

/**
 * Whether a whole-plan submit can go out as ONE job, or must auto-split into
 * one job per scene.
 *
 * One ComfyUI job builds ONE graph with ONE `LTX_lora_loader.stack_data` —
 * every shot in that job samples against whatever this build stamped, so a
 * whole-plan submit can only stay a single job when every plan clip wants the
 * SAME style stack. The moment two clips differ, the only way to honour both
 * is one job per scene.
 */
export function planNeedsPerSceneLoraSplit(stacks: ReadonlyArray<LoraStackEntry[] | undefined>): boolean {
  if (stacks.length <= 1) return false
  const first = loraStackKey(stacks[0])
  return stacks.some((s) => loraStackKey(s) !== first)
}

/**
 * One clip's resolved style-stack, in priority order: its OWN explicit
 * choice, else the FILM-WIDE default (Full Story mode's "Story & shots"
 * card — `Session.filmLoraStack`), else the bound workflow's own baked
 * default. Mirrors the two-level fallback `ClipPlan`/`Composer` already
 * apply for `defaultStack` (a local machine override, else the graph's own
 * `stack_data`) one level further out: a per-clip override, else a
 * film-wide one, else that same workflow default.
 *
 * Never a fourth level: an unset film default and a workflow default that
 * happens to be `[]` are not distinguished, because both mean "nothing more
 * specific was chosen here."
 */
export function resolveLoraStack(
  clipStack: LoraStackEntry[] | undefined,
  filmStack: LoraStackEntry[] | undefined,
  workflowDefault: LoraStackEntry[],
): LoraStackEntry[] {
  if (clipStack !== undefined) return clipStack
  if (filmStack !== undefined) return filmStack
  return workflowDefault
}
