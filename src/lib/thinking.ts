/**
 * Request-level controls for local Qwen-family models.
 *
 * llama.cpp's Qwen chat template understands these as top-level request
 * fields. They are intentionally kept out of `chat_template_kwargs`, which
 * is reserved for the template's `enable_thinking` switch.
 */

export const QWEN_REASONING_BUDGET_TOKENS = 0
export const QWEN_REASONING_BUDGET_MESSAGE = 'Time to stop thinking. Give the final answer.'

type LlamaEndpoint = {
  id?: string
  baseUrl: string
  sendCachePrompt?: boolean
}

const LOCAL_QWEN_ALIASES = new Set([
  'default',
  'thinkingcap-27b',
  'qwen38-heretic-27b-fast',
])

/**
 * Identify a llama.cpp endpoint without treating every OpenAI-compatible
 * endpoint as local llama.cpp. The explicit provider flag covers the built-in
 * llama.cpp connection; the route check covers the 5090 gateway and similar
 * configured `/llama/v1` endpoints; sendCachePrompt is the persisted marker
 * used by older custom llama.cpp connections.
 */
export function isLocalLlamaCppEndpoint(provider: LlamaEndpoint): boolean {
  const providerId = provider.id?.trim().toLowerCase() ?? ''
  if (provider.sendCachePrompt === true) return true
  if (providerId === 'llamacpp' || providerId === 'llama.cpp' || providerId === 'llama-cpp') return true

  try {
    const pathname = new URL(provider.baseUrl).pathname.toLowerCase()
    return /(?:^|\/)llama(?:\.cpp)?(?:\/|$)/.test(pathname)
  } catch {
    return false
  }
}

/** True for Qwen IDs and the named local aliases used by the 5090 router. */
export function isQwenFamilyModel(provider: LlamaEndpoint, model: string): boolean {
  if (!isLocalLlamaCppEndpoint(provider)) return false
  const modelId = model.trim().toLowerCase()
  if (LOCAL_QWEN_ALIASES.has(modelId)) return true
  // Handles Qwen3, qwen-35b, Qwen/Qwen3-30B, and vendor-qualified variants.
  return /(?:^|[\/_:.\-])qwen(?:$|[\/_:.\-]|\d)/i.test(modelId)
}

/**
 * Add the paired zero reasoning-budget fields to a request body when the
 * selected model is a local Qwen-family model. Non-Qwen and hosted payloads
 * are returned by identity so callers cannot accidentally alter their body.
 */
export function withQwenReasoningBudget<T>(provider: LlamaEndpoint, model: string, payload: T): T {
  if (!isQwenFamilyModel(provider, model) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...(payload as Record<string, unknown>),
    reasoning_budget_tokens: QWEN_REASONING_BUDGET_TOKENS,
    reasoning_budget_message: QWEN_REASONING_BUDGET_MESSAGE,
  } as T
}
