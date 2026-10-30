/**
 * beta2 kernel integration: real DSH Host plugin + Mock Adapter, v2 snapshot/event/command protocol.
 *
 * Evidence level: real Host process wiring + real DSH Session/Tool/Approval services + mock LLM.
 * It proves the v2 transport, one official decision, idempotent receipts and main-window
 * observation; native window evidence is a separate gate.
 */
import { it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
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
const wait = async (condition: () => boolean | Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 12000
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
}

type Bridge = { port: number; token: string; hostEpoch: string }
type Snapshot = Record<string, any>

type Host = { ctx: Context; adapter: InstanceType<typeof MockAdapter> }

async function startHost({ responses, workspaceDir, memoryUrl }: { responses: unknown[]; workspaceDir: string; memoryUrl: string }): Promise<Host> {
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
  const integration = await import(pathToFileURL(resolve('nisse/packages/host-integration/lib/index.js')).href)
  await ctx.plugin(integration, {
    provider: 'mock', model: 'mock', requirePreset: false, permissionPreset: 'bot-outside-write',
    memoryUrl, memoryToken: 'fixture', workspaceDir,
  })
  return { ctx, adapter }
}

it('reaches the v2 handshake, idempotent receipts, one official decision and main-window observation', async () => {
  const home = mkdtempSync(join(tmpdir(), 'beta2-kernel-'))
  const target = join(home, 'outside.txt')
  const workspaceDir = join(home, 'workspace')
  const memory = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url === '/search' ? { ok: true, hits: [] } : req.url === '/digest' ? { ok: true, digest: { text: '' } } : { ok: true }))
  })
  await new Promise<void>(done => memory.listen(0, '127.0.0.1', done))
  const address = memory.address()
  if (!address || typeof address === 'string') throw new Error('No memory fixture address')
  vi.stubEnv('DSH_BOT_RUNTIME_ROOT', resolve('apps/cli'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NISSE_DSH_LLM_ENTRY', resolve('packages/llm/llm/lib/index.js'))
  let host: Host | null = null
  try {
    host = await startHost({
      workspaceDir,
      memoryUrl: `http://127.0.0.1:${address.port}`,
      responses: [
        toolCallResponse('write-1', 'write', { path: target }),
        textResponse('finished'),
        textResponse('recalled'),
      ],
    })
    host.ctx.tools.register(defineContentToolFixture({
      name: 'write', description: 'write a file', parameters: { path: { type: 'string' } },
      execute: async () => {
        writeFileSync(target, 'approved')
        return [{ type: 'text', text: 'written' }]
      },
    }))
    const bridgeFile = join(home, 'bot/bridge.json')
    await wait(() => existsSync(bridgeFile))
    const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as Bridge
    const base = `http://127.0.0.1:${bridge.port}`
    const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
    const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    const getSnapshot = async (): Promise<Snapshot> => (await (await fetch(base + '/v2/snapshot', { headers })).json()) as Snapshot
    const command = (extra: Record<string, unknown>) => ({
      protocolVersion: PROTOCOL, commandId: randomUUID(), hostEpoch: bridge.hostEpoch,
      sourceConnectionId: 'desktop', sessionId: null, type: 'task.status', payload: {}, ...extra,
    })

    expect((await post('/sessions/create', {})).status).toBe(200)
    const snapshot = await getSnapshot()
    expect(snapshot.protocolVersion).toBe(PROTOCOL)
    expect(snapshot.schema).toBe('snapshot@1')
    expect(snapshot.hostEpoch).toBe(bridge.hostEpoch)
    expect(Number.isInteger(snapshot.snapshotSeq)).toBe(true)
    for (const section of ['identity', 'connection', 'capture', 'playback', 'execution', 'interactions', 'queue', 'notices', 'presentation']) {
      expect(snapshot[section], section).toBeTruthy()
    }
    const eventsResponse = await fetch(base + `/v2/events?after=${snapshot.snapshotSeq}`, { headers })
    expect(eventsResponse.status).toBe(200)
    const events = await eventsResponse.json() as { events: unknown[]; resyncRequired: boolean }
    expect(events.resyncRequired).toBe(false)

    const stale = await post('/v2/command', command({ hostEpoch: 'stale-epoch' }))
    expect(stale.status).toBe(409)
    expect(((await stale.json()) as any).error.code).toBe('STALE_HOST_EPOCH')
    const wrongProtocol = await post('/v2/command', command({ protocolVersion: 'v0' }))
    expect(wrongProtocol.status).toBe(426)

    // Same commandId + same content returns the original receipt (no re-execution).
    const key = randomUUID()
    const first = await post('/v2/command', command({ commandId: key }))
    const firstReceipt = (await first.json()) as any
    expect(first.status).toBe(200)
    expect(firstReceipt.commandId).toBe(key)
    expect(firstReceipt.status).toBe('accepted')
    const replay = await post('/v2/command', command({ commandId: key }))
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as any).status).toBe(firstReceipt.status)
    const conflict = await post('/v2/command', command({ commandId: key, type: 'queue.list' }))
    expect(conflict.status).toBe(409)
    expect(((await conflict.json()) as any).error.code).toBe('IDEMPOTENCY_CONFLICT')

    // A voice final utterance is routed by the Host and admitted exactly once.
    const voice = (type: string, payload: object, commandId = randomUUID()) => post('/v2/command', command({ commandId, sourceConnectionId: 'worker', type, payload }))
    const facts = await voice('voice.facts', {
      connectionId: 'worker-test', capture: { captureId: 'cap-1', mode: 'hold', state: 'closing' },
      items: [{ kind: 'asr.final', itemId: 'item-1', utteranceId: 'utt-1', revision: 0, text: '写一个文件到工作区外', confidence: null }],
      release: { captureId: 'cap-1', reason: 'release' },
    })
    expect(facts.status).toBe(200)
    let withApproval: Snapshot | null = null
    const pendingApproval = async (): Promise<Snapshot | null> => {
      const value = await getSnapshot()
      return Array.isArray(value.interactions?.pending) && value.interactions.pending.length ? value : null
    }
    await wait(async () => {
      if (withApproval === null) withApproval = await pendingApproval()
      return withApproval !== null
    })
    const approval = withApproval!.interactions.pending[0]
    expect(approval.kind).toBe('approval')
    expect(withApproval!.execution.state).toBe('working')
    const decision = (commandId: string, value: string, semanticRevision: number) => command({
      commandId, sourceConnectionId: 'worker', type: 'interaction.resolve',
      payload: { interactionId: approval.id, semanticRevision, decision: value },
    })
    const resolved = await post('/v2/command', decision(randomUUID(), 'allowed-once', approval.semanticRevision))
    expect(resolved.status).toBe(200)
    const resolvedBody = (await resolved.json()) as any
    if (!['resolved', 'accepted'].includes(resolvedBody.status)) console.log('RESOLVE-RECEIPT', JSON.stringify(resolvedBody))
    expect(['resolved', 'accepted']).toContain(resolvedBody.status)
    await wait(() => existsSync(target))
    // Replaying the same decision key is a receipt replay, never a second official decision.
    const replayKey = randomUUID()
    const firstDecision = await post('/v2/command', decision(replayKey, 'allowed-once', approval.semanticRevision))
    expect(firstDecision.status).toBe(200)
    const replayDecision = await post('/v2/command', decision(replayKey, 'allowed-once', approval.semanticRevision))
    expect(replayDecision.status).toBe(200)
    const replayDecisionBody = (await replayDecision.json()) as any
    expect(['resolved', 'accepted']).toContain(replayDecisionBody.status)
    await wait(async () => {
      const value = await getSnapshot()
      return value.execution?.state === 'idle' && value.interactions.pending.length === 0
    })

    // Main-window initiated work is observed; the Host does not duplicate-submit.
    const health = (await (await fetch(base + '/health')).json()) as any
    const agent = host.ctx.agents.get(health.agent.sessionId)
    if (!agent) throw new Error('No Bot agent')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '主窗口直接发起的任务' }] }))
    let observed = false
    await wait(async () => {
      const value = await getSnapshot()
      if (value.execution?.state === 'working' || value.execution?.state === 'submitting') {
        observed = value.execution.mainWindowTurn === true
        return observed
      }
      return false
    })
    expect(observed).toBe(true)
    await agent.whenIdle()
    const healthAfter = (await (await fetch(base + '/health')).json()) as any
    expect(healthAfter.ok).toBe(true)
    expect(JSON.stringify(healthAfter)).not.toMatch(/dsh-home|bridgeDir|workspaceDir/)
  } finally {
    if (host) await host.ctx.fiber.dispose()
    await new Promise<void>((done, reject) => { memory.close((error: Error | undefined) => error ? reject(error) : done()); memory.closeAllConnections() })
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)

it('routes mixed control + work through the Host without dropping the remaining task', async () => {
  const home = mkdtempSync(join(tmpdir(), 'beta2-control-'))
  const workspaceDir = join(home, 'workspace')
  const memory = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>((done) => memory.listen(0, '127.0.0.1', done))
  const address = memory.address()
  if (!address || typeof address === 'string') throw new Error('No memory fixture address')
  vi.stubEnv('DSH_BOT_RUNTIME_ROOT', resolve('apps/cli'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NISSE_DSH_LLM_ENTRY', resolve('packages/llm/llm/lib/index.js'))
  let host: Host | null = null
  try {
    host = await startHost({ workspaceDir, memoryUrl: `http://127.0.0.1:${address.port}`, responses: [textResponse('done'), textResponse('done again')] })
    const bridgeFile = join(home, 'bot/bridge.json')
    await wait(() => existsSync(bridgeFile))
    const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as Bridge
    const base = `http://127.0.0.1:${bridge.port}`
    const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
    const post = (path: string, body: object) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    const command = (extra: Record<string, unknown>) => ({
      protocolVersion: PROTOCOL, commandId: randomUUID(), hostEpoch: bridge.hostEpoch,
      sourceConnectionId: 'worker', sessionId: null, type: 'voice.facts', payload: {}, ...extra,
    })
    expect((await post('/sessions/create', {})).status).toBe(200)
    const facts = (text: string, utteranceId: string) => {
      const captureId = 'cap-' + utteranceId
      return post('/v2/command', command({
        payload: {
          connectionId: 'worker-control', capture: { captureId, mode: 'hold', state: 'closing' },
          items: [{ kind: 'asr.final', itemId: 'item-' + utteranceId, utteranceId, revision: 0, text, confidence: null }],
          release: { captureId, reason: 'release' },
        },
      }))
    }
    const snapshotSeq = async (): Promise<number> => (await (await fetch(base + '/v2/snapshot', { headers })).json() as Snapshot).snapshotSeq as number
    const eventsSince = async (after: number): Promise<any[]> => {
      const response = await fetch(base + `/v2/events?after=${after}&limit=2000`, { headers })
      const body = (await response.json()) as { events: any[]; resyncRequired: boolean }
      return body.resyncRequired ? [] : body.events
    }
    const playbackStopsSince = async (after: number): Promise<any[]> => (await eventsSince(after))
      .filter((event) => event.type === 'command' && event.data?.type === 'playback.stop')
    // 1) A stop control and the remaining work are each consumed exactly once.
    const base1 = await snapshotSeq()
    const mixed = await facts('停一下。然后写一篇八百字的小作文', 'mix-1')
    expect(mixed.status).toBe(200)
    expect(((await mixed.json()) as any).status).toBe('accepted')
    await wait(() => host!.adapter.requests.length === 1)
    expect(JSON.stringify(host!.adapter.requests[0])).toContain('八百字')
    await wait(async () => (await playbackStopsSince(base1)).length === 1)
    expect((await playbackStopsSince(base1)).length).toBe(1)
    await wait(async () => ((await (await fetch(base + '/v2/snapshot', { headers })).json()) as Snapshot).execution.state === 'idle')
    // 2) Negated stop phrases stay ordinary input and never emit a playback stop.
    const base2 = await snapshotSeq()
    const negated = await facts('不要停，继续讲', 'neg-1')
    expect(negated.status).toBe(200)
    await wait(() => host!.adapter.requests.length === 2)
    await new Promise((done) => setTimeout(done, 300))
    expect((await playbackStopsSince(base2)).length).toBe(0)
    await wait(async () => ((await (await fetch(base + '/v2/snapshot', { headers })).json()) as Snapshot).execution.state === 'idle')
    // 3) A pure stop never creates a turn.
    const base3 = await snapshotSeq()
    const stopOnly = await facts('停一下', 'stop-1')
    expect(stopOnly.status).toBe(200)
    await wait(async () => (await playbackStopsSince(base3)).length === 1)
    await new Promise((done) => setTimeout(done, 300))
    expect(host!.adapter.requests.length).toBe(2)
  } finally {
    if (host) await host.ctx.fiber.dispose()
    await new Promise<void>((done, reject) => { memory.close((error: Error | undefined) => error ? reject(error) : done()); memory.closeAllConnections() })
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}, 60000)
