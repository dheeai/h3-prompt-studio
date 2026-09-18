import { useEffect, useState } from 'react'
import { useApp } from './state'
import { ConnectPanel } from '../components/ConnectPanel'
import { SkillsPanel } from '../components/SkillsPanel'
import { SettingsPanel } from '../components/SettingsPanel'
import { PlatesPanel } from '../components/PlatesPanel'
import { ExtenderSettingsPanel } from '../components/ExtenderSettingsPanel'
import { EndpointPanel } from '../components/RenderPanel'
import { ClipPlan } from '../components/ClipPlan'
import { DraftingStatus } from '../components/DraftingStatus'
import { Marginalia } from '../components/Marginalia'
import { FilmRegion } from '../components/FilmRegion'
import { ScenesStrip } from '../components/ScenesStrip'
import { Composer } from '../components/Composer'
import { AgentPanel } from '../components/AgentPanel'
import { StoryAndShots } from '../components/StoryAndShots'
import { ClipInHand } from '../components/ClipInHand'
import { FilmTimeline } from '../components/FilmTimeline'
import { NextStepBar } from '../components/NextStepBar'

type Modal = 'connect' | 'skills' | 'settings' | 'plates' | 'extender-settings' | 'endpoint' | 'check' | null

/**
 * ONE COMPOSER. There are no entry-mode doors — see the module comment on
 * `lib/entry.ts`. Four regions, stacked, each with exactly one home:
 *
 *   1. THE FILM      — `FilmRegion`   — the artifact.
 *   2. THE SCENES    — `ScenesStrip`  — continue-from-here / prompt.
 *   3. THE COMPOSER  — `Composer`     — text, attachments, length, one button.
 *   4. SETUP         — this file's header — model, endpoint, geometry, steps,
 *      LoRAs and skills all live behind it; readiness is the one dot beside it.
 *
 * A previous pass on this app kept the old three-column authoring shell and
 * was rejected for it. This file replaces that shell rather than adjusting it.
 */
export function App() {
  const app = useApp()
  const { ready, skills, settings, versions, story, error, notice } = app
  const [modal, setModal] = useState<Modal>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  // Full Story is the default (founder, 2026-09-17): it is the way a film gets
  // made now, and Studio is the single-clip surface you drop into for one shot.
  const [workspace, setWorkspace] = useState<'studio' | 'story' | 'agent'>('story')
  const [confirmClear, setConfirmClear] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)

  const loadedSkills = skills.filter((s) => settings.selection[s.id]?.length)
  const endpointOk = app.endpoint ? app.comfyProbes[app.endpoint.id]?.state === 'ok' : false
  const ready2 = app.sceneBlockers.length === 0
  // The geometry/steps shown here are read straight off the Master
  // Extender's own loaded graph (`extenderDefaults`), never a Settings
  // override standing in for it — the node's `pass2_resolution`/
  // `pass2_steps` are baked into the shipped workflow and cannot be
  // overridden from here (issue #30).
  const { width, height, steps } = app.extenderDefaults ?? { width: undefined, height: undefined, steps: undefined }

  // A render in flight is a Studio-wide fact, not owned by whichever panel
  // started it (the composer's single scene, the plan's whole-batch submit,
  // Gate A's "approve and render", "Generate the rest", a Gate B redo, the
  // Agent's own render action) — so the confirm chip belongs here, in the
  // one header mounted no matter which workspace tab is showing, rather
  // than duplicated into every panel that can start one.
  useEffect(() => {
    if (!app.rendering) setConfirmStop(false)
  }, [app.rendering])

  if (!ready) {
    return (
      <div className="app" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <span className="tok">loading…</span>
      </div>
    )
  }

  return (
    <div className="app studio-app one-composer">
      <header className="studio-topbar">
        <div className="studio-wordmark"><span className="studio-mark">H3</span><span>Prompt Studio</span></div>
        <nav className="workspace-tabs" aria-label="Workspace">
          <button className={workspace === 'story' ? 'active' : ''} aria-current={workspace === 'story' ? 'page' : undefined} onClick={() => setWorkspace('story')}>Full Story</button>
          <button className={workspace === 'studio' ? 'active' : ''} aria-current={workspace === 'studio' ? 'page' : undefined} onClick={() => setWorkspace('studio')}>Studio</button>
          <button className={workspace === 'agent' ? 'active' : ''} aria-current={workspace === 'agent' ? 'page' : undefined} onClick={() => setWorkspace('agent')}>Agent <span>(beta)</span></button>
        </nav>
        <div className="studio-grow" />
        {app.rendering && (
          confirmStop ? (
            <div className="studio-clear-confirm" role="status">
              <span className="tok">
                stop rendering scene {app.rendering.extender?.sceneIndex ?? app.rendering.index}? it will not exist — anything
                else in this batch already finished stays cached.
              </span>
              <button className="btn pri sm" onClick={() => { app.stopRender(); setConfirmStop(false) }}>Stop</button>
              <button className="btn ghost sm" onClick={() => setConfirmStop(false)}>Keep rendering</button>
            </div>
          ) : (
            <button className="btn sm" onClick={() => setConfirmStop(true)}>Stop render</button>
          )
        )}
        <span className="tok setup-readiness">
          <span className={`dot ${ready2 ? 'ok' : 'warn'}`} /> {ready2 ? 'ready' : 'not ready'}
          {width && height ? ` · ${width}×${height} · ${steps} steps` : ''}
        </span>
        {confirmClear ? (
          <div className="studio-clear-confirm" role="status">
            <span className="tok">discard {versions.length} pass{versions.length === 1 ? '' : 'es'}?</span>
            <button className="btn pri sm" onClick={() => { void app.reset(); setConfirmClear(false) }}>Discard</button>
            <button className="btn ghost sm" onClick={() => setConfirmClear(false)}>Keep</button>
          </div>
        ) : (
          <button className="studio-top-action" onClick={() => (versions.length || story ? setConfirmClear(true) : undefined)} disabled={!versions.length && !story}>New draft</button>
        )}
        <div style={{ position: 'relative' }}>
          <button className="studio-top-action" onClick={() => setSetupOpen((v) => !v)}>Setup</button>
          {setupOpen && (
            <>
              <div className="setup-backdrop" onClick={() => setSetupOpen(false)} />
              <div className="setup-menu">
                <button onClick={() => { setModal('connect'); setSetupOpen(false) }}>
                  Model <span className="tok">{app.settings.model || 'not connected'}</span>
                </button>
                <button onClick={() => { setModal('endpoint'); setSetupOpen(false) }}>
                  ComfyUI endpoint <span className="tok"><span className={`dot ${endpointOk ? 'ok' : 'idle'}`} /> {app.endpoint?.label || 'none'}</span>
                </button>
                <button onClick={() => { setModal('extender-settings'); setSetupOpen(false) }}>
                  Render settings <span className="tok">
                    {width && height ? `${width}×${height}` : 'not loaded'}
                    {Object.keys(app.settings.extenderOverrides ?? {}).length ? ' · customized' : ''}
                  </span>
                </button>
                <button onClick={() => { setModal('skills'); setSetupOpen(false) }}>
                  Skills / reading <span className="tok">{loadedSkills.length} loaded</span>
                </button>
                <button onClick={() => { setModal('settings'); setSetupOpen(false) }}>
                  Model settings <span className="tok">temperature, output length</span>
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <div className={`workspace-view ${workspace === 'studio' ? 'is-active' : 'is-hidden'}`} aria-hidden={workspace !== 'studio'}>
        <FilmRegion />
        <ScenesStrip />
        <Composer
          onOpenPlates={() => setModal('plates')}
          onOpenCheck={() => setModal('check')}
        />
        {app.breakIntoScenes && (
          <div className="composer-plan">
            {!app.breakdown && (
              <button
                className="btn"
                disabled={!story.trim() || !!app.streaming}
                onClick={() => void app.run('breakdown', undefined, { studioMode: 'story' })}
              >
                {app.streaming ? 'Planning…' : 'Create clip plan'}
              </button>
            )}
            {/* Planning is the longest silent stretch in the app — it reads the
                whole source before it emits anything. The panel belongs next to
                the button that started it, not only up in the composer. */}
            {app.streaming?.stage === 'breakdown' && <DraftingStatus streaming={app.streaming} />}
            {app.breakdown && <ClipPlan />}
          </div>
        )}
        {error && <div className="alert err composer-error"><span>{error}</span><button className="btn sm ghost" onClick={app.clearError}>dismiss</button></div>}
        {notice && <div className="alert warn composer-error"><span>{notice}</span><button className="btn sm ghost" onClick={app.clearNotice}>dismiss</button></div>}
      </div>

      <div className={`workspace-view ${workspace === 'story' ? 'is-active' : 'is-hidden'}`} aria-hidden={workspace !== 'story'}>
        {/* ONE SCROLLING PAGE, no tabs — the tab order was never the work
            order (2026-09-18 founder brief: "the whole flow is super
            confusing.. we go to tab 2 first, then the user needs to know to
            go to tab 1 for timeline"). Top to bottom is the order the work
            actually happens: the film's own setup (collapses once a shot
            list exists), the one sticky next step, then the timeline. "The
            clip in hand" is a drill-in reached by clicking a clip, never a
            tab — see the overlay below, driven by `editingGroupIndex`. */}
        <StoryAndShots onOpenPlates={() => setModal('plates')} />
        {/* THE ERROR GOES ABOVE THE FOLD, next to the next step — not at the
            foot of the page. It used to sit after `FilmTimeline`, so on any
            film with clips the one message explaining why a run stopped was
            below every clip band and off-screen. The founder hit exactly
            that: preset B refused after spending its Direction and Acting
            calls, `setError` fired correctly, and the report was "it just
            stops" and "its not telling me what happened either" — because
            nothing he could see said anything. A failure has to appear where
            the action that failed was pressed. */}
        {error && (
          <div className="alert err" style={{ position: 'sticky', top: 0, zIndex: 20, margin: '0 26px 9px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ flexGrow: 1 }}>{error}</span>
            <button className="btn sm ghost" onClick={app.clearError}>dismiss</button>
          </div>
        )}
        {notice && (
          <div className="alert warn" style={{ margin: '0 26px 9px', display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ flexGrow: 1 }}>{notice}</span>
            <button className="btn sm ghost" onClick={app.clearNotice}>dismiss</button>
          </div>
        )}
        <NextStepBar />
        <FilmTimeline />
        {app.editingGroupIndex !== null && (
          <div className="backdrop" onClick={() => app.setEditingGroupIndex(null)}>
            <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 760, width: '94vw', maxHeight: '88vh' }}>
              <div className="modal-body">
                <ClipInHand onClose={() => app.setEditingGroupIndex(null)} />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={`workspace-view ${workspace === 'agent' ? 'is-active' : 'is-hidden'}`} aria-hidden={workspace !== 'agent'}>
        <AgentPanel onOpenStudio={() => setWorkspace('studio')} />
      </div>

      {modal === 'connect' && <ConnectPanel onClose={() => setModal(null)} />}
      {modal === 'skills' && <SkillsPanel onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsPanel onClose={() => setModal(null)} />}
      {modal === 'plates' && <PlatesPanel onClose={() => setModal(null)} />}
      {modal === 'extender-settings' && <ExtenderSettingsPanel onClose={() => setModal(null)} />}
      {modal === 'endpoint' && <EndpointPanel onClose={() => setModal(null)} />}
      {modal === 'check' && (
        <div className="backdrop" onClick={() => setModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620 }}>
            <div className="modal-head"><strong>Prompt check</strong><button className="btn sm ghost" onClick={() => setModal(null)}>Close</button></div>
            <div className="modal-body"><Marginalia /></div>
          </div>
        </div>
      )}
    </div>
  )
}
