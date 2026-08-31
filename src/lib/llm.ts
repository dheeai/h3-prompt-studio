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
  /** Thinking tokens, streamed separately from the answer. */
  onReasoning?: (chunk: string) => void
}

export interface StreamResult {
  text: string
  reasoning: string
  ms: number
  cacheReused: boolean
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

/** Longest k where the tail of `s` equals the first k chars of `tag`. */
function partialTagTail(s: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k
  }
  return 0
}

/**
 * Splits a content stream into answer and thinking.
 *
 * Reasoning arrives two different ways depending on the server: as a separate
 * `reasoning` / `reasoning_content` delta key, or inline in the content wrapped
 * in <think>…</think>. Both are handled, and a tag split across chunk
 * boundaries is held back rather than leaking half a tag into the answer.
 */
function makeThinkSplitter(onText: (s: string) => void, onThink: (s: string) => void) {
  let buf = ''
  let thinking = false

  const emit = (s: string) => {
    if (!s) return
    if (thinking) onThink(s)
    else onText(s)
  }

  return {
    push(chunk: string) {
      buf += chunk
      for (;;) {
        const tag = thinking ? THINK_CLOSE : THINK_OPEN
        const idx = buf.indexOf(tag)
        if (idx !== -1) {
          emit(buf.slice(0, idx))
          buf = buf.slice(idx + tag.length)
          thinking = !thinking
          continue
        }
        const hold = partialTagTail(buf, tag)
        emit(buf.slice(0, buf.length - hold))
        buf = hold ? buf.slice(buf.length - hold) : ''
        return
      }
    },
    end() {
      emit(buf)
      buf = ''
    },
  }
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
  const { provider, model, messages, temperature, maxTokens, signal, onDelta, onReasoning } = opts
  const started = performance.now()
  const cacheReused = !!opts.contextHash && wasSent(opts.contextHash)

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    stream: true,
  }
  // 0 means no ceiling: omit the field entirely so the server applies its own
  // maximum, which is its context minus the prompt — the real limit, and one
  // no fixed number here could ever guess correctly across every model.
  if (maxTokens > 0) body.max_tokens = maxTokens
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

  // Servers disagree about max_tokens in both directions: most reject a ceiling
  // larger than their context with a 400 rather than clamping it, and a few
  // reject a request that omits it. One retry covers whichever complaint came
  // back, so neither case needs the user to know anything about the model.
  if (!res.ok && res.status === 400) {
    const detail = await res.clone().text().catch(() => '')
    const mentionsLimit = /max_tokens|max_completion_tokens|max_output_tokens|context length|context_length|n_predict/i.test(detail)

    if (mentionsLimit) {
      const demandsOne = /required|must be|missing|expected/i.test(detail)
      if (demandsOne && maxTokens <= 0) {
        res = await send({ ...body, max_tokens: 32768 })
      } else if (!demandsOne && maxTokens > 0) {
        const { max_tokens: _dropped, ...withoutLimit } = body
        res = await send(withoutLimit)
      }
    }
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`)
  }

  let text = ''
  let reasoning = ''

  const splitter = makeThinkSplitter(
    (s) => {
      text += s
      onDelta(s)
    },
    (s) => {
      reasoning += s
      onReasoning?.(s)
    },
  )

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

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
            choices?: {
              delta?: { content?: string; reasoning?: string; reasoning_content?: string }
              text?: string
            }[]
          }
          const choice = json.choices?.[0]

          // Servers disagree on the key; both mean the same thing.
          const think = choice?.delta?.reasoning ?? choice?.delta?.reasoning_content
          if (think) {
            reasoning += think
            onReasoning?.(think)
          }

          const piece = choice?.delta?.content ?? choice?.text ?? ''
          if (piece) splitter.push(piece)
        } catch {
          // A partial frame that slipped through — ignore and keep reading.
        }
      }
    }
  }
  splitter.end()

  if (opts.contextHash) markSent(opts.contextHash)
  return { text, reasoning, ms: Math.round(performance.now() - started), cacheReused }
}
