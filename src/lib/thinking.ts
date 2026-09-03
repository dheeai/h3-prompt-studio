import { localEndpoint, localNetworkTarget } from './providers'

/**
 * Request-level controls for local Qwen-family models.
 *
 * llama.cpp's Qwen chat template understands these as top-level request
 * fields. They are intentionally kept out of `chat_template_kwargs`, which
 * is reserved for the template's `enable_thinking` switch.
 */

export const QWEN_REASONING_BUDGET_DEFAULT = 8192
export const QWEN_REASONING_BUDGET_MAX = 32768
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

const KNOWN_HOSTED_HOSTS = [
  'openrouter.ai',
  'api.openai.com',
  'anthropic.com',
  'api.anthropic.com',
  'api.groq.com',
  'api.deepseek.com',
  'api.x.ai',
  'api.mistral.ai',
]

/** A stable, collision-safe key for a provider/model pair in Settings. */
export function thinkingBudgetKey(providerId: string, model: string): string {
  return JSON.stringify([providerId.trim(), model.trim()])
}

/** Normalize user or persisted input to the supported integer token range. */
export function normalizeThinkingBudget(value: unknown, fallback = QWEN_REASONING_BUDGET_DEFAULT): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(number)) return fallback
  return Math.min(QWEN_REASONING_BUDGET_MAX, Math.max(0, Math.round(number)))
}

/** Normalize a persisted map while ignoring malformed entries. */
export function normalizeThinkingBudgets(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, number> = {}
  for (const [key, budget] of Object.entries(value)) {
    if (typeof budget !== 'number' && typeof budget !== 'string') continue
    const parsed = normalizeThinkingBudget(budget, Number.NaN)
    if (Number.isFinite(parsed)) result[key] = parsed
  }
  return result
}

/** Resolve a provider/model-specific budget, defaulting new pairs to 8k. */
export function resolveThinkingBudget(providerId: string, model: string, budgets: Record<string, number> | undefined): number {
  const key = thinkingBudgetKey(providerId, model)
  return normalizeThinkingBudget(budgets?.[key])
}

function isKnownHostedHost(hostname: string): boolean {
  return KNOWN_HOSTED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

/**
 * Identify a llama.cpp endpoint without treating every OpenAI-compatible
 * endpoint as local llama.cpp. Provider markers are only trusted on a
 * concrete local/private/Tailscale/mDNS host. A `/llama/...` route is an
 * explicit gateway signal, except on known hosted endpoints.
 */
export function isLocalLlamaCppEndpoint(provider: LlamaEndpoint): boolean {
  const providerId = provider.id?.trim().toLowerCase() ?? ''
  try {
    const url = new URL(provider.baseUrl)
    if (isKnownHostedHost(url.hostname.toLowerCase())) return false

    const pathname = url.pathname.toLowerCase()
    if (/(?:^|\/)llama(?:\.cpp)?(?:\/|$)/.test(pathname)) return true

    const marker = provider.sendCachePrompt === true || providerId === 'llamacpp' || providerId === 'llama.cpp' || providerId === 'llama-cpp'
    const localHost = localEndpoint(provider.baseUrl) || localNetworkTarget(provider.baseUrl) !== null
    return marker && localHost
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
 * Add the paired reasoning-budget fields to a request body when the selected
 * model is a local Qwen-family model. Non-Qwen and hosted payloads are
 * returned by identity so callers cannot accidentally alter their body.
 */
export function withQwenReasoningBudget<T>(provider: LlamaEndpoint, model: string, payload: T, budget = QWEN_REASONING_BUDGET_DEFAULT): T {
  if (!isQwenFamilyModel(provider, model) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  return {
    ...(payload as Record<string, unknown>),
    reasoning_budget_tokens: normalizeThinkingBudget(budget),
    reasoning_budget_message: QWEN_REASONING_BUDGET_MESSAGE,
  } as T
}
