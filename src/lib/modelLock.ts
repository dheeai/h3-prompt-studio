/**
 * MODEL SWAPS ARE EXPENSIVE, NOT FORBIDDEN.
 *
 * WHAT A SWAP ACTUALLY COSTS, because the number is the whole point of warning at
 * all. The 5090 gateway single-flights the GPU and llama-server holds tens of GB,
 * so changing the selected model does not "change a setting" — it evicts and
 * reloads. Measured elsewhere in this repo's notes: renders that take 1.3-4 s on
 * a free card took 241-581 s under swap contention (~150x, entirely swap
 * overhead), and an author->critic swap on every cycle of an authoring loop
 * thrashes residency continuously.
 *
 * WHY THIS IS NOW ADVISORY (founder directive, 2026-09-17). It shipped as a hard
 * refusal, on the reasoning that an accidental swap is exactly what you want to
 * prevent. That was wrong in practice: changing model between scenes is a normal
 * thing to want — comparing two models on the same film is the obvious example —
 * and a blocker turned a deliberate choice into a dead end that needed a hidden
 * Settings release to escape. The cost is real, so it is still stated plainly;
 * the decision belongs to the operator.
 *
 * The pin therefore re-arms to whatever was chosen, and warns ONCE per change
 * rather than on every subsequent call: the second scene authored on the new
 * model is no longer news.
 */

export type ModelLock = { model: string; provider: string; armedAt: number } | null

/** Arm on the first call, and RE-arm on a deliberate change so the warning is
 * emitted once per swap rather than on every call that follows it. */
export function armModelLock(lock: ModelLock, model: string, provider: string, now = Date.now()): ModelLock {
  if (lock && lock.model === model && lock.provider === provider) return lock
  return { model, provider, armedAt: now }
}

/**
 * @returns null when nothing changed, or an advisory describing the swap and
 * what it costs. The caller SHOWS this and proceeds — it is not a refusal.
 */
export function modelSwapWarning(lock: ModelLock, model: string, provider: string): string | null {
  if (!lock) return null
  if (lock.model === model && lock.provider === provider) return null
  const what = lock.provider !== provider && lock.model !== model
    ? `provider "${lock.provider}" → "${provider}" and model "${lock.model}" → "${model}"`
    : lock.provider !== provider
      ? `provider "${lock.provider}" → "${provider}"`
      : `model "${lock.model}" → "${model}"`
  return `Switching ${what}. The box evicts and reloads the model, so the next call pays that once — `
       + `and swap contention has been measured at ~150x on render times, so avoid alternating `
       + `models mid-film. Continuing.`
}

/** Human-readable state, for the UI. */
export function describeModelLock(lock: ModelLock): string {
  return lock ? `using ${lock.provider}/${lock.model}` : 'no model used yet this session'
}
