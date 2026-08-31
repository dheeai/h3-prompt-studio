import { markSent, wasSent } from './context'
import type { Provider } from './types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface StreamOptions {
  provider: Provider
  model: string
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
  /** Hash of the cached prefix, so we can report whether it was reused. */
  contextHash?: string
  signal?: AbortSignal
  onDelta: (chunk: string) => void
}

export interface StreamResult {
  text: string
  ms: number
  cacheReused: boolean
}

/**
 * One OpenAI-compatible streaming client for every lane.
 *
 * Ollama, LM Studio and llama.cpp all expose /v1/chat/completions, so there is
 * no reason for four code paths. The only per-provider variation is the
 * cache_prompt flag, which llama.cpp understands and others reject as an
 * unknown field — so it is opt-in per provider rather than always sent.
 */
export async function streamChat(opts: StreamOptions): Promise<StreamResult> {
  const { provider, model, messages, temperature, maxTokens, signal, onDelta } = opts
  const started = performance.now()
  const cacheReused = !!opts.contextHash && wasSent(opts.contextHash)

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: true,
  }
  if (provider.sendCachePrompt) body.cache_prompt = true

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`
  if (/openrouter\.ai/.test(provider.baseUrl)) {
    // OpenRouter attributes traffic by these; both are optional.
    headers['HTTP-Referer'] = location.origin
    headers['X-Title'] = 'H3 Prompt Studio'
  }

  const url = `${provider.baseUrl.replace(/\/$/, '')}/chat/completions`
  const send = (payload: Record<string, unknown>) =>
    fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal })

  let res = await send(body)

  // A ceiling larger than the model's context is a 400, not a clamp, on most
  // servers. Rather than force everyone to know their context size, drop the
  // limit and let the server apply its own.
  if (!res.ok && res.status === 400) {
    const detail = await res.clone().text().catch(() => '')
    if (/max_tokens|max_completion_tokens|context length|context_length|n_predict|too large|exceed/i.test(detail)) {
      const { max_tokens: _dropped, ...withoutLimit } = body
      res = await send(withoutLimit)
    }
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line; a frame may carry several
    // `data:` lines. Keep the tail in the buffer until it completes.
    let idx: number
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)
      for (const line of frame.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; reasoning?: string }; text?: string }[]
          }
          const choice = json.choices?.[0]
          // Reasoning models stream their thinking on a separate key; it is
          // not part of the answer, so it is dropped rather than shown.
          const piece = choice?.delta?.content ?? choice?.text ?? ''
          if (piece) {
            text += piece
            onDelta(piece)
          }
        } catch {
          // A partial frame that slipped through — ignore and keep reading.
        }
      }
    }
  }

  if (opts.contextHash) markSent(opts.contextHash)
  return { text, ms: Math.round(performance.now() - started), cacheReused }
}
