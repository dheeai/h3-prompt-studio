import { useState } from 'react'
import { selectableStyleLoras } from '../lib/chain'
import type { LoraStackEntry } from '../lib/types'

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
 * The style-LoRA picker for ONE scene.
 *
 * Extracted from `ClipPlan` because it was only reachable through the
 * break-into-scenes path — so rendering one scene at a time, which is the
 * primary loop, had no LoRA control at all. Both hosts now mount this and
 * supply their own `onChange`: the plan writes a `BreakdownClip.loraStack`,
 * the composer writes `Session.loraStack`.
 *
 * `undefined` means "leave the bound graph's baked stack alone" and is
 * deliberately distinct from an empty array, which means "no style LoRAs".
 */
export function LoraStackEditor({
  label,
  stack,
  defaultStack,
  available,
  allowExplicit,
  onChange,
}: {
  /** What this stack belongs to, for the heading — a scene number or 'next scene'. */
  label: string
  stack: LoraStackEntry[] | undefined
  defaultStack: LoraStackEntry[]
  available: string[]
  allowExplicit: boolean
  onChange: (stack: LoraStackEntry[] | undefined) => void
}) {
  const customized = stack !== undefined
  const effective = stack ?? defaultStack
  const offered = selectableStyleLoras(available, { allowExplicit }).filter((name) => !effective.some((e) => e.lora === name))

  const mutate = (next: LoraStackEntry[]) => onChange(next)
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
          <button className="btn sm ghost" onClick={() => onChange(undefined)}>
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
