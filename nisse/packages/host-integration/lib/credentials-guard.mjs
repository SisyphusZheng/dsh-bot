/**
 * Credential write channel guard.
 *
 * The product shares the DSH credentials document (`$DSH_HOME/.credentials.yaml`)
 * with the bundled runtime, and that document has more than one writer: the
 * upstream provider (`@deepseek-ai/dsh-credentials-local`) and the Desktop
 * settings process. "Several writers" is only safe when every writer uses the
 * same two mechanisms the upstream provider defines, so this module names that
 * protocol and enforces the parts an entry point can still get wrong:
 *
 *  - the managed writer lock is `<document>.lock`, taken with `wx` create and a
 *    holder PID record, so a read-modify-write cycle can never resurrect a state
 *    another writer replaced (`@deepseek-ai/dsh-atomic-write` owns the
 *    implementation; this module only states where the lock lives);
 *  - the commit is a random-suffix temp file renamed over the document, which
 *    carries `0600` onto the replaced inode;
 *  - a document that cannot be parsed, or a provider that is absent, fails
 *    closed: the caller sees a typed error and no value is discarded silently.
 *
 * The store is a `0600` file owned by the OS user. It is not Keychain
 * encryption and must never be described as such.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Basename of the shared credentials document inside the harness home. */
export const CREDENTIALS_FILENAME = '.credentials.yaml'

/** Suffix of the cross-process writer lock the upstream provider also uses. */
export const CREDENTIALS_LOCK_SUFFIX = '.lock'

/** Permission bits outside the owner; a credentials document must have none of them. */
export const CREDENTIALS_FORBIDDEN_BITS = 0o077

/**
 * Every source file allowed to write the shared credentials document, with the
 * protocol each one must use. A new writer has to be added here deliberately;
 * {@link auditCredentialDocumentWriters} fails the gate otherwise.
 */
export const CREDENTIAL_DOCUMENT_WRITERS = Object.freeze([
  { file: 'packages/credentials/credentials-local/src/index.ts', role: 'upstream-provider', takesLock: true, atomicReplace: true },
  { file: 'apps/desktop/src/secret-store.ts', role: 'desktop-settings', takesLock: true, atomicReplace: true },
])

const WRITE_CALL = /\b(?:writeFileAtomic|writeFileSync|writeFile|renameSync|rename)\s*\(/
const LOCK_CALL = /\bwithFileLock\s*\(/
const ATOMIC_CALL = /\bwriteFileAtomic\s*\(/

/**
 * Drop block comments and whole-line `//` comments before scanning.
 * A comment that merely names the document is documentation, not a writer;
 * trailing `//` is left alone so a URL in a string literal survives.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(line => !/^\s*(?:\/\/|\*)/.test(line))
    .join('\n')
}

/** Absolute path of the shared credentials document for one harness home. */
export function credentialDocumentPath(dshHome) {
  if (typeof dshHome !== 'string' || dshHome === '') throw new Error('credentialDocumentPath requires a harness home')
  return join(dshHome, CREDENTIALS_FILENAME)
}

/** Absolute path of the writer lock for a credentials document. */
export function credentialLockPath(documentPath) {
  return String(documentPath) + CREDENTIALS_LOCK_SUFFIX
}

/**
 * Whether a document's permission bits keep it owner-only.
 * @param {number} mode - `stat().mode` (file type bits are ignored).
 * @returns {boolean} true when no group/other bit is set.
 */
export function isOwnerOnlyMode(mode) {
  return (Number(mode) & CREDENTIALS_FORBIDDEN_BITS) === 0
}

/** A secret must never be echoed in a response, log line, or audit record. */
function requireService(credentials) {
  const usable = credentials !== undefined && credentials !== null
    && typeof credentials.set === 'function' && typeof credentials.describe === 'function'
  if (!usable) {
    const error = new Error('the DSH credentials service is not mounted, so a provider key cannot be stored')
    error.code = 'CREDENTIALS_UNAVAILABLE'
    error.status = 503
    throw error
  }
  return credentials
}

/**
 * The only way an entry point may store or clear a provider key.
 *
 * A previous revision wrote the key only when the service happened to exist and
 * still answered `{ok:true, applied:true}` when it did not, which discarded the
 * user's key without telling anyone. This channel fails closed instead, and
 * verifies the value landed in the managed document by re-reading its metadata
 * (`describe` reports the source layer, never the value).
 * @param {object} options - `credentials` service, an optional logger.
 * @returns {object} channel with `store`, `clear`, and `assertAvailable`.
 */
export function createCredentialWriteChannel({ credentials, log = () => {} } = {}) {
  function assertAvailable() {
    return requireService(credentials)
  }

  function verify(ref) {
    // `source: 'file'` is the proof that the managed document — not an inherited
    // environment value — now supplies the reference. `get` is never used: no
    // read path in this channel returns a secret value.
    return Promise.resolve(credentials.describe(ref)).then((info) => {
      const stored = info !== null && typeof info === 'object' && info.configured === true && info.source === 'file'
      if (!stored) {
        const error = new Error('the credentials service did not confirm the stored value for ' + String(ref))
        error.code = 'CREDENTIAL_READBACK_MISMATCH'
        error.status = 503
        throw error
      }
      return { configured: true, source: String(info.source) }
    })
  }

  return {
    assertAvailable,
    /**
     * Store one provider key through the managed provider and verify it landed.
     * @param {object} request - `ref` and `value`.
     * @returns {object} receipt safe to return over HTTP: ref and verification facts, never the value.
     */
    async store({ ref, value }) {
      const provider = assertAvailable()
      const reference = String(ref || '')
      const secret = String(value ?? '')
      if (reference === '') {
        const error = new Error('a credential reference is required')
        error.code = 'CREDENTIAL_REF_REQUIRED'
        error.status = 400
        throw error
      }
      if (secret === '') {
        const error = new Error('an empty value cannot be stored for ' + reference + '; clear it instead')
        error.code = 'CREDENTIAL_VALUE_EMPTY'
        error.status = 400
        throw error
      }
      await provider.set(reference, secret)
      const verified = await verify(reference)
      log('credentials.stored', { ref: reference, source: verified.source })
      return { ref: reference, stored: true, verified: true, source: verified.source }
    },
    /**
     * Remove one reference through the managed provider and confirm it is gone.
     * @param {object} request - `ref`.
     * @returns {object} receipt with the post-clear description, never a value.
     */
    async clear({ ref }) {
      const provider = assertAvailable()
      const reference = String(ref || '')
      await provider.unset(reference)
      const info = await provider.describe(reference)
      log('credentials.cleared', { ref: reference, configured: info?.configured === true })
      return { ref: reference, cleared: true, configured: info?.configured === true }
    },
  }
}

/**
 * Replace every occurrence of the given secret values with a marker.
 * @param {string} text - text about to be logged or returned.
 * @param {Iterable<string>} secrets - values that must not appear.
 * @returns {string} the redacted text.
 */
export function redactSecretText(text, secrets) {
  let output = String(text ?? '')
  for (const secret of secrets ?? []) {
    const value = String(secret ?? '')
    if (value === '') continue
    output = output.split(value).join('[REDACTED]')
  }
  return output
}

/**
 * Count how many of the given secrets appear verbatim in a rendered payload.
 * Returns counts only: a leak detector must never re-emit the value it found.
 * @param {unknown} payload - value about to cross a boundary (response, log, audit row).
 * @param {Iterable<string>} secrets - values that must not appear.
 * @returns {number} number of secrets found verbatim.
 */
export function countSecretLeaks(payload, secrets) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null)
  let found = 0
  for (const secret of secrets ?? []) {
    const value = String(secret ?? '')
    if (value === '' ) continue
    if (text.includes(value)) found += 1
  }
  return found
}

/**
 * Static audit of every source file that writes the shared credentials document.
 *
 * This is a guard against regression, not a proof of good behaviour: it reports
 * which writers exist and whether each shows the shared lock and the atomic
 * replace call. A writer that builds the path dynamically can be missed, which
 * is why the allowlist is explicit and reviewed rather than derived.
 * @param {object} options - `root` of the checkout and the source `directories` to scan.
 * @returns {Array<{file: string, takesLock: boolean, atomicReplace: boolean}>} detected writers, sorted by file.
 */
export function auditCredentialDocumentWriters({ root, directories = [] } = {}) {
  if (typeof root !== 'string' || root === '') throw new Error('auditCredentialDocumentWriters requires a checkout root')
  const found = new Map()
  const visit = (directory) => {
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) }
    catch (error) {
      void error
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        // Build output duplicates `src` and is never the authority.
        if (['node_modules', 'lib', 'tests', 'dist', '.desktop-build', '.mvv-build'].includes(entry.name)) continue
        visit(path)
        continue
      }
      if (!/\.(?:ts|tsx|js|mjs)$/.test(entry.name)) continue
      // This module states the protocol; it never writes the document itself.
      if (entry.name === 'credentials-guard.mjs') continue
      let text
      try { text = stripComments(readFileSync(path, 'utf8')) }
      catch (error) {
        void error
        continue
      }
      const namesDocument = text.includes(CREDENTIALS_FILENAME)
      if (!namesDocument || !WRITE_CALL.test(text)) continue
      found.set(path.slice(root.length + 1), {
        file: path.slice(root.length + 1),
        takesLock: LOCK_CALL.test(text),
        atomicReplace: ATOMIC_CALL.test(text),
      })
    }
  }
  for (const directory of directories) visit(join(root, directory))
  return [...found.values()].sort((left, right) => left.file.localeCompare(right.file))
}

/**
 * Read the permission bits of a path, or null when it does not exist.
 * Diagnostics only: it reads metadata, never document content.
 * @param {string} path - document path.
 * @returns {number|null} permission bits, or null when absent.
 */
export function documentMode(path) {
  try { return statSync(path).mode & 0o777 }
  catch (error) {
    if ((error?.code) === 'ENOENT') return null
    throw error
  }
}
