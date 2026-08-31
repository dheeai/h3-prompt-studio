# Visual structure — contrast & affinity

Bruce Block, *The Visual Story*. The most directly encodable of the classical
frameworks, because it is a formal system with a decision procedure rather than a
matter of taste.

## The principle

> **The greater the contrast in a visual component, the more the visual intensity
> of the picture increases. The greater the affinity in a visual component, the
> more the visual intensity decreases.**

Contrast = difference. Affinity = similarity. Intensity = the dynamic, agitating,
exciting quality of the image.

## The seven visual components

Each can be pushed toward contrast or toward affinity, independently.

| Component | Affinity (low intensity) | Contrast (high intensity) |
|---|---|---|
| **Space** | Flat, shallow, ambiguous depth; even planes | Deep, layered; strong foreground/background separation; extreme scale differences |
| **Line & shape** | All curves, or all straights; one shape language | Curves against hard angles; a circle in a grid |
| **Tone** | Narrow value range; everything mid-grey; flat light | Deep blacks against bright highlights; silhouette; hard shadow |
| **Color** | Analogous, desaturated, one family | Complementary, saturated, a single hot accent in a cold field |
| **Movement** | Everything still, or everything moving at one speed and direction | Stillness against sudden motion; opposing directions; speed changes |
| **Rhythm** | Even cut durations; regular repetition | Irregular durations; a long held beat against a burst of short ones |
| **Story** | Nothing at stake, no opposition | Conflict, reversal, the break |

## The method: make the picture graph the story

1. **Chart the story's intensity** across the running time as a curve —
   exposition low, rising conflict, climax at the peak, resolution back down.
2. **Chart one visual component underneath it** on the same time axis.
3. **Make the second curve parallel the first.** Contrast rises as conflict
   rises; the component relaxes to affinity at the resolution.

That parallelism — the picture escalating in step with the story — is a large
part of what reads as "directed" rather than "shot."

## Pick exactly ONE component to carry escalation

This is the constraint that matters for a 15-second clip and the one an LLM will
not impose on itself. Given the framework, a model will happily escalate all
seven components at once. Everything gets more contrasty, more saturated, faster,
deeper, and louder simultaneously — which reads as chaos, or as a perfume advert.

**One component carries the curve. The other six stay in affinity, holding
still, so the one that moves is legible.**

Choosing which one is a genre decision:

| The scene is about | Carry it on |
|---|---|
| Someone being cornered, or gaining ground | **Space** — room around the character shrinks or opens |
| Concealment, guilt, exposure | **Tone** — flat light to hard shadow to silhouette |
| An emotional temperature change | **Color** — a cold field admitting one warm accent, or losing it |
| A decision, a break, an escape | **Movement** — stillness, then the one thing that moves |
| Panic, pursuit, a closing window | **Rhythm** — long beats collapsing to short ones |
| Order breaking down | **Line & shape** — a clean grid invaded by one wrong angle |

## Worked shapes

**Confession, carried on tone.** Beats 1–2 flat and evenly lit — affinity, low
intensity, nothing to look at yet. Beat 3 introduces exactly one hard shadow.
Beat 4 is near-silhouette against a window at the Impact — maximum contrast.
Beat 5 returns to flat light on an empty room — affinity, resolution. Nothing
else changes register: same palette, same cut length, same camera.

**Product reveal, carried on space.** Beats 1–2 shallow and tight, no depth cues,
the object ambiguous in scale. Beat 3 pulls back and layers foreground against a
deep background — the object resolves. Beat 4 is the maximum-depth hero frame.
Beat 5 flattens back to a clean lockup. Colour and cut rhythm stay constant
throughout, so the depth change is the only event.

**Pursuit, carried on rhythm.** 4s, 4s, 3s, 2s, 1s, **pause**, 2s. Every other
component held flat. The pause before the last beat is the whole effect — take it
out and the acceleration reads as noise.

## Stating it in an H3 prompt

The curve reaches the model as a **concrete per-beat progression of the chosen
component**, never as the word "intensity."

- Bad: *"The intensity builds throughout."*
- Bad: *"Increasingly dramatic and contrasty lighting."*
- Good: *"Beat 1 and 2 are lit flat and evenly, no visible shadow. At beat 3 a
  single hard-edged shadow crosses the left half of the frame. At beat 4 he is
  almost entirely dark against the bright window. At beat 5 the room is flatly
  lit again and empty."*

The good version is four checkable facts. The bad versions are adjectives, and H3
renders adjectives from its median taste.

Same rule for the components you are *holding*: say so. "The palette does not
change at any point in the film" is a real instruction and prevents H3 escalating
colour on its own initiative alongside your tone curve.
