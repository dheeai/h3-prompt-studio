import { localEndpoint, localNetworkTarget } from './providers'

/**
 * Request-level controls for local Qwen-family models.
 *
 * llama.cpp's Qwen chat template understands these as top-level request
 * fields. They are intentionally kept out of `chat_template_kwargs`, which
 * is reserved for the template's `enable_thinking` switch.
 */

/**
 * Default reasoning ceiling.
 *
 * Lowered 8192 -> 4096 (2026-09-08). Measured on 10 briefs x 20 blind
 * pairwise judgements: 8k beat 4k 11-8-1, p=0.65 — no measurable quality
 * difference — for 45% fewer completion tokens (5.1k vs 9.3k) and ~40% less
 * wall-clock. 1k IS materially worse (4k won 19-1, p=0.00004), so the cliff
 * sits between 1k and 4k rather than on a slope. MAX stays 8192.
 */
export const QWEN_REASONING_BUDGET_DEFAULT = 4096
/** Hard ceiling on reasoning, everywhere. Founder, 2026-09-07: thinking must
 * be bounded to 8k "even if the provider is openrouter". A budget above this
 * is clamped rather than refused, so an older persisted setting still loads. */
export const QWEN_REASONING_BUDGET_MAX = 8192
export const QWEN_REASONING_BUDGET_MESSAGE = 'Time to stop thinking. Give the final answer.'

type LlamaEndpoint = {
  id?: string
  baseUrl: string
  sendCachePrompt?: boolean
  /** Explicit override; undefined means infer. See `reasoningBudgetSupported`. */
  supportsReasoningBudget?: boolean
}

/**
 * Paths on an otherwise-local host that are NOT llama.cpp.
 *
 * The 5090 gateway fronts several backends behind one host, so "local" does
 * not imply llama.cpp: `/ninfer/v1` is a from-scratch C++/CUDA engine that
 * accepts `reasoning_budget_tokens` and ignores it. Without this guard the
 * endpoint check below would hand it a ceiling it does not implement, and the
 * request body would claim a bound that never existed.
 */
const NOT_LLAMACPP_PATHS = [/\/ninfer(\/|$)/i, /\/vllm(\/|$)/i, /\/render(\/|$)/i]

function pathIsNotLlamaCpp(baseUrl: string): boolean {
  try {
    return NOT_LLAMACPP_PATHS.some((re) => re.test(new URL(baseUrl).pathname))
  } catch {
    return false
  }
}

/**
 * Will a per-request reasoning ceiling actually take effect here?
 *
 * Callers must use this rather than assuming: a UI or log that reports a
 * budget the server ignores is worse than one that admits it is unbounded.
 */
export function reasoningBudgetSupported(provider: LlamaEndpoint, model: string): boolean {
  if (provider.supportsReasoningBudget === false) return false
  if (pathIsNotLlamaCpp(provider.baseUrl)) return false
  if (provider.supportsReasoningBudget === true) return true
  return isLocalLlamaCppEndpoint(provider) || isQwenFamilyModel(provider, model) || isOpenRouter(provider)
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const tokens = normalizeThinkingBudget(budget)

  // ANY model on a local llama.cpp endpoint gets the paired fields, not just
  // the Qwen family. `reasoning_budget_tokens` is a property of the SERVER, so
  // gating it on the model name left real local reasoning models unbounded —
  // `huihui-thinkingcap-27b` is a slug this gateway serves and it matched
  // neither the alias list nor the /qwen/ pattern, so it thought without any
  // ceiling at all. llama.cpp ignores fields it does not know, so widening
  // this cannot break a non-reasoning local model.
  // An endpoint that ignores the fields must not be sent them: see
  // `reasoningBudgetSupported` and the ninfer measurement on Provider.
  if (!reasoningBudgetSupported(provider, model)) return payload

  if ((isLocalLlamaCppEndpoint(provider) || isQwenFamilyModel(provider, model)) && !pathIsNotLlamaCpp(provider.baseUrl)) {
    return {
      ...(payload as Record<string, unknown>),
      reasoning_budget_tokens: tokens,
      reasoning_budget_message: QWEN_REASONING_BUDGET_MESSAGE,
    } as T
  }

  // OpenRouter exposes a UNIFIED reasoning control across the models it
  // fronts, so a hosted model is no longer left to think without a ceiling —
  // which is what "unbounded thinking" meant in practice: a reasoning model
  // on OpenRouter could spend arbitrarily long before emitting a token, with
  // no budget field sent at all.
  if (isOpenRouter(provider)) {
    return { ...(payload as Record<string, unknown>), reasoning: { max_tokens: tokens } } as T
  }

  // Anything else is returned untouched ON PURPOSE. There is no portable
  // reasoning-budget field across OpenAI-compatible servers, and inventing one
  // risks a 400 from a server that rejects unknown keys — the completion's own
  // `max_tokens` is the bound that always applies.
  return payload
}

/** OpenRouter, by endpoint rather than by provider id, so a renamed or
 * hand-added provider pointed at it is still recognised. */
export function isOpenRouter(provider: LlamaEndpoint): boolean {
  try {
    return /(?:^|\.)openrouter\.ai$/.test(new URL(provider.baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}
