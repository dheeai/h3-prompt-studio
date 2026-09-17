import { useApp } from '../app/state'
import {
  EXTENDER_PDD_STEPS,
  EXTENDER_QUALITY_TIERS,
  extenderEngineChoiceFromInputs,
  extenderEngineOverride,
  extenderQualityOverride,
  extenderQualityTierFromInputs,
  isExtenderFieldFrozen,
  turboLoraStepCount,
  withExtenderOverrides,
} from '../lib/extenderSettings'
import type { ExtenderEngineChoice, ExtenderQualityTier } from '../lib/extenderSettings'
import { framesForSeconds, oomRisk } from '../lib/geometry'

/**
 * The Master Extender's own settings, reduced to the two decisions the
 * founder actually wants exposed — engine+steps and quality
 * (2026-09-17 rewrite; see the brief this replaced the 28-field editor
 * against). Every other one of the node's 28 signature fields stays at the
 * shipped graph's own baked value: not editable here, but not hidden either
 * — the read-only disclosure at the bottom shows the whole configuration so
 * an operator can see it without being invited to break it.
 *
 * Both controls only ever write through `buildExtenderGraph`'s existing
 * `overrides` argument (via `Settings.extenderOverrides`), and every field
 * either one touches is one of `EXTENDER_SIGNATURE_FIELDS` — the panel warns
 * when clips are already validated, the existing guard in `extender.ts`
 * refuses the actual submit. Nothing here duplicates that guard's logic.
 */

const bakedString = (v: unknown): string => (v == null ? '' : String(v))

function EngineControl({
  baked,
  effective,
  turboLoras,
  onChange,
}: {
  baked: Record<string, unknown>
  effective: Record<string, unknown>
  turboLoras: string[]
  onChange: (choice: ExtenderEngineChoice) => void
}) {
  const choice = extenderEngineChoiceFromInputs(effective)
  const bakedNfe = bakedString(baked.pdd_nfe) || '8'

  // The live list (from `/object_info`) is the source of truth; the graph's
  // own currently-baked file is folded in too so the picker is never empty
  // before that fetch lands, and never drops the shipped default off the
  // list if it were ever removed from the live one.
  const bakedLora = bakedString(baked.turbo_lora)
  const loraOptions = Array.from(new Set([...(bakedLora && bakedLora !== 'none' ? [bakedLora] : []), ...turboLoras.filter((f) => f !== 'none')]))

  return (
    <div>
      <div className="lbl" style={{ marginBottom: 4 }}>Engine + steps</div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="radio"
            name="engine-mode"
            checked={choice?.mode === 'pdd'}
            onChange={() => onChange({ mode: 'pdd', steps: (EXTENDER_PDD_STEPS as readonly string[]).includes(bakedNfe) ? (bakedNfe as (typeof EXTENDER_PDD_STEPS)[number]) : '8' })}
          />
          PDD 8-step
        </label>
        {choice?.mode === 'pdd' && (
          <div style={{ display: 'flex', gap: 8 }}>
            {EXTENDER_PDD_STEPS.map((s) => (
              <label key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                <input type="radio" name="pdd-steps" checked={choice.steps === s} onChange={() => onChange({ mode: 'pdd', steps: s })} />
                {s}
              </label>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="radio"
            name="engine-mode"
            checked={choice?.mode === 'turbo'}
            onChange={() => onChange({ mode: 'turbo', lora: loraOptions[0] ?? bakedLora ?? 'none' })}
          />
          Turbo LoRA
        </label>
        {choice?.mode === 'turbo' && (
          <>
            <select value={choice.lora} onChange={(e) => onChange({ mode: 'turbo', lora: e.target.value })} style={{ maxWidth: 380 }}>
              {loraOptions.length === 0 && <option value={choice.lora}>{choice.lora}</option>}
              {loraOptions.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <span className="tok">
              {turboLoraStepCount(choice.lora) ? `${turboLoraStepCount(choice.lora)} steps — read from the filename` : `steps: ${bakedString(effective.pdd_nfe)} (filename doesn't say — using the baked step count)`}
            </span>
          </>
        )}
      </div>
      <div className="tok" style={{ display: 'block', marginTop: 6, lineHeight: 1.5 }}>
        A turbo LoRA's own step count and <code>pdd_nfe</code> are set together, never separately — the node has no
        cross-check of its own (<code>pdd_pure_engine.py</code>: turbo mode sends <code>pdd_nfe</code> straight to the
        sampler as the step count), so picking the LoRA IS picking the steps. PDD mode only offers 4/6/8: the engine
        itself clamps any other value to 8 and logs a warning, so those are the only three that actually run.
      </div>
    </div>
  )
}

function QualityControl({
  tier,
  onChange,
  seconds,
}: {
  tier: ExtenderQualityTier | null
  onChange: (tier: ExtenderQualityTier) => void
  seconds: number
}) {
  const frames = framesForSeconds(seconds, 24)
  return (
    <div>
      <div className="lbl" style={{ marginBottom: 4 }}>Quality</div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {EXTENDER_QUALITY_TIERS.map((t) => {
          const risky = oomRisk(t.pass2Width, t.pass2Height, frames)
          return (
            <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="radio" name="quality-tier" checked={tier?.id === t.id} onChange={() => onChange(t)} />
              {t.label}
              {risky && <span style={{ color: 'var(--ox)' }} title="OOM risk at the current clip length">⚠</span>}
            </label>
          )
        })}
        {!tier && <span className="tok">custom (not one of these three — pick one to replace it)</span>}
      </div>
      {tier && (
        <div className="tok" style={{ display: 'block', marginTop: 6 }}>
          pass 1 <code>{tier.pass1Resolution}</code> → pass 2 <code>{tier.pass2Resolution}</code>
        </div>
      )}
      {tier && oomRisk(tier.pass2Width, tier.pass2Height, frames) && (
        <div className="alert warn" style={{ marginTop: 8 }}>
          This geometry at the current clip length ({seconds}s) has been measured to OOM the box past ~362 frames.
          An OOM takes ComfyUI down and leaves no trace — a crashed render looks identical to one that was never
          submitted. Trade resolution for length, or accept the risk.
        </div>
      )}
    </div>
  )
}

/** One baked, non-editable field — value only, no control. Every field this
 * disclosure lists happens to be one of the 28 signature fields, but the
 * badge is computed from `isExtenderFieldFrozen` rather than assumed, so a
 * field ever added here that ISN'T one still reads correctly as "free". */
function BakedRow({ field, label, value }: { field: string; label: string; value: unknown }) {
  const frozen = isExtenderFieldFrozen(field)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', borderBottom: '1px solid var(--rule)' }}>
      <span style={{ width: 200, fontSize: 11.5, flex: '0 0 auto' }}>{label}</span>
      <span className="tok" style={{ width: 54, flex: '0 0 auto', color: frozen ? 'var(--ox)' : 'var(--grn)' }}>{frozen ? 'frozen' : 'free'}</span>
      <span style={{ fontSize: 12, fontFamily: 'var(--mono, monospace)' }}>{value == null ? '—' : String(value)}</span>
    </div>
  )
}

/** Every one of the 28 signature fields NOT covered by the two controls
 * above — grouped the same way the old full editor was, but read-only:
 * this is disclosure, not a second way to edit them. */
const BAKED_GROUPS: Array<{ label: string; fields: Array<{ field: string; label: string }> }> = [
  {
    label: 'Pass 2 refine',
    fields: [
      { field: 'pass2_denoise', label: 'Pass 2 denoise' },
      { field: 'pass2_steps', label: 'Pass 2 steps (tail length)' },
    ],
  },
  {
    label: 'Context & continuity',
    fields: [
      { field: 'context_length', label: 'Context length' },
      { field: 'audio_context_length', label: 'Audio context length' },
      { field: 'identity_continuity', label: 'Identity continuity' },
    ],
  },
  {
    label: 'Sparse attention (SLA)',
    fields: [
      { field: 'sla_enabled', label: 'SLA enabled' },
      { field: 'sla_sparsity', label: 'SLA sparsity' },
      { field: 'sparse_method', label: 'Sparse method' },
      { field: 'sparse_tau', label: 'Sparse tau' },
    ],
  },
  {
    label: 'Chunking',
    fields: [
      { field: 'pass2_chunk_frames', label: 'Pass 2 chunk frames' },
      { field: 'pass2_chunk_overlap', label: 'Pass 2 chunk overlap' },
    ],
  },
  {
    label: 'Turbo LoRA (baked strength/sampler)',
    fields: [
      { field: 'turbo_lora_strength', label: 'Turbo LoRA strength' },
      { field: 'turbo_sampler', label: 'Turbo sampler' },
      { field: 'turbo_scheduler', label: 'Turbo scheduler' },
    ],
  },
  {
    label: 'Pass-2 LoRA',
    fields: [
      { field: 'pass2_lora', label: 'Pass 2 LoRA' },
      { field: 'pass2_lora_strength', label: 'Pass 2 LoRA strength' },
      { field: 'pass2_lora_mode', label: 'Pass 2 LoRA mode' },
    ],
  },
  {
    label: 'Semantic bridge',
    fields: [
      { field: 'semantic_bridge', label: 'Semantic bridge' },
      { field: 'semantic_bridge_alpha', label: 'Semantic bridge alpha' },
      { field: 'semantic_bridge_match', label: 'Semantic bridge match' },
    ],
  },
  {
    label: 'Detail pass',
    fields: [
      { field: 'pdd_file', label: 'PDD file' },
      { field: 'upscaler_model', label: 'Upscaler model' },
    ],
  },
]

export function ExtenderSettingsPanel({ onClose }: { onClose: () => void }) {
  const { extenderMasterDefaults, extenderNodeSchema, extenderReady, settings, patchSettings, extenderFilm } = useApp()

  const overrides = settings.extenderOverrides ?? {}
  const overrideCount = Object.keys(overrides).length
  const validatedCount = extenderFilm?.scenes.filter((s) => s.clip.state === 'done').length ?? 0

  const effective = extenderMasterDefaults ? { ...extenderMasterDefaults, ...overrides } : null
  const engineChoice = extenderEngineChoiceFromInputs(effective)
  const qualityTier = extenderQualityTierFromInputs(effective)

  const setEngine = (choice: ExtenderEngineChoice) => {
    if (!extenderMasterDefaults) return
    const bakedNfe = bakedString(extenderMasterDefaults.pdd_nfe) || '8'
    patchSettings({
      extenderOverrides: withExtenderOverrides(settings.extenderOverrides, extenderMasterDefaults, extenderEngineOverride(choice, bakedNfe)),
    })
  }

  const setQuality = (tier: ExtenderQualityTier) => {
    if (!extenderMasterDefaults) return
    patchSettings({
      extenderOverrides: withExtenderOverrides(settings.extenderOverrides, extenderMasterDefaults, extenderQualityOverride(tier)),
    })
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 820, height: '86%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Render settings</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              Two decisions: engine + steps, and quality. Everything else stays at the shipped graph's own value.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          {overrideCount > 0 && (
            <button className="btn sm ghost" onClick={() => patchSettings({ extenderOverrides: undefined })}>
              Reset all to shipped defaults
            </button>
          )}
          <button className="btn ghost" onClick={onClose}>Close</button>
        </div>

        <div className="modal-body">
          {!extenderReady || !extenderMasterDefaults || !effective ? (
            <div className="card err">
              The Master Extender workflow has not loaded — check public/workflows/minimax_h3_master_extender_api.json.
            </div>
          ) : (
            <>
              <div className="tok" style={{ display: 'block', lineHeight: 1.6, marginBottom: 10 }}>
                Both controls below touch fields the node itself hashes — the first submit after any clip in a film
                is validated that moves one is refused, naming what changed and how many clips it would cost, unless
                you explicitly accept the reset.
              </div>

              {validatedCount > 0 && (
                <div className="alert warn" style={{ marginBottom: 12 }}>
                  {validatedCount} clip{validatedCount === 1 ? '' : 's'} validated in the current film — changing
                  either control below will be refused at submit time until you accept discarding{' '}
                  {validatedCount === 1 ? 'it' : 'them'}.
                </div>
              )}

              <div style={{ marginBottom: 20 }}>
                <EngineControl
                  baked={extenderMasterDefaults}
                  effective={effective}
                  turboLoras={extenderNodeSchema?.turboLoras ?? []}
                  onChange={setEngine}
                />
              </div>

              <div style={{ marginBottom: 20 }}>
                <QualityControl tier={qualityTier} onChange={setQuality} seconds={settings.seconds} />
              </div>

              <div style={{ marginTop: 4 }}>
                <div className="lbl" style={{ marginBottom: 4 }}>Everything else — fixed at the shipped value</div>
                {BAKED_GROUPS.map((group) => (
                  <div key={group.label} style={{ marginBottom: 14 }}>
                    <div className="tok" style={{ marginBottom: 2, display: 'block' }}>{group.label}</div>
                    {group.fields.map((spec) => (
                      <BakedRow key={spec.field} field={spec.field} label={spec.label} value={extenderMasterDefaults[spec.field]} />
                    ))}
                  </div>
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0' }}>
                  <span style={{ width: 200, fontSize: 11.5, flex: '0 0 auto' }}>refs_json</span>
                  <span className="tok" style={{ width: 54, flex: '0 0 auto', color: 'var(--ox)' }}>frozen</span>
                  <span className="tok">set from the Plates panel — swapping a plate re-freezes the film the same way either control above does</span>
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <span className="tok">
            {overrideCount === 0 ? 'Nothing customized — every field renders at the shipped graph\'s own value.' : `${overrideCount} field${overrideCount === 1 ? '' : 's'} customized.`}
          </span>
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
