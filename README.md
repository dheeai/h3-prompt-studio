# H3 Prompt Studio

Load the craft documents you trust, paste a story, and refine it into a video
prompt the model actually obeys.

It runs **entirely in your browser**. No backend, no account, no telemetry.
Your text goes only to the model endpoint you choose. Skills you upload are
kept in your own browser and are there next time you open the page.

---

## The idea

A good video prompt is mostly craft knowledge, and craft knowledge lives in
documents. This app puts those documents in front of the model as a stable,
cached block, then walks a draft through four stages against them:

**Direct** → a direction sheet: anchors, escalation, a beat grid, shot cards.
**Draft** → the prompt itself, in the official field structure.
**Critique** → an audit against the loaded documents.
**Revise** → the corrections applied, and nothing else touched.

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

2. **Plain HTTP on *another* machine is blocked.** The localhost exemption
   does not extend to other hosts, so `http://some-box.local:9000/v1` from an
   HTTPS page is refused as mixed content *before the request is sent*. No
   CORS header can fix it. Two ways out:
   - give the box a real HTTPS name — for a Tailscale host,
     `tailscale serve --bg 9000` issues a certificate and serves it over
     `https://<host>.ts.net`;
   - or run this app over `http://localhost` yourself (`npm run serve`),
     where there is no mixed content at all.

The Connect panel diagnoses which of these you have hit, rather than reporting
a bare network error.

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

`public/skills/` is what a visitor gets on first load. It is **empty and
gitignored by default**, because anything placed there is served to everyone
who opens your deployment. Baking is therefore an explicit local act:

```bash
node scripts/bake-skills.mjs ~/.claude/skills/h3-direction ~/.claude/skills/h3-prompting
node scripts/bake-skills.mjs --glob '~/.claude/skills/h3-*'
node scripts/bake-skills.mjs --clear
```

> **Check before you bake.** If your skills live in a private repo, baking
> them and deploying publishes them. Only bake documents you intend to make
> public.

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
