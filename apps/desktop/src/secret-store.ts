/**
 * Provider credential storage, reusing DSH's own credential document.
 *
 * DSH stores credentials in `$DSH_HOME/.credentials.yaml` (mode 0600) and relies
 * on the per-user home boundary rather than app-level encryption; there is no
 * second secret store in upstream. WhaleGirl Bot writes the same document, so a key
 * configured in the Bot is visible to DSH (and vice versa) and the product does not
 * invent its own crypto. This is a private file owned by the OS user, not
 * Keychain encryption, and must never be described as the latter.
 *
 * Because the runtime writes the same document from its own process, this store
 * follows the two mechanisms the upstream provider (`@deepseek-ai/dsh-credentials-local`)
 * already uses, rather than inventing a product-only scheme:
 *  - the cross-process writer lock `<document>.lock` from
 *    `@deepseek-ai/dsh-atomic-write`, held across the whole read-modify-write so a
 *    key written here can never resurrect a state the runtime just replaced;
 *  - a random-suffix temporary sibling renamed over the document, which carries
 *    0600 onto the replacement inode.
 * Reads stay lock-free: the rename commit is atomic, so a reader sees either the
 * previous or the next complete document.
 *
 * A document that cannot be parsed fails closed — the write is refused and the
 * existing file is left exactly as it was — because rewriting it from an empty
 * mapping would silently destroy every credential the user has.
 */
import { chmod, mkdir, stat } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { SecretAccess } from './bot-settings-model.ts'

const CREDENTIALS_FILE = '.credentials.yaml'

/**
 * How long one mutation waits for the shared writer lock.
 *
 * The runtime's provider holds the same lock across a provider request while
 * refreshing a record, and its documented budget for that hold is 30 seconds
 * (`DOCUMENT_LOCK_WAIT_MS` in `@deepseek-ai/dsh-credentials-local`). A contender
 * must outlast the longest holder it can meet, so this bound exceeds that one;
 * sizing it for local file work alone would fail spuriously during a token
 * refresh. Expiry is a refusal, never a bypass: nothing is written and the
 * caller reports the failure.
 */
const DOCUMENT_LOCK_WAIT_MS = 40_000

/** Parsed document plus the refs mapping; every other key is carried through untouched. */
type CredentialDocument = Record<string, unknown>

function documentPath(dshHome: string): string {
  return join(dshHome, CREDENTIALS_FILE)
}

/**
 * Read/write the DSH credentials document used by the bundled runtime.
 *
 * Mutations are asynchronous because the shared lock is: they wait for the
 * runtime's writer instead of racing it. Reads stay synchronous and lock-free.
 */
export class DshCredentialStore implements SecretAccess {
  constructor(private readonly dshHome: string) {}

  private path(): string {
    return documentPath(this.dshHome)
  }

  /** Parse the document and return its top-level mapping (version/records preserved by write). */
  private document(): CredentialDocument {
    let raw: string
    try {
      raw = readFileSync(this.path(), 'utf8')
    } catch (error) {
      // Only a truly absent file is a new profile; never turn I/O errors into an empty store.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, refs: {} }
      throw error
    }
    // YAML parse/type errors must not silently wipe existing credentials on save.
    // The parse failure is reported without the parser's source snippet: the
    // document holds secrets, so its text must not reach an error message the UI
    // or a log may render.
    let parsed: unknown
    try {
      parsed = load(raw)
    } catch {
      throw new Error('DSH credentials document is not valid YAML; refusing to rewrite it')
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('DSH credentials document must be a YAML mapping')
    }
    const refs = (parsed as CredentialDocument).refs
    if (refs !== undefined && (refs === null || typeof refs !== 'object' || Array.isArray(refs))) {
      throw new Error('DSH credentials refs must be a mapping')
    }
    return parsed as CredentialDocument
  }

  private read(): Record<string, string> {
    const refs = this.document()['refs']
    if (refs === null || typeof refs !== 'object' || Array.isArray(refs)) return {}
    const map: Record<string, string> = {}
    for (const [ref, value] of Object.entries(refs as Record<string, unknown>)) {
      if (typeof value === 'string') map[ref] = value
    }
    return map
  }

  /**
   * Patch one reference under the shared writer lock.
   *
   * The document is re-read *after* the lock is held: the state this writer saw
   * before queueing may already have been replaced by the runtime, and patching
   * from that stale copy is what makes unrelated references disappear.
   * @param ref - credential reference to write or clear.
   * @param value - value to store, or an empty string to clear the reference.
   */
  private async write(ref: string, value: string): Promise<void> {
    await mkdir(this.dshHome, { recursive: true, mode: 0o700 })
    await withFileLock(this.path(), async () => {
      const document = this.document()
      const current = document['refs']
      const refs: Record<string, string> = {}
      if (current !== null && typeof current === 'object' && !Array.isArray(current)) {
        for (const [key, entry] of Object.entries(current as Record<string, unknown>)) {
          if (typeof entry === 'string') refs[key] = entry
        }
      }
      if (value === '') Reflect.deleteProperty(refs, ref)
      else refs[ref] = value
      document['refs'] = refs
      if (typeof document['version'] !== 'number') document['version'] = 1
      await writeFileAtomic(this.path(), dump(document, { lineWidth: -1 }), { mode: 0o600, dirMode: 0o700 })
      await this.enforceOwnerOnlyMode()
    }, { waitMs: DOCUMENT_LOCK_WAIT_MS })
  }

  /** Narrow a replaced document whose bits a umask handed wider than 0600. */
  private async enforceOwnerOnlyMode(): Promise<void> {
    const mode = (await stat(this.path())).mode & 0o777
    if ((mode & 0o077) !== 0) await chmod(this.path(), 0o600)
  }

  available(): boolean {
    return true
  }

  /** Backend identity, surfaced in settings diagnostics. */
  mode(): 'dsh-credentials' {
    return 'dsh-credentials'
  }

  has(ref: string): boolean {
    return (this.read()[ref] ?? '') !== ''
  }

  get(ref: string): string {
    return this.read()[ref] ?? ''
  }

  async set(ref: string, value: string): Promise<void> {
    await this.write(ref, value)
  }

  async delete(ref: string): Promise<void> {
    await this.write(ref, '')
  }
}
