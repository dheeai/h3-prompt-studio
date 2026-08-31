import { estTokens } from './tokens'
import type { Selection, Skill } from './types'

/**
 * The cached layer.
 *
 * Assembly is deterministic — skills sorted by id, files sorted within a
 * skill, byte-identical wrapper text every time. That stability is the whole
 * point: an unchanged prefix is what lets llama.cpp / Ollama reuse their KV
 * cache instead of re-reading tens of thousands of tokens of skill on every
 * turn. Anything that varies per request (the story, the instruction) must go
 * AFTER this block, never inside it.
 */

const HEADER = `# Loaded skills

The blocks below are complete, authoritative reference documents. They are the
governing spec for this task: when a block states a rule, a measured failure
mode, a required field or an exact format, follow it literally rather than
substituting general knowledge. Where two blocks conflict, the more specific
one wins. Do not summarise these documents back to the user; apply them.
`

export interface BuiltContext {
  text: string
  hash: string
  tokens: number
  parts: { skillId: string; skillName: string; rel: string; tokens: number }[]
}

async function sha256(text: string): Promise<string> {
  // crypto.subtle needs a secure context; localhost and https both qualify.
  if (!globalThis.crypto?.subtle) {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0
    return (h >>> 0).toString(16).padStart(8, '0')
  }
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

const cache = new Map<string, BuiltContext>()

export function selectionKey(selection: Selection): string {
  return Object.keys(selection)
    .filter((k) => selection[k]?.length)
    .sort()
    .map((k) => `${k}:${[...selection[k]].sort().join(',')}`)
    .join('|')
}

export async function buildContext(skills: Skill[], selection: Selection): Promise<BuiltContext> {
  const key = selectionKey(selection)
  const hit = cache.get(key)
  if (hit) return hit

  const index = new Map(skills.map((s) => [s.id, s]))
  const chunks: string[] = [HEADER]
  const parts: BuiltContext['parts'] = []

  for (const skillId of Object.keys(selection).sort()) {
    const skill = index.get(skillId)
    if (!skill) continue
    for (const rel of [...(selection[skillId] || [])].sort()) {
      const file = skill.files.find((f) => f.rel === rel)
      if (!file) continue
      chunks.push(`\n\n<skill name="${skill.name}" file="${rel}">\n${file.text.trim()}\n</skill>`)
      parts.push({ skillId: skill.id, skillName: skill.name, rel, tokens: file.tokens })
    }
  }

  const text = chunks.join('')
  const built: BuiltContext = { text, hash: await sha256(text), tokens: estTokens(text), parts }
  cache.set(key, built)
  return built
}

/** True once this exact prefix has been sent at least once this session. */
const sent = new Set<string>()
export function markSent(hash: string) {
  sent.add(hash)
}
export function wasSent(hash: string) {
  return sent.has(hash)
}
