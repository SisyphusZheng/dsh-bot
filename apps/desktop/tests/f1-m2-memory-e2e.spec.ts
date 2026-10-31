/**
 * F1/M2 memory closed loop at the real Host boundary (closure 2026-10-31, plan §5 M2 ②③④).
 *
 * Evidence level: real Host integration + real DSH Session/AgentLoop + real memory sidecar
 * + real Hindsight storage/retrieval (isolated bank); the MODEL is a MockAdapter and the
 * retain path is chunks (no extraction). Therefore this proves:
 *   - a brand-new DSH conversation's model request carries the remembered fact (memory is
 *     actually used, not merely queried),
 *   - after correcting the fact, the new conversation's request carries the new fact only,
 *   - after deletion the new conversation's request carries neither fact.
 * It does NOT prove conversation quality or extraction from free-form dialogue.
 *
 * Requires an isolated Hindsight instance (see product/tools/closure-m2-e2e.mjs):
 *   CLOSURE_M2_HINDSIGHT_URL=http://127.0.0.1:55xx npx vitest run apps/desktop/tests/f1-m2-memory-e2e.spec.ts
 * Without that variable the suite skips instead of pretending to pass.
 */
import { describe, expect, it, vi } from 'vitest'
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
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const HINDSIGHT_URL = String(process.env.CLOSURE_M2_HINDSIGHT_URL || '').replace(/\/$/, '')
const ENABLED = HINDSIGHT_URL !== ''
const MARK_A = 'F1M2A-' + randomBytes(5).toString('hex')
const MARK_B = 'F1M2B-' + randomBytes(5).toString('hex')
const PREFERENCE_A = `用户明确要求记住：我喜欢无糖拿铁，店名海风咖啡（编号 ${MARK_A}）`
const PREFERENCE_B = `用户更正：我现在喝燕麦奶拿铁，不再喝无糖拿铁（编号 ${MARK_B}）`
const QUESTION = '我平时喝咖啡有什么习惯？'
const TOKEN = randomBytes(18).toString('hex')

/** HTTP JSON boundary of the product memory sidecar (field set follows the sidecar contract). */
type MemoryItem = { id?: string; text?: string; kind?: string; namespace?: string }
type MemoryHit = { id?: string; text?: string; kind?: string; score?: number }
type MemoryResponse = {
  ok?: boolean
  error?: { code?: string; message?: string }
  items?: MemoryItem[]
  hits?: MemoryHit[]
  export?: { path?: string; count?: number }
  digest?: { text?: string; tokensEstimated?: number }
  result?: Record<string, unknown>
}
/** `/health` projection used here: the Bot agent readiness of the real Host. */
type HostHealthSnapshot = { agent?: { ready?: boolean; sessionId?: string } }

const wait = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
}

async function waitForEpisode(memory: ReturnType<typeof memoryApi>, needle: string): Promise<boolean> {
  try {
    await wait(async () => (await memory.list()).some(item => item.kind === 'episode' && String(item.text ?? '').includes(needle)), 15000)
    return true
  } catch { return false }
}

type Sidecar = { url: string; child: ChildProcessWithoutNullStreams; close: () => Promise<void> }

async function startSidecar(bank: string): Promise<Sidecar> {
  const root = mkdtempSync(join(tmpdir(), 'f1-m2-sidecar-'))
  const child = spawn(process.execPath, [resolve('product/memory/sidecar.mjs')], {
    cwd: root,
    env: {
      ...process.env,
      HINDSIGHT_URL,
      NISSE_M4_MEMORY_ROOT: root,
      NISSE_M4_MEMORY_TOKEN: TOKEN,
      NISSE_M4_BANK: bank,
    },
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += String(chunk) })
  child.stderr.on('data', (chunk) => { output += String(chunk) })
  let url = ''
  await wait(() => {
    const match = /MEMORY_SIDECAR_READY \{"port":(\d+)\}/.exec(output)
    if (match) url = `http://127.0.0.1:${match[1]}`
    return url !== ''
  })
  return {
    url,
    child,
    close: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((done) => { child.once('exit', () => done()); setTimeout(done, 3000) })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

function memoryApi(sidecar: Sidecar) {
  const call = async (path: string, body?: object) => {
    const response = await fetch(sidecar.url + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(120000),
    })
    const json = await response.json() as MemoryResponse
    return { status: response.status, json }
  }
  return {
    call,
    write: (text: string, source: { sessionId: string; turnId?: string }, kind = 'preference') => call('/write', {
      items: [{ kind, namespace: 'global', text }],
      writer: 'bot',
      opts: { source },
    }),
    search: async (query: string) => (await call('/search', { query, namespaces: ['global'], limit: 8, budgetTokens: 2000 })).json?.hits ?? [],
    list: async () => (await call('/list', { limit: 100 })).json?.items ?? [],
    correct: (id: string, text: string) => call('/correct', { id, text, writer: 'bot' }),
    remove: (id: string) => call('/delete', { id, writer: 'bot' }),
  }
}

type Host = {
  ctx: Context
  adapter: InstanceType<typeof MockAdapter>
  bridge: { port: number; token: string; hostEpoch: string }
  home: string
  post: (path: string, body?: object) => Promise<Response>
  health: () => Promise<HostHealthSnapshot>
}

async function startHost(memoryUrl: string): Promise<Host> {
  const home = mkdtempSync(join(tmpdir(), 'f1-m2-host-'))
  const workspaceDir = join(home, 'workspace')
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
  const adapter = new MockAdapter([textResponse('first-answer'), textResponse('second-answer'), textResponse('third-answer')] as never)
  ctx.llm.registerAdapter(['mock'], adapter)
  vi.stubEnv('DSH_BOT_RUNTIME_ROOT', resolve('apps/cli'))
  vi.stubEnv('DSH_HOME', home)
  vi.stubEnv('NISSE_DSH_LLM_ENTRY', resolve('packages/llm/llm/lib/index.js'))
  const integration = await import(pathToFileURL(resolve('nisse/packages/host-integration/lib/index.js')).href)
  await ctx.plugin(integration, {
    provider: 'mock', model: 'mock', requirePreset: false, permissionPreset: 'bot-outside-write',
    memoryUrl, memoryToken: TOKEN, workspaceDir,
  })
  const bridgeFile = join(home, 'bot/bridge.json')
  await wait(() => existsSync(bridgeFile))
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port: number; token: string; hostEpoch: string }
  const base = `http://127.0.0.1:${bridge.port}`
  const post = (path: string, body: object = {}) => fetch(base + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const health = async () => (await (await fetch(base + '/health', { headers: { authorization: 'Bearer ' + bridge.token } })).json()) as HostHealthSnapshot
  return { ctx, adapter, bridge, home, post, health }
}

describe.skipIf(!ENABLED)('F1/M2 closed loop: memory is used by a brand-new DSH conversation (real Hindsight, mock model)', () => {
  it('remember A -> new conversation uses A -> correct to B -> delete B -> new conversation uses neither', async () => {
    const bank = `closure:f1m2:${Date.now()}:${randomBytes(3).toString('hex')}`
    const sidecar = await startSidecar(bank)
    const memory = memoryApi(sidecar)
    let host: Host | null = null
    try {
      // Seed the remembered fact through the product memory API (same /write shape the Host uses).
      const seeded = await memory.write(PREFERENCE_A, { sessionId: 'm2-seed-session', turnId: 'm2-seed-session:1' })
      expect(seeded.status).toBe(200)
      expect(seeded.json.ok).toBe(true)

      host = await startHost(sidecar.url)
      expect((await host.post('/sessions/create')).status).toBe(200)
      const health = await host.health()
      expect(health.agent?.ready).toBe(true)
      const firstSessionId = SessionId(String(health.agent?.sessionId))
      expect(String(firstSessionId).length).toBeGreaterThan(0)

      // ② A brand-new conversation asks a related question: the model request must carry A.
      host.ctx.agents.get(firstSessionId)?.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: QUESTION }] }))
      await wait(() => host!.adapter.requests.length === 1)
      await host.ctx.agents.get(firstSessionId)?.whenIdle()
      const firstRequest = JSON.stringify(host.adapter.requests[0])
      expect(firstRequest).toContain(MARK_A)
      expect(firstRequest).toContain('无糖拿铁')
      // The recalled fact is injected as background context, not treated as a user instruction.
      expect(firstRequest).toContain('个人历史资料')
      // The product also auto-records every finished turn as a raw conversation episode
      // (Host rememberTurn -> /write kind=episode). Wait for it: this is the behaviour the
      // M1 commitment analysis must describe honestly (auto raw transcript, no extraction).
      const episodeRecorded = await waitForEpisode(memory, 'first-answer')

      // ③ Correct A -> B, then a NEW conversation: the request carries B and not A.
      const memories = await memory.list()
      const current = memories.find(item => String(item.text ?? '').includes(MARK_A))
      if (current === undefined) throw new Error('seeded A must be listable')
      const corrected = await memory.correct(String(current.id), PREFERENCE_B)
      expect(corrected.status).toBe(200)
      expect(corrected.json.ok).toBe(true)

      expect((await host.post('/conversation/new')).status).toBe(200)
      const healthAfterCorrection = await host.health()
      const secondSessionId = SessionId(String(healthAfterCorrection.agent?.sessionId))
      expect(secondSessionId).not.toBe(firstSessionId)
      host.ctx.agents.get(secondSessionId)?.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: QUESTION }] }))
      await wait(() => host!.adapter.requests.length === 2)
      await host.ctx.agents.get(secondSessionId)?.whenIdle()
      const secondRequest = JSON.stringify(host.adapter.requests[1])
      expect(secondRequest).toContain(MARK_B)
      expect(secondRequest).not.toContain(MARK_A)
      // A fresh conversation session is used (asserted above via sessionId). The previous
      // conversation text only reaches it through the auto-recorded memory episode, never as
      // live session history; that episode must be visible here for the M1 finding to hold.
      expect(secondRequest).toContain('first-answer')
      expect(episodeRecorded).toBe(true)

      // ④ Delete B, then a NEW conversation: neither A nor B may be injected.
      const afterCorrection = await memory.list()
      const currentB = afterCorrection.find(item => String(item.text ?? '').includes(MARK_B))
      if (currentB === undefined) throw new Error('corrected B must be listable')
      const removed = await memory.remove(String(currentB.id))
      expect(removed.status).toBe(200)
      expect(removed.json.ok).toBe(true)

      expect((await host.post('/conversation/new')).status).toBe(200)
      const healthAfterDelete = await host.health()
      const thirdSessionId = SessionId(String(healthAfterDelete.agent?.sessionId))
      expect(thirdSessionId).not.toBe(secondSessionId)
      host.ctx.agents.get(thirdSessionId)?.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: QUESTION }] }))
      await wait(() => host!.adapter.requests.length === 3)
      await host.ctx.agents.get(thirdSessionId)?.whenIdle()
      const thirdRequest = JSON.stringify(host.adapter.requests[2])
      expect(thirdRequest).not.toContain(MARK_A)
      expect(thirdRequest).not.toContain(MARK_B)

      // Retrieval-level corroboration (not a substitute for the model-input assertions above).
      const afterDeleteHits = await memory.search(QUESTION)
      expect(afterDeleteHits.some(hit => String(hit.text).includes(MARK_A) || String(hit.text).includes(MARK_B))).toBe(false)
    } finally {
      if (host) {
        await host.ctx.fiber.dispose()
        rmSync(host.home, { recursive: true, force: true })
      }
      vi.unstubAllEnvs()
      await sidecar.close()
    }
  }, 120000)
})
