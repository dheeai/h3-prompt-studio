import { useEffect, useRef, useState } from 'react'
import { useApp } from '../app/state'
import { classifyInput } from '../lib/lint'
import { SCENE_LENGTH_CHIPS, secondsLabel } from '../lib/chainDisplay'
import { LoraStackEditor } from './LoraStackEditor'
import { DraftingStatus } from './DraftingStatus'
import { listLoraNames } from '../lib/comfy'
import { localLoraStackOverride, readBakedLoraStack } from '../lib/chain'
import { framesForSeconds } from '../lib/recipe'

function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.max(96, el.scrollHeight)}px`
}

const EXAMPLES: { label: string; text: string }[] = [
  {
    label: 'quiet drama',
    text: 'Lira finds the last fragment in the gantry bay. She already knows what it means — the layer never closed. She doesn’t say anything about it. She just stops moving, and the cold does the rest.',
  },
  {
    label: 'product film',
    text: 'A pair of hands unboxes a small brushed-aluminium sensor, sets it on a workbench, and taps once. A row of lights wakes across it. The bench is dark; the light is the only event.',
  },
  {
    label: 'title sequence',
    text: 'Nine seconds of flat-vector motion that spells out a studio name one letter at a time, each letter arriving on a hard colour-field wipe, ending on a locked-off lockup.',
  },
]


/**
 * "3. THE COMPOSER" — the same place every time, always the next thing.
 *
 * There is no entry-mode picker: text, attachments and length live here, and
 * the ONLY genuine variable is "one scene" vs "break into scenes" — see the
 * module comment on `lib/entry.ts`. Attachments (footage to continue from,
 * reference images) are controls ON the composer, not a separate panel —
 * burying video upload in another panel was the reported bug.
 *
 * Nothing here gates rendering behind an LLM stage: "Draft it for me" is an
 * offer, and the primary button always renders whatever is currently typed
 * or pasted, whether or not that offer was ever taken.
 */
export function Composer({
  onOpenExternalVideo,
  onOpenPlates,
  onOpenCheck,
}: {
  onOpenExternalVideo: () => void
  onOpenPlates: () => void
  onOpenCheck: () => void
}) {
  const app = useApp()
  const { story, setStory, settings, patchSettings, breakIntoScenes, setBreakIntoScenes, streaming, providers, probes, clip, isFreshChainStart, externalVideo, plates, chainBlockers, rendering, gpuBusy, findings, scenesFrom, setLoraStack, chainRecipe, endpoint, loraStack } = app
  const ref = useRef<HTMLTextAreaElement>(null)
  // The box's own LoRA folder — `/object_info` is on ComfyUI's light paths, so
  // listing it never forces a GPU backend switch.
  useEffect(() => {
    if (!endpoint) return
    let live = true
    listLoraNames(endpoint).then((n) => { if (live) setLoraNames(n) }).catch(() => {})
    return () => { live = false }
  }, [endpoint])
  const [authoring, setAuthoring] = useState(false)
  const [confirmingRender, setConfirmingRender] = useState(false)
  const [loraNames, setLoraNames] = useState<string[]>([])
  const [allowExplicit, setAllowExplicit] = useState(false)

  useEffect(() => autosize(ref.current), [story])
  useEffect(() => setConfirmingRender(false), [clip?.id])
  useEffect(() => {
    let cancelled = false
    void document.fonts?.ready.then(() => {
      if (!cancelled) autosize(ref.current)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const provider = providers.find((p) => p.id === settings.providerId)
  const probe = provider ? probes[provider.id] : undefined
  const connected = probe?.state === 'ok' && !!settings.model
  const busy = !!streaming
  const targetSceneIndex = (clip?.chain?.sceneIndex ?? 0) + 1
  const isContinuation = !!clip
  const standing = classifyInput(story)
  const currentFrames = framesForSeconds(settings.seconds, 24)
  const rendering2 = !!rendering || gpuBusy === 'render'
  const renderDisabled = busy || rendering2 || chainBlockers.length > 0
  // Continuing from an EARLIER scene (not the newest) writes over scene
  // targetSceneIndex, which is append-only fatal to every scene after it —
  // the same "state the count, make it deliberate" treatment Replace gets
  // on the scenes strip. Free (no confirm) when there is nothing to lose.
  const laterDiscarded = clip ? scenesFrom(clip.id, targetSceneIndex + 1) : 0

  const draftItForMe = async () => {
    setAuthoring(true)
    try {
      if (isContinuation && clip) await app.continueFrom(clip.id, story.trim() || undefined)
      else await app.rebuild()
    } finally {
      setAuthoring(false)
    }
  }

  const makeScene = async () => {
    if (laterDiscarded > 0 && !confirmingRender) {
      setConfirmingRender(true)
      return
    }
    setConfirmingRender(false)
    await app.renderChain()
  }

  const actionableFindings = findings.filter((f) => f.severity !== 'pass').length

  return (
    <div className="composer">
      <div className="composer-head">
        <span className="serif composer-title">{isContinuation ? `Scene ${targetSceneIndex}` : 'What is the film?'}</span>
        {isContinuation && <span className="tok">continues scene {targetSceneIndex - 1}</span>}
        <div className="studio-grow" />
        <span className="tok">{connected ? '' : 'connect a model to draft — typing and rendering still work'}</span>
      </div>
      {!isContinuation && (
        <div className="composer-intro tok">An idea, a rough prompt, a finished H3 prompt, or a whole scene. It does not matter which — write or paste it here and it becomes film.</div>
      )}

      <div className="composer-box">
        <textarea
          ref={ref}
          className="composer-textarea"
          value={story}
          onChange={(e) => setStory(e.target.value)}
          placeholder={isContinuation ? 'Write what happens next, or let the studio draft it…' : 'A woman crosses an empty stone courtyard before dawn…'}
        />
        <div className="composer-footer">
          <button
            className={`chip${!isFreshChainStart ? ' off' : ''}`}
            disabled={!isFreshChainStart}
            title={isFreshChainStart ? undefined : 'Only scene 1 of a fresh chain can start from footage'}
            onClick={onOpenExternalVideo}
          >
            {externalVideo ? `continuing ${externalVideo.filename}` : 'Continue from footage'}
          </button>
          <button className="chip" onClick={onOpenPlates}>
            Reference images{plates.length > 0 ? ` ${plates.length}` : ''}
          </button>
          <div className="studio-grow" />
          <button className="btn sm ghost" onClick={onOpenCheck}>
            Check{actionableFindings > 0 ? ` · ${actionableFindings}` : ''}
          </button>
          <button className="btn sm" disabled={!connected || busy || authoring || !story.trim()} onClick={() => void draftItForMe()}>
            {authoring ? 'Drafting…' : 'Draft it for me'}
          </button>
        </div>
      </div>

      {streaming && streaming.stage !== 'breakdown' && <DraftingStatus streaming={streaming} />}
      <div className="composer-controls">
        <div>
          <div className="lbl">Make it</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className={`chip${!breakIntoScenes ? ' on' : ''}`} onClick={() => setBreakIntoScenes(false)}>One scene</button>
            <button className={`chip${breakIntoScenes ? ' on' : ''}`} onClick={() => setBreakIntoScenes(true)}>Break into scenes</button>
          </div>
          <div className="tok composer-controls-note">Break it up when the text already covers several beats. You still render them one at a time.</div>
        </div>
        <div>
          <div className="lbl">Scene length</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 340 }}>
            {SCENE_LENGTH_CHIPS.map((f) => (
              <button key={f} className={`chip${f === currentFrames ? ' on' : ''}`} style={{ fontSize: 10.5, padding: '3px 8px' }} onClick={() => patchSettings({ seconds: f / 24 })}>
                {secondsLabel(f)}
              </button>
            ))}
          </div>
          <div className="tok composer-controls-note">5.2s is the shortest H3 makes.</div>
        </div>
        <div>
          <LoraStackEditor
            label="this scene"
            stack={loraStack}
            defaultStack={localLoraStackOverride(import.meta.env?.VITE_LOCAL_LORA_STACK) .length
              ? localLoraStackOverride(import.meta.env?.VITE_LOCAL_LORA_STACK)
              : readBakedLoraStack(chainRecipe?.graph ?? null)}
            available={loraNames}
            allowExplicit={allowExplicit}
            onChange={setLoraStack}
          />
          <label className="tok composer-controls-note" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 }}>
            <input type="checkbox" checked={allowExplicit} onChange={(e) => setAllowExplicit(e.target.checked)} />
            show explicit-content LoRAs
          </label>
        </div>
        <div style={{ textAlign: 'right', marginLeft: 'auto', flex: '0 0 auto' }}>
          {confirmingRender && laterDiscarded > 0 && (
            <div className="composer-blockers" style={{ color: 'var(--ox)', maxWidth: 260, marginBottom: 8 }}>
              Writing scene {targetSceneIndex} here discards {laterDiscarded} later scene{laterDiscarded === 1 ? '' : 's'} — they no longer resume against a checkpoint that will still exist.
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            {confirmingRender && laterDiscarded > 0 && (
              <button className="btn sm ghost" onClick={() => setConfirmingRender(false)}>Cancel</button>
            )}
            <button className="btn pri composer-primary" disabled={renderDisabled || !story.trim()} onClick={() => void makeScene()}>
              {rendering2
                ? `Rendering scene ${targetSceneIndex}…`
                : confirmingRender && laterDiscarded > 0
                  ? `Discard ${laterDiscarded} and make scene ${targetSceneIndex}`
                  : `Make scene ${targetSceneIndex}`}
            </button>
          </div>
          {chainBlockers.length > 0 && (
            <div className="composer-blockers">
              {chainBlockers.map((b) => <div key={b} className="tok">{b}</div>)}
            </div>
          )}
        </div>
      </div>

      {story.trim() && (
        <div className="composer-standing">
          <span className="studio-kicker">STANDING</span>
          <strong>{standing.kind}</strong>
          <span className="tok">{standing.stands}</span>
        </div>
      )}
      {!story && (
        <div className="composer-examples">
          <span className="tok">try</span>
          {EXAMPLES.map((ex) => (
            <button key={ex.label} className="btn sm ghost" onClick={() => setStory(ex.text)}>{ex.label}</button>
          ))}
        </div>
      )}
    </div>
  )
}
