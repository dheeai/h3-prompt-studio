import { useState } from 'react'
import { useApp } from '../app/state'
import { nextStep } from '../lib/nextStep'
import { deriveNextStepInput } from '../lib/nextStepInput'
import { pipelinePreset } from '../lib/pipeline'
import { clipsNeedingPrompt } from '../lib/studio-workflow'

/**
 * The single sticky answer to "what do I do now" — see `nextStep.ts`'s own
 * module comment for why this exists at all. Sticky at the TOP of the Full
 * Story scroll region (2026-09-18: "I have no ability to render the film at
 * all now" — the render action used to live below every clip band, off
 * screen on anything past two or three clips) so the one action that matters
 * is never something the operator has to scroll to find.
 *
 * Every button here calls the EXACT SAME function a per-clip/bulk control
 * elsewhere on the page calls — `approveShotGroups`, `writePendingPrompts`,
 * `submitTickedPrompts`, `stopRender`, `continueSubdivision`, `makeShotList`,
 * `saveFilmNow` — never a second implementation of any of them. This bar is
 * a dispatcher onto those, not a parallel authoring path.
 */
export function NextStepBar() {
  const app = useApp()
  const {
    plot, shotList, thinBriefCheck, shotGroups, breakdown, versions, timeline, rendering,
    settings, makeShotList, continueSubdivision, approveShotGroups, writePendingPrompts,
    submitTickedPrompts, stopRender, saveFilmNow,
  } = app
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const clipsNeedingPromptCount = breakdown ? clipsNeedingPrompt(breakdown, versions).length : 0
  const callsPerClip = 1 + pipelinePreset(settings.pipelinePreset).extraStages.length

  const step = nextStep(
    deriveNextStepInput({
      plot,
      hasShotList: !!shotList,
      awaitingSubdivision: !!shotList && shotList.shots.length === 0 && !!thinBriefCheck,
      thinBriefCheck: thinBriefCheck ?? null,
      groupCount: shotGroups.length,
      approvedClipCount: breakdown?.clips.length ?? 0,
      clipsNeedingPromptCount,
      timeline,
      rendering: !!rendering,
      callsPerClip,
    }),
  )

  const unapprovedGroupIndices = shotGroups.filter((g) => !breakdown?.clips.some((c) => c.index === g.index)).map((g) => g.index)
  const writtenClipIndices = timeline.clips.filter((c) => c.state === 'written').map((c) => c.index)

  const run = async (fn: () => Promise<unknown> | void) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
      setConfirming(false)
    }
  }

  const press = () => {
    if (step.spendsGpu && !confirming) {
      setConfirming(true)
      return
    }
    switch (step.kind) {
      case 'make-shot-list':
        return void run(() => makeShotList())
      case 'resolve-thin-brief':
        return void run(() => continueSubdivision())
      case 'approve-groups':
        return void run(() => approveShotGroups(unapprovedGroupIndices))
      case 'write-prompts':
        return void run(() => writePendingPrompts())
      case 'stop-or-wait':
        return stopRender()
      case 'render-clips':
        return void run(() => submitTickedPrompts(writtenClipIndices))
      case 'watch-and-keep':
        document.getElementById('film-timeline')?.scrollIntoView({ behavior: 'smooth' })
        return
      case 'film-done':
        return void run(() => saveFilmNow())
      case 'write-plot':
        return
    }
  }

  return (
    <div className="next-step-bar" role="status">
      <div className="next-step-bar-row">
        <span className="next-step-kind tok">{step.kind.replace(/-/g, ' ')}</span>
        {step.actionable && !confirming && (
          <button className="btn pri" disabled={busy} onClick={press}>
            {busy ? 'Working…' : step.action}
          </button>
        )}
        {confirming && (
          <>
            <span className="tok" style={{ color: 'var(--amb)' }}>
              {step.cost} of GPU time — go ahead?
            </span>
            <button className="btn pri sm" disabled={busy} onClick={press}>{busy ? 'Rendering…' : 'Confirm'}</button>
            <button className="btn ghost sm" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
          </>
        )}
        <div style={{ flexGrow: 1 }} />
        {step.cost && !confirming && <span className="tok">{step.cost}</span>}
      </div>
      <div className="tok next-step-detail">{step.detail}</div>
    </div>
  )
}
