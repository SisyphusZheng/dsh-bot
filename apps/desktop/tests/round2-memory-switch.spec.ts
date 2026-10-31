/**
 * Round-2 memory contract (closure 2026-10-31, plan §5 M1/M2 gap):
 *   1. memory OFF proves ZERO read/write traffic: no /digest, /search or /write request reaches
 *      the memory service, the model request carries no memory injection, and the Host reports
 *      the service as off (not as an error).
 *   2. switching memory ON live (product path: POST /config { memory: { url, token } }) restores
 *      recall + digest + end-of-turn episode writes against the same running Host.
 *   3. switching it OFF again returns to zero traffic without an error state.
 *   4. desktop status semantics: disabled => { enabled:false, phase:'disabled', error:'' };
 *      an enabled-but-broken payload is a distinct `failed` state with an explicit error.
 *
 * Evidence level: real Host integration + real DSH Session/AgentLoop + MockAdapter; the memory
 * service is an HTTP fixture that records every request (server-side observation instrument).
 */
import { it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import PermissionPresets from '@deepseek-ai/dsh-permission-presets'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { MemoryRuntime } from '../src/memory-runtime.ts'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SENTINEL = 'MEM-SENTINEL 偏好：下午喝一杯手冲咖啡'
type RecordedRequest = { method: string; path: string; body: Record<string, unknown> }
type MemoryFixture = { url: string; recorded: RecordedRequest[]; close: () => Promise<void> }
type HostHealth = { ok?: boolean; services?: { memory?: boolean }; agent?: { ready?: boolean; sessionId?: string } }
type HostSnapshot = { notices?: { text?: string }[] }

const wait = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
}

/** Memory service stub whose only job is to record every request it receives. */
async function startCountingFixture(): Promise<MemoryFixture> {
  const recorded: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += String(chunk)
    let body: Record<string, unknown> = {}
    try { body = raw === '' ? {} : JSON.parse(raw) as Record<string, unknown> } catch { body = { raw: raw.slice(0, 200) } }
    recorded.push({ method: String(req.method ?? ''), path: String(req.url ?? ''), body })
    res.setHeader('content-type', 'application/json')
    if (req.url === '/digest') res.end(JSON.stringify({ ok: true, digest: { text: SENTINEL } }))
    else if (req.url === '/search') res.end(JSON.stringify({ ok: true, hits: [{ text: SENTINEL, score: 1 }] }))
    else res.end(JSON.stringify({ ok: true }))
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no fixture address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    recorded,
    close: async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections() }) },
  }
}

type Host = {
  ctx: Context
  adapter: InstanceType<typeof MockAdapter>
  post: (path: string, body?: object) => Promise<Response>
  health: () => Promise<HostHealth>
  snapshot: () => Promise<HostSnapshot>
  ask: (text: string, expectedRequests: number) => Promise<void>
}

async function startHost({ home, workspaceDir, memoryUrl }: { home: string; workspaceDir: string; memoryUrl?: string }): Promise<Host> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  ctx.provide('shell', {
    sandboxMode: 'danger-full-access',
    resolve() { throw new Error('unused') },
    run() { throw new Error('unused') },
    start() { throw new Error('unused') },
  })
  await ctx.plugin(PermissionPresets, {
    presets: { 'bot-outside-write': { sandbox: 'danger-full-access', approval: 'ask' } },
    defaultPreset: 'bot-outside-write',
  })
  const adapter = new MockAdapter([textResponse('ok-one'), textResponse('ok-two'), textResponse('ok-three')] as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  vi.stubEnv('DSH_BOT_RUNTIME_ROOT', resolve('apps/cli'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NISSE_DSH_LLM_ENTRY', resolve('packages/llm/llm/lib/index.js'))
  vi.stubEnv('NISSE_MEMORY_URL', '')
  vi.stubEnv('NISSE_MEMORY_TOKEN', '')
  const integration = await import(pathToFileURL(resolve('nisse/packages/host-integration/lib/index.js')).href)
  await ctx.plugin(integration, {
    provider: 'mock',
    model: 'mock',
    requirePreset: false,
    permissionPreset: 'bot-outside-write',
    workspaceDir,
    ...(memoryUrl === undefined ? {} : { memoryUrl, memoryToken: 'fixture-token' }),
  })
  const bridgeFile = join(home, 'bot/bridge.json')
  await wait(() => existsSync(bridgeFile))
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port: number; token: string }
  const base = `http://127.0.0.1:${bridge.port}`
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  const post = (path: string, body: object = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const health = async () => (await (await fetch(base + '/health')).json()) as HostHealth
  const snapshot = async () => (await (await fetch(base + '/v2/snapshot', { headers })).json()) as HostSnapshot
  const ask = async (text: string, expectedRequests: number) => {
    const current = await health()
    const agent = ctx.agents.get(SessionId(String(current.agent?.sessionId)))
    if (agent === undefined) throw new Error('agent missing')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
    await wait(() => adapter.requests.length === expectedRequests)
    await agent.whenIdle()
  }
  return { ctx, adapter, post, health, snapshot, ask }
}

const requestsTo = (fixture: MemoryFixture, path: string): RecordedRequest[] => fixture.recorded.filter(entry => entry.path === path)

it('memory off proves zero read/write traffic, no model injection and an off (not error) state', async () => {
  const home = mkdtempSync(join(tmpdir(), 'round2-memoff-'))
  const fixture = await startCountingFixture()
  let host: Host | null = null
  try {
    host = await startHost({ home, workspaceDir: join(home, 'workspace') })
    expect((await host.post('/sessions/create')).status).toBe(200)
    await wait(async () => (await host!.health()).agent?.ready === true)

    // ④ Host-side state: memory service reported off, not failed.
    const healthOff = await host.health()
    expect(healthOff.ok).toBe(true)
    expect(healthOff.services?.memory).toBe(false)

    // Turn 1 while memory is off.
    await host.ask('第一条：今天天气怎么样？', 1)
    await new Promise(done => setTimeout(done, 400))
    // ①② zero requests of any kind reached the memory service.
    expect(fixture.recorded).toEqual([])
    // ③ the model request carries no memory section and no memory content.
    const requestOff = JSON.stringify(host.adapter.requests[0])
    expect(requestOff).not.toContain('个人历史资料')
    expect(requestOff).not.toContain(SENTINEL)
    // no memory error notice is presented while disabled.
    const noticesOff = (await host.snapshot()).notices ?? []
    expect(noticesOff.filter(notice => /记忆/.test(String(notice.text ?? '')) && /失败|错误|不可用/.test(String(notice.text ?? '')))).toEqual([])

    // Switch memory ON through the product live-configuration path.
    const onResponse = await host.post('/config', { memory: { url: fixture.url, token: 'fixture-token' } })
    expect(onResponse.status).toBe(200)
    await wait(async () => (await host!.health()).services?.memory === true)
    const digestAfterOn = requestsTo(fixture, '/digest').length
    expect(digestAfterOn).toBeGreaterThanOrEqual(1)

    // Turn 2 with memory on: recall reaches the service, reaches the model, episode is written.
    await host.ask('第二条：我下午喝点什么好？', 2)
    await wait(() => requestsTo(fixture, '/write').length >= 1)
    expect(requestsTo(fixture, '/search').length).toBeGreaterThanOrEqual(1)
    const requestOn = JSON.stringify(host!.adapter.requests[1])
    expect(requestOn).toContain('个人历史资料')
    expect(requestOn).toContain(SENTINEL)
    const episodeWrite = requestsTo(fixture, '/write')[0]
    if (episodeWrite === undefined) throw new Error('no episode write observed')
    expect(JSON.stringify(episodeWrite.body)).toContain('episode')
    expect(JSON.stringify(episodeWrite.body)).toContain('bot-conversation')
    expect(JSON.stringify(episodeWrite.body)).toContain('第二条')

    // Switch memory OFF again via the same product path.
    const offResponse = await host.post('/config', { memory: { url: '', token: '' } })
    expect(offResponse.status).toBe(200)
    expect((await host.health()).services?.memory).toBe(false)
    const countsWhenOff = { digest: requestsTo(fixture, '/digest').length, search: requestsTo(fixture, '/search').length, write: requestsTo(fixture, '/write').length }

    // Turn 3 while off: still zero new traffic and no injection.
    await host.ask('第三条：晚饭吃什么？', 3)
    await new Promise(done => setTimeout(done, 400))
    expect(requestsTo(fixture, '/digest').length).toBe(countsWhenOff.digest)
    expect(requestsTo(fixture, '/search').length).toBe(countsWhenOff.search)
    expect(requestsTo(fixture, '/write').length).toBe(countsWhenOff.write)
    const requestOffAgain = JSON.stringify(host.adapter.requests[2])
    expect(requestOffAgain).not.toContain('个人历史资料')
    expect(requestOffAgain).not.toContain(SENTINEL)
    expect((await host.health()).ok).toBe(true)
  } finally {
    if (host) await host.ctx.fiber.dispose().catch(() => {})
    await fixture.close()
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  }
}, 120000)

it('desktop memory status: disabled is a clean off state, a broken enabled payload is an explicit failure', async () => {
  const home = mkdtempSync(join(tmpdir(), 'round2-memstatus-'))
  try {
    const runtime = new MemoryRuntime(home, join(home, 'resources'), resolve('apps/desktop'), false)
    const disabled = await runtime.start({ memory: { enabled: false } })
    // Closed, never presented as an error.
    expect(disabled.enabled).toBe(false)
    expect(disabled.phase).toBe('disabled')
    expect(disabled.error).toBe('')
    expect(disabled.server).toBeNull()
    expect(disabled.sidecar).toBeNull()

    // Enabling with a payload that is not there is a DIFFERENT state with an explicit reason.
    const failed = await runtime.start({})
    expect(failed.phase).toBe('failed')
    expect(String(failed.error)).toMatch(/Hindsight runtime missing|memory payload/i)
    await runtime.stop()
    expect((await runtime.start({ memory: { enabled: false } })).phase).toBe('disabled')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120000)
