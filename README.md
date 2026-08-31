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

`h3-direction` in full, and `h3-prompting`'s `SKILL.md`.

`h3-prompting`'s two reference files are **not** included: they are verbatim
copies of MiniMax's own documentation, which is published under a custom
licence rather than a permissive one. `SKILL.md` says where they live
(`huggingface.co/MiniMaxAI/MiniMax-H3`, under `docs/`) — fetch them from the
source and add them through the Skills panel, and they stay in your browser.

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
