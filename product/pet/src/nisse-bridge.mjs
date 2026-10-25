// Nisse client <-> dsh-nisse plugin bridge.
//
// The plugin owns DSH (sessions, model, persona). This module is the client
// half of that contract and deliberately contains no Electron imports so the
// behaviour can be tested against a stub loopback server:
// - read the loopback credentials the plugin writes to bridge.json;
// - push the intended client configuration with PUT /config (2s timeout);
// - when the bridge is offline, persist the same payload to
//   pending-client-config.json (0600), which plugin v0.5 applies and deletes on
//   its next load;
// - generate the bundled-gateway persona profile (ASSISTANT.md structure).
//
// Every network helper returns null instead of throwing: the settings panel
// must stay usable when DSH is not running.
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  DEFAULT_PERSONA,
  normalizeNisseReasoningEffort,
} from './settings-config.mjs'

export const BRIDGE_FILE_ENV = 'NISSE_BRIDGE_FILE'
export const BRIDGE_TIMEOUT_MS = 2000
export const PERSONA_DIRECTORY = 'persona'
export const PERSONA_FILE = 'ASSISTANT.md'

const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIRECTORY_MODE = 0o700
const MAX_SESSION_ID = 200
const CONFIG_FIELDS = Object.freeze([
  'defaultWorkspace',
  'defaultSessionId',
  'personaName',
  'personaPersonality',
  'personaTone',
  'personaInstructions',
  'nisseReasoningEffort',
])

function cleanText(value, maxChars) {
  return [...String(value ?? '').replace(/\s+/gu, ' ').trim()]
    .slice(0, maxChars)
    .join('')
}

function personaValues(settings = {}) {
  return {
    name: cleanText(settings.personaName, 80) || DEFAULT_PERSONA.name,
    personality: cleanText(settings.personaPersonality, 1200) || DEFAULT_PERSONA.personality,
    tone: cleanText(settings.personaTone, 1200) || DEFAULT_PERSONA.tone,
    instructions: cleanText(settings.personaInstructions, 2400) || DEFAULT_PERSONA.instructions,
  }
}

export function nisseBridgeFile(env = process.env, home = homedir()) {
  const configured = String(env?.[BRIDGE_FILE_ENV] || '').trim()
  if (configured) return resolve(configured)
  return join(home, '.dsh-nisse', 'bridge.json')
}

export function nissePendingConfigPath(bridgeFile) {
  return join(dirname(bridgeFile || nisseBridgeFile()), 'pending-client-config.json')
}

export function nissePersonaProfilePath(userDataDirectory) {
  if (!userDataDirectory) throw new TypeError('userData directory is required')
  return resolve(userDataDirectory, PERSONA_DIRECTORY, PERSONA_FILE)
}

export function bridgeCurrentModel(health) {
  if (!health || typeof health !== 'object') return null
  const candidates = [
    health.currentModel,
    health.defaultModel,
    health.resolved?.model,
    health.model,
    health.modelPolicy,
  ]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    const provider = cleanText(candidate.provider, 80)
    const model = cleanText(candidate.model || candidate.id, 160)
    if (!provider || !model) continue
    return {
      provider,
      model,
      reasoningEffort: String(candidate.reasoningEffort ?? ''),
      label: cleanText(candidate.label, 160),
      mode: cleanText(candidate.mode || health.modelPolicy, 40),
    }
  }
  return null
}

export function bridgeSessionsPayload(payload) {
  const roots = Array.isArray(payload?.roots) ? payload.roots : []
  const sessions = roots
    .map(root => ({
      sessionId: cleanText(root?.sessionId, MAX_SESSION_ID),
      status: cleanText(root?.status, 40),
      cwd: cleanText(root?.cwd || root?.workspace, 1024),
    }))
    .filter(session => session.sessionId)
  return {
    sessions,
    defaultSessionId: cleanText(payload?.defaultSessionId, MAX_SESSION_ID),
    nisseSessionId: cleanText(payload?.nisseSessionId, MAX_SESSION_ID),
    defaultWorkspace: cleanText(payload?.defaultWorkspace, 1024),
  }
}

export function personaPluginPayload(settings = {}) {
  return personaValues(settings)
}

export function nissePluginConfigPayload(settings = {}) {
  return {
    defaultWorkspace: cleanText(settings.defaultWorkspace, 1024),
    defaultSessionId: cleanText(settings.defaultSessionId, MAX_SESSION_ID),
    reasoningEffort: normalizeNisseReasoningEffort(settings.nisseReasoningEffort),
    persona: personaPluginPayload(settings),
  }
}

// The gateway already understands QWEN_AUDIO_AGENT_ASSISTANT_PROFILE_PATH.
// Segment order mirrors config/frontend-agent/ASSISTANT.md so the file remains
// editable by hand without surprising the prompt builder.
export function personaProfileText(settings = {}) {
  const persona = personaValues(settings)
  const lines = [
    '## Identity',
    '',
    `你叫${persona.name}，住在用户 Mac 桌面上的鲸鱼娘，也是用户唯一的私人助理。`,
    '你的大脑是 DeepSeek Harness（DSH），声音由实时语音层呈现。对外只使用这个身份，',
    '不要自称通义千问、Qwen、模型或 Coding Agent。',
    '',
    '## Personality',
    '',
    persona.personality,
    '',
    '## Conversation style',
    '',
    persona.tone,
  ]
  if (persona.instructions) lines.push('', persona.instructions)
  return `${lines.join('\n')}\n`
}

function writePrivateFile(path, content) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
    chmodSync(temporary, PRIVATE_FILE_MODE)
    renameSync(temporary, path)
    chmodSync(path, PRIVATE_FILE_MODE)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {}
    throw error
  }
}

export function writePersonaProfile({ settings, userDataDirectory } = {}) {
  const path = nissePersonaProfilePath(userDataDirectory)
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  writePrivateFile(path, personaProfileText(settings))
  return path
}

export function writePendingClientConfig({ settings, bridgeFile } = {}) {
  const path = nissePendingConfigPath(bridgeFile)
  mkdirSync(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  writePrivateFile(
    path,
    `${JSON.stringify(nissePluginConfigPayload(settings), null, 2)}\n`,
  )
  return path
}

export function clearPendingClientConfig(bridgeFile) {
  try {
    unlinkSync(nissePendingConfigPath(bridgeFile))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

export function pendingClientConfigExists(bridgeFile) {
  try {
    readFileSync(nissePendingConfigPath(bridgeFile))
    return true
  } catch {
    return false
  }
}

export function readBridgeCredentials(filePath = nisseBridgeFile()) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
  const port = Number(parsed?.port)
  const token = String(parsed?.token || '').trim()
  if (!Number.isInteger(port) || port <= 0 || port > 65535 || !token) return null
  return {
    port,
    token,
    baseUrl: `http://127.0.0.1:${port}`,
    version: String(parsed.version || ''),
  }
}

export async function bridgeRequest(pathname, {
  method = 'GET',
  body,
  timeoutMs = BRIDGE_TIMEOUT_MS,
  bridgeFile,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') return null
  const credentials = readBridgeCredentials(bridgeFile || nisseBridgeFile())
  if (!credentials) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || BRIDGE_TIMEOUT_MS))
  try {
    const response = await fetchImpl(`${credentials.baseUrl}${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${credentials.token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    if (!response?.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchNisseBridgeStatus({ bridgeFile, timeoutMs } = {}) {
  const health = await bridgeRequest('/health', { bridgeFile, timeoutMs })
  if (!health) return { online: false, model: null, version: '', defaultWorkspace: '', defaultSessionId: '' }
  return {
    online: true,
    version: cleanText(health.version, 40),
    model: bridgeCurrentModel(health),
    defaultWorkspace: cleanText(health.defaultWorkspace, 1024),
    defaultSessionId: cleanText(health.defaultSessionId, MAX_SESSION_ID),
  }
}

export async function fetchNisseBridgeConfig({ bridgeFile, timeoutMs } = {}) {
  const config = await bridgeRequest('/config', { bridgeFile, timeoutMs })
  if (!config || typeof config !== 'object') return { online: false, config: null }
  return { online: true, config }
}

export async function fetchNisseBridgeSessions({ bridgeFile, timeoutMs } = {}) {
  const payload = await bridgeRequest('/sessions', { bridgeFile, timeoutMs })
  if (!payload || typeof payload !== 'object') {
    return { online: false, sessions: [], defaultSessionId: '', nisseSessionId: '', defaultWorkspace: '' }
  }
  return { online: true, ...bridgeSessionsPayload(payload) }
}

/**
 * Push the client-owned configuration to the plugin. Returns
 * { online, pending, pendingPath, bridgeFile } and never throws for transport
 * failures: the pending file is the offline contract with plugin v0.5.
 */
export async function applyClientConfigToBridge({
  settings,
  bridgeFile = nisseBridgeFile(),
  timeoutMs = BRIDGE_TIMEOUT_MS,
  fetchImpl,
} = {}) {
  const payload = nissePluginConfigPayload(settings)
  const updated = await bridgeRequest('/config', {
    method: 'PUT',
    body: payload,
    bridgeFile,
    timeoutMs,
    fetchImpl,
  })
  if (updated) {
    try {
      clearPendingClientConfig(bridgeFile)
    } catch {}
    return {
      online: true,
      pending: false,
      pendingPath: nissePendingConfigPath(bridgeFile),
      bridgeFile,
      config: updated,
    }
  }
  let pendingPath = nissePendingConfigPath(bridgeFile)
  try {
    pendingPath = writePendingClientConfig({ settings, bridgeFile })
  } catch {
    return { online: false, pending: false, pendingPath, bridgeFile, config: null }
  }
  return { online: false, pending: true, pendingPath, bridgeFile, config: null }
}

// Kept for tests/status rendering: the settings panel names the fields it
// persists so the config-file section can list them without guessing.
export const NISSE_CLIENT_CONFIG_FIELDS = CONFIG_FIELDS
