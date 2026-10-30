/**
 * Bounded, atomic, versioned product-state persistence for the beta2 Host.
 *
 * The Host must survive restarts without ever auto-replaying work and without
 * silently overwriting a damaged record. Everything here is deliberately small:
 * one JSON state file + one idempotency-receipt file under the product Bot
 * directory (never DSH's database, never a new database engine).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const STATE_SCHEMA_VERSION = 1
export const RECEIPT_SCHEMA_VERSION = 1

function safeMkdir(dir) {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }) } catch { /* existing dir */ }
}

function quarantine(file, now) {
  const stamp = String(now()).replace(/[^0-9A-Za-z]+/g, '-').replace(/-+$/, '')
  const backup = `${file}.corrupt-${stamp}-${process.pid}`
  try { renameSync(file, backup); return backup } catch { return null }
}

function atomicWrite(file, payload, now) {
  safeMkdir(dirname(file))
  const text = JSON.stringify(payload, null, 2) + '\n'
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  try { chmodSync(tmp, 0o600) } catch { /* best effort */ }
  renameSync(tmp, file)
  return text.length
}

/**
 * A single versioned JSON document with atomic replacement.
 * - `load()` returns {data, corruptBackup, error}; corruption is quarantined, never overwritten.
 * - `update(mutator)` clones, mutates the clone, persists, and returns the new data.
 * - A missing file yields data=null (callers apply their own defaults).
 */
export function createStateStore({ file, schemaVersion = STATE_SCHEMA_VERSION, maxBytes = 2 * 1024 * 1024, now = () => new Date().toISOString() } = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('state store requires a file path')
  let data = null
  let loaded = false
  let corruptBackup = null
  let loadError = null
  let writes = 0
  function load() {
    if (loaded) return { data, corruptBackup, error: loadError }
    loaded = true
    try {
      if (!existsSync(file)) return { data: null, corruptBackup: null, error: null }
      const stat = statSync(file)
      if (!stat.isFile() || stat.size > maxBytes) throw new Error('state file missing or too large')
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.schemaVersion !== schemaVersion) {
        throw new Error('unsupported state document')
      }
      data = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data : {}
      return { data, corruptBackup: null, error: null }
    } catch (error) {
      loadError = String(error?.message || error)
      corruptBackup = quarantine(file, now)
      data = null
      return { data: null, corruptBackup, error: loadError }
    }
  }
  function update(mutator) {
    load()
    const draft = data ? JSON.parse(JSON.stringify(data)) : {}
    const next = mutator(draft)
    const resolved = next === undefined ? draft : next
    if (!resolved || typeof resolved !== 'object' || Array.isArray(resolved)) throw new Error('state mutator must return an object')
    atomicWrite(file, { schemaVersion, updatedAt: now(), data: resolved }, now)
    data = resolved
    writes += 1
    return data
  }
  return {
    file,
    load,
    update,
    snapshot: () => (data ? JSON.parse(JSON.stringify(data)) : null),
    stats: () => ({ loaded, writes, corruptBackup, loadError }),
    close() { loaded = false },
  }
}

/**
 * Bounded idempotency-receipt persistence.
 * Receipts are a recovery aid only: on restart they are read-only history; a
 * command whose outcome is unknown is never re-executed from here.
 */
export function createReceiptStore({ file, schemaVersion = RECEIPT_SCHEMA_VERSION, maxEntries = 128, now = () => new Date().toISOString() } = {}) {
  if (typeof file !== 'string' || file === '') throw new Error('receipt store requires a file path')
  let loaded = false
  let entries = []
  let corruptBackup = null
  function load() {
    if (loaded) return { entries, corruptBackup }
    loaded = true
    try {
      if (!existsSync(file)) return { entries: [], corruptBackup: null }
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== schemaVersion || !Array.isArray(parsed.receipts)) {
        throw new Error('unsupported receipt document')
      }
      entries = parsed.receipts.filter((item) => item && typeof item.key === 'string').slice(-maxEntries)
      return { entries, corruptBackup: null }
    } catch {
      corruptBackup = quarantine(file, now)
      entries = []
      return { entries: [], corruptBackup }
    }
  }
  function put(key, record) {
    load()
    entries = entries.filter((item) => item.key !== key)
    entries.push({ key, at: now(), ...record })
    if (entries.length > maxEntries) entries = entries.slice(-maxEntries)
    atomicWrite(file, { schemaVersion, updatedAt: now(), receipts: entries }, now)
    return entries.length
  }
  function get(key) {
    load()
    return entries.find((item) => item.key === key) || null
  }
  return {
    file,
    load,
    get,
    put,
    size: () => entries.length,
    stats: () => ({ loaded, size: entries.length, corruptBackup }),
    close() { loaded = false },
  }
}
