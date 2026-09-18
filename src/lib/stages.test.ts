import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { platesBlock,
  DEFAULT_TEMPLATES, OFF_CHAIN, PROMPT_STAGES, SCHEMA_STAGES, STAGE_INFO, STAGE_LABEL,
  continuationFrameBlock, durationBlock, fillTemplate, fillTemplateWithDuration, filmBlock,
} from './stages'
import { framesForSeconds } from './geometry'
import { FILM_LOOK_PRESETS } from './filmLook'
import { pipelinePreset } from './pipeline'
import type { FilmContext } from './types'

test('durationBlock states the ACTUAL grid-snapped length, not the chosen one', () => {
  // 5s -> snapFrames(120) = 124 frames = 5.167s. The prompt must carry 5.167s, because
  // cut timecodes have to fit inside it and a snapped clip runs slightly long.
  const b = durationBlock(5, framesForSeconds(5))
  assert.match(b, /124 frames at 24fps = 5\.167s/)
  assert.match(b, /must fit inside 5\.167s/)
  assert.match(b, /operator selected 5s/)
  assert.match(b, /use it, not 5s/)
})

test('durationBlock omits the reconciliation when chosen equals actual', () => {
  const frames = framesForSeconds(5)
  const actual = +(frames / 24).toFixed(3)
  const b = durationBlock(actual, frames)
  assert.match(b, /5\.167s/)
  assert.doesNotMatch(b, /operator selected/)
})

test('a 20s selection carries 20s, not the templates\' 6-15 hint', () => {
  const frames = framesForSeconds(20)          // snapFrames(480) = 481
  const b = durationBlock(20, frames)
  assert.match(b, new RegExp(`${frames} frames`))
  assert.match(b, /20\.042s/)
})

test('fillTemplateWithDuration PREPENDS when the template has no placeholder', () => {
  // Stage templates are persisted per browser, so an operator carrying a customised one
  // must still receive the duration — otherwise the fix reaches nobody who has used the app.
  const out = fillTemplateWithDuration('WRITE THE CLIP.\n{{story}}', { story: 'a man waits', duration: 'DURATION — 124 frames' })
  assert.match(out, /^DURATION — 124 frames/)
  assert.match(out, /WRITE THE CLIP/)
})

test('fillTemplateWithDuration PLACES it when the template names it', () => {
  const out = fillTemplateWithDuration('{{story}}\n\n{{duration}}\n\nGO.', { story: 's', duration: 'DUR' })
  assert.doesNotMatch(out, /^DUR/)
  assert.match(out, /s\n\nDUR\n\nGO\./)
})

test('no duration supplied leaves the template untouched', () => {
  assert.equal(fillTemplateWithDuration('{{story}}', { story: 'x' }), 'x')
})

test('fillTemplate still strips an unused {{duration}} placeholder', () => {
  assert.equal(fillTemplate('{{story}}{{duration}}', { story: 'x' }), 'x')
})

// ── continuationFrameBlock / {{continuationFrame}} — only present when a ──
// ── continuation frame is actually attached ───────────────────────────────

test('continuationFrameBlock: absent when no frame is attached', () => {
  assert.equal(continuationFrameBlock(false), '')
})

test('continuationFrameBlock: names what the image is, and forbids citing it', () => {
  const b = continuationFrameBlock(true)
  assert.match(b, /final rendered frame of the previous clip/)
  assert.match(b, /CONTEXT ONLY/)
  assert.match(b, /Never cite it as <Subject N> or <Picture N>/)
  assert.match(b, /never add it to\s+references/)
})

test('fillTemplate: {{continuationFrame}} renders empty when nothing is supplied', () => {
  assert.equal(fillTemplate('BEFORE\n{{continuationFrame}}\nAFTER', { story: 'x' }), 'BEFORE\n\nAFTER')
})

test('fillTemplate: {{continuationFrame}} carries the supplied block verbatim', () => {
  const out = fillTemplate('{{continuationFrame}}', { story: 'x', continuationFrame: continuationFrameBlock(true) })
  assert.match(out, /CONTEXT ONLY/)
})

test('draft template: carries the {{continuationFrame}} placeholder, after {{previous}}', () => {
  const draft = DEFAULT_TEMPLATES.draft
  assert.ok(draft.includes('{{continuationFrame}}'))
  assert.ok(draft.indexOf('{{previous}}') < draft.indexOf('{{continuationFrame}}'))
})

// ── filmBlock: the film-wide look (2026-09-17 brief) ──────────────────────
// Chosen once, carried on FilmContext.look, and folded into {{film}} for
// EVERY clip — standalone or part of a longer film, including one authored
// long after the look was picked.

test('filmBlock: a standalone clip with no look set is unchanged from before this existed', () => {
  const f: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '' }
  assert.equal(filmBlock(f), '')
})

test('filmBlock: the look reaches a STANDALONE clip', () => {
  const preset = FILM_LOOK_PRESETS[1]
  const f: FilmContext = { role: 'standalone', spine: '', precedes: '', follows: '', look: { preset: preset.id } }
  const block = filmBlock(f)
  assert.match(block, /FILM-WIDE LOOK/)
  assert.ok(block.includes(preset.description))
  assert.ok(block.includes(preset.description))
})

test('filmBlock: the look reaches a clip authored LATER in the film (a non-standalone role)', () => {
  const preset = FILM_LOOK_PRESETS[0]
  const f: FilmContext = {
    role: 'rising',
    spine: 'a woman searches a flooded city for her brother',
    precedes: 'she has just found his boat, empty',
    follows: 'the water starts rising again',
    clipIndex: 4,
    look: { preset: preset.id, freeText: 'grainy, handheld, like a home video' },
  }
  const block = filmBlock(f)
  // the look block precedes the per-clip film-role text, but both must be present
  assert.match(block, /FILM-WIDE LOOK/)
  assert.ok(block.includes(preset.description))
  assert.match(block, /grainy, handheld, like a home video/)
  assert.match(block, /THIS CLIP IS PART OF A LONGER FILM/)
  assert.ok(block.indexOf('FILM-WIDE LOOK') < block.indexOf('THIS CLIP IS PART OF A LONGER FILM'))
})

test('filmBlock: free text survives alongside a preset choice, in the same clip', () => {
  const preset = FILM_LOOK_PRESETS[2]
  const f: FilmContext = {
    role: 'standalone',
    spine: '',
    precedes: '',
    follows: '',
    look: { preset: preset.id, freeText: 'match the reference film we discussed' },
  }
  const block = filmBlock(f)
  assert.ok(block.includes(preset.description))
  assert.match(block, /match the reference film we discussed/)
})

// ── the frozen arm — preset A's incumbent must stay byte-identical ────────
//
// "I want to save the current mode -- as its working well.. dont touch the
// prompt etc of the current. But put it as a preset." Preset A is the
// control of an A/B; if a shared template moves, both arms move and the
// experiment measures nothing. Hashed rather than inlined byte-for-byte
// here (these are long) — any edit at all, even whitespace, changes the
// hash and fails this loudly.

const FROZEN_TEMPLATE_HASHES: Record<string, string> = {
  direct: '8d39c8fffaf92c30d203d158db3317b9f2e1e58a035500749a3f995f0fe77d63',
  draft: '49de4c4d561c382784f19e275862af61ebcd8dff411beae415c3d9487ccfd1d2',
  critique: '738c6e1152489002e329d73b4a44ac540796a4f737bc1bfc5fff50efacfc1f9b',
  revise: 'a99bfc095bdfd7b8b9e12e5c690c48a5b0028a2fc27532533bb97fe405e71b75',
  rebuild: 'c15cdd688682a5c0a4ed9b8f72ea294401c568466552d72e281e033c005db804',
  handoff: '9c52d4d3beecdc3c91ed9b8a60a5701712f03b93e708eefdb78458f4f9b3edaa',
  freeform: '264733ed91419efd75c4b4c36ef90159aa100e3451f5975befa1e3dae5630d26',
  breakdown: '47f6f10f53dd6555310e54f3669236b7770c0527961fb977436ee3e24bbf66c9',
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

test('frozen arm: every DEFAULT_TEMPLATES entry that existed before preset B is byte-identical', () => {
  for (const [stage, expected] of Object.entries(FROZEN_TEMPLATE_HASHES)) {
    const actual = sha256(DEFAULT_TEMPLATES[stage as keyof typeof DEFAULT_TEMPLATES])
    assert.equal(
      actual,
      expected,
      `${stage}'s DEFAULT_TEMPLATES entry changed — preset A must stay frozen, or the A/B measures nothing`,
    )
  }
})

test('frozen arm: preset A\'s stage list contains no direction/acting stage', () => {
  const a = pipelinePreset('direct-write')
  assert.deepStrictEqual(a.extraStages, [])
  assert.equal(a.writerStage, 'draft')
})

test('draftDirected is a NEW template, not a rename or edit of draft', () => {
  assert.notEqual(DEFAULT_TEMPLATES.draftDirected, DEFAULT_TEMPLATES.draft)
  assert.ok(!Object.values(FROZEN_TEMPLATE_HASHES).includes(sha256(DEFAULT_TEMPLATES.draftDirected)))
})

// ── the draftDirected template itself ──────────────────────────────────────

test('draftDirected tells the writer the shots/camera/performance are already decided', () => {
  const t = DEFAULT_TEMPLATES.draftDirected
  assert.match(t, /ALREADY DECIDED/)
  assert.match(t, /Do not re-choose a shot/)
})

test('draftDirected keeps the same <<<PROMPT>>> output contract as draft', () => {
  assert.match(DEFAULT_TEMPLATES.draftDirected, /<<<PROMPT>>>/)
  assert.match(DEFAULT_TEMPLATES.draftDirected, /no preamble, no explanation, no\nfences/)
})

test('draftDirected carries the same shared placeholder vocabulary as draft', () => {
  const t = DEFAULT_TEMPLATES.draftDirected
  for (const ph of ['{{film}}', '{{plates}}', '{{previous}}', '{{story}}', '{{standing}}', '{{continuationFrame}}', '{{mode}}']) {
    assert.ok(t.includes(ph), `draftDirected must keep ${ph}`)
  }
})

test('draftDirected adds {{direction}} and {{acting}} placeholders draft does not have', () => {
  assert.ok(DEFAULT_TEMPLATES.draftDirected.includes('{{direction}}'))
  assert.ok(DEFAULT_TEMPLATES.draftDirected.includes('{{acting}}'))
  assert.ok(!DEFAULT_TEMPLATES.draft.includes('{{direction}}'))
  assert.ok(!DEFAULT_TEMPLATES.draft.includes('{{acting}}'))
})

test('fillTemplate fills {{direction}} and {{acting}} when supplied', () => {
  const out = fillTemplate('D: {{direction}}\nA: {{acting}}', { direction: 'shot 1: push in', acting: 'wants: leave' })
  assert.match(out, /D: shot 1: push in/)
  assert.match(out, /A: wants: leave/)
})

test('fillTemplate states the gap explicitly when direction/acting are not supplied', () => {
  const out = fillTemplate('{{direction}} / {{acting}}', {})
  assert.match(out, /no direction document supplied/)
  assert.match(out, /no acting document supplied/)
})

test('draftDirected fills end to end, same as draft', () => {
  const filled = fillTemplateWithDuration(DEFAULT_TEMPLATES.draftDirected, {
    duration: 'DURATION — 124 frames',
    story: 'a woman enters a shop',
    mode: 'Ref2VA',
    film: 'FILM-WIDE LOOK\nsome look',
    standing: 'a plain idea',
    previous: '',
    plates: '',
    continuationFrame: '',
    direction: '[Shot 1]\n  camera: wide -> close, Push In',
    acting: '- Lira — wants: leave the shop',
  })
  assert.match(filled, /a woman enters a shop/)
  assert.match(filled, /Push In/)
  assert.match(filled, /wants: leave the shop/)
  assert.match(filled, /<<<PROMPT>>>/)
})

// ── stage bookkeeping picks up the new stage ───────────────────────────────

test('draftDirected is schema-constrained and counts as a canonical prompt stage, same as draft', () => {
  assert.ok(SCHEMA_STAGES.has('draftDirected'))
  assert.ok(PROMPT_STAGES.has('draftDirected'))
})

test('draftDirected is off the manual chain — an action a preset invokes, not a button to click through', () => {
  assert.ok(OFF_CHAIN.includes('draftDirected'))
})

test('draftDirected has its own label and stage info, distinct from draft', () => {
  assert.equal(STAGE_LABEL.draftDirected, 'Draft (directed)')
  assert.notEqual(STAGE_LABEL.draftDirected, STAGE_LABEL.draft)
  assert.ok(STAGE_INFO.draftDirected.blurb.length > 0)
})

// ── plates cite the slot the render actually resolves (2026-09-18) ──────

test('an image plate is offered as <Picture N> — the slot refs_json wires it to', () => {
  const b = platesBlock([
    { name: 'nusrat', kind: 'image', job: 'her identity' },
    { name: 'farid', kind: 'image', job: 'his identity' },
  ])
  assert.match(b, /- <Picture 1> — nusrat: her identity/)
  assert.match(b, /- <Picture 2> — farid: his identity/)
  // It must NOT label an image plate <Subject N>: nothing resolves that to a
  // wired slot, and the old block did exactly this while also forbidding the
  // model from citing any other label — so an obedient model would never
  // reference the image at all.
  assert.doesNotMatch(b, /- <Subject 1>/)
})

test('a video plate keeps <Video N>', () => {
  assert.match(platesBlock([{ name: 'walk', kind: 'video', job: 'the gait' }]), /- <Video 1> — walk: the gait/)
})

test('plates position is the slot number, in order', () => {
  const b = platesBlock([
    { name: 'a', kind: 'image', job: 'x' },
    { name: 'b', kind: 'video', job: 'y' },
    { name: 'c', kind: 'image', job: 'z' },
  ])
  assert.ok(b.indexOf('<Picture 1> — a') < b.indexOf('<Video 2> — b'))
  assert.ok(b.indexOf('<Video 2> — b') < b.indexOf('<Picture 3> — c'))
})

test('the block teaches the guide’s own shape: a Subject defined FROM a Picture', () => {
  // ref_guide.md 2.2: "If an image is used only to define a character, scene,
  // costume, or style, do not create a standalone picture entry. Instead, cite
  // the image source inside the corresponding <Subject N> definition."
  const b = platesBlock([{ name: 'nusrat', kind: 'image', job: 'her identity' }])
  assert.match(b, /<Subject 1> is the woman in <Picture 1>/)
  assert.match(b, /does NOT get a standalone picture entry/)
})

test('an uncited plate is called out as loaded-and-unused', () => {
  const b = platesBlock([{ name: 'nusrat', kind: 'image', job: 'her identity' }])
  assert.match(b, /loaded and never used/)
})

test('a plate with no job still says so rather than going silent', () => {
  assert.match(platesBlock([{ name: 'x', kind: 'image', job: '  ' }]), /no job written/)
})

test('no plates writes nothing at all', () => {
  assert.equal(platesBlock([]), '')
  assert.equal(platesBlock(undefined), '')
})
