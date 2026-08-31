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

Follow the official field structure from the loaded documents literally — field
names, order and formatting exactly as specified there, not a paraphrase of
them. Render the direction sheet below; do not re-direct it, and do not invent
beats it does not contain.

Output the prompt and nothing else — no preamble, no explanation, no fences.

DIRECTION SHEET
{{current}}

SOURCE (for reference only)
{{story}}`,

  critique: `Audit the prompt below against the loaded documents.

Be specific and hostile. For each problem: quote the exact text, name the rule
it breaks, and say what it will do to the render. Prefer the failure modes the
documents record from real measurements over general prompt-writing advice.

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

  revise: `Apply the findings to the prompt and output the corrected prompt only.

Change what the findings identify and leave everything else exactly as it is.
Do not restructure, do not "improve" untouched lines, do not add a preamble or
an explanation. Output the prompt and nothing else.

FINDINGS
{{findings}}

{{notes}}

PROMPT
{{current}}`,

  freeform: `Apply this instruction to the prompt and output the corrected prompt only.

Change only what the instruction asks for. Keep the field structure, the
formatting and every untouched line exactly as they are. Do not add a preamble
or an explanation. Output the prompt and nothing else.

INSTRUCTION
{{notes}}

PROMPT
{{current}}`,
}

export function fillTemplate(
  template: string,
  vars: { story?: string; current?: string; mode?: string; notes?: string; findings?: string },
): string {
  return template
    .replace(/\{\{story\}\}/g, vars.story ?? '')
    .replace(/\{\{current\}\}/g, vars.current ?? '')
    .replace(/\{\{mode\}\}/g, vars.mode ?? '')
    .replace(/\{\{findings\}\}/g, vars.findings ?? '(none recorded — audit it yourself)')
    .replace(/\{\{notes\}\}/g, vars.notes ? `ALSO\n${vars.notes}` : '')
    .trim()
}
