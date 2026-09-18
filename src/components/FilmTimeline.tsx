import { useState } from 'react'
import { useApp } from '../app/state'
import { FilmRegion } from './FilmRegion'
import { latestPromptForClip } from '../lib/stages'
import { lint, summarise } from '../lib/lint'
import { extenderCostEstimate } from '../lib/extender'
import { planForTickedSubmission, promptIsStale, toggledSet } from '../lib/shotScreens'
import { pairShotsWithPrompt, promptShotIssues, splitClipLevelSections, splitPromptShots } from '../lib/promptShots'
import { PromptDoc } from './PromptDoc'
import type { ClipTimelineState, TimelineClip } from '../lib/timeline'

/**
 * The film, start to finish — one clip band per row, on a shared time axis
 * (2026-09-18 brief: "consider showing the shots as a timeline.. start to
 * finish"). Replaces "Approve prompts" and "Watch & keep" (see `App.tsx`'s
 * module comment for the cost of that choice): both were a single-clip-at-
 * a-time view (the newest pending prompt, or the newest render); this shows
 * every clip's own state in one place and lets any of them be acted on, not
 * only the newest.
 *
 * `lib/timeline.ts`'s `buildTimeline` (`app.timeline`) is the one source of
 * truth for the geometry (clip/shot start times, delivered-vs-asked,
 * per-clip state) — this file adds no accounting of its own. The submit
 * card at the bottom still reads `extenderPlanPreview`/`submitTickedPrompts`
 * exactly as "Approve prompts" did; nothing about how a batch actually
 * renders changes here.
 *
 * PROMPT TEXT IS CLOSED BY DEFAULT, per shot, per clip. A shot band shows
 * only what happens and how it is shot (`covers` + camera term); its own
 * words open on click, one shot at a time, never the whole prompt. A
 * rendered clip collapses its shots entirely — the video is what you
 * judge — and only opens back up to work out why something came out wrong.
 * The four clip-level sections (`subject_definitions`, `retention_analysis`,
 * `overall_soundscape`, `non_diegetic_music` — found structurally by
 * `splitClipLevelSections`, not hardcoded) sit behind their own single
 * disclosure per clip. The raw whole prompt is always one click away
 * (`PromptDoc`), because it is ground truth.
 */
export function FilmTimeline({
  onOpenClipInHand,
  onOpenStoryAndShots,
}: {
  onOpenClipInHand: (groupIndex: number) => void
  onOpenStoryAndShots: () => void
}) {
  const app = useApp()
  const {
    timeline, shotGroups, breakdown, shotList, settings, versions,
    extenderPlanPreview, submitTickedPrompts, extenderReady, rendering,
    redoPlanClip, renderExtenderPlan, discardGroupRender, editPromptShotText,
    setEditingGroupIndex, shotListBusy, streaming, pipelineStreaming,
  } = app

  const [ticked, setTicked] = useState<Set<number>>(new Set())
  const [openShots, setOpenShots] = useState<Set<string>>(new Set())
  const [openSections, setOpenSections] = useState<Set<number>>(new Set())
  const [openFullPrompt, setOpenFullPrompt] = useState<Set<number>>(new Set())
  const [expandedRendered, setExpandedRendered] = useState<Set<number>>(new Set())
  const [managing, setManaging] = useState<number | null>(null)
  const [confirmingDiscard, setConfirmingDiscard] = useState<number | null>(null)
  const [editingShotKey, setEditingShotKey] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [busy, setBusy] = useState(false)

  const busyNow = busy || !!rendering || shotListBusy || !!streaming || !!pipelineStreaming

  if (!timeline.clips.length) {
    return (
      <div style={{ padding: '24px 26px' }}>
        <span className="lbl">The film, start to finish</span>
        <div className="tok" style={{ marginTop: 12, lineHeight: 1.6 }}>
          Nothing planned yet — make a shot list and approve a set or two in “Story &amp; shots” first.
        </div>
      </div>
    )
  }

  const shotKey = (clipIndex: number, shotIndex: number) => `${clipIndex}:${shotIndex}`

  const openInHand = (groupIndex: number) => {
    setEditingGroupIndex(groupIndex)
    onOpenClipInHand(groupIndex)
  }

  // `ticked` means "held BACK" — the same inversion "Approve prompts" used:
  // every pending (written, not yet validated) clip is included by default,
  // and un-ticking one holds it back from this submission.
  const pending = extenderPlanPreview?.clips.filter((c) => !c.validated && c.prompt.trim()) ?? []
  const heldBack = ticked
  const toSubmitIndices = pending.filter((c) => !heldBack.has(c.index)).map((c) => c.index)
  const { toSubmit } = planForTickedSubmission(extenderPlanPreview?.clips ?? [], new Set(toSubmitIndices))
  const cost = extenderCostEstimate(toSubmit)

  const submit = async () => {
    setBusy(true)
    try {
      await submitTickedPrompts(toSubmitIndices)
    } finally {
      setBusy(false)
    }
  }

  const redo = async (index: number, keepSeed: boolean) => {
    setBusy(true)
    try {
      redoPlanClip(index, { keepSeed })
      await renderExtenderPlan('clip_by_clip')
    } finally {
      setBusy(false)
      setManaging(null)
    }
  }

  const discard = (index: number) => {
    discardGroupRender(index)
    setConfirmingDiscard(null)
    setManaging(null)
    onOpenClipInHand(index)
  }

  const saveEdit = (clipIndex: number, shotN: number) => {
    editPromptShotText(clipIndex, shotN, editText)
    setEditingShotKey(null)
  }

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">The film, start to finish</span>
        <div style={{ flexGrow: 1 }} />
        <button className="btn sm ghost" onClick={onOpenStoryAndShots}>Story &amp; shots</button>
      </div>

      <FilmRegion />
      <RuntimeBar timeline={timeline} />

      <div style={{ marginTop: 12 }}>
        {timeline.clips.map((clip) => (
          <ClipBand
            key={clip.index}
            clip={clip}
            versions={versions}
            mode={settings.mode}
            hasGroup={shotGroups.some((g) => g.index === clip.index)}
            stale={(() => {
              const g = shotGroups.find((x) => x.index === clip.index)
              const bc = breakdown?.clips.find((x) => x.index === clip.index)
              return g && bc && shotList ? promptIsStale(bc, shotList.shots, g) : false
            })()}
            ticked={!heldBack.has(clip.index)}
            onToggleTick={() => setTicked((prev) => toggledSet(prev, clip.index))}
            openShots={openShots}
            onToggleShot={(key) => setOpenShots((prev) => toggledSet(prev, key))}
            sectionsOpen={openSections.has(clip.index)}
            onToggleSections={() => setOpenSections((prev) => toggledSet(prev, clip.index))}
            fullPromptOpen={openFullPrompt.has(clip.index)}
            onToggleFullPrompt={() => setOpenFullPrompt((prev) => toggledSet(prev, clip.index))}
            expandedRendered={expandedRendered.has(clip.index)}
            onToggleExpandedRendered={() => setExpandedRendered((prev) => toggledSet(prev, clip.index))}
            managing={managing === clip.index}
            onToggleManaging={() => setManaging((v) => (v === clip.index ? null : clip.index))}
            confirmingDiscard={confirmingDiscard === clip.index}
            onConfirmDiscard={() => setConfirmingDiscard(clip.index)}
            onCancelDiscard={() => setConfirmingDiscard(null)}
            onDiscard={() => discard(clip.index)}
            onRedo={(keepSeed) => void redo(clip.index, keepSeed)}
            onOpenInHand={() => openInHand(clip.index)}
            editingShotKey={editingShotKey}
            editText={editText}
            onStartEdit={(key, text) => {
              setEditingShotKey(key)
              setEditText(text)
            }}
            onChangeEditText={setEditText}
            onCancelEdit={() => setEditingShotKey(null)}
            onSaveEdit={(shotN) => saveEdit(clip.index, shotN)}
            busyNow={busyNow}
            shotKey={shotKey}
          />
        ))}
      </div>

      {pending.length > 0 && (
        <div className="card" style={{ marginTop: 4 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
            <span className="lbl">Submit the written, un-ticked-held-back clips as one Master Extender job</span>
            <div style={{ flexGrow: 1 }} />
            <span className="tok">
              {cost.totalSeconds.toFixed(1)}s · {cost.toSample} to sample · {cost.fromCache} from cache
            </span>
          </div>
          {extenderPlanPreview?.issues && extenderPlanPreview.issues.length > 0 && (
            <div className="alert warn" style={{ marginTop: 8 }}>
              {extenderPlanPreview.issues.map((i) => <div key={i}>{i}</div>)}
            </div>
          )}
          <button
            className="btn pri"
            style={{ marginTop: 10 }}
            disabled={!toSubmitIndices.length || !extenderReady || busyNow}
            onClick={() => void submit()}
          >
            {busyNow ? 'Rendering…' : `Render ${toSubmitIndices.length} written clip${toSubmitIndices.length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  )
}

// ── the runtime bar ────────────────────────────────────────────────────

function RuntimeBar({ timeline }: { timeline: import('../lib/timeline').Timeline }) {
  const { keptSeconds, renderedSeconds, remainingSeconds } = timeline.runtimeBar
  const total = timeline.totalSeconds || 1
  return (
    <div className="card" style={{ marginTop: 9 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Runtime</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">
          {timeline.totalSeconds.toFixed(1)}s{timeline.isEstimate ? ' (part estimated — not every clip has rendered)' : ''}
        </span>
      </div>
      <div style={{ display: 'flex', height: 10, border: '1px solid var(--rule)', background: 'var(--sunk)', overflow: 'hidden', marginTop: 8 }}>
        <div style={{ width: `${(keptSeconds / total) * 100}%`, background: 'var(--grn)' }} title={`kept · ${keptSeconds.toFixed(1)}s`} />
        <div style={{ width: `${(renderedSeconds / total) * 100}%`, background: 'var(--amb)' }} title={`rendered, not kept · ${renderedSeconds.toFixed(1)}s`} />
        <div style={{ width: `${(remainingSeconds / total) * 100}%`, background: 'var(--rule2)' }} title={`remaining · ${remainingSeconds.toFixed(1)}s`} />
      </div>
      <div style={{ display: 'flex', gap: 14, marginTop: 7 }}>
        <Swatch color="var(--grn)" label={`kept · ${keptSeconds.toFixed(1)}s`} />
        <Swatch color="var(--amb)" label={`rendered · ${renderedSeconds.toFixed(1)}s`} />
        <Swatch color="var(--rule2)" label={`remaining · ${remainingSeconds.toFixed(1)}s`} />
      </div>
    </div>
  )
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' }} />
      {label}
    </span>
  )
}

// ── per-clip state chrome ─────────────────────────────────────────────

function stateColor(s: ClipTimelineState): string {
  if (s === 'kept' || s === 'rendered') return 'var(--grn)'
  if (s === 'written') return 'var(--amb)'
  if (s === 'rendering') return 'var(--ox)'
  if (s === 'failed') return 'var(--ox)'
  return 'var(--rule2)' // planned
}

function stateLabel(s: ClipTimelineState): string {
  switch (s) {
    case 'planned': return 'planned · no prompt'
    case 'written': return 'written · not rendered'
    case 'rendering': return 'rendering now'
    case 'rendered': return 'rendered · not kept'
    case 'kept': return 'kept · validated'
    case 'failed': return 'failed'
  }
}

// ── one clip band ──────────────────────────────────────────────────────

interface ClipBandProps {
  clip: TimelineClip
  versions: import('../lib/types').Version[]
  mode: import('../lib/types').H3Mode
  hasGroup: boolean
  stale: boolean
  ticked: boolean
  onToggleTick: () => void
  openShots: Set<string>
  onToggleShot: (key: string) => void
  sectionsOpen: boolean
  onToggleSections: () => void
  fullPromptOpen: boolean
  onToggleFullPrompt: () => void
  expandedRendered: boolean
  onToggleExpandedRendered: () => void
  managing: boolean
  onToggleManaging: () => void
  confirmingDiscard: boolean
  onConfirmDiscard: () => void
  onCancelDiscard: () => void
  onDiscard: () => void
  onRedo: (keepSeed: boolean) => void
  onOpenInHand: () => void
  editingShotKey: string | null
  editText: string
  onStartEdit: (key: string, text: string) => void
  onChangeEditText: (text: string) => void
  onCancelEdit: () => void
  onSaveEdit: (shotN: number) => void
  busyNow: boolean
  shotKey: (clipIndex: number, shotIndex: number) => string
}

function ClipBand(props: ClipBandProps) {
  const { clip, versions, mode, hasGroup, stale, ticked, onToggleTick, onOpenInHand, busyNow } = props
  const [keepSeed, setKeepSeed] = useState(false)

  const promptVersion = latestPromptForClip(versions, clip.index)
  const promptText = promptVersion?.text ?? ''
  const { shotSectionBody, otherSections } = splitClipLevelSections(promptText)
  const split = splitPromptShots(shotSectionBody)
  const issues = promptShotIssues(split)
  const { pairs } = pairShotsWithPrompt(clip.shots, split)
  const findings = promptText ? lint(promptText, mode) : []
  const counts = summarise(findings)

  const isRenderedState = clip.state === 'kept' || clip.state === 'rendered'
  const shotsVisible = !isRenderedState || props.expandedRendered

  return (
    <div className="card" style={{ marginBottom: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
        {clip.state === 'written' && <input type="checkbox" checked={ticked} onChange={onToggleTick} />}
        <span className="tok">{clip.index}</span>
        <span style={{ fontWeight: 600, fontSize: 12.5 }}>{clip.title}</span>
        <span className="tok" title="film-wide start time">starts {clip.filmStartSeconds.toFixed(1)}s</span>
        <span className="tok">
          {clip.deliveredSeconds.toFixed(1)}s{clip.isEstimate ? ' (asked)' : ''}
          {!clip.isEstimate && clip.padded.authored !== clip.padded.delivered
            ? ` · asked ${(clip.padded.authored / 24).toFixed(1)}s`
            : ''}
        </span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok" style={{ color: stateColor(clip.state) }}>{stateLabel(clip.state)}</span>
        {hasGroup && <button className="btn sm ghost" onClick={onOpenInHand}>open in “the clip in hand”</button>}
      </div>

      {stale && (
        <div className="alert warn" style={{ marginTop: 8 }}>
          Clip {clip.index}’s shots have changed since this prompt was written — reopen it in “the clip in hand” to
          rewrite it against what they say now.
        </div>
      )}

      {promptText && (
        <div className="tok" style={{ marginTop: 7 }}>
          {counts.error > 0 && <span style={{ color: 'var(--ox)' }}>{counts.error} must fix · </span>}
          {counts.warn > 0 && <span style={{ color: 'var(--amb)' }}>{counts.warn} check · </span>}
          <span style={{ color: 'var(--grn)' }}>{counts.pass} pass</span>
        </div>
      )}

      {isRenderedState && (
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={props.onToggleExpandedRendered}>
          {props.expandedRendered ? 'collapse shots' : `inspect its ${clip.shots.length} shot${clip.shots.length === 1 ? '' : 's'}`}
        </button>
      )}

      {shotsVisible && clip.shots.length > 0 && (
        <div style={{ display: 'flex', gap: 2, marginTop: 9, height: 4 }}>
          {clip.shots.map((s) => (
            <div
              key={s.shotIndex}
              style={{ width: `${(s.seconds / (clip.askedSeconds || 1)) * 100}%`, background: 'var(--rule2)' }}
              title={`shot ${s.shotIndex} · ${s.seconds}s`}
            />
          ))}
        </div>
      )}

      {shotsVisible && pairs.map(({ shot, fragment }, i) => {
        const key = props.shotKey(clip.index, shot.shotIndex)
        const isOpen = props.openShots.has(key)
        const isEditing = props.editingShotKey === key
        return (
          <div key={shot.shotIndex} style={{ marginTop: 7, paddingTop: 7, borderTop: i === 0 ? 'none' : '1px solid var(--rule)' }}>
            <div
              className="tok"
              style={{ display: 'flex', gap: 9, alignItems: 'baseline', cursor: fragment ? 'pointer' : 'default' }}
              onClick={() => fragment && props.onToggleShot(key)}
            >
              <span style={{ width: 26, flex: '0 0 auto', color: 'var(--ink3)' }}>
                {shot.clipPosition}<span style={{ color: 'var(--ink3)', opacity: 0.6 }}> / film {shot.shotIndex}</span>
              </span>
              <span style={{ flex: '1 1 auto', color: 'var(--ink2)' }}>{shot.covers}</span>
              {shot.cameraMovement && <span style={{ color: 'var(--ink3)' }}>{shot.cameraMovement}</span>}
              <span style={{ color: 'var(--ink3)' }}>{shot.seconds}s</span>
              {fragment && <span style={{ color: 'var(--ink3)' }}>{isOpen ? '▾' : '▸'}</span>}
            </div>

            {isOpen && fragment && !isEditing && (
              <div style={{ marginTop: 6, paddingLeft: 35 }}>
                <div className="code" style={{ whiteSpace: 'pre-wrap' }}>{fragment.text.trim()}</div>
                <button className="btn sm ghost" style={{ marginTop: 6 }} onClick={() => props.onStartEdit(key, fragment.text)}>
                  edit this shot’s words
                </button>
              </div>
            )}
            {isOpen && isEditing && fragment && (
              <div style={{ marginTop: 6, paddingLeft: 35 }}>
                <textarea
                  className="composer-textarea"
                  style={{ minHeight: 70, width: '100%' }}
                  value={props.editText}
                  onChange={(e) => props.onChangeEditText(e.target.value)}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <button className="btn sm pri" onClick={() => props.onSaveEdit(fragment.n)}>Save</button>
                  <button className="btn sm ghost" onClick={props.onCancelEdit}>Cancel</button>
                </div>
              </div>
            )}
            {isOpen && !fragment && (
              <div className="tok" style={{ marginTop: 6, paddingLeft: 35, color: 'var(--amb)' }}>
                No fragment in the prompt for this shot — the plan and the prompt have drifted.
              </div>
            )}
          </div>
        )
      })}

      {shotsVisible && issues.noMarkers === false && (issues.numbering.length > 0 || issues.missingTimestamps.length > 0 || issues.outOfOrder.length > 0 || issues.firstShotTimestamped) && (
        <div className="alert warn" style={{ marginTop: 8 }}>
          {issues.numbering.length > 0 && <div>shot numbering drifted at: {issues.numbering.join(', ')}</div>}
          {issues.missingTimestamps.length > 0 && <div>missing timestamps: shot{issues.missingTimestamps.length === 1 ? '' : 's'} {issues.missingTimestamps.join(', ')}</div>}
          {issues.outOfOrder.length > 0 && <div>timestamps out of order: shot{issues.outOfOrder.length === 1 ? '' : 's'} {issues.outOfOrder.join(', ')}</div>}
          {issues.firstShotTimestamped && <div>[Shot 1] carries a timestamp it should not have</div>}
        </div>
      )}

      {otherSections.length > 0 && (
        <>
          <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={props.onToggleSections}>
            {props.sectionsOpen ? 'hide subject, retention &amp; sound' : 'show subject, retention &amp; sound'}
          </button>
          {props.sectionsOpen && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
              {otherSections.map((s) => (
                <div key={s.name} style={{ marginBottom: 8 }}>
                  <div className="tok" style={{ color: 'var(--ink3)', marginBottom: 3 }}>{s.name}</div>
                  <div className="tok" style={{ color: 'var(--ink2)', whiteSpace: 'pre-wrap' }}>{s.body.trim()}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {promptText && (
        <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={props.onToggleFullPrompt}>
          {props.fullPromptOpen ? 'hide the full prompt' : 'show the full prompt'}
        </button>
      )}
      {props.fullPromptOpen && promptText && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
          <PromptDoc text={promptText} />
        </div>
      )}

      {isRenderedState && hasGroup && (
        <>
          <button className="btn sm ghost" style={{ marginTop: 8 }} onClick={props.onToggleManaging}>
            {props.managing ? 'hide redo / discard' : 'redo or discard this render'}
          </button>
          {props.managing && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
              <label className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <input type="checkbox" checked={keepSeed} onChange={(e) => setKeepSeed(e.target.checked)} />
                keep the same seed on redo
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={busyNow} onClick={() => props.onRedo(keepSeed)}>
                  {busyNow ? 'Rendering…' : 'Right idea, bad take — redo'}
                </button>
                <button className="btn sm ghost" disabled={busyNow} onClick={props.onConfirmDiscard}>
                  Wrong shots — discard
                </button>
              </div>
              {props.confirmingDiscard && (
                <div className="alert warn" style={{ marginTop: 9 }}>
                  Discards clip {clip.index}’s prompt and this render — every later clip too, since the render cache
                  is a linear prefix.
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    <button className="btn sm" onClick={props.onDiscard}>Discard and go fix it</button>
                    <button className="btn sm ghost" onClick={props.onCancelDiscard}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
