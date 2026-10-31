/**
 * S3 credential-write guard behaviour.
 *
 * The product shares one credentials document with the bundled runtime, so the
 * claims under test are: a missing provider refuses instead of dropping a key, a
 * store that did not land in the managed document is not reported as success, no
 * receipt or log line carries the secret, and the set of files allowed to write
 * the document is exactly the reviewed set — each using the shared lock and the
 * atomic replace.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import {
  CREDENTIAL_DOCUMENT_WRITERS,
  CREDENTIALS_FILENAME,
  auditCredentialDocumentWriters,
  countSecretLeaks,
  createCredentialWriteChannel,
  credentialDocumentPath,
  credentialLockPath,
  documentMode,
  isOwnerOnlyMode,
  redactSecretText,
} from '../lib/credentials-guard.mjs'

const SECRET = 'sk-fixture-never-log-this-value'

/** Minimal stand-in for the provider seam; `describe` mirrors credentials-local. */
function fakeProvider({ source = 'file', failSet = null } = {}) {
  const values = new Map()
  return {
    values,
    calls: [],
    async set(ref, value) {
      this.calls.push(['set', ref])
      if (failSet !== null) throw new Error(failSet)
      values.set(ref, value)
    },
    async unset(ref) {
      this.calls.push(['unset', ref])
      values.delete(ref)
    },
    async describe(ref) {
      this.calls.push(['describe', ref])
      return values.has(ref)
        ? { configured: true, source, writable: true }
        : { configured: false, writable: true }
    },
  }
}

test('a missing credentials provider refuses the write instead of reporting success', async () => {
  const channel = createCredentialWriteChannel({ credentials: undefined })
  await assert.rejects(
    () => channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET }),
    (error) => error.code === 'CREDENTIALS_UNAVAILABLE' && error.status === 503,
  )
  assert.equal(countSecretLeaks(String(channel), [SECRET]), 0)
})

test('a configured channel writes through the provider and verifies the managed source', async () => {
  const provider = fakeProvider()
  const channel = createCredentialWriteChannel({ credentials: provider })
  const receipt = await channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET })
  assert.deepEqual(receipt, { ref: 'WHALEGIRL_LLM_API_KEY', stored: true, verified: true, source: 'file' })
  assert.deepEqual(provider.calls, [['set', 'WHALEGIRL_LLM_API_KEY'], ['describe', 'WHALEGIRL_LLM_API_KEY']])
  // No read path in this channel returns the value, and the receipt is safe to
  // return over HTTP or write to the audit log.
  assert.equal(countSecretLeaks(receipt, [SECRET]), 0)
})

test('a write that did not land in the managed document is a mismatch, not a success', async () => {
  // The value is only inherited from the environment: the managed document does
  // not hold it, so a later launch without that variable would lose the key.
  const provider = fakeProvider({ source: 'env' })
  const channel = createCredentialWriteChannel({ credentials: provider })
  provider.values.set('WHALEGIRL_LLM_API_KEY', SECRET)
  await assert.rejects(
    () => channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET }),
    (error) => error.code === 'CREDENTIAL_READBACK_MISMATCH' && error.status === 503,
  )
})

test('a provider failure surfaces instead of being swallowed', async () => {
  const provider = fakeProvider({ failSet: 'credentials-local: document is not 0600' })
  const channel = createCredentialWriteChannel({ credentials: provider })
  await assert.rejects(() => channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET }), /document is not 0600/)
})

test('empty values and empty references are refused with typed codes', async () => {
  const channel = createCredentialWriteChannel({ credentials: fakeProvider() })
  await assert.rejects(() => channel.store({ ref: '', value: SECRET }), (error) => error.code === 'CREDENTIAL_REF_REQUIRED' && error.status === 400)
  await assert.rejects(() => channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: '' }), (error) => error.code === 'CREDENTIAL_VALUE_EMPTY' && error.status === 400)
})

test('clearing reports the post-clear description and never a value', async () => {
  const provider = fakeProvider()
  const channel = createCredentialWriteChannel({ credentials: provider })
  await channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET })
  const cleared = await channel.clear({ ref: 'WHALEGIRL_LLM_API_KEY' })
  assert.deepEqual(cleared, { ref: 'WHALEGIRL_LLM_API_KEY', cleared: true, configured: false })
  assert.equal(countSecretLeaks(cleared, [SECRET]), 0)
})

test('log lines are redacted: the secret never reaches the log sink', async () => {
  const lines = []
  const channel = createCredentialWriteChannel({
    credentials: fakeProvider(),
    log: (event, fields) => { lines.push(redactSecretText(JSON.stringify({ event, fields }), [SECRET])) },
  })
  await channel.store({ ref: 'WHALEGIRL_LLM_API_KEY', value: SECRET })
  assert.equal(lines.length, 1)
  assert.match(lines[0], /credentials\.stored/)
  assert.equal(countSecretLeaks(lines, [SECRET]), 0)
})

test('the write channel and the upstream provider share one lock path', () => {
  const document = credentialDocumentPath('/tmp/dsh-home-fixture')
  assert.equal(document, '/tmp/dsh-home-fixture/' + CREDENTIALS_FILENAME)
  assert.equal(credentialLockPath(document), document + '.lock', 'the lock name upstream withFileLock creates for the same file')
  assert.equal(credentialLockPath(document).endsWith(CREDENTIALS_FILENAME + '.lock'), true)
})

test('owner-only permission bits are recognised', () => {
  assert.equal(isOwnerOnlyMode(0o600), true)
  assert.equal(isOwnerOnlyMode(0o400), true)
  assert.equal(isOwnerOnlyMode(0o640), false)
  assert.equal(isOwnerOnlyMode(0o644), false)
  assert.equal(isOwnerOnlyMode(0o604), false)
  assert.equal(documentMode('/tmp/definitely-absent-dsh-home-fixture/.credentials.yaml'), null)
})

test('every writer of the shared credentials document uses the shared lock and atomic replace', () => {
  const root = resolve(import.meta.dirname, '../../../..')
  const detected = auditCredentialDocumentWriters({
    root,
    directories: [
      'packages/credentials/credentials-local/src',
      'apps/desktop/src',
      'nisse/packages/host-integration/lib',
      'packages/api/settings-controller/src',
    ],
  })
  // Adding a writer is a deliberate act: update the reviewed list together with
  // the protocol it must follow, never just the allowlist.
  assert.deepEqual(
    detected.map(entry => entry.file),
    CREDENTIAL_DOCUMENT_WRITERS.map(entry => entry.file).sort((left, right) => left.localeCompare(right)),
  )
  for (const writer of detected) {
    assert.equal(writer.takesLock, true, writer.file + ' must take the shared writer lock')
    assert.equal(writer.atomicReplace, true, writer.file + ' must commit with an atomic replace')
  }
})
