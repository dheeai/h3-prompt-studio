# Browser Agent tab implementation plan

1. Map the existing AppProvider actions and session types; define a narrow typed AgentTool API that delegates to deterministic state mutations only.
2. Add the Pi browser adapter and a cancellable agent session hook. Reuse the existing provider/model settings and preserve partial reasoning on abort.
3. Add the top-level Studio/Agent tab shell and Agent transcript, starter intents, tool cards, confirmation UI, and `Open in Studio` links. Keep all current Studio components mounted through the shared provider.
4. Wire tools for state inspection, canonical prompt/version updates, clip-plan updates, continuation preparation, single render, and multiclip submission. Add explicit confirmation gates for render operations.
5. Add compatibility tests for tool contracts, no nested `app.run()` calls, cancellation persistence, and canonical prompt invariants.
6. Run `npx tsc --noEmit`, `npm run build`, `npx tsx scripts/selftest.mjs`, `git diff --check`, and browser smoke checks at desktop and 821–869px widths.
