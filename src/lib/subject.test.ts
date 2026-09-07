import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeSubjectImage,
  composeSubjectJob,
  defaultJobForSubjectKind,
  parseSubjectDefinition,
  resolveVisionMaxTokens,
} from './subject'
import type { SubjectDefinition } from './types'
import type { Provider } from './types'

const PROVIDER: Provider = { id: 'p', label: 'p', baseUrl: 'http://local.test/v1', kind: 'openai', builtIn: true }

const LARA: SubjectDefinition = {
  apparentAge: 'mid-20s',
  build: 'athletic',
  face: 'sharp jawline, high cheekbones',
  hair: 'dark brown, braided ponytail',
  skin: 'tanned olive',
  distinguishingMarks: '',
  wardrobe: 'denim shorts and a white tank top',
}

// ── Feature 1 — subject-kind radio phrasing ──────────────────────────────

test('defaultJobForSubjectKind: male seeds the male possessive phrasing', () => {
  assert.equal(defaultJobForSubjectKind('male'), 'his face, his body, his identity')
})

test('defaultJobForSubjectKind: female seeds the female possessive phrasing', () => {
  assert.equal(defaultJobForSubjectKind('female'), 'her face, her body, her identity')
})

test('defaultJobForSubjectKind: other seeds the neutral phrasing', () => {
  assert.equal(defaultJobForSubjectKind('other'), 'identity from image')
})

// ── Feature 2 — JSON subject definition parsing ──────────────────────────

test('parseSubjectDefinition: parses a clean JSON object', () => {
  const raw = JSON.stringify(LARA)
  assert.deepEqual(parseSubjectDefinition(raw), LARA)
})

test('parseSubjectDefinition: tolerates a ```json fence and surrounding whitespace', () => {
  const raw = `\n\`\`\`json\n${JSON.stringify(LARA)}\n\`\`\`\n`
  assert.deepEqual(parseSubjectDefinition(raw), LARA)
})

test('parseSubjectDefinition: returns null for prose with no JSON object', () => {
  assert.equal(parseSubjectDefinition('She looks about mid-20s, athletic build.'), null)
})

test('parseSubjectDefinition: missing keys come back as empty strings, not undefined', () => {
  const def = parseSubjectDefinition('{"face": "round"}')
  assert.equal(def?.face, 'round')
  assert.equal(def?.wardrobe, '')
  assert.equal(def?.distinguishingMarks, '')
})

// ── Feature 3 — identity/wardrobe blending, the Lara Croft -> saree case ─

test('composeSubjectJob: no override states the detected wardrobe positively', () => {
  const text = composeSubjectJob({ subjectKind: 'female', def: LARA })
  assert.match(text, /her face, her body, her identity/)
  assert.match(text, /denim shorts and a white tank top/)
});

test('composeSubjectJob: a wardrobe override replaces the garment and never names the source one', () => {
  const override = 'a flowing green chiffon saree with gold embroidery at the border'
  const text = composeSubjectJob({ subjectKind: 'female', def: LARA, wardrobeOverride: override })

  // The new wardrobe is present...
  assert.match(text, /green chiffon saree/)
  // ...and the source garment is not named anywhere, positively or as a negation —
  // naming it at all is what re-instructs the model to produce it.
  assert.doesNotMatch(text.toLowerCase(), /shorts/)
  assert.doesNotMatch(text.toLowerCase(), /tank top/)
  assert.doesNotMatch(text.toLowerCase(), /denim/)
  // And it is not phrased as a negation of anything.
  assert.doesNotMatch(text.toLowerCase(), /\b(not|ignore|instead of|rather than|without)\b/)
})

test('composeSubjectJob: identity attributes still appear alongside an override', () => {
  const text = composeSubjectJob({ subjectKind: 'female', def: LARA, wardrobeOverride: 'a green saree' })
  assert.match(text, /athletic/)
  assert.match(text, /sharp jawline/)
})

test('composeSubjectJob: an empty override falls back to the detected wardrobe', () => {
  const withEmpty = composeSubjectJob({ subjectKind: 'female', def: LARA, wardrobeOverride: '   ' })
  const withNone = composeSubjectJob({ subjectKind: 'female', def: LARA })
  assert.equal(withEmpty, withNone)
})

test('composeSubjectJob: "other" uses neutral phrasing throughout', () => {
  const text = composeSubjectJob({ subjectKind: 'other', def: LARA })
  assert.match(text, /identity from image/)
  assert.match(text, /The subject wears/)
})

// ── output-cap floor ──────────────────────────────────────────────────────

test('resolveVisionMaxTokens: 0 (no ceiling) is left alone', () => {
  assert.equal(resolveVisionMaxTokens(0), 0)
})

test('resolveVisionMaxTokens: a tight cap is raised to the floor', () => {
  assert.equal(resolveVisionMaxTokens(64), 1500)
})

test('resolveVisionMaxTokens: a already-generous cap is left alone', () => {
  assert.equal(resolveVisionMaxTokens(4000), 4000)
})

// ── empty content must surface as an error, not a silent success ────────

function sseResponse(frames: string[]): Response {
  const body = frames.map((f) => `data: ${f}\n\n`).join('') + 'data: [DONE]\n\n'
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

test('analyzeSubjectImage: empty content with finish_reason length throws, not a silent empty definition', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking about the image…' } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    ])) as typeof fetch

  try {
    await assert.rejects(
      analyzeSubjectImage({ provider: PROVIDER, model: 'thinkingcap-27b', imageDataUrl: 'data:image/png;base64,AA==', maxTokens: 64 }),
      /ran out of room|Cut off/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('analyzeSubjectImage: content that never parses as JSON throws rather than returning garbage', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse([JSON.stringify({ choices: [{ delta: { content: 'Sure, here is a description in prose.' }, finish_reason: 'stop' }] })])) as typeof fetch

  try {
    await assert.rejects(
      analyzeSubjectImage({ provider: PROVIDER, model: 'thinkingcap-27b', imageDataUrl: 'data:image/png;base64,AA==', maxTokens: 1500 }),
      /did not return the expected JSON/,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('analyzeSubjectImage: a clean JSON reply parses into a SubjectDefinition', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    sseResponse([JSON.stringify({ choices: [{ delta: { content: JSON.stringify(LARA) }, finish_reason: 'stop' }] })])) as typeof fetch

  try {
    const { def } = await analyzeSubjectImage({
      provider: PROVIDER,
      model: 'thinkingcap-27b',
      imageDataUrl: 'data:image/png;base64,AA==',
      maxTokens: 1500,
    })
    assert.deepEqual(def, LARA)
  } finally {
    globalThis.fetch = originalFetch
  }
})
