/**
 * Provider credential storage, reusing DSH's own credential document.
 *
 * DSH stores credentials in `$DSH_HOME/.credentials.yaml` (mode 0600) and relies on
 * the per-user home boundary rather than app-level encryption; there is no second
 * secret store in upstream. WhaleGirl Bot writes the same document, so a key
 * configured in the Bot is visible to DSH (and vice versa) and the product does not
 * invent its own crypto. Writes are atomic (temp + rename, 0600).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import type { SecretAccess } from './bot-settings-model.ts'

const CREDENTIALS_FILE = '.credentials.yaml'

/** Read/write the DSH credentials document used by the bundled runtime. */
export class DshCredentialStore implements SecretAccess {
  constructor(private readonly dshHome: string) {}

  private path(): string {
    return join(this.dshHome, CREDENTIALS_FILE)
  }

  /** Parse the document and return only its `refs` mapping (version/records preserved by write). */
  private document(): Record<string, unknown> {
    let raw: string
    try {
      raw = readFileSync(this.path(), 'utf8')
    } catch (error) {
      // Only a truly absent file is a new profile; never turn I/O errors into an empty store.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, refs: {} }
      throw error
    }
    // YAML parse/type errors must not silently wipe existing credentials on save.
    const parsed = load(raw) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('DSH credentials document must be a YAML mapping')
    }
    const refs = (parsed as Record<string, unknown>).refs
    if (refs !== undefined && (refs === null || typeof refs !== 'object' || Array.isArray(refs))) {
      throw new Error('DSH credentials refs must be a mapping')
    }
    return parsed as Record<string, unknown>
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

  private write(map: Record<string, string>): void {
    const document = this.document()
    document['refs'] = map
    if (typeof document['version'] !== 'number') document['version'] = 1
    mkdirSync(this.dshHome, { recursive: true, mode: 0o700 })
    const temporary = `${this.path()}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, dump(document, { lineWidth: -1 }), { mode: 0o600, flag: 'wx' })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.path())
    } finally {
      try { rmSync(temporary, { force: true }) } catch { /* best-effort cleanup */ }
    }
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

  set(ref: string, value: string): void {
    const map = this.read()
    if (value === '') Reflect.deleteProperty(map, ref)
    else map[ref] = value
    this.write(map)
  }

  delete(ref: string): void {
    const map = this.read()
    Reflect.deleteProperty(map, ref)
    this.write(map)
  }
}
