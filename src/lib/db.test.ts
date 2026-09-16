import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrate } from './db'
import type { UpgradableDb } from './db'

/** Node has no native IndexedDB, so the migration is exercised against a
 * plain in-memory stand-in for the one slice of `IDBDatabase` an upgrade
 * actually touches, rather than a real browser database. */
class FakeDb implements UpgradableDb {
  stores = new Set<string>()
  objectStoreNames = { contains: (name: string) => this.stores.has(name) }
  createObjectStore(name: string) {
    this.stores.add(name)
    return {}
  }
  deleteObjectStore(name: string) {
    this.stores.delete(name)
  }
}

const CURRENT_STORES = ['skills', 'settings', 'sessions', 'plates', 'clips']

test('migrate drops the retired recipes store — the actual bug: stale Contex-Loop entries kept surfacing because the store itself was never removed', () => {
  const db = new FakeDb()
  db.stores.add('recipes')
  db.stores.add('settings')
  migrate(db)
  assert.equal(db.objectStoreNames.contains('recipes'), false)
})

test('migrate creates every store this version needs, on a brand-new database', () => {
  const db = new FakeDb()
  migrate(db)
  for (const s of CURRENT_STORES) assert.equal(db.objectStoreNames.contains(s), true, `expected ${s} to exist`)
})

test('migrate leaves every OTHER existing store alone — only recipes is dropped', () => {
  const db = new FakeDb()
  for (const s of CURRENT_STORES) db.stores.add(s)
  db.stores.add('recipes')
  migrate(db)
  for (const s of CURRENT_STORES) assert.equal(db.objectStoreNames.contains(s), true)
})

test('migrate is idempotent — running it again on an already-migrated db changes nothing', () => {
  const db = new FakeDb()
  migrate(db)
  const before = [...db.stores].sort()
  migrate(db)
  assert.deepEqual([...db.stores].sort(), before)
})
