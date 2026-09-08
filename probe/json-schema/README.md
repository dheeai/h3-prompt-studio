# Probe — does a JSON schema make a better H3 prompt?

Throwaway A/B. Nothing here is imported by the app. If it proves out, the
schema moves into `src/lib/` and this directory goes away.

## Run it

```bash
cd ~/Projects/h3-prompt-studio
node_modules/.bin/tsx probe/json-schema/probe.ts            # the full 4x2 matrix
node_modules/.bin/tsx probe/json-schema/probe.ts --dry       # build the bodies, send nothing
```

Endpoint and model come from the gitignored `.env.local`
(`VITE_LOCAL_LLM_URL`, `VITE_LOCAL_LLM_MODEL`), overridable with `LLM_URL`,
`LLM_MODEL`, `LLM_KEY`. No host is hardcoded — this repo is public with a
live Pages deploy.

Flags: `--modes a,b` · `--brief dialogue|silent` · `--repeats N` ·
`--h3mode Ref2VA|T2VA` · `--max-tokens N` · `--temp N` · `--dry`.

Typecheck after an edit: `node_modules/.bin/tsc -p probe/json-schema/tsconfig.json`.

`out/` is gitignored — the dumped request bodies embed the whole ~34k-token
skill corpus.

## The four modes

| mode | what is sent | what it isolates |
|---|---|---|
| `text` | nothing extra — byte-for-byte what the Studio sends today | the baseline |
| `json_object` | `response_format: {type:'json_object'}` + the key list in the prompt | is valid JSON alone enough? |
| `json_schema` | a compiled grammar over six required string fields | does a hard constraint beat an instruction? |
| `json_schema_shots` | same, but the body is an array of `{at, prose}` | does forcing the shot grid help the prose, or chop it up? |

The system prompt is **identical across all four** — only `response_format`
and a short key-list instruction vary. That is the control. Measured: the
`draft` system prompt is ~34.6k tokens over 12 skill files, so a saving in
completion tokens is a saving against a large fixed prefix, not against the
whole call.

## What it measures, and what it cannot

Scored with the app's own `lint()` from `src/lib/lint.ts`, so the columns mean
the same thing they mean in the UI.

- **`fields`** — sections actually present and non-empty.
- **`body`** — word count of `detailed_description`. The skill wants 350–500;
  measured output "lands near 200 and that is too thin." **No schema can
  express a word count**, so this is the one thing the grammar cannot fix and
  the number to watch most.
- **`errs` / `warns`** — real lint findings: a spoken line with no `<d>` tag, a
  timestamp on `[Shot 1]`, voice content in `overall_soundscape`, camera verbs
  outside the controlled vocabulary.
- **`think`** — **the open question.** A strict grammar forbids `<think>` at
  position 0. Depending on the build and whether `--jinja` /
  `--reasoning-format` is on, llama.cpp either exempts the reasoning block via
  a lazy grammar or the model cannot think at all. A `NO` in this column
  against a `text` row that says `yes` is the answer.
- **`json`** — `FAIL` means unparseable, which under `json_schema` should be
  impossible. If it happens, the endpoint ignored the field.

An HTTP refusal is not a bug in the probe — it is the answer to "does this
endpoint support the field", and refusals are printed separately at the end.

**The lint columns say whether a prompt is well FORMED, not whether it is any
GOOD.** Read the `out/*.prompt.txt` files for that.

## The two briefs

Both are the failure modes `h3-prompting` names explicitly:

- **`dialogue`** — someone speaks, so every line must carry both a `(Sx)`
  speaker id and the words inside `<d>[Language] …</d>`. Describing speech
  without supplying words synthesises voice-shaped noise.
- **`silent`** — nobody speaks, which any speech verb in the prose will
  undo, *including one inside a denial* ("she does not speak" still trips it).
  Also the `non_diegetic_music: N/A` sentinel: a sentence describing the
  absence of music is a spec of a score with "don't" in front of it.

## Output

`out/<mode>-<brief>-<n>.prompt.txt` — the assembled canonical prompt.
`out/<mode>-<brief>-<n>.raw.txt` — reasoning and raw content as returned.
`out/runs.json` — every metric, for diffing across sessions.
