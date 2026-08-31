---
name: h3-two-hander
description: Write an H3 scene where two people talk and something changes — the fix for a film that came out beautiful and boring. Use whenever a piece reads as a montage of good shots with no story, whenever faces look soft or small, whenever the images look murky next to reference work, and whenever adapting a story into a scene rather than a sequence. Carries the scene contract (blocking, the 180-degree axis, named gaze directions, and a shot-size floor that exists because H3 loses faces at distance), one framing per shot module, an emotion timeline inside each shot, governed camera movement, locating the turn on one word, voice casting, and the suppression rule that separates three confusable cases — a categorical ban stated once works, repeating a specific negation of something already on screen reinforces it (substitute instead), and a described absent modality returns it (use the sentinel). Also when to reach for FL2VA over I2VA, why the frame grid is a directing problem rather than arithmetic, why perceived clarity comes from subject and light rather than lens vocabulary and what a higher bitrate can and cannot fix, and the eight-frame contact sheet that is the only gate that looks at the picture itself.
---

# The two-hander — a scene, not a montage

Most H3 films that disappoint are not badly written. They are **montages**: a
run of well-composed shots, beautiful weather, nobody talking, nothing turning.
Every shot is defensible and the whole is inert.

This skill is the opposite construction. **Two people, one place, one
conversation, one reversal.** It is the smallest unit that is a film rather
than a reel, and it is what almost every strong reference piece in this genre
turns out to be when you take it apart.

Use it with `h3-direction` (which decides *what to show*) and `h3-prompting`
(which governs the official field structure). This skill sits between them: it
decides the SHAPE of a dramatic scene and how to write its shots.

## Symptoms this fixes

If two or more of these are true, you have a montage:

- No one speaks, and the sound design is weather, rooms and architecture.
- The two characters never appear in the same frame looking at each other.
- Faces appear, but no shot's *job* is a face doing one thing.
- The piece escalates events (a storm, a chase, a crowd) but nothing reverses.
- Subjects are small in frame, silhouetted, or seen from behind.
- You could reorder three of the shots and nobody would notice.

## 1. The scene contract — decided once, before any shot

State all of these ABOVE the shot list, as standing facts for the whole scene.
Everything after them inherits them.

**Two people, one location, one continuous exchange.** No third character
enters. No location change. If the story needs a second place, that is a second
scene, not a second shot.

**Blocking locked to frame sides, with the axis and the gaze named.** This is
the single highest-value line in the whole prompt:

> A stands on the LEFT of frame, B on the RIGHT, facing each other about a
> metre and a half apart, adhering to the 180-degree axis. A looks toward frame
> right, B toward frame left. Positions are fixed throughout; they never swap
> and the orientations are never mixed up.

Without it, characters trade sides across a cut and the scene stops reading as
one space. Naming the gaze DIRECTION per character, and forbidding the swap
explicitly, is what makes it hold.

**A shot-size floor for the whole scene — and it is a mitigation, not a taste.**

> The scene avoids wide shots and full-body framing. Coverage is chest-up
> medium shots, close-ups, and facial close-ups. Faces must be large, clear and
> stable.

H3 loses facial fidelity when the whole body is in frame; practitioners running
it locally describe face blur in full-body shots as a standing property of the
model rather than a bad run. So the chest-up discipline is not a style — it is
how you keep a face sharp enough to act. If you need an establishing frame,
write it the way the good references do: *an opening wide-medium shot that
still does not show full body, the two figures' chest-up outlines placed in the
landscape.* A wide that is still a chest-up.

**A declared duration for every shot.** Treat shot length as a required field,
not an afterthought. Under ~10s per generated clip is the stable range.

**Dialogue is the spine.** Write the lines first and hang the timings off them.
A two-hander with no dialogue is the montage you were trying to escape.

## 2. The shape

The reference pattern, which recurs across unrelated films:

| shot | on | framing | job |
|---|---|---|---|
| 1 | A | chest-up, 2/3 profile toward B | poses the question, from strength |
| 2 | B | over A's shoulder, B dead centre | the long build — several emotional slices |
| 3 | A | **the identical setup to shot 1**, B's voice off-screen | the strength drains out |
| 4 | B | facial close-up, tighter than anything before | the payoff line |

Five shots when there is an environment worth establishing: put the
wide-medium two-shot first and let the rest follow.

**Shot 3 is the load-bearing one, and it is written as an equality
constraint:**

> Hard cut back to A at the same angle, with focal length, lighting, camera
> position and framing identical to shot 1.

Naming the return as *equal to an earlier shot* is what makes cut–cut–cut read
as one continuous scene rather than three unrelated locations. Do not
re-describe the setup in fresh words and hope it matches; say it is the same.

**Ladder the lens inward as pressure builds** — a wide-medium, then a chest-up,
then a facial close-up, then eyes — and release at the end. Name the focal
length every time (e.g. 70mm → 85mm → 100mm). A scene shot entirely on one
lens has no escalation of scale to spend.

## 3. Writing a shot module

**Exactly one framing per module.** If the camera cuts, that is a new module.
A block headed "over-the-shoulder on B" whose body cuts back to A twice is the
most common defect in otherwise excellent reference prompts — it produces set
drift and the wrong speaker on screen. One header, one framing, no exceptions.

**Give the shot an emotion timeline, not a description.** A 10-second shot
described once goes static. Slice it:

> 5.8–9.0s  She hears it. The pupils shrink, the brow draws very slightly in,
>           the gaze flicks away and comes back. Breath catches. [line]
> 9.0–12.8s Water rises along the lower lids, lashes tremble, she does not
>           blink it away. [line]
> 12.8–16.5s The composure is gone; what is left is plain and unguarded.

Each slice: a physical state, and at most one line of dialogue.

**Write observable muscle action, never an emotion label.** "Conflicted" is not
filmable. "The jaw sets and the lower lip goes unsteady for half a beat" is.
Give each beat a short expression line in plain physical language — brows,
lids, gaze, jaw, breath, mouth.

> Do NOT use FACS action-unit codes. They appear in some admired reference
> prompts, and they are largely decorative there: in one widely-copied example
> roughly half were wrong (a code that is not an action unit at all; two others
> glossed as the opposite of what they mean), and the plain-language phrase
> beside each code was carrying the direction. A later film by the same author
> dropped the codes entirely with no loss. Write the physical description. If
> you want the precision of a code, pair it with the description — never alone.

**Mark off-screen dialogue as off-screen**, so the cut lands on the listener:

> B, off-screen from frame right: "[line]" — A's expression does not change,
> and then it does.

The shot is the *reaction*. This is most of what shot 3 is for.

**Describe a reverse shot by what is BLURRED in the foreground.** Occlusion is
how you tell the model where the camera is:

> From over A's shoulder — A's shoulder, neck and collar blurred in the lower
> left foreground, occupying a fifth of the frame; B centred, chest-up, sharp.

## 4. The turn, located on one word

A scene needs a reversal, and a reversal lives in a line. Decide which single
word carries it and say so:

- in the shot module: `Stress "soul" and "heart".`
- in the closing intent block: *"the whole scene turns on the last line: 'I did.'"*

If you cannot name the word the scene turns on, the scene does not turn yet —
go back to `h3-direction` before writing prompt fields.

**And fix the semantics before the visuals.** Every metaphor must resolve to a
concrete physical action a camera can see. "Piecing together a shattered dream"
staged as assembling a map reads as abstract and lands on nobody; the same beat
staged as repairing a child's rocking horse is specific and carries the feeling.
If a beat cannot be named as an action performed on an object, it is not
directable yet — no amount of lens and grade language will rescue it.

## 5. Camera movement — always governed

Movement is available and worth having. It fails when it is unbounded. Every
move gets **type + speed qualifier + limit**:

- `Camera nearly static, with only an extremely slow push-in.`
- `An extremely slow lateral arc following his eyeline.`
- `The lens arcs around them less than 30 degrees, without rapid rotation.`

Then close it from the other side in the negative block: *no rapid circling, no
whip pans, no fast push-pull.* A bare "the camera circles them" is what
produces the swooping, weightless move that reads as AI.

**Spend movement where it means something** — the slow push-in belongs on the
shot where the turn lands, not on the establisher.

## 6. Voice

Cast the voice as precisely as the face, and give it an arc:

> A: a low, warm baritone, slow, with an old tiredness under it — composed and
> probing at first, then caught out, then gentle.
> B: a clear, cool mezzo — careful, then firm, then unsteady at the end.

Then protect its texture: keep audible breaths, the catch before a line, the
tremble on a tail syllable, chest resonance. **Say explicitly not to denoise or
smooth the voice.** Lip-sync accuracy to every syllable is worth stating too.

If narration or music will be added later, keep them out of the generation and
layer them in post — three sources competing in one render drown each other.

## 7. Generation mode, and living with the frame grid

**Pick the mode from the shape of the action.**

- Ordinary shot, open-ended movement → **I2VA**, first frame only.
- An action with a definite END STATE — sheathing a blade after inspecting it,
  setting a cup down, a door closing — → **FL2VA**, locking first *and* last
  frame. Given both ends the model has to land the action; given only the start
  it often does not arrive.

**The frame grid is a directing problem, not just arithmetic.** H3 snaps
duration to its internal grid, so the generated length rarely equals the length
the edit wants. Trimming the tail to fit cuts the end off the action, which is
the part that carries the meaning. Instead: **pace the action so it completes
inside the snapped length, and hold the completed state** for the remainder.
Write the hold explicitly — "he stays like that, unmoving, until the end of the
shot".

## 8. Making the image read as clear

A common and wrong diagnosis: "their footage looks crisp and graded, ours looks
flat — they must be specifying more lenses and cameras." Usually the reverse is
true. Reference work that looks *crystalline* often carries a very short
optical spec — photorealistic, an aspect ratio, subtle film grain, shallow
depth of field, one focal length per shot — and a **one-line palette**.

Perceived clarity and colour gradation come from **subject and light**, not
from optical vocabulary:

| reads as clear | reads as murky |
|---|---|
| daylight, or a warm practical you can see | flat, directionless, overcast |
| two or three saturated hues in contrast | one accent colour on grey |
| clean air | volumetric haze, dust, heavy rain |
| detail held in the mid-tones | crushed near-blacks |
| subject large in frame | subject small, silhouetted, backlit |

A grade written as *crushed shadows, cold slate mid-tones, thick atmosphere* is
a specification for a low-information image, and the model will deliver one
faithfully. If a scene must be dark or wet, accept that it will not also be
crisp, and spend the clarity budget on the faces.

Three production notes that belong to the render rather than the prompt, but
decide how the result reads:

- **Step count.** Too few steps costs micro-detail and can degrade dialogue
  clarity along with the picture.
- **A finishing pass.** An upscale adds apparent acuity and cleans generation
  artefacts.
- **Encode generously** — haze and near-blacks band badly at a modest bitrate,
  and banding is what people mean by "no gradation".

**But be precise about what encoding can fix.** A higher bitrate removes
BANDING, which is an encode artefact. It cannot restore DETAIL the model never
generated: a face that came out soft in the source is a faithfully preserved
soft face at any bitrate. If faces are the problem, the fixes are upstream —
frame closer, raise the generation resolution, add steps, or run a dedicated
face-restoration pass. Do not reach for the encoder to fix the generator.

## 9. Translating this into the official H3 fields

This skill decides the scene; `h3-prompting` owns the field structure. The map:

- **subject_definitions** — the two characters, from the character contract:
  age, build, face, hair, wardrobe, and the voice casting line.
- **summary** — one line: who, where, and what changes.
- **retention_analysis** — which subject appears in which shots, and what must
  be preserved exactly.
- **detailed_description** — the scene contract: the blocking and axis, the
  shot-size floor, the palette and light, and the invariants that hold for
  every shot.
- **[Shot N]** — one module per framing, with its timecode, focal length, the
  emotion timeline, the expression lines, and the dialogue.
- **overall_soundscape** — the voice arcs, the do-not-denoise instruction, and
  a sparse, sourced ambience placed in time.
- **non_diegetic_music** — `N/A` when there is no score. Never a sentence
  describing the absence of music; that is a specification of a score with
  "don't" in front of it, and you will get one.

## 10. Suppression — by substitution or sentinel, never by description

**Naming a thing instructs the model to produce it, negation or not.** But that
is not a blanket ban on negatives; there are three distinct cases and confusing
them is what goes wrong.

| case | works | what to write |
|---|---|---|
| a **categorical** class, banned ONCE, up front | **yes** | one line: no subtitles, on-screen text, watermarks or logos |
| a **specific element already appearing** on screen | **no — repeating it reinforces it** | delete its vocabulary entirely; positively describe what occupies that space instead |
| an **absent modality** described in prose | **no — returns the modality** | the sentinel: `non_diegetic_music: N/A` |

The middle row is the one that surprises people. A practitioner trying to remove
coloured lines from a riverbank wrote "no red lines" repeatedly and the model
kept producing them; deleting every mention and instead positively describing
soil, rock, river water and snow fixed it immediately. Each negation
re-specifies the thing, and the space still has nothing else to be.

**So the repair for a persistent unwanted element is never a stronger negative.
It is substitution:** say what is there instead, concretely.

The same logic explains the music sentinel. `N/A` is a null — nothing to
synthesise. A careful paragraph explaining there must be no score, no melody, no
bass, is a detailed specification of a score with "don't" in front of it, and it
returns music every time.

With that understood, a **single** up-front block is still correct and worth
writing:

> No subtitles, on-screen text, watermarks or logos. No third character. No
> location change. No change of lighting or colour partway. No swapping of
> positions. No full-body framing. No face drift, distorted features, unfocused
> or misaligned gaze, lips sticking together, or false excessive tears. No skin
> smoothing, over-exposure, high-saturation filters or stage lighting. No
> exaggerated gestures, head shaking, shouting, slow motion, orbiting camera or
> fast push-pull. No wardrobe or hairstyle change mid-scene.

State it once. Do not restate a ban inside a shot module, and never escalate a
ban that is not working — switch to substitution instead.

Banning on-screen text explicitly matters more than it looks: H3 preserves
supplied text well but will invent glyphs in period and ornamental settings
unless told not to. That is a categorical ban, so it belongs in the block above.

Also: reconstruct the *dramatic structure* of a scene you admire, never a
performer. Include "does not imitate any real actor or public figure."

## 11. What not to carry over

- **The FACS codes.** See §3.
- **Multi-cut shot modules.** See §3.
- **Shipping every frame you generate.** A generated clip is raw material, not
  a finished shot. Practitioners producing this work generate several minutes
  and cut down to the passages that work. Plan to keep perhaps half.
- **Everything in one model.** Score, narration, titles, posters and subtitles
  are separate jobs. Do not ask the video model for them.

## 12. Check the middle of every shot

A correct first frame and a correct last frame do not imply correct motion
between them. Pull a **contact sheet of about eight evenly spaced frames from
every generated clip** and look at it before the clip goes anywhere near an
edit. It catches what endpoint checks cannot: an action performed in the wrong
direction, hands changing between frames, colour banding appearing mid-clip,
and a character drifting away from their reference.

This is cheap and it is the only gate that inspects the picture itself. Prompt
audits check what you asked for; transcript checks hear the words; nothing else
looks at what actually moved.

## Status of the claims here

The scene shape, the blocking contract, the movement grammar, the matched-setup
return, the emotion timeline and the negative-block vocabulary are distilled
from a body of publicly posted reference prompts (notably @PixelAigc on X, who
runs H3 locally) plus our own reading of where our films went flat. The face
loss in full-body shots, the step-count effect on dialogue clarity and the
resolution guidance are **reported by that practitioner and not independently
measured here** — treat them as strong priors to test on your own recipe, not
as settled numbers. The `N/A` music sentinel and the text-preservation
behaviour are our own measurements.
