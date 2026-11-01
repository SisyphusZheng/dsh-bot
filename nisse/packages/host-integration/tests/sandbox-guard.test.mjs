/**
 * Product pre-execute guard contract.
 *
 * These tests pin the S1 division of responsibility: the product heuristic
 * NEVER authorizes a file effect and never asks for approval itself; DSH's
 * workspace-write sandbox plus the upstream one-shot escalation own the file
 * effects. The guard owns only the best-effort screen switch, the per-call
 * operation record, and audit hints — and it is fail-closed when its own
 * classification fails. Every denial assertion also checks the real file
 * system: a denied call must leave no file behind.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FILE_WRITE_TOOL_NAMES,
  canonicalPath,
  classifyWriteIntent,
  createSandboxGuard,
  guardFaultReason,
  isOutsideWorkspace,
  isScreenCapableTool,
  shellWriteHints,
  toolFamily,
} from '../lib/sandbox-guard.mjs'
import { operationKey } from '../lib/approval-policies.mjs'

/** Isolated fixture: `base/ws` workspace, `base/out` outside target, `base/call-<n>` scripts. */
function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'sandbox-guard-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const workspace = join(base, 'ws')
  const outside = join(base, 'out')
  mkdirSync(workspace)
  mkdirSync(outside)
  return { base, workspace, outside }
}

/** Build the guard with the product defaults and a recording audit sink. */
function guardFor({ workspace, outside, screenView = false, overrides = {} }) {
  const calls = []
  const audits = []
  const executed = []
  const guard = createSandboxGuard({
    isOurs: () => true,
    workspace: () => workspace,
    cwdOf: () => workspace,
    screenViewAllowed: () => screenView,
    toolDescription: name => (name === 'read' ? 'Read a text file from disk.' : ''),
    recordOperation: (exec, operation) => calls.push({ callId: exec.callId, ...operation }),
    audit: (event, fields) => audits.push({ event, ...fields }),
    ...overrides,
  })
  const run = async (name, args, { callId = 'call-1', onNext } = {}) => {
    const result = await guard(
      { name, callId, arguments: args, agent: { session: { id: 'bot-session' } } },
      async () => {
        executed.push({ name, args })
        if (onNext !== undefined) onNext()
        return { kind: 'allow' }
      },
    )
    return { result, executed, calls, audits }
  }
  return { run, calls, audits, executed, outside }
}

test('file-write family detection covers the fs tool names and only those', () => {
  for (const name of FILE_WRITE_TOOL_NAMES) assert.equal(toolFamily(name), 'file-write', name)
  assert.equal(toolFamily('bash'), 'shell')
  assert.equal(toolFamily('mcp__cua-driver-mcp__screenshot'), 'other')
  assert.equal(toolFamily('read'), 'other')
  assert.equal(toolFamily(''), 'other')
})

test('screen-capability classification covers official CUA entry points, names and strong descriptions', () => {
  for (const name of ['cua_driver_native__screenshot', 'cua_driver_native__left_click', 'mcp__cua-driver-mcp__take_screenshot', 'computer_use', 'screenshot', 'screen_capture']) {
    assert.equal(isScreenCapableTool(name), true, name)
  }
  assert.equal(isScreenCapableTool('read', 'Read a text file.'), false)
  assert.equal(isScreenCapableTool('bash', 'Run a shell command.'), false)
  assert.equal(isScreenCapableTool('mcp__thirdparty__capture', 'Takes a screenshot of the active window.'), true)
  assert.equal(isScreenCapableTool('mcp__files__list', 'Lists files on the desktop.'), false)
})

test('disabled screen switch denies the call before any side effect; a policy denial is not a guard fault', async t => {
  const f = fixture(t)
  const target = join(f.base, 'would-have-run.txt')
  const g = guardFor({ workspace: f.workspace, outside: f.outside, screenView: false })
  const { result } = await g.run('cua_driver_native__screenshot', {}, { onNext: () => writeFileSync(target, 'ran') })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /产品策略拒绝/)
  assert.match(result.reason, /不是守卫故障/)
  assert.equal(existsSync(target), false, 'denied call must not execute its body')
  assert.deepEqual(g.executed, [])
  assert.ok(g.audits.some(item => item.event === 'tool.denied_screen_view' && item.tool === 'cua_driver_native__screenshot'))
})

test('enabled screen switch delegates normally (call is executed)', async t => {
  const f = fixture(t)
  const target = join(f.base, 'ran.txt')
  const g = guardFor({ workspace: f.workspace, outside: f.outside, screenView: true })
  const { result } = await g.run('cua_driver_native__screenshot', {}, { onNext: () => writeFileSync(target, 'ran') })
  assert.equal(result.kind, 'allow')
  assert.equal(existsSync(target), true)
})

test('guard fault is denied, leaves no side effect, names the fault, and later unrelated calls still run', async t => {
  const f = fixture(t)
  const target = join(f.base, 'guard-fault-side-effect.txt')
  const throwForWrite = ({ toolName }) => {
    if (toolName === 'write') throw new TypeError('classification exploded')
    return { family: 'other', outside: false, unknown: false, targets: [] }
  }
  const g = guardFor({ workspace: f.workspace, outside: f.outside, overrides: { classify: throwForWrite } })
  const first = await g.run('write', { path: join(f.base, 'anywhere.txt'), content: 'x' }, { callId: 'fault-1', onNext: () => writeFileSync(target, 'ran') })
  assert.equal(first.result.kind, 'deny')
  assert.match(first.result.reason, /守卫故障/)
  assert.match(first.result.reason, /SANDBOX_GUARD_FAULT\/TypeError/)
  assert.match(first.result.reason, /没有任何文件或命令被执行/)
  assert.equal(existsSync(target), false, 'a denied guard call must not produce the file side effect')
  const audit = g.audits.find(item => item.event === 'tool.guard_fault')
  assert.ok(audit && audit.tool === 'write' && /classification exploded/.test(audit.error))
  // The fault is scoped to the call: an unrelated call still reaches execution.
  const second = await g.run('read', { file_path: join(f.workspace, 'a.txt') }, { callId: 'ok-2' })
  assert.equal(second.result.kind, 'allow')
  assert.deepEqual(g.executed.map(item => item.name), ['read'])
})

test('guard never asks: an out-of-workspace write is audited and delegated (sandbox owns the effect)', async t => {
  const f = fixture(t)
  const g = guardFor({ workspace: f.workspace, outside: f.outside })
  const { result } = await g.run('write', { path: join(f.outside, 'escaped.txt'), content: 'x' })
  assert.equal(result.kind, 'allow')
  const hint = g.audits.find(item => item.event === 'write.outside_workspace_hint')
  assert.ok(hint, 'out-of-workspace attempt is audited')
  assert.equal(hint.outside, true)
  assert.equal(hint.family, 'file-write')
  assert.equal(existsSync(join(f.outside, 'escaped.txt')), false, 'the guard itself must not write; the sandbox decides')
})

test('every delegated call records the complete operation for exact-grant matching; arguments changes change the key', async t => {
  const f = fixture(t)
  const g = guardFor({ workspace: f.workspace, outside: f.outside })
  await g.run('bash', { command: 'echo one > out.txt' }, { callId: 'call-a' })
  await g.run('bash', { command: 'echo two > out.txt' }, { callId: 'call-b' })
  assert.equal(g.calls.length, 2)
  assert.deepEqual(g.calls[0], { callId: 'call-a', toolName: 'bash', arguments: { command: 'echo one > out.txt' }, cwd: f.workspace })
  const keyA = operationKey(g.calls[0])
  const keyB = operationKey(g.calls[1])
  assert.notEqual(keyA, keyB, 'a changed command must not match the previous exact grant')
})

test('write-intent classification: inside, traversal, absolute outside, and unlisted absolute directory', async t => {
  const f = fixture(t)
  const inside = classifyWriteIntent({ toolName: 'write', arguments: { file_path: 'nested/a.txt' }, workspace: f.workspace, cwd: f.workspace })
  assert.equal(inside.family, 'file-write')
  assert.equal(inside.outside, false)
  assert.deepEqual(inside.targets, [canonicalPath(join(f.workspace, 'nested/a.txt'))])
  const traversal = classifyWriteIntent({ toolName: 'edit', arguments: { path: '../escaped.txt' }, workspace: f.workspace, cwd: f.workspace })
  assert.equal(traversal.outside, true)
  const absolute = classifyWriteIntent({ toolName: 'write', arguments: { path: join(f.outside, 'x.txt') }, workspace: f.workspace, cwd: f.workspace })
  assert.equal(absolute.outside, true)
  const unlisted = classifyWriteIntent({ toolName: 'write', arguments: { path: '/opt/not-in-any-list/x.txt' }, workspace: f.workspace, cwd: f.workspace })
  assert.equal(unlisted.outside, true)
  const relativeToCwdSubdir = classifyWriteIntent({ toolName: 'write', arguments: { path: 'sub/ok.txt' }, workspace: f.workspace, cwd: join(f.workspace, 'sub') })
  assert.equal(relativeToCwdSubdir.outside, false)
})

test('symlinked directory inside the workspace pointing out is classified as outside (canonicalized)', async t => {
  const f = fixture(t)
  symlinkSync(f.outside, join(f.workspace, 'link'))
  const intent = classifyWriteIntent({ toolName: 'write', arguments: { file_path: 'link/escape.txt' }, workspace: f.workspace, cwd: f.workspace })
  assert.equal(intent.outside, true, 'the canonical target is outside even though the spelling is workspace-relative')
})

test('shell hints recognize interpreter-only and variable-constructed writes the old regex missed', async t => {
  const f = fixture(t)
  const python = classifyWriteIntent({
    toolName: 'bash',
    arguments: { command: `python3 -c "open('${join(f.outside, 'py.txt')}','w').write('x')"` },
    workspace: f.workspace,
    cwd: f.workspace,
  })
  assert.equal(python.family, 'shell')
  assert.equal(python.outside, true, 'python3 -c indirect write is recognized as an out-of-workspace hint')
  const node = classifyWriteIntent({
    toolName: 'bash',
    arguments: { command: `node -e "require('fs').writeFileSync('${join(f.outside, 'node.txt')}','x')"` },
    workspace: f.workspace,
    cwd: f.workspace,
  })
  assert.equal(node.outside, true, 'node -e indirect write is recognized as an out-of-workspace hint')
  const variable = classifyWriteIntent({
    toolName: 'bash',
    arguments: { command: 'P="$(pwd)/../x"; echo x > "$P/f.txt"' },
    workspace: f.workspace,
    cwd: f.workspace,
  })
  assert.equal(variable.unknown, true, 'a path assembled from a variable is recorded as unresolvable')
  const assigned = classifyWriteIntent({
    toolName: 'bash',
    arguments: { command: 'P=/opt/target; echo x > "$P/f.txt"' },
    workspace: f.workspace,
    cwd: f.workspace,
  })
  assert.equal(assigned.outside, true, 'a literal path assigned to a variable is still audited as an outside hint')
  const relative = classifyWriteIntent({
    toolName: 'bash',
    arguments: { command: 'echo x > ../escaped.txt' },
    workspace: f.workspace,
    cwd: f.workspace,
  })
  assert.equal(relative.outside, true, 'relative traversal out of the cwd is an outside hint')
  assert.equal(classifyWriteIntent({ toolName: 'bash', arguments: { command: 'ls -la' }, workspace: f.workspace, cwd: f.workspace }).unknown, true)
  const hints = shellWriteHints('rm -rf /opt/x && python3 -c "print(1)"')
  assert.equal(hints.mutation, true)
})

test('a URL argument is never recorded as an outside-workspace path', t => {
  const f = fixture(t)
  for (const command of [
    'open "https://www.bing.com/search?q=Nisse+DSH"',
    'open http://127.0.0.1:3000/a/../b',
    'node script.mjs --endpoint https://api.example.com/v1/items?limit=2',
  ]) {
    const hints = shellWriteHints(command)
    assert.equal(hints.targets.length, 0, `URL path parts must be ignored: ${command}`)
    const intent = classifyWriteIntent({ toolName: 'bash', arguments: { command }, workspace: f.workspace, cwd: f.workspace })
    assert.equal(intent.outside, false, `URL must not look outside: ${command}`)
    assert.equal(intent.family, 'shell')
    // A shell line that names no filesystem path is still audited as "unknown"
    // under the existing guard contract; that generic ambiguity is not a URL hit.
    assert.deepEqual(intent.targets, [], `URL must not become a target: ${command}`)
  }
  // A real absolute file path in the same command is still reported.
  const mixed = shellWriteHints('open https://example.com/x && rm /opt/target/y')
  assert.deepEqual(mixed.targets.map(item => item.replace(f.workspace, '')), ['/opt/target/y'])
})

test('canonical containment resolves a symlinked ancestor for a not-yet-existing target', async t => {
  const f = fixture(t)
  symlinkSync(f.outside, join(f.workspace, 'link'))
  const missing = join(f.workspace, 'link', 'deep', 'file.txt')
  assert.equal(isOutsideWorkspace(canonicalPath(missing), canonicalPath(f.workspace)), true)
  assert.equal(isOutsideWorkspace(canonicalPath(join(f.workspace, 'a.txt')), canonicalPath(f.workspace)), false)
})

test('ownership-establishment failure is fail-closed', async t => {
  const f = fixture(t)
  const audits = []
  let executed = false
  const guard = createSandboxGuard({
    isOurs: () => { throw new Error('session unreadable') },
    workspace: () => f.workspace,
    cwdOf: () => f.workspace,
    screenViewAllowed: () => false,
    toolDescription: () => '',
    recordOperation: () => {},
    audit: (event, fields) => audits.push({ event, ...fields }),
  })
  const result = await guard({ name: 'bash', callId: 'x', arguments: {} }, async () => { executed = true; return { kind: 'allow' } })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /守卫故障/)
  assert.equal(executed, false)
  assert.equal(audits[0]?.event, 'tool.guard_fault')
})

test('fault vs policy reason text is distinguishable and cites a recoverable action', () => {
  const fault = guardFaultReason('write', new Error('boom'))
  assert.match(fault, /守卫故障（非 DSH 策略拒绝）/)
  assert.match(fault, /重新保存权限或重启 Bot/)
  assert.match(fault, /SANDBOX_GUARD_FAULT\/Error/)
  assert.doesNotMatch(fault, /产品策略拒绝/)
})

test('an unenforced mutating tool outside the workspace gets the product confirmation; a bounded one delegates', async t => {
  const f = fixture(t)
  const confirmations = []
  const g = guardFor({
    workspace: f.workspace,
    outside: f.outside,
    overrides: {
      confirmUnenforcedWrite: facts => {
        confirmations.push(facts)
        return { kind: 'ask', reason: `confirm ${facts.toolName}`, displayReason: { en: 'confirm', zh: '确认' } }
      },
    },
  })
  const delegated = await g.run('write', { path: join(f.workspace, 'inside.txt') })
  assert.equal(delegated.result.kind, 'allow', 'inside the workspace the guard never confirms')
  assert.deepEqual(confirmations, [])
  const executedBefore = g.executed.length
  const confirmed = await g.run('write', { path: join(f.outside, 'outer.txt') })
  assert.equal(confirmed.result.kind, 'ask')
  assert.equal(confirmed.result.reason, 'confirm write')
  assert.equal(g.executed.length, executedBefore, 'the confirmed call must not execute before the human answers')
  assert.equal(existsSync(join(f.outside, 'outer.txt')), false)
  assert.equal(confirmations.length, 1)
  assert.equal(confirmations[0].outside, true)
})

test('the product confirmation can deny (never-ask) with a fail-closed, recoverable reason', async t => {
  const f = fixture(t)
  const g = guardFor({
    workspace: f.workspace,
    outside: f.outside,
    overrides: {
      confirmUnenforcedWrite: () => ({
        kind: 'deny',
        reason: '产品审批模式为“从不询问”…已拒绝本次调用（fail-closed，未执行任何操作）。可在 DSH 设置 → Bot → 权限中改为询问后重试。',
      }),
    },
  })
  const denied = await g.run('write', { path: join(f.outside, 'denied.txt') })
  assert.equal(denied.result.kind, 'deny')
  assert.match(denied.result.reason, /fail-closed/)
  assert.match(denied.result.reason, /改为询问后重试/)
  assert.deepEqual(g.executed, [])
  assert.equal(existsSync(join(f.outside, 'denied.txt')), false)
})

test('a confirmation callback that throws is a guard fault (denied, no side effect)', async t => {
  const f = fixture(t)
  const target = join(f.base, 'never-ran.txt')
  const g = guardFor({
    workspace: f.workspace,
    outside: f.outside,
    overrides: { confirmUnenforcedWrite: () => { throw new Error('settings unreadable') } },
  })
  const { result } = await g.run('write', { path: join(f.outside, 'x.txt') }, { onNext: () => writeFileSync(target, 'ran') })
  assert.equal(result.kind, 'deny')
  assert.match(result.reason, /守卫故障/)
  assert.equal(existsSync(target), false)
  assert.ok(g.audits.some(item => item.event === 'tool.guard_fault'))
})
