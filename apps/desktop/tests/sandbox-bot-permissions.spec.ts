/**
 * S1 product permission promise: the managed DSH profile the Bot runs under.
 *
 * The Bot default must be `workspace-write` + per-action approval, with
 * `danger-full-access` available only as a deliberate, truthfully labelled
 * user choice. A pre-0.0.1 profile that still granted full access must be
 * narrowed with a one-time, recoverable notice (never silently widened), and
 * the generated patch must keep the user's own patch entries untouched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BotRuntime,
  PERMISSION_DOWNGRADE_NOTICE,
  legacyFullAccessManagedBlock,
  managedProfilePatch,
} from '../src/bot-runtime.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

/** The preset entry generated for `key`, as `[sandbox, approval]` plus the raw lines. */
function presetBlock(patch: string, key: string): string[] {
  const lines = patch.split('\n')
  const start = lines.findIndex(line => line.trim() === `${key}:`)
  expect(start, `preset ${key} is generated`).toBeGreaterThan(-1)
  const startLine = lines[start]
  if (startLine === undefined) return []
  const indent = startLine.length - startLine.trimStart().length
  const block: string[] = []
  for (let at = start + 1; at < lines.length; at += 1) {
    const line = lines[at]
    if (line === undefined) break
    if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break
    block.push(line)
  }
  return block
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
        name: Bot（审批制）
        description: Bot 可操作整个电脑；工作区外写操作在桌宠气泡里逐次审批。
- id: nisse-host-integration
  name: "nisse-host-integration"
  config:
    permissionPreset: bot-outside-write
# <<< whalegirl-bot: managed profile layer <<<`

describe('managed profile patch', () => {
  it('defaults the Bot bundle to workspace-write + ask and never claims full-computer access', () => {
    const patch = managedProfilePatch({}, '/home/bot-home', false, null)
    const botBundle = presetBlock(patch, 'bot-outside-write')
    expect(botBundle.some(line => /sandbox:\s*workspace-write/.test(line))).toBe(true)
    expect(botBundle.some(line => /approval:\s*ask/.test(line))).toBe(true)
    expect(botBundle.some(line => /danger-full-access/.test(line))).toBe(false)
    expect(patch).not.toContain('整个电脑')
    expect(patch).not.toContain('Bot 可操作整个电脑')
    expect(patch).toContain('permissionPreset: bot-outside-write')
  })

  it('keeps danger-full-access as an explicitly labelled, non-default option', () => {
    const patch = managedProfilePatch({}, '/home/bot-home', false, null)
    const full = presetBlock(patch, 'danger-full-access')
    expect(full.some(line => /sandbox:\s*danger-full-access/.test(line))).toBe(true)
    expect(full.some(line => /高风险/.test(line))).toBe(true)
    expect(full.some(line => /不推荐/.test(line))).toBe(true)
    expect(full.some(line => /最高风险/.test(line))).toBe(true)
    expect(full.some(line => /仅在你完全信任 Bot/.test(line))).toBe(true)
    // No composition default points at the full-access preset.
    expect(patch).not.toMatch(/defaultPreset:\s*danger-full-access/)
    expect(patch).toMatch(/permissionPreset:\s*bot-outside-write/)
  })

  it('generates valid, JSON-quoted presentation strings for the preset table', () => {
    const patch = managedProfilePatch({}, '/home/bot-home', false, null)
    for (const line of patch.split('\n').filter(item => /^\s+(name|description):/.test(item))) {
      const value = line.slice(line.indexOf(':') + 1).trim()
      expect(value.startsWith('"') && value.endsWith('"'), line).toBe(true)
      expect(() => JSON.parse(value)).not.toThrow()
    }
  })

  it('keeps the user-authored patch entries when the managed block is regenerated', () => {
    const home = tempDir('s1-bot-runtime-')
    const runtimeRoot = tempDir('s1-bot-runtime-root-')
    mkdirSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
    writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.js' }))
    writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'index.js'), 'export default {}\n')
    const resources = tempDir('s1-bot-resources-')
    symlinkSync(resolve('nisse/packages/host-integration'), join(resources, 'host-integration'), 'dir')
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), `${OLD_MANAGED_BLOCK}\n- id: user-entry\n  name: "@example/user-entry"\n`)

    const runtime = new BotRuntime(home, resources, undefined, runtimeRoot)
    runtime.prepare({})
    const patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('- id: user-entry')
    expect(patch).toContain('@example/user-entry')
    expect(presetBlock(patch, 'bot-outside-write').some(line => /sandbox:\s*workspace-write/.test(line))).toBe(true)
    expect(patch).not.toContain('Bot 可操作整个电脑')
  })
})

describe('legacy full-access managed profile migration', () => {
  it('detects the pre-0.0.1 bundle inside the managed block only', () => {
    expect(legacyFullAccessManagedBlock(OLD_MANAGED_BLOCK)).toBe(true)
    const newPatch = managedProfilePatch({}, '/home/bot-home', false, null)
    expect(legacyFullAccessManagedBlock(newPatch)).toBe(false)
    expect(legacyFullAccessManagedBlock('- id: unrelated\n')).toBe(false)
    // A user-authored duplicate outside the managed markers is NOT treated as the
    // managed bundle (the shell refuses to edit user-authored entries); reported as a risk instead.
    const userAuthored = '- id: permission\n  config:\n    presets:\n      bot-outside-write:\n        sandbox: danger-full-access\n'
    expect(legacyFullAccessManagedBlock(userAuthored)).toBe(false)
  })

  it('narrows a pre-0.0.1 profile with a durable notice and a recoverable instruction', () => {
    const home = tempDir('s1-bot-migrate-')
    const runtimeRoot = tempDir('s1-bot-migrate-root-')
    mkdirSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm'), { recursive: true })
    writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-llm', main: 'index.js' }))
    writeFileSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-llm', 'index.js'), 'export default {}\n')
    const resources = tempDir('s1-bot-migrate-resources-')
    symlinkSync(resolve('nisse/packages/host-integration'), join(resources, 'host-integration'), 'dir')
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'cordis.patch.yml'), `${OLD_MANAGED_BLOCK}\n`)

    const runtime = new BotRuntime(home, resources, undefined, runtimeRoot)
    runtime.prepare({})
    expect(runtime.status().permissionNotice).toBe(PERMISSION_DOWNGRADE_NOTICE)
    const migrationFile = join(home, 'bot', 'permission-migration.json')
    expect(existsSync(migrationFile)).toBe(true)
    const migration = JSON.parse(readFileSync(migrationFile, 'utf8'))
    expect(migration.from).toEqual({ preset: 'bot-outside-write', sandbox: 'danger-full-access' })
    expect(migration.to).toEqual({ preset: 'bot-outside-write', sandbox: 'workspace-write', approval: 'ask' })
    expect(String(migration.notice)).toContain('/permission danger-full-access')
    expect(PERMISSION_DOWNGRADE_NOTICE).toMatch(/收紧/)
    expect(PERMISSION_DOWNGRADE_NOTICE).toMatch(/\/permission danger-full-access/)

    // The narrowing is recorded once; a relaunch of the already-migrated profile has no notice.
    runtime.prepare({})
    expect(runtime.status().permissionNotice).toBe('')
    expect(readFileSync(migrationFile, 'utf8')).toContain('workspace-write')
  })
})
