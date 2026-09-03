import type { ChatMessage } from '../src/lib/llm'
import type { EntryModeId } from '../src/lib/entry'
import type { FilmContext, H3Mode, StageId } from '../src/lib/types'

export type EvalModel = 'default' | 'thinkingcap-27b' | 'qwen38-heretic-27b-fast'

export type EvalFamily = 'scene' | 'clip' | 'prompt' | 'continuation'

export type EvalValidatorId =
  | 'breakdown-json'
  | 'required-h3-fields'
  | 'prompt-replacement-blocks'
  | 'handoff-blocks'
  | 'fixed-facts'
  | 'neighboring-states'
  | 'continuity'
  | 'dialogue-acting'

export interface ThinkingEvalCase {
  id: string
  family: EvalFamily
  stage: StageId
  studioMode: EntryModeId
  h3Mode: H3Mode
  story: string
  current: string
  previous: string
  film: FilmContext
  notes: string
  findings: string
  standing: string
  validators: readonly EvalValidatorId[]
}

export interface ParsedEvalResponse {
  content: string
  reasoning: string
  finishReason: string | null
  usage: { prompt?: number; completion?: number } | null
  elapsedMs: number
  timeToFirstTokenMs: number | null
  unterminatedThink: boolean
}

export interface RawEvalRecord {
  eval: 'studio-thinking-v1'
  caseId: string
  family: EvalFamily
  stage: StageId
  studioMode: EntryModeId
  model: EvalModel
  chatTemplateKwargs: { enable_thinking: boolean }
  settings: {
    temperature: 0.2
    maxTokens: 8192
    h3Mode: H3Mode
    selectedSkills: string[]
    inputHash: string
    systemHash: string
  }
  request: { url: string; body: Record<string, unknown> }
  response: ParsedEvalResponse & { requestCount: 1; continuations: 0 }
  deterministic: {
    passed: boolean
    findings: { id: string; passed: boolean; detail: string }[]
  }
  qualitative: null
  errors: string[]
}

export type EvalChatMessage = ChatMessage
