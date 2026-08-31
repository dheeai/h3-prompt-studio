import { useRef, useState } from 'react'
import { useApp } from '../app/state'
import { WorkflowError, makeRecipe, parseWorkflow, recipeIssues } from '../lib/recipe'
import type { Binding, BindingSlot, Recipe } from '../lib/types'

const SLOTS: Array<{ slot: BindingSlot; label: string; why: string }> = [
  { slot: 'prompt', label: 'Prompt', why: 'where your written prompt is placed' },
  { slot: 'length', label: 'Length', why: 'frames, snapped to H3’s grid' },
  { slot: 'width', label: 'Width', why: '' },
  { slot: 'height', label: 'Height', why: '' },
  { slot: 'seed', label: 'Seed', why: 'held constant down a film' },
  { slot: 'steps', label: 'Steps', why: 'left alone unless you override it' },
  { slot: 'output', label: 'Output', why: 'the node that saves the file' },
]

function BindingRow({ recipe, slot, label, why }: { recipe: Recipe; slot: BindingSlot; label: string; why: string }) {
  const { addRecipe } = useApp()
  const b = recipe.bindings[slot]
  const choices = recipe.ambiguous[slot]

  const pick = (c: Binding) => {
    const next = { ...recipe, bindings: { ...recipe.bindings, [slot]: c }, ambiguous: { ...recipe.ambiguous } }
    delete next.ambiguous[slot]
    void addRecipe(next)
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '9px 14px',
        borderBottom: '1px solid var(--rule)',
        background: choices ? 'var(--amb-soft)' : undefined,
      }}
    >
      <span style={{ width: 74, fontSize: 11.5, fontWeight: 500, flex: '0 0 auto' }}>{label}</span>
      <span className="tok" style={{ flexGrow: 1, minWidth: 0 }}>
        {b ? `${b.node} · ${b.classType}${b.field ? ` · ${b.field}` : ''}` : <span style={{ color: 'var(--ink3)' }}>{why || 'not found'}</span>}
      </span>
      {choices ? (
        <span style={{ display: 'flex', gap: 5 }}>
          {choices.map((c) => (
            <button key={`${c.node}:${c.field}`} className="chip" style={{ padding: '2px 8px', fontSize: 10 }} onClick={() => pick(c)}>
              {c.node} · {c.field}
            </button>
          ))}
        </span>
      ) : (
        <span className="tok" style={{ color: b ? 'var(--grn)' : 'var(--ink3)', width: 62, textAlign: 'right' }}>
          {b ? 'bound' : '—'}
        </span>
      )}
    </div>
  )
}

export function RecipePanel({ onClose }: { onClose: () => void }) {
  const { recipes, recipe, addRecipe, deleteRecipe, settings, patchSettings } = useApp()
  const fileRef = useRef<HTMLInputElement>(null)
  const [err, setErr] = useState<string | null>(null)

  async function take(files: FileList | null) {
    const f = files?.[0]
    if (!f) return
    setErr(null)
    try {
      const graph = parseWorkflow(await f.text())
      await addRecipe(makeRecipe(f.name.replace(/\.json$/i, ''), graph))
    } catch (e) {
      setErr(e instanceof WorkflowError ? e.message : String((e as Error).message || e))
    }
  }

  const issues = recipeIssues(recipe)
  const nodeCount = recipe ? Object.keys(recipe.graph).length : 0
  const boundNodes = recipe ? new Set(Object.values(recipe.bindings).map((b) => b?.node)).size : 0

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 800 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <div className="serif" style={{ fontSize: 19 }}>Recipe</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink3)', marginTop: 3 }}>
              A workflow of yours, and what each part of it is for.
            </div>
          </div>
          <div style={{ flexGrow: 1 }} />
          {recipe && <span className="tok">{nodeCount} nodes</span>}
        </div>

        <div className="modal-body">
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              void take(e.dataTransfer.files)
            }}
            onClick={() => fileRef.current?.click()}
            style={{ border: '1px dashed var(--rule2)', background: 'var(--panel)', padding: '15px 18px', cursor: 'pointer' }}
          >
            <div style={{ fontSize: 12.5, color: 'var(--ink2)' }}>
              Drop a ComfyUI workflow — <strong>saved in API format</strong>.
            </div>
            <div className="tok" style={{ marginTop: 3 }}>
              The UI export won’t run. In ComfyUI: Workflow ▸ Export (API).
            </div>
          </div>
          <input ref={fileRef} type="file" accept="application/json,.json" style={{ display: 'none' }} onChange={(e) => void take(e.target.files)} />

          {err && <div className="card err" style={{ marginTop: 12 }}>{err}</div>}

          {recipes.length > 1 && (
            <div style={{ display: 'flex', gap: 7, marginTop: 14, flexWrap: 'wrap' }}>
              {recipes.map((r) => (
                <button
                  key={r.id}
                  className={`chip${r.id === recipe?.id ? ' on' : ''}`}
                  onClick={() => patchSettings({ recipeId: r.id })}
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}

          {recipe && (
            <>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '20px 0 4px' }}>
                <span className="lbl">What it found</span>
                <span className="tok" style={{ color: 'var(--grn)' }}>
                  {Object.values(recipe.bindings).filter(Boolean).length} of {SLOTS.length} bound
                </span>
              </div>
              <div className="tok" style={{ display: 'block', marginBottom: 12, lineHeight: 1.6 }}>
                Matched on node type, not node number — so the turbo, 8-step and other variants of this graph all bind
                without touching anything.
              </div>

              <div style={{ border: '1px solid var(--rule)', borderBottom: 'none' }}>
                {SLOTS.map((s) => (
                  <BindingRow key={s.slot} recipe={recipe} {...s} />
                ))}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 14px', borderBottom: '1px solid var(--rule)' }}>
                  <span style={{ width: 74, fontSize: 11.5, fontWeight: 500, flex: '0 0 auto' }}>Plates</span>
                  <span className="tok" style={{ flexGrow: 1 }}>
                    {recipe.refHost ? `${recipe.refHost} · ref_images.ref_image_N` : 'no reference input found'}
                  </span>
                  <span className="tok" style={{ color: recipe.refHost ? 'var(--grn)' : 'var(--ox)', width: 62, textAlign: 'right' }}>
                    {recipe.refHost ? 'bound' : 'missing'}
                  </span>
                </div>
              </div>

              {issues.length > 0 && (
                <div className="card err" style={{ marginTop: 14 }}>
                  {issues.map((i) => (
                    <div key={i} style={{ fontSize: 11.5, lineHeight: 1.6 }}>{i}</div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, margin: '22px 0 8px' }}>
                <span className="lbl">Left alone</span>
                <span className="tok">{Math.max(0, nodeCount - boundNodes)} nodes</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink2)', lineHeight: 1.65, maxWidth: 640 }}>
                Only the slots above are written. Everything else — loaders, LoRA stack, attention, sigma shift, sampler,
                VAE — goes back to your box exactly as it arrived, so the recipe stays the thing you tuned in ComfyUI.
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 20, paddingTop: 15, borderTop: '1px solid var(--rule)' }}>
                <span className="lbl" style={{ width: 74 }}>Length</span>
                <input
                  type="number"
                  step="0.1"
                  min="1"
                  max="15"
                  value={settings.seconds}
                  onChange={(e) => patchSettings({ seconds: Number(e.target.value) })}
                  style={{ width: 80 }}
                />
                <span className="tok">seconds — snapped to the 17k+5 grid at render time</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                <span className="lbl" style={{ width: 74 }}>Seed</span>
                <input
                  type="number"
                  value={settings.seed}
                  onChange={(e) => patchSettings({ seed: Number(e.target.value) })}
                  style={{ width: 110 }}
                  disabled={!settings.lockSeed}
                />
                <button className={`chip${settings.lockSeed ? ' on' : ''}`} onClick={() => patchSettings({ lockSeed: !settings.lockSeed })}>
                  {settings.lockSeed ? 'locked down the film' : 'random each clip'}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                <span className="lbl" style={{ width: 74 }}>Steps</span>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={settings.steps ?? ''}
                  placeholder="the recipe’s own"
                  onChange={(e) => patchSettings({ steps: e.target.value ? Number(e.target.value) : undefined })}
                  style={{ width: 110 }}
                />
                <span className="tok">override only if you mean to — too few costs detail and dialogue clarity</span>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          {recipe && (
            <button className="btn ghost" onClick={() => void deleteRecipe(recipe.id)}>
              Remove this recipe
            </button>
          )}
          <div style={{ flexGrow: 1 }} />
          <button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}
