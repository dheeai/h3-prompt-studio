import type { StudioRunPhase } from './studio-workflow'

/**
 * The `streamChatComplete` callbacks that turn a call into what
 * `DraftingStatus` renders: thinking until real text arrives, writing once it
 * has, continuing/thinking-recovery on a continuation round.
 *
 * `run()` and the Full Story shots calls (`makeShotList`, `reviseShotsFrom`,
 * in `app/state.tsx`) share this rather than each keeping their own copy —
 * the bug this was written to fix (2026-09-17) was exactly a second call site
 * (the shots calls) that never got this wiring in the first place, so it
 * showed no progress at all. Generic over the caller's own progress slot
 * (`run()`'s `streaming`, keyed to a `StageId`; the shots calls' own
 * `shotStreaming`) rather than hardcoded to one, so a caller with no
 * `StageId` of its own still gets the identical phase machinery.
 *
 * Every callback no-ops when the slot has already gone back to `null` (a
 * cancelled or finished call) — `s ? {...} : s` — so a late-arriving chunk
 * from an aborted request can never resurrect a cleared progress panel.
 */
export function streamingCallbacks<T extends { text: string; reasoning: string; continuations: number; phase?: StudioRunPhase }>(
  setProgress: (updater: (s: T | null) => T | null) => void,
) {
  return {
    onDelta: (chunk: string) =>
      setProgress((s) => (s ? { ...s, text: s.text + chunk, phase: s.phase === 'thinking' ? 'writing' : s.phase } : s)),
    onReasoning: (chunk: string) =>
      setProgress((s) => (s ? { ...s, reasoning: s.reasoning + chunk, phase: s.text ? s.phase : 'thinking' } : s)),
    onContinuation: (round: number, kind: 'answer' | 'thinking') =>
      setProgress((s) => (s ? { ...s, continuations: round, phase: kind === 'thinking' ? 'thinking-recovery' : 'continuing' } : s)),
    // A continuation resumes from the last complete line, so the partial one
    // already on the page has to come back off it.
    onRewind: (chars: number) =>
      setProgress((s) => (s ? { ...s, text: s.text.slice(0, Math.max(0, s.text.length - chars)) } : s)),
  }
}
