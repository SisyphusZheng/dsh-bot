/**
 * Round-3 G2: the Bot profile's persistent writes must use the same
 * cross-process protocol as the rest of the harness — `withFileLock` around the
 * manifest read-modify-write and `writeFileAtomic` for every replacement.
 *
 * The concurrency and crash cases use REAL child processes (node --import tsx
 * against the source module); a single-process simulation proves nothing about
 * cross-process locking or SIGKILL durability.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BotRuntime } from '../src/bot-runtime.ts'

const ROOT = resolve(process.cwd())
const CHILD = fileURLToPath(new URL('./fixtures/round3-atomic-child.mjs', import.meta.url))
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

/** Run one child against the TypeScript source through tsx. */
/** One child run: the process handle and a promise of its captured output. */
type ChildRun = {
  child: ReturnType<typeof spawn>
  done: Promise<{ code: number | null; stdout: string; stderr: string }>
}

/** Environment for a child: no inherited DSH identity, no shell overrides. */
function childEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => (
    !/^DSH_/.test(key) && key !== 'NODE_OPTIONS' && key !== 'ELECTRON_RUN_AS_NODE'
  )))
}

/** Run one child against the TypeScript source through tsx. */
function spawnChild(args: string[]): ChildRun {
  const env = childEnv()
  const child = spawn(process.execPath, ['--import', 'tsx', CHILD, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveDone) => {
    child.once('exit', code => resolveDone({ code, stdout, stderr }))
  })
  return { child, done }
}

/** Full Bot runtime wiring for one isolated DSH home (fake runtime root + real host-integration bundle). */
function runtimeFixture(prefix: string): { home: string; resources: string; runtimeRoot: string; profile: string } {
  const home = tempDir(prefix)
  const runtimeRoot = tempDir(`${prefix}runtime-`)
  mkdirSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
  writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.js' }))
  writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'index.js'), 'export default {}\n')
  const resources = tempDir(`${prefix}resources-`)
  symlinkSync(resolve('nisse/packages/host-integration'), join(resources, 'host-integration'), 'dir')
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  return { home, resources, runtimeRoot, profile }
}

const OLD_MANAGED_BLOCK = `# >>> whalegirl-bot: managed profile layer >>>
# Regenerated on cold start.
- id: permission
  name: "@deepseek-ai/dsh-permission-presets"
  config:
    presets:
      bot-outside-write:
        sandbox: danger-full-access
        approval: ask
- id: nisse-host-integration
  name: "nisse-host-integration"
  config:
    permissionPreset: bot-outside-write
# <<< whalegirl-bot: managed profile layer <<<`

describe('profile manifest write protocol (real child processes)', () => {
  it('two concurrent processes adding different dependencies never lose an update', async () => {
    for (let round = 0; round < 3; round += 1) {
      const home = tempDir(`r3-lock-${round}-`)
      mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
      const manifestFile = join(home, 'profiles', 'desktop', 'package.json')
      writeFileSync(manifestFile, JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: {} }, null, 2) + '\n')

      const first = spawnChild(['manifest-add', home, 'writer-a', '150'])
      const second = spawnChild(['manifest-add', home, 'writer-b', '150'])
      const [firstResult, secondResult] = await Promise.all([first.done, second.done])
      expect(firstResult.code, firstResult.stderr).toBe(0)
      expect(secondResult.code, secondResult.stderr).toBe(0)
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { dependencies?: Record<string, string> }
      expect(manifest.dependencies?.['writer-a'], `round ${round}`).toBe('1')
      expect(manifest.dependencies?.['writer-b'], `round ${round}`).toBe('1')
    }
  }, 30_000)

  it('prepare() keeps a concurrent writer’s manifest data (locked read-modify-write)', async () => {
    const { home, resources, runtimeRoot, profile } = runtimeFixture('r3-prepare-merge-')
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-desktop', private: true, dependencies: { seed: '1' } }, null, 2) + '\n')
    const prepare = spawnChild(['prepare', home, resources, runtimeRoot])
    const writer = spawnChild(['manifest-add', home, 'concurrent-key', '150'])
    const [prepareResult, writerResult] = await Promise.all([prepare.done, writer.done])
    expect(prepareResult.code, prepareResult.stderr).toBe(0)
    expect(writerResult.code, writerResult.stderr).toBe(0)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.dependencies?.seed).toBe('1')
    expect(manifest.dependencies?.['concurrent-key']).toBe('1')
    expect(manifest.dsh?.profile?.bundles).toEqual(expect.arrayContaining(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'nisse-host-integration']))
  }, 30_000)

  it('SIGKILL during a multi-megabyte replacement leaves the old or the new complete JSON, never a truncated file', async () => {
    const home = tempDir('r3-crash-')
    const file = join(home, 'profiles', 'desktop', 'package.json')
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    const oldContent = JSON.stringify({ name: 'old', private: true, dependencies: {} }, null, 2) + '\n'
    const padBytes = 6 * 1024 * 1024
    const newContent = JSON.stringify({ name: 'new', private: true, dependencies: {}, pad: 'x'.repeat(padBytes) }, null, 2) + '\n'
    let killedMidWrite = 0
    for (let round = 0; round < 8; round += 1) {
      writeFileSync(file, oldContent)
      const { child, done } = spawnChild(['write-json-big', file, String(padBytes)])
      await new Promise(resolveDelay => setTimeout(resolveDelay, 2 + round * 3))
      const exited = child.exitCode !== null
      if (!exited) { killedMidWrite += 1; child.kill('SIGKILL') }
      await done
      const text = readFileSync(file, 'utf8')
      expect(() => JSON.parse(text), `round ${round} must stay valid JSON`).not.toThrow()
      expect([oldContent, newContent].includes(text), `round ${round} must be old-complete or new-complete`).toBe(true)
    }
    // At least some rounds must actually interrupt the process; otherwise the case proves nothing about crashes.
    expect(killedMidWrite).toBeGreaterThan(0)
  }, 60_000)
})

describe('atomic profile replacements', () => {
  it('cordis.patch.yml is never observed partially replaced by a concurrent writer', async () => {
    const home = tempDir('r3-patch-')
    mkdirSync(join(home, 'profiles', 'desktop'), { recursive: true })
    const patchFile = join(home, 'profiles', 'desktop', 'cordis.patch.yml')
    const first = '- id: probe-a\n  value: A\n'
    const second = '- id: probe-b\n  value: B\n'
    writeFileSync(patchFile, first)
    const { done } = spawnChild(['loop-write', patchFile, first, second, '160'])
    let finished = false
    let violations = 0
    let reads = 0
    const completion = done.then((childResult) => { finished = true; return childResult })
    while (!finished) {
      const text = readFileSync(patchFile, 'utf8')
      reads += 1
      if (text !== first && text !== second) violations += 1
      await new Promise(resolveDelay => setTimeout(resolveDelay, 3))
    }
    const result = await completion
    expect(result.code, result.stderr).toBe(0)
    expect(violations, `reads=${reads}`).toBe(0)
    expect([first, second]).toContain(readFileSync(patchFile, 'utf8'))
    expect(reads).toBeGreaterThan(1)
  }, 30_000)

  it('prepare() writes the migration record atomically with 0600 and the correct content', async () => {
    const { home, resources, runtimeRoot, profile } = runtimeFixture('r3-migrate-')
    writeFileSync(join(profile, 'cordis.patch.yml'), `${OLD_MANAGED_BLOCK}\n`)
    const runtime = new BotRuntime(home, resources, undefined, runtimeRoot)
    await runtime.prepare({})
    const migrationFile = join(home, 'bot', 'permission-migration.json')
    expect(existsSync(migrationFile)).toBe(true)
    expect(statSync(migrationFile).mode & 0o777).toBe(0o600)
    const migration = JSON.parse(readFileSync(migrationFile, 'utf8')) as { version: number; from: { sandbox: string }; to: { sandbox: string; approval: string }; notice: string }
    expect(migration.version).toBe(1)
    expect(migration.from.sandbox).toBe('danger-full-access')
    expect(migration.to.sandbox).toBe('workspace-write')
    expect(migration.to.approval).toBe('ask')
    expect(migration.notice).toContain('/permission danger-full-access')
    // The managed patch itself is replaced atomically with owner-only permissions.
    const patchFile = join(profile, 'cordis.patch.yml')
    expect(statSync(patchFile).mode & 0o777).toBe(0o600)
    const patch = readFileSync(patchFile, 'utf8')
    expect(patch).toContain('# >>> whalegirl-bot: managed profile layer >>>')
    expect(patch).toContain('sandbox: workspace-write')
    expect(runtime.status().permissionNotice).not.toBe('')
  }, 30_000)

  it('the Electron main process awaits prepare() before continuing to the Host bridge', () => {
    const main = readFileSync(resolve('apps/desktop/src/main.ts'), 'utf8')
    expect(main).toContain('await botRuntime.prepare(startupConfig)')
    expect(main).not.toMatch(/(?<!await )botRuntime\.prepare\(/)
    const prepareIndex = main.indexOf('await botRuntime.prepare(startupConfig)')
    const bridgeIndex = main.indexOf('const callBridge = async', prepareIndex)
    expect(prepareIndex).toBeGreaterThan(-1)
    expect(bridgeIndex).toBeGreaterThan(prepareIndex)
  })
})
