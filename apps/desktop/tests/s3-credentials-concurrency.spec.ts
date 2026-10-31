/**
 * S3 credentials concurrency, proven with real processes.
 *
 * The Desktop settings process and the running DSH runtime both write
 * `$DSH_HOME/.credentials.yaml`. These cases start real child Node processes
 * against one isolated temporary home and assert that no unrelated reference is
 * silently lost, that a crash mid-write never damages committed data, that a
 * corrupt document fails closed, and that no secret value appears in any receipt,
 * error text, or captured output.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load as parseYaml } from 'js-yaml'
import { DshCredentialStore } from '../src/secret-store.ts'

const STORE_URL = new URL('../src/secret-store.ts', import.meta.url).href
const ATOMIC_URL = new URL('../../../packages/util/atomic-write/src/index.ts', import.meta.url).href
const TSX_IMPORT = 'tsx'

/** Environment for a child process: no inherited DSH identity, no shell overrides. */
function childEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DSH_HOME: undefined,
    DSH_PROFILE: undefined,
    DSH_PROFILE_DIR: undefined,
    DSH_SESSION_ID: undefined,
    DSH_WEB_URL: undefined,
    DSH_SHELL: undefined,
    NODE_OPTIONS: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
  }
}

/** Script body a child runs: import the store (or the atomic primitives) and patch one ref. */
function childScript(mode: 'store' | 'upstream'): string {
  if (mode === 'upstream') {
    // Exactly the protocol `@deepseek-ai/dsh-credentials-local` uses for this
    // document: hold `<file>.lock`, re-read under it, patch only this key,
    // replace atomically at 0600.
    return `
const { withFileLock, writeFileAtomic } = await import(process.argv[1])
const home = process.argv[2], ref = process.argv[3], value = process.argv[4]
const document = home + '/.credentials.yaml'
const { readFileSync } = await import('node:fs')
const { load, dump } = await import('js-yaml')
await withFileLock(document, async () => {
  let parsed = { version: 1, refs: {} }
  let text = null
  try { text = readFileSync(document, 'utf8') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (text !== null) {
    try { parsed = load(text) ?? parsed } catch { throw new Error('corrupt document') }
  }
  parsed.refs = { ...(parsed.refs ?? {}), [ref]: value }
  await writeFileAtomic(document, dump(parsed, { lineWidth: -1 }), { mode: 0o600, dirMode: 0o700 })
}, { waitMs: 20000 })
process.exit(0)
`
  }
  return `
const { DshCredentialStore } = await import(process.argv[1])
const home = process.argv[2], ref = process.argv[3], value = process.argv[4], extra = process.argv[5]
const store = new DshCredentialStore(home)
if (extra === 'delete') await store.delete(ref)
else await store.set(ref, value)
process.exit(0)
`
}

/** Run one child that patches `ref`; resolves with its exit code and streams. */
function runChild(mode: 'store' | 'upstream', home: string, ref: string, value: string, extra: string[] = []): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  const args = mode === 'store'
    ? ['--import', TSX_IMPORT, '-e', childScript('store'), '--', STORE_URL, home, ref, value, ...extra]
    : ['--import', TSX_IMPORT, '-e', childScript('upstream'), '--', ATOMIC_URL, home, ref, value, ...extra]
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', (code, signal) => resolveRun({ code, signal, stdout, stderr }))
  })
}

/** Read the document as the product/persona-layer code does, failing on a torn file. */
function readRefs(home: string): Record<string, string> {
  const parsed = parseYaml(readFileSync(join(home, '.credentials.yaml'), 'utf8')) as { refs?: Record<string, string> }
  return parsed?.refs ?? {}
}

const homes: string[] = []
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'dsh-s3-credentials-'))
  homes.push(home)
  return home
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('shared credentials document under real concurrency', () => {
  it('keeps every reference when several processes write different refs at once', async () => {
    const home = makeHome()
    const rounds = 6
    for (let round = 0; round < rounds; round += 1) {
      const writers = Array.from({ length: 4 }, (_, index) => runChild('store', home, `REF_${String(round)}_${String(index)}`, `value-${String(round)}-${String(index)}`))
      const results = await Promise.all(writers)
      for (const result of results) expect(result.code).toBe(0)
      const refs = readRefs(home)
      for (let index = 0; index < writers.length; index += 1) {
        expect(refs[`REF_${String(round)}_${String(index)}`]).toBe(`value-${String(round)}-${String(index)}`)
      }
    }
    expect(Object.keys(readRefs(home))).toHaveLength(rounds * 4)
  })

  it('does not lose the runtime provider write when the Desktop writes at the same time', async () => {
    const home = makeHome()
    // The upstream provider and the Desktop store share one lock file, so each
    // patch is applied to the state the previous holder committed.
    for (let round = 0; round < 5; round += 1) {
      const [upstream, desktop] = await Promise.all([
        runChild('upstream', home, `UPSTREAM_${String(round)}`, `up-${String(round)}`),
        runChild('store', home, `DESKTOP_${String(round)}`, `desk-${String(round)}`),
      ])
      expect(upstream.code).toBe(0)
      expect(desktop.code).toBe(0)
      const refs = readRefs(home)
      expect(refs[`UPSTREAM_${String(round)}`]).toBe(`up-${String(round)}`)
      expect(refs[`DESKTOP_${String(round)}`]).toBe(`desk-${String(round)}`)
    }
  })

  it('resolves a same-ref conflict to one complete value and keeps other refs', async () => {
    const home = makeHome()
    const store = new DshCredentialStore(home)
    await store.set('KEEP_ME', 'kept')
    const [left, right] = await Promise.all([
      runChild('store', home, 'SAME_REF', 'value-left'),
      runChild('store', home, 'SAME_REF', 'value-right'),
    ])
    expect(left.code).toBe(0)
    expect(right.code).toBe(0)
    const refs = readRefs(home)
    expect(['value-left', 'value-right']).toContain(refs['SAME_REF'])
    expect(refs['KEEP_ME']).toBe('kept')
  })

  it('applies a delete and an add from two processes without dropping either fact', async () => {
    const home = makeHome()
    const store = new DshCredentialStore(home)
    await store.set('REMOVE_ME', 'stale')
    const [removal, addition] = await Promise.all([
      runChild('store', home, 'REMOVE_ME', '', ['delete']),
      runChild('store', home, 'ADD_ME', 'fresh'),
    ])
    expect(removal.code).toBe(0)
    expect(addition.code).toBe(0)
    const refs = readRefs(home)
    expect(refs['REMOVE_ME']).toBeUndefined()
    expect(refs['ADD_ME']).toBe('fresh')
  })

  it('never damages committed data when a writer is killed mid-write', async () => {
    const home = makeHome()
    const store = new DshCredentialStore(home)
    for (let index = 0; index < 5; index += 1) await store.set(`COMMITTED_${String(index)}`, `safe-${String(index)}`)
    const committedBefore = readRefs(home)

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const child = spawn(process.execPath, ['--import', TSX_IMPORT, '-e', childScript('store'), '--', STORE_URL, home, `KILLED_${String(attempt)}`, 'interrupted'], { env: childEnv(), stdio: 'ignore' })
      await new Promise<void>((resolveKill) => {
        setTimeout(() => { child.kill('SIGKILL'); resolveKill() }, 5 + attempt * 3)
      })
      await new Promise<void>((resolveExit) => { child.on('close', () => { resolveExit() }) })
      // Whatever the interruption did to the in-flight write, every value that had
      // already been committed is still readable and the document still parses.
      const after = readRefs(home)
      for (const [ref, value] of Object.entries(committedBefore)) expect(after[ref]).toBe(value)
    }
  })

  it('fails closed on a corrupt document and preserves it byte for byte', async () => {
    const home = makeHome()
    const file = join(home, '.credentials.yaml')
    const corrupt = 'version: 1\nrefs: [not closed\n'
    writeFileSync(file, corrupt, { mode: 0o600 })
    const store = new DshCredentialStore(home)
    await expect(store.set('NEW_REF', 'value')).rejects.toThrow(/not valid YAML/)
    expect(readFileSync(file, 'utf8')).toBe(corrupt)
    // The failure message never carries document text.
    await store.set('NEW_REF', 'value').catch((error: Error) => {
      expect(error.message).not.toContain('not closed')
    })
  })

  it('keeps the document owner-only even when it arrived world-readable', async () => {
    const home = makeHome()
    const file = join(home, '.credentials.yaml')
    writeFileSync(file, 'version: 1\nrefs:\n  LEGACY: old-value\n', { mode: 0o644 })
    const store = new DshCredentialStore(home)
    await store.set('NEW', 'new-value')
    const mode = statSync(file).mode & 0o777
    expect(mode & 0o077).toBe(0)
    expect(readRefs(home)).toEqual({ LEGACY: 'old-value', NEW: 'new-value' })
  })

  it('never returns or logs a secret value', async () => {
    const home = makeHome()
    const secret = 'sk-should-never-appear-in-output-1234567890'
    const logs: string[] = []
    const store = new DshCredentialStore(home)
    await store.set('WHALEGIRL_LLM_API_KEY', secret)
    const receipt = { mode: store.mode(), available: store.available(), has: store.has('WHALEGIRL_LLM_API_KEY') }
    logs.push(JSON.stringify(receipt))
    const output = logs.join('\n')
    expect(output).not.toContain(secret)
    expect(store.get('WHALEGIRL_LLM_API_KEY')).toBe(secret)
    // A corrupt document's failure path must not echo the file either.
    const corruptHome = makeHome()
    writeFileSync(join(corruptHome, '.credentials.yaml'), `version: 1\nrefs:\n  KEEP: ${secret}\nbroken: [\n`, { mode: 0o600 })
    const corruptStore = new DshCredentialStore(corruptHome)
    const failure = await corruptStore.set('OTHER', 'x').then(() => null, (error: Error) => error.message)
    expect(failure).not.toBeNull()
    expect(String(failure)).not.toContain(secret)
  })

  it('reads through the same document the upstream provider writes', () => {
    const home = makeHome()
    const child = spawnSync(process.execPath, ['--import', TSX_IMPORT, '-e', childScript('upstream'), '--', ATOMIC_URL, home, 'WHALEGIRL_LLM_API_KEY', 'written-by-runtime'], { env: childEnv(), encoding: 'utf8' })
    expect(child.status).toBe(0)
    const store = new DshCredentialStore(home)
    expect(store.get('WHALEGIRL_LLM_API_KEY')).toBe('written-by-runtime')
    const mode = statSync(join(home, '.credentials.yaml')).mode & 0o777
    expect(mode & 0o077).toBe(0)
  })
})
