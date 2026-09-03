export const SETTINGS_SCHEMA = 5
export const DEFAULT_THINKING_ENABLED = true

export function thinkingEnabledFromSaved(saved: { thinkingEnabled?: unknown } | null | undefined): boolean {
  return typeof saved?.thinkingEnabled === 'boolean' ? saved.thinkingEnabled : DEFAULT_THINKING_ENABLED
}

/**
 * Apply the settings migrations that predate the thinking toggle.
 *
 * Schema 4 already contains user-owned output limits and template overrides,
 * so only schema versions below 4 receive the old cleanup. Every version
 * below the current schema then advances to the current schema without
 * changing those fields.
 */
export function migrateSettings(
  saved: { schema?: number } | null | undefined,
  merged: { schema?: number; maxTokens: number; stageTemplates: unknown },
  legacyMaxTokens: number,
): void {
  const savedSchema = saved?.schema ?? 1
  if (savedSchema < 4) {
    merged.maxTokens = legacyMaxTokens
    merged.stageTemplates = {}
  }
  if (savedSchema < SETTINGS_SCHEMA) merged.schema = SETTINGS_SCHEMA
}
