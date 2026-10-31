/**
 * F1 host-restart acceptance (closure 2026-10-31, plan §4 F1):
 *   "Host 重启后 unknown 不猜、不重放、不自动重放任务" and "重连不自动重放任务".
 *
 * Evidence level: real Host integration plugin + real DSH Session/Approval + mock provider,
 * two sequential Host processes sharing one isolated DSH_HOME.
 *
 * Two distinct restart semantics are pinned here, because conflating them would misreport
 * the product:
 *   1. abrupt restart (crash, no teardown): the durable state as of the crash still has an
 *      open interaction -> the restarted Host must refuse to turn a late decision into an
 *      official one (unknown receipt, never replayed). The snapshot@1 interactions section
 *      has no `unknown` list, so this safety result is observable through the receipt, not
 *      through a recovered-unknown projection; that projection gap is documented, not hidden.
 *   2. graceful shutdown: the Host tears down the interaction mirror first, which settles the
 *      pending interaction as `cancelled` and persists that known outcome; the restarted Host
 *      must show it as a known cancelled result (not `unknown`) and still never replay it.
 */
import { it, expect, vi } from 'vitest'
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

const PROTOCOL = 'dsh-bot-v1'
type HostPending = { id: string; kind: string; semanticRevision?: number }
type HostResolved = { id: string; outcome?: string }
type HostInteractions = { pending: HostPending[]; recentlyResolved?: HostResolved[] }
type HostSnapshot = { interactions: HostInteractions; execution: { state?: string } }
type HostHealth = { ok?: boolean }
type CommandReceipt = { status?: string; result?: { outcome?: string }; error?: { code?: string } }

const wait = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
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

type Host = {
  ctx: Context
  adapter: InstanceType<typeof MockAdapter>
  base: string
  token: string
  hostEpoch: string
  snapshot: () => Promise<HostSnapshot>
  post: (path: string, body?: object) => Promise<Response>
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
  const home = mkdtempSync(join(tmpdir(), 'f1-restart-'))
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
  expect((await facts('写一个文件到工作区外', 'restart-1')).status).toBe(200)
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
  // The durable state is written when the interaction is presented; wait for that record so
  // both the crash and the graceful case start from the product's own persisted state.
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

it('surfaces an unresolved approval as unknown after an abrupt Host restart and never replays it', async () => {
  let setup: PendingSetup | null = null
  let hostB: Host | null = null
  try {
    setup = await setupPendingApproval()
    const interactionId = setup.interactionId
    // Simulate an abrupt process death: keep the durable state exactly as it was while the
    // interaction was still open. A graceful dispose would settle it as `cancelled` first.
    const stateAtCrash = readFileSync(setup.registryFile)
    await setup.host.ctx.fiber.dispose()
    writeFileSync(setup.registryFile, stateAtCrash, { mode: 0o600 })

    hostB = await startHost({ home: setup.home, workspaceDir: setup.workspaceDir, memoryUrl: setup.memory.url, responses: [textResponse('restarted')] })
    const afterRestart = await hostB.snapshot()
    // Safety: the stale approval is not presented as an actionable pending request, and the
    // projection does not fabricate a success/failure claim for it.
    expect(afterRestart.interactions.pending).toEqual([])
    expect((afterRestart.interactions.recentlyResolved ?? []).some(item => item.id === interactionId)).toBe(false)
    // Documented projection gap (pre-existing, not introduced by the safety changes): the
    // snapshot@1 interactions section has no `unknown` list, so a crashed approval cannot be
    // shown to the user. The registry still recovers it as unknown, which the late-decision
    // receipt below proves. Tracked as a non-safety observability gap in F1-MAPPING.md §5.
    expect(Object.prototype.hasOwnProperty.call(afterRestart.interactions, 'unknown')).toBe(false)
    expect(['idle', 'unknown', 'starting'].includes(String(afterRestart.execution.state))).toBe(true)
    expect(afterRestart.execution.state).not.toBe('working')

    // A late/renewed decision for that interaction must report unknown and never fabricate an
    // official decision (this is the registry-recovered `unknown` surfaced through the receipt).
    const late = await hostB.post('/v2/command', {
      protocolVersion: PROTOCOL, commandId: randomUUID(), hostEpoch: hostB.hostEpoch,
      sourceConnectionId: 'desktop', sessionId: null, type: 'interaction.resolve',
      payload: { interactionId, semanticRevision: setup.semanticRevision, decision: 'allowed-once' },
    })
    const lateBody = await late.json() as CommandReceipt
    expect(String(lateBody.status)).toBe('unknown')
    expect(lateBody.result?.outcome).toBe('unknown')
    expect(String(lateBody.error?.code ?? '')).toContain('UNKNOWN')
    // The pending tool call was never executed: no side effect, no new model request.
    expect(existsSync(setup.target)).toBe(false)
    expect(hostB.adapter.requests.length).toBe(0)
    const health = await (await fetch(hostB.base + '/health', { headers: { authorization: `Bearer ${hostB.token}` } })).json() as HostHealth
    expect(health.ok).toBe(true)
  } finally {
    await teardown(setup, hostB)
  }
}, 120000)

it('a graceful Host restart persists the pending approval as known-cancelled and never replays it', async () => {
  let setup: PendingSetup | null = null
  let hostB: Host | null = null
  try {
    setup = await setupPendingApproval()
    const interactionId = setup.interactionId
    await setup.host.ctx.fiber.dispose()
    // Graceful teardown settles the interaction mirror first, so the persisted record is a
    // KNOWN cancellation rather than an unknown outcome.
    const persisted = JSON.parse(readFileSync(setup.registryFile, 'utf8')) as {
      data?: { interactions?: Record<string, { state?: string }> }
    }
    expect(persisted?.data?.interactions?.[interactionId]?.state).toBe('cancelled')

    hostB = await startHost({ home: setup.home, workspaceDir: setup.workspaceDir, memoryUrl: setup.memory.url, responses: [textResponse('restarted')] })
    const afterRestart = await hostB.snapshot()
    expect(afterRestart.interactions.pending).toEqual([])
    expect(Object.prototype.hasOwnProperty.call(afterRestart.interactions, 'unknown')).toBe(false)
    const known = (afterRestart.interactions.recentlyResolved ?? []).find(item => item.id === interactionId)
    if (known === undefined) throw new Error('the known cancelled interaction must stay inspectable after restart')
    expect(known.outcome).toBe('cancelled')
    // Still no replay: no side effect and no new model request after the restart.
    expect(existsSync(setup.target)).toBe(false)
    expect(hostB.adapter.requests.length).toBe(0)
    const health = await (await fetch(hostB.base + '/health', { headers: { authorization: `Bearer ${hostB.token}` } })).json() as HostHealth
    expect(health.ok).toBe(true)
  } finally {
    await teardown(setup, hostB)
  }
}, 120000)
