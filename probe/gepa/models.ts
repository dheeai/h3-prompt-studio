/**
 * The two GEPA roles, named once.
 *
 * TASK MODEL — founder directive 2026-09-19: "we optimise against swift
 * uncensored 27b.. that should be our default going forward". Every prompt
 * this project optimises is optimised FOR this model, on the local box. It is
 * not interchangeable: prompt optimisation learns a specific model's failure
 * modes, so swapping the task model invalidates the tuning rather than
 * porting it.
 *
 * REFLECTION MODEL — `claude -p`, locked to a single turn with no tools. See
 * `reflect.ts`. Never ships, never generates film content.
 */
export const TASK_MODEL = 'swift-uncensored-27b'

/** The local llama.cpp gateway, from the environment — never hardcoded, so a
 * tailnet host never lands in a tracked file. */
export function taskEndpoint(): string {
  const url = process.env.LLM_URL
  if (!url) throw new Error('LLM_URL is not set (the local llama.cpp chat/completions endpoint)')
  return url
}
