import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migratePlaintextSecrets,
  readBotConfigFile,
  writeBotConfigFile,
  type BotConfig,
  type SecretAccess,
} from '../src/bot-settings-model.ts'

class FakeSecrets implements SecretAccess {
  readonly values = new Map<string, string>()
  availableValue = true
  breakReadBack = false
  /** Optional hook run before the first store call, to interleave another writer. */
  onSet: (() => void) | null = null
  private firstSet = true

  available(): boolean {
    return this.availableValue
  }

  has(ref: string): boolean {
    return this.values.has(ref)
  }

  get(ref: string): string {
    if (this.breakReadBack) return 'corrupted'
    return this.values.get(ref) ?? ''
  }

  async set(ref: string, value: string): Promise<void> {
    if (this.firstSet) { this.firstSet = false; this.onSet?.() }
    this.values.set(ref, value)
  }

  async delete(ref: string): Promise<void> {
    this.values.delete(ref)
  }
}

const dirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wg-bot-secrets-'))
  dirs.push(dir)
  return dir
}

function configWithKeys(): BotConfig {
  return {
    voice: { provider: 'dashscope', baseUrl: '', apiKey: 'voice-secret', model: 'm', voice: 'v', wakeWord: '' },
    llm: { provider: 'opencode-go', model: 'm', baseUrl: '', apiKey: 'llm-secret' },
  } as BotConfig
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Bot provider key storage', () => {
  it('writes provider keys to the secret store, never to config.json', async () => {
    const dir = makeDir()
    const secrets = new FakeSecrets()
    const stored = await writeBotConfigFile(dir, configWithKeys(), secrets)

    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as BotConfig
    expect(onDisk.voice.apiKey).toBe('')
    expect(onDisk.llm.apiKey).toBe('')
    expect(secrets.values.get('WHALEGIRL_DASHSCOPE_API_KEY')).toBe('voice-secret')
    expect(secrets.values.get('WHALEGIRL_LLM_API_KEY')).toBe('llm-secret')
    expect(stored.voice.apiKey).toBe('voice-secret')
    expect(stored.llm.apiKey).toBe('llm-secret')

    const readBack = await readBotConfigFile(dir, secrets)
    expect(readBack.voice.apiKey).toBe('voice-secret')
    expect(readBack.llm.apiKey).toBe('llm-secret')
  })

  it('refuses to persist a new key as plaintext when the store is unavailable', async () => {
    const dir = makeDir()
    const secrets = new FakeSecrets()
    secrets.availableValue = false
    await expect(writeBotConfigFile(dir, configWithKeys(), secrets)).rejects.toThrow('SECRET_STORE_UNAVAILABLE')
  })

  it('migrates legacy plaintext keys: store -> read-back -> atomic rewrite', async () => {
    const dir = makeDir()
    const legacy = configWithKeys()
    writeFileSync(join(dir, 'config.json'), JSON.stringify(legacy, null, 2) + '\n')

    const secrets = new FakeSecrets()
    const result = await migratePlaintextSecrets(dir, secrets)
    expect(result.migrated.sort()).toEqual(['WHALEGIRL_DASHSCOPE_API_KEY', 'WHALEGIRL_LLM_API_KEY'])
    expect(result.failed).toEqual([])
    expect(secrets.values.get('WHALEGIRL_DASHSCOPE_API_KEY')).toBe('voice-secret')

    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as BotConfig
    expect(onDisk.voice.apiKey).toBe('')
    expect(onDisk.llm.apiKey).toBe('')
  })

  it('keeps a key a concurrent save wrote while the migration ran', async () => {
    const dir = makeDir()
    const file = join(dir, 'config.json')
    // Start from a legacy document that still holds one plaintext key.
    writeFileSync(file, JSON.stringify({ voice: { apiKey: 'voice-secret' } }, null, 2) + '\n')
    const secrets = new FakeSecrets()
    // The save lands after the migration read the document and while it is
    // storing credentials. The new key must survive: a migration may only clear
    // the exact plaintext value it moved, never a value it has not seen.
    let saved = false
    secrets.onSet = () => {
      if (saved) return
      saved = true
      writeFileSync(file, JSON.stringify({
        voice: { apiKey: 'voice-secret' },
        llm: { apiKey: 'newly-saved-key' },
      }, null, 2) + '\n')
    }
    const result = await migratePlaintextSecrets(dir, secrets)
    expect(saved).toBe(true)
    expect(result.migrated).toEqual(['WHALEGIRL_DASHSCOPE_API_KEY'])
    expect(result.failed).toEqual([])
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as BotConfig
    expect(onDisk.voice.apiKey).toBe('')
    expect(onDisk.llm.apiKey).toBe('newly-saved-key')
  })

  it('leaves the legacy file untouched when read-back verification fails', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'config.json'), JSON.stringify(configWithKeys(), null, 2) + '\n')
    const secrets = new FakeSecrets()
    secrets.breakReadBack = true

    const result = await migratePlaintextSecrets(dir, secrets)
    expect(result.migrated).toEqual([])
    expect(result.failed.sort()).toEqual(['WHALEGIRL_DASHSCOPE_API_KEY', 'WHALEGIRL_LLM_API_KEY'])
    const onDisk = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) as BotConfig
    expect(onDisk.voice.apiKey).toBe('voice-secret')
  })
})
