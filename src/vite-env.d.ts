/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Local-only default style stack — see `localLoraStackOverride` in `lib/chain.ts`.
   * Set in a gitignored `.env.local`; absent from the public GitHub Pages build. */
  readonly VITE_LOCAL_LORA_STACK?: string
  /** Local-only ComfyUI base URL, e.g. a `tailscale serve` HTTPS front. Added
   * as a built-in endpoint when set. Absent from the public build, so the
   * gateway's hostname is never published. */
  readonly VITE_LOCAL_COMFY_URL?: string
  /** Local-only OpenAI-compatible LLM base URL (must end in the version
   * segment, e.g. `.../llama/v1`). Same publishing property as above. */
  readonly VITE_LOCAL_LLM_URL?: string
  /** Model id to preselect for `VITE_LOCAL_LLM_URL`. */
  readonly VITE_LOCAL_LLM_MODEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
