---
name: h3-acting
description: Direct PERFORMANCE in an H3 scene — master character profiles, per-scene objective/obstacle/stakes, and per-shot tactic and observable behaviour. Use when a character has to act. Not for authoring reference images; that is h3-lira.
---

# ACTING — performance direction for H3 scenes

ACTING governs what a character *does*. It is a separate system from LIRA,
which authors the reference image the scene cites. LIRA decides what the
character looks like; ACTING decides how they behave.

The whole system describes **observable behaviour, never emotion labels**.
"Anxious" is not filmable. A hand that returns twice to a pocket is.

## Master profile — once per character

Wardrobe-independent, camera-independent, lighting-independent. It travels
with the character across every scene.

- `masterProfile` — 150–220 words of observable, wardrobe-independent behaviour
- `voicePrompt` — a fixed 1–2 sentence vocal identity
- `objectiveEngine` — what this person is always trying to get
- `physicalBaseline` — how they hold themselves at rest
- `eyeLife` — where the eyes go, and when
- `signatureTics` — each paired with the trigger that fires it
- `mask` and `crackTrigger` — the presented self, and what breaks it
- `softeningTarget` — optional; who or what lowers the mask

The profile must **prohibit** camera, wardrobe, lighting, colour, and
unfilmable psychology. Those belong to other layers and will fight them here.

## Per scene

- `objective` — what they want in this scene
- `obstacle` — what is in the way
- `stakes` — what it costs to fail
- `physicalBusiness` — what the hands are doing
- `bodyState`
- `eyeLife`
- optional `subtext`, `statusDynamic`, `proxemics`
- `voiceProfiles` — empty only for a silent scene; otherwise exactly one entry
  per dialogue subject, its `voicePrompt` copied verbatim from that
  character's master profile

## Per shot

- `subjectId`
- `tactic` — how they pursue the objective in *this* shot
- `observableBehavior`
- `beatChange` — what is different by the end of the shot
- optional `reaction`, `assessmentMoment`, `interruptedAction`

Every shot containing a character needs at least one acting entry, and every
`subjectId` must belong to that shot. Environment-only shots may omit acting
entirely.

## What must survive compilation

Performance folds into the scene setup and each shot's action prose. It must
not disturb:

- the official six H3 sections
- reference routing and subject-label remapping
- exact dialogue ownership and `<d>` tags
- each fixed voice identity placed outside `<d>`, immediately before that
  subject's first line, emitted once per dialogue subject
- the controlled camera vocabulary
- no voice language at all when there are no spoken lines

Never emit schema field names into the prompt, and never paste a whole master
profile verbatim into a scene.

---

Extracted from an internal H3 integration design spec.
The field vocabulary and constraints are verbatim; the framing is not.
