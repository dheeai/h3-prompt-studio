import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../app/state'
import { LoraStackEditor } from './LoraStackEditor'
import { listLoraNames } from '../lib/comfy'
import { localLoraStackOverride } from '../lib/loras'
import { clipsNeedingPrompt } from '../lib/studio-workflow'
import { latestPromptForClip } from '../lib/stages'


/**
 * The style-stack editor for one plan clip — add/remove a LoRA, toggle it,
 * adjust its strength. `stack` is `undefined` until this clip is customized,
 * at which point it renders on whatever the bound Master Extender workflow's
 * own `LTX_lora_loader.stack_data` already carries (`defaultStack`).
 */
/** The clip plan a Break down pass produced, and one way in per clip. */
export function ClipPlan() {
  const app = useApp()
  const { breakdown, versions, streaming, clips, rendering, extenderDefaultLoraStack, endpoint } = app
  const [loraNames, setLoraNames] = useState<string[]>([])
  const [loraErr, setLoraErr] = useState<string | null>(null)

  // Fetched once per endpoint, shared by every clip's editor — an
  // /object_info lookup, on the light_paths list, so it never forces a GPU
  // backend switch and is safe alongside a render in flight.
  useEffect(() => {
    if (!endpoint) return
    let live = true
    listLoraNames(endpoint)
      .then((names) => live && setLoraNames(names))
      .catch((e) => live && setLoraErr(String((e as Error).message || e)))
    return () => {
      live = false
    }
  }, [endpoint])

  // The operator's own machine-local override (VITE_LOCAL_LORA_STACK, from a
  // gitignored .env.local) wins when present; the public build has none, so
  // every visitor falls back to the graph's own baked stack — see
  // `localLoraStackOverride`'s module comment.
  const defaultStack = useMemo(() => {
    const local = localLoraStackOverride(import.meta.env.VITE_LOCAL_LORA_STACK)
    return local.length ? local : extenderDefaultLoraStack
  }, [extenderDefaultLoraStack])

  if (!breakdown) return null

  const latestFor = (clipIndex: number) => latestPromptForClip(versions, clipIndex)

  return (
    <div style={{ padding: '4px 26px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
        <span className="lbl">Clip plan{breakdown.spine ? ` — ${breakdown.spine}` : ''}</span>
      </div>
      {loraErr && <div className="tok" style={{ display: 'block', marginBottom: 7, color: 'var(--ox)' }}>{loraErr}</div>}
      {breakdown.clips.map((c) => {
        const ready = latestFor(c.index)
        return (
          <div className="card" key={c.index} style={{ marginBottom: 7 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
              <span className="tok">{c.index}</span>
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{c.title || `clip ${c.index}`}</span>
              <span className="tok">
                {c.role} · {c.seconds}s
              </span>
              <div style={{ flexGrow: 1 }} />
              <span className="tok" style={{ color: ready ? 'var(--grn)' : 'var(--ink3)' }}>
                {ready ? 'prompt ready' : 'no prompt yet'}
              </span>
              {ready && (
                <button
                  className="btn sm ghost"
                  onClick={() => {
                    app.selectVersion(ready.id)
                    // The composer is the one editable box — loading a plan
                    // clip's already-authored prompt into it is what makes it
                    // reviewable/editable and renderable there, same as any
                    // other scene.
                    app.setStory(ready.text)
                    app.setFilm({ role: c.role, spine: breakdown.spine, precedes: c.precedes, follows: c.follows, covers: c.covers, title: c.title, clipIndex: c.index })
                  }}
                >
                  read
                </button>
              )}
              <button
                className="btn sm"
                disabled={!!streaming}
                onClick={() => {
                  app.setFilm({
                    role: c.role,
                    spine: breakdown.spine,
                    precedes: c.precedes,
                    follows: c.follows,
                    covers: c.covers,
                    title: c.title,
                    clipIndex: c.index,
                  })
                  void app.rebuild('story')
                }}
              >
                Generate prompt
              </button>
            </div>
            {c.covers && (
              <div className="tok" style={{ marginTop: 6, lineHeight: 1.55, color: 'var(--ink2)' }}>
                {c.covers}
              </div>
            )}
            <LoraStackEditor
              label={`scene ${c.index}`}
              onChange={(stack) => app.setClipLoraStack(c.index, stack)}
              stack={c.loraStack}
              defaultStack={defaultStack}
              available={loraNames}
            />
          </div>
        )
      })}

      <ExtenderPlanSubmit />
      <GenerateRestAction />
    </div>
  )
}

/**
 * One Master Extender job for the whole plan — the studio's only multi-clip
 * render path. There is no frame accounting to disclose (no overlap tax —
 * see `lib/extender.ts`'s module comment) and no per-scene "redo" action:
 * the node itself always takes the WHOLE plan, and `run_mode` (one clip vs.
 * all pending) is the only shape choice. The cost line — clip count, total
 * seconds, how many will actually sample versus come from the box's own
 * cache — is shown before either button is pressed, per the brief.
 */
function ExtenderPlanSubmit() {
  const app = useApp()
  const { extenderPlanPreview, extenderReady, rendering, renderExtenderPlan, extenderProgress } = app
  const [busy, setBusy] = useState(false)
  if (!extenderPlanPreview) return null

  const { clips, cost, issues } = extenderPlanPreview
  const blocked = issues.length > 0 || !extenderReady || !!rendering || busy

  const submit = async (runMode: 'clip_by_clip' | 'full_batch') => {
    setBusy(true)
    try {
      await renderExtenderPlan(runMode)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Master Extender — the whole film as one job</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">
          {cost.totalSeconds.toFixed(1)}s · {cost.toSample} to sample · {cost.fromCache} from cache
        </span>
      </div>

      <div style={{ marginTop: 10 }}>
        {clips.map((c) => (
          <div key={c.index} style={{ display: 'flex', alignItems: 'baseline', gap: 9, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}>
            <span className="tok" style={{ width: 18, flex: '0 0 auto' }}>{c.index}</span>
            <span style={{ fontSize: 11.5, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title}
            </span>
            <span className="tok">{c.seconds}s</span>
            <span className="tok" style={{ color: c.validated ? 'var(--grn)' : 'var(--ink3)' }}>
              {c.validated ? 'validated · cached' : 'will sample'}
            </span>
          </div>
        ))}
      </div>

      {issues.length > 0 && (
        <div className="card err" style={{ marginTop: 12 }}>
          {issues.map((i) => (
            <div key={i} style={{ fontSize: 11.5, lineHeight: 1.6 }}>{i}</div>
          ))}
        </div>
      )}

      {rendering && extenderProgress && (
        <div className="tok" style={{ display: 'block', marginTop: 10 }}>
          clip {extenderProgress.clip}/{extenderProgress.totalClips} · {extenderProgress.cacheMode}
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
        <button className="btn pri" disabled={blocked} onClick={() => void submit('clip_by_clip')}>
          {rendering ? 'Rendering…' : 'Render the next clip'}
        </button>
        <button className="btn" disabled={blocked} onClick={() => void submit('full_batch')}>
          Render every pending clip
        </button>
      </div>
    </div>
  )
}

/**
 * "Generate the rest" (Task 2, 2026-09-16) — the autonomous tail on this
 * plan's interactive head. Only shown once there is something to run
 * unattended AND at least one scene has already landed (an operator's first
 * few scenes reviewed clean is the whole point — this is never the FIRST
 * action on a fresh plan). Wiring plus a gate over what already exists:
 * `clipsNeedingPrompt` for the authoring loop, `extenderPlanPreview` for the
 * cost shown before anything is spent (never a second estimate that can
 * drift from what `generateRest` actually submits), and `generateRest`
 * itself for the run.
 */
function GenerateRestAction() {
  const app = useApp()
  const { breakdown, versions, clips, extenderPlanPreview, streaming, rendering, generateRest } = app
  const [confirming, setConfirming] = useState(false)
  const [running, setRunning] = useState(false)
  if (!breakdown || !extenderPlanPreview) return null

  const anyLanded = clips.some((c) => c.extender?.nodeId === extenderPlanPreview.nodeId && c.state === 'done')
  if (!anyLanded) return null

  const remaining = clipsNeedingPrompt(breakdown, versions)
  if (!remaining.length) return null

  const busy = running || !!streaming || !!rendering

  const run = async () => {
    setConfirming(false)
    setRunning(true)
    try {
      await generateRest()
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Generate the rest</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">{remaining.length} clip{remaining.length === 1 ? '' : 's'} left unauthored</span>
      </div>
      {confirming ? (
        <>
          <div className="tok" style={{ marginTop: 8, lineHeight: 1.6 }}>
            Authors {remaining.length} clip{remaining.length === 1 ? '' : 's'}, then renders every pending clip of the
            {' '}{extenderPlanPreview.clips.length}-clip plan as one Master Extender job — ≈{extenderPlanPreview.cost.totalSeconds.toFixed(1)}s.
            Stoppable mid-run; whatever is already authored or rendered stays exactly as it is.
          </div>
          <div style={{ display: 'flex', gap: 9, marginTop: 10 }}>
            <button className="btn pri" onClick={() => void run()}>
              Author {remaining.length} and render everything
            </button>
            <button className="btn sm ghost" onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </>
      ) : (
        <div style={{ marginTop: 10 }}>
          <button className="btn" disabled={busy} onClick={() => setConfirming(true)}>
            {running ? 'Generating…' : 'Generate the rest'}
          </button>
        </div>
      )}
    </div>
  )
}
