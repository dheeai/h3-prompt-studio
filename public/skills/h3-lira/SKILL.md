---
name: h3-lira
description: Author IMAGE prompts for character and scene references — identity sheets, object anchors, location plates, and character-state edits. Use when producing a reference asset that a video prompt will later cite by label. Not for directing performance; that is h3-acting.
---

# LIRA — reference image prompt authoring

LIRA applies **only to image-prompt authoring**: character identity sheets,
object anchors, location plates, and character-state edits. It governs how an
`imagePrompt` is written, not what a character does on screen.

If you are deciding how someone behaves, moves, or reacts, you want
`h3-acting` instead. If you are deciding what the camera shows, you want
`h3-direction`. LIRA is upstream of both — it makes the asset they refer to.

## Rules

- Deconstruct the canonical entity and art-style inputs before writing.
- Diagnose ambiguity and known failure modes first.
- Produce concise natural prose rather than keyword stacks.
- Specify observable materials, lighting, framing, and a source-derived palette.
- Keep aspect ratio and resolution in structured platform fields, not in prompt
  prose.
- Use positive descriptions for generation, and exact preserve/change
  discipline for edits.
- Forbid accidental text, labels, extra subjects, and invented identity
  details.
- Retain the real routing of whichever generator you are using rather than
  carrying product names across runtimes.

## Why prose, not keyword stacks

A keyword stack gives the model a bag of attributes with no relationships
between them. Prose states what is attached to what, which is what identity
consistency actually depends on: whose hair, on which garment, under which
light.

## Edits

An edit prompt is a contract with two halves, and both must be explicit:
what is **preserved** and what **changes**. Naming only the change lets the
model treat everything else as negotiable, which is how identity drifts
between a reference sheet and its edited variant.

---

Extracted from an internal H3 integration design spec.
The rules are verbatim; the framing is not.
