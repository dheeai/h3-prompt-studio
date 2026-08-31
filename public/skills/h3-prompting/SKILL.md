---
name: h3-prompting
description: Write a MiniMax H3 (Hailuo 03) video prompt in the OFFICIAL format — full-reference (ref2va) or base (T2VA / I2VA / FL2VA / L2VA). Use whenever authoring or reviewing a prompt for H3: reference-to-video with images/video/audio refs, garment or subject swaps, video edits and continuations, timecoded multi-cut scenes, dialogue and soundscape direction. Carries the verbatim official guides from MiniMaxAI/MiniMax-H3 plus the failure modes measured on our own runs.
---

# MiniMax H3 prompt authoring

H3 renders a whole scene — several cuts, camera moves, ambience, foley and
dialogue — in ONE generation, up to ~15s at 24fps, with a native stereo audio
track it synthesises **from the prompt text**. The prompt is therefore both the
shot list and the sound mix. Getting the format wrong does not produce a
slightly worse clip; it produces a garbled or structurally flat one.

## The two guides — read the right one

| Mode | Guide | Use when |
|---|---|---|
| **Full-reference** (`ref2va`) | `references/ref_guide.md` | Any reference image / reference video / reference audio is wired. Six named sections. |
| **Base** (T2VA / I2VA / FL2VA / L2VA) | `references/base_guide.md` | Text-only, or first/last-frame anchoring only. Three core fields. Also the authority for shot, camera, speaker, dialogue and sound formats, which full-reference INHERITS. |

Both are verbatim copies of `MiniMaxAI/MiniMax-H3/docs/*` on HuggingFace
(`https://huggingface.co/MiniMaxAI/MiniMax-H3/raw/main/docs/…`). Read the actual
file before authoring — the summary below is an index, not a substitute.

## Full-reference: six sections, fixed order

```
subject_definitions:   what each label denotes, its role, features to follow
summary:               [task type] one paragraph, using the labels
retention_analysis:    one line per label + a fixed relationship marker
detailed_description:  the body — shot by shot, in playback order
overall_soundscape:    ambience + physical sound, NO voices
non_diegetic_music:    audience-only score: instrumentation, tempo, dynamics
```

### The four labels — and the one that is always got wrong

| Label | Meaning |
|---|---|
| `<Subject N>` | **Reusable visible content** — a person, environment, garment, prop, style, action, pose. This is the normal case. |
| `<Picture N>` | An image acting as a **concrete frame anchor** — first frame, keyframe, last frame, composition/storyboard anchor. |
| `<Video N>` | **Whole-video relationship only** — the edit source, a continuation start point, or the camera/cut/rhythm/temporal structure. |
| `<Audio N>` | An audio signal copied or referenced. |

> **An anchor plate that only defines a character, scene, costume or style is a
> `<Subject N>`, not a `<Picture N>`.** The image is cited *inside* the subject
> definition (`<Subject 1> is the woman in <Picture 1>, with …`) and gets no
> standalone `<Picture N>` line. Our first implementation used a bare
> `<Picture N>` binding clause built from third-party write-ups and had the label
> wrong throughout.

Content pulled out of a reference video is still a `<Subject N>`; `<Video N>`
never replaces subject labels. One subject may cite several assets:
`<Subject 1> is the woman whose appearance comes from <Picture 1> and whose
walking motion comes from <Video 1>.`

`<Video N>` and `<Audio N>` number **independently** — the same file can be
`<Video 1>` and `<Audio 2>`. A reference video does not create an `<Audio N>`
merely because it has sound; only wire and declare one if the audio is used.

### Task-type prefix on `summary`

`keyframe completion` · `reference generation` · `video editing` ·
`video continuation` · `audio reuse` · `audio reference` — combined with ` + `.

A reference video supplying only camera/cuts/rhythm is `reference generation`,
NOT `video editing`. Use `video editing` only when that video is actually
modified — and then open the summary with the fixed line
`The target video is an edited version of <Video 1>.`

### Relationship markers (fixed English values)

Visible (`<Subject>` / `<Picture>` / `<Video>`): `fully_preserved` ·
`partially_preserved` · `attribute_transfer` · `weak_reference`.
Audio (`<Audio>`): `fully_copy` · `partially_copy` · `reference` ·
`weak_reference`.

`attribute_transfer` is the marker for a **swap** — a garment, style or trait
moved onto a different identifiable target subject. Never write `(Sx)` in
`retention_analysis`.

## `detailed_description` — the body

- 350–500 English words for a generation task. Measured outputs land near 200
  and that is too thin. Reach the range by covering, **per shot**: composition
  and framing · each subject's appearance and **position in frame** ·
  environment and light · the action **as a state change** · camera motion ·
  the sound in that moment · where each reference actually takes effect.
- Style opens in **one or two sentences BEFORE `[Shot 1]`** (full-reference
  differs from T2VA here, where style goes after the marker).
- **`[Shot 1]` carries NO timestamp.** Later shots are
  `[Shot N] At MM:SS.mmm, the shot cuts to …`, strictly increasing.
- A cut must bring new information. If only distance or angle changes, move the
  camera instead.
- **Camera motion must use the controlled vocabulary verbatim**, as natural
  English inside the shot, never stacked as a label:
  `Zoom In/Out` · `Push In` · `Pull Out` · `Pan Left/Right` ·
  `Truck Left/Right` · `Tilt Up/Down` · `Pedestal Up/Down` · `Arc Shot` ·
  `Tracking Shot` · `Static Shot` · `Shake Slightly/Strongly` · `POV` ·
  `Roll Clockwise/Counterclockwise`; optional `with small/large amplitude`,
  `at slow/fast speed`. "in a static medium shot" does **not** register as
  `Static Shot`; "slow dolly forward" does not register as `Push In`.

## Dialogue — the rule that garbles the audio

**If the prose says anyone speaks, those words MUST appear in a `<d>` tag. If
there are no words, nothing may be described as speaking.**

H3 builds the audio from the text. Describe a trembling voice and give it no
words and it synthesises a trembling voice saying nothing — voice-shaped noise
that sounds like a corrupted file. Measured on a shipped 35-section film: one
scene asserted speech three times with zero `<d>` tags; re-rendering with the
line supplied, changing nothing else, produced clean speech. Resolution, model,
steps and caching were each falsified first. This applies to background voices
too — a shouting crowd with no words becomes babble; describe it non-vocally.

Every spoken line needs **both**:

1. a speaker id `(S1)` / `(S2)` / `(S1,S2)` on the speaker, before the verb;
2. `<d>[Language] the exact words</d>`.

```
<Subject 2> (S1) — a woman in her late thirties, warm mid-range voice, unhurried — looks up and says quietly: <d>[English] Could you say that again?</d>
```

Establish the vocal identity (age, register, pace, accent) **outside** the tag,
or H3 picks a voice at random and drifts. `(Sx)` is assigned once in order of
vocal events and reused everywhere. Voiceover uses the exact phrase `says in an
off-screen voiceover`, then state the lips stay closed. Dialogue crossing a cut
takes `<scenetrans>` both sides; speech truncated by the ending takes `<cutoff>`.

**`overall_soundscape` carries NO voice at all** — not even in the abstract.
"her voice carries a trembling quality" there is a second instruction to
synthesise speech in a layer that must not contain any, and it garbles the mix.
Breath, footsteps, fabric, impacts, ambience, a gasp: yes. Anything conveying
words: no.

To suppress invented speech in a silent scene, avoid every speech verb
(`speak`, `says`, `her voice`, `murmurs`, `calls out`, `replies`, …) — including
in a denial like "she does not speak", which still trips the check. Write
"her lips stay closed and the call is silent."

## Mechanics that are not the prompt's job

Our runner (`comfy.minimax_h3_r2v`, `~/.kshana/runners/dhee-runner-minimax-h3`)
owns these; do not hand-write them into an authored prompt:

- `subject_definitions` and `retention_analysis` are emitted by
  `buildSubjectSections()` from the resolved reference list — the author cannot
  know the final slot order after routing, capping and background-last.
- `repairH3Prose()` deterministically fixes the two defects models keep
  producing: a missing `(Sx)`, and a timestamp on `[Shot 1]`. A rule that is
  regex-checkable does not belong in a prompt.
- `auditDialogueIntegrity()` gates speech-described-without-words as **fatal**
  before GPU time is spent.
- **There is no negative prompt.** The ref2va graph is guidance-distilled
  (`BasicGuider`, no CFG), so negatives go in the prose or nowhere.

## Reference plates: multi-view sheets are FINE — the label is what matters

**CORRECTED 2026-08-08 by the founder. The earlier "never feed H3 a contact
sheet" rule was the wrong lesson drawn from a real symptom.** In production the
founder routinely uses **multi-angle character reference sheets and they work
well.** Do not refuse a contact sheet and do not warn about one.

What actually happened in the original probe: the sheet was bound as a bare
**`<Picture N>`**, and `<Picture N>` *means* "this image is a concrete frame
anchor — a first frame, keyframe or composition anchor." Declaring a
seven-panel character sheet to be a literal frame is an instruction to
reproduce it as a frame, and H3 obeyed (bottom ~40% of every frame reproduced
the plate, mid-frame SSIM 0.38). **That was a mislabelling, not a model defect
and not a "leak."** The runner was later fixed to emit `<Subject N>` for
character/scene/costume/style plates, which is the correct label — see the
`<Picture N>` warning in the label table above.

So the operative rule is the LABEL, not the image content:
- character / scene / costume / style plate — including a multi-view sheet →
  **`<Subject N>`**, cited inside the subject definition.
- an image that genuinely IS a frame or a composition/storyboard anchor →
  **`<Picture N>`**.

9 image slots are available. Historical write-up (read with the correction
above): `dhee-cofounder/artifacts/h3-r2v-probe/README.md`.

## Measured cost, so a prompt's duration is an informed choice

`length` is on a **17k+5 frame grid** at 24fps (124 = 5.17s, 243 = 10.125s,
362 = 15.08s, 481 = 20.04s, 719 = 29.96s). **Do NOT treat 362 as a ceiling** —
that was an over-cautious reading of "trained range"; the founder routinely
produces 20s and has produced 30s in a single call (2026-08-11). What actually
binds is VRAM, not the grid: at 1344x768 the box OOMs around 362 frames and the
crash takes ComfyUI down with it, so `/history` comes back EMPTY and a crashed
render is indistinguishable from one never submitted. Trade resolution for
length — 960x544 carries 481 frames comfortably. Cost scales as roughly pixels^1.3, and there is a wall
between 192f (8.0s) and 226f (9.4s). `beta` vs `simple` scheduling is free.
SageAttention buys nothing on the 5090. `ref_image_size: max` (2048 short edge)
buys identity fidelity at several times the cost, because reference tokens ride
through every sampling step.
