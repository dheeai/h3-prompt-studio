/** The three ways a new operator can enter the studio. */
export type EntryModeId = 'story' | 'prompt' | 'idea'

export interface EntryMode {
  id: EntryModeId
  label: string
  title: string
  description: string
  placeholder: string
  action: string
}

export const ENTRY_MODES: readonly EntryMode[] = [
  {
    id: 'story',
    label: 'A story',
    title: 'Your story',
    description: 'Plan several connected clips',
    placeholder: 'Paste a story, beat sheet, or script…',
    action: 'Generate clip plan',
  },
  {
    id: 'prompt',
    label: 'A prompt',
    title: 'Your prompt',
    description: 'Improve what you already have',
    placeholder: 'Paste a rough or finished H3 prompt…',
    action: 'Refine prompt',
  },
  {
    id: 'idea',
    label: 'An idea',
    title: 'Your idea',
    description: 'Turn a thought into one H3 prompt',
    placeholder: 'Describe the moment, image, or effect you want…',
    action: 'Generate H3 prompt',
  },
]

export function entryMode(id: EntryModeId): EntryMode {
  return ENTRY_MODES.find((mode) => mode.id === id) ?? ENTRY_MODES[0]
}

export function entryLabel(id: EntryModeId): string {
  return entryMode(id).label
}

export function entryAction(id: EntryModeId): string {
  return entryMode(id).action
}
