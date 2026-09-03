import { markSent, wasSent } from './context'
import type { Provider, StageId } from './types'

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
  /** Request the provider's native thinking toggle when it supports one. */
  thinkingEnabled?: boolean
  /** Hash of the cached prefix, so we can report whether it was reused. */
  contextHash?: string
  signal?: AbortSignal
  onDelta: (chunk: string) => void
  /** Thinking tokens, streamed separately from the answer. */
  onReasoning?: (chunk: string) => void
  /** Prompt replacement operations must make one endpoint attempt only. */
  retryOnLimit?: boolean
}

export interface StreamResult {
  text: string
  reasoning: string
  ms: number
  cacheReused: boolean
  /** 'length' means a limit cut it off; 'stop' means the model chose to end. */
  finishReason: string | null
  /** The model opened a <think> block and never closed it. */
  unterminatedThink: boolean
  /** Whether a ceiling was actually sent, so errors can say so truthfully. */
  sentLimit: number | null
  /** Real counts, when the server reports them. Estimates are used otherwise. */
  usage: { prompt?: number; completion?: number } | null
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
    /** True if the stream ended while still inside a <think> block. */
    get unterminated() {
      return thinking
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
  if (provider.supportsThinkingToggle === true && typeof opts.thinkingEnabled === 'boolean') {
    body.chat_template_kwargs = { enable_thinking: opts.thinkingEnabled }
  }

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
  if (opts.retryOnLimit !== false && !res.ok && res.status === 400) {
    const detail = await res.clone().text().catch(() => '')
    const mentionsLimit = /max_tokens|max_completion_tokens|max_output_tokens|context length|context_length|n_predict/i.test(detail)

    if (mentionsLimit) {
      const demandsOne = /required|must be|missing|expected/i.test(detail)
      if (demandsOne && maxTokens <= 0) {
        // Not a considered ceiling — just a value large enough that a server
        // demanding SOME number rarely has to reject this one too. If it is
        // still too small for a particular reply, streamChatComplete's
        // continuation loop below covers however much is left over.
        res = await send({ ...body, max_tokens: 200_000 })
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

  let finishReason: string | null = null
  let usage: { prompt?: number; completion?: number } | null = null
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const consumeFrame = (frame: string) => {
    for (const line of frame.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload) as {
          choices?: {
            delta?: { content?: string; reasoning?: string; reasoning_content?: string }
            text?: string
            finish_reason?: string | null
          }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number }
        }
        if (json.usage) {
          usage = { prompt: json.usage.prompt_tokens, completion: json.usage.completion_tokens }
        }
        const choice = json.choices?.[0]
        if (choice?.finish_reason) finishReason = choice.finish_reason

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

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // SSE frames are separated by a blank line; a frame may carry several
    // `data:` lines. Keep the tail in the buffer until it completes.
    let separator: RegExpMatchArray | null
    while ((separator = buffer.match(/\r?\n\r?\n/))) {
      const idx = separator.index ?? -1
      if (idx < 0) break
      consumeFrame(buffer.slice(0, idx))
      buffer = buffer.slice(idx + separator[0].length)
    }
  }
  // The SSE blank line is a framing convention, not a requirement of the
  // transport. llama.cpp may close immediately after its last `data:` line;
  // consume that final frame so a trailing EXPLANATION block is not silently
  // dropped from a strict Prompt replacement.
  buffer += decoder.decode()
  if (buffer.trim()) consumeFrame(buffer)
  const unterminatedThink = splitter.unterminated
  splitter.end()

  if (opts.contextHash) markSent(opts.contextHash)
  return {
    text,
    reasoning,
    ms: Math.round(performance.now() - started),
    cacheReused,
    finishReason,
    unterminatedThink,
    sentLimit: typeof body.max_tokens === 'number' ? body.max_tokens : null,
    usage,
  }
}

/**
 * The continuation loop.
 *
 * An output cap can come from the SERVER rather than from this app, in which
 * case nothing sent from here can raise it — "No limit" in Settings only
 * controls what WE send, not what the endpoint enforces on its own side. This
 * app's own `max_tokens: 200_000` retry a few lines up (sent only when a
 * server demands a value at all) is one concrete example of a cap that has
 * nothing to do with the model's real capacity; a metered remote provider
 * enforcing its own ceiling is another. Either way, a reply that ends with
 * `finish_reason: "length"` was cut off by *something*, and the only way past
 * a cap this client cannot lift is to continue the generation in a new
 * request.
 *
 * Two shapes of cut-off, handled differently:
 * - The cut landed mid-ANSWER (there is text already). Hand the model back
 *   its own text and ask it to continue exactly where it stopped.
 * - The cut landed mid-THINKING (the answer is still empty). Continuing "the
 *   answer" makes no sense when there isn't one — instead, hand back the
 *   reasoning as working notes and ask for the answer directly, once, without
 *   re-deliberating from scratch.
 */
function stripCodeFenceLine(s: string): string {
  return s.replace(/^\s*```[a-zA-Z0-9_-]*\n/, '')
}

const CONTINUE_ANSWER =
  'Your reply was cut off by an output limit mid-text. Continue EXACTLY from where the text now ends — ' +
  'do not repeat anything already written, and do not add any preamble, apology, summary, or code fence. If the last ' +
  'thing you wrote was inside a block or a field, keep going inside it. Keep the same output format and the same ' +
  'markers you were using.'

/** Appended when the partial trailing line was discarded before continuing. */
const CONTINUE_FROM_LINE =
  'The text above now ends at the end of a COMPLETE line. The fragment that was cut off mid-line has been discarded — ' +
  'do not try to reconstruct it or guess what it was going to say. Write only what comes NEXT, and start it on a new line.'

/**
 * The longest partial line worth discarding.
 *
 * Dropping the fragment a cut left behind is what makes a join safe (see
 * `toLineBoundary`), but an H3 field can be one very long line, and throwing
 * away a whole paragraph to save a join is a bad trade. Past this length the
 * text is handed back intact and `stitch`'s overlap dedup is the only guard —
 * which is the right guard there, because a model continuing mid-sentence
 * repeats whole words, well above the dedup's minimum.
 */
const MAX_DISCARDED_LINE = 400

/**
 * Hand a continuation back a text that ends on a LINE boundary.
 *
 * A cut lands wherever the limit fell, usually mid-line, and concatenating a
 * continuation onto a fragment fuses two values into one. Measured against
 * thinkingcap-27b on a numbered list: cut after "8", the model was asked to
 * restore the partial line, guessed it had been "88" — which was already the
 * line above — and the join read "87, 8888, 89". A fragment is not
 * identifiable from its first character, so it is discarded and never asked
 * for back; the model is told to write only what comes next.
 *
 * A text with no newline, or one whose partial line is too long to throw
 * away, is handed back whole.
 */
export function toLineBoundary(text: string): { base: string; dropped: string } {
  const cut = text.lastIndexOf('\n')
  if (cut <= 0) return { base: text, dropped: '' }
  const dropped = text.slice(cut + 1)
  // Already ends on a newline: there is no fragment, and the newline must be
  // KEPT. Stripping it and then not putting one back is what fused "107" and
  // "108" into "107108" — the model continued with "108" and had nowhere to
  // land but the end of the previous line.
  if (!dropped) return { base: text, dropped: '' }
  if (dropped.length > MAX_DISCARDED_LINE) return { base: text, dropped: '' }
  return { base: text.slice(0, cut), dropped }
}

function resumeFromNotesPrompt(reasoning: string): string {
  const CAP = 60_000
  const overflow = reasoning.length > CAP
  const tail = overflow ? reasoning.slice(reasoning.length - CAP) : reasoning
  const note = overflow ? ` (truncated — showing the last ${CAP.toLocaleString()} characters)` : ''
  return (
    'The previous attempt ran out of room before writing an answer. Do not re-deliberate at length. Using the notes ' +
    'below, write the answer now, in the required output format.\n\n' +
    `YOUR WORKING NOTES SO FAR${note}\n${tail}`
  )
}

/**
 * De-duplicate a continuation's text against what is already written.
 *
 * A continuation is asked to pick up exactly where the last one stopped, but
 * models routinely re-write the last few words or a whole trailing clause
 * before continuing — so the join is not a plain concatenation. This finds
 * the longest suffix of the existing text that reappears as a prefix of the
 * new text and drops it, after stripping a leading code fence the model
 * sometimes adds out of habit.
 */
export function stitch(oldText: string, newText: string): { joined: string; appended: string } {
  const fenceStripped = stripCodeFenceLine(newText)
  const trimmed = fenceStripped.replace(/^[ \t\r\n]+/, '')

  const maxLen = Math.min(400, oldText.length)
  let overlapLen = 0
  for (let len = maxLen; len >= 12; len--) {
    if (oldText.slice(oldText.length - len) === trimmed.slice(0, len)) {
      overlapLen = len
      break
    }
  }

  const appended = overlapLen ? trimmed.slice(overlapLen) : fenceStripped
  return { joined: oldText + appended, appended }
}


/**
 * What a continuation round adds, and how it is attached.
 *
 * When the round resumed from a line boundary the separator is a single
 * newline that WE write, not one the model has to remember — a model that
 * begins its continuation without one is otherwise indistinguishable from one
 * continuing a line, and that ambiguity is what fuses two lines together.
 */
export function appendedFor(base: string, incoming: string, fromLineBoundary: boolean): string {
  const { appended } = stitch(base, incoming)
  if (!fromLineBoundary) return appended
  const body = appended.replace(/^[\r\n]+/, '')
  return body ? `\n${body}` : ''
}

export function joinRound(base: string, incoming: string, fromLineBoundary: boolean): string {
  return base + appendedFor(base, incoming, fromLineBoundary)
}

/**
 * The provider-output recovery loop is useful for long direction sheets, but
 * an interactive prompt edit must be one bounded request. In particular, a
 * server that reports `length` for every request used to make Revise/Rebuild/
 * freeform issue the generic eight follow-ups and concatenate prompt replies.
 */
export function continuationBudgetFor(stage: StageId): number {
  if (stage === 'revise' || stage === 'rebuild' || stage === 'freeform') return 0
  return 2
}

export async function streamChatComplete(
  opts: StreamOptions & {
    maxContinuations?: number
    /** Fired just before firing a continuation round, so the UI can show it. */
    onContinuation?: (round: number, kind: 'answer' | 'thinking') => void
    /**
     * How many characters were just discarded from the end of the answer,
     * because a continuation resumes from the last COMPLETE line. A caller
     * showing the stream live has to un-append them, or the rewritten line
     * appears twice on the page while the saved version has it once.
     */
    onRewind?: (chars: number) => void
  },
): Promise<StreamResult & { continuations: number; truncated: boolean }> {
  const { maxContinuations = 8, onContinuation, onRewind, onDelta, ...rest } = opts
  const messages: ChatMessage[] = [...opts.messages]

  const first = await streamChat({ ...rest, messages, onDelta })

  let text = first.text
  let reasoning = first.reasoning
  let ms = first.ms
  let finishReason = first.finishReason
  let unterminatedThink = first.unterminatedThink
  let sentLimit = first.sentLimit
  let usage = first.usage
  const cacheReused = first.cacheReused

  let round = 0
  let triedThinkingRecovery = false

  while (finishReason === 'length' && round < maxContinuations) {
    if (opts.signal?.aborted) break

    const isRecovery = !text.trim()
    if (isRecovery && triedThinkingRecovery) break // already tried once; still nothing to continue

    round++
    if (isRecovery) triedThinkingRecovery = true
    onContinuation?.(round, isRecovery ? 'thinking' : 'answer')

    // The partial trailing line is dropped and regenerated, so `before` is
    // what the next round actually builds on — not the raw text so far.
    const boundary = isRecovery ? { base: text, dropped: '' } : toLineBoundary(text)

    if (isRecovery) {
      messages.push({ role: 'user', content: resumeFromNotesPrompt(reasoning) })
    } else {
      messages.push({ role: 'assistant', content: boundary.base })
      messages.push({
        role: 'user',
        content: boundary.dropped ? `${CONTINUE_ANSWER}\n\n${CONTINUE_FROM_LINE}` : CONTINUE_ANSWER,
      })
    }

    const before = boundary.base
    if (text.length > before.length) onRewind?.(text.length - before.length)

    // Stream the round's own deltas live once the overlap window (at most
    // 400 chars, per stitch()) has been resolved — before that, chunks are
    // held back so a repeated tail is never flashed onto the page.
    let pending = ''
    let resolved = false
    const roundResult = await streamChat({
      ...rest,
      messages,
      onDelta: (chunk) => {
        if (resolved) {
          onDelta(chunk)
          return
        }
        pending += chunk
        if (pending.length <= 400) return
        resolved = true
        const appended = appendedFor(before, pending, !!boundary.dropped)
        if (appended) onDelta(appended)
      },
    })
    if (!resolved) {
      const appended = appendedFor(before, pending, !!boundary.dropped)
      if (appended) onDelta(appended)
    }

    ms += roundResult.ms
    finishReason = roundResult.finishReason
    unterminatedThink = unterminatedThink || roundResult.unterminatedThink
    sentLimit = roundResult.sentLimit
    if (roundResult.usage?.completion !== undefined) {
      usage = { prompt: roundResult.usage.prompt, completion: (usage?.completion ?? 0) + roundResult.usage.completion }
    }
    reasoning = roundResult.reasoning ? (reasoning ? `${reasoning}\n\n— continued —\n\n${roundResult.reasoning}` : roundResult.reasoning) : reasoning

    text = joinRound(before, roundResult.text, !!boundary.dropped)

    if (isRecovery && !text.trim()) break // the recovery round produced nothing either
  }

  return {
    text,
    reasoning,
    ms,
    cacheReused,
    finishReason,
    unterminatedThink,
    sentLimit,
    usage,
    continuations: round,
    truncated: finishReason === 'length',
  }
}
