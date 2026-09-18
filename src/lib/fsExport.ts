import { slugifyFilmName } from './extender'
import type { ExportFile } from './sessionExport'

/**
 * The effectful half of "save the prompts locally" — everything
 * `sessionExport.ts` deliberately cannot do (touch `window`, a real
 * directory, a real download). Not unit-tested for the same reason `db.ts`'s
 * `open()`/`tx()` aren't: there is no DOM/File System Access API in Node,
 * only `migrate()`'s pure slice is. Every function here is a thin wrapper
 * with nothing to assert beyond "it calls the browser API" — the actual
 * CONTENT decisions all live in `sessionExport.ts`, which is what carries
 * the tests.
 *
 * TypeScript's shipped `lib.dom.d.ts` (this repo's TS version) knows
 * `FileSystemDirectoryHandle`/`FileSystemFileHandle`/`createWritable`, but
 * not `showDirectoryPicker` (no origin yet ships it as a *documented*
 * standard global) or `queryPermission`/`requestPermission` on a handle —
 * both are real Chrome APIs, just not in this lib version. Declared here,
 * once, as ambient global augmentation.
 */
declare global {
  interface FileSystemHandle {
    queryPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
    requestPermission(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>
  }
  interface Window {
    showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite'; id?: string }): Promise<FileSystemDirectoryHandle>
  }
}

/** Feature-detect, never user-agent sniff — Safari and Firefox simply don't
 * define `showDirectoryPicker`. */
export function supportsFileSystemAccess(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** Opens the browser's own folder picker. Must be called from inside a
 * click handler — Chrome refuses it without a user gesture. Rejects with
 * `AbortError` when the operator cancels the picker; callers should treat
 * that as "did nothing", not a failure worth surfacing. */
export async function pickExportDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) throw new Error('showDirectoryPicker is not available in this browser.')
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

/** Read-only permission check — unlike `requestDirPermission`, this needs
 * no user gesture, so it is safe to call on boot against a handle loaded
 * back out of IndexedDB. A stored handle is not a live grant: Chrome can
 * drop the grant silently across a browser restart, or the operator can
 * revoke it in chrome://settings, and this is how that shows up. */
export async function checkDirPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return handle.queryPermission({ mode: 'readwrite' })
}

/** Re-prompts for permission on an already-picked folder. Needs a user
 * gesture (call this directly from a click handler) exactly like
 * `pickExportDirectory` — Chrome refuses a bare call. */
export async function requestDirPermission(handle: FileSystemDirectoryHandle): Promise<PermissionState> {
  return handle.requestPermission({ mode: 'readwrite' })
}

async function writeOneFile(root: FileSystemDirectoryHandle, path: string, content: string): Promise<void> {
  const parts = path.split('/').filter(Boolean)
  const filename = parts.pop()
  if (!filename) return
  let dir = root
  for (const seg of parts) dir = await dir.getDirectoryHandle(seg, { create: true })
  const fileHandle = await dir.getFileHandle(filename, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(content)
  await writable.close()
}

/** A thin loop over `buildExportPlan`'s output — see that function's own
 * comment for why the content decisions live there and not here. */
export async function writeFilesToDirectory(root: FileSystemDirectoryHandle, files: ExportFile[]): Promise<void> {
  for (const f of files) await writeOneFile(root, f.path, f.content)
}

/** The `SkillsPanel.tsx`-precedent download dance (`doExport`, line ~119)
 * — Blob + `URL.createObjectURL` + a clicked, never-appended `<a download>`.
 * The fallback path for a browser with no File System Access API. */
export function downloadTextFile(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

/** The folder name a film's export lands under — reuses `slugifyFilmName`
 * rather than a second sanitiser, so it is exactly the studio's existing
 * "Act 2 / the door can't create a folder" guarantee. */
export function exportFolderName(filmName: string): string {
  return slugifyFilmName(filmName)
}
