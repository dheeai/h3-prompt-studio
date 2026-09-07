import { useEffect, useMemo, useState } from 'react'
import { useApp } from '../app/state'
import { listLoraNames } from '../lib/comfy'
import { localLoraStackOverride, planNeedsPerSceneLoraSplit, readBakedLoraStack, selectableStyleLoras } from '../lib/chain'
import type { LoraStackEntry, Version } from '../lib/types'

/** Stages whose output is a prompt — the only ones that count as "ready" for a clip. */
const PROMPT_STAGES = new Set(['draft', 'revise', 'rebuild', 'freeform'])

/** Some LoRA filenames are percent-encoded (`HMBreasts%20-%20...`) — decode
 * only for DISPLAY. The value written into `stack_data` must stay whatever
 * ComfyUI reported, byte-exact, or the box will not find the file. */
function displayLoraName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

/**
 * The style-stack editor for one plan clip — add/remove a LoRA, toggle it,
 * adjust its strength. `stack` is `undefined` until this clip is customized,
 * at which point it renders on whatever the bound Contex-Loop workflow's own
 * `LTX_lora_loader.stack_data` already carries (`defaultStack`) — the
 * no-op-until-edited contract `chain.ts`'s `buildChainGraph` keeps.
 */
function LoraStackEditor({
  clipIndex,
  stack,
  defaultStack,
  available,
  allowExplicit,
}: {
  clipIndex: number
  stack: LoraStackEntry[] | undefined
  defaultStack: LoraStackEntry[]
  available: string[]
  allowExplicit: boolean
}) {
  const { setClipLoraStack } = useApp()
  const customized = stack !== undefined
  const effective = stack ?? defaultStack
  const offered = selectableStyleLoras(available, { allowExplicit }).filter((name) => !effective.some((e) => e.lora === name))

  const mutate = (next: LoraStackEntry[]) => setClipLoraStack(clipIndex, next)
  const addLora = (name: string) => {
    if (!name) return
    mutate([...effective, { lora: name, strength: 0.5, on: true }])
  }
  const removeAt = (i: number) => mutate(effective.filter((_, idx) => idx !== i))
  const toggleAt = (i: number) => mutate(effective.map((e, idx) => (idx === i ? { ...e, on: !e.on } : e)))
  const setStrengthAt = (i: number, v: number) => mutate(effective.map((e, idx) => (idx === i ? { ...e, strength: v } : e)))

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="lbl">Style LoRAs</span>
        <span className="tok">{customized ? 'customized for this clip' : 'using the workflow\'s own default'}</span>
        <div style={{ flexGrow: 1 }} />
        {customized && (
          <button className="btn sm ghost" onClick={() => setClipLoraStack(clipIndex, undefined)}>
            reset to workflow default
          </button>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7 }}>
        {effective.length === 0 && <span className="tok">no style LoRA — base model only</span>}
        {effective.map((e, i) => (
          <div key={`${e.lora}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className={`chip${e.on ? ' on' : ' off'}`} style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => toggleAt(i)}>
              {e.on ? 'on' : 'off'}
            </button>
            <span
              style={{ fontSize: 11, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={e.lora}
            >
              {displayLoraName(e.lora)}
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={e.strength}
              onChange={(ev) => setStrengthAt(i, Number(ev.target.value))}
              style={{ width: 90 }}
              aria-label={`${displayLoraName(e.lora)} strength`}
            />
            <span className="tok" style={{ width: 30, textAlign: 'right' }}>{e.strength.toFixed(2)}</span>
            <button className="btn sm ghost" onClick={() => removeAt(i)}>remove</button>
          </div>
        ))}
      </div>

      {offered.length > 0 && (
        <select
          value=""
          onChange={(ev) => addLora(ev.target.value)}
          style={{ marginTop: 7, fontSize: 11, padding: '4px 7px' }}
          aria-label="Add a style LoRA"
        >
          <option value="">＋ add a style LoRA…</option>
          {offered.map((name) => (
            <option key={name} value={name}>
              {displayLoraName(name)}
            </option>
          ))}
        </select>
      )}
      <div className="tok" style={{ marginTop: 6, lineHeight: 1.5 }}>
        Strength runs 0–1, the range the workflow's own stack already uses. Applies only at build time, per scene — see
        the render note below when clips in this plan disagree.
      </div>
    </div>
  )
}

/** The clip plan a Break down pass produced, and one way in per clip. */
export function ClipPlan() {
  const app = useApp()
  const { breakdown, versions, streaming, clips, chainPlanPreview, renderChainPlan, rendering, chainRecipe, endpoint } = app
  const [loraNames, setLoraNames] = useState<string[]>([])
  const [loraErr, setLoraErr] = useState<string | null>(null)
  const [allowExplicit, setAllowExplicit] = useState(false)

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
  // every visitor falls back to the graph's own baked stack (empty on the
  // shipped workflow) — see `localLoraStackOverride`'s module comment.
  const defaultStack = useMemo(() => {
    const local = localLoraStackOverride(import.meta.env.VITE_LOCAL_LORA_STACK)
    return local.length ? local : readBakedLoraStack(chainRecipe?.graph ?? null)
  }, [chainRecipe])

  if (!breakdown) return null

  const latestFor = (clipIndex: number): Version | undefined =>
    [...versions].reverse().find((v) => v.clipIndex === clipIndex && PROMPT_STAGES.has(v.stage))

  // Whether THIS plan clip's scene has already landed as part of the plan's
  // own chain (as opposed to some other manually-continued chain) — the
  // signal that a "redo this scene alone" resubmit is even possible.
  const renderedFor = (clipIndex: number) =>
    chainPlanPreview &&
    clips.some((c) => c.chain?.runName === chainPlanPreview.runName && c.chain.sceneIndex === clipIndex && c.state === 'done')

  return (
    <div style={{ padding: '4px 26px 0' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 7 }}>
        <span className="lbl">Clip plan{breakdown.spine ? ` — ${breakdown.spine}` : ''}</span>
        <div style={{ flexGrow: 1 }} />
        <label className="tok" style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={allowExplicit} onChange={(e) => setAllowExplicit(e.target.checked)} />
          show explicit-content LoRAs
        </label>
      </div>
      {loraErr && <div className="tok" style={{ display: 'block', marginBottom: 7, color: 'var(--ox)' }}>{loraErr}</div>}
      {breakdown.clips.map((c) => {
        const ready = latestFor(c.index)
        const landed = renderedFor(c.index)
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
              {landed && ready && (
                <button
                  className="btn sm ghost"
                  disabled={!!rendering}
                  title="Resample only this scene, resuming every other scene from its checkpoint"
                  onClick={() => void renderChainPlan(c.index)}
                >
                  Redo this scene
                </button>
              )}
            </div>
            {c.covers && (
              <div className="tok" style={{ marginTop: 6, lineHeight: 1.55, color: 'var(--ink2)' }}>
                {c.covers}
              </div>
            )}
            <LoraStackEditor
              clipIndex={c.index}
              stack={c.loraStack}
              defaultStack={defaultStack}
              available={loraNames}
              allowExplicit={allowExplicit}
            />
          </div>
        )
      })}

      <ChainPlanSubmit />
    </div>
  )
}

/**
 * One Contex-Loop chain job for the whole plan — the studio's only multi-clip
 * render path (Long Media multiclip removed 2026-09-07).
 *
 * The frame accounting is shown BEFORE the submit button on purpose — the
 * delivered length differs from what the plan asked for (the overlap tax, see
 * chain.ts / frames.ts), and that surprise is the whole point of surfacing it
 * here rather than after a long render comes back short. A per-clip "Redo
 * this scene" action (above, once a clip has landed) resamples just one
 * scene via `scene_range`, without re-sampling its neighbours.
 */
function ChainPlanSubmit() {
  const app = useApp()
  const { chainPlanPreview, rendering, renderChainPlan, breakdown } = app
  const [busy, setBusy] = useState(false)
  if (!chainPlanPreview) return null

  const { clips, totalSeconds, issues, warnings } = chainPlanPreview
  const blocked = issues.length > 0 || !!rendering || busy
  const splitting = planNeedsPerSceneLoraSplit((breakdown?.clips ?? []).map((c) => c.loraStack))

  const submitAll = async () => {
    setBusy(true)
    try {
      await renderChainPlan()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" style={{ marginTop: 4, marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
        <span className="lbl">Contex-Loop — the whole plan as one chain</span>
        <div style={{ flexGrow: 1 }} />
        <span className="tok">{totalSeconds.toFixed(3)}s delivered</span>
      </div>

      <div style={{ marginTop: 10 }}>
        {clips.map((c) => (
          <div key={c.index} style={{ display: 'flex', alignItems: 'baseline', gap: 9, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}>
            <span className="tok" style={{ width: 18, flex: '0 0 auto' }}>{c.index}</span>
            <span style={{ fontSize: 11.5, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.title}
            </span>
            <span className="tok">authored {c.authored}f</span>
            <span className="tok">rendered {c.rendered}f</span>
            <span className="tok" style={{ color: c.delivered < c.authored ? 'var(--ox)' : 'var(--ink2)' }}>
              delivered {c.delivered}f
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
      {warnings.length > 0 && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          {warnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {splitting && (
        <div className="alert warn" style={{ marginTop: 12 }}>
          Clips in this plan disagree on their style LoRAs, so a single job cannot honour all of them — one ComfyUI job
          samples every shot in it against the same style stack. This submits as {clips.length} sequential jobs instead,
          one per scene, each resuming the last from its checkpoint — still one render at a time.
        </div>
      )}

      <div style={{ display: 'flex', gap: 9, marginTop: 12 }}>
        <button className="btn pri" disabled={blocked} onClick={() => void submitAll()}>
          {rendering ? 'Rendering…' : splitting ? `Submit all ${clips.length} as ${clips.length} scene jobs` : `Submit all ${clips.length} as one chain`}
        </button>
      </div>
    </div>
  )
}
