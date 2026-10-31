/**
 * S1 real-side-effect acceptance: the Bot default permission model
 * (`workspace-write` + one-shot escalation + formal approval) against the real
 * DSH filesystem fence and the real macOS Seatbelt bash executor.
 *
 * Every case asserts the final file-system state — a denied/cancelled/failed
 * approval must leave no file, an approved one-shot escalation must land the
 * exact file, and the grant must not survive the call. The temporary roots are
 * allocated outside the automatic temp write grants (`outsideTempWorkspaceParent`)
 * so "outside the workspace" is a real denial rather than a temp-dir allowance,
 * and each test owns and removes its own directories.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../../scripts/snapshot-workspace-parent.ts'

/** The Seatbelt probe the real provider runs; skip the kernel suite where it cannot work (never silently pass). */
const seatbeltProbe = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)(deny file-write*)', '--', 'true'], { timeout: 5_000, stdio: 'ignore' })
const seatbeltUsable = seatbeltProbe.status === 0

type TestEvent = { type: string; data?: Record<string, unknown>; seq: number }

/** A structural Agent/Session stub with an open turn so approval audit events can commit. */
function fakeAgent(cwd: string, sessionId = 's1-sandbox-session'): { agent: Agent; events: TestEvent[] } {
  const events: TestEvent[] = [{ type: 'turn/start', data: { turn: 1 }, seq: 0 }]
  const id = SessionId(sessionId)
  const session = {
    id,
    header: { version: 0, id, createdAt: 0, cwd },
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
    snapshotEvents: () => events,
    append: (type: string, data: Record<string, unknown> = {}) => {
      const event = { type, data, seq: events.length }
      events.push(event)
      return event
    },
  }
  return { agent: { id, session } as never, events }
}

const contexts: Context[] = []
const bases: string[] = []
let callCounter = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true })
})

/** Allocate an isolated root outside the automatic temp write grants; returns workspace and outside siblings. */
function fixture(): { base: string; workspace: string; outside: string } {
  const base = mkdtempSync(join(outsideTempWorkspaceParent(), 'dsh-s1-sandbox-'))
  bases.push(base)
  const workspace = join(base, 'ws')
  const outside = join(base, 'out')
  mkdirSync(workspace)
  mkdirSync(outside)
  assertWorkspaceOutsideTemp(workspace)
  return { base, workspace, outside }
}

function call(ctx: Context, agent: Agent, name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? new AbortController().signal,
    callId: ToolCallId(`s1-call-${++callCounter}`),
    name,
    arguments: args,
    agent,
  })
}

type ToolResult = Awaited<ReturnType<Context['tools']['execute']>>

function text(result: ToolResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** Record every approval request and answer from a fixed queue (default: reject — the safe choice). */
function answerer(ctx: Context, outcomes: readonly ApprovalOutcome[]): { prompts: () => number } {
  let prompts = 0
  const queue = [...outcomes]
  ctx.on('approval/request', () => {
    const outcome = queue.shift() ?? 'rejected'
    prompts += 1
    return Promise.resolve(outcome)
  })
  return { prompts: () => prompts }
}

/** Answer only when the request is cancelled (exception path / timeout semantics). */
function abortAnswerer(ctx: Context): { prompts: () => number } {
  let prompts = 0
  ctx.on('approval/request', req => new Promise<ApprovalOutcome>((resolve) => {
    prompts += 1
    const signal = (req as { signal?: AbortSignal }).signal
    if (signal === undefined) { resolve('unavailable'); return }
    if (signal.aborted) { resolve('cancelled'); return }
    signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }))
  return { prompts: () => prompts }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition timeout')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** Real fs-tool stack: sandboxed filesystem fence + policy + approval. */
async function bootFsTools(workspace: string, mode: 'workspace-write' | 'danger-full-access' = 'workspace-write'): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, workspace)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode, workspaceRoot: workspace })
  await ctx.plugin(SandboxedFileSystem, { cwd: workspace })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ToolFs)
  return ctx
}

/** Real bash-tool stack: Seatbelt provider + confining executor + approval. */
async function bootBashTools(workspace: string): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  provideWorkingDirectoryFixture(ctx, workspace)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: workspace })
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  // darwin's chain is Seatbelt-only; forcing the Linux rungs off records the platform claim.
  sandbox.internals = { probeBwrap: () => false, probeLandlock: () => 'unusable' }
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SandboxBashExecutor, { cwd: workspace, timeoutMs: 30_000 })
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ToolBash)
  return ctx
}

describe('fs tools under the Bot default workspace-write policy', () => {
  it('writes inside the workspace on disk', async () => {
    const { workspace } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, [])
    const result = await call(ctx, agent, 'write', { file_path: join(workspace, 'inside.txt'), content: 'inside' })
    expect(result.isError, text(result)).toBe(false)
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toBe('inside')
  })

  it('denies an out-of-workspace write with no file, then an approved one-shot escalation lands it', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent, events } = fakeAgent(workspace)
    const approval = answerer(ctx, ['allowed-once'])
    const target = join(outside, 'approved.txt')

    const denied = await call(ctx, agent, 'write', { file_path: target, content: 'denied' })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(text(denied)).toContain('[sandbox: escalation available')
    expect(existsSync(target)).toBe(false)
    expect(approval.prompts()).toBe(0)

    const approved = await call(ctx, agent, 'write', {
      file_path: target,
      content: 'approved',
      sandbox_permissions: 'danger-full-access',
      justification: 'the user asked for this report outside the workspace',
    })
    expect(approved.isError, text(approved)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('approved')
    expect(approval.prompts()).toBe(1)
    expect(events.some(event => event.type === 'approval/asked')).toBe(true)
    expect(events.some(event => event.type === 'approval/decided' && event.data?.outcome === 'allowed-once')).toBe(true)
  })

  it('a rejected escalation leaves no file', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, ['rejected'])
    const target = join(outside, 'rejected.txt')
    const result = await call(ctx, agent, 'write', {
      file_path: target,
      content: 'nope',
      sandbox_permissions: 'danger-full-access',
      justification: 'trying an out-of-workspace write',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('the user rejected escalating')
    expect(existsSync(target)).toBe(false)
  })

  it('a cancelled (timeout) approval leaves no file and records the cancelled audit outcome', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent, events } = fakeAgent(workspace)
    const approval = abortAnswerer(ctx)
    const controller = new AbortController()
    const target = join(outside, 'cancelled.txt')
    const pending = call(ctx, agent, 'write', {
      file_path: target,
      content: 'nope',
      sandbox_permissions: 'danger-full-access',
      justification: 'approval will be withdrawn',
    }, controller.signal)
    await waitFor(() => approval.prompts() === 1)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('cancelled')
    expect(existsSync(target)).toBe(false)
    expect(events.some(event => event.type === 'approval/decided' && event.data?.outcome === 'cancelled')).toBe(true)
  })

  it('a throwing approval answerer fails closed (unavailable) with no file', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    ctx.on('approval/request', () => { throw new Error('approval channel broke') })
    const target = join(outside, 'unavailable.txt')
    const result = await call(ctx, agent, 'write', {
      file_path: target,
      content: 'nope',
      sandbox_permissions: 'danger-full-access',
      justification: 'approval channel failure fixture',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no approval channel is available')
    expect(existsSync(target)).toBe(false)
  })

  it('relative traversal, an unlisted absolute directory, and a symlink escape are denied with no file', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    const approval = answerer(ctx, [])
    const traversal = await call(ctx, agent, 'write', { file_path: '../traversal.txt', content: 'x' })
    expect(traversal.isError).toBe(true)
    expect(existsSync(join(workspace, '..', 'traversal.txt'))).toBe(false)
    const unlisted = await call(ctx, agent, 'write', { file_path: '/opt/dsh-s1-unlisted/x.txt', content: 'x' })
    expect(unlisted.isError).toBe(true)
    expect(existsSync('/opt/dsh-s1-unlisted/x.txt')).toBe(false)
    symlinkSync(outside, join(workspace, 'link'))
    const symlinked = await call(ctx, agent, 'write', { file_path: 'link/escape.txt', content: 'x' })
    expect(symlinked.isError).toBe(true)
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false)
    expect(approval.prompts()).toBe(0)
  })

  it('the one-shot grant is not sticky: a repeat without escalation is denied again', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    const approval = answerer(ctx, ['allowed-once'])
    const target = join(outside, 'one-shot.txt')
    const args = { file_path: target, content: 'first' }
    expect((await call(ctx, agent, 'write', args)).isError).toBe(true)
    const approved = await call(ctx, agent, 'write', {
      ...args,
      sandbox_permissions: 'danger-full-access',
      justification: 'the user approved this exact file once',
    })
    expect(approved.isError, text(approved)).toBe(false)
    expect(readFileSync(target, 'utf8')).toBe('first')
    const repeat = await call(ctx, agent, 'write', { file_path: target, content: 'second' })
    expect(repeat.isError).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('first')
    expect(approval.prompts()).toBe(1)
  })

  it('an approved escalation for one path does not authorize a different path', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootFsTools(workspace)
    const { agent } = fakeAgent(workspace)
    const approval = answerer(ctx, ['allowed-once', 'rejected'])
    const first = join(outside, 'first.txt')
    const second = join(outside, 'second.txt')
    const approved = await call(ctx, agent, 'write', {
      file_path: first,
      content: 'one',
      sandbox_permissions: 'danger-full-access',
      justification: 'approve the first file only',
    })
    expect(approved.isError, text(approved)).toBe(false)
    const rejected = await call(ctx, agent, 'write', {
      file_path: second,
      content: 'two',
      sandbox_permissions: 'danger-full-access',
      justification: 'this is a different target',
    })
    expect(rejected.isError).toBe(true)
    expect(existsSync(second)).toBe(false)
    expect(approval.prompts()).toBe(2)
  })
})

describe.skipIf(!seatbeltUsable)('bash under the Bot default workspace-write policy (real macOS Seatbelt)', () => {
  it('writes inside the workspace', async () => {
    const { workspace } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, [])
    const result = await call(ctx, agent, 'bash', { command: 'printf bash-inside > inside.txt; cat inside.txt', description: 'write inside' })
    expect(result.isError, text(result)).toBe(false)
    expect(text(result)).toBe('bash-inside')
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toBe('bash-inside')
  })

  it('denies an out-of-workspace write in the kernel and reports the denial marker', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    const approval = answerer(ctx, [])
    const target = join(outside, 'shell-denied.txt')
    const result = await call(ctx, agent, 'bash', { command: `printf nope > ${target}`, description: 'write outside' })
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(text(result)).toContain('[sandbox: escalation available')
    expect(existsSync(target)).toBe(false)
    expect(approval.prompts()).toBe(0)
  })

  it('denies interpreter indirect writes: python3 -c and node -e', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, [])
    const py = join(outside, 'python.txt')
    const fromPython = await call(ctx, agent, 'bash', {
      command: `python3 -c "open('${py}','w').write('x')"`,
      description: 'python indirect write',
    })
    expect(text(fromPython)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(py)).toBe(false)
    const js = join(outside, 'node.txt')
    const fromNode = await call(ctx, agent, 'bash', {
      command: `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync('${js}','x')"`,
      description: 'node indirect write',
    })
    expect(text(fromNode)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(js)).toBe(false)
  })

  it('denies variable-constructed and relative-traversal writes', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, [])
    const target = join(outside, 'variable.txt')
    const variable = await call(ctx, agent, 'bash', {
      command: `P=${JSON.stringify(target)}; printf x > "$P"`,
      description: 'variable path write',
    })
    expect(text(variable)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(target)).toBe(false)
    const relative = await call(ctx, agent, 'bash', { command: 'printf x > ../relative-escape.txt', description: 'relative escape' })
    expect(text(relative)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(join(workspace, '..', 'relative-escape.txt'))).toBe(false)
  })

  it('denies a symlink escape created inside the workspace', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    answerer(ctx, [])
    symlinkSync(outside, join(workspace, 'bash-link'))
    const target = join(outside, 'via-link.txt')
    const result = await call(ctx, agent, 'bash', { command: 'printf x > bash-link/via-link.txt', description: 'write through symlink' })
    expect(text(result)).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(existsSync(target)).toBe(false)
  })

  it('a rejected escalation leaves no file; an approved one writes it once', async () => {
    const { workspace, outside } = fixture()
    const ctx = await bootBashTools(workspace)
    const { agent } = fakeAgent(workspace)
    const approval = answerer(ctx, ['rejected', 'allowed-once'])
    const rejectedTarget = join(outside, 'shell-rejected.txt')
    const rejected = await call(ctx, agent, 'bash', {
      command: `printf x > ${rejectedTarget}`,
      description: 'escalated shell write (rejected)',
      sandbox_permissions: 'danger-full-access',
      justification: 'the user has not approved this shell write',
    })
    expect(rejected.isError).toBe(true)
    expect(text(rejected)).toContain('the user rejected escalating this command')
    expect(existsSync(rejectedTarget)).toBe(false)
    const approvedTarget = join(outside, 'shell-approved.txt')
    const approved = await call(ctx, agent, 'bash', {
      command: `printf approved > ${approvedTarget}`,
      description: 'escalated shell write (approved)',
      sandbox_permissions: 'danger-full-access',
      justification: 'the user approved this exact shell write once',
    })
    expect(approved.isError, text(approved)).toBe(false)
    expect(readFileSync(approvedTarget, 'utf8')).toBe('approved')
    expect(approval.prompts()).toBe(2)
  })
})
