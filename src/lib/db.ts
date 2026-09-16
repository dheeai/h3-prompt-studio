// A very small IndexedDB wrapper.
//
// localStorage would be simpler but caps around 5 MB, and the skill corpus
// alone is ~270 KB before anyone uploads anything of their own. IndexedDB has
// room and stores structured values without a JSON round-trip.

const DB_NAME = 'h3-prompt-studio'
const DB_VERSION = 3
const STORES = ['skills', 'settings', 'sessions', 'plates', 'clips'] as const

export type StoreName = (typeof STORES)[number]

/**
 * Stores this app used to keep and no longer does. Dropped on the next
 * upgrade rather than merely stopped-writing-to: `recipes` (the plain
 * single-clip Recipe/Binding render path, removed 2026-09-16 once the Master
 * Extender became the studio's only render path) is exactly the founder's
 * reported bug — retired Contex-Loop recipes kept surfacing because
 * `RecipePanel` listed whatever was still sitting in this store, and merely
 * deleting `RecipePanel` would have left the stale data on disk forever,
 * one browser restore away from resurfacing if anything ever read the store
 * again.
 */
const DROPPED_STORES = ['recipes'] as const

/** A stand-in for the one slice of `IDBDatabase` an upgrade actually touches
 * — kept separate from the real `open()` below so the migration itself is
 * exercisable against a plain fake object. Node has no native IndexedDB. */
export interface UpgradableDb {
  objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): unknown
  deleteObjectStore(name: string): void
}

/** The actual migration: create every store this version needs and is
 * missing, then drop every store a past version created that this one no
 * longer uses. Idempotent — running it again on an already-migrated db is a
 * no-op both ways. */
export function migrate(db: UpgradableDb): void {
  for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s)
  for (const s of DROPPED_STORES) if (db.objectStoreNames.contains(s)) db.deleteObjectStore(s)
}

let dbPromise: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => migrate(req.result)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const idb = {
  get: <T>(store: StoreName, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>),
  set: (store: StoreName, key: string, value: unknown) => tx(store, 'readwrite', (s) => s.put(value, key) as IDBRequest<IDBValidKey>),
  del: (store: StoreName, key: string) => tx(store, 'readwrite', (s) => s.delete(key) as unknown as IDBRequest<undefined>),
  all: <T>(store: StoreName) => tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>),
  keys: (store: StoreName) => tx<IDBValidKey[]>(store, 'readonly', (s) => s.getAllKeys() as IDBRequest<IDBValidKey[]>),
  clear: (store: StoreName) => tx(store, 'readwrite', (s) => s.clear() as unknown as IDBRequest<undefined>),
}

/** Rough bytes held, for the storage line in the skills panel. */
export async function estimateUsage(): Promise<{ used: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null
  const e = await navigator.storage.estimate()
  return { used: e.usage ?? 0, quota: e.quota ?? 0 }
}
