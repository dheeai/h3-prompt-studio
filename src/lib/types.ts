export type SkillSource = 'bundled' | 'upload' | 'url'

export interface SkillFile {
  /** Path relative to the skill root, e.g. "references/rule-of-six.md". */
  rel: string
  text: string
  /** Estimated tokens — see tokens.ts for why this is an estimate. */
  tokens: number
}

export interface Skill {
  id: string
  name: string
  description: string
  source: SkillSource
  /** Where a url-sourced skill came from, for re-sync. */
  origin?: string
  addedAt: number
  files: SkillFile[]
}

/** Which files of which skills are currently loaded into the context. */
export type Selection = Record<string, string[]>

export type ProviderKind = 'openai' | 'ollama'

export interface Provider {
  id: string
  label: string
  /** Base URL including the OpenAI-compatible path segment, e.g. .../v1 */
  baseUrl: string
  kind: ProviderKind
  /** Held in this browser only. Never sent anywhere but this provider. */
  apiKey?: string
  builtIn: boolean
  /** llama.cpp understands cache_prompt; others reject unknown fields. */
  sendCachePrompt?: boolean
  /** Set-up hint shown when a probe fails with a CORS-shaped error. */
  corsHint?: string
}

export type ProbeState =
  | 'unknown'
  | 'probing'
  | 'ok'
  | 'mixed-content'
  | 'local-network-blocked'
  | 'unreachable'
  | 'no-key'
  | 'error'

export interface ProbeResult {
  state: ProbeState
  detail: string
  /** A concrete next step, when the failure has one. */
  hint?: string
  /** A corrected URL to offer, when the entered one is malformed. */
  suggest?: string
  models: string[]
  at: number
}

export type StageId = 'direct' | 'draft' | 'critique' | 'revise' | 'freeform'

export interface Version {
  id: string
  stage: StageId
  label: string
  text: string
  model: string
  providerId: string
  at: number
  ms: number
  /** The instruction that produced it, for freeform turns. */
  note?: string
}

export type H3Mode = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA' | 'Ref2VA' | 'MoGr'

export interface Settings {
  providerId: string
  model: string
  temperature: number
  maxTokens: number
  mode: H3Mode
  selection: Selection
  stageTemplates: Record<StageId, string>
  onboarded: boolean
}

export type Severity = 'error' | 'warn' | 'pass'

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  /** Literal excerpts from the prompt that triggered it. */
  matches: string[]
  metric?: string
}
