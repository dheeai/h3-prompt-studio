import { useMemo, useState } from 'react'
import { useApp } from '../app/state'
import { RUNTIME_MAX_SECONDS, RUNTIME_MIN_SECONDS, RUNTIME_STEP_SECONDS, checkRuntimeCeiling, clampRuntimeSeconds, deriveFilmName, formatRuntime, groupsAffectedByCut, parsePartialShotList } from '../lib/shotList'
import { ceilingAlert, thinBriefAlert } from '../lib/shotScreens'
import { EXTENDER_REF_SLOTS, filmOutputPrefix } from '../lib/extender'
import { DraftingStatus } from './DraftingStatus'
import { FILM_LOOK_PRESETS, filmLookPreset, isFilmLookSet } from '../lib/filmLook'
import { LoraStackEditor } from './LoraStackEditor'
import { localLoraStackOverride } from '../lib/loras'
import { PIPELINE_PRESETS, pipelinePreset } from '../lib/pipeline'
import type { PipelinePresetId } from '../lib/pipeline'
import type { FilmContext, FilmLook, LoraStackEntry, Settings } from '../lib/types'

/**
 * The preset switch (2026-09-18 brief: "Create a new preset with direction +
 * acting.. and we will test the production against the two"). Lives right
 * next to the Project field — both are once-per-film decisions. Preset A is
 * stated as unchanged, in plain words, so nobody has to go read `pipeline.ts`
 * to know that leaving this alone changes nothing.
 */
function PipelinePresetRow({
  pipelinePreset: current,
  patchSettings,
}: {
  pipelinePreset: PipelinePresetId | undefined
  patchSettings: (p: Partial<Settings>) => void
}) {
  const active = pipelinePreset(current)
  return (
    <div style={{ marginBottom: 9 }}>
      <div className="lbl">Pipeline preset</div>
      <div style={{ display: 'flex', gap: 7, marginTop: 5, flexWrap: 'wrap' }}>
        {PIPELINE_PRESETS.map((p) => (
          <button
            key={p.id}
            className={`chip${active.id === p.id ? ' on' : ''}`}
            style={{ flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', maxWidth: 320, height: 'auto', padding: '7px 10px' }}
            onClick={() => patchSettings({ pipelinePreset: p.id })}
          >
            <span style={{ fontWeight: 600 }}>{p.name}</span>
            <span className="tok" style={{ color: 'inherit', opacity: 0.75, whiteSpace: 'normal', lineHeight: 1.4 }}>{p.description}</span>
            <span className="tok" style={{ color: 'inherit', opacity: 0.6 }}>{p.cost}</span>
          </button>
        ))}
      </div>
      <div className="tok" style={{ marginTop: 5, lineHeight: 1.5 }}>
        {active.id === 'direct-write'
          ? 'Preset A — the incumbent, unchanged. Nothing about how a prompt is authored is different from before this switch existed.'
          : 'Preset B — every clip gets two extra model calls (Direction, then Acting) before the prompt is written.'}
      </div>
    </div>
  )
}

/**
 * "Save the prompts locally" (the founder's own ask that opened this) — the
 * save target belongs right next to the Project field, since the project
 * name and the folder it saves into are one idea: what a film is called on
 * disk. Says plainly what state it is in, one line, no modal:
 *   - unsupported (Safari/Firefox) — a plain download, no folder concept.
 *   - none — nothing chosen yet.
 *   - granted — writes happen automatically as prompts are approved; "Save
 *     now" also covers a film authored before the folder existed.
 *   - needs-permission — a stored handle survived, but Chrome does not
 *     guarantee the GRANT does; needs one more click, not a re-pick.
 *   - denied — the grant was refused; only a fresh folder recovers.
 */
function SaveFilmRow({
  exportDirName, exportDirStatus, chooseExportDirectory, reconnectExportDirectory, saveFilmNow,
}: {
  exportDirName: string | null
  exportDirStatus: 'unsupported' | 'none' | 'granted' | 'needs-permission' | 'denied'
  chooseExportDirectory: () => Promise<void>
  reconnectExportDirectory: () => Promise<void>
  saveFilmNow: () => Promise<void>
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const run = (label: string, fn: () => Promise<void>) => async () => {
    setBusy(label)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9, flexWrap: 'wrap' }}>
      <span className="lbl" style={{ whiteSpace: 'nowrap' }}>Save to disk</span>
      {exportDirStatus === 'unsupported' && (
        <>
          <span className="tok">This browser can't grant a folder — "Save now" downloads plan.md + prompts + project.json.</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('save', saveFilmNow)}>{busy === 'save' ? 'Saving…' : 'Save now'}</button>
        </>
      )}
      {exportDirStatus === 'none' && (
        <>
          <span className="tok">No folder chosen — approved prompts exist only in this browser until you pick one.</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('choose', chooseExportDirectory)}>
            {busy === 'choose' ? 'Opening…' : 'Choose a folder…'}
          </button>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('save', saveFilmNow)}>
            {busy === 'save' ? 'Saving…' : 'or download instead'}
          </button>
        </>
      )}
      {exportDirStatus === 'granted' && (
        <>
          <span className="tok" style={{ color: 'var(--grn)' }}>Saving to "{exportDirName}" as prompts are approved.</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('save', saveFilmNow)}>{busy === 'save' ? 'Saving…' : 'Save now'}</button>
        </>
      )}
      {exportDirStatus === 'needs-permission' && (
        <>
          <span className="tok" style={{ color: 'var(--amb)' }}>Permission to "{exportDirName}" needs to be re-granted.</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('reconnect', reconnectExportDirectory)}>
            {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect'}
          </button>
        </>
      )}
      {exportDirStatus === 'denied' && (
        <>
          <span className="tok" style={{ color: 'var(--rule2)' }}>Permission to "{exportDirName}" was denied.</span>
          <button className="btn sm ghost" disabled={!!busy} onClick={run('choose', chooseExportDirectory)}>
            {busy === 'choose' ? 'Opening…' : 'Choose a different folder…'}
          </button>
        </>
      )}
    </div>
  )
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
 * The film-wide style-LoRA default (founder: "the story mode doesn't have
 * the lora selection"). The same KIND of decision as `FilmLookCard` right
 * above — chosen once, applies to the whole film — but unlike the look,
 * this is NOT baked into prompt text: `loras` sits in `EXTENDER_FREE_FIELDS`
 * (`lib/extender.ts`), so it is read at RENDER time, the same moment a
 * `BreakdownClip`'s own per-clip stack already is (`resolveLoraStack` in
 * `lib/loras.ts`, wired into `renderExtenderPlan`). Reuses `LoraStackEditor`
 * — the SAME editor `ClipPlan`/`Composer` already mount — rather than a
 * second implementation.
 *
 * Because a LoRA change never moves the render signature, it never
 * re-renders anything on its own — safe to change mid-film. But that cuts
 * both ways: change it partway through and every clip already rendered
 * keeps whatever it rendered with, so the film reads inconsistently
 * between clips rendered before and after, with NO warning from the guard
 * (nothing here moved as far as it's concerned) — said here plainly rather
 * than left for the operator to discover on watch.
 */
function FilmLoraCard({
  stack,
  defaultStack,
  available,
  listState,
  onRefresh,
  onChange,
}: {
  stack: LoraStackEntry[] | undefined
  defaultStack: LoraStackEntry[]
  available: string[]
  listState: 'idle' | 'loading' | 'ok' | 'error'
  onRefresh: () => void
  onChange: (stack: LoraStackEntry[] | undefined) => void
}) {
  return (
    <div className="card" style={{ marginTop: 9 }}>
      <div className="lbl">Film-wide style LoRAs</div>
      <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 4, lineHeight: 1.5 }}>
        Chosen once, applies to every clip that hasn't set its own on "The clip in hand" — a per-clip
        override always wins over this. Never part of the render signature, so changing it never
        re-renders anything already made — but for the same reason, a clip rendered before the change
        keeps the stack it rendered with, and the film reads inconsistently between clips rendered
        before and after until those are redone by hand.
      </div>
      <LoraStackEditor
        label="the whole film"
        stack={stack}
        defaultStack={defaultStack}
        available={available}
        listState={listState}
        onRefresh={onRefresh}
        onChange={onChange}
        customizedLabel="a film-wide stack is set"
        defaultLabel="no film-wide stack — every clip falls back to the workflow's own default"
      />
    </div>
  )
}

/**
 * "The film" — project name, plot, runtime ceiling, look, LoRAs, plates and
 * pipeline preset (2026-09-18 brief). Set once near the start of a film and
 * then in the way, so once a shot list exists it COLLAPSES to a one-line
 * summary with a way to reopen — the top of the single-page Full Story
 * layout (`App.tsx`'s module comment), never a tab of its own. Grouping
 * shots into clips and approving them into the plan now live on the
 * timeline (`FilmTimeline.tsx`) and the sticky next-step bar
 * (`NextStepBar.tsx`) — this file only ever writes `plot`/`maxRuntimeSeconds`/
 * `film`/`filmLoraStack`/settings, never a `BreakdownClip` or an H3 prompt.
 */
export function StoryAndShots({ onOpenPlates }: { onOpenPlates: () => void }) {
  const app = useApp()
  const {
    plot, setPlot, maxRuntimeSeconds, setMaxRuntimeSeconds, shotList, thinBriefCheck, shotsAuthoredSoFar,
    shotGroups, shotGroupIssues, shotListBusy, shotStreaming, makeShotList, continueSubdivision, reviseShotsFrom,
    breakdown, plates, platesFrozenReason, film, setFilm,
    filmLoraStack, setFilmLoraStack, extenderDefaultLoraStack, endpoint, loraNames, loraNamesState, refreshLoraNames,
    filmName, filmNameEffective, setFilmName, settings, patchSettings,
    exportDirName, exportDirStatus, chooseExportDirectory, reconnectExportDirectory, saveFilmNow,
  } = app

  // Pass 1 landed but pass 2 hasn't run yet — either it's paused on
  // `thinBriefCheck`, or the very next tick after `makeShotList` sets it
  // (both cases render the same "beats decided, no shots yet" state briefly).
  const beatsOnly = !!shotList && shotList.shots.length === 0

  // `app.filmName` is the EFFECTIVE name (the operator's own, else one
  // derived from the spine), which is what the readout below should show —
  // but the input itself must bind to what was actually TYPED, or a derived
  // name would appear as real text the operator has to delete before they
  // can name the film themselves. The derived name is the placeholder.
  const derivedName = deriveFilmName(shotList?.spine)


  // The operator's own machine-local override wins when present, else the
  // bound workflow's own baked default — the same fallback `ClipPlan`/
  // `Composer` already apply for their own `defaultStack`.
  const workflowLoraDefault = useMemo(() => {
    const local = localLoraStackOverride(import.meta.env.VITE_LOCAL_LORA_STACK)
    return local.length ? local : extenderDefaultLoraStack
  }, [extenderDefaultLoraStack])

  const [revFrom, setRevFrom] = useState(1)
  const [revOpen, setRevOpen] = useState(false)

  const busy = shotListBusy

  const ceiling = shotList ? checkRuntimeCeiling(shotList.shots, maxRuntimeSeconds) : null
  const alert = ceiling ? ceilingAlert(ceiling) : null

  const revPreview = shotGroups.length ? groupsAffectedByCut(shotGroups, revFrom) : null
  const revDiscardCount = revPreview
    ? revPreview.discardedGroupIndices.filter((i) => breakdown?.clips.some((c) => c.index === i)).length
    : 0

  // Once a shot list exists this whole card is set-and-forget and only in
  // the way, so it collapses to one line — but the operator can always
  // reopen (or re-collapse early) by hand; a wizard that traps them here
  // would be exactly the "no way onward" the brief rules out.
  const hasFullShotList = !!shotList && shotList.shots.length > 0
  const [manuallyOpen, setManuallyOpen] = useState<boolean | null>(null)
  const open = manuallyOpen ?? !hasFullShotList

  return (
    <div style={{ padding: '4px 26px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 9 }}>
        <span className="lbl">The film</span>
        <div style={{ flexGrow: 1 }} />
        <button className="btn sm ghost" onClick={() => setManuallyOpen(!open)}>{open ? 'collapse' : 'edit the film'}</button>
      </div>

      {!open ? (
        <div className="card" style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, fontSize: 12.5 }}>{filmNameEffective || 'this film'}</span>
          <span className="tok">{shotGroups.length} clip{shotGroups.length === 1 ? '' : 's'} planned</span>
          {ceiling && <span className="tok">{ceiling.totalSeconds.toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s ceiling</span>}
        </div>
      ) : (
      <>
      <div className="card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 9 }}>
          <span className="lbl" style={{ whiteSpace: 'nowrap' }}>Project</span>
          <input
            type="text"
            value={filmName}
            onChange={(e) => setFilmName(e.target.value)}
            placeholder={derivedName || 'name this film'}
            aria-label="Project name"
            style={{ flexGrow: 1, minWidth: 0, fontSize: 12 }}
          />
          <span className="tok" style={{ whiteSpace: 'nowrap' }} title="Where this film lands on the box">
            {filmOutputPrefix(filmNameEffective)}_00001_.mp4
          </span>
        </div>
        <PipelinePresetRow pipelinePreset={settings.pipelinePreset} patchSettings={patchSettings} />
        <SaveFilmRow
          exportDirName={exportDirName}
          exportDirStatus={exportDirStatus}
          chooseExportDirectory={chooseExportDirectory}
          reconnectExportDirectory={reconnectExportDirectory}
          saveFilmNow={saveFilmNow}
        />
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
        {/* Pass 1 (the beat list) is about the WHOLE plot, not one beat yet
            — so it renders right here, next to the button that started it,
            rather than at a beat it has no beat to attach to (2026-09-18:
            streaming belongs "exactly where it is working"). */}
        {shotStreaming && !shotStreaming.target && (
          <div style={{ marginTop: 9 }}><DraftingStatus streaming={shotStreaming} /></div>
        )}
      </div>

      <FilmLookCard look={film.look} setFilm={setFilm} />
      <FilmLoraCard stack={filmLoraStack} defaultStack={workflowLoraDefault} available={loraNames}
            listState={loraNamesState}
            onRefresh={refreshLoraNames} onChange={setFilmLoraStack} />

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

      {shotList?.beats && shotList.beats.length > 0 && (
        <div className="card" style={{ marginTop: 9 }}>
          <div className="lbl">Beats</div>
          {shotsAuthoredSoFar.length > 0 && shotList.shots.length === 0 && (
            <div className="tok" style={{ marginTop: 6 }}>
              whole film so far: {shotsAuthoredSoFar.length} shot{shotsAuthoredSoFar.length === 1 ? '' : 's'} ·{' '}
              {shotsAuthoredSoFar.reduce((sum, s) => sum + s.seconds, 0).toFixed(1)}s of {maxRuntimeSeconds.toFixed(1)}s
            </div>
          )}
          {shotList.beats.map((beat) => {
            // The streaming call names the beat it is subdividing
            // (`state.tsx`'s `beatIndex`), so THIS beat's own row is where
            // its progress — and the shots it has closed so far — belongs,
            // never a panel elsewhere on the page (2026-09-18 brief).
            const isStreamingHere = shotStreaming?.target?.kind === 'beat' && shotStreaming.target.beatIndex === beat.index
            const closedShots = (shotList.shots.length ? shotList.shots : shotsAuthoredSoFar).filter((s) => s.beatIndex === beat.index)
            const partial = isStreamingHere ? parsePartialShotList(shotStreaming!.text).shots : []
            return (
              <div key={beat.index} style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
                <div className="tok" style={{ display: 'flex', gap: 9, alignItems: 'baseline' }}>
                  <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{beat.index}</span>
                  <span style={{ flex: '1 1 auto', color: 'var(--ink2)' }}>{beat.covers}</span>
                  <span style={{ color: 'var(--ink3)' }}>{beat.seconds.toFixed(1)}s</span>
                </div>
                {isStreamingHere && <div style={{ marginTop: 6 }}><DraftingStatus streaming={shotStreaming!} /></div>}
                {closedShots.map((s) => (
                  <div key={s.index} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0 2px 29px', color: 'var(--ink2)' }}>
                    <span style={{ width: 20, flex: '0 0 auto', color: 'var(--ink3)' }}>{s.index}</span>
                    <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                    <span style={{ color: 'var(--ink3)' }}>{s.seconds}s</span>
                  </div>
                ))}
                {partial.map((s, i) => (
                  <div key={`partial-${i}`} className="tok" style={{ display: 'flex', gap: 9, padding: '2px 0 2px 29px', color: 'var(--ink3)' }}>
                    <span style={{ width: 20, flex: '0 0 auto' }}>{s.index}</span>
                    <span style={{ flex: '1 1 auto' }}>{s.covers}</span>
                    <span>{s.seconds}s</span>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      )}

      {beatsOnly && thinBriefCheck && (
        <div className="card" style={{ marginTop: 9 }}>
          <div className="lbl">Beats decided — before subdividing into shots</div>
          <div className="alert warn" style={{ marginTop: 9 }}>{thinBriefAlert(thinBriefCheck)}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 9 }}>
            <button className="btn pri sm" disabled={busy} onClick={() => void continueSubdivision()}>
              Continue and subdivide anyway
            </button>
          </div>
        </div>
      )}

      {shotList && !beatsOnly && (
        <>
          {alert && <div className="alert warn" style={{ marginTop: 9 }}>{alert}</div>}

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
        </>
      )}
      </>
      )}
    </div>
  )
}
