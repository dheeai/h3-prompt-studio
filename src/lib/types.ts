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
  /** Thinking tokens, when the model emitted any. */
  reasoning?: string
  /** Exactly what this pass worked from, so a diff has a real "before". */
  fromText?: string
  /** One line per edit, each naming the document that required it. */
  changelog?: string[]
  /** Completion tokens — real if the server reported them, else estimated. */
  tokens?: number
  /** True when `tokens` is an estimate rather than a reported count. */
  tokensEstimated?: boolean
  /** The instruction that produced it, for freeform turns. */
  note?: string
}

/** Where a clip sits in a longer film, when it is not standalone. */
export type ClipRole = 'standalone' | 'opening' | 'rising' | 'turn' | 'falling' | 'closing'

export interface FilmContext {
  role: ClipRole
  /** What the whole film is about — one line. */
  spine: string
  /** The state the audience arrives in, from the previous clip. */
  precedes: string
  /** What the next clip has to be able to open on. */
  follows: string
}

export interface ChatTurn {
  role: 'user' | 'assistant'
  text: string
  at: number
  /** Set when this turn produced a new pass rather than just an answer. */
  versionId?: string
}

export type H3Mode = 'T2VA' | 'I2VA' | 'FL2VA' | 'L2VA' | 'Ref2VA' | 'MoGr'

export interface Settings {
  /** Bumped when a default changes in a way that must reach existing users. */
  schema?: number
  providerId: string
  model: string
  temperature: number
  /** 0 = send no ceiling at all and let the server use its own maximum. */
  maxTokens: number
  mode: H3Mode
  selection: Selection
  /**
   * User overrides ONLY. Storing a full copy meant a stored snapshot shadowed
   * the shipped defaults forever, so no improvement to a stage prompt could
   * ever reach someone who had already opened the app.
   */
  stageTemplates: Partial<Record<StageId, string>>
  /** Bundled skill ids already offered, so a deletion is not undone on reload. */
  seenBundled?: string[]
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
