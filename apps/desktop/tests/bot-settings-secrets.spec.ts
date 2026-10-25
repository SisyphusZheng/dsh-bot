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

  set(ref: string, value: string): void {
    this.values.set(ref, value)
  }

  delete(ref: string): void {
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
