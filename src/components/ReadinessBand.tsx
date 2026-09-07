import { useApp } from '../app/state'
import { CHAIN_MIN_STEPS } from '../lib/chain'
import { framesForSeconds } from '../lib/recipe'

/**
 * "Is this session ready to render" said BEFORE any work is invested, not
 * discovered after a prompt is written — the readiness band `Main.dc.html`
 * and `Start.dc.html` both put across the top of the page.
 *
 * Green mirrors `chainBlockers` (what actually gates the studio's one render
 * action, `renderChain`) so this can never say "ready" while that button is
 * still disabled. A risky geometry+length combination (`oomRisk`, surfaced
 * here via `warnings`) does not block — it is stated up front instead, which
 * is the whole point of putting it here rather than after a crash.
 */
export function ReadinessBand({ onOpenEndpoint, onOpenRecipe }: { onOpenEndpoint: () => void; onOpenRecipe: () => void }) {
  const { chainRecipe, endpoint, comfyProbes, chainBlockers, warnings, settings } = useApp()
  const endpointOk = !!endpoint && comfyProbes[endpoint.id]?.state === 'ok'
  const ready = chainBlockers.length === 0
  const width = settings.width ?? chainRecipe?.defaults.width
  const height = settings.height ?? chainRecipe?.defaults.height
  const steps = settings.steps ?? CHAIN_MIN_STEPS
  const frames = framesForSeconds(settings.seconds, 24)

  return (
    <div className={`readiness-band ${ready ? (warnings.length ? 'ready warn' : 'ready') : 'blocked'}`} role="status">
      <span className={`dot ${ready ? 'ok' : 'warn'}`} />
      {ready ? (
        <>
          <span className="readiness-headline">Everything needed is in place</span>
          <span className="tok readiness-detail">
            {chainRecipe ? `${chainRecipe.name} loaded` : 'no chain workflow loaded'} · {endpoint ? `${endpoint.label} reachable` : 'no endpoint'}
            {width && height ? ` · ${width}×${height}` : ''} · {steps} steps · {frames}f
          </span>
        </>
      ) : (
        <>
          <span className="readiness-headline">Not ready to render yet</span>
          <span className="readiness-blockers">
            {chainBlockers.map((b) => (
              <span key={b} className="tok">{b}</span>
            ))}
          </span>
        </>
      )}
      {ready && warnings.length > 0 && (
        <span className="readiness-blockers">
          {warnings.map((w) => (
            <span key={w} className="tok">{w}</span>
          ))}
        </span>
      )}
      <div className="studio-grow" />
      <button className="readiness-change" onClick={endpointOk ? onOpenRecipe : onOpenEndpoint}>change</button>
    </div>
  )
}
