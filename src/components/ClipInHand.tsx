import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../app/state'
import { LoraStackEditor } from './LoraStackEditor'
import { localLoraStackOverride } from '../lib/loras'
import { DraftingStatus } from './DraftingStatus'
import { offVocabularyMovements } from '../lib/direction'
import type { DirectionDoc } from '../lib/direction'
import type { ActingDoc } from '../lib/acting'

/**
 * The Direction/Acting documents for one clip, read-only (2026-09-18 brief:
 * "the direction document should be inspectable for a clip — the operator
 * needs to see what the camera was told to do"). Only preset B
 * (`lib/pipeline.ts`) ever writes these, so this renders nothing for a clip
 * authored under preset A. An editor is a separate job — this never calls
 * back into `state.tsx`.
 */
function DirectionInspector({ direction, acting }: { direction: DirectionDoc | undefined; acting: ActingDoc | undefined }) {
  if (!direction && !acting) return null
  const offVocab = direction ? offVocabularyMovements(direction) : []
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="lbl">Direction &amp; acting — what the camera and the performance were told (preset B)</div>
      {direction && (
        <>
          <div className="tok" style={{ marginTop: 8, lineHeight: 1.55, color: 'var(--ink2)' }}>
            <strong>Geometry:</strong> {direction.geometrySentence || '(none written)'}
            <br />
            <strong>Rhythm:</strong> {direction.rhythm || '(none written)'}
          </div>
          <div className="tok" style={{ marginTop: 6 }}>
            {/* Reported, never corrected — a camera term outside H3's controlled
                vocabulary is the interesting failure and the number the A/B
                wants (see `offVocabularyMovements`'s own module comment). */}
            {offVocab.length > 0 ? (
              <span style={{ color: 'var(--amb)' }}>
                {offVocab.length} shot{offVocab.length === 1 ? '' : 's'} named a camera move outside H3's controlled vocabulary: shot{offVocab.length === 1 ? '' : 's'} {offVocab.join(', ')}
              </span>
            ) : (
              <span style={{ color: 'var(--grn)' }}>every shot's camera move is in H3's controlled vocabulary</span>
            )}
          </div>
          {direction.shots.map((s) => (
            <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '4px 0', borderTop: '1px solid var(--rule)', color: 'var(--ink2)' }}>
              <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
              <span style={{ flex: '1 1 auto' }}>
                {s.action}
                <br />
                <span className="tok">
                  camera: {s.cameraStartAngle} → {s.cameraEndAngle}, {s.cameraMovement} · {s.optics}
                </span>
              </span>
            </div>
          ))}
        </>
      )}
      {acting && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--rule)' }}>
          <div className="tok" style={{ color: 'var(--ink3)', marginBottom: 4 }}>Performance</div>
          {acting.performances.map((p, i) => (
            <div key={i} className="tok" style={{ padding: '2px 0', color: 'var(--ink2)' }}>
              <strong>{p.characterId}</strong> — wants: {p.objective || '(none written)'}; by: {p.tactic || '(none written)'}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Screen 2 — "The clip in hand" (2026-09-17 brief). The set currently open,
 * on its own, with a link back to Story & shots. Editing here never touches
 * an H3 prompt — it only edits `shotList.shots`/`shotGroups` (via
 * `shotScreens.ts`'s pure editors, wired through `state.tsx`). Approving
 * writes the prompt through the EXISTING per-clip Direct/Draft path
 * (`app.approveShotGroups`), same as Screen 1's own approve.
 */
export function ClipInHand({ onOpenStoryAndShots }: { onOpenStoryAndShots: () => void }) {
  const app = useApp()
  const {
    shotList, shotGroups, editingGroupIndex, setEditingGroupIndex, breakdown,
    rewordShotText, retimeShotSeconds, addShotInGroup, dropShotByIndex, pullShotIntoGroup, pushShotOutOfGroup,
    approveShotGroups, shotListBusy, streaming, pipelineStreaming, directionForClip, actingForClip,
    setClipLoraStack, filmLoraStack, extenderDefaultLoraStack, endpoint, loraNames, loraNamesState, refreshLoraNames,
  } = app
  const [newCovers, setNewCovers] = useState('')
  const [newSeconds, setNewSeconds] = useState(4)

  // What an UNSET clip actually falls back to: the film-wide default (Full
  // Story mode's "Story & shots" card) if one is set, else the operator's
  // own machine-local override, else the bound workflow's own baked
  // default — the same chain `resolveLoraStack` applies at render time.
  const inheritedDefault = useMemo(() => {
    if (filmLoraStack !== undefined) return filmLoraStack
    const local = localLoraStackOverride(import.meta.env.VITE_LOCAL_LORA_STACK)
    return local.length ? local : extenderDefaultLoraStack
  }, [filmLoraStack, extenderDefaultLoraStack])

  const busy = shotListBusy || !!streaming || !!pipelineStreaming
  const groupPos = shotGroups.findIndex((g) => g.index === editingGroupIndex)
  const group = groupPos === -1 ? null : shotGroups[groupPos]

  if (!shotList || !group) {
    return (
      <div style={{ padding: '24px 26px' }}>
        <span className="lbl">The clip in hand</span>
        <div className="tok" style={{ marginTop: 12, lineHeight: 1.6 }}>
          No set is open. <button className="btn sm ghost" onClick={onOpenStoryAndShots}>Go to Story &amp; shots</button> and open one from its list.
        </div>
      </div>
    )
  }

  const groupShots = shotList.shots.filter((s) => group.shotIndices.includes(s.index))
  const approvedClip = breakdown?.clips.find((c) => c.index === group.index)
  const hasPrev = groupPos > 0
  const hasNext = groupPos < shotGroups.length - 1

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">The clip in hand</span>
        <div style={{ flexGrow: 1 }} />
        <button className="btn sm ghost" onClick={onOpenStoryAndShots}>&larr; Story &amp; shots</button>
      </div>

      <div className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <button className="btn sm ghost" disabled={!hasPrev} onClick={() => setEditingGroupIndex(shotGroups[groupPos - 1].index)}>‹ prev set</button>
          <span className="tok">{group.index}</span>
          <span style={{ fontWeight: 600, fontSize: 13 }}>clip {group.index}</span>
          <span className="tok">{group.seconds.toFixed(1)}s</span>
          {approvedClip && <span className="tok" style={{ color: 'var(--grn)' }}>approved · “{approvedClip.title}”</span>}
          <div style={{ flexGrow: 1 }} />
          <button className="btn sm ghost" disabled={!hasNext} onClick={() => setEditingGroupIndex(shotGroups[groupPos + 1].index)}>next set ›</button>
        </div>

        <div style={{ marginTop: 10 }}>
          {groupShots.map((s) => (
            <div key={s.index} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', borderBottom: '1px solid var(--rule)' }}>
              <span className="tok" style={{ width: 20, flex: '0 0 auto', marginTop: 7 }}>{s.index}</span>
              <textarea
                className="composer-textarea"
                style={{ minHeight: 40, flex: '1 1 auto' }}
                value={s.covers}
                onChange={(e) => rewordShotText(s.index, e.target.value)}
              />
              <input
                type="number"
                min={0.5}
                step={0.5}
                value={s.seconds}
                onChange={(e) => retimeShotSeconds(s.index, Number(e.target.value) || s.seconds)}
                style={{ width: 56, marginTop: 7 }}
              />
              <button
                className="btn sm ghost"
                disabled={groupShots.length <= 1}
                onClick={() => dropShotByIndex(s.index)}
                style={{ marginTop: 5 }}
                title={groupShots.length <= 1 ? 'a set cannot be emptied to zero shots' : 'drop this shot'}
              >
                drop
              </button>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'flex-start' }}>
          <textarea
            className="composer-textarea"
            style={{ minHeight: 36, flex: '1 1 auto' }}
            placeholder="a new shot — what happens"
            value={newCovers}
            onChange={(e) => setNewCovers(e.target.value)}
          />
          <input type="number" min={0.5} step={0.5} value={newSeconds} onChange={(e) => setNewSeconds(Number(e.target.value) || 4)} style={{ width: 56 }} />
          <button
            className="btn sm"
            disabled={!newCovers.trim()}
            onClick={() => { addShotInGroup(group.index, newCovers.trim(), newSeconds); setNewCovers('') }}
          >
            add shot
          </button>
        </div>

        {(hasNext) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn sm ghost" onClick={() => pullShotIntoGroup(group.index)}>pull a shot in from the next clip</button>
            <button className="btn sm ghost" disabled={groupShots.length <= 1} onClick={() => pushShotOutOfGroup(group.index)}>push the last shot out to the next clip</button>
          </div>
        )}

        {/* A per-clip override writes onto `BreakdownClip.loraStack`
            (`setClipLoraStack`), which only exists once this set has been
            approved into the plan — before that there is nowhere to write
            it, so this offers the note below instead rather than a control
            that would silently do nothing. */}
        {approvedClip ? (
          <div style={{ marginTop: 14 }}>
            <LoraStackEditor
              label={`clip ${group.index}`}
              stack={approvedClip.loraStack}
              defaultStack={inheritedDefault}
              available={loraNames}
            listState={loraNamesState}
            onRefresh={refreshLoraNames}
              onChange={(stack) => setClipLoraStack(group.index, stack)}
              customizedLabel="overridden for this clip"
              defaultLabel={
                filmLoraStack !== undefined
                  ? 'inheriting the film-wide stack (Story & shots)'
                  : "inheriting the workflow's own default — no film-wide stack is set"
              }
            />
          </div>
        ) : (
          <div className="tok" style={{ marginTop: 14, lineHeight: 1.55, display: 'block' }}>
            Approve this clip to give it its own style-LoRA stack — until then it will inherit
            {filmLoraStack !== undefined ? ' the film-wide stack' : " the workflow's own default"} when it renders.
          </div>
        )}

        <div style={{ marginTop: 14 }}>
          <button className="btn pri" disabled={busy} onClick={() => void approveShotGroups([group.index])}>
            {approvedClip ? 'Re-approve and rewrite the prompt' : 'Approve and write the prompt'}
          </button>
        </div>
      </div>

      {pipelineStreaming && (
        <div className="card" style={{ marginTop: 9 }}>
          <DraftingStatus streaming={pipelineStreaming} />
        </div>
      )}

      <DirectionInspector direction={directionForClip(group.index)} acting={actingForClip(group.index)} />
    </div>
  )
}
