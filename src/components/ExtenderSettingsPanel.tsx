import { useApp } from '../app/state'
import { isExtenderFieldFrozen, withExtenderOverride } from '../lib/extenderSettings'

/**
 * The Master Extender's own settings, exposed — never a second graph to pick
 * (the shipped workflow stays the one and only fixed graph), just its
 * existing `overrides` argument (`buildExtenderGraph`'s own mechanism,
 * `extender.ts:346`) given a face. Every value shown here is seeded from the
 * shipped graph's own baked input (`extenderMasterDefaults`, read fresh off
 * the loaded graph) — never a hardcoded duplicate — so a swapped graph on
 * disk is what the panel follows.
 *
 * Grouped by what an operator is actually deciding, not the node's own
 * arbitrary widget order: resolution/steps/denoise first (the brief's own
 * words for what should be visible), then continuity, sparse attention,
 * chunking, acceleration, the pass-2 LoRA, the semantic bridge, and the
 * detail pass. `refs_json` — also one of the 28 hashed fields — is shown
 * read-only: it is never typed here, it is BUILT from the Plates panel, so
 * giving it an edit control here would be a second, competing way to set the
 * same value.
 */

interface FieldSpec {
  field: string
  label: string
}

const GROUPS: Array<{ label: string; fields: FieldSpec[] }> = [
  {
    label: 'Resolution, steps, denoise',
    fields: [
      { field: 'pass1_resolution', label: 'Pass 1 resolution' },
      { field: 'pass2_resolution', label: 'Pass 2 resolution' },
      { field: 'pass2_steps', label: 'Pass 2 steps' },
      { field: 'pass2_denoise', label: 'Pass 2 denoise' },
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
    label: 'Acceleration',
    fields: [
      { field: 'accel_mode', label: 'Acceleration mode' },
      { field: 'turbo_lora', label: 'Turbo LoRA' },
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
      { field: 'pdd_nfe', label: 'PDD NFE' },
      { field: 'pdd_file', label: 'PDD file' },
      { field: 'upscaler_model', label: 'Upscaler model' },
    ],
  },
]

/** One field's control — its INPUT KIND is decided by the type of the
 * graph's own baked value (boolean → checkbox, number → number input,
 * anything else → text), never guessed or hardcoded per field name. This is
 * what lets all 27 editable fields share one control instead of 27 bespoke
 * widgets, and it is honest about what we actually know: the node's true
 * combo enumerations (e.g. which strings `accel_mode` accepts) live in
 * ComfyUI's `/object_info`, not in this repo, so a free-form control that
 * preserves the baked value's own JS type is the offer that cannot silently
 * send the wrong shape. */
function FieldRow({
  spec,
  baked,
  override,
  onChange,
}: {
  spec: FieldSpec
  baked: unknown
  override: unknown
  onChange: (value: unknown) => void
}) {
  const frozen = isExtenderFieldFrozen(spec.field)
  const current = override !== undefined ? override : baked
  const overridden = override !== undefined
  const kind = typeof baked

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--rule)' }}>
      <span style={{ width: 176, fontSize: 11.5, flex: '0 0 auto' }}>{spec.label}</span>
      <span
        className="tok"
        title={frozen ? 'Frozen once any clip in this film is validated — changing it then re-renders the whole film.' : 'Safe to change mid-film.'}
        style={{ width: 54, flex: '0 0 auto', color: frozen ? 'var(--ox)' : 'var(--grn)' }}
      >
        {frozen ? 'frozen' : 'free'}
      </span>

      {kind === 'boolean' ? (
        <input type="checkbox" checked={current === true} onChange={(e) => onChange(e.target.checked)} />
      ) : kind === 'number' ? (
        <input
          type="number"
          value={current == null ? '' : Number(current)}
          onChange={(e) => onChange(e.target.value === '' ? baked : Number(e.target.value))}
          style={{ width: 120 }}
        />
      ) : (
        <input
          type="text"
          value={current == null ? '' : String(current)}
          onChange={(e) => onChange(e.target.value)}
          style={{ flexGrow: 1, minWidth: 0 }}
        />
      )}

      <div style={{ flexGrow: 1 }} />
      {overridden && (
        <button className="btn sm ghost" onClick={() => onChange(baked)}>
          reset
        </button>
      )}
    </div>
  )
}

export function ExtenderSettingsPanel({ onClose }: { onClose: () => void }) {
  const { extenderMasterDefaults, extenderReady, settings, patchSettings, extenderFilm } = useApp()

  const overrides = settings.extenderOverrides ?? {}
  const overrideCount = Object.keys(overrides).length
  const validatedCount = extenderFilm?.scenes.filter((s) => s.clip.state === 'done').length ?? 0

  const setField = (field: string, value: unknown) => {
    patchSettings({ extenderOverrides: withExtenderOverride(settings.extenderOverrides, extenderMasterDefaults, field, value) })
  }

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 820, height: '86%' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Render settings</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              The shipped Master Extender graph's own configuration — the graph itself stays fixed; these are overrides onto it.
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
          {!extenderReady || !extenderMasterDefaults ? (
            <div className="card err">
              The Master Extender workflow has not loaded — check public/workflows/minimax_h3_master_extender_api.json.
            </div>
          ) : (
            <>
              <div className="tok" style={{ display: 'block', lineHeight: 1.6, marginBottom: 10 }}>
                <span style={{ color: 'var(--ox)' }}>frozen</span> fields are hashed by the node itself — the first submit
                after any clip in a film is validated that moves one is refused, naming what changed and how many clips it
                would cost, unless you explicitly accept the reset. <span style={{ color: 'var(--grn)' }}>free</span> fields
                can change on the very next scene. <code>refs_json</code> is also frozen but is never edited here — it comes
                from the Plates panel.
              </div>

              {validatedCount > 0 && (
                <div className="alert warn" style={{ marginBottom: 12 }}>
                  {validatedCount} clip{validatedCount === 1 ? '' : 's'} validated in the current film — changing a frozen
                  field below will be refused at submit time until you accept discarding {validatedCount === 1 ? 'it' : 'them'}.
                </div>
              )}

              {GROUPS.map((group) => (
                <div key={group.label} style={{ marginBottom: 18 }}>
                  <div className="lbl" style={{ marginBottom: 4 }}>{group.label}</div>
                  {group.fields.map((spec) => (
                    <FieldRow
                      key={spec.field}
                      spec={spec}
                      baked={extenderMasterDefaults[spec.field]}
                      override={overrides[spec.field]}
                      onChange={(v) => setField(spec.field, v)}
                    />
                  ))}
                </div>
              ))}

              <div style={{ marginTop: 4 }}>
                <div className="lbl" style={{ marginBottom: 4 }}>References</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
                  <span style={{ width: 176, fontSize: 11.5, flex: '0 0 auto' }}>refs_json</span>
                  <span className="tok" style={{ width: 54, flex: '0 0 auto', color: 'var(--ox)' }}>frozen</span>
                  <span className="tok">set from the Plates panel — swapping a plate re-freezes the film the same way any field above does</span>
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
