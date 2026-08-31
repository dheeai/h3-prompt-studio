import type { StageId } from './types'

export const STAGE_ORDER: StageId[] = ['direct', 'draft', 'critique', 'revise']

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
    blurb: 'Works out what to show — the anchors, the escalation, a beat grid and a card per cut. Writes no prompt fields.',
  },
  draft: {
    produces: 'the prompt',
    needs: 'anything',
    blurb: 'Turns what is on the page into a prompt, in the official field structure for the chosen mode.',
  },
  critique: {
    produces: 'notes',
    needs: 'prompt',
    blurb: 'Audits the prompt against the loaded skills and lists what is wrong. Changes nothing.',
  },
  revise: {
    produces: 'a corrected prompt',
    needs: 'prompt',
    blurb: 'Applies the notes and leaves every untouched line exactly as it was.',
  },
  freeform: {
    produces: 'a corrected prompt',
    needs: 'prompt',
    blurb: 'Applies one instruction you type, and nothing else.',
  },
}

export const STAGE_LABEL: Record<StageId, string> = {
  direct: 'Direct',
  draft: 'Draft',
  critique: 'Critique',
  revise: 'Revise',
  freeform: 'Note',
}

/**
 * Stage templates. Editable by the user and stored in settings, so these are
 * only the starting point.
 *
 * Placeholders: {{story}} {{current}} {{mode}} {{notes}} {{findings}}
 *
 * Each one deliberately refuses to restate the loaded skills — the skills are
 * already in the system block, and repeating them here would both waste the
 * budget and break the byte-stable prefix that keeps the KV cache warm.
 */
export const DEFAULT_TEMPLATES: Record<StageId, string> = {
  direct: `You are directing, not writing prompts yet.

Read the source below and produce a DIRECTION SHEET, following the loaded craft
documents exactly where they specify a structure.

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

Render the direction sheet below; do not re-direct it, and do not invent beats
it does not contain.

Output the prompt and nothing else — no preamble, no explanation, no fences.

DIRECTION SHEET
{{current}}

SOURCE (for reference only)
{{story}}`,

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

  revise: `Apply the review to the prompt and output the corrected prompt only.

The review below is the judgement of the loaded craft documents — it is the
substance of this pass, and every point in it must be addressed. The
deterministic check that follows is a small set of mechanical rules; honour it
too, but it is not a substitute for the review.

Where a fix requires rewriting the direction rather than editing a field, do
that. Otherwise change what the review identifies and leave everything else
exactly as it is: no restructuring, no "improving" untouched lines.

Output exactly two blocks, in this order, and nothing outside them:

<<<PROMPT>>>
the complete corrected prompt
<<<CHANGES>>>
- one line per edit: what you changed, and which loaded document required it

If a review point needed no edit, say so on its own line and why. Do not
describe edits you did not make.

REVIEW AGAINST THE LOADED DOCUMENTS
{{critique}}

DETERMINISTIC CHECK
{{findings}}

{{notes}}

PROMPT
{{current}}`,

  freeform: `Apply this instruction to the prompt.

Change only what the instruction asks for. Keep the field structure, the
formatting and every untouched line exactly as they are. Where the loaded
documents constrain how the change should be made, follow them.

Output exactly two blocks, in this order, and nothing outside them:

<<<PROMPT>>>
the complete corrected prompt
<<<CHANGES>>>
- one line per edit: what you changed, and why

INSTRUCTION
{{notes}}

PROMPT
{{current}}`,
}

/** The user's override for a stage if they set one, otherwise the default. */
const PROMPT_MARK = '<<<PROMPT>>>'
const CHANGES_MARK = '<<<CHANGES>>>'

/**
 * Split a two-block reply into the prompt and its changelog.
 *
 * The contract is asked for, not enforced — a model that ignores it still
 * produces a usable prompt, so an unmarked reply is treated as all prompt
 * rather than being rejected.
 */
export function splitReply(raw: string): { prompt: string; changelog: string[] } {
  const text = raw.trim()
  const ci = text.indexOf(CHANGES_MARK)
  const body = ci === -1 ? text : text.slice(0, ci)
  const tail = ci === -1 ? '' : text.slice(ci + CHANGES_MARK.length)

  const pi = body.indexOf(PROMPT_MARK)
  const prompt = (pi === -1 ? body : body.slice(pi + PROMPT_MARK.length)).trim()

  const changelog = tail
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\u2022]\s*/, '').trim())
    .filter(Boolean)

  return { prompt, changelog }
}

export function templateFor(overrides: Partial<Record<StageId, string>> | undefined, stage: StageId): string {
  return overrides?.[stage] ?? DEFAULT_TEMPLATES[stage]
}

export function fillTemplate(
  template: string,
  vars: { story?: string; current?: string; mode?: string; notes?: string; findings?: string; critique?: string },
): string {
  return template
    .replace(/\{\{story\}\}/g, vars.story ?? '')
    .replace(/\{\{current\}\}/g, vars.current ?? '')
    .replace(/\{\{mode\}\}/g, vars.mode ?? '')
    .replace(/\{\{critique\}\}/g, vars.critique?.trim() || '(no review recorded — judge it against the loaded documents yourself)')
    .replace(/\{\{findings\}\}/g, vars.findings?.trim() || '(the deterministic check found nothing)')
    .replace(/\{\{notes\}\}/g, vars.notes ? `ALSO\n${vars.notes}` : '')
    .trim()
}
