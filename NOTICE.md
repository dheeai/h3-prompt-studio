# Third-party material

The skills bundled with this deployment are not all our own work. This file
records what came from where.

## MiniMax — `h3-prompting`

`skills/h3-prompting/references/base_guide.md` and `ref_guide.md` are **verbatim
copies of MiniMax's own H3 documentation**, from
`MiniMaxAI/MiniMax-H3/docs/*` on HuggingFace:

- https://huggingface.co/MiniMaxAI/MiniMax-H3

They are redistributed here unmodified, and verified byte-identical against
upstream, so the prompt format is available to the model at authoring time.
`docs/` upstream holds exactly these two guides plus a licence Q&A:

- https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/QA-about-License.md

That Q&A concerns regional restrictions on the model weights rather than the
documentation. The model card lists the licence as "other" — consult MiniMax's
terms before redistributing these documents yourself.

`h3-prompting/SKILL.md` is ours: it is our synthesis of those guides plus
failure modes measured on our own runs.

## Higgsfield — `h3-lira`, `h3-acting`

The **LIRA** image-prompt methodology and the **ACTING** performance system are
**Higgsfield's**. Our `h3-lira` and `h3-acting` skills restate their
model-agnostic core for use with MiniMax H3, and cross-reference them against
each other and against `h3-direction`.

The methodologies are Higgsfield's; the framing, the H3-specific compilation
notes and the cross-references are ours. Higgsfield's own product routing and
product names are deliberately not carried across.

## Ours

`h3-direction` and its references, `h3-prompting/SKILL.md`, and the application
itself.

MIT, per `LICENSE` — which covers our own work, not the third-party documents
listed above.
