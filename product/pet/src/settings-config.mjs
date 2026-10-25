import { parseEnv } from 'node:util'
import { isAbsolute } from 'node:path'
import {
  backendDefinition,
  normalizeBackendProtocol,
  resolveBackendOwnership,
} from '../../shared/backend/catalog.mjs'
import {
  normalizeOrbSkinId,
  resolveOrbSkinId,
} from '../../shared/orb-skin-catalog.mjs'
import {
  normalizeRealtimeProvider,
  assertRealtimeFrontendModel,
  resolveRealtimeFrontendConfiguration,
} from '../../shared/realtime-provider-catalog.mjs'
import {
  REALTIME_PROVIDERS, REALTIME_SETTING_FIELDS,
  migrateRealtimeFileEnvironment, realtimeRuntimeEnvironment, realtimeSettingsValues, realtimeSettingsFromEnvironment, mergeRealtimeEnvironment,
} from '../../shared/realtime-provider-definitions.mjs'
import { normalizeDesktopLanguage } from './i18n.mjs'
import {
  DEFAULT_WAKE_WORD_PHRASE,
  sanitizeWakeWordPhrase,
  validateWakeWordPhrase,
} from './wake-word/keyword-phrase.mjs'

// Seeded from config/frontend-agent/ASSISTANT.md semantics. The client owns the
// editable copy (persona/ASSISTANT.md in the desktop data directory); these
// values are only the first-run defaults and what "恢复默认角色" restores.
export const DEFAULT_PERSONA = Object.freeze({
  name: 'Nisse（家灵）',
  personality: '自然、可靠、有一点鲸鱼娘的温柔与俏皮，但不过度卖萌；有自己的判断，不刻意迎合；做事时干脆，回答时先说重点。',
  tone: '中文口语，简洁自然；适合听觉，不堆格式；复杂内容先给结论再解释。',
  instructions: '所有实质性回答都来自后台 DSH 的结果，你不凭自身知识补充。',
})

export const NISSE_REASONING_EFFORTS = Object.freeze(['', 'low', 'high', 'max'])

export function normalizeNisseReasoningEffort(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return NISSE_REASONING_EFFORTS.includes(text) ? text : ''
}

function cleanPersonaText(value, fallback, maxChars) {
  const text = [...String(value ?? '').replace(/\s+/gu, ' ').trim()]
    .slice(0, maxChars)
    .join('')
  return text || fallback
}

function cleanDefaultWorkspace(value, fallback = '') {
  const text = [...String(value ?? '').replaceAll('\0', '').trim()]
    .slice(0, 1024)
    .join('')
  if (!text) return ''
  // A relative workspace would resolve differently in the DSH host process.
  if (!isAbsolute(text)) return fallback
  return text
}

function cleanDefaultSessionId(value, fallback = '') {
  const text = [...String(value ?? '').replace(/[\r\n\0]/g, '').trim()]
    .slice(0, 200)
    .join('')
  if (!text) return ''
  // DSH session ids are opaque but single-line tokens; anything else is a paste
  // accident and must not reach the plugin config.
  if (!/^[A-Za-z0-9._:/@-]+$/.test(text)) return fallback
  return text
}

const DEFAULTS = {
  gatewayUrl: 'http://127.0.0.1:3101',
  orbStyle: 'fluid',
  orbSkin: 'whale-girl',
  autoHideSeconds: 0,
  wakeShortcut: 'CommandOrControl+Shift+Space',
  wakeWordEnabled: false,
  // 本地唤醒词短语（Nisse 默认「大肥鱼」），写入 keywords.txt 由桌面端生成。
  wakeWordPhrase: DEFAULT_WAKE_WORD_PHRASE,
  ...realtimeSettingsValues(),
  agentProtocol: 'none',
  backendModel: '',
  backendOwnership: 'owned',
  backendUrl: '',
  backendCredential: '',
  nodePath: '',
  language: 'zh',
  // Nisse client configuration. The first four are pushed to the dsh-nisse
  // plugin (default workspace/session, persona); nisseReasoningEffort is
  // Nisse's own thinking level and is never inherited from DSH.
  defaultWorkspace: '',
  defaultSessionId: '',
  personaName: DEFAULT_PERSONA.name,
  personaPersonality: DEFAULT_PERSONA.personality,
  personaTone: DEFAULT_PERSONA.tone,
  personaInstructions: DEFAULT_PERSONA.instructions,
  nisseReasoningEffort: '',
}

const CLIENT_SETTING_KEYS = {
  gatewayUrl: 'QWEN_AUDIO_AGENT_URL',
  orbStyle: 'QWEN_AUDIO_ORB_STYLE',
  orbSkin: 'QWEN_AUDIO_ORB_SKIN',
  autoHideSeconds: 'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS',
  wakeShortcut: 'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT',
  wakeWordEnabled: 'QWEN_AUDIO_WAKE_WORD_ENABLED',
  wakeWordPhrase: 'QWEN_AUDIO_WAKE_WORD_PHRASE',
  language: 'QWEN_AUDIO_DESKTOP_LANGUAGE',
  defaultWorkspace: 'NISSE_DEFAULT_WORKSPACE',
  defaultSessionId: 'NISSE_DEFAULT_SESSION_ID',
  personaName: 'NISSE_PERSONA_NAME',
  personaPersonality: 'NISSE_PERSONA_PERSONALITY',
  personaTone: 'NISSE_PERSONA_TONE',
  personaInstructions: 'NISSE_PERSONA_INSTRUCTIONS',
  nisseReasoningEffort: 'NISSE_REASONING_EFFORT',
}

const CLIENT_ENVIRONMENT_KEYS = new Set(Object.values(CLIENT_SETTING_KEYS))

export function clientSettingsPatch(settings) {
  return Object.fromEntries(Object.entries(settings)
    .filter(([key]) => Object.hasOwn(CLIENT_SETTING_KEYS, key)))
}

const SETTING_KEYS = {
  ...CLIENT_SETTING_KEYS,
  agentProtocol: 'AGENT_PROTOCOL',
  backendModel: 'QWEN_AUDIO_AGENT_BACKEND_MODEL',
  backendOwnership: 'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP',
  nodePath: 'QWEN_AUDIO_AGENT_NODE_PATH',
}

function configured(values, key, fallback) {
  return Object.hasOwn(values, key) ? values[key] : fallback
}

function cleanUrl(value, fallback, label = '地址') {
  const text = String(value || fallback).trim()
  const url = new URL(text)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 HTTP 或 HTTPS`)
  }
  return url.origin
}

function cleanRealtimeUrl(value, fallback, label = '服务地址') {
  const text = String(value || fallback).trim()
  const url = new URL(text)
  if (!['ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 WS 或 WSS`)
  }
  return text.replace(/\/+$/, '')
}

function cleanBackendUrl(value, label = '后台服务地址') {
  const text = String(value || '').trim()
  if (!text) return ''
  const url = new URL(text)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
    throw new Error(`${label}只支持 HTTP、HTTPS、WS 或 WSS`)
  }
  if (url.username || url.password) {
    throw new Error(`${label}不能包含用户名或密码，请使用独立的访问令牌`)
  }
  return text.replace(/\/+$/, '')
}

function cleanAgentProtocol(value) {
  const protocol = normalizeBackendProtocol(value)
  if (!protocol) return DEFAULTS.agentProtocol
  if (!backendDefinition(protocol)) {
    throw new Error(`不支持的后台 Agent：${protocol}`)
  }
  return protocol
}

function cleanAutoHideSeconds(value) {
  const seconds = Number(value)
  if (seconds === 0) return 0
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    return DEFAULTS.autoHideSeconds
  }
  return seconds
}

function cleanWakeShortcut(value) {
  const shortcut = String(value || DEFAULTS.wakeShortcut).trim()
  if (shortcut === 'CommandOrControl+Space') {
    return DEFAULTS.wakeShortcut
  }
  const parts = shortcut.split('+')
  const key = parts.pop() || ''
  const modifiers = new Set(parts)
  const validModifiers = parts.every(part => (
    ['CommandOrControl', 'Alt', 'Shift'].includes(part)
  )) && modifiers.size === parts.length
  const validKey = (
    key === 'Space'
    || /^[A-Z0-9]$/.test(key)
    || /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
    || ['Up', 'Down', 'Left', 'Right'].includes(key)
  )
  const functionKey = /^F(?:[1-9]|1\d|2[0-4])$/.test(key)
  const hasCommandModifier = (
    modifiers.has('CommandOrControl') || modifiers.has('Alt')
  )
  if (!validModifiers || !validKey || (!functionKey && !hasCommandModifier)) {
    return DEFAULTS.wakeShortcut
  }
  return [
    modifiers.has('CommandOrControl') ? 'CommandOrControl' : '',
    modifiers.has('Alt') ? 'Alt' : '',
    modifiers.has('Shift') ? 'Shift' : '',
    key,
  ].filter(Boolean).join('+')
}

function encoded(value) {
  const text = String(value ?? '')
  if (/^[A-Za-z0-9_./:@+-]*$/.test(text)) return text
  // These settings are single-line fields. Node's parseEnv does not support
  // JavaScript-style escaping: double quotes expand \\n but preserve \\\\ and \\".
  // Choose a literal delimiter and verify round-trip semantics before saving.
  if (!/[\r\n\0]/.test(text)) {
    for (const quote of ['"', "'", '`']) {
      if (text.includes(quote)) continue
      const result = `${quote}${text}${quote}`
      if (parseEnv(`VALUE=${result}`).VALUE === text) return result
    }
  }
  throw new TypeError('设置值包含无法保存的换行、控制字符或引号组合')
}

function parseRealtimeSettings(values, fallback, realtimeProvider, drafts) {
  return realtimeSettingsFromEnvironment({
    ...mergeRealtimeEnvironment(fallback, values),
    QWEN_AUDIO_REALTIME_PROVIDER: realtimeProvider,
  }, drafts)
}

export function hasRealtimeSettingsPatch(settings) {
  return REALTIME_SETTING_FIELDS.some(field => settings[field] !== undefined)
}

function normalizeRealtimeSettings(settings, realtimeProvider) {
  const values = realtimeSettingsValues(settings)
  for (const provider of REALTIME_PROVIDERS) {
    for (const field of provider.settings) {
      const active = provider.key === realtimeProvider
      const value = values[field.key].trim() || field.default || (active ? field.activeDefault : '') || ''
      // Inactive providers retain their drafts but cannot block applying the
      // selected provider. The active endpoint is validated at the IPC boundary.
      values[field.key] = active && field.type === 'url'
        ? cleanRealtimeUrl(value, '') : value
    }
  }
  return { ...values, realtimeProvider }
}

export function parseSettings(content = '', fallback = {}, realtimeDrafts = {}) {
  const values = migrateRealtimeFileEnvironment(parseEnv(content))
  const agentProtocol = cleanAgentProtocol(configured(
    values,
    'AGENT_PROTOCOL',
    fallback.AGENT_PROTOCOL || DEFAULTS.agentProtocol,
  ))
  const backend = backendDefinition(agentProtocol)
  const backendUrl = backend?.baseUrlEnvironment
    ? String(configured(
      values,
      backend.baseUrlEnvironment,
      fallback[backend.baseUrlEnvironment] || '',
    ) || '').trim()
    : ''
  const backendOwnership = backend
    ? resolveBackendOwnership(agentProtocol, {
      baseUrlConfigured: Boolean(backendUrl),
      requestedOwnership: configured(
        values,
        'QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP',
        fallback.QWEN_AUDIO_AGENT_BACKEND_OWNERSHIP || '',
      ),
    })
    : DEFAULTS.backendOwnership
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  const backendCredential = credentialEnvironment
    ? String(configured(
      values,
      credentialEnvironment,
      fallback[credentialEnvironment] || '',
    ) || '').trim()
    : ''
  const realtimeProvider = normalizeRealtimeProvider(configured(
    values,
    'QWEN_AUDIO_REALTIME_PROVIDER',
    fallback.QWEN_AUDIO_REALTIME_PROVIDER || realtimeDrafts.realtimeProvider || DEFAULTS.realtimeProvider,
  ))
  const configuredOrbStyle = configured(
    values,
    'QWEN_AUDIO_ORB_STYLE',
    fallback.QWEN_AUDIO_ORB_STYLE || '',
  )
  const configuredOrbSkin = configured(
    values,
    'QWEN_AUDIO_ORB_SKIN',
    fallback.QWEN_AUDIO_ORB_SKIN || '',
  )
  return {
    gatewayUrl: configured(
      values,
      'QWEN_AUDIO_AGENT_URL',
      fallback.QWEN_AUDIO_AGENT_URL || DEFAULTS.gatewayUrl,
    ) || DEFAULTS.gatewayUrl,
    orbStyle: ['fluid', 'goo'].includes(
      String(configuredOrbStyle).toLowerCase(),
    ) ? String(configuredOrbStyle).toLowerCase() : DEFAULTS.orbStyle,
    // 旧配置只有 QWEN_AUDIO_ORB_STYLE 时自动收敛为 orbSkin。
    orbSkin: resolveOrbSkinId({
      orbSkin: configuredOrbSkin || DEFAULTS.orbSkin,
      orbStyle: configuredOrbStyle,
    }),
    autoHideSeconds: cleanAutoHideSeconds(configured(
      values,
      'QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS',
      configured(
        values,
        'QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS',
        fallback.QWEN_AUDIO_DESKTOP_AUTO_HIDE_SECONDS
          ?? fallback.QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS
          ?? DEFAULTS.autoHideSeconds,
      ),
    )),
    wakeShortcut: cleanWakeShortcut(configured(
      values,
      'QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT',
      fallback.QWEN_AUDIO_DESKTOP_WAKE_SHORTCUT ?? DEFAULTS.wakeShortcut,
    )),
    wakeWordEnabled: String(
      configured(
        values,
        'QWEN_AUDIO_WAKE_WORD_ENABLED',
        fallback.QWEN_AUDIO_WAKE_WORD_ENABLED || '',
      ),
    ).toLowerCase() === 'true',
    // 读取配置时宽松处理：历史配置或手写坏值回退到默认唤醒词，不阻塞启动。
    wakeWordPhrase: sanitizeWakeWordPhrase(configured(
      values,
      'QWEN_AUDIO_WAKE_WORD_PHRASE',
      fallback.QWEN_AUDIO_WAKE_WORD_PHRASE || DEFAULTS.wakeWordPhrase,
    )),
    ...parseRealtimeSettings(values, fallback, realtimeProvider, realtimeDrafts),
    agentProtocol,
    backendModel: String(configured(
      values,
      'QWEN_AUDIO_AGENT_BACKEND_MODEL',
      fallback.QWEN_AUDIO_AGENT_BACKEND_MODEL || DEFAULTS.backendModel,
    ) || '').trim(),
    backendOwnership,
    backendUrl,
    backendCredential,
    nodePath: String(configured(
      values,
      'QWEN_AUDIO_AGENT_NODE_PATH',
      fallback.QWEN_AUDIO_AGENT_NODE_PATH || DEFAULTS.nodePath,
    ) || '').trim(),
    language: normalizeDesktopLanguage(configured(
      values,
      'QWEN_AUDIO_DESKTOP_LANGUAGE',
      fallback.QWEN_AUDIO_DESKTOP_LANGUAGE || DEFAULTS.language,
    )),
    defaultWorkspace: cleanDefaultWorkspace(configured(
      values,
      'NISSE_DEFAULT_WORKSPACE',
      fallback.NISSE_DEFAULT_WORKSPACE || DEFAULTS.defaultWorkspace,
    ), ''),
    defaultSessionId: cleanDefaultSessionId(configured(
      values,
      'NISSE_DEFAULT_SESSION_ID',
      fallback.NISSE_DEFAULT_SESSION_ID || DEFAULTS.defaultSessionId,
    ), ''),
    personaName: cleanPersonaText(
      configured(values, 'NISSE_PERSONA_NAME', fallback.NISSE_PERSONA_NAME || DEFAULTS.personaName),
      DEFAULTS.personaName,
      80,
    ),
    personaPersonality: cleanPersonaText(
      configured(values, 'NISSE_PERSONA_PERSONALITY', fallback.NISSE_PERSONA_PERSONALITY || DEFAULTS.personaPersonality),
      DEFAULTS.personaPersonality,
      1200,
    ),
    personaTone: cleanPersonaText(
      configured(values, 'NISSE_PERSONA_TONE', fallback.NISSE_PERSONA_TONE || DEFAULTS.personaTone),
      DEFAULTS.personaTone,
      1200,
    ),
    personaInstructions: cleanPersonaText(
      configured(values, 'NISSE_PERSONA_INSTRUCTIONS', fallback.NISSE_PERSONA_INSTRUCTIONS || DEFAULTS.personaInstructions),
      DEFAULTS.personaInstructions,
      2400,
    ),
    nisseReasoningEffort: normalizeNisseReasoningEffort(configured(
      values,
      'NISSE_REASONING_EFFORT',
      fallback.NISSE_REASONING_EFFORT || DEFAULTS.nisseReasoningEffort,
    )),
  }
}

export function normalizeSettings(settings = {}) {
  const realtimeProvider = normalizeRealtimeProvider(
    settings.realtimeProvider ?? DEFAULTS.realtimeProvider,
  )
  const agentProtocol = cleanAgentProtocol(
    settings.agentProtocol ?? DEFAULTS.agentProtocol,
  )
  const backend = backendDefinition(agentProtocol)
  const backendUrl = backend?.baseUrlEnvironment
    ? cleanBackendUrl(settings.backendUrl ?? DEFAULTS.backendUrl)
    : ''
  const backendOwnership = backend
    ? resolveBackendOwnership(agentProtocol, {
      baseUrlConfigured: Boolean(backendUrl),
      requestedOwnership: settings.backendOwnership
        ?? DEFAULTS.backendOwnership,
    })
    : DEFAULTS.backendOwnership
  if (backendOwnership === 'external' && !backendUrl) {
    throw new Error('请填写外部后台服务地址')
  }
  return {
    gatewayUrl: cleanUrl(
      settings.gatewayUrl,
      DEFAULTS.gatewayUrl,
      'Gateway 地址',
    ),
    orbStyle: ['fluid', 'goo'].includes(
      String(settings.orbStyle || DEFAULTS.orbStyle).toLowerCase(),
    )
      ? String(settings.orbStyle || DEFAULTS.orbStyle).toLowerCase()
      : DEFAULTS.orbStyle,
    orbSkin: normalizeOrbSkinId(settings.orbSkin) || DEFAULTS.orbSkin,
    autoHideSeconds: cleanAutoHideSeconds(
      settings.autoHideSeconds ?? DEFAULTS.autoHideSeconds,
    ),
    wakeShortcut: cleanWakeShortcut(
      settings.wakeShortcut ?? DEFAULTS.wakeShortcut,
    ),
    wakeWordEnabled: Boolean(settings.wakeWordEnabled),
    // 保存时严格校验：无效短语返回可读错误，交由设置页提示。
    wakeWordPhrase: validateWakeWordPhrase(
      settings.wakeWordPhrase === undefined
        || String(settings.wakeWordPhrase).trim() === ''
        ? DEFAULTS.wakeWordPhrase
        : settings.wakeWordPhrase,
    ),
    ...normalizeRealtimeSettings(settings, realtimeProvider),
    agentProtocol,
    backendModel: String(
      settings.backendModel ?? DEFAULTS.backendModel,
    ).trim(),
    backendOwnership,
    backendUrl,
    backendCredential: backend?.externalService?.credentialEnvironment
      ? String(settings.backendCredential ?? DEFAULTS.backendCredential).trim()
      : '',
    nodePath: String(
      settings.nodePath ?? DEFAULTS.nodePath,
    ).trim(),
    language: normalizeDesktopLanguage(settings.language),
    defaultWorkspace: (() => {
      const text = String(settings.defaultWorkspace ?? DEFAULTS.defaultWorkspace).trim()
      if (!text) return ''
      if (!isAbsolute(text)) throw new Error('默认工作区必须是绝对路径')
      return text
    })(),
    defaultSessionId: (() => {
      const text = String(settings.defaultSessionId ?? DEFAULTS.defaultSessionId).trim()
      if (!text) return ''
      if (!/^[A-Za-z0-9._:/@-]+$/.test(text)) {
        throw new Error('默认会话 ID 格式不正确')
      }
      return text
    })(),
    personaName: cleanPersonaText(settings.personaName, DEFAULTS.personaName, 80),
    personaPersonality: cleanPersonaText(
      settings.personaPersonality,
      DEFAULTS.personaPersonality,
      1200,
    ),
    personaTone: cleanPersonaText(settings.personaTone, DEFAULTS.personaTone, 1200),
    personaInstructions: cleanPersonaText(
      settings.personaInstructions,
      DEFAULTS.personaInstructions,
      2400,
    ),
    nisseReasoningEffort: normalizeNisseReasoningEffort(settings.nisseReasoningEffort),
  }
}

export function realtimeSettingsConfiguration(settings = {}) {
  return resolveRealtimeFrontendConfiguration(realtimeRuntimeEnvironment(settings))
}

export function realtimeSettingsConfigured(settings = {}) {
  try {
    const frontend = realtimeSettingsConfiguration(settings)
    assertRealtimeFrontendModel(frontend.active)
    return frontend.active.configured && Boolean(cleanRealtimeUrl(frontend.active.endpoint, ''))
  } catch {
    return false
  }
}

// Applies a just-saved settings patch to a live environment, mirroring the
// key mapping of updateSettingsContent. Without this the desktop process
// keeps serving the values it loaded first — the config file is only read
// into environment slots that are still unset, so a freshly saved API Key
// would look ignored until the app itself restarts.
export function applySettingsEnvironment(settings = {}, env = process.env) {
  const realtimeChanged = hasRealtimeSettingsPatch(settings)
  const normalized = normalizeSettings(realtimeChanged ? { ...parseSettings('', env), ...settings } : settings)
  const backend = backendDefinition(normalized.agentProtocol)
  const entries = Object.entries(SETTING_KEYS)
    .filter(([field]) => settings[field] !== undefined)
    .map(([field, key]) => [key, normalized[field]])
  if (settings.backendUrl !== undefined && backend?.baseUrlEnvironment) {
    entries.push([backend.baseUrlEnvironment, normalized.backendUrl])
  }
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  if (settings.backendCredential !== undefined && credentialEnvironment) {
    entries.push([credentialEnvironment, normalized.backendCredential])
  }
  for (const [key, value] of entries) {
    const text = String(value ?? '')
    // A cleared value releases the slot so runtime defaults apply again,
    // instead of pinning the stale override forever.
    if (text === '') delete env[key]
    else env[key] = text
  }
  if (realtimeChanged) {
    delete env.QWEN_AUDIO_REALTIME_API_KEY
    delete env.QWEN_AUDIO_REALTIME_ENDPOINT
    Object.assign(env, realtimeRuntimeEnvironment(normalized))
  }
  return env
}

// The form is unified; persistence is not. Gateway settings and client
// preferences use separate files without duplicating validation or schemas.
export function updateSettingsContent(content = '', settings = {}, { scope = 'all', realtimeDrafts = {} } = {}) {
  if (!['all', 'gateway', 'client'].includes(scope)) throw new TypeError('invalid settings scope')
  const accepts = key => scope === 'all'
    || (scope === 'client') === CLIENT_ENVIRONMENT_KEYS.has(key)
  const realtimeChanged = scope !== 'client' && hasRealtimeSettingsPatch(settings)
  const normalized = normalizeSettings(realtimeChanged
    ? { ...parseSettings(content, {}, realtimeDrafts), ...realtimeDrafts, ...settings }
    : settings)
  const values = Object.fromEntries(
    Object.entries(SETTING_KEYS)
      .filter(([field, key]) => settings[field] !== undefined && accepts(key))
      .map(([field, key]) => [
        key,
        encoded(normalized[field]),
      ]),
  )
  if (realtimeChanged) {
    for (const [key, value] of Object.entries(realtimeRuntimeEnvironment(normalized))) values[key] = encoded(value)
  }
  const backend = backendDefinition(normalized.agentProtocol)
  if (scope !== 'client' && settings.backendUrl !== undefined && backend?.baseUrlEnvironment) {
    values[backend.baseUrlEnvironment] = encoded(normalized.backendUrl)
  }
  const credentialEnvironment = backend?.externalService?.credentialEnvironment
  if (scope !== 'client' && settings.backendCredential !== undefined && credentialEnvironment) {
    values[credentialEnvironment] = encoded(normalized.backendCredential)
  }
  const removed = new Set([
    ['backendUrl', backend?.baseUrlEnvironment],
    ['backendCredential', credentialEnvironment],
  ].filter(([field, key]) => (
    Boolean(key) && settings[field] !== undefined && !normalized[field]
  )).map(([, key]) => key))
  // Legacy keys that were merged into auto-hide. Drop them so the saved
  // config no longer carries a divergent sleep timeout.
  const legacy = new Set([
    'QWEN_AUDIO_SLEEP_TIMEOUT_SECONDS',
    'QWEN_AUDIO_DESKTOP_AUTO_SLEEP_SECONDS',
  ])
  if (realtimeChanged) {
    removed.add('QWEN_AUDIO_REALTIME_API_KEY')
    removed.add('QWEN_AUDIO_REALTIME_ENDPOINT')
  }
  const seen = new Set()
  const lines = content.split(/\r?\n/).map(line => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*=/)
    const key = match?.[1]
    if (key && !accepts(key)) return null
    if (key && legacy.has(key)) return null
    if (key && removed.has(key)) return null
    if (!key || !(key in values)) return line
    if (seen.has(key)) return null
    seen.add(key)
    return `${key}=${values[key]}`
  }).filter(line => line !== null)
  for (const key of Object.keys(values)) {
    if (!seen.has(key) && !removed.has(key)) lines.push(`${key}=${values[key]}`)
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`
}
