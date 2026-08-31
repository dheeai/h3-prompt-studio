# The Rule of Six — Murch's weighted critique rubric

Walter Murch, *In the Blink of an Eye*. Six criteria for whether a cut is right,
**ranked by weight**. An ideal cut satisfies all six; in practice they conflict,
and the ranking tells you which one to sacrifice.

| # | Criterion | Weight | The question |
|---|---|---:|---|
| 1 | **Emotion** | **51%** | Is the cut true to the emotion of the moment? |
| 2 | **Story** | **23%** | Does it advance the story or reveal character? |
| 3 | Rhythm | 10% | Does it happen at a rhythmically *right* moment? |
| 4 | Eye-trace | 7% | Does it acknowledge where the audience's focus already is, and where it lands in the new frame? |
| 5 | 2D plane | 5% | Does it respect screen direction — the grammar of three dimensions flattened to two? |
| 6 | 3D space | 4% | Does it respect the real continuity of the location? |

## Why the weights are the point for an LLM

Emotion and story together are **74%**. The bottom four are 26% combined.

An LLM directing without this ranking optimises for what is *checkable*: the
180° line, consistent screen direction, geographic continuity. Those are criteria
4–6 — a quarter of the score. That is why LLM-directed sequences come out
technically clean and emotionally inert. **The ranking is the correction.**

Murch's own framing: emotion is worth more than all five things underneath it
combined. If you must break continuity to stay true to the emotion of the moment,
break continuity.

## Using it as a critique pass

Grade a direction sheet before spending a generation, and the render after.
Score each criterion 0–1, multiply by its weight, sum.

```
weighted score = 0.51·E + 0.23·S + 0.10·R + 0.07·T + 0.05·P + 0.04·G
```

Then report **one** thing: the highest-weighted criterion that is failing. Fix
that alone and re-grade. Do not hand back six simultaneous notes — the whole
value of the ranking is that it serialises the work.

### Reading the scores

| Score | Reading |
|---|---|
| < 0.30 | The piece is decorative. Go back to the scene formula — usually the desire or the break was never named. |
| 0.30 – 0.60 | Emotion or story is missing. Almost always: no *break*, or the break is not visible on screen. |
| 0.60 – 0.80 | Working. The failures are in rhythm/eye-trace — usually no held beat before the impact. |
| > 0.80 | Ship it. |

**A sheet that scores continuity-perfect and emotionally inert lands at 0.16.**
If your critique keeps returning "geometry is inconsistent" as the top note on a
piece that also has no emotional through-line, the rubric is being applied
without its weights.

### Rubric questions, expanded

**Emotion (51%).** What is the viewer supposed to feel at this exact instant?
Does the cut arrive when that feeling peaks, or a beat early/late? Is the feeling
*visible* — on a body, in the space — or only asserted?

**Story (23%).** What does the viewer know after this cut that they did not know
before? If the answer is "nothing," the cut is a rhythm cut and must justify
itself on criterion 3 alone — worth 10%.

**Rhythm (10%).** Is there a held beat before the biggest change? Metronomic
cutting scores low here even when every individual cut is defensible.

**Eye-trace (7%).** Where is the viewer's gaze in the last 0.3s of the outgoing
shot, and where does the incoming shot want it? A cut that moves the point of
interest across the frame costs the viewer a beat of re-orientation — sometimes
that cost is the effect you want; usually it is an accident.

**2D plane (5%).** Screen direction. If she exits frame right, she enters frame
left. Breaking it deliberately is a statement; breaking it accidentally is a
mistake nobody can name but everybody feels.

**3D space (4%).** The 180° line and the real geometry of the location. Lowest
weight, most obsessed over.

## On H3 specifically

H3 renders all the cuts in one pass, so criteria 5 and 6 are only *partly* yours
— the model reconstructs the space at every cut and will invent geography if the
prompt does not pin it. Two consequences:

- Score 5 and 6 **on the render**, not on the sheet. On the sheet, the only
  question is whether you *stated* the geometry in one sentence.
- Score 1–4 **on the sheet**, before generating. They are fully determined by
  your decisions, and they are 91% of the weight. Grading them costs nothing and
  saves the generation.
