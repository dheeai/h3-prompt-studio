import { useState } from 'react'
import { useApp } from '../app/state'
import { RUNTIME_MAX_SECONDS, RUNTIME_MIN_SECONDS, RUNTIME_STEP_SECONDS, checkRuntimeCeiling, clampRuntimeSeconds, formatRuntime, groupsAffectedByCut, parsePartialShotList } from '../lib/shotList'
import { ceilingAlert, groupBandState } from '../lib/shotScreens'
import type { GroupBandState } from '../lib/shotScreens'
import { EXTENDER_REF_SLOTS } from '../lib/extender'
import { DraftingStatus } from './DraftingStatus'
import { FILM_LOOK_PRESETS, filmLookPreset, isFilmLookSet } from '../lib/filmLook'
import type { FilmContext, FilmLook } from '../lib/types'

function bandColor(state: GroupBandState): string {
  if (state === 'kept') return 'var(--grn)'
  if (state === 'waiting') return 'var(--amb)'
  return 'var(--rule2)'
}

function bandLabel(state: GroupBandState): string {
  if (state === 'kept') return 'kept · validated'
  if (state === 'waiting') return 'rendered-and-waiting'
  return 'not yet written'
}

/**
 * The film-wide camera/lens/look selector (2026-09-17 brief, refined same
 * day to ONE dropdown of named camera-and-lens COMBINATIONS rather than
 * independent axes — a focal length, a grain gauge and a palette are not
 * independent choices, and a multi-axis form invites picking ones that
 * don't describe any real camera package). Lives here, next to the plot,
 * rather than in the render settings panel: it is authored PROMPT text
 * picked once for the whole film — the same kind of decision as the plot
 * itself — not a ComfyUI graph setting, and it never touches
 * `EXTENDER_SIGNATURE_FIELDS`. Writes through `setFilm`, which
 * shallow-merges onto the existing `FilmContext`, so setting this before any
 * clip is approved is enough for it to reach every clip approved afterwards
 * (`approveShotGroups`/`generateRest`/`authorNextAfterLanding` all call
 * `setFilm` with a partial object that leaves `look` untouched).
 */
function FilmLookCard({ look, setFilm }: { look: FilmLook | undefined; setFilm: (f: Partial<FilmContext>) => void }) {
  const set = (patch: Partial<FilmLook>) => setFilm({ look: { ...look, ...patch } })
  const preset = filmLookPreset(look?.preset)
  return (
    <div className="card" style={{ marginTop: 9 }}>
      <div className="lbl">Film-wide look</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 4, lineHeight: 1.5 }}>
        Chosen once, applied to every clip — a described LOOK, not a measured optical change. "Best for" is a
        suggestion about the look a combination produces, not a claim that H3 renders a true optical equivalent —
        whether a stated focal length actually shifts field of view, or is only a stylistic nudge, has not been
        measured.
        <br />
        This rides on the film context, not the render graph, on purpose: changing it here reaches only clips not
        yet authored. An already-authored or already-rendered clip keeps the look it was written under until you
        redo it by hand — the film reads inconsistently in the meantime.
      </div>
      <label className="tok" style={{ display: 'block', marginTop: 10 }}>
        Camera &amp; lens
        <select value={look?.preset ?? ''} onChange={(e) => set({ preset: e.target.value || undefined })} style={{ width: '100%', marginTop: 4 }}>
          <option value="">unset</option>
          {FILM_LOOK_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name} — best for {p.bestFor}</option>
          ))}
        </select>
      </label>
      {preset && (
        <div className="tok" style={{ display: 'block', marginTop: 6, color: 'var(--ink2)', lineHeight: 1.5 }}>
          {preset.description}
        </div>
      )}
      <label className="tok" style={{ display: 'block', marginTop: 10 }}>
        Free text — anything the list above doesn't cover
        <textarea
          className="composer-textarea"
          style={{ minHeight: 46, marginTop: 4 }}
          value={look?.freeText ?? ''}
          onChange={(e) => set({ freeText: e.target.value })}
          placeholder="a specific stock name, a reference director's look, a look written entirely from scratch…"
        />
      </label>
      {isFilmLookSet(look) && (
        <div className="tok" style={{ marginTop: 8, color: 'var(--ink2)' }}>
          Applied to every clip authored from here on — visible in the prompt each Direct/Draft pass produces.
        </div>
      )}
    </div>
  )
}

/**
 * Screen 1 — "Story & shots" (2026-09-17 brief). The plot and the runtime
 * ceiling live HERE; a rendered clip reports its own state back onto the
 * SAME list, so this stays the one map of the film. Approving a set derives
 * a `BreakdownClip` and hands it straight to the EXISTING per-clip
 * Direct/Draft path (`app.approveShotGroups`) — nothing here writes camera,
 * performance or an H3 prompt.
 */
export function StoryAndShots({
  onOpenClipInHand,
  onOpenPlates,
}: {
  onOpenClipInHand: (groupIndex: number) => void
  onOpenPlates: () => void
}) {
  const app = useApp()
  const {
    plot, setPlot, maxRuntimeSeconds, setMaxRuntimeSeconds, shotList, shotGroups, shotGroupIssues,
    shotListBusy, shotStreaming, makeShotList, reviseShotsFrom, approveShotGroups, breakdown, extenderPlanPreview,
    setEditingGroupIndex, streaming, plates, platesFrozenReason, film, setFilm,
  } = app

  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [revFrom, setRevFrom] = useState(1)
  const [revOpen, setRevOpen] = useState(false)

  const bandFor = (groupIndex: number): GroupBandState => {
    const approved = !!breakdown?.clips.some((c) => c.index === groupIndex)
    const validated = extenderPlanPreview?.clips.find((c) => c.index === groupIndex)?.validated ?? false
    return groupBandState(approved, validated)
  }

  const busy = shotListBusy || !!streaming

  const toggle = (i: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(i)) next.delete(i)
      else next.add(i)
      return next
    })

  const doApprove = async () => {
    const indices = [...selected].sort((a, b) => a - b)
    setSelected(new Set())
    await approveShotGroups(indices)
  }

  const ceiling = shotList ? checkRuntimeCeiling(shotList.shots, maxRuntimeSeconds) : null
  const alert = ceiling ? ceilingAlert(ceiling) : null

  const revPreview = shotGroups.length ? groupsAffectedByCut(shotGroups, revFrom) : null
  const revDiscardCount = revPreview
    ? revPreview.discardedGroupIndices.filter((i) => extenderPlanPreview?.clips.find((c) => c.index === i)?.validated).length
    : 0

  const openInHand = (groupIndex: number) => {
    setEditingGroupIndex(groupIndex)
    onOpenClipInHand(groupIndex)
  }

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">Story &amp; shots</span>
      </div>

      <div className="card">
        <div className="lbl">The plot</div>
        <textarea
          className="composer-textarea"
          style={{ minHeight: 120, marginTop: 6 }}
          value={plot}
          onChange={(e) => setPlot(e.target.value)}
          placeholder="What happens, start to finish…"
        />
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 9, flexWrap: 'wrap' }}>
          <label className="tok" style={{ display: 'flex', alignItems: 'center', gap: 9, flexGrow: 1, minWidth: 260 }}>
            maximum runtime
            <input
              type="range"
              min={RUNTIME_MIN_SECONDS}
              max={RUNTIME_MAX_SECONDS}
              step={RUNTIME_STEP_SECONDS}
              value={clampRuntimeSeconds(maxRuntimeSeconds)}
              onChange={(e) => setMaxRuntimeSeconds(clampRuntimeSeconds(Number(e.target.value)))}
              style={{ flexGrow: 1, maxWidth: 300 }}
            />
            <span className="tok" style={{ color: 'var(--ink)', minWidth: 52 }}>
              {formatRuntime(clampRuntimeSeconds(maxRuntimeSeconds))}
            </span>
            <span className="tok">
              ≈ {Math.round(clampRuntimeSeconds(maxRuntimeSeconds) / RUNTIME_STEP_SECONDS)} clip
              {Math.round(clampRuntimeSeconds(maxRuntimeSeconds) / RUNTIME_STEP_SECONDS) === 1 ? '' : 's'}
            </span>
          </label>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" disabled={!plot.trim() || busy} onClick={() => void makeShotList()}>
            {shotListBusy ? 'Making the shot list…' : shotList ? 'Remake the shot list' : 'Make the shot list'}
          </button>
        </div>
      </div>

      <FilmLookCard look={film.look} setFilm={setFilm} />

      <div className="card" style={{ marginTop: 9 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
          <div className="lbl">Plates</div>
          <div style={{ flexGrow: 1 }} />
          <span className="tok">{plates.length} of {EXTENDER_REF_SLOTS}</span>
          <button className="btn sm" onClick={onOpenPlates}>Manage plates</button>
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 4 }}>
          Recurring characters need a plate to stay the same person across clips — a prompt cites one as
          &lt;Picture N&gt;, so position here is what a prompt means by N.
        </div>
        {plates.length > 0 && (
          <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap', marginTop: 9 }}>
            {plates.map((p, i) => (
              <span key={p.id} className="chip" title={p.job.trim() || 'No job written yet.'}>
                &lt;{p.kind === 'video' ? 'Video' : 'Picture'} {i + 1}&gt; {p.name}
                {!p.job.trim() && <span style={{ color: 'var(--ox)' }}> · no job</span>}
              </span>
            ))}
          </div>
        )}
        {platesFrozenReason && <div className="alert warn" style={{ marginTop: 9 }}>{platesFrozenReason}</div>}
      </div>

      {shotStreaming && (
        <div className="card" style={{ marginTop: 9 }}>
          <DraftingStatus streaming={shotStreaming} />
          {(() => {
            // Shots close off in ARRIVAL order and never get rewritten once
            // closed (the model is a forward-only token stream), so — unlike
            // a band that reflects render/approval state and can flip
            // colors — a running total here only ever grows. Showing it live
            // is a plain "how far in are we", not something that can jitter;
            // see `parsePartialShotList`'s module comment for why a shot only
            // appears once its object has fully closed.
            const partial = parsePartialShotList(shotStreaming.text)
            if (!partial.shots.length) return null
            const total = partial.shots.reduce((sum, s) => sum + s.seconds, 0)
            return (
              <div style={{ marginTop: 9 }}>
                <div className="tok">
                  {partial.shots.length} shot{partial.shots.length === 1 ? '' : 's'} so far · {total.toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s
                </div>
                {partial.shots.map((s) => (
                  <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0', color: 'var(--ink2)' }}>
                    <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                    <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                    <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {shotList && (
        <>
          <div className="card" style={{ marginTop: 9 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
              <span className="lbl">Authored vs. ceiling</span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok">
                {ceiling?.totalSeconds.toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s
              </span>
            </div>
            <div style={{ display: 'flex', height: 8, border: '1px solid var(--rule)', background: 'var(--sunk)', overflow: 'hidden', marginTop: 8 }}>
              {shotGroups.map((g) => {
                const state = bandFor(g.index)
                const pct = maxRuntimeSeconds > 0 ? Math.min(100, (g.seconds / maxRuntimeSeconds) * 100) : 0
                return <div key={g.index} style={{ width: `${pct}%`, background: bandColor(state) }} title={`clip ${g.index} · ${bandLabel(state)} · ${g.seconds}s`} />
              })}
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 7 }}>
              {(['kept', 'waiting', 'unwritten'] as const).map((state) => (
                <span key={state} className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: bandColor(state), display: 'inline-block', flex: '0 0 auto' }} />
                  {bandLabel(state)}
                </span>
              ))}
            </div>
            {alert && <div className="alert warn" style={{ marginTop: 9 }}>{alert}</div>}
          </div>

          {shotGroupIssues.length > 0 && (
            <div className="alert warn" style={{ marginTop: 9 }}>
              {shotGroupIssues.map((i) => <div key={i}>{i}</div>)}
            </div>
          )}

          <div className="card" style={{ marginTop: 9 }}>
            <div className="lbl">Revise from a shot</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 7 }}>
              <span className="tok">from shot</span>
              <input type="number" min={1} value={revFrom} onChange={(e) => { setRevFrom(Number(e.target.value) || 1); setRevOpen(false) }} style={{ width: 56 }} />
              <span className="tok">— edit the plot above first, then</span>
              <button className="btn sm" disabled={busy} onClick={() => setRevOpen(true)}>Preview revision</button>
            </div>
            {revOpen && (
              <div style={{ marginTop: 9 }}>
                {revDiscardCount > 0 ? (
                  <div className="alert warn">
                    Regenerating from shot {revFrom} discards {revDiscardCount} rendered clip{revDiscardCount === 1 ? '' : 's'} — they no longer
                    follow what the shot list will say.
                  </div>
                ) : (
                  <div className="tok">Nothing rendered yet is affected by this cut.</div>
                )}
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button
                    className="btn pri sm"
                    disabled={busy}
                    onClick={() => { setRevOpen(false); void reviseShotsFrom(revFrom) }}
                  >
                    {revDiscardCount > 0 ? `Discard ${revDiscardCount} and regenerate` : 'Regenerate from here'}
                  </button>
                  <button className="btn sm ghost" onClick={() => setRevOpen(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: 12 }}>
            {shotGroups.map((g) => {
              const state = bandFor(g.index)
              const groupShots = shotList.shots.filter((s) => g.shotIndices.includes(s.index))
              return (
                <div className="card" key={g.index} style={{ marginBottom: 7 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
                    {state === 'unwritten' && (
                      <input type="checkbox" checked={selected.has(g.index)} onChange={() => toggle(g.index)} />
                    )}
                    <span className="tok">{g.index}</span>
                    <span style={{ fontWeight: 600, fontSize: 12.5 }}>clip {g.index}</span>
                    <span className="tok">{g.seconds.toFixed(1)}s</span>
                    <div style={{ flexGrow: 1 }} />
                    <span className="tok" style={{ color: bandColor(state) }}>{bandLabel(state)}</span>
                    {state !== 'unwritten' && (
                      <button className="btn sm ghost" onClick={() => openInHand(g.index)}>open in “the clip in hand”</button>
                    )}
                  </div>
                  <div style={{ marginTop: 7 }}>
                    {groupShots.map((s) => (
                      <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0', color: 'var(--ink2)' }}>
                        <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                        <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                        <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>

          {selected.size > 0 && (
            <button className="btn pri" disabled={busy} onClick={() => void doApprove()} style={{ marginTop: 4 }}>
              Approve {selected.size} and generate {selected.size === 1 ? 'its prompt' : 'their prompts'}
            </button>
          )}
        </>
      )}
    </div>
  )
}
