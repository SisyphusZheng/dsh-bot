/**
 * R2 unknown-interaction user visibility (closure 2026-10-31, plan §5.2 / F1 DEFERRED gap).
 *
 * F1 proved the safety half at the registry layer: after a crash/restart an unconfirmed
 * approval is never replayed and a late decision reports `unknown`. It also recorded the
 * parity gap that `snapshot@1` never projected `unknown`, so the user could neither see
 * "the result is unconfirmed" nor get a safe recovery entry. This spec pins the closure:
 *
 *   Part 1 (pure projection): the real product pet surface (`companion-presentation.mjs`)
 *     renders the Host's warning notice as one Chinese "result unconfirmed" bubble with the
 *     safe "打开主窗口确认" action, never as success/cancel/idle, and the action only opens
 *     the main window (it never re-answers the interaction). Old snapshots without the
 *     additive field keep applying.
 *   Part 2 (real Host): two sequential Host processes sharing one isolated DSH_HOME. A crash
 *     restart projects the stale approval in `interactions.unknown` (never as pending or
 *     resolved) and announces the warning notice; that real snapshot drives the real bubble
 *     hint; a late decision stays `unknown`, with no side effect and no model request. A
 *     graceful restart persists a KNOWN cancellation and shows no unknown hint.
 *
 * Evidence level: real Host integration plugin + real DSH Session/Approval + mock provider,
 * plus the real pet presentation module. No Electron window/TTS pixels are involved.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { createServer } from 'node:http'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { MockAdapter, toolCallResponse, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createCompanionPresentation } from '../../../product/pet/src/companion-presentation.mjs'

// The pet runtime module only exposes pure copy helpers for this spec; Electron is never
// instantiated, so the minimal stub only has to satisfy the import bindings.
vi.mock('electron', () => ({
  app: { dock: { isVisible: () => true } },
  BrowserWindow: class { webContents = {} },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }),
    getAllDisplays: () => [],
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 0, height: 0 } }),
  },
  session: { fromPartition: () => ({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} }) },
  systemPreferences: {},
  Menu: { buildFromTemplate: () => ({ popup: () => {} }) },
  powerMonitor: { getSystemIdleTime: () => 0 },
  globalShortcut: { register: () => true, unregister: () => {} },
  dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
  Notification: { isSupported: () => false },
}))
import { unknownInteractionNotice } from '../src/pet-runtime.ts'

const PROTOCOL = 'dsh-bot-v1'
type HostPending = { id: string; kind: string; semanticRevision?: number }
type HostResolved = { id: string; outcome?: string }
type HostUnknown = {
  id: string
  kind?: string | null
  sessionId?: string | null
  reason?: string | null
  at?: string | null
  action?: { id?: string; label?: string }
}
type HostNotice = {
  id?: string
  kind?: string
  severity?: string
  text?: string
  diagnosticId?: string | null
  actions?: { id?: string; label?: string }[]
}
type HostInteractions = { pending: HostPending[]; recentlyResolved?: HostResolved[]; unknown?: HostUnknown[] }
type HostSnapshot = {
  interactions: HostInteractions
  execution: { state?: string }
  presentation?: { displayMode?: string }
  notices?: HostNotice[]
}
type HostHealth = { ok?: boolean }
type CommandReceipt = { status?: string; result?: { outcome?: string }; error?: { code?: string } }

const wait = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
}

type BubblePayload = { text?: string; kind?: string; secondary?: { id?: string; label?: string }[]; clickThrough?: boolean }
type Projection = {
  presentation: ReturnType<typeof createCompanionPresentation>
  shown: BubblePayload[]
  commands: unknown[][]
  hidden: () => number
  apply: (body: object) => void
  click: (action: object) => Promise<void>
  stop: () => void
}

function makeProjection(): Projection {
  const shown: BubblePayload[] = []
  const commands: unknown[][] = []
  let hidden = 0
  const timers = new Map<number, () => void>()
  let timerId = 0
  const presentation = createCompanionPresentation({
    show: (payload) => { shown.push(payload as BubblePayload) },
    hide: () => { hidden += 1 },
    animate: () => {},
    send: async (type: string, payload?: object) => {
      commands.push(payload === undefined ? [type] : [type, payload])
      return { protocolVersion: 'dsh-bot-v1', commandId: 'cmd', hostEpoch: 'epoch-a', status: 'accepted', result: {}, error: null }
    },
    setTimer: (fn: () => void) => { timerId += 1; timers.set(timerId, fn); return timerId },
    clearTimer: (id: number) => { timers.delete(id) },
  })
  return {
    presentation,
    shown,
    commands,
    hidden: () => hidden,
    apply(body) { expect(presentation.applySnapshot(body).applied).toBe(true) },
    async click(action) { await presentation.action(action) },
    stop() { try { presentation.stop() } catch { /* already stopped */ } },
  }
}

/** The additive snapshot@1 shape the Host now emits when an interaction is unconfirmed. */
function unknownSnapshot(options: {
  withUnknown?: boolean
  withNotice?: boolean
  snapshotSeq?: number
} = {}): Record<string, unknown> {
  const { withUnknown = true, withNotice = true, snapshotSeq = 4 } = options
  const unknown = [{
    id: 'ix-1',
    kind: 'approval',
    sessionId: 's',
    reason: 'HOST_RESTARTED',
    at: '2026-10-31T03:00:00.000Z',
    action: { id: 'open-main', label: '打开主窗口确认' },
  }]
  return {
    protocolVersion: 'dsh-bot-v1',
    schema: 'snapshot@1',
    hostEpoch: 'epoch-a',
    snapshotSeq,
    identity: { sessionId: 's', hostPid: 99, botSessionReady: true, workspace: '/w' },
    capture: { state: 'off', mode: 'hold', captureId: null, preview: null },
    playback: { state: 'idle', playbackId: null, sourceTurnId: null, style: 'full' },
    execution: {
      state: 'idle', sessionId: 's', requestId: null, clientTurnId: null, turn: null,
      startedAt: null, inputSource: 'desktop', lastTurn: { turn: null, terminal: null, reason: null },
    },
    interactions: {
      focusedId: null,
      pending: [],
      drafts: {},
      recentlyResolved: [],
      ...(withUnknown ? { unknown } : {}),
    },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: withNotice
      ? [{
        id: 'notice-unknown',
        kind: 'warning',
        severity: 'warning',
        text: '上次审批或回答的结果尚未确认；请打开主窗口核实，不会自动重试。',
        diagnosticId: 'INTERACTION_UNKNOWN',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        actions: [{ id: 'open-main', label: '打开主窗口确认' }],
      }]
      : [],
    presentation: {
      displayMode: withUnknown ? 'unknown' : 'idle',
      priority: ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices'],
      bubble: { visible: false, requestId: null, kind: null },
      bubblePolicy: { placement: 'above', anchorGapPx: 24 },
    },
  }
}

describe('R2 unknown interaction user visibility (projection)', () => {
  it('shows one Chinese "result unconfirmed" hint instead of success or plain idle', () => {
    const projection = makeProjection()
    try {
      projection.apply(unknownSnapshot())
      const bubble = projection.shown.at(-1)
      expect(bubble?.kind).toBe('status')
      expect(String(bubble?.text)).toContain('尚未确认')
      expect(String(bubble?.text)).not.toMatch(/已成功|已完成|已取消|已停止/)
      expect(bubble?.secondary).toEqual([{ id: 'open', label: '打开主窗口确认' }])
      expect(projection.hidden()).toBe(0)
    } finally { projection.stop() }
  })

  it('the safe action opens the main window and never re-answers the interaction', async () => {
    const projection = makeProjection()
    try {
      projection.apply(unknownSnapshot())
      await projection.click({ type: 'secondary', id: 'open', label: '打开主窗口确认' })
      expect(projection.commands).toEqual([['open']])
      expect(projection.commands.flat().some(value => typeof value === 'string' && value.startsWith('interaction.'))).toBe(false)
      expect(projection.commands.flat().some(value => typeof value === 'string' && value === 'submit')).toBe(false)
    } finally { projection.stop() }
  })

  it('an older Host snapshot without the additive field still applies, and an old client ignores it', () => {
    const projection = makeProjection()
    try {
      // Exactly the pre-R2 shape: no `interactions.unknown`, no unknown notice.
      projection.apply(unknownSnapshot({ withUnknown: false, withNotice: false }))
      expect(projection.shown).toEqual([])
      // A newer Host's additive field is harmless to a client that only knows pending.
      projection.apply(unknownSnapshot({ withNotice: false, snapshotSeq: 5 }))
      expect(projection.shown).toEqual([])
    } finally { projection.stop() }
  })

  it('derives the same warning copy from the snapshot for the inspect-task entry', () => {
    expect(unknownInteractionNotice(null)).toBeNull()
    expect(unknownInteractionNotice({ interactions: { unknown: [] } })).toBeNull()
    const notice = unknownInteractionNotice({ interactions: { unknown: [{ id: 'ix-1' }] } })
    expect(notice).not.toBeNull()
    expect(notice?.text).toContain('尚未确认')
    expect(notice?.text).not.toMatch(/已成功|已完成|已取消/)
    expect(notice?.secondary).toEqual([{ id: 'open', label: '打开主窗口确认' }])
  })
})

type Host = {
  ctx: Context
  adapter: InstanceType<typeof MockAdapter>
  base: string
  token: string
  hostEpoch: string
  snapshot: () => Promise<HostSnapshot>
  post: (path: string, body?: object) => Promise<Response>
}

async function memoryFixture(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* drain */ }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/search' ? { ok: true, hits: [] } : req.url === '/digest' ? { ok: true, digest: { text: '' } } : { ok: true }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no memory fixture address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() }) },
  }
}

async function startHost({ home, responses, workspaceDir, memoryUrl }: {
  home: string
  responses: unknown[]
  workspaceDir: string
  memoryUrl: string
}): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  ctx.provide('shell', { sandboxMode: 'danger-full-access', resolve() { throw new Error('unused') }, run() { throw new Error('unused') }, start() { throw new Error('unused') } })
  await ctx.plugin(PermissionPresets, { presets: { 'bot-outside-write': { sandbox: 'danger-full-access', approval: 'ask' } }, defaultPreset: 'bot-outside-write' })
  const adapter = new MockAdapter(responses as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  vi.stubEnv('DSH_BOT_RUNTIME_ROOT', resolve('apps/cli'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NISSE_DSH_LLM_ENTRY', resolve('packages/llm/llm/lib/index.js'))
  const integration = await import(pathToFileURL(resolve('nisse/packages/host-integration/lib/index.js')).href)
  await ctx.plugin(integration, {
    provider: 'mock', model: 'mock', requirePreset: false, permissionPreset: 'bot-outside-write',
    memoryUrl, memoryToken: 'fixture', workspaceDir,
  })
  const bridgeFile = join(home, 'bot/bridge.json')
  await wait(() => existsSync(bridgeFile))
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port: number; token: string; hostEpoch: string }
  const base = `http://127.0.0.1:${bridge.port}`
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  return {
    ctx, adapter, base, token: bridge.token, hostEpoch: bridge.hostEpoch,
    snapshot: async () => (await (await fetch(base + '/v2/snapshot', { headers })).json()) as HostSnapshot,
    post: (path: string, body: object = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }),
  }
}

type PendingSetup = {
  home: string
  target: string
  workspaceDir: string
  registryFile: string
  memory: { url: string; close: () => Promise<void> }
  host: Host
  interactionId: string
  semanticRevision: number
}

/** Start a Host, queue one outside-workspace write, and stop once its approval is pending. */
async function setupPendingApproval(): Promise<PendingSetup> {
  const home = mkdtempSync(join(tmpdir(), 'r2-unknown-'))
  const target = join(home, 'outside.txt')
  const workspaceDir = join(home, 'workspace')
  const memory = await memoryFixture()
  const host = await startHost({ home, workspaceDir, memoryUrl: memory.url, responses: [toolCallResponse('write-1', 'write', { path: target }), textResponse('finished')] })
  host.ctx.tools.register(defineContentToolFixture({
    name: 'write', description: 'write a file', parameters: { path: { type: 'string' } },
    execute: async () => { writeFileSync(target, 'approved'); return [{ type: 'text', text: 'written' }] },
  }))
  expect((await host.post('/sessions/create')).status).toBe(200)
  const command = (extra: Record<string, unknown>) => ({
    protocolVersion: PROTOCOL, commandId: randomUUID(), hostEpoch: host.hostEpoch,
    sourceConnectionId: 'worker', sessionId: null, type: 'voice.facts', payload: {}, ...extra,
  })
  const facts = (text: string, utteranceId: string) => host.post('/v2/command', command({
    payload: {
      connectionId: 'worker-restart', capture: { captureId: 'cap-' + utteranceId, mode: 'hold', state: 'closing' },
      items: [{ kind: 'asr.final', itemId: 'item-' + utteranceId, utteranceId, revision: 0, text, confidence: null }],
      release: { captureId: 'cap-' + utteranceId, reason: 'release' },
    },
  }))
  expect((await facts('写一个文件到工作区外', 'r2-1')).status).toBe(200)
  await wait(async () => {
    const snapshot = await host.snapshot()
    return Array.isArray(snapshot.interactions?.pending) && snapshot.interactions.pending.length > 0
  })
  const pending = (await host.snapshot()).interactions.pending[0]
  if (pending === undefined) throw new Error('the queued write did not surface a pending approval')
  expect(pending.kind).toBe('approval')
  expect((await host.snapshot()).execution.state).toBe('working')
  const registryFile = join(home, 'bot/beta2-registry.json')
  const interactionId = String(pending.id)
  // The durable record is written when the interaction is presented; wait for it so both the
  // crash and the graceful case start from the product's own persisted state.
  await wait(() => existsSync(registryFile) && readFileSync(registryFile, 'utf8').includes(interactionId))
  return { home, target, workspaceDir, registryFile, memory, host, interactionId, semanticRevision: Number(pending.semanticRevision) }
}

async function teardown(setup: PendingSetup | null, hostB: Host | null): Promise<void> {
  if (setup) {
    try { await setup.host.ctx.fiber.dispose() } catch { /* already disposed */ }
    await setup.memory.close()
    rmSync(setup.home, { recursive: true, force: true })
  }
  if (hostB) { try { await hostB.ctx.fiber.dispose() } catch { /* already disposed */ } }
  vi.unstubAllEnvs()
}

describe('R2 unknown interaction user visibility (real Host)', () => {
  it('a crash-restarted Host projects the approval as unknown and the real UI shows the unconfirmed hint', async () => {
    let setup: PendingSetup | null = null
    let hostB: Host | null = null
    try {
      setup = await setupPendingApproval()
      const interactionId = setup.interactionId
      // Abrupt death: keep the durable state exactly as it was while the interaction was open.
      const stateAtCrash = readFileSync(setup.registryFile)
      await setup.host.ctx.fiber.dispose()
      writeFileSync(setup.registryFile, stateAtCrash, { mode: 0o600 })

      hostB = await startHost({ home: setup.home, workspaceDir: setup.workspaceDir, memoryUrl: setup.memory.url, responses: [textResponse('restarted')] })
      const afterRestart = await hostB.snapshot()
      // No fabricated outcome: not pending, not resolved/cancelled.
      expect(afterRestart.interactions.pending).toEqual([])
      expect((afterRestart.interactions.recentlyResolved ?? []).some(item => item.id === interactionId)).toBe(false)
      const unknown = (afterRestart.interactions.unknown ?? []).filter(item => item.id === interactionId)
      expect(unknown.length).toBe(1)
      expect(['HOST_RESTARTED', 'INTERACTION_UNKNOWN_AFTER_RESTART']).toContain(String(unknown[0]?.reason))
      expect(unknown[0]?.action).toEqual({ id: 'open-main', label: '打开主窗口确认' })
      // Not ordinary idle, and the user-visible hint exists.
      expect(afterRestart.presentation?.displayMode).toBe('unknown')
      const hints = (afterRestart.notices ?? []).filter(notice => notice.diagnosticId === 'INTERACTION_UNKNOWN')
      expect(hints.length).toBe(1)
      expect(String(hints[0]?.text)).toContain('尚未确认')
      expect(String(hints[0]?.text)).not.toMatch(/已成功|已完成|已取消/)
      expect(hints[0]?.actions).toEqual([{ id: 'open-main', label: '打开主窗口确认' }])

      // The real Host snapshot drives the real pet bubble: one warning + the safe action.
      const projection = makeProjection()
      try {
        projection.apply(afterRestart)
        const bubble = projection.shown.at(-1)
        expect(String(bubble?.text)).toContain('尚未确认')
        expect(bubble?.secondary).toEqual([{ id: 'open', label: '打开主窗口确认' }])
        await projection.click({ type: 'secondary', id: 'open', label: '打开主窗口确认' })
        expect(projection.commands).toEqual([['open']])
      } finally { projection.stop() }

      // A late/renewed decision still reports unknown and never becomes an official decision.
      const late = await hostB.post('/v2/command', {
        protocolVersion: PROTOCOL, commandId: randomUUID(), hostEpoch: hostB.hostEpoch,
        sourceConnectionId: 'desktop', sessionId: null, type: 'interaction.resolve',
        payload: { interactionId, semanticRevision: setup.semanticRevision, decision: 'allowed-once' },
      })
      const lateBody = await late.json() as CommandReceipt
      expect(String(lateBody.status)).toBe('unknown')
      expect(lateBody.result?.outcome).toBe('unknown')
      expect(String(lateBody.error?.code ?? '')).toContain('UNKNOWN')
      // No replay and no side effect after the restart.
      expect(existsSync(setup.target)).toBe(false)
      expect(hostB.adapter.requests.length).toBe(0)
      const health = await (await fetch(hostB.base + '/health', { headers: { authorization: `Bearer ${hostB.token}` } })).json() as HostHealth
      expect(health.ok).toBe(true)
    } finally {
      await teardown(setup, hostB)
    }
  }, 120000)

  it('a graceful restart persists a known cancellation and shows no unknown hint', async () => {
    let setup: PendingSetup | null = null
    let hostB: Host | null = null
    try {
      setup = await setupPendingApproval()
      const interactionId = setup.interactionId
      await setup.host.ctx.fiber.dispose()
      const persisted = JSON.parse(readFileSync(setup.registryFile, 'utf8')) as {
        data?: { interactions?: Record<string, { state?: string }> }
      }
      expect(persisted?.data?.interactions?.[interactionId]?.state).toBe('cancelled')

      hostB = await startHost({ home: setup.home, workspaceDir: setup.workspaceDir, memoryUrl: setup.memory.url, responses: [textResponse('restarted')] })
      const afterRestart = await hostB.snapshot()
      expect(afterRestart.interactions.pending).toEqual([])
      expect(afterRestart.interactions.unknown ?? []).toEqual([])
      expect((afterRestart.notices ?? []).some(notice => notice.diagnosticId === 'INTERACTION_UNKNOWN')).toBe(false)
      const known = (afterRestart.interactions.recentlyResolved ?? []).find(item => item.id === interactionId)
      if (known === undefined) throw new Error('the known cancelled interaction must stay inspectable after restart')
      expect(known.outcome).toBe('cancelled')
      expect(afterRestart.presentation?.displayMode).not.toBe('unknown')
      // The UI must not render an unconfirmed hint for a known cancellation.
      const projection = makeProjection()
      try {
        projection.apply(afterRestart)
        expect(projection.shown.some(payload => String(payload.text).includes('尚未确认'))).toBe(false)
      } finally { projection.stop() }
      // Still no replay: no side effect and no new model request after the restart.
      expect(existsSync(setup.target)).toBe(false)
      expect(hostB.adapter.requests.length).toBe(0)
      const health = await (await fetch(hostB.base + '/health', { headers: { authorization: `Bearer ${hostB.token}` } })).json() as HostHealth
      expect(health.ok).toBe(true)
    } finally {
      await teardown(setup, hostB)
    }
  }, 120000)
})
