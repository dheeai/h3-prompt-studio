import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `public/` is served as-is by GitHub Pages on this PUBLIC repo
 * (`https://dheeai.github.io/h3-prompt-studio/`) — anything tracked can end
 * up in front of a visitor. This guard exists so the real 5090 Tailscale
 * hostname (swept out of every tracked file 2026-09-07) cannot silently
 * come back in a future commit.
 *
 * Split into a fragment + template so this guard's OWN source is never a
 * contiguous match for the pattern it searches for.
 */
const REAL_TAILNET_FRAGMENT = 'tail3cca41'
const REAL_HOSTNAME = `5090.${REAL_TAILNET_FRAGMENT}.ts.net`

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..')
const SELF_PATH = relative(REPO_ROOT, fileURLToPath(import.meta.url)).split('\\').join('/')

function grepTrackedFiles(needle: string): string[] {
  try {
    const out = execFileSync('git', ['grep', '--fixed-strings', '--name-only', needle], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
    return out.split('\n').filter(Boolean)
  } catch (err) {
    // git grep exits 1 (not an error) when nothing matches.
    const status = (err as { status?: number }).status
    if (status === 1) return []
    throw err
  }
}

test('no tracked file leaks the real 5090 Tailscale hostname — public/ is served to every visitor', () => {
  const hits = grepTrackedFiles(REAL_HOSTNAME).filter((f) => f !== SELF_PATH)
  assert.deepStrictEqual(hits, [], `these tracked files still leak the real gateway hostname: ${hits.join(', ')}`)
})
