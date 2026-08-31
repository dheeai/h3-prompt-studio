#!/usr/bin/env node
/**
 * Copy skills into public/skills/ so a deployment ships with them.
 *
 * NOTHING is baked in by default and public/skills/ is gitignored, because
 * anything placed there is served to every visitor of wherever you deploy.
 * Baking is therefore an explicit, local act — run it when you have decided
 * that these particular documents should be public.
 *
 *   node scripts/bake-skills.mjs ~/.claude/skills/h3-direction ~/.claude/skills/h3-prompting
 *   node scripts/bake-skills.mjs --glob '~/.claude/skills/h3-*'
 *   node scripts/bake-skills.mjs --clear
 */

import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { join, resolve, basename, relative, extname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const OUT = resolve(fileURLToPath(new URL('../public/skills', import.meta.url)))
const TEXT = new Set(['.md', '.markdown', '.txt'])

const expand = (p) => (p.startsWith('~') ? join(homedir(), p.slice(1)) : p)

async function walk(dir, base = '', out = [], depth = 0) {
  if (depth > 4) return out
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '.venv') continue
    const abs = join(dir, e.name)
    const rel = base ? `${base}/${e.name}` : e.name
    if (e.isDirectory()) await walk(abs, rel, out, depth + 1)
    else if (TEXT.has(extname(e.name).toLowerCase())) out.push({ rel, abs })
  }
  return out
}

async function expandGlob(pattern) {
  const full = expand(pattern)
  const star = full.indexOf('*')
  if (star === -1) return [full]
  const dir = full.slice(0, full.lastIndexOf('/', star))
  const pat = new RegExp('^' + full.slice(dir.length + 1).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory() && pat.test(e.name)).map((e) => join(dir, e.name))
}

const argv = process.argv.slice(2)

if (argv.includes('--clear')) {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await writeFile(join(OUT, '.gitkeep'), '')
  console.log('cleared public/skills/')
  process.exit(0)
}

let targets = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--glob') targets.push(...(await expandGlob(argv[++i])))
  else targets.push(expand(argv[i]))
}

if (!targets.length) {
  console.error(`Nothing to bake.

  node scripts/bake-skills.mjs <skill-dir> [<skill-dir> …]
  node scripts/bake-skills.mjs --glob '~/.claude/skills/h3-*'
  node scripts/bake-skills.mjs --clear

Anything baked here is served to every visitor of wherever you deploy this.
Only bake documents you intend to publish.`)
  process.exit(1)
}

await mkdir(OUT, { recursive: true })
const manifest = { skills: [] }

for (const target of targets) {
  let s
  try {
    s = await stat(target)
  } catch {
    console.warn(`skipped (not found): ${target}`)
    continue
  }

  const dirName = basename(target).replace(/\.(md|markdown|txt)$/i, '')
  const destDir = join(OUT, dirName)
  await mkdir(destDir, { recursive: true })

  const files = s.isDirectory() ? await walk(target) : [{ rel: basename(target), abs: target }]
  const written = []
  for (const f of files) {
    const dest = join(destDir, f.rel)
    await mkdir(join(dest, '..'), { recursive: true })
    await writeFile(dest, await readFile(f.abs))
    written.push(f.rel)
  }

  // SKILL.md first so the app's default selection picks the right document.
  written.sort((a, b) => (/^SKILL\.md$/i.test(a) ? -1 : /^SKILL\.md$/i.test(b) ? 1 : a.localeCompare(b)))
  manifest.skills.push({ dir: dirName, files: written })
  console.log(`baked ${dirName} — ${written.length} file${written.length === 1 ? '' : 's'}`)
}

await writeFile(join(OUT, 'index.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`\nwrote ${relative(process.cwd(), join(OUT, 'index.json'))} — ${manifest.skills.length} skill(s)`)
console.log('These will be served to every visitor of your deployment.')
