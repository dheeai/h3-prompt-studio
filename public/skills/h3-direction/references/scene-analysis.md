# Scene analysis — the eight questions, and the uninflected image

## Part 1 — Eight questions, cut down from thirty

Peter D. Marshall's *Detailed Scene Analysis* is a 30-category director's
breakdown: stage directions, main scene objective, what happens, location,
central emotional event, sources of conflict, obstacles, scene beats, story
points, plot points, tone, mood, themes, climax, tension, pacing, character arcs,
subtext, important dialogue, scene control, character actions, backstory,
off-camera beat, recognition & reversal, visual/sound elements, counterpoint,
foreshadowing, recurring motifs, transitions, resolution.

**Do not hand an LLM thirty fields.** It will fill all thirty, none of them will
be a decision, and the mush will read as thoroughness. These eight carry the
weight; the rest are either downstream of them or are notes for a live shoot.

1. **Whose scene is it?** One character. Not two. The scene belongs to whoever
   changes. *(If you cannot answer, nothing below will help.)*

2. **What do they want, in this scene, right now?** Not their want in the film —
   in these seconds. Phrase it as something another person could refuse.

3. **What is the central emotional event?** The thing that happens *between*
   people — or between a person and a fact. This is the scene's reason to exist.

4. **What is the obstacle?** Internal (they cannot admit it) or external (the
   door is locked). Name which.

5. **Where are the beats?** A beat is a moment where the scene **suddenly changes
   direction**. Most 15-second scenes have one or two. If you have listed six,
   you have listed shots, not beats.

6. **Who controls the scene, and does that change?** Control is the thing an
   audience tracks without knowing it. A transfer of control mid-scene is often
   the whole event.

7. **What is the off-camera beat?** What was the character doing in the ten
   seconds *before* we cut in? This single question fixes more flat openings than
   any other — it is why a character enters a scene already mid-something instead
   of neutrally waiting to be filmed.

8. **What is the subtext?** What is being transacted underneath what is being
   said. If subtext and text are identical, either the dialogue or the staging
   needs to change.

### Staging answers question 6 before anyone speaks

Power reads off the picture. From Katz's staging patterns and standard blocking
grammar:

| Staging | Reads as |
|---|---|
| Standing over seated | Dominance |
| Character in the doorway | Controls the room; can leave |
| Shot through glass | Psychological distance |
| In shadow | Threat, or grief |
| Alone in negative space | Isolation |
| Tight framing, no headroom | Suffocation |
| Sharing a frame, no eye contact | Broken intimacy |
| Character with their back to the camera | Withholding |
| Low angle / high angle | Power / vulnerability — the bluntest tool; use once |

**Blocking is the choreography of desire.** For each character ask: what do they
move *toward*, what do they move *away from*, whom do they corner, to whom do
they yield space, and what gesture leaks the thing they are hiding?

- Weak: *"He stands near the window."*
- Strong: *"He edges toward the window but keeps his shoulders turned back
  toward her, as if the conversation still has hold of him."*

The second is a decision. The first is a stage direction waiting for a director.

### Geometry: the 180° line

Once two characters are established in a space, an imaginary line runs between
them; keep the camera on one side of it and screen direction stays consistent —
she looks frame-left, he looks frame-right, and the audience holds the geometry
without effort. Cross it and they lose the room.

For H3 this is not enforced by a camera operator; it is enforced by **stating the
geography in one sentence in the prompt** and repeating the same directional
words at every beat: *"He is frame right throughout and always looks to
frame-left; she is frame left and always looks frame-right."* Without that, H3
reconstructs the space at each cut and the two of them will end up looking the
same way.

---

## Part 2 — Mamet's uninflected image

David Mamet, *On Directing Film*. The most useful single rule for LLM-directed
video, and the one most at odds with how an LLM writes.

### The rule

Cut the scene into a sequence of **simple, neutral, concrete images**. Do not
load any individual shot with the theme. Meaning is manufactured by the
**juxtaposition** of shots, not carried inside one of them.

The director's job is to find, for each beat, the plainest image that shows what
happens — then place it next to the previous one and let the audience make the
meaning. Mamet's organising question for the whole structure is *what does the
protagonist want*, and the throughline is the unbroken path of that pursuit.

### Why this matters for H3 more than for a live shoot

A film crew asked for *"a shot expressing her isolation"* will produce something,
because a human DP silently converts the abstraction into a concrete image.

**H3 cannot do that conversion.** Asked for an abstraction it returns the median
image associated with the word — which is a stock photograph. Asked for a
concrete physical event it renders the event.

| Inflected (LLM default) | Uninflected (directed) |
|---|---|
| "A shot conveying her isolation" | "The wide table. One cup. Her coat still on." |
| "A moment of triumph" | "His hand lets go of the rail." |
| "A tense atmosphere pervades the room" | "The overhead strip light. Nobody sits down." |
| "She realises the truth" | "She stops reading. She does not turn the page." |
| "An air of quiet desperation" | "He counts the notes twice." |
| "The team celebrates their success" | "Someone claps once. Then everyone does." |

Every abstraction left in the sheet is a decision handed to the model, and the
model decides from its median.

### The test

Read each shot card's **Action** line and ask: *could a camera photograph this,
with no interpretation?*

- "Her hand tightens on the strap" — yes. Photograph it.
- "Her anxiety builds" — no. That is a note to an actor, not a shot.

If the answer is no, you have written a feeling where a picture belongs. Convert
it. The conversion *is* the directing.

### The corollary: cut on the physical event

Because the images are uninflected, the cuts do the work — so cut on the moment
the physical thing happens, not before it and not after it. The hand releases the
rail *and we cut*. The page does not turn *and we cut*. This is also why the held
beat before the impact is so effective: it is the one place you deliberately
withhold the cut, and the withholding is legible.
