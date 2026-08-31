#!/usr/bin/env node
// Serves the built app over http://localhost, which is the escape hatch for
// the two cases a hosted HTTPS page cannot handle: Safari (which does not
// treat http://localhost as a secure origin) and model endpoints that are
// plain HTTP on some other machine.

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../dist', import.meta.url)))
const PORT = Number(process.env.PORT || 5178)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
}

try {
  await stat(join(ROOT, 'index.html'))
} catch {
  console.error('No build found. Run `npm run build` first.')
  process.exit(1)
}

createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  let path = join(ROOT, decodeURIComponent(url.pathname))
  if (!path.startsWith(ROOT)) return res.writeHead(403).end('forbidden')
  try {
    const s = await stat(path)
    if (s.isDirectory()) path = join(path, 'index.html')
  } catch {
    path = join(ROOT, 'index.html') // single-page fallback
  }
  try {
    const body = await readFile(path)
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`H3 Prompt Studio → http://localhost:${PORT}`)
})
