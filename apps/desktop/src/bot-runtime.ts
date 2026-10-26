/**
 * Prepares the Bot's DSH profile layer and reports whether the bundled voice
 * worker is present. The main Electron process owns the Pipecat worker and pet window;
 * no legacy gateway or nested Electron process is used.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

/** What the shell can truthfully report about the voice runtime. */
export interface BotRuntimeStatus {
  /** True when the packaged Pipecat worker bundle is present. */
  voiceAvailable: boolean
  /** Directory holding the bundled voice worker (diagnostics only). */
  workerDir: string
  error: string
}

/** The subset of the Bot settings document the shell runtime owns. All fields are optional in storage. */
export interface BotRuntimeConfig {
  voice?: { provider?: string; baseUrl?: string; apiKey?: string; model?: string; voice?: string; wakeWord?: string }
  llm?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }
  memory?: { enabled?: boolean }
  approval?: { mode?: string; onceMinutes?: number }
  behavior?: { pauseOnInput?: boolean; allowScreenView?: boolean }
  persona?: {
    name?: string
    personality?: string
    tone?: string
    promptOverride?: string
    background?: string
    quirks?: string
    addressUser?: string
    boundaries?: string
    instructions?: string
  }
}

/** Loopback memory adapter endpoints published to the Host Integration profile layer. */
export interface BotMemoryInfo {
  url: string
  token: string
}

/** Environment variable a custom OpenAI-compatible route reads its key from. */
const CUSTOM_LLM_KEY_ENV = 'WHALEGIRL_LLM_API_KEY'

/** Begin marker of the profile layer this shell owns; the rest of the patch stays user-authored. */
const MANAGED_BEGIN = '# >>> whalegirl-bot: managed profile layer >>>'
/** End marker of the profile layer this shell owns. */
const MANAGED_END = '# <<< whalegirl-bot: managed profile layer <<<'

const DEFAULT_LLM = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }

/**
 * The managed profile patch block: the Bot session's permission boundary, LLM
 * default model, and the first-party Host Integration entry. Everything the
 * user configures elsewhere in the DSH profile is preserved because only this
 * marked block is regenerated.
 */
function managedPatch(
  config: BotRuntimeConfig,
  dshHome: string,
  hasUserLlmConfig: boolean,
  memory: BotMemoryInfo | null,
): string {
  const provider = String(config.llm?.provider || DEFAULT_LLM.provider).trim() || DEFAULT_LLM.provider
  const model = String(config.llm?.model || DEFAULT_LLM.model).trim() || DEFAULT_LLM.model
  const workspace = join(dshHome, 'workspace')
  const lines = [
    MANAGED_BEGIN,
    '# Regenerated on cold start; live settings use the authenticated bridge. Do not edit by hand.',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '      bot-outside-write:',
    '        sandbox: danger-full-access',
    '        approval: ask',
    '        name: Bot（审批制）',
    '        description: Bot 可操作整个电脑；工作区外写操作在桌宠气泡里逐次审批。',
    '- id: nisse-host-integration',
    '  name: "nisse-host-integration"',
    '  config:',
    `    ipcDir: ${JSON.stringify(join(dshHome, 'bot'))}`,
    `    workspaceDir: ${JSON.stringify(workspace)}`,
    '    permissionPreset: bot-outside-write',
    ...(memory === null ? [] : [
      `    memoryUrl: ${JSON.stringify(memory.url)}`,
      `    memoryToken: ${JSON.stringify(memory.token)}`,
    ]),
  ]
  if (!hasUserLlmConfig) {
    const keyEnv = CUSTOM_LLM_KEY_ENV
    lines.push(
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      `      ${JSON.stringify(provider)}:`,
      `        apiKeyEnv: ${JSON.stringify(keyEnv)}`,
      ...(config.llm?.baseUrl ? [`        baseURL: ${JSON.stringify(String(config.llm.baseUrl))}`] : []),
      ...(['custom', 'dashscope'].includes(provider) ? [
        '        api: openai-completions', '        models:',
        `          - id: ${JSON.stringify(model)}`, '            contextWindow: 32768', '            maxTokens: 4096',
      ] : []),
    )
  }
  lines.push(MANAGED_END)
  return lines.join('\n') + '\n'
}

/** Replace one marked block in a patch file, preserving every line the shell does not own. */
function rewriteManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(MANAGED_BEGIN)
  const end = existing.indexOf(MANAGED_END)
  let rest: string
  if (begin >= 0 && end > begin) {
    rest = existing.slice(0, begin) + existing.slice(end + MANAGED_END.length)
  } else {
    rest = existing
  }
  rest = rest.replace(/^\n+/, '').replace(/\n+$/, '')
  const separator = rest.length > 0 ? '\n' : ''
  return `${block}${separator}${rest}${rest.length > 0 ? '\n' : ''}`
}

/** Publish the LLM key the profile's route references into the Host child environment. */
function applyLlmEnvironment(config: BotRuntimeConfig): string | null {
  const key = String(config.llm?.apiKey || '').trim()
  if (!key) return null
  const envName = CUSTOM_LLM_KEY_ENV
  process.env[envName] = key
  return envName
}

export class BotRuntime {
  private memory: BotMemoryInfo | null = null
  private lastError = ''
  private managedKey: string | null = null
  private readonly inheritedKeys = { ...process.env }

  constructor(
    private readonly dshHome: string,
    private readonly resourcesPath = process.resourcesPath,
    /** Reads provider keys from the DSH credentials document; keys never live in config.json. */
    private readonly secretReader: { get: (ref: string) => string } | undefined = undefined,
    private readonly runtimeRoot = join(resourcesPath, 'app.asar', 'dsh'),
  ) {}

  /**
   * Publish the built-in memory adapter endpoints so the managed profile layer
   * configures the Host Integration for long-term memory.
   * @param memory - loopback URL/token, or null to keep memory off.
   */
  setMemory(memory: BotMemoryInfo | null): void {
    this.memory = memory
  }

  /** Read the persisted Bot settings without creating or defaulting the file. */
  readConfig(): BotRuntimeConfig {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dshHome, 'bot', 'config.json'), 'utf8')) as BotRuntimeConfig
      if (parsed === null || typeof parsed !== 'object') return {}
      if (this.secretReader !== undefined) {
        const voiceKey = this.secretReader.get('WHALEGIRL_DASHSCOPE_API_KEY')
        const llmKey = this.secretReader.get('WHALEGIRL_LLM_API_KEY')
        if ((parsed.voice?.apiKey ?? '') === '' && voiceKey !== '') parsed.voice = { ...(parsed.voice ?? {}), apiKey: voiceKey }
        if ((parsed.llm?.apiKey ?? '') === '' && llmKey !== '') parsed.llm = { ...(parsed.llm ?? {}), apiKey: llmKey }
      }
      return parsed
    } catch { return {} }
  }

  /**
   * Install the first-party Host Integration bundle and the managed profile
   * layer into the desktop DSH profile. Idempotent: it regenerates only the
   * marked block and leaves user-authored patch entries untouched.
   * @param config - Bot settings to publish; omitted reads the persisted file.
   */
  prepare(config: BotRuntimeConfig = this.readConfig()): void {
    this.lastError = ''
    let llm: string
    try {
      llm = createRequire(join(this.runtimeRoot, 'package.json')).resolve('@deepseek-ai/dsh-llm')
      if (!existsSync(llm)) throw new Error(`compiled LLM entry missing: ${llm}`)
    } catch (error) { this.lastError = `DSH runtime preflight: ${String(error)}`; return }
    mkdirSync(this.dshHome, { recursive: true, mode: 0o700 })
    chmodSync(this.dshHome, 0o700)
    const profile = join(this.dshHome, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })
    const bundle = process.env.WHALEGIRL_HOST_INTEGRATION_DIR || join(this.resourcesPath, 'host-integration')
    if (!existsSync(bundle)) { this.lastError = 'host-integration bundle missing'; return }
    const link = join(modules, 'nisse-host-integration')
    try { rmSync(link, { recursive: true, force: true }) } catch {}
    try { symlinkSync(bundle, link, 'dir') } catch (error) { this.lastError = String((error as Error)?.message || error) }
    let manifest: Record<string, unknown> = { name: 'dsh-profile-desktop', private: true, dependencies: {} }
    try { manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) } catch {}
    const dsh = (manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh as Record<string, unknown> : {})
    const profileConfig = (dsh.profile && typeof dsh.profile === 'object' ? dsh.profile as Record<string, unknown> : {})
    const bundles = Array.isArray(profileConfig.bundles) ? profileConfig.bundles.map(String).filter(name => name !== 'whalegirl-g2-bridge') : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'nisse-host-integration']) if (!bundles.includes(name)) bundles.push(name)
    profileConfig.bundles = bundles; dsh.profile = profileConfig; manifest.dsh = dsh
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    process.env.DSH_BOT_RUNTIME_ROOT = this.runtimeRoot
    process.env.NISSE_DSH_LLM_ENTRY = llm
    if (this.managedKey !== null) {
      const inherited = this.inheritedKeys[this.managedKey]
      if (inherited === undefined) Reflect.deleteProperty(process.env, this.managedKey)
      else process.env[this.managedKey] = inherited
    }
    this.managedKey = applyLlmEnvironment(config)
    const patchFile = join(profile, 'cordis.patch.yml')
    let existingPatch = ''
    try { existingPatch = readFileSync(patchFile, 'utf8') } catch {}
    const userPart = existingPatch
      .replace(new RegExp(`${MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '')
    const hasUserLlmConfig = /(^|\n)\s*-?\s*id:\s*llm-pi-ai\b/.test(userPart)
    const block = managedPatch(config, this.dshHome, hasUserLlmConfig, this.memory)
    writeFileSync(patchFile, rewriteManagedBlock(existingPatch, block), { mode: 0o600 })
    chmodSync(patchFile, 0o600)
  }

  status(): BotRuntimeStatus {
    const workerDir = join(this.resourcesPath, 'voice-worker')
    const voiceAvailable = existsSync(join(workerDir, 'VoiceWorker'))
    return { voiceAvailable, workerDir, error: this.lastError }
  }
}
