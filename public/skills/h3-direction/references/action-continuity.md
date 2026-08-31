# Cutting on action — making a movement survive a cut

> **STATUS: PARTIALLY DISPROVEN — 2026-08-31. Do not trust this document yet.**
>
> Measured on a three-shot throw at 1344x768 / v1.1 turbo / 6 steps, two arms,
> same seed: writing the cut this way did **not** stop the action repeating. The
> object was thrown three times — and so was the control. **The repeat count
> tracked the number of `[Shot N]` markers, not the wording.** Shortening the
> clip to match the action (3.75s) did not help either: still three throws, plus
> a 2-3s freeze once the described content ran out.
>
> Current best reading: H3 generates per `[Shot N]` block, so a single physical
> action spread across three markers is rendered three times, and no phrasing
> inside those blocks changes that. If that holds, the fix is structural — keep
> one continuous action inside ONE marker and describe the framing change as
> camera movement — and most of the wording advice below is beside the point.
>
> What IS confirmed: section 2's correction. Writing "it does not begin again /
> no wind-up / no pause" makes things worse, for the same reason
> `non_diegetic_music: None.` produces music. That much is measured.
>
> Untested: whether one-marker-per-action fixes it. Until that render exists,
> treat everything here as a hypothesis, not a rule.

The failure this fixes: a wide shot shows a sword mid-swing, the next shot is a
macro as it reaches the head — and the model renders **two separate swings**.
The second shot winds up and starts again. The cut reads as a repeat, not a
continuation, and the violence loses its line.

This is the oldest rule in continuity editing and H3 does not apply it unless
the prompt makes it impossible to do otherwise.

## The rule, from the editors

> All moving things — hands, heads, blades — must be in **the same place** at
> the end of one shot and the beginning of the next.

> The entrance in the second shot must match the **screen direction and motive
> rhythm** of the exit in the first.

A cut on action works because the subject *begins* an action in one shot and
*carries it through to completion* in the next. The movement is the bridge; it
is what stops the audience seeing the join at all.

## Why H3 breaks it by default

Each `[Shot N]` block reads as a self-contained description. Given

    [Shot 1] He swings the sword.
    [Shot 2] At 00:03.000, macro. The sword reaches the man's head.

the model has been handed two complete actions, so it renders two. Nothing in
the prompt says the second is the *same swing, later*.

The word that does the damage is the verb restated. `swings` in Shot 1 and
`reaches` in Shot 2 are two events unless the prompt binds them.

## How to write it

**One action, one description, cut placed inside it.** Not two descriptions.

### 1. State the same instant on both sides of the cut

The outgoing shot ends on a physical state. The incoming shot opens on that
*same* state, described from the new framing. Same position, same phase, same
direction, same speed. If you cannot write the two sentences so they describe
one instant, the cut is not on action.

    [Shot 1] ... the blade travels right-to-left and is three-quarters through
    its arc, level with his shoulder, when the shot ends.

    [Shot 2] At 00:03.000, cut to a macro. The blade is three-quarters through
    the arc, travelling right-to-left at the same speed, now level with the
    other man's temple. It carries through into the bone.

### 2. Never NAME the restart — initiate once, then describe only state

**This rule was measured wrong once and corrected. Read the correction.**

The obvious move is to forbid the restart in words: *"It does not begin again;
there is no wind-up, no preparation, and no pause at the cut."* That is what
this document said to do, and **on a real render it produced MORE restarts, not
fewer** — a three-shot throw written that way showed the woman throwing the
tumbler several times.

It is the `non_diegetic_music` failure exactly. Naming a thing instructs the
model to produce it, negation or not. "No wind-up" is a wind-up with *no* in
front of it, the same way "None. Do not generate any music" is a score with
*don't* in front of it. There is no sentinel for an action, so the fix is not a
different phrasing of the denial — it is to never raise the subject.

Never write, anywhere in the prompt:

    begins again · begin · restart · reset · wind-up · preparation ·
    no pause · does not repeat · again

**Do this instead — initiate once, then carry state:**

1. The initiating verb — *throws, swings, pours, strikes* — appears **exactly
   once**, in the shot where the action starts. Never again.
2. Every later shot has **no agent and no initiating verb**. The thrower is not
   mentioned; the hand is not mentioned. Only the moving thing and its state.
3. Later shots use **continuation verbs**: *crosses, keeps, carries, meets,
   completes*. Never a verb that could start the action over.

    [Shot 1] ... A woman throws a steel tumbler towards the wall. It leaves her
    hand travelling left-to-right and spinning clockwise, and it is two-thirds
    of the way across the room, at head height, when the shot ends.

    [Shot 2] ... It is two-thirds of the way across the room, at head height,
    travelling left-to-right, spinning clockwise. It crosses the remaining
    distance and is a hand's width from the plaster when the shot ends.

    [Shot 3] ... The tumbler is a hand's width from the plaster, travelling
    left-to-right, spinning clockwise. It meets the wall and drops.

The continuity is carried entirely by the repeated **state** — position,
direction, rotation — and by the absence of any second initiation. Nothing in
those three shots tells the model not to do something.

### 3. A middle shot has TWO boundaries, not one

A shot in the middle of a chain is the incoming side of one cut and the
outgoing side of the next. It needs both states written, or the second cut has
nothing to match against.

Observed failure, from a real pass: a three-shot throw where shot 2 opened
correctly ("already two-thirds of the way to the wall") but never said where it
*ended* — and shot 3 then opened "already at the wall's surface". The object
teleported the last third of its flight, inside a chain that was otherwise
written correctly. Each cut was locally consistent; the sequence was not.

    [Shot 2] ... opens two-thirds of the way across, still travelling
    left-to-right, spinning clockwise. It crosses the last of that distance and
    the shot ends with the tumbler a hand's width from the plaster, still
    turning.

    [Shot 3] ... opens with the tumbler a hand's width from the plaster, still
    turning the same way. It meets the wall and drops.

Rule: **every cut boundary needs the state written on both sides of it.** For a
chain of N shots that is 2(N−1) states, not N−1.

### 4. Speed may change; nothing else may

A deliberate ramp — a slow-motion insert, a speed-up — is a legitimate choice
and does not break a cut on action. Position, phase, direction and rotation
still have to match exactly across the cut; only the rate differs, and it must
be *stated as deliberate* so the model does not read the mismatch as a new
action:

    Shot 2 is in slow motion; the tumbler crosses the same distance at the same
    left-to-right heading.

State the ramp as a property of the SHOT ("in slow motion"), never as a
statement about the action ("the throw continues without reset") — the second
form names the reset and brings it back.

Everything else on the list stays fixed. A ramp is not a licence to re-time the
action, only to re-time the viewing of it.

### 5. Preserve screen direction

Right-to-left stays right-to-left. Reverse it and the audience reads a second,
opposing swing no matter how well the timing matches — this is the 180-degree
rule doing its work. State the direction in **both** shots, in the same words.

### 6. Keep the clock continuous

The timecodes already carry the action forward. Do not leave a gap at the cut
and do not restate elapsed time. If the swing takes 0.8s and the cut lands at
0.45s into it, the incoming shot opens 0.45s into the swing — not at zero.

### 7. Carry the sound through

A cut on action that resets its sound still reads as two events. The blade's
travel noise, the breath, the cloth — one continuous envelope across the cut,
described in `overall_soundscape` as a single event with the cut inside it.

## The direction sheet already has the hook

The shot card carries `Ends on: <the state at the cut>`. That field exists for
this. Whatever it says, the next card's opening state must be **the same
sentence**, re-framed. If the two do not match, either the cut is not on action
or the sheet is wrong.

Add to the card when the cut is on action:

    Ends on:      <the exact physical state, with direction and speed>
    Next opens:   <that same state, from the new framing>
    Screen dir:   <left-to-right | right-to-left>, unchanged across the cut

## When NOT to cut on action

Not every cut should be. A cut on action hides the join — which is wrong when
the join is the point. Mamet's uninflected image and the juxtaposition rule both
depend on cuts the audience *feels*. Use it for a single physical event crossing
a framing change; do not use it to smooth over a change of scene, of idea, or of
time, where the seam is doing the work.

## Checklist

- [ ] The shots describe **one** action, not several
- [ ] Every cut boundary has the state written on BOTH sides — a middle shot
      states where it opens AND where it ends
- [ ] The incoming shot opens mid-action, never at rest, never with a wind-up
- [ ] Position, phase, speed and screen direction restated identically
- [ ] The initiating verb appears exactly ONCE, in the first shot only
- [ ] No later shot names an agent, a wind-up, a restart, a reset or a pause
- [ ] Timecodes continuous through the action
- [ ] Sound is one envelope across the cut

## Sources

Classical continuity editing — cutting on action, overlapping action, and
screen-direction matching:

- <https://en.wikipedia.org/wiki/Cutting_on_action>
- <https://www.videomaker.com/article/c10/13536-cutting-on-action/>
- <https://www.filmmakersacademy.com/glossary/overlapping-action-overlapping-editing/>
- <https://www.backstage.com/magazine/article/continuity-editing-guide-75720/>
