import { Type } from 'typebox'
import type { Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core'
import type { Api } from '../app/state'
import type { Breakdown, BreakdownClip } from './types'

export type AgentConfirmation = 'render_current' | 'render_multiclip'

export interface AgentToolDetails {
  operation: string
  versionId?: string
  clipId?: string
  clipIndex?: number
  requiresConfirmation?: AgentConfirmation
  message?: string
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
  const promptVersion = [...app.versions].reverse().find((version) => ['draft', 'revise', 'freeform'].includes(version.stage))
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

export const AGENT_SYSTEM_PROMPT = `You are the H3 Prompt Studio browser agent. Work with the Studio state through deterministic tools.

The canonical prompt is always the complete prompt in the current version. If the user asks for a prompt change, produce the complete updated prompt and call set_current_prompt or append_prompt_version. Never put explanation, markdown fences, or tool commentary in the prompt argument.

Use read_studio_state before making decisions when context is missing. Use prepare_continuation for a selected rendered clip; it stages state but does not author text. Do not call Studio LLM stages and do not invent renders. Render and multiclip tools require explicit confirmation from the user; never pass confirmed=true until the user has confirmed in the interface. Keep the response concise and stop after one meaningful operation.`

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
