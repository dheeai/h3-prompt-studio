import type { Breakdown, BreakdownClip, ClipRole, FilmContext, StageId } from './types'

export const STAGE_ORDER: StageId[] = ['direct', 'draft', 'critique', 'revise']

/** Stages that are actions rather than steps in the chain. */
export const OFF_CHAIN: StageId[] = ['rebuild', 'freeform', 'handoff', 'breakdown']

/**
 * What each pass consumes and produces.
 *
 * They form a chain — each works on what the one before it left on the page —
 * but any of them can be entered directly, which is why the UI has to state
 * both facts rather than looking like a wizard.
 */
export const STAGE_INFO: Record<StageId, { produces: string; needs: 'story' | 'anything' | 'prompt'; blurb: string }> = {
  direct: {
    produces: 'a direction sheet',
    needs: 'story',
    blurb:
      'Works out what to show — anchors, escalation, a beat grid, a card per cut. Reads a story, or re-reads a prompt someone already wrote and re-decides it. Writes no prompt fields.',
  },
  draft: {
    produces: 'the prompt',
    needs: 'anything',
    blurb: 'Rebuilds the prompt from the direction sheet, in the official field structure — not an edit of what came before.',
  },
  critique: {
    produces: 'notes',
    needs: 'prompt',
    blurb: 'Audits the prompt against the loaded skills and lists what is wrong. Changes nothing.',
  },
  revise: {
    produces: 'a corrected prompt',
    needs: 'prompt',
    blurb: 'One finite replacement: applies the loaded-skill findings, preserves the fixed brief, and explains the material corrections.',
  },
  rebuild: {
    produces: 'a rebuilt prompt',
    needs: 'prompt',
    blurb: 'One finite replacement: preserves the fixed brief while rethinking open performance, beats, shot design, camera, lighting, sound, and structure.',
  },
  freeform: {
    produces: 'a corrected prompt',
    needs: 'prompt',
    blurb: 'Applies one instruction you type, and nothing else.',
  },
  handoff: {
    produces: 'the state the next clip inherits',
    needs: 'prompt',
    blurb:
      'Reads the clip that just landed and writes what the next one opens on — the frame, what is unresolved, and what must not be re-established. Writes no prompt.',
  },
  breakdown: {
    produces: 'a clip plan',
    needs: 'story',
    blurb: 'Decides how many clips the source needs and what each one covers, precedes and follows. Writes no prompt.',
  },
}

export const STAGE_LABEL: Record<StageId, string> = {
  direct: 'Direct',
  draft: 'Draft',
  critique: 'Critique',
  revise: 'Revise',
  rebuild: 'Rebuild',
  freeform: 'Note',
  handoff: 'Hand-off',
  breakdown: 'Break down',
}

/**
 * Stage templates. Editable by the user and stored in settings, so these are
 * only the starting point.
 *
 * Placeholders: {{story}} {{current}} {{mode}} {{notes}} {{findings}} {{critique}} {{film}} {{standing}} {{previous}}
 *
 * Each one deliberately refuses to restate the loaded skills — the skills are
 * already in the system block, and repeating them here would both waste the
 * budget and break the byte-stable prefix that keeps the KV cache warm.
 */
export const DEFAULT_TEMPLATES: Record<StageId, string> = {
  direct: `You are directing, not writing prompts yet.

THE ONE RULE:

  You cannot change WHAT HAPPENS ON THE SCREEN.
  You can change HOW WHAT HAPPENS ON THE SCREEN IS SHOT.

Two different things live in the source and they are NOT treated the same way.

FIXED — carry these through unchanged. They are what was actually asked for:
- who is in the scene, and what they do
- where it takes place
- the action requested, and how it ends
- named objects, props, wardrobe, animals, vehicles
- any dialogue, verbatim
- stated constraints: duration, aspect ratio, language, format

OPEN — yours to decide, and to re-decide when the source gets them wrong:
- framing, lens, camera behaviour, blocking, eyelines
- the order and duration of beats WITHIN the requested action
- what is shown and what is withheld, and when
- performance: gaze, breath, hands, weight, timing, reaction delay
- light, palette, texture, sound design

If the source is ALREADY A PROMPT, do not treat its craft as settled. Judge it —
does it escalate, does each beat earn its screen time, is the camera doing
anything, is the performance observable — and say what it gets wrong. Then
direct it again.

But re-directing means re-deciding HOW it is shot. **It does not license
changing what happens.** "A woman enters a shop" does not become a woman
strolling down a lane because a lane is more interesting: that is a different
film, and no amount of directorial merit makes it the one that was requested.
Changing the subject is not a stronger reading of the brief, it is a failure to
answer it.

If you genuinely believe the requested action cannot work as asked, say so in
one line — then direct the requested action anyway.

{{film}}

PREVIOUS CLIP PROMPT (continuity reference only — do not recreate its whole action)
{{previous}}

A DETERMINISTIC READ OF THE SOURCE, computed before you looked at it — confirm
it or correct it, don't just restate it:
{{standing}}

Begin with these two blocks, before anything else:

WHERE THE SOURCE STANDS
- what kind of thing the source is, in your own judgement
- where that puts it in the regime Direct → Draft → Critique → Revise
- what it has already decided, and what it has not

WHAT THE BRIEF FIXES
- one short line per fixed element above, in your own words

Those blocks are a contract. Everything after them must be a way of shooting
THAT, and any drift is then visible at a glance.

Then produce the DIRECTION SHEET, following the loaded craft documents exactly
where they specify a structure.

Decide and state:
- what this is actually about, in one line
- the five anchors
- the escalation curve across the running time
- a beat grid: for each beat, its duration, what changes, and why that change
  earns its screen time
- for each cut, a shot card: frame size, lens feel, camera behaviour, what the
  audience learns in that shot

Do not write any prompt fields. Do not describe music or rhythm. Output the
direction sheet only.

SOURCE
{{story}}`,

  draft: `Write the {{mode}} prompt now.

The loaded documents govern this. Follow their field structure literally —
field names, order and formatting exactly as specified there, not a paraphrase.
Apply every craft rule they state about shot construction, camera, performance,
sound and suppressed modalities, including any failure mode they record from
real measurements.

This is a rebuild of the WRITING, not of the scene.

Write the prompt from the direction sheet rather than from any earlier prompt:
that prompt's wording, ordering and structure are superseded. What is NOT
superseded is the subject — the people, the place, the action and its outcome,
the named objects, and any dialogue, which stay exactly as the brief asked for
them. The sheet's WHAT THE BRIEF FIXES block is the authority on that.

Render the direction sheet; do not re-direct it, and do not invent beats it
does not contain. If the sheet itself has drifted from the fixed elements,
follow the fixed elements and note the discrepancy in one line at the end.

A DETERMINISTIC READ OF THE SOURCE, computed before either pass looked at it.
It is context for the explanation you are about to write, not something to
reproduce:
{{standing}}

DIRECTION SHEET
{{current}}

SOURCE (for reference only)
{{story}}

Now write your reply. Output exactly two blocks, in this order, and nothing
outside them — no heading of your own before, between or after them:

<<<PROMPT>>>
the complete prompt — and nothing else in it: no preamble, no explanation, no
fences

<<<EXPLANATION>>>
Under ~300 words, prose or short bullets, covering these parts in order:

WHERE THE SOURCE STOOD — what kind of thing the source was (a raw idea, a
story, a brief, a direction sheet, a rough or badly formatted prompt, a
structured prompt) and where that puts it in the regime
Direct → Draft → Critique → Revise: which decisions it had already made and
which it had not.

WHAT WAS FIXED AND WHAT WAS DECIDED — the fixed elements carried through, and
the open craft decisions taken (framing, blocking, beats, sound), each naming
the loaded document that governed it.

WHAT THE SOURCE GOT WRONG — if the source was already a prompt, what it did
badly and what changed; otherwise "nothing to correct".`,

  critique: `Audit the prompt below against the loaded documents.

Every finding must come from those documents, and must NAME the one it comes
from — the skill and, where it exists, the rule or section. A finding you
cannot attribute to a loaded document is general prompt-writing advice; leave
it out. Prefer the failure modes they record from real measurements over
anything you believe from elsewhere.

Judge the WRITING as well as the structure: whether the direction is specific,
whether performance is observable rather than an emotion label, whether the
images earn their screen time, whether the sound is sourced. A structurally
valid prompt that shows nothing worth watching is a finding.

Be specific and hostile. For each problem: quote the exact text, name the
document it breaks, and say what it will do to the render.

Check at minimum:
- every field the {{mode}} structure requires is present and correctly named
- timings are internally consistent and sum to the declared duration
- suppressed modalities use the sentinel, never a description of the absence
- no vocabulary anywhere in the prompt cues a modality that should be silent
- every reference label used is declared
- the soundscape names concrete sources placed in time, not moods

Output a numbered list of findings, worst first. If something is right, do not
mention it. Write no revised prompt — that is the next stage.

PROMPT
{{current}}`,

  revise: `Revise the existing prompt in one finite pass.

The deterministic findings below and the selected skill documents are the
review. Diagnose the material problems in the current prompt, then apply every
necessary correction. Preserve the requested subject, action, outcome, named
objects, dialogue, and explicit constraints. Keep the replacement complete and
submission-ready; do not return a patch, fragment, critique-only response, or
an endless retry.

Critique is explanatory output in this pass, not a separate user stage. Keep
the explanation concise and name the governing skill documents. Do not put
explanation, findings, or markdown fences inside the prompt.

Output exactly two blocks, in this order, and nothing outside them:

<<<PROMPT>>>
the complete canonical replacement prompt — and nothing else

<<<EXPLANATION>>>
2-6 concise lines: what the source got wrong, what was fixed, and which loaded
skill document governed the decisions

DETERMINISTIC FINDINGS
{{findings}}

OPERATOR NOTE
{{notes}}

CURRENT PROMPT
{{current}}`,

  rebuild: `Rebuild the existing prompt from first principles in one finite pass.

This is an operation-specific creative re-synthesis, not a request for a
critique, a patch, or a second stage. Preserve these fixed elements exactly:
the subject, requested action, outcome, setting, named objects, wardrobe,
animals, vehicles, dialogue verbatim, and explicit duration/aspect/language/
format constraints. Do not change what happens on screen.

Rethink the open craft decisions: observable performance, blocking, temporal
beats and beat durations, shot design, framing, lens feel, camera behaviour,
lighting, texture, sound sources, field ordering, and prompt structure. Use the
selected skill documents as the authority, make the action fit the duration,
and return one complete submission-ready H3 prompt. Critique is explanatory
output in this pass, never a separate user stage. Do not put explanation,
findings, or markdown fences inside the prompt.

Output exactly two blocks, in this order, and nothing outside them:

<<<PROMPT>>>
the complete canonical replacement prompt — and nothing else

<<<EXPLANATION>>>
2-6 concise lines: the fixed elements preserved, the open craft decisions
rethought, and which loaded skill documents governed them

DETERMINISTIC FINDINGS
{{findings}}

CURRENT PROMPT TO REBUILD
{{current}}`,

  handoff: `The clip below has been generated and watched. Your job is to state
what the NEXT clip inherits from it — nothing else.

Read the prompt as a record of what is now on screen. Write the hand-off from
the END of it: the final state, not a summary of the whole clip.

Be concrete and physical. Where the characters are, what they are doing, what
the light is, what is in shot, what has changed. This paragraph will be handed
to the director of the next clip as the state the audience arrives in, so an
abstraction ("tension lingers") is useless and a position ("she is three metres
past it, facing away, and has not seen it") is not.

Do not write the next clip. Do not invent events. Do not describe the previous
clip's beginning or middle.

Output exactly three blocks, in this order, and nothing outside them:

<<<PRECEDES>>>
one paragraph: the state the next clip opens on
<<<FOLLOWS>>>
one line: what the next clip has to be able to do from here
<<<OPEN>>>
one line: what is still unresolved, and therefore still available

PROMPT OF THE CLIP THAT JUST LANDED
{{current}}`,

  freeform: `You are working on this prompt with me, in conversation. What
follows is where it stands; my messages continue from here.

The loaded documents govern any craft judgement you make. Keep answers short
and concrete.

If I ASK SOMETHING — why a choice was made, what a rule means, whether an idea
would work — just answer in plain prose. Do not restate the prompt and do not
rewrite it.

If I ASK FOR A CHANGE, make it and reply with exactly three blocks, nothing
outside them:

<<<PROMPT>>>
the complete updated prompt
<<<EXPLANATION>>>
2-6 lines: why, in terms of the loaded documents
<<<CHANGES>>>
- one line per edit: what you changed, and why

Change only what I asked for. Keep the field structure, the formatting and
every untouched line exactly as they are.

THE PROMPT AS IT STANDS
{{current}}`,

  breakdown: `Read the source below and decide how many clips it needs.

One H3 clip runs roughly 6-15 seconds, and one clip carries one dramatic unit
— a single change, not several. If the source genuinely fits in one clip, say
so and return exactly one.

For each clip, decide:
- index (1-based)
- title — a short name for it
- role — one of opening / rising / turn / falling / closing, or "standalone"
  if there is only one clip in total
- seconds — its target length
- covers — what happens in this clip, in fixed elements only (who, where,
  what happens, how it ends): no camera, no shot construction, that is the
  next stage's job
- precedes — what the audience arrives at THIS clip having just seen. Leave
  it empty for the first clip, which has nothing before it.
- follows — what the NEXT clip must be able to open on

Also give the whole film's spine in one line.

Output ONLY a JSON object, no fences, no prose outside it, in exactly this
shape:

{
  "spine": "...",
  "clips": [
    { "index": 1, "title": "...", "role": "...", "seconds": 10, "covers": "...", "precedes": "...", "follows": "..." }
  ]
}

SOURCE
{{story}}`,
}

/** The user's override for a stage if they set one, otherwise the default. */
const PROMPT_MARK = '<<<PROMPT>>>'
const EXPLANATION_MARK = '<<<EXPLANATION>>>'
const CHANGES_MARK = '<<<CHANGES>>>'
const MARKS = { prompt: PROMPT_MARK, explanation: EXPLANATION_MARK, changes: CHANGES_MARK } as const

/** Strip a ```json fence (or a bare ``` fence) around a reply, if present. */
function stripFence(text: string): string {
  const m = text.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```\s*$/)
  return (m ? m[1] : text).trim()
}

function parseJsonReply(text: string): { prompt: string; explanation: string; changelog: string[] } | null {
  const stripped = stripFence(text)
  if (!stripped.startsWith('{')) return null
  try {
    const obj = JSON.parse(stripped) as { prompt?: unknown; explanation?: unknown; changes?: unknown }
    if (typeof obj.prompt !== 'string' && typeof obj.explanation !== 'string') return null
    const changelog = Array.isArray(obj.changes)
      ? obj.changes.map((c) => String(c).trim()).filter(Boolean)
      : typeof obj.changes === 'string'
        ? obj.changes
            .split('\n')
            .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
            .filter(Boolean)
        : []
    return {
      prompt: typeof obj.prompt === 'string' ? obj.prompt.trim() : '',
      explanation: typeof obj.explanation === 'string' ? obj.explanation.trim() : '',
      changelog,
    }
  } catch {
    return null
  }
}

/**
 * Split a marked reply into its blocks, in ANY order — the model is asked for
 * a fixed order but not enforced on it, and getting the order right matters
 * less than getting the content into the right bucket.
 */
function splitMarkers(text: string): { prompt: string; explanation: string; changelog: string[] } {
  const positions = (Object.entries(MARKS) as [keyof typeof MARKS, string][])
    .map(([key, mark]) => ({ key, mark, index: text.indexOf(mark) }))
    .filter((p) => p.index !== -1)
    .sort((a, b) => a.index - b.index)

  if (!positions.length) return { prompt: text, explanation: '', changelog: [] }

  const parts: Partial<Record<keyof typeof MARKS, string>> = {}
  for (let i = 0; i < positions.length; i++) {
    const { key, index, mark } = positions[i]
    const end = i + 1 < positions.length ? positions[i + 1].index : text.length
    parts[key] = text.slice(index + mark.length, end).trim()
  }

  const changelog = (parts.changes ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter(Boolean)

  return { prompt: parts.prompt ?? '', explanation: parts.explanation ?? '', changelog }
}

/**
 * Split a reply into the prompt, its explanation and its changelog.
 *
 * The contract is asked for, not enforced — a model that ignores it still
 * produces a usable prompt, so an unmarked reply is treated as all prompt
 * rather than being rejected. A JSON reply (optionally fenced) is accepted
 * too, since some models prefer structured output to markers.
 */
export function splitReply(raw: string): { prompt: string; explanation: string; changelog: string[] } {
  const text = raw.trim()
  return parseJsonReply(text) ?? splitMarkers(text)
}

/** Did the model choose to rewrite, or just answer? */
export function hasPromptBlock(raw: string): boolean {
  const text = raw.trim()
  if (text.includes(PROMPT_MARK)) return true
  const json = parseJsonReply(text)
  return !!json && !!json.prompt
}

const HANDOFF_MARKS = ['<<<PRECEDES>>>', '<<<FOLLOWS>>>', '<<<OPEN>>>'] as const

/**
 * Pull the three hand-off fields out.
 *
 * As with splitReply the contract is asked for, not enforced: a model that
 * ignores the markers still said something useful, so an unmarked reply becomes
 * `precedes` rather than an error.
 */
export function splitHandoff(raw: string): { precedes: string; follows: string; open: string } {
  const text = raw.trim()
  const [p, f, o] = HANDOFF_MARKS.map((m) => text.indexOf(m))
  if (p === -1) return { precedes: text, follows: '', open: '' }
  const cut = (from: number, mark: string, to: number) =>
    text.slice(from + mark.length, to === -1 ? undefined : to).trim()
  return {
    precedes: cut(p, HANDOFF_MARKS[0], f === -1 ? o : f),
    follows: f === -1 ? '' : cut(f, HANDOFF_MARKS[1], o),
    open: o === -1 ? '' : cut(o, HANDOFF_MARKS[2], -1),
  }
}

/** Where a clip sits next, once the one before it has landed. */
export function nextRole(role: ClipRole): ClipRole {
  // Deliberately NOT a march along the curve. A film's middle runs as long as
  // it needs to, and deciding that a clip is the TURN is the one judgement a
  // director must not have made for them — so 'rising' holds until it is
  // changed by hand, and only the unambiguous steps advance.
  switch (role) {
    case 'standalone':
      return 'opening'
    case 'opening':
      return 'rising'
    case 'turn':
      return 'falling'
    case 'falling':
      return 'closing'
    default:
      return role // rising holds; closing stays closing
  }
}

/**
 * The clip's place in a longer film.
 *
 * The craft documents give each clip its own formula, which is right for a
 * standalone clip and wrong for clip four of nine — apply it everywhere and a
 * film becomes a row of miniature complete films, each hooking, escalating and
 * resolving, none of them going anywhere together.
 */
export function filmBlock(f: FilmContext | undefined): string {
  if (!f) return ''

  // A breakdown clip may set `covers` without ever setting a role beyond
  // 'standalone' (a source that turned out to fit in one clip) — that still
  // needs saying, even though the "part of a longer film" machinery below
  // does not apply.
  const coversBlock = f.covers
    ? `THIS CLIP COVERS exactly: ${f.covers}. Direct only this. The rest of the source is context for continuity, not material to shoot.\n`
    : ''

  if (f.role === 'standalone') return coversBlock

  const roleLine: Record<Exclude<ClipRole, 'standalone'>, string> = {
    opening: 'This clip OPENS the film. It is the only one that may establish — it earns its hook. It must not resolve.',
    rising: 'This clip is in the RISE. It inherits pressure already built and raises it. It has no hook of its own and no resolution — it is a middle.',
    turn: 'This clip is the TURN — the one moment the situation changes. Everything before points at it and everything after follows from it. It does not re-establish and it does not settle.',
    falling: 'This clip is AFTERMATH. The break has happened; this shows the cost. It must not introduce a new hook or a new escalation.',
    closing: 'This clip CLOSES the film. It is the only one that may resolve, and it resolves what the film set up — not something of its own.',
  }

  return `THIS CLIP IS PART OF A LONGER FILM — DIRECT IT AS A PART, NOT A WHOLE

${roleLine[f.role as Exclude<ClipRole, 'standalone'>]}

${coversBlock}${f.spine ? `The film is about: ${f.spine}
` : ''}${f.precedes ? `The audience arrives here having just seen: ${f.precedes}
` : ''}${f.follows ? `The next clip has to be able to open on: ${f.follows}
` : ''}
Consequences you must honour:

- Do NOT give this clip its own hook, escalation curve and aftermath. A clip
  that arcs completely is a short film, and a row of short films is not a film.
- The five anchors belong to the FILM. Carry them; do not invent a new set for
  this clip. Continuity of motif and object is what makes separate clips read
  as one piece.
- Its escalation is a SLICE of the film's curve — where it starts and where it
  hands off — not a curve of its own.
- Open on the state the previous clip left, and end on the state the next one
  needs. State both explicitly at the top of the sheet.
- Nothing may be re-established that the audience already has.
`
}

export function templateFor(overrides: Partial<Record<StageId, string>> | undefined, stage: StageId): string {
  return overrides?.[stage] ?? DEFAULT_TEMPLATES[stage]
}

export function fillTemplate(
  template: string,
  vars: {
    story?: string
    current?: string
    mode?: string
    notes?: string
    findings?: string
    critique?: string
    film?: string
    /** The deterministic read of the source — see `classifyInput` / `standingToText` in lint.ts. */
    standing?: string
    /** The prompt that produced the rendered parent clip, for continuation Direct. */
    previous?: string
  },
): string {
  return template
    .replace(/\{\{film\}\}/g, vars.film?.trim() ?? '')
    .replace(/\{\{story\}\}/g, vars.story ?? '')
    .replace(/\{\{current\}\}/g, vars.current ?? '')
    .replace(/\{\{mode\}\}/g, vars.mode ?? '')
    .replace(/\{\{critique\}\}/g, vars.critique?.trim() || '(no review recorded — judge it against the loaded documents yourself)')
    .replace(/\{\{findings\}\}/g, vars.findings?.trim() || '(the deterministic check found nothing)')
    .replace(/\{\{notes\}\}/g, vars.notes ? `ALSO\n${vars.notes}` : '')
    .replace(/\{\{standing\}\}/g, vars.standing?.trim() || '(not computed)')
    .replace(/\{\{previous\}\}/g, vars.previous?.trim() || '(none — this is the first clip)')
    .trim()
}

/**
 * Parse a Breakdown out of a reply — strip any fence, take from the first
 * `{` to the last `}` (a model sometimes wraps the JSON in a sentence or
 * two despite being told not to), then validate and coerce the shape rather
 * than trusting it.
 */
export function parseBreakdown(raw: string): Breakdown | null {
  const text = stripFence(raw.trim())
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  let obj: unknown
  try {
    obj = JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
  if (!obj || typeof obj !== 'object') return null
  const o = obj as { spine?: unknown; clips?: unknown }
  if (typeof o.spine !== 'string' || !Array.isArray(o.clips) || !o.clips.length) return null

  const ROLES: ClipRole[] = ['opening', 'rising', 'turn', 'falling', 'closing', 'standalone']
  const single = o.clips.length === 1

  const clips: BreakdownClip[] = o.clips.map((item, i) => {
    const c = (item ?? {}) as Record<string, unknown>
    const role = ROLES.includes(c.role as ClipRole) ? (c.role as ClipRole) : single ? 'standalone' : 'rising'
    return {
      index: Number(c.index) || i + 1,
      title: typeof c.title === 'string' ? c.title.trim() : '',
      role,
      seconds: Number(c.seconds) || 0,
      covers: typeof c.covers === 'string' ? c.covers.trim() : '',
      precedes: typeof c.precedes === 'string' ? c.precedes.trim() : '',
      follows: typeof c.follows === 'string' ? c.follows.trim() : '',
    }
  })

  return { spine: o.spine.trim(), clips, at: Date.now() }
}
