import { Type } from 'typebox'
import type { Static } from 'typebox'
import type { AgentEvent, AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { Api } from '../app/state'
import { H3_AGENT_SYSTEM_RULES } from './context'
import { needsKey } from './providers'
import { isCanonicalPromptStage } from './studio-workflow'
import type { Breakdown, BreakdownClip, Provider } from './types'
import { withQwenReasoningBudget } from './thinking'

export type AgentConfirmation = 'render_current' | 'render_multiclip'

export interface AgentToolDetails {
  operation: string
  versionId?: string
  clipId?: string
  clipIndex?: number
  requiresConfirmation?: AgentConfirmation
  message?: string
}

export type AgentTranscriptItem = {
  id: string
  kind: 'user' | 'assistant' | 'thinking' | 'tool'
  text: string
  toolName?: string
  status?: 'running' | 'done' | 'error'
  details?: Record<string, unknown>
  /** Timestamp shared by Pi's partial and final assistant messages. */
  sourceId?: string
}

export type AgentEventStatus = {
  kind: 'ready' | 'error' | 'aborted'
  message: string
}

type AgentMessageLike = {
  role?: string
  content?: Array<{ type?: string; text?: string; thinking?: string }>
  timestamp?: number
  stopReason?: string
  errorMessage?: string
}

function messageSourceId(message: AgentMessageLike, kind: 'assistant' | 'thinking'): string | undefined {
  return typeof message.timestamp === 'number' ? `${kind}:${message.timestamp}` : undefined
}

function messageParts(message: AgentMessageLike): { text: string; thinking: string } {
  let text = ''
  let thinking = ''
  for (const block of message.content ?? []) {
    if (block.type === 'text') text += block.text ?? ''
    if (block.type === 'thinking') thinking += block.thinking ?? ''
  }
  return { text, thinking }
}

function appendDelta(items: AgentTranscriptItem[], kind: 'assistant' | 'thinking', delta: string, sourceId?: string): AgentTranscriptItem[] {
  if (!delta) return items
  const index = sourceId
    ? [...items].map((item, i) => ({ item, i })).reverse().find(({ item }) => item.kind === kind && item.sourceId === sourceId)?.i ?? -1
    : -1
  if (index !== -1) {
    const item = items[index]
    return [...items.slice(0, index), { ...item, text: item.text + delta }, ...items.slice(index + 1)]
  }
  return [...items, { id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, kind, text: delta, sourceId }]
}

function finalizeAssistant(items: AgentTranscriptItem[], message: AgentMessageLike): AgentTranscriptItem[] {
  const { text, thinking } = messageParts(message)
  const assistantId = messageSourceId(message, 'assistant')
  const thinkingId = messageSourceId(message, 'thinking')
  let next = items

  const upsert = (kind: 'assistant' | 'thinking', value: string, sourceId?: string) => {
    if (!value) return
    const index = sourceId
      ? [...next].map((item, i) => ({ item, i })).reverse().find(({ item }) => item.kind === kind && item.sourceId === sourceId)?.i ?? -1
      : -1
    if (index === -1) {
      next = [...next, { id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`, kind, text: value, sourceId }]
    } else {
      next = [...next.slice(0, index), { ...next[index], text: value }, ...next.slice(index + 1)]
    }
  }

  upsert('thinking', thinking, thinkingId)
  const assistantLengthBefore = next.length
  upsert('assistant', text || message.errorMessage || '', assistantId)
  if (!text && message.errorMessage) {
    const index = assistantId
      ? next.findIndex((item) => item.kind === 'assistant' && item.sourceId === assistantId)
      : next.length > assistantLengthBefore ? next.length - 1 : -1
    if (index !== -1) next = [...next.slice(0, index), { ...next[index], status: 'error' }, ...next.slice(index + 1)]
  }
  return next
}

/**
 * Reduce Pi lifecycle events into the transcript the browser renders.
 * `agent_end.messages` is authoritative for errors and for providers that
 * finish without emitting a text_delta, so relying on deltas alone loses the
 * only useful receipt in precisely those failure cases.
 */
export function reduceAgentEvent(items: AgentTranscriptItem[], event: AgentEvent): AgentTranscriptItem[] {
  switch (event.type) {
    case 'message_update': {
      const streamEvent = event.assistantMessageEvent
      const source = event.message as AgentMessageLike
      if (streamEvent.type === 'thinking_delta') return appendDelta(items, 'thinking', streamEvent.delta, messageSourceId(source, 'thinking'))
      if (streamEvent.type === 'text_delta') return appendDelta(items, 'assistant', streamEvent.delta, messageSourceId(source, 'assistant'))
      return items
    }
    case 'message_end':
      return event.message.role === 'assistant' ? finalizeAssistant(items, event.message as AgentMessageLike) : items
    case 'agent_end': {
      const finalAssistant = [...event.messages].reverse().find((message) => message.role === 'assistant')
      return finalAssistant ? finalizeAssistant(items, finalAssistant as AgentMessageLike) : items
    }
    case 'tool_execution_start':
      return [...items, { id: event.toolCallId, kind: 'tool', toolName: event.toolName, text: JSON.stringify(event.args), status: 'running' }]
    case 'tool_execution_end': {
      const details = event.result?.details && typeof event.result.details === 'object' ? event.result.details as Record<string, unknown> : undefined
      const resultText = contentText(event.result)
      return items.map((item) => item.id === event.toolCallId ? { ...item, status: event.isError ? 'error' : 'done', text: resultText || item.text, details } : item)
    }
    default:
      return items
  }
}

/** The terminal run status, including Pi's resolved-but-error agent_end path. */
export function agentEventStatus(event: AgentEvent): AgentEventStatus | null {
  if (event.type !== 'agent_end') return null
  const finalAssistant = [...event.messages].reverse().find((message) => message.role === 'assistant') as AgentMessageLike | undefined
  if (finalAssistant?.errorMessage || finalAssistant?.stopReason === 'error') {
    return { kind: 'error', message: finalAssistant.errorMessage || 'The agent stopped with an error.' }
  }
  if (finalAssistant?.stopReason === 'aborted') {
    return { kind: 'aborted', message: 'Stopped. Partial thinking remains in this transcript.' }
  }
  return { kind: 'ready', message: 'Ready. The shared Studio state is up to date.' }
}

/**
 * pi-ai requires an apiKey option even for keyless OpenAI-compatible servers.
 * The regular Studio client correctly omits Authorization for those servers,
 * so give Pi a harmless placeholder whenever the provider does not require a
 * key (including LAN, Tailscale, and custom compatible endpoints).
 */
export function agentApiKey(provider: Pick<Provider, 'baseUrl' | 'apiKey'>): string | undefined {
  return provider.apiKey || (!needsKey(provider) ? 'local-browser-runtime' : undefined)
}

/** Apply Studio's Qwen request contract to a Pi-generated payload. */
export function agentRequestPayload<T>(provider: Pick<Provider, 'id' | 'baseUrl' | 'sendCachePrompt'>, model: string, payload: T, thinkingBudget?: number): T {
  return withQwenReasoningBudget(provider, model, payload, thinkingBudget)
}

function contentText(result: unknown): string {
  if (!result || typeof result !== 'object') return ''
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content
  return content?.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('') ?? ''
}

const textResult = (details: AgentToolDetails, text: string, terminate = false): AgentToolResult<AgentToolDetails> => ({
  content: [{ type: 'text', text }],
  details,
  ...(terminate ? { terminate: true } : {}),
})

type Bridge = Pick<
  Api,
  | 'story' | 'versions' | 'current' | 'film' | 'breakdown' | 'clips' | 'clip' | 'settings' | 'skills'
  | 'appendPromptVersion' | 'setBreakdown' | 'prepareContinuation' | 'render' | 'renderMulticlip'
>

function stateText(app: Bridge): string {
  const promptVersion = [...app.versions].reverse().find((version) => isCanonicalPromptStage(version.stage))
  return JSON.stringify({
    story: app.story,
    currentPrompt: promptVersion?.text ?? null,
    currentVersionId: app.current?.id ?? null,
    versionCount: app.versions.length,
    film: app.film,
    breakdown: app.breakdown,
    selectedClip: app.clip ? { id: app.clip.id, index: app.clip.index, state: app.clip.state, prompt: app.clip.prompt, film: app.clip.film } : null,
    clips: app.clips.map((clip) => ({ id: clip.id, index: clip.index, state: clip.state, prompt: clip.prompt })),
    settings: { mode: app.settings.mode, model: app.settings.model, temperature: app.settings.temperature },
    loadedSkills: app.skills.filter((skill) => app.settings.selection[skill.id]?.length).map((skill) => skill.name),
  }, null, 2)
}

const noArgs = Type.Object({})
const setCurrentPromptParameters = Type.Object({
  prompt: Type.String({ description: 'The complete canonical H3 prompt.' }),
  explanation: Type.Optional(Type.String()),
  note: Type.Optional(Type.String()),
})
const appendPromptVersionParameters = Type.Object({
  prompt: Type.String({ description: 'The complete canonical H3 prompt.' }),
  explanation: Type.Optional(Type.String()),
  changelog: Type.Optional(Type.Array(Type.String())),
  note: Type.Optional(Type.String()),
})
const clipPlanParameters = Type.Object({
  spine: Type.String(),
  clips: Type.Array(Type.Object({
    index: Type.Integer({ minimum: 1 }),
    title: Type.String(),
    role: Type.Union([Type.Literal('standalone'), Type.Literal('opening'), Type.Literal('rising'), Type.Literal('turn'), Type.Literal('falling'), Type.Literal('closing')]),
    seconds: Type.Number({ minimum: 1 }),
    covers: Type.String(),
    precedes: Type.String(),
    follows: Type.String(),
  })),
})
const continuationParameters = Type.Object({ clipId: Type.Optional(Type.String()) })
const renderParameters = Type.Object({ confirmed: Type.Optional(Type.Boolean()) })

type SetCurrentPromptParameters = Static<typeof setCurrentPromptParameters>
type AppendPromptVersionParameters = Static<typeof appendPromptVersionParameters>
type ClipPlanParameters = Static<typeof clipPlanParameters>
type ContinuationParameters = Static<typeof continuationParameters>
type RenderParameters = Static<typeof renderParameters>

export function buildAgentTools(app: Bridge, onConfirmation?: (type: AgentConfirmation) => void): AgentTool[] {
  const readStudioState: AgentTool = {
    name: 'read_studio_state',
    label: 'Read Studio state',
    description: 'Read the current story, canonical prompt, clip plan, selected clip, settings, and loaded skills.',
    parameters: noArgs,
    executionMode: 'sequential',
    async execute() {
      return textResult({ operation: 'read_studio_state' }, stateText(app), true)
    },
  }

  const setCurrentPrompt: AgentTool<typeof setCurrentPromptParameters, AgentToolDetails> = {
    name: 'set_current_prompt',
    label: 'Set canonical prompt',
    description: 'Set the complete H3 prompt that Studio will copy, lint, and submit to ComfyUI. Never pass commentary in prompt.',
    parameters: setCurrentPromptParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { prompt: string; explanation?: string; note?: string }
      const version = app.appendPromptVersion({ text: p.prompt, explanation: p.explanation, note: p.note ?? 'Agent' })
      if (!version) throw new Error('Prompt cannot be empty.')
      return textResult({ operation: 'set_current_prompt', versionId: version.id }, `Canonical prompt saved as ${version.id}.`, true)
    },
  }

  const appendPromptVersion: AgentTool<typeof appendPromptVersionParameters, AgentToolDetails> = {
    name: 'append_prompt_version',
    label: 'Append prompt version',
    description: 'Append a complete prompt version to Studio history and make it canonical.',
    parameters: appendPromptVersionParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { prompt: string; explanation?: string; changelog?: string[]; note?: string }
      const version = app.appendPromptVersion({ text: p.prompt, explanation: p.explanation, changelog: p.changelog, note: p.note ?? 'Agent' })
      if (!version) throw new Error('Prompt cannot be empty.')
      return textResult({ operation: 'append_prompt_version', versionId: version.id }, `Prompt version ${version.id} is now canonical.`, true)
    },
  }

  const setClipPlan: AgentTool<typeof clipPlanParameters, AgentToolDetails> = {
    name: 'set_clip_plan',
    label: 'Set clip plan',
    description: 'Save a deterministic multi-clip plan in Studio. Keep covers, precedes, and follows factual and camera-free.',
    parameters: clipPlanParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const p = params as { spine: string; clips: BreakdownClip[] }
      const breakdown: Breakdown = { spine: p.spine, clips: p.clips, at: Date.now() }
      app.setBreakdown(breakdown)
      return textResult({ operation: 'set_clip_plan' }, `Saved ${breakdown.clips.length} clip plan item${breakdown.clips.length === 1 ? '' : 's'}.`, true)
    },
  }

  const prepareContinuation: AgentTool<typeof continuationParameters, AgentToolDetails> = {
    name: 'prepare_continuation',
    label: 'Prepare continuation context',
    description: 'Select a rendered clip and stage its prompt and film context for continuation. This is deterministic; it does not call an LLM.',
    parameters: continuationParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      const source = (params as { clipId?: string }).clipId ?? app.clip?.id
      if (!source) throw new Error('Select a rendered clip first.')
      const prepared = app.prepareContinuation(source)
      if (!prepared) throw new Error('That clip no longer exists.')
      return textResult({ operation: 'prepare_continuation', clipId: prepared.clipId, clipIndex: prepared.clipIndex }, `Continuation context staged from clip ${prepared.clipIndex}. Open Studio to run the ending-frame hand-off and author the next prompt.`, true)
    },
  }

  const renderCurrent: AgentTool<typeof renderParameters, AgentToolDetails> = {
    name: 'render_current',
    label: 'Render current prompt',
    description: 'Render the current canonical prompt in ComfyUI. Always ask for explicit user confirmation before passing confirmed=true.',
    parameters: renderParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      if (!(params as { confirmed?: boolean }).confirmed) {
        onConfirmation?.('render_current')
        return textResult({ operation: 'render_current', requiresConfirmation: 'render_current', message: 'Waiting for explicit confirmation.' }, 'Rendering requires confirmation in the Agent panel.', true)
      }
      await app.render()
      return textResult({ operation: 'render_current' }, 'Render submitted from the canonical prompt.', true)
    },
  }

  const renderMulticlip: AgentTool<typeof renderParameters, AgentToolDetails> = {
    name: 'render_multiclip',
    label: 'Submit multiclip job',
    description: 'Submit the saved clip plan as one ComfyUI multiclip job. Always ask for explicit user confirmation before passing confirmed=true.',
    parameters: renderParameters,
    executionMode: 'sequential',
    async execute(_id, params) {
      if (!(params as { confirmed?: boolean }).confirmed) {
        onConfirmation?.('render_multiclip')
        return textResult({ operation: 'render_multiclip', requiresConfirmation: 'render_multiclip', message: 'Waiting for explicit confirmation.' }, 'Multiclip submission requires confirmation in the Agent panel.', true)
      }
      await app.renderMulticlip()
      return textResult({ operation: 'render_multiclip' }, 'Multiclip job submitted from the saved clip plan.', true)
    },
  }

  return [readStudioState, setCurrentPrompt, appendPromptVersion, setClipPlan, prepareContinuation, renderCurrent, renderMulticlip]
}

/** Kept as a named export for consumers that display the Agent contract. */
export const AGENT_SYSTEM_PROMPT = H3_AGENT_SYSTEM_RULES

export function buildAgentModel(provider: { id: string; baseUrl: string }, modelId: string) {
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider: provider.id,
    baseUrl: provider.baseUrl,
    reasoning: true,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 200_000,
    compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false, maxTokensField: 'max_tokens' as const, supportsUsageInStreaming: true, supportsStrictMode: false },
  }
}
