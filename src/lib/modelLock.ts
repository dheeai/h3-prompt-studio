/**
 * ONE MODEL PER SESSION. The Studio must never swap the model out from under the box.
 *
 * WHY THIS IS A HARD GUARD AND NOT A HINT. The 5090 gateway single-flights the GPU and
 * llama-server holds ~31.8 of 32 GB, so changing the selected model does not "switch a
 * setting" — it evicts and reloads tens of gigabytes. Two consequences, both measured
 * elsewhere in this repo's notes: renders that take 1.3-4 s on a free card took 241-581 s
 * under swap contention (~150x, entirely swap overhead), and an author->critic swap on
 * every cycle of an authoring loop thrashes residency continuously. The global rule is
 * already "use the SAME local model as both implementer and critic to prevent GPU
 * thrashing"; this is that rule made mechanical for the Studio.
 *
 * The Studio already routes EVERY call through `settings.model` — authoring stages, the
 * agent surface, and the plate/vision analysis in PlatesPanel — so there is no per-stage
 * swap to remove. The hole this closes is a swap BETWEEN calls: nothing stopped the user
 * changing the selection mid-session and paying a reload on the next stage.
 *
 * Design: the lock arms on the first model call of a session and pins that model. A
 * different model is refused with the reason, not silently honoured. Releasing is
 * deliberate (`releaseReason` explains what the user must do), because an accidental
 * release is exactly the thing being prevented.
 */

export type ModelLock = { model: string; provider: string; armedAt: number } | null

/** Arm the lock on the first call. Idempotent for the same model+provider. */
export function armModelLock(lock: ModelLock, model: string, provider: string, now = Date.now()): ModelLock {
  if (lock && lock.model === model && lock.provider === provider) return lock;
  if (lock) return lock;                      // never silently re-arm to a different model
  return { model, provider, armedAt: now };
}

/**
 * @returns null when the call may proceed, or the reason it may not.
 */
export function modelLockViolation(lock: ModelLock, model: string, provider: string): string | null {
  if (!lock) return null;
  if (lock.model === model && lock.provider === provider) return null;
  const what = lock.provider !== provider && lock.model !== model
    ? `provider "${lock.provider}" → "${provider}" and model "${lock.model}" → "${model}"`
    : lock.provider !== provider
      ? `provider "${lock.provider}" → "${provider}"`
      : `model "${lock.model}" → "${model}"`;
  return `This session is pinned to ${lock.provider}/${lock.model}. Changing ${what} would evict ~30 GB and reload — `
       + `the gateway single-flights the GPU, and swap contention has been measured at ~150x on render times. `
       + `Finish or clear this session before switching, or release the pin deliberately in Settings.`;
}

/** Human-readable state, for the UI to show why a selection is refused. */
export function describeModelLock(lock: ModelLock): string {
  return lock ? `pinned to ${lock.provider}/${lock.model}` : 'not pinned — the next model call will pin this session';
}
