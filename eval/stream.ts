import type { ParsedEvalResponse } from './types'

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

type Delta = {
  content?: unknown
  reasoning?: unknown
  reasoning_content?: unknown
}

type SsePayload = {
  choices?: { delta?: Delta; text?: unknown; finish_reason?: unknown }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown }
}

interface CaptureState {
  content: string
  reasoning: string
  finishReason: string | null
  usage: { prompt?: number; completion?: number } | null
  splitter: ThinkSplitter
}

/** Longest suffix of `value` that is a prefix of `tag`. */
function partialTagTail(value: string, tag: string): number {
  for (let length = Math.min(tag.length - 1, value.length); length > 0; length--) {
    if (value.endsWith(tag.slice(0, length))) return length
  }
  return 0
}

interface ThinkSplitter {
  push(value: string): void
  end(): void
  readonly unterminated: boolean
}

/**
 * Split inline `<think>` output without leaking a partial tag into the
 * visible answer. Separate reasoning deltas are handled by the caller.
 */
function makeThinkSplitter(onContent: (value: string) => void, onReasoning: (value: string) => void): ThinkSplitter {
  let buffer = ''
  let thinking = false

  const emit = (value: string) => {
    if (!value) return
    if (thinking) onReasoning(value)
    else onContent(value)
  }

  return {
    push(value: string) {
      buffer += value
      for (;;) {
        const tag = thinking ? THINK_CLOSE : THINK_OPEN
        const index = buffer.indexOf(tag)
        if (index >= 0) {
          emit(buffer.slice(0, index))
          buffer = buffer.slice(index + tag.length)
          thinking = !thinking
          continue
        }

        const hold = partialTagTail(buffer, tag)
        emit(buffer.slice(0, buffer.length - hold))
        buffer = hold > 0 ? buffer.slice(buffer.length - hold) : ''
        return
      }
    },
    end() {
      emit(buffer)
      buffer = ''
    },
    get unterminated() {
      return thinking
    },
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function consumePayload(payload: string, state: CaptureState, onToken?: () => void): void {
  const trimmed = payload.trim()
  if (!trimmed || trimmed === '[DONE]') return

  let json: SsePayload
  try {
    json = JSON.parse(trimmed) as SsePayload
  } catch {
    // A malformed/partial SSE payload is not a reason to terminate a stream.
    // The framing buffer keeps later complete events usable.
    return
  }

  if (json.usage && typeof json.usage === 'object') {
    state.usage = {
      prompt: numberOrUndefined(json.usage.prompt_tokens),
      completion: numberOrUndefined(json.usage.completion_tokens),
    }
  }

  const choice = json.choices?.[0]
  const finishReason = stringOrUndefined(choice?.finish_reason)
  if (finishReason !== undefined) state.finishReason = finishReason

  const separateReasoning = stringOrUndefined(choice?.delta?.reasoning) ?? stringOrUndefined(choice?.delta?.reasoning_content)
  if (separateReasoning) {
    onToken?.()
    state.reasoning += separateReasoning
  }

  const content = stringOrUndefined(choice?.delta?.content) ?? stringOrUndefined(choice?.text)
  if (content) state.splitter.push(content)
}

function consumeFrame(frame: string, state: CaptureState, onToken?: () => void): void {
  for (const line of frame.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    consumePayload(trimmed.slice(5), state, onToken)
  }
}

function parseText(frameText: string, onToken?: () => void): Omit<ParsedEvalResponse, 'elapsedMs' | 'timeToFirstTokenMs'> {
  let content = ''
  let reasoning = ''
  const state: CaptureState = {
    content,
    reasoning,
    finishReason: null,
    usage: null,
    splitter: makeThinkSplitter(
      (value) => { state.content += value },
      (value) => { state.reasoning += value },
    ),
  }

  // Parsing a complete text input needs the same terminal-frame behavior as
  // the live reader: a final data line need not have a blank-line separator.
  let buffer = frameText
  let separator: RegExpMatchArray | null
  while ((separator = buffer.match(/\r?\n\r?\n/))) {
    const index = separator.index ?? -1
    if (index < 0) break
    consumeFrame(buffer.slice(0, index), state, onToken)
    buffer = buffer.slice(index + separator[0].length)
  }
  if (buffer.trim()) consumeFrame(buffer, state, onToken)
  state.splitter.end()

  return {
    content: state.content,
    reasoning: state.reasoning,
    finishReason: state.finishReason,
    usage: state.usage,
    unterminatedThink: state.splitter.unterminated,
  }
}

/** Parse one or more SSE frames without performing any I/O. */
export function parseEvalSse(frameText: string): ParsedEvalResponse {
  return {
    ...parseText(frameText),
    elapsedMs: 0,
    timeToFirstTokenMs: null,
  }
}

function emptyResponse(elapsedMs: number): ParsedEvalResponse {
  return {
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    elapsedMs,
    timeToFirstTokenMs: null,
    unterminatedThink: false,
  }
}

/** Capture exactly the supplied streamed response; this function never fetches or retries. */
export async function streamOneResponse(response: Response, onFirstToken: () => void): Promise<ParsedEvalResponse> {
  const started = performance.now()
  if (!response.body) return emptyResponse(Math.round(performance.now() - started))

  let firstTokenAt: number | null = null
  let notified = false
  const markFirstToken = () => {
    if (notified) return
    notified = true
    firstTokenAt = performance.now()
    onFirstToken()
  }

  const state: CaptureState = {
    content: '',
    reasoning: '',
    finishReason: null,
    usage: null,
    splitter: makeThinkSplitter(
      (value) => {
        markFirstToken()
        state.content += value
      },
      (value) => {
        markFirstToken()
        state.reasoning += value
      },
    ),
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let separator: RegExpMatchArray | null
      while ((separator = buffer.match(/\r?\n\r?\n/))) {
        const index = separator.index ?? -1
        if (index < 0) break
        consumeFrame(buffer.slice(0, index), state, markFirstToken)
        buffer = buffer.slice(index + separator[0].length)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) consumeFrame(buffer, state, markFirstToken)
  } finally {
    // `end` is required even when the last content chunk is an inline
    // `<think>` fragment; it preserves the partial answer/reasoning and makes
    // unterminatedThink observable without issuing a recovery request.
    state.splitter.end()
  }

  return {
    content: state.content,
    reasoning: state.reasoning,
    finishReason: state.finishReason,
    usage: state.usage,
    elapsedMs: Math.round(performance.now() - started),
    timeToFirstTokenMs: firstTokenAt === null ? null : Math.max(0, Math.round(firstTokenAt - started)),
    unterminatedThink: state.splitter.unterminated,
  }
}
