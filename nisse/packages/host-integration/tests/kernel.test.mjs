import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PROTOCOL_VERSION,
  SNAPSHOT_SCHEMA,
  ContractError,
  canonicalJson,
  digest,
  validateCommand,
  receipt,
  optionId,
  normalizeAnswerValue,
  emptySnapshotSections,
} from '../lib/contracts.mjs'
import { createStateStore, createReceiptStore, STATE_SCHEMA_VERSION } from '../lib/persistence.mjs'
import { createSnapshotStore } from '../lib/snapshot.mjs'
import {PRODUCT_VERSION} from './product-version.mjs'

const HOST_EPOCH = 'epoch-fixture'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'beta2-kernel-'))
}

// ---------- contracts ----------

test('canonicalJson is key-order independent and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }), canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 }))
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}')
  assert.equal(canonicalJson({ a: [undefined, 1] }), '{"a":[null,1]}')
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }))
  const cyclic = {}; cyclic.self = cyclic
  assert.throws(() => canonicalJson(cyclic), (error) => error instanceof ContractError && error.code === 'INVALID_JSON')
})

test('validateCommand rejects unsupported protocol, stale epoch, missing identity and bad session', () => {
  const base = {
    protocolVersion: PROTOCOL_VERSION,
    commandId: 'c1',
    hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker',
    sessionId: 's1',
    type: 'voice.facts',
    payload: { x: 1 },
  }
  const parsed = validateCommand(base, { hostEpoch: HOST_EPOCH, sessionId: 's1' })
  assert.equal(parsed.type, 'voice.facts')
  assert.equal(parsed.payload.x, 1)
  const cases = [
    [{ ...base, protocolVersion: 'v0' }, 'UNSUPPORTED_PROTOCOL', 426],
    [{ ...base, hostEpoch: 'other' }, 'STALE_HOST_EPOCH', 409],
    [{ ...base, commandId: '' }, 'MISSING_COMMAND_ID', 400],
    [{ ...base, sourceConnectionId: undefined }, 'MISSING_SOURCE', 401],
    [{ ...base, sessionId: 's2' }, 'STALE_SESSION', 409],
    [{ ...base, type: 'Voice Facts' }, 'INVALID_COMMAND_TYPE', 400],
    [{ ...base, payload: [] }, 'INVALID_PAYLOAD', 400],
  ]
  for (const [body, code, status] of cases) {
    assert.throws(() => validateCommand(body, { hostEpoch: HOST_EPOCH, sessionId: 's1' }), (error) => {
      assert.equal(error.code, code)
      assert.equal(error.status, status)
      return true
    })
  }
})

test('receipt shape is bounded and status-validated', () => {
  const value = receipt({ commandId: 'c1', hostEpoch: HOST_EPOCH, status: 'resolved', result: { ok: true }, at: '2026-01-01T00:00:00.000Z' })
  assert.equal(value.protocolVersion, PROTOCOL_VERSION)
  assert.equal(value.status, 'resolved')
  assert.equal(value.result.ok, true)
  assert.throws(() => receipt({ commandId: 'c', hostEpoch: 'e', status: 'done' }), /invalid receipt status/)
  const err = receipt({ commandId: 'c', hostEpoch: 'e', status: 'rejected', error: { code: 'X', message: 'y'.repeat(3000) } })
  assert.equal(err.error.message.length, 1000)
})

test('option ids are stable within a semantic revision and change across revisions', () => {
  const a = optionId('q1', 1, '拿铁', 0)
  assert.equal(a, optionId('q1', 1, '拿铁', 0))
  assert.notEqual(a, optionId('q1', 2, '拿铁', 0))
  assert.notEqual(a, optionId('q1', 1, '美式', 0))
})

test('normalizeAnswerValue validates by option id, never by list position', () => {
  const questions = [{ id: 'q1', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }]
  // Position 2 ("third") is only valid when it maps to the selected option identity.
  const optionIds = { q1: [optionId('q1', 1, 'A', 0), optionId('q1', 1, 'B', 1), optionId('q1', 1, 'C', 2)] }
  const ok = normalizeAnswerValue(questions, { semanticRevision: 1, answers: [{ id: 'q1', selected: [optionIds.q1[1]] }] }, { optionIds })
  assert.deepEqual(ok.answers, [{ id: 'q1', selected: [optionIds.q1[1]] }])
  assert.throws(() => normalizeAnswerValue(questions, { semanticRevision: 1, answers: [{ id: 'q1', selected: ['position:1'] }] }, { optionIds }), /unknown option id/)
  assert.throws(() => normalizeAnswerValue(questions, { semanticRevision: 1, answers: [{ id: 'q1', selected: [optionIds.q1[0], optionIds.q1[1]] }] }, { optionIds }), /single-select/)
  assert.throws(() => normalizeAnswerValue(questions, { semanticRevision: 1, answers: [] }, { optionIds }), /answer every question/)
  const multi = [{ id: 'q2', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] }]
  const multiIds = { q2: [optionId('q2', 3, 'X', 0), optionId('q2', 3, 'Y', 1)] }
  const multiOk = normalizeAnswerValue(multi, { semanticRevision: 3, answers: [{ id: 'q2', selected: [multiIds.q2[0], multiIds.q2[1]], custom: '备注' }] }, { optionIds: multiIds })
  assert.equal(multiOk.answers[0].custom, '备注')
  // Multi-select toggle replay must express set-selected in the caller; validation rejects duplicates.
  assert.throws(() => normalizeAnswerValue(multi, { semanticRevision: 3, answers: [{ id: 'q2', selected: [multiIds.q2[0], multiIds.q2[0]] }] }, { optionIds: multiIds }), /repeated option id/)
})

test('empty snapshot sections keep the orthogonal shape', () => {
  const sections = emptySnapshotSections()
  assert.deepEqual(Object.keys(sections.queue), ['revision', 'items'])
  assert.deepEqual(sections.interactions.pending, [])
})

// ---------- persistence ----------

test('state store writes atomically, reloads, and never overwrites corruption', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  const store = createStateStore({ file })
  assert.deepEqual(store.load(), { data: null, corruptBackup: null, error: null })
  store.update((draft) => { draft.queue = [{ id: 'q1', text: 'hello' }]; return draft })
  const reloaded = createStateStore({ file }).load()
  assert.equal(reloaded.data.queue[0].text, 'hello')
  const document = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(document.schemaVersion, STATE_SCHEMA_VERSION)
  assert.equal(document.data.queue.length, 1)
  // Corrupt file: quarantined, original bytes preserved in the backup.
  writeFileSync(file, '{not json')
  const broken = createStateStore({ file }).load()
  assert.equal(broken.data, null)
  assert.ok(broken.corruptBackup && existsSync(broken.corruptBackup))
  assert.equal(readFileSync(broken.corruptBackup, 'utf8'), '{not json')
  assert.equal(existsSync(file), false)
})

test('state store rejects unknown schema and oversized documents without overwrite', () => {
  const dir = tempDir()
  const file = join(dir, 'state.json')
  writeFileSync(file, JSON.stringify({ schemaVersion: 999, data: { keep: true } }))
  const loaded = createStateStore({ file }).load()
  assert.equal(loaded.data, null)
  assert.match(String(loaded.error), /unsupported state document/)
  assert.ok(loaded.corruptBackup)
  const tiny = join(dir, 'tiny.json')
  writeFileSync(tiny, JSON.stringify({ schemaVersion: 1, data: { padding: 'x'.repeat(4000) } }))
  const bounded = createStateStore({ file: tiny, maxBytes: 1000 }).load()
  assert.equal(bounded.data, null)
})

test('receipt store is bounded and survives restart as read-only history', () => {
  const dir = tempDir()
  const file = join(dir, 'receipts.json')
  const store = createReceiptStore({ file, maxEntries: 3 })
  for (let i = 0; i < 6; i += 1) store.put('c' + i, { digest: 'd' + i, receipt: receipt({ commandId: 'c' + i, hostEpoch: 'e', status: 'accepted' }) })
  assert.equal(store.size(), 3)
  assert.equal(store.get('c5').digest, 'd5')
  assert.equal(store.get('c0'), null)
  const reloaded = createReceiptStore({ file, maxEntries: 3 })
  assert.equal(reloaded.load().entries.length, 3)
  assert.equal(reloaded.get('c5').digest, 'd5')
})

// ---------- snapshot / events ----------

test('snapshot + replay handshake never loses the events recorded after the snapshot', () => {
  const store = createSnapshotStore({ hostEpoch: HOST_EPOCH })
  assert.equal(store.seq(), 0)
  store.record('host.epoch', { data: { productVersion: PRODUCT_VERSION } })
  const snapshot = store.snapshot(() => ({ identity: { sessionId: 's' } }))
  assert.equal(snapshot.protocolVersion, PROTOCOL_VERSION)
  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA)
  assert.equal(snapshot.hostEpoch, HOST_EPOCH)
  assert.equal(snapshot.snapshotSeq, 1)
  store.record('queue.changed', { data: { revision: 1 } })
  store.record('execution.changed', { data: { state: 'working' } })
  const replay = store.eventsAfter(snapshot.snapshotSeq)
  assert.equal(replay.resyncRequired, false)
  assert.deepEqual(replay.events.map((event) => event.seq), [2, 3])
  assert.deepEqual(replay.events.map((event) => event.type), ['queue.changed', 'execution.changed'])
  assert.equal(replay.next, 3)
  // A live subscriber sees the replay immediately and then the tail.
  const seen = []
  const sub = store.subscribe(snapshot.snapshotSeq, (event) => seen.push(event.seq))
  assert.deepEqual(seen, [2, 3])
  store.record('notice.added', { data: {} })
  assert.deepEqual(seen, [2, 3, 4])
  sub.unsubscribe()
  store.record('notice.expired', { data: {} })
  assert.deepEqual(seen, [2, 3, 4])
})

test('out-of-window and future cursors force resync instead of silently skipping', () => {
  const store = createSnapshotStore({ hostEpoch: HOST_EPOCH, retention: 4 })
  for (let i = 0; i < 10; i += 1) store.record('tick', { data: { i } })
  assert.equal(store.minRetainedSeq(), 7)
  assert.equal(store.eventsAfter(1).resyncRequired, true)
  assert.equal(store.eventsAfter(6).resyncRequired, false)
  assert.deepEqual(store.eventsAfter(6).events.map((event) => event.seq), [7, 8, 9, 10])
  assert.equal(store.eventsAfter(99).resyncRequired, true)
  assert.equal(store.subscribe(2, () => {}).ok, false)
})

test('event envelopes carry the causal command id only when one exists', () => {
  const store = createSnapshotStore({ hostEpoch: HOST_EPOCH })
  const causal = store.record('queue.changed', { causedByCommandId: 'cmd-1', sessionId: 's', data: { revision: 2 } })
  const official = store.record('interaction.resolved', { source: 'dsh', data: { id: 'i1' } })
  assert.equal(causal.causedByCommandId, 'cmd-1')
  assert.equal(causal.hostEpoch, HOST_EPOCH)
  assert.equal(official.causedByCommandId, null)
  assert.equal(official.source, 'dsh')
  assert.ok(official.eventId)
  assert.ok(official.at)
})

test('disposed snapshot store refuses further writes', () => {
  const store = createSnapshotStore({ hostEpoch: HOST_EPOCH })
  store.record('host.epoch', { data: {} })
  store.dispose()
  assert.throws(() => store.record('host.epoch', { data: {} }), /disposed/)
})
