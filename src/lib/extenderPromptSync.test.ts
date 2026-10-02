import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_REWRITE_SYSTEM_PROMPT } from './rewriteSystemPrompt'
import { CHAPTER_BREAKDOWN_TEMPLATE } from './chapterBreakdown'

// The MiniMax H3 Master Extender repo keeps the canonical copy of these two prompts in prompts/*.md (its
// built-in rewriter and story planner run them). Drift guard: skipped when that checkout is absent.
// Locate it with H3_EXTENDER_DIR, else ~/Projects/h3-extender.
const extenderDir = process.env.H3_EXTENDER_DIR || join(homedir(), 'Projects', 'h3-extender')

function extenderPrompt(name: string): string {
  const text = readFileSync(join(extenderDir, 'prompts', `${name}.md`), 'utf8')
  return text.startsWith('<!--') ? text.slice(text.indexOf('-->') + 3).replace(/^\r?\n/, '') : text
}

const present = existsSync(join(extenderDir, 'prompts', 'builder.md')) && existsSync(join(extenderDir, 'prompts', 'planner.md'))

test('DEFAULT_REWRITE_SYSTEM_PROMPT equals the extender prompts/builder.md', { skip: !present && 'extender checkout not found' }, () => {
  assert.equal(extenderPrompt('builder'), DEFAULT_REWRITE_SYSTEM_PROMPT)
})

test('CHAPTER_BREAKDOWN_TEMPLATE equals the extender prompts/planner.md', { skip: !present && 'extender checkout not found' }, () => {
  assert.equal(extenderPrompt('planner'), CHAPTER_BREAKDOWN_TEMPLATE)
})
