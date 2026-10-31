/**
 * Round-2 memory contract: what actually happens when the user says "请记住 X".
 *
 * Evidence level: real Host integration + real DSH Session/AgentLoop + real memory sidecar +
 * real Hindsight storage/retrieval (isolated bank); the MODEL is a MockAdapter.
 *
 * It observes, in the product's shipped wiring, that an explicit "remember X" request is only
 * stored as the raw finished-turn episode (kind=episode, tags=[bot-conversation], source
 * sessionId/turnId). There is no model-facing memory-write tool and no structured
 * preference/fact record — so "explicit remember" has no dedicated write semantics today.
 * The fact still becomes usable later because the episode is recalled into a new conversation's
 * model request (background context), which this spec also asserts.
 *
 * Requires an isolated Hindsight instance:
 *   CLOSURE_M2_HINDSIGHT_URL=http://127.0.0.1:55xx npx vitest run apps/desktop/tests/round2-remember-path.spec.ts
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
const METHOD_MARK = 'ROUND2-REMEMBER-' + randomBytes(5).toString('hex')
const REMEMBER_TEXT = `请记住：我的对接代号是蓝鲸七号（${METHOD_MARK}），下次直接用它称呼这个项目。`
const FOLLOW_UP = '我的对接代号是什么？'
const TOKEN = randomBytes(18).toString('hex')

/** Native Hindsight memory row (subset this spec reads). */
type NativeMemory = {
  id?: string
  text?: string
  tags?: string[]
  state?: string
  metadata?: { kind?: string; writer?: string; sourceSessionId?: string; sourceTurnId?: string }
}
type SidecarItem = { id?: string; kind?: string; text?: string }
type SidecarSidecar = { url: string; child: ChildProcessWithoutNullStreams; close: () => Promise<void> }
type HostHealth = { ok?: boolean; agent?: { ready?: boolean; sessionId?: string } }

const wait = async (condition: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(done => setTimeout(done, 25))
  }
}

async function startSidecar(bank: string): Promise<SidecarSidecar> {
  const root = mkdtempSync(join(tmpdir(), 'round2-sidecar-'))
  const child = spawn(process.execPath, [resolve('product/memory/sidecar.mjs')], {
    cwd: root,
    env: { ...process.env, HINDSIGHT_URL, NISSE_M4_MEMORY_ROOT: root, NISSE_M4_MEMORY_TOKEN: TOKEN, NISSE_M4_BANK: bank },
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

const sidecarCall = async (sidecar: SidecarSidecar, path: string, body: object = {}): Promise<Response> =>
  fetch(sidecar.url + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  })

async function nativeMemories(bank: string): Promise<NativeMemory[]> {
  const response = await fetch(`${HINDSIGHT_URL}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=100&state=valid`)
  if (!response.ok) throw new Error('native memory list failed: ' + String(response.status))
  const json = await response.json() as { items?: NativeMemory[] }
  return json.items ?? []
}

type Host = {
  ctx: Context
  adapter: InstanceType<typeof MockAdapter>
  post: (path: string, body?: object) => Promise<Response>
  health: () => Promise<HostHealth>
}

async function startHost({ home, workspaceDir, memoryUrl }: { home: string; workspaceDir: string; memoryUrl: string }): Promise<Host> {
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
  const adapter = new MockAdapter([textResponse('好的，我记住了'), textResponse('你的对接代号是蓝鲸七号')] as never)
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
  const bridge = JSON.parse(readFileSync(bridgeFile, 'utf8')) as { port: number; token: string }
  const base = `http://127.0.0.1:${bridge.port}`
  const headers = { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }
  return {
    ctx,
    adapter,
    post: (path: string, body: object = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) }),
    health: async () => (await (await fetch(base + '/health')).json()) as HostHealth,
  }
}

async function ask(host: Host, text: string, expectedRequests: number): Promise<void> {
  const current = await host.health()
  const agent = host.ctx.agents.get(SessionId(String(current.agent?.sessionId)))
  if (agent === undefined) throw new Error('agent missing')
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await wait(() => host.adapter.requests.length === expectedRequests)
  await agent.whenIdle()
}

describe.skipIf(!ENABLED)('round-2: what an explicit "remember X" request actually writes', () => {
  it('stores only a raw episode with provenance (no structured preference) and later recalls it', async () => {
    const bank = `closure:round2:remember:${Date.now()}:${randomBytes(3).toString('hex')}`
    const sidecar = await startSidecar(bank)
    const home = mkdtempSync(join(tmpdir(), 'round2-remember-host-'))
    let host: Host | null = null
    try {
      host = await startHost({ home, workspaceDir: join(home, 'workspace'), memoryUrl: sidecar.url })
      expect((await host.post('/sessions/create')).status).toBe(200)
      await wait(async () => (await host!.health()).agent?.ready === true)
      const sessionId = String((await host.health()).agent?.sessionId)

      // Step 1: the user explicitly asks the assistant to remember one fact.
      await ask(host, REMEMBER_TEXT, 1)
      // The first turn had no memory context yet.
      expect(JSON.stringify(host.adapter.requests[0])).not.toContain('个人历史资料')

      // Step 2: observe what the product actually wrote for that turn.
      let episode: NativeMemory | undefined
      await wait(async () => {
        const items = await nativeMemories(bank)
        episode = items.find(item => String(item.text ?? '').includes(METHOD_MARK))
        return episode !== undefined
      })
      if (episode === undefined) throw new Error('no episode recorded for the remember turn')
      const memories = await nativeMemories(bank)
      const structured = memories.filter(item => String(item.text ?? '').includes(METHOD_MARK)
        && ['preference', 'fact', 'profile', 'entity'].includes(String(item.metadata?.kind ?? '')))
      // Reality check: the explicit request becomes an episode transcript, not a structured memory.
      expect(episode.metadata?.kind).toBe('episode')
      expect(episode.tags ?? []).toEqual(expect.arrayContaining(['bot-conversation', 'ns:global', 'kind:episode']))
      expect(episode.metadata?.sourceSessionId).toBe(sessionId)
      expect(String(episode.metadata?.sourceTurnId ?? '')).toBe(`${sessionId}:1`)
      expect(episode.metadata?.writer).toBe('bot')
      expect(String(episode.text ?? '')).toContain('用户：' + REMEMBER_TEXT)
      expect(structured).toEqual([])

      // Step 3: a brand-new conversation recalls the episode into the model request.
      expect((await host.post('/conversation/new')).status).toBe(200)
      const rotated = String((await host.health()).agent?.sessionId)
      expect(rotated).not.toBe(sessionId)
      await ask(host, FOLLOW_UP, 2)
      const secondRequest = JSON.stringify(host.adapter.requests[1])
      expect(secondRequest).toContain('个人历史资料')
      expect(secondRequest).toContain(METHOD_MARK)
      expect(secondRequest).toContain('蓝鲸七号')

      // Step 4: operator-visible list (same API as the settings memory panel) shows the episode.
      const listResponse = await sidecarCall(sidecar, '/list', { limit: 50 })
      const listJson = await listResponse.json() as { ok?: boolean; items?: SidecarItem[] }
      expect(listJson.ok).toBe(true)
      const listed = (listJson.items ?? []).find(item => String(item.text ?? '').includes(METHOD_MARK))
      expect(listed?.kind).toBe('episode')
    } finally {
      if (host) {
        await host.ctx.fiber.dispose().catch(() => {})
        vi.unstubAllEnvs()
        rmSync(home, { recursive: true, force: true })
      }
      await sidecar.close()
    }
  }, 180000)
})
