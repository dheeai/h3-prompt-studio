---
name: h3-direction
description: Decide WHAT TO SHOW before writing a single H3 prompt word — the directorial layer that turns a story into a direction sheet (five anchors, scene formula, escalation curve, beat grid, per-cut shot cards). Use whenever an H3 film comes out flat, evenly-weighted, aimlessly moving or "pretty but pointless"; whenever adapting a story/script/brief into shots; and BEFORE h3-prompting / h3-motion-graphics / h3-shots, which render a direction sheet but cannot invent one. Carries the three forcing-function gates, the Murch Rule-of-Six critique rubric, Block's contrast curve, Mamet's uninflected-image rule, and the rhythm-vocabulary trap that makes a direction sheet leak music into a silent film.
---

# H3 direction — deciding what to show

Every other H3 skill answers **"how do I say it to the model."** This one answers
the question that comes first and that models are worst at: **"what should be on
screen, whose scene is this, and what changes."**

**Direction is subtraction.** An LLM asked to direct does not lack film
vocabulary — it knows every shot name and will sprinkle *dolly in, 85mm, golden
hour* across everything. It fails because nothing forces a **choice**. Left
alone it produces even-weighted coverage of the whole story, a camera that moves
because cameras move, and no point of view about whose scene it is. More
vocabulary makes this worse, not better — it just gives the model more to
sprinkle.

So this skill is not a glossary. It is a set of **forcing functions**: rules that
make options *impossible*. Use them in the order given, and emit a
**direction sheet** — a decision artifact that exists before any prompt text, and
that the prompt skills then render.

## Where this sits

```
story / brief / script
        ↓
   ► h3-direction ◄     ← THIS SKILL: the direction sheet (decisions)
        ↓
h3-prompting            format authority — field names, [Shot N] markers, <d> tags
h3-motion-graphics      genre playbook when the deliverable is designed motion
h3-shots                multi-clip films where dialogue must survive verbatim
        ↓
      render
```

Read `~/.claude/skills/h3-prompting/references/base_guide.md` for the **format
contract**. This skill never overrides it. A direction sheet is input to it.

## Reference files

- `references/dramaturgy.md` — the core framework (scene formula, three-jobs
  rule, three-detail rule, shot functions, rhythm ladders). Vendored from
  [smixs/visual-skills](https://github.com/smixs/visual-skills), CC BY 4.0,
  Serge Shima. **Read this first** — it is the densest of the four.
- `references/rule-of-six.md` — Murch's weighted rubric, written as a critique
  pass. Use it to *grade* a direction sheet or a render.
- `references/visual-structure.md` — Bruce Block's contrast & affinity: how to
  make the picture's intensity graph the story's intensity.
- `references/action-continuity.md` — cutting on action: how to make one
  physical movement survive a cut instead of being rendered twice. Read it
  whenever a single action crosses a framing change.
- `references/scene-analysis.md` — the eight questions that survive from Peter
  Marshall's 30-column breakdown, plus Mamet's uninflected-image rule.

---

## 1. The three gates

Apply in order. Each one is a gate: if it does not pass, you do not proceed to
the next, and you certainly do not start writing prompt prose.

### Gate 1 — The scene formula

```
scene = desire + obstacle + geometry + gaze + rhythm
```

Name each in **one sentence**. If you cannot name all five, the scene is not
ready to be directed and no amount of prompt craft will rescue it.

| Element | The question it answers | Failure if missing |
|---|---|---|
| **Desire** | What does the protagonist want *in this 15 seconds*? | Aimless drift; nothing to root for |
| **Obstacle** | What is in the way, right now? | No tension; a mood reel |
| **Geometry** | Where is everyone, and which direction is escape/decision? | H3 invents new geography at every cut |
| **Gaze** | What is the viewer looking at, and who controls that? | Even-weighted coverage; no emphasis |
| **Rhythm** | Where does it accelerate, where does it pause? | Metronomic cutting; no impact |

Note the H3 wrinkle: **"in this 15 seconds."** A single generation is one scene,
not a story. If the desire you named needs three minutes to land, you are
directing the wrong unit — split it, and give each clip its own formula.

### Gate 2 — The three jobs

Every shot must do at least one of:

- **change emotion** (in a character, in the viewer, or between characters)
- **advance action** (a new physical event, a new position, new information)
- **increase pressure** (stakes rise, clock ticks, space tightens, a witness arrives)

**A shot that does none of these gets deleted.** This is the single most useful
gate against LLM output, because the model's default failure is the beautiful
establishing shot that does nothing — the drone push over the city, the hero
looking thoughtfully out of a window, the product rotating.

At 15s you have room for 2–8 shots depending on register (§4). Every one of them
must earn its slot against a competitor. Ask: *if I deleted this beat, what would
the viewer not know or not feel?* If the answer is "nothing," it's decoration.

### Gate 3 — Three details per shot

Every shot embeds three concrete physical facts:

1. **Environmental pressure** — a spatial fact carrying the emotion (flickering
   fluorescent, wet asphalt, steam, rain on glass, a corridor too narrow)
2. **Physical micro-action** — the emotion rendered on a body (jaw locks,
   knuckles whiten, eyes drop, fingers curl on the strap)
3. **Sound anchor or visual motif** — a recurring perceptual hook (a clock, a
   reflection in glass, a bass hit, a specific footfall)

This is the gate that gets skipped, and skipping it is exactly what makes H3
output generic — H3 synthesises picture *and* audio from this text, so a missing
sound anchor is not a missing note in a shot list, it is a missing sound.

**Banned in a direction sheet:** `cinematic`, `professional`, `high quality`,
`stunning`, `epic`, `beautiful`, `he is sad`, `she is angry`, `emotional`,
`dynamic`, `engaging`. Each is a slot where a decision should be. In an H3
prompt they burn attention budget and return the model's median taste.

---

## 2. The five anchors — commit before you plan

Before the beat grid, commit to exactly **five** things. Not six. The constraint
is the point: five anchors is what makes a 15-second film feel authored instead
of assembled.

1. **One emotion** — the single feeling the piece is about (guilt, relief,
   defiance, dread, pride). Not two.
2. **One visual motif** — the thing that recurs (reflections, hands, a color, a
   doorway, the horizon line).
3. **One anchor object** — the physical thing the story happens to/through (the
   phone, the key, the letter, the blade, the product).
4. **One break** — the single moment the situation changes. The whole film points
   at this.
5. **One final image** — the exact frame the viewer carries out. Name it as a
   picture, not a feeling.

If you cannot name the break, you have a mood piece, not a scene. If you cannot
name the final image, H3 will pick one and it will be a slow fade on a face.

---

## 3. Mamet's rule: uninflected images, not loaded ones

Cut the beat into **simple, neutral, concrete images**. Meaning comes from the
*juxtaposition*, never from loading one shot with the theme.

| Don't write | Write |
|---|---|
| "A shot expressing her isolation" | "The wide table. One cup. Her coat still on." |
| "A moment of triumph" | "His hand lets go of the rail." |
| "A tense atmosphere pervades the room" | "The overhead strip light. Nobody sits down." |

This matters more for H3 than for a live shoot. H3 can render *a hand letting go
of a rail*. It cannot render *a moment of triumph* — asked for that, it returns
a stock photograph of a person with their arms up. Every abstraction you leave in
the sheet is a decision H3 makes on your behalf, from its median.

Full treatment in `references/scene-analysis.md`.

---

## 4. The beat grid — at 15s the grid *is* the edit

There is no cutting room. H3 renders the whole clip in one pass, so the beat grid
you write **is** the edit decision list, and it reaches the model as `[Shot N] At
MM:SS.mmm` markers. Two consequences:

- **The number of `[Shot N]` markers is exactly the number of cuts, plus one.**
  Count them against your budget before rendering. (Mechanism and the
  continuous-transition workaround: `h3-motion-graphics` §3.)
- **Cut rate is a register decision** and the easiest thing to get wrong.
  Measured budgets, carried from `h3-motion-graphics` §3:

| Register | 15s shape | Cut every |
|---|---|---|
| Social / feed | 6–8 beats | 1.2–2.0s |
| Explainer | 5–6 beats | 2.0–3.0s |
| **Brand / website intro** | **2–3 movements** | **5–6s** |
| Title sequence | 4–5 beats | 2.5–3.5s |
| Drama / narrative beat | 4–6 beats | 2.0–3.5s |

More than 8 beats at 15s and no beat is long enough to be read. Fewer cuts is
not the same as less motion — a calm film still needs continuous development
inside its shots.

### Shot functions — label every beat with one

Give each beat a job from this list. If two adjacent beats have the same
function, one of them is redundant.

`Establish` (where) · `Power` (who controls) · `Pressure` (what pushes down) ·
`Detail` (macro anchor — object, hand, eye) · `Reaction` (face after event) ·
`Shift` (inner change made visible) · `Impact` (the decisive frame) ·
`Aftermath` (emptiness after) · `Exit` (final image)

### The 15-second shape

The 60–90s seven-beat ladder compresses to five functional slots. **Never skip
Crack or Impact** — they are the film.

```
0.0 – 2.0s    HOOK          one arresting image, the tension already visible
2.0 – 5.0s    CONTEXT       geography + who has power
5.0 – 9.0s    CRACK         the detail that breaks the position
9.0 – 12.0s   ACCEL→IMPACT  shortest beats, then the PAUSE, then the decisive frame
12.0 – 15.0s  AFTERMATH     the final image, held still to the out point
```

**The pause before impact matters more than the speed of the cuts.** Without it,
fast cutting is a visual meat grinder. Always place at least one held beat
immediately before the biggest change.

End the last beat with an explicit freeze instruction, or H3 keeps animating and
the out point is mush.

### Camera: one motivated move per beat

Every camera move answers **"what changed?"** H3's default is a slow aimless
drift on everything, so an unmotivated move is not neutral — it is the model
filling a vacuum.

| Don't | Do |
|---|---|
| "Cinematic gliding camera movement" | "Push-in starts on 'I don't know' and stops on her jaw locking" |
| "Dynamic camera work" | "Static. The camera does not move; only her hand does." |

Valid reasons for a move: a character decided; new information entered frame;
pressure escalated (tighten); a character looked (reveal what they saw); a
gesture pulled focus; the space changed. **Name where the move starts and where
it stops.** "Static" is a legitimate and under-used choice — pin the camera and
let the blocking carry the beat.

---

## 5. The escalation curve (Block)

Plot the story's intensity across the 15 seconds, then make **one** visual
component carry that curve — its contrast rises as conflict rises, and relaxes
at the resolution.

> **Principle of contrast & affinity:** the greater the *contrast* in a visual
> component, the higher the visual intensity; the greater the *affinity*
> (similarity), the lower it.

Pick **one** component to carry escalation. Not all seven — that's a music video,
and in a 15s clip it reads as chaos:

`space` · `line & shape` · `tone` (light/dark) · `color` · `movement` ·
`rhythm` (cut duration) · `story` (the content itself)

Worked shape: a confession scene escalates on **tone** — beats 1–2 flat and evenly
lit (affinity, low intensity), beat 3 introduces one hard shadow, beat 4 is
near-silhouette against a window (maximum contrast at the Impact), beat 5 returns
to flat light with the room now empty (affinity, resolution). Nothing else
changes register. That single controlled variable is what reads as *directed*.

Then state the chosen component in the prompt as a concrete progression, per
beat. Full treatment in `references/visual-structure.md`.

---

## 6. The direction sheet

The deliverable. Emit this **before** any prompt prose. One sheet per clip.

```markdown
## Direction sheet — <clip id> — <duration>s — register: <social|explainer|brand|title|drama>

### Five anchors
- Emotion:       <one word>
- Motif:         <the recurring perceptual hook>
- Anchor object: <the physical thing>
- Break:         <the single moment it changes>
- Final image:   <a picture, not a feeling>

### Scene formula
- Desire:   <one sentence — what they want in these N seconds>
- Obstacle: <one sentence>
- Geometry: <one sentence — "hero left-to-right, threat enters top, exit off-frame right">
- Gaze:     <one sentence — what the viewer looks at, and who controls it>
- Rhythm:   <one sentence — where it accelerates, where it holds>

### Escalation
- Carrying component: <space|line|tone|color|movement|rhythm>
- Curve: beat1 <level> → beat2 <level> → … → resolution <level>

### Beat grid   (marker count = cuts + 1 — check against register budget)
| # | In     | Dur  | Function | What changes | Contrast | Camera + reason | Eye-trace |
|---|--------|------|----------|--------------|----------|-----------------|-----------|
| 1 | 00.000 | 2.0s | Hook     | …            | low      | static          | …         |
| … |        |      |          |              |          |                 |           |

### Shot cards   (one per beat)
- **Beat N** — <function>
  - Frame:        <wide | medium | close | macro insert>
  - Composition:  <center | edge | negative space | reflection | silhouette | foreground obstruction>
  - Action:       <the exact physical event — uninflected, concrete>
  - Env pressure: <the spatial fact carrying the emotion>
  - Micro-action: <emotion on a body>
  - Sound anchor: <the audible hook — H3 synthesises this>
  - Light/color:  <per the escalation curve>
  - Ends on:      <the state at the cut — position, phase, speed, screen direction>
  - Next opens:   <that SAME state from the next framing, when the cut is on
                   action; leave blank when the cut is meant to be felt>

### Gates
- [ ] Scene formula complete (all five named)
- [ ] Every beat does one of the three jobs
- [ ] Every beat carries three details
- [ ] Every camera move has a named reason, start and stop
- [ ] Geometry readable in one sentence
- [ ] Five anchors named, exactly five
- [ ] Every cut that carries one continuous movement has `Next opens` matching
      the previous `Ends on` word for word — see `references/action-continuity.md`
- [ ] No banned words
- [ ] Marker count within the register's cut budget
- [ ] Final beat has an explicit freeze
```

---

## 7. Handoff to the prompt — and the two traps

### ⚠ Trap 1: the rhythm vocabulary leaks MUSIC

**This is the highest-risk failure of this specific skill.** A direction sheet is
full of the words *beat*, *rhythm*, *tempo*, *accelerate*, *on the beat*, *lands
on*, *pause*. Those are edit-timing words to you. To H3 they are **musical
cues** — and H3 will score the film.

Measured on the dhee reel (2026-08-11): `EVERY CUT IS ON A MUSICAL BEAT at 100
BPM`, the bare phrase `on the beat`, and even `PRECISION INSTRUMENT` (a visual
system name) each handed H3 musical cues while the music field said none.

So, translating a sheet into a prompt:

1. **Convert every rhythm word into a timecode or a duration.** "Accelerating
   cuts" becomes `[Shot 4] At 00:09.200 … [Shot 5] At 00:10.100`. The grid
   carries the rhythm; the *word* does not survive the handoff.
2. **If the film has no score, the field must be exactly `non_diegetic_music:
   N/A`.** `N/A` is a null — there is nothing to synthesise. Anything that
   *describes* the absence ("None. No background music of any kind. Do not
   generate any melody…") is a detailed spec of a score with "don't" in front of
   it, and returns music. `Silence.` fails the same way.
3. **Then sweep the whole prompt for musical vocabulary** — not just the music
   field. Beat, tempo, rhythm, groove, pulse, downbeat, sting, swell.

Full write-up: `~/Projects/dhee-cofounder/memory/2026-08-11-h3-na-sentinel-suppresses-music.md`.

### ⚠ Trap 2: direction never rewrites dialogue

If the script has lines, they are **data**. The direction sheet directs *around*
them — what we see while the line lands, who is on screen, where the camera is,
what the reaction is. It does not paraphrase, tighten, translate or "improve" a
single word. `h3-shots` enforces this with a byte-match audit before submit; a
direction pass that quietly rewrote a line will be caught there, having wasted
the run.

### Mapping the sheet onto the prompt

| Sheet field | Lands in |
|---|---|
| Five anchors | The opening of `integrated_multimodal_description` — models weight the first 30–40% of tokens most heavily, so the anchors go **first** |
| Beat grid rows | `[Shot N] At MM:SS.mmm` markers, in order |
| Shot card action / env pressure / micro-action | The per-shot prose |
| Sound anchors | `overall_soundscape`, on the same timecodes as the grid |
| Escalation curve | The light/color progression, stated per beat |
| Final image + freeze | The last beat, plus an explicit hold to the out point |
| Camera + reason | Per-shot, with named start and stop |

---

## 8. The critique pass

Direction fails *quietly* — the render looks fine and lands on nobody. So grade
the sheet before you spend a generation, and grade the render after.

Apply **Murch's Rule of Six** as a weighted rubric (`references/rule-of-six.md`):

| Criterion | Weight | Question |
|---|---:|---|
| Emotion | 51% | Does the cut honour the emotional truth of the moment? |
| Story | 23% | Does it advance the story or reveal character? |
| Rhythm | 10% | Does it land at the right moment? |
| Eye-trace | 7% | Does the viewer's gaze arrive naturally in the new shot? |
| 2D plane | 5% | Is screen direction respected? |
| 3D space | 4% | Is the location geometry respected? |

The **weights are the whole point** — they are what stops an LLM optimising for
geometric correctness. A sheet that is continuity-perfect and emotionally inert
scores 16%. Report a weighted score and the single lowest-weighted-but-failing
criterion, then fix that one thing.

**Run the critique on the local model.** Per the model policy, this is a
reasoning-bound judgement call with a rubric, so it is `thinkingcap-27b` on the
5090 llama gateway (`http://5090.tail3cca41.ts.net:9000/llama/v1/chat/completions`,
no API key). thinkingcap is multimodal, so the *same* model grades the direction
sheet as text and the rendered frames as images — no author↔critic model swap,
no GPU thrash. For video-modality critique specifically, that is the one case
that goes remote to `xiaomi/mimo-v2.5`.

---

## 9. Worked example — "Guilt", 15s, drama register

**Five anchors:** emotion `guilt` · motif `reflections in glass` · object `a phone
with one unread message` · break `he deletes the conversation` · final image
`his face ghosted on a dark phone screen`.

**Scene formula.** Desire: he wants to answer her without admitting what he did.
Obstacle: any honest answer costs him the job. Geometry: he is alone at a desk,
frame right; the office extends empty to frame left; the only exit is behind him,
unused. Gaze: the viewer looks where he looks — phone, then his own reflection.
Rhythm: three held beats, then four fast, then a full stop before the tap.

**Escalation:** carried on **space** — beats 1–2 give him room, beat 3 tightens to
a macro insert, beat 4 is the thumb alone in frame, beat 5 opens back out to the
empty room.

| # | In | Dur | Function | What changes | Contrast | Camera + reason | Eye-trace |
|---|---|---|---|---|---|---|---|
| 1 | 00.000 | 3.0s | Hook | Phone buzzes face-down; light throws his reflection onto dark glass | low | static | the lit rectangle |
| 2 | 03.000 | 3.5s | Power | The office is empty around him; he has not taken his coat off | low | slow push-in, starts as he reaches, stops as he stops | his hand |
| 3 | 06.500 | 3.0s | Detail | He types, stops, deletes one character at a time | rising | static macro | the cursor |
| 4 | 09.500 | 1.0s | Shift | Thumb hovers over Delete Conversation — **held, no movement at all** | max | static | the thumb |
| 5 | 10.500 | 4.5s | Impact→Aftermath | One tap. Screen goes black. His face remains, reflected in it. Hold still to 15.000 | release | static | his reflected eyes |

Four cuts, five `[Shot N]` markers — inside the 4–6 beat drama budget.

**Three details, beat 4:** environmental pressure = the fluorescent above him
ticks; micro-action = his thumb stops moving entirely for a full second; sound
anchor = the room tone drops out under it.

**Notice what is absent:** no establishing exterior, no clock on a wall, no
colleague in a doorway, no rain. All were available; none of them does one of the
three jobs. That is the subtraction.

**Handoff note:** this film has no score. `non_diegetic_music: N/A` — and "three
held beats, then four fast" never reaches the prompt as words; it reaches it as
the timecodes in the grid.

---

## 10. The pre-send check

1. Scene formula complete? (desire + obstacle + geometry + gaze + rhythm)
2. Exactly five anchors, including a named break and a named final image?
3. Every beat passes the three-jobs test — nothing decorative survives?
4. Every beat carries three details (environmental, micro-action, sound/motif)?
5. Every camera move has a reason, a start and a stop — or is deliberately static?
6. Geometry statable in one sentence?
7. Escalation carried by exactly one visual component?
8. Marker count inside the register's cut budget?
9. A held beat immediately before the biggest change?
10. Final beat freezes explicitly to the out point?
11. No banned words anywhere in the sheet?
12. Rhythm words converted to timecodes; musical vocabulary swept; `N/A` if silent?
13. Dialogue byte-identical to the script?

**Steps 4 and 12 are the most violated.**

---

**Attribution:** §1–§2, the shot-function list, the rhythm ladders and the
three-detail rule are adapted from *Dramaturgy, Detail, Montage* by Serge Shima,
[smixs/visual-skills](https://github.com/smixs/visual-skills), CC BY 4.0 —
vendored in full at `references/dramaturgy.md`. The Rule of Six is Walter Murch,
*In the Blink of an Eye*. Contrast & affinity is Bruce Block, *The Visual Story*.
The uninflected image is David Mamet, *On Directing Film*. Staging patterns are
Steven D. Katz, *Film Directing: Shot by Shot*. The eight scene questions are cut
down from Peter D. Marshall's Detailed Scene Analysis.
