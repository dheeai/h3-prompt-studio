import { unzipSync, strFromU8 } from 'fflate'
import { idb } from './db'
import { estTokens } from './tokens'
import type { Skill, SkillFile, SkillSource } from './types'

const TEXT_EXT = /\.(md|markdown|txt)$/i

/** Parse the `name:` / `description:` keys out of YAML frontmatter, if present. */
function frontmatter(text: string): { name?: string; description?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const out: { name?: string; description?: string } = {}
  // Only the two scalar keys we care about; folded/multi-line values are
  // joined so a long description survives a line wrap.
  const lines = m[1].split(/\r?\n/)
  let key: 'name' | 'description' | null = null
  let buf: string[] = []
  const flush = () => {
    if (key && buf.length) out[key] = buf.join(' ').trim().replace(/^["']|["']$/g, '')
    buf = []
  }
  for (const line of lines) {
    const kv = line.match(/^(name|description)\s*:\s*(.*)$/)
    if (kv) {
      flush()
      key = kv[1] as 'name' | 'description'
      buf = kv[2] ? [kv[2]] : []
    } else if (key && /^\s+\S/.test(line)) {
      buf.push(line.trim())
    } else if (/^\S/.test(line)) {
      flush()
      key = null
    }
  }
  flush()
  return out
}

function firstHeading(text: string): string | null {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
  const m = body.match(/^#\s+(.+)$/m)
  return m ? m[1].trim() : null
}

function mkFile(rel: string, text: string): SkillFile {
  return { rel, text, tokens: estTokens(text) }
}

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/\.(md|markdown|txt)$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

/** Sort so SKILL.md leads and the references follow in a stable order. */
function orderFiles(files: SkillFile[]): SkillFile[] {
  return [...files].sort((a, b) => {
    const ap = /^SKILL\.md$/i.test(a.rel) ? 0 : 1
    const bp = /^SKILL\.md$/i.test(b.rel) ? 0 : 1
    return ap - bp || a.rel.localeCompare(b.rel)
  })
}

function buildSkill(rawName: string, files: SkillFile[], source: SkillSource, origin?: string): Skill {
  // A dated filename is a document, not a skill name — the date is filing
  // metadata and only makes the chip harder to read.
  const dirName = rawName.replace(/^\d{4}-\d{2}-\d{2}-/, '')
  const ordered = orderFiles(files)
  const primary = ordered.find((f) => /^SKILL\.md$/i.test(f.rel)) ?? ordered[0]
  const fm = primary ? frontmatter(primary.text) : {}
  return {
    id: slugify(fm.name || dirName) || `skill-${Date.now().toString(36)}`,
    name: fm.name || dirName,
    description: fm.description || (primary ? firstHeading(primary.text) : null) || '',
    source,
    origin,
    addedAt: Date.now(),
    files: ordered,
  }
}

/**
 * Group dropped/selected files into skills.
 *
 * A directory containing SKILL.md at its root becomes one skill carrying its
 * references. Loose markdown files each become a skill of their own — that is
 * how a single acting/direction doc gets in without ceremony.
 */
export async function skillsFromFileList(list: FileList | File[], source: SkillSource = 'upload'): Promise<Skill[]> {
  const files = Array.from(list)
  const zips = files.filter((f) => /\.zip$/i.test(f.name))
  const plain = files.filter((f) => !/\.zip$/i.test(f.name) && TEXT_EXT.test(f.name))

  const skills: Skill[] = []

  const loose: File[] = []

  // A skill root is any folder holding a SKILL.md; everything beneath it
  // belongs to that skill, and anything outside one is a loose document.
  const allPaths = plain.map((f) => (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name)
  const roots = new Set<string>()
  for (const p of allPaths) {
    const parts = p.split('/')
    if (/^SKILL\.md$/i.test(parts[parts.length - 1])) roots.add(parts.slice(0, -1).join('/'))
  }

  if (roots.size) {
    for (const root of roots) {
      const members: SkillFile[] = []
      for (const f of plain) {
        const p = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        if (p === root || p.startsWith(root + '/')) {
          members.push(mkFile(p.slice(root.length + 1) || f.name, await f.text()))
        }
      }
      const dirName = root.split('/').pop() || 'skill'
      if (members.length) skills.push(buildSkill(dirName, members, source))
    }
    // Anything outside a SKILL.md root is treated as loose.
    for (const f of plain) {
      const p = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
      if (![...roots].some((r) => p === r || p.startsWith(r + '/'))) loose.push(f)
    }
  } else {
    loose.push(...plain)
  }

  for (const f of loose) {
    const text = await f.text()
    skills.push(buildSkill(f.name.replace(TEXT_EXT, ''), [mkFile(f.name, text)], source))
  }

  for (const z of zips) skills.push(...(await skillsFromZip(await z.arrayBuffer(), z.name, source)))

  // De-dupe ids within this batch.
  const seen = new Set<string>()
  for (const s of skills) {
    let id = s.id
    let n = 2
    while (seen.has(id)) id = `${s.id}-${n++}`
    s.id = id
    seen.add(id)
  }
  return skills
}

export async function skillsFromZip(buf: ArrayBuffer, zipName: string, source: SkillSource = 'upload'): Promise<Skill[]> {
  const entries = unzipSync(new Uint8Array(buf))
  const paths = Object.keys(entries).filter((p) => TEXT_EXT.test(p) && !p.includes('__MACOSX'))
  const roots = new Set<string>()
  for (const p of paths) {
    const parts = p.split('/')
    if (/^SKILL\.md$/i.test(parts[parts.length - 1])) roots.add(parts.slice(0, -1).join('/'))
  }

  const skills: Skill[] = []
  if (roots.size) {
    for (const root of roots) {
      const members = paths
        .filter((p) => (root ? p.startsWith(root + '/') : !p.includes('/')))
        .map((p) => mkFile(root ? p.slice(root.length + 1) : p, strFromU8(entries[p])))
      const dirName = root.split('/').pop() || zipName.replace(/\.zip$/i, '')
      if (members.length) skills.push(buildSkill(dirName, members, source))
    }
  } else {
    for (const p of paths) {
      skills.push(buildSkill(p.split('/').pop()!.replace(TEXT_EXT, ''), [mkFile(p.split('/').pop()!, strFromU8(entries[p]))], source))
    }
  }
  return skills
}

/**
 * Add a skill from a URL. Accepts a single markdown file, or a manifest
 * (`{name, description, files: {rel: url}}`) so a repo can publish a skill
 * with its references.
 */
export async function skillFromUrl(url: string): Promise<Skill> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const ct = res.headers.get('content-type') || ''
  const body = await res.text()

  if (ct.includes('json') || /^\s*\{/.test(body)) {
    const manifest = JSON.parse(body) as { name?: string; description?: string; files: Record<string, string> }
    const base = new URL(url)
    const files: SkillFile[] = []
    for (const [rel, href] of Object.entries(manifest.files)) {
      const r = await fetch(new URL(href, base).toString())
      if (!r.ok) throw new Error(`${rel}: ${r.status}`)
      files.push(mkFile(rel, await r.text()))
    }
    const s = buildSkill(manifest.name || 'skill', files, 'url', url)
    if (manifest.name) s.name = manifest.name
    if (manifest.description) s.description = manifest.description
    return s
  }

  const name = decodeURIComponent(url.split('/').pop() || 'skill').replace(TEXT_EXT, '')
  return buildSkill(name, [mkFile(`${name}.md`, body)], 'url', url)
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export async function loadSkills(): Promise<Skill[]> {
  const all = await idb.all<Skill>('skills')
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

export async function saveSkill(skill: Skill): Promise<void> {
  await idb.set('skills', skill.id, skill)
}

export async function removeSkill(id: string): Promise<void> {
  await idb.del('skills', id)
}

/**
 * Fetch whatever skills the deployment ships with, once. Baked skills live in
 * `public/skills/` (see scripts/bake-skills.mjs) so what gets published is
 * exactly what someone put there — nothing is compiled into the bundle.
 */
export async function fetchBundledSkills(): Promise<Skill[]> {
  try {
    const res = await fetch(new URL('skills/index.json', document.baseURI).toString(), { cache: 'no-cache' })
    if (!res.ok) return []
    const manifest = (await res.json()) as { skills: { dir: string; files: string[] }[] }
    const out: Skill[] = []
    for (const entry of manifest.skills) {
      const files: SkillFile[] = []
      for (const rel of entry.files) {
        const r = await fetch(new URL(`skills/${entry.dir}/${rel}`, document.baseURI).toString(), { cache: 'no-cache' })
        if (r.ok) files.push(mkFile(rel, await r.text()))
      }
      if (files.length) out.push(buildSkill(entry.dir, files, 'bundled'))
    }
    return out
  } catch {
    return []
  }
}

export function skillTokens(skill: Skill, selected?: string[]): number {
  const set = selected ? new Set(selected) : null
  return skill.files.reduce((n, f) => (!set || set.has(f.rel) ? n + f.tokens : n), 0)
}

export function exportSkills(skills: Skill[]): Blob {
  return new Blob([JSON.stringify({ version: 1, exportedAt: Date.now(), skills }, null, 2)], { type: 'application/json' })
}

export function importSkills(json: string): Skill[] {
  const parsed = JSON.parse(json) as { skills?: Skill[] }
  if (!Array.isArray(parsed.skills)) throw new Error('not a skill export')
  return parsed.skills.map((s) => ({ ...s, files: orderFiles(s.files || []) }))
}
