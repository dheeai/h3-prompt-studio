# 2026-09-19 · 19 older prompts, re-authored through preset A and preset B

Three arms kept side by side: `old/` as the source project wrote it, `new-A/`
and `new-B/` re-authored from the same brief, `plans/` shared by all three.

Sources: `sakhubai_h3` (4 × 10s), `veyra-cloudsilk-ugc-60s-draft` (4 × 15s,
4-shot), `gyantv-pte-01` (11, latest of 6–9 versions each, structured shots
with exact `startTime`/`endTime`, dialogue and per-shot sound).
`structured-h3-lira-acting-smoke` was excluded — all 8 files have an empty
description.

Authored on `swift-qwen38-27b`. The founder's designated model is
`swift-uncensored-27b`; the wrong slug was used because the model list was
truncated at 20 entries and the right name is the 21st. Left as-is by founder
decision — "mostly equivalent, and we are interested in the prompt anyway" —
and GEPA optimises against the correct model.

## Result

```
ALL 19          old 0.643    new-A 0.649    new-B 0.698

B > A   13/19        A > old   10/19        B > old   15/19
```

**Preset B wins. Preset A is a coin flip against the old pipeline.** B's
margin sits in acting (0.83–0.96 against old's 0.57–0.83) and camera —
the two things its extra calls exist to produce. Of B's 6 losses, 4 are inside
±0.03; only `scene_10` (−0.093) and `sakhubai-2` (−0.053) are real.

B's one consistent weakness is DROPPING DIALOGUE — 0.24–0.37 on several gyantv
scenes where A kept it.

## The correction that changed the headline

The old arm first scored 0.603, and preset A appeared to beat it. That was a
bug in this script's conversion, not a property of the prompts:

- `gyantv` stores dialogue as `{speakerId, language, exactWords}` and the
  converter looked for a `line` key,
- `veyra` ships `spokenLinesAudio` ALREADY in H3 form (`<d>[English] (S1) …</d>`)
  and the converter ignored it.

Both rendered the old arm with **no dialogue at all**, scoring 0.11–0.45 on
that dimension. Fixing it moved the old arm **+0.040** and erased preset A's
apparent advantage. Convert losslessly or do not claim to be comparing.

## Reading these numbers

The plan is derived from each old prompt's own structure, which FAVOURS the old
arm — it trivially matches a plan taken from itself. B winning anyway is the
robust direction.

The old prompts carry no `subject_definitions` or `retention_analysis`; those
were not invented, so the old arm takes a structural hit that reflects a format
difference rather than quality.

n = 19 from three projects. Per-prompt margins are well above the judge's
±0.002 aggregate noise, but this is not a general claim about the presets, and
nobody has watched a rendered clip from any of them.
