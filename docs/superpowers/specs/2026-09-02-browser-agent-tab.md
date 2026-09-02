# Browser Agent tab — product and architecture spec

## Goal

Add an `Agent (beta)` tab beside the existing `Studio` tab. The new surface lets a user direct the same configured LLM through a browser-native Pi agent while preserving the current Studio workflow unchanged.

## Non-negotiables

- Studio remains the default tab and keeps every existing Story, Prompt, Idea, skills, settings, continuation, ComfyUI render, multiclip, history, stop, and streaming behavior.
- There is one source of truth for the current prompt, clip plan, film context, skills, settings, and version history. Agent actions update that store; they never create a shadow prompt store.
- Agent tools are deterministic state operations. They may read or write Studio state and request an explicit render, but must never call `app.run()` or another LLM stage. This prevents nested calls and continuous loops.
- The canonical prompt is always the prompt submitted to ComfyUI, whether it was authored in Studio or by the Agent.
- Stop preserves visible partial thinking and cancels the active stream/tool operation.

## Agent experience

- Header navigation: `Studio` and `Agent (beta)`; shared `Skills`, `Settings`, model connection, and ComfyUI status controls remain available.
- Empty state offers starter intents: `Turn this idea into a prompt`, `Break this story into clips`, `Continue from the selected clip`, and `Improve the current prompt`.
- The transcript shows user messages, retained reasoning, tool operation cards, and final summaries. Each operation card exposes the affected clip/version and an `Open in Studio` affordance.
- Agent can inspect the current session, propose edits, apply a canonical prompt/version, prepare continuation context, render one clip, or submit a multiclip job. Render and multiclip submission require a visible confirmation step.
- Agent can be left for Studio at any time; returning shows the same session state and history.

## Browser runtime

Use `@mariozechner/pi-agent-core` with a custom browser `streamFn` adapter backed by the existing provider connection. Keep API keys behind the existing configured proxy/provider boundary; do not expose new secrets in the browser bundle. Do not depend on Node-only `pi-coding-agent` APIs.

## Tool contract

Initial tools: `read_studio_state`, `set_current_prompt`, `append_prompt_version`, `set_clip_plan`, `prepare_continuation`, `render_current`, and `render_multiclip`. All mutations go through typed AppProvider actions and produce an audit entry in the transcript.

## Failure and cancellation

All agent streams and tool calls accept an `AbortSignal`. Stop/Escape cancels the active operation, keeps the partial reasoning in the transcript, and leaves the last committed canonical prompt intact. A failed frame extraction or ComfyUI request is reported as a recoverable tool error, never silently replaced with stale data.

## Compatibility checks

Before shipping the tab, verify Vite can bundle the Pi core adapter, existing TypeScript/build/self-test suites remain green, and a browser smoke test covers tab switching, a prompt mutation, stop-with-partial-thinking, and explicit render confirmation.
