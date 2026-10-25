// Body Runtime transport contract (W1/W6).
//
// Product rule: DSH owns the agent, the chat and the session; the pet is only an
// OS-level body (transparent floating orb, bubbles, voice I/O). The WhaleGirl
// Bot desktop shell therefore
//   - spawns this app with NISSE_BRIDGE_ONLY=1,
//   - owns the voice gateway and passes its origin in QWEN_AUDIO_AGENT_URL,
//   - exposes a small loopback control surface (POST /bot/toggle-main,
//     POST /bot/open-settings, POST /bot/approval) on its own port.
// This module keeps those decisions pure (no electron, no timers, no global
// fetch) so they are unit-testable and shared with the smoke harness.

export const BRIDGE_ONLY_ENV = 'NISSE_BRIDGE_ONLY'
export const BRIDGE_FILE_ENV = 'NISSE_BRIDGE_FILE'
export const GATEWAY_URL_ENV = 'QWEN_AUDIO_AGENT_URL'
export const SHELL_CONTROL_URL_ENV = 'NISSE_SHELL_CONTROL_URL'

/** The desktop shell's Bot config server (apps/desktop/src/bot-config-server.ts). */
export const DEFAULT_SHELL_CONTROL_URL = 'http://127.0.0.1:59100'

/**
 * Endpoints the pet calls on the desktop shell. The shell must answer them.
 *
 * `/bot/config`, `/bot/test/*` and `/bot/status` already exist in
 * apps/desktop/src/bot-config-server.ts. They are the ONLY way the pet reads
 * or writes configuration: settings stay owned by DSH, the pet just asks.
 */
export const SHELL_PATHS = Object.freeze({
  toggleMain: '/bot/toggle-main',
  openSettings: '/bot/open-settings',
  approval: '/bot/approval',
  config: '/bot/config',
  testLlm: '/bot/test/llm',
  testVoice: '/bot/test/voice',
  status: '/bot/status',
})

/** Bubble body is clamped so one long delta cannot grow the card unbounded. */
export const BUBBLE_TEXT_MAX = 200

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

function loopbackHttpOrigin(raw, label) {
  let url
  try {
    url = new URL(String(raw || ''))
  } catch {
    throw new TypeError(`${label} must be an absolute URL`)
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new TypeError(`${label} must be an http:// loopback URL`)
  }
  return url.origin
}

/** Bridge-only mode: the shell owns the gateway, so the pet must not start one. */
export function isBridgeOnly(env = process.env) {
  return String(env?.[BRIDGE_ONLY_ENV] || '').trim() === '1'
}

/**
 * The voice gateway origin the body runtime connects to.
 *
 * In bridge-only mode the desktop shell always provides QWEN_AUDIO_AGENT_URL;
 * `fallback` (the persisted client preference) only matters for a standalone
 * launch. Throws when neither yields a valid URL so startup can fail visibly
 * instead of silently spawning an embedded gateway.
 */
export function bridgeGatewayOrigin(env = process.env, fallback = '') {
  const candidates = [
    [env?.[GATEWAY_URL_ENV], GATEWAY_URL_ENV],
    [fallback, 'gatewayUrl'],
  ]
  for (const [value, label] of candidates) {
    const text = String(value || '').trim()
    if (!text) continue
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new TypeError(`${label} must use http(s)`)
    }
    return url.origin
  }
  throw new TypeError(`missing gateway origin (${GATEWAY_URL_ENV})`)
}

/** Loopback base URL of the desktop shell control surface (W6 double-click). */
export function resolveShellControlUrl(env = process.env) {
  return loopbackHttpOrigin(
    String(env?.[SHELL_CONTROL_URL_ENV] || '').trim()
      || DEFAULT_SHELL_CONTROL_URL,
    'shell control URL',
  )
}

export function shellControlEndpoint(origin, path, search = '') {
  const base = loopbackHttpOrigin(origin, 'shell control URL')
  const suffix = String(path || '')
  if (!suffix.startsWith('/')) throw new TypeError('shell control path must start with /')
  return `${base}${suffix}${search}`
}

/**
 * POST a control request to the desktop shell.
 *
 * Never throws: the pet must keep animating and listening even while the shell
 * is restarting. Returns `{ ok, result }` or `{ ok: false, error }`.
 */
export async function postShellControl(
  path,
  payload,
  { env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {},
) {
  let endpoint
  try {
    endpoint = shellControlEndpoint(resolveShellControlUrl(env), path)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch is unavailable' }
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-dsh-bot-token': String(env.NISSE_SHELL_CONTROL_TOKEN || '') },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      return {
        ok: false,
        error: body?.error || `shell control HTTP ${response.status}`,
      }
    }
    return { ok: true, result: body?.result ?? body ?? null }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/**
 * W6 double-click: ask the shell to toggle the DSH window (hidden → shown /
 * focused → minimized). The shell answers with `minimized` or `shown`.
 */
export async function requestMainToggle(options = {}) {
  return postShellControl(SHELL_PATHS.toggleMain, {}, options)
}

/** Settings live in DSH; the pet only asks the shell to open DSH → Bot. */
export async function requestOpenDshSettings(options = {}) {
  return postShellControl(SHELL_PATHS.openSettings, {}, options)
}

/** Bubble button answer → shell → bridge /approval. */
export async function sendApprovalDecision(id, decision, options = {}) {
  const approvalId = String(id || '').trim()
  const value = String(decision || '').trim()
  if (!approvalId || !['allow', 'reject'].includes(value)) {
    return { ok: false, error: 'invalid approval decision' }
  }
  return postShellControl(
    SHELL_PATHS.approval,
    { id: approvalId, decision: value },
    options,
  )
}

/** Read the bridge descriptor the desktop shell writes next to DSH_HOME. */
export function parseBridgeDescriptor(raw) {
  let value = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const port = Number(value.port)
  const token = String(value.token || '').trim()
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  if (!token) return null
  return { port, token }
}

export function bridgeEventsEndpoint(descriptor, after = 0) {
  if (!descriptor?.port || !descriptor?.token) throw new TypeError('bridge descriptor is incomplete')
  const seq = Math.max(0, Math.floor(Number(after) || 0))
  return `http://127.0.0.1:${descriptor.port}/events?after=${seq}`
}

/** Highest ioSeq seen in a /events page, so polling never re-delivers. */
export function nextBridgeSeq(previous, events) {
  let next = Math.max(0, Math.floor(Number(previous) || 0))
  for (const event of Array.isArray(events) ? events : []) {
    next = Math.max(next, Math.floor(Number(event?.ioSeq) || 0))
  }
  return next
}

/**
 * Turn a raw integration bridge event into bubble presentation.
 *
 * DSH owns the turn; the bubble only mirrors it. Returns
 * `{ action: 'show', payload }`, `{ action: 'hide', delayMs }` or null for
 * events the body runtime does not surface.
 */
export function bridgeEventToBubble(event) {
  const type = String(event?.type || '')
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  switch (type) {
    case 'turn.started':
    case 'turn.accepted':
    case 'user.message':
      return {
        action: 'show',
        payload: { kind: 'speech', text: 'DSH 正在处理…' },
      }
    case 'assistant.delta':
    case 'assistant.message': {
      const text = String(data.text || '').slice(0, BUBBLE_TEXT_MAX)
      if (!text) return null
      return { action: 'show', payload: { kind: 'speech', text } }
    }
    case 'turn.settled':
    case 'turn.ended':
      return { action: 'hide', delayMs: 600 }
    case 'agent.status':
      return data.status === 'idle'
        ? { action: 'hide', delayMs: 800 }
        : null
    case 'error':
    case 'agent.error': {
      const message = String(data.message || '').slice(0, BUBBLE_TEXT_MAX)
      return {
        action: 'show',
        payload: { kind: 'speech', text: `DSH 出错：${message || '未知错误'}` },
      }
    }
    default:
      return null
  }
}

/** Bubble payload for an approval.request bridge event, or null. */
export function approvalBubblePayload(event) {
  if (String(event?.type || '') !== 'approval.request') return null
  const data = event?.data && typeof event.data === 'object' ? event.data : {}
  const id = String(data.id || '').trim()
  if (!id) return null
  const toolName = String(data.toolName || '操作').slice(0, 80)
  const reason = String(data.reason || '').slice(0, 120)
  return {
    id,
    payload: {
      visible: true,
      kind: 'action',
      text: `DSH 请求确认：${toolName}${reason ? `\n${reason}` : ''}`,
      approval: { id },
    },
  }
}

// ---- shell Bot settings surface (GET/PUT /bot/config, POST /bot/test/*) ----
//
// The pet-led onboarding must never grow its own settings storage for
// authoritative values: it reads the shell's Bot config, merges the answers the
// user gave inside the bubble, and writes the document back. These helpers are
// deliberately transport-only so the onboarding state machine stays pure.

async function shellJsonRequest(method, path, payload, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  let endpoint
  try {
    endpoint = shellControlEndpoint(resolveShellControlUrl(env), path)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is unavailable' }
  try {
    const init = {
      method,
      headers: { 'content-type': 'application/json', 'x-dsh-bot-token': String(env.NISSE_SHELL_CONTROL_TOKEN || '') },
      signal: AbortSignal.timeout(timeoutMs),
    }
    if (payload !== undefined) init.body = JSON.stringify(payload)
    const response = await fetchImpl(endpoint, init)
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      return { ok: false, error: body?.error || `shell control HTTP ${response.status}` }
    }
    return { ok: true, status: response.status, body }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** Read the stored Bot config (GET /bot/config). Secrets arrive as `apiKeySet`. */
export async function readBotConfig(options = {}) {
  const reply = await shellJsonRequest('GET', SHELL_PATHS.config, undefined, options)
  if (!reply.ok) return reply
  const config = reply.body?.config
  if (!config || typeof config !== 'object') return { ok: false, error: 'shell returned no config' }
  return { ok: true, config }
}

/**
 * Persist a merged Bot config edit (PUT /bot/config).
 *
 * The shell merges an edit over the stored document, so callers pass the
 * sections they own (persona / llm / voice / approval / behavior). An empty
 * string apiKey keeps the stored secret — the pet never reads keys back.
 */
export async function updateBotConfig(edit, options = {}) {
  const reply = await shellJsonRequest('PUT', SHELL_PATHS.config, edit || {}, options)
  if (!reply.ok) return reply
  return { ok: true, config: reply.body?.config ?? null }
}

/** Probe the configured LLM route through the shell (POST /bot/test/llm). */
export async function testLlmConnection(llm, options = {}) {
  const reply = await shellJsonRequest(
    'POST',
    SHELL_PATHS.testLlm,
    { llm: llm && typeof llm === 'object' ? llm : {} },
    { timeoutMs: 15000, ...options },
  )
  if (!reply.ok) return reply
  return { ok: true, result: reply.body?.result ?? null }
}

/** Probe the configured voice provider through the shell (POST /bot/test/voice). */
export async function testVoiceConnection(voice, options = {}) {
  const reply = await shellJsonRequest(
    'POST',
    SHELL_PATHS.testVoice,
    { voice: voice && typeof voice === 'object' ? voice : {} },
    { timeoutMs: 15000, ...options },
  )
  if (!reply.ok) return reply
  return { ok: true, result: reply.body?.result ?? null }
}

/** Voice gateway runtime status (GET /bot/status) for readable error bubbles. */
export async function readBotRuntimeStatus(options = {}) {
  const reply = await shellJsonRequest('GET', SHELL_PATHS.status, undefined, options)
  if (!reply.ok) return reply
  return { ok: true, status: reply.body?.status ?? null }
}

// ---- bridge control (DSH host-integration HTTP bridge) ----
//
// The bridge descriptor (port + bearer token) is written by the shell next to
// DSH_HOME/bot/bridge.json. The pet already polls /events with it; pausing a
// running turn uses the same token against POST /cancel.

export function bridgeControlEndpoint(descriptor, path) {
  if (!descriptor?.port || !descriptor?.token) throw new TypeError('bridge descriptor is incomplete')
  const suffix = String(path || '')
  if (!suffix.startsWith('/')) throw new TypeError('bridge control path must start with /')
  return `http://127.0.0.1:${Math.floor(Number(descriptor.port))}${suffix}`
}

/**
 * POST one control request to the DSH bridge. Never throws; the pet keeps
 * animating if DSH is restarting.
 */
export async function postBridgeControl(descriptor, path, payload, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 2500,
} = {}) {
  let endpoint
  try {
    endpoint = bridgeControlEndpoint(descriptor, path)
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
  if (typeof fetchImpl !== 'function') return { ok: false, error: 'fetch is unavailable' }
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) return { ok: false, error: body?.error || `bridge HTTP ${response.status}` }
    return { ok: true, result: body }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

/** Pause the running DSH turn: POST /cancel on the bridge (bearer token). */
export async function requestBridgeCancel(descriptor, options = {}) {
  return postBridgeControl(descriptor, '/cancel', {}, options)
}
