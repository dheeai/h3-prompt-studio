# H3 Prompt Studio

Load the craft documents you trust, paste a story, and refine it into a video
prompt the model actually obeys.

It runs **entirely in your browser**. No backend, no account, no telemetry.
Your text goes only to the model endpoint you choose.

**What a refresh keeps, and what it deliberately throws away.** Your
configuration persists: the skills you have loaded, your model and endpoint
settings, and the ComfyUI workflows you have dropped in. Your *work* does
not. The draft, its passes, the clip plan, the film context, the plates and
the rendered clips are all cleared on load. Work that reappears by itself is
work you have to remember to discard before you can trust what is on the
page, so a refresh always starts clean.

---

## The idea

A good video prompt is mostly craft knowledge, and craft knowledge lives in
documents. This app puts those documents in front of the model as a stable,
cached block, then walks a draft through four stages against them:

**Direct** → a direction sheet: anchors, escalation, a beat grid, shot cards.
**Draft** → the prompt itself, in the official field structure.
**Critique** → an audit against the loaded documents.
**Revise** → the corrections applied, and nothing else touched.

Draft, Revise and a freeform note all come back as **two sections**: the
prompt itself, and an explanation of why it is the way it is (which document
governed each decision, what was fixed vs. what was open craft, and — for
Draft — where the source stood before it was directed). The two are kept
apart on the page and in the clipboard: "Copy prompt" copies only the prompt,
and the prompt check only ever runs on the prompt, never on the prose next to
it.

A story that needs more than one clip has its own pass: **Break into clips**
reads the source, decides how many H3 clips it actually needs (one clip is
one dramatic unit, roughly 6–15 seconds), and gives each one a role, a
duration and exactly what it covers. Each clip in the plan can be sent
straight into Direct with everything it needs to stay a *part* of the film
rather than a small complete film of its own — the same machinery that
already governs a manually-chained multi-clip film.

Once every clip in that plan has a prompt, the whole plan can go to ComfyUI
as **one Long Media multiclip job** rather than a render per clip. Two things
about that path are worth knowing before you use it, both measured rather
than assumed:

- **The mode is load-bearing.** Long Media has six workflow modes, and four
  of them take a single prompt for the whole duration. Handing several clips'
  prose to one of those returns correct picture, hallucinated action and *no
  dialogue at all* — nothing tells a single-prompt segmenter which sentence
  belongs to which segment. Only `multiclip` takes a prompt per clip, so that
  is the only mode this ever writes.
- **The film delivers less than you asked for, unless the overlap is paid.**
  Every clip after the first repeats the previous clip's last frames at its
  head and then trims them, so it delivers fewer frames than it renders. The
  panel therefore shows authored, rendered and delivered frames per clip, and
  the real delivered running time, before you spend anything.

References on that path are global — every clip sees every plate, capped at
H3's nine — and the geometry is chosen from the resolutions that have
actually been measured on the box. The largest of them is known to run out of
memory past roughly 362 frames, and that failure takes ComfyUI down with it
and leaves an empty history, so a crashed render is indistinguishable from
one that was never submitted. You get told, not blocked: the fix is to trade
resolution for length.

Alongside that runs a **prompt check** — deterministic rules, no model
involved. It catches things that only show up after you've burned a render:

- `non_diegetic_music` describing the absence of music instead of being
  exactly `N/A`. A described absence is a specification of a score with
  "don't" in front of it, and the model will write one.
- Rhythm vocabulary anywhere else in a prompt that is meant to be silent —
  "on the beat", "100 BPM", even the name of your own system if it happens
  to contain the word *instrument*.
- Silence written as a denial (*"she does not speak"*), which is the same
  failure in a different modality.
- Timing gaps, undeclared reference labels, on-screen text over the glyph
  budget, soundscapes that name a mood instead of a source.

---

## What you can paste

The source box takes anything — a story, a brief, a rough shot list, a
half-finished prompt, a finished one. A **Standing** strip under the box
reads it deterministically (no model involved) and says where it sits before
you run anything:

- **A story or an idea** — narrative prose, nothing decided about how it is
  shot yet. Suggested next step: Direct.
- **A brief** — a specification of what is wanted (bullets, "we need",
  "deliverable", a duration), not yet a decision about how to shoot it.
  Suggested: Direct.
- **A direction sheet** — already has anchors, a beat grid, shot cards, or
  the words "WHAT THE BRIEF FIXES". Suggested: Draft.
- **A rough prompt** — the shot decisions exist (timecodes, camera and
  shot-size vocabulary, `<Subject N>`-style labels) but not in the official
  field structure, or the field names are there in the wrong casing or
  formatting (Title Case, markdown-bolded, a heading). Suggested: Direct,
  to rebuild it properly rather than patch the formatting.
- **A finished prompt** — the canonical field names, at line start, with a
  colon. Suggested: Critique.

The strip shows what it found evidence of (`has: …`), what is still missing
(`lacks: …`), and a **suggested** stage as a one-click chip. It is a first
read, for you and for the model to confirm or correct — not a verdict, and
Direct is handed the same read so it can disagree with it in the open.

---

## Running it

```bash
npm install
npm run dev          # http://localhost:5173
```

Build and serve the static bundle:

```bash
npm run build
npm run serve        # http://localhost:5178
```

Or, once published, `npx h3-prompt-studio`.

---

## Connecting a model

Any OpenAI-compatible endpoint works. Built-in entries:

| | Endpoint | Setup |
|---|---|---|
| **Ollama** | `http://localhost:11434/v1` | `OLLAMA_ORIGINS=<page origin> ollama serve` |
| **LM Studio** | `http://localhost:1234/v1` | Developer ▸ Settings ▸ **Enable CORS** |
| **llama.cpp** | `http://localhost:8080/v1` | permissive CORS by default |
| **OpenRouter** | `https://openrouter.ai/api/v1` | your own API key |

Add any other endpoint from the **Connect** panel.

An output cap can also come from the endpoint's own side rather than from
anything this app sends — a metered provider enforcing its own ceiling, or a
local server that clamps a request down regardless of what "output length"
in Settings asks for. That kind of cap cannot be raised from here. So a reply
that gets cut off mid-answer is continued automatically in follow-up requests
and stitched back onto what was already written; one that gets cut off
mid-*thought*, before any answer at all, gets one recovery request built from
its own thinking, asking it to write the answer now rather than re-deliberate
from scratch. Either way the pass is saved as soon as it stops growing, with
a note if it is still incomplete after every continuation was used up.

### Can a page on GitHub Pages talk to a model on my machine?

**Yes — with two caveats.** Browsers treat `http://localhost` (and
`127.0.0.1`, `::1`) as a *secure origin*, so an HTTPS page is permitted to
call them. This is specified behaviour, not a loophole. After the one-time
CORS setting above, a hosted copy of this app drives your local model
directly.

The caveats:

1. **Safari won't.** It is the one browser that does not treat
   `http://localhost` as secure. Use Chrome, Edge or Firefox — or run the app
   locally with `npm run serve`.

2. **A model on another machine on your network needs *two* things cleared,
   not one.** They are independent, and fixing the first does not fix the
   second:

   - **Mixed content.** Plain HTTP on a non-localhost host is refused before
     the request is sent. Give the box a real HTTPS name — for a Tailscale
     host, `tailscale serve --bg 9000` issues a certificate and serves on 443.
     Note that the front-end is then on **443, not the app's own port**:
     `https://<host>.ts.net/llama/v1`, not `https://<host>.ts.net:9000/...`.
   - **Local Network Access.** Chrome separately requires *permission* for a
     public origin to reach a private-range address — judged on the
     destination IP, not the scheme. Tailscale hands out `100.64.0.0/10`
     (CGNAT), which falls in that range, as do `192.168.x`, `10.x` and
     `.local` names. This is a prompt, not a wall: allow it and the endpoint
     works normally.

   The catch is that Chrome only shows that prompt in response to a **user
   gesture**. A probe fired automatically on page load has no gesture, so it
   silently waits and eventually times out — which looks exactly like a dead
   server. Press **Check** in the Connect panel and allow it when asked.

   *Measured:* `https://<host>.ts.net/llama/v1/models` from a page on
   `github.io` timed out after 31 s while the permission was unresolved, and
   returned 200 with 17 models in **274 ms** once granted. `curl` reaches it in
   6 ms regardless — curl has no such policy, so it cannot reproduce or
   diagnose either gate.

   `localhost` is exempt from both, which is why it needs no setup at all.
   Running the app locally (`npm run serve`) also sidesteps the permission
   entirely.

The Connect panel diagnoses which gate you have hit, rather than reporting a
bare network error. It also catches the two URL mistakes that look like
network failures: pointing `https://` at a plaintext port (the TLS handshake
fails in milliseconds), and a base URL that does not end in `/v1`.

### About API keys

A static site has nowhere to hide a secret. A key you enter is stored in your
browser and sent straight from your browser to that provider. That is fine for
your own machine and **not** fine on a shared one. There is no server here that
could hold it for you.

---

## Skills

A skill is a folder with a `SKILL.md` at its root, optionally with reference
documents beside it. Loose `.md` files work too — each becomes a skill of its
own, which is how a single acting or direction note gets in without ceremony.

Add them by dropping a folder, files or a `.zip` onto the **Skills** panel, or
by URL (a raw markdown file, or a JSON manifest of
`{name, description, files: {rel: url}}`). They persist in IndexedDB. Use
**Export all** before clearing site data — uploaded skills exist nowhere else.

Every file is individually selectable with its own token cost, because loading
a whole corpus into a local model's context is rarely what you want.

### Shipping skills with a deployment

`public/skills/` is what a visitor gets on first load. Baking into it is an
explicit local act, and the directory is deliberately **not** gitignored — so
`git status` always shows exactly what a deploy would publish.

```bash
node scripts/bake-skills.mjs ~/.claude/skills/h3-direction
node scripts/bake-skills.mjs --glob '~/.claude/skills/h3-*'
node scripts/bake-skills.mjs <skill-dir> --exclude 'references/ref_guide.md'
node scripts/bake-skills.mjs --clear
```

> **Check before you bake.** If your skills live in a private repo, baking
> them and deploying publishes them. Only bake documents you intend to make
> public — and use `--exclude` for files a skill quotes but does not own.

### What this deployment ships

`h3-direction` in full, `h3-prompting` with its two official reference guides,
and two reference-craft skills:

- **`h3-lira`** — authoring the reference *image*: identity sheets, object
  anchors, location plates, character-state edits.
- **`h3-acting`** — directing the *performance* in the video that cites it:
  master character profile, per-scene objective/obstacle/stakes, per-shot
  tactic and observable behaviour.

They are deliberately separate. LIRA governs what a character looks like;
ACTING governs what they do. They apply at different stages and are rarely
wanted at the same time, so loading one should not cost you the other's
context.

Not all of this is our own work — the H3 reference guides are MiniMax's and the
LIRA/ACTING methodologies are Higgsfield's. See **[NOTICE.md](NOTICE.md)**.

---

## The cached layer

Selected skill files are assembled into one system block that is
**deterministic** — skills sorted by id, files sorted within a skill, the same
wrapper text every time. Nothing that varies per request goes inside it.

That byte-stability is the entire point: an unchanged prefix is what lets
llama.cpp and Ollama reuse their KV cache instead of re-reading tens of
thousands of tokens of skill on every turn. The reading strip shows the
estimated size and whether this exact prefix has been sent yet.

If you edit the stage prompts, keep the skills out of them — repeating skill
text in the user turn defeats the cache and wastes the budget twice.

Token counts are estimates (`chars / 4`). A real tokenizer would cost ~2 MB of
bundle for a number that only drives a budget meter.

---

## Deploying to GitHub Pages

`.github/workflows/pages.yml` builds and publishes on every push to `main`.
Enable Pages for the repo with **Source: GitHub Actions**. The build uses a
relative base, so it works from any repo path without configuration.

---

## Layout

```
src/lib/skills.ts     discovery, upload, zip/url import, persistence
src/lib/context.ts    the deterministic cached block
src/lib/providers.ts  endpoints, probing, mixed-content diagnosis
src/lib/llm.ts        one OpenAI-compatible streaming client
src/lib/stages.ts     editable stage prompts
src/lib/lint.ts       the deterministic prompt check
src/app/state.tsx     application state
scripts/bake-skills.mjs
bin/serve.mjs         static server for the localhost escape hatch
design/               the design canvas source (.dc.html artboards)
```

MIT.
