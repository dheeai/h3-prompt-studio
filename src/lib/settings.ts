export const SETTINGS_SCHEMA = 5
export const DEFAULT_THINKING_ENABLED = true

export function thinkingEnabledFromSaved(saved: { thinkingEnabled?: unknown } | null | undefined): boolean {
  return typeof saved?.thinkingEnabled === 'boolean' ? saved.thinkingEnabled : DEFAULT_THINKING_ENABLED
}
