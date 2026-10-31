/**
 * S2 Desktop cancel entry.
 *
 * The pet process is one of the product's cancel entry points, so it must stop
 * the turn the user actually saw: the v2 command carries the captured target, a
 * refused stop never degrades into an unscoped legacy `/cancel`, and an
 * unconfirmed stop is never worded as a success.
 */
import { beforeEach, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const state = vi.hoisted(() => ({
  events: [] as { channel: string; data: Record<string, unknown> }[],
  owners: [] as object[],
  handlers: new Map<string, (event: { sender: object }, value?: unknown) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { dock: { isVisible: () => true } },
  BrowserWindow: class {
    constructor() { state.owners.push(this.webContents) }
    webContents = {
      send: (channel: string, data: object) => state.events.push({ channel, data: data as Record<string, unknown> }),
      setWindowOpenHandler: () => {},
      on: () => {},
      once: () => {},
    }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return false }
    destroy() {}
    getPosition() { return [0, 0] }
    setPosition() {}
    setBounds() {}
    setAlwaysOnTop() {}
    setFocusable() {}
    showInactive() {}
    hide() {}
    on() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    getBounds() { return { x: 0, y: 0, width: 172, height: 204 } }
  },
  ipcMain: {
    handle: (name: string, handle: (event: { sender: object }, value?: unknown) => unknown) => state.handlers.set(name, handle),
    removeHandler: (name: string) => state.handlers.delete(name),
  },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } }],
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
  powerMonitor: { getSystemIdleTime: () => 100 },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: () => ({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} }) },
  Notification: { isSupported: () => false },
  systemPreferences: {},
  globalShortcut: { register: () => true, unregister() {} },
  dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
}))

import { cancelFailureNotice, cancelReceiptNotice, ProductPet } from '../src/pet-runtime.ts'

beforeEach(() => {
  state.events.length = 0
  state.owners.length = 0
  state.handlers.clear()
})

/** Host fixture: v2 snapshot with one running turn, recording every request. */
function createHost(options: { execution: Record<string, unknown>; receipt: Record<string, unknown> | null; legacy?: boolean }) {
  const requests: { path: string; body: Record<string, unknown> | null }[] = []
  const host = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    let raw = ''
    req.on('data', (chunk) => { raw += String(chunk) })
    req.on('end', () => {
      requests.push({ path: url.pathname, body: raw === '' ? null : JSON.parse(raw) as Record<string, unknown> })
      res.setHeader('content-type', 'application/json')
      if (options.legacy === true && url.pathname.startsWith('/v2/')) { res.statusCode = 404; res.end(JSON.stringify({ error: 'not_found' })); return }
      if (url.pathname === '/v2/snapshot') {
        res.end(JSON.stringify({
          schema: 'snapshot@1',
          protocolVersion: 'dsh-bot-v1',
          hostEpoch: 'epoch-fixture',
          snapshotSeq: 9,
          identity: { sessionId: 'session-fixture', hostPid: process.pid },
          execution: options.execution,
          interactions: { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] },
          queue: { revision: 0, items: [] },
          presentation: { displayMode: 'idle', priority: [], bubble: { visible: false, requestId: null, kind: null } },
        }))
        return
      }
      if (url.pathname === '/v2/events') { res.end(JSON.stringify({ events: [], next: 9, resyncRequired: false })); return }
      if (url.pathname === '/v2/command') {
        res.end(JSON.stringify(options.receipt ?? { protocolVersion: 'dsh-bot-v1', commandId: 'x', hostEpoch: 'epoch-fixture', status: 'resolved', result: { confirmed: true }, error: null }))
        return
      }
      if (url.pathname === '/task-state') {
        res.end(JSON.stringify({
          sessionId: 'session-fixture', clientTurnId: 'client-7', turn: 7, hostEpoch: 'epoch-fixture', status: 'working', lastTurn: null,
        }))
        return
      }
      if (url.pathname === '/cancel') {
        res.end(JSON.stringify({ ok: true, cancelled: true, confirmed: true, sessionId: 'session-fixture', settledApprovals: 0 }))
        return
      }
      res.end(JSON.stringify({ ok: true, events: [] }))
    })
  })
  return { host, requests }
}

/** Start one pet against the fixture host and hand back the cancel IPC handler. */
async function startPet(options: { execution: Record<string, unknown>; receipt?: Record<string, unknown> | null; legacy?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'pet-s2-cancel-'))
  const { host, requests } = createHost({
    execution: options.execution,
    receipt: options.receipt ?? null,
    ...(options.legacy === true ? { legacy: true } : {}),
  })
  await new Promise<void>(done => host.listen(0, '127.0.0.1', () => { done() }))
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('No host address')
  const home = join(root, 'user')
  const resources = join(root, 'resources')
  mkdirSync(join(home, 'dsh-home/bot'), { recursive: true })
  writeFileSync(join(home, 'dsh-home/bot/bridge.json'), JSON.stringify({ port: address.port, pid: process.pid, token: 'fixture-bridge' }))
  mkdirSync(join(home, 'pet'), { recursive: true })
  writeFileSync(join(home, 'pet/pet-experience.json'), JSON.stringify({ onboarding: { completed: true } }))
  mkdirSync(resources, { recursive: true })
  cpSync(resolve('apps/desktop/resources/pet'), join(resources, 'pet'), { recursive: true })
  cpSync(resolve('apps/desktop/resources/whale-girl'), join(resources, 'whale-girl'), { recursive: true })
  writeFileSync(join(resources, 'pet/voice-worker-runtime.mjs'), 'export function createVoiceWorkerRuntime(){return{async start(){return{state:"running"}},async stop(){}}}')
  const pet = new ProductPet({ resources, home, development: true, appPath: join(root, 'apps/desktop'), voicePort: 8765, toggleMain: () => {} })
  await pet.start({})
  // Let the v2 snapshot poll settle so the captured target exists.
  const deadline = Date.now() + 5000
  while (!requests.some(entry => entry.path.startsWith('/v2/snapshot')) && Date.now() < deadline) {
    await new Promise(done => setTimeout(done, 20))
  }
  await new Promise(done => setTimeout(done, 120))
  const handler = state.handlers.get('pet:cancel')
  if (!handler) throw new Error('Missing pet:cancel handler')
  const owner = state.owners[0]
  if (!owner) throw new Error('Missing pet owner window')
  return {
    requests,
    cancel: () => handler({ sender: owner }, undefined),
    dispose: async () => {
      await pet.stop()
      await new Promise<void>((done) => { host.close(() => { done() }) })
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const RUNNING = { state: 'working', sessionId: 'session-fixture', turn: 7, turnId: 'session-fixture:7', clientTurnId: 'client-7' }

it('sends the captured target and never falls back to an unscoped legacy cancel', async () => {
  const pet = await startPet({ execution: RUNNING })
  try {
    await pet.cancel()
    const commands = pet.requests.filter(entry => entry.path === '/v2/command')
    expect(commands).toHaveLength(1)
    expect(commands[0]?.body?.['type']).toBe('control.cancel-task')
    expect(commands[0]?.body?.['hostEpoch']).toBe('epoch-fixture')
    expect(commands[0]?.body?.['sessionId']).toBe('session-fixture')
    expect(commands[0]?.body?.['payload']).toEqual({
      target: { hostEpoch: 'epoch-fixture', sessionId: 'session-fixture', turn: 7, turnId: 'session-fixture:7', clientTurnId: 'client-7' },
    })
    expect(pet.requests.some(entry => entry.path === '/cancel')).toBe(false)
  } finally {
    await pet.dispose()
  }
})

it('does not degrade into the legacy endpoint when the v2 stop is refused as stale', async () => {
  const pet = await startPet({
    execution: RUNNING,
    receipt: { protocolVersion: 'dsh-bot-v1', commandId: 'x', hostEpoch: 'epoch-fixture', status: 'rejected', result: {}, error: { code: 'STALE_TURN', message: 'the cancelled DSH turn is no longer the active turn' } },
  })
  try {
    await pet.cancel()
    expect(pet.requests.filter(entry => entry.path === '/v2/command')).toHaveLength(1)
    // Falling back here is what used to cancel the successor turn.
    expect(pet.requests.some(entry => entry.path === '/cancel')).toBe(false)
    expect(pet.requests.some(entry => entry.path === '/task-state')).toBe(false)
  } finally {
    await pet.dispose()
  }
})

it('sends nothing when no turn is running', async () => {
  const pet = await startPet({ execution: { state: 'idle', sessionId: 'session-fixture', turn: null, clientTurnId: null } })
  try {
    await pet.cancel()
    expect(pet.requests.some(entry => entry.path === '/v2/command')).toBe(false)
    expect(pet.requests.some(entry => entry.path === '/cancel')).toBe(false)
  } finally {
    await pet.dispose()
  }
})

it('sends the same identity on the legacy endpoint instead of an empty body', async () => {
  const pet = await startPet({ execution: RUNNING, legacy: true })
  try {
    // The legacy bridge has no v2 snapshot, so the pet reads the identity back
    // from /task-state in the same request cycle.
    const deadline = Date.now() + 5000
    while (!pet.requests.some(entry => entry.path === '/task-state') && Date.now() < deadline) {
      await new Promise(done => setTimeout(done, 20))
    }
    await pet.cancel()
    const cancels = pet.requests.filter(entry => entry.path === '/cancel')
    expect(cancels).toHaveLength(1)
    expect(cancels[0]?.body).toMatchObject({ source: 'task-stop', hostEpoch: 'epoch-fixture', sessionId: 'session-fixture', turn: 7, clientTurnId: 'client-7' })
    expect(pet.requests.some(entry => entry.path === '/v2/command')).toBe(false)
  } finally {
    await pet.dispose()
  }
})

it('words an unconfirmed stop as pending, never as stopped', () => {
  expect(cancelReceiptNotice({ status: 'resolved', result: { confirmed: true } })).toBeNull()
  const pending = cancelReceiptNotice({ status: 'pending', result: { confirmed: false } })
  expect(pending?.text).toContain('等待 DSH 确认')
  // Only a negated mention is allowed: the text may say it will not claim a stop.
  expect(pending?.text).not.toMatch(/任务已停止|已确认.*停止|已停止任务/)
  const rejected = cancelReceiptNotice({ status: 'accepted', result: {} })
  expect(rejected?.kind).toBe('error')
  expect(rejected?.text).toContain('结果未知')
})

it('words a stale refusal as "nothing was stopped"', () => {
  for (const code of ['STALE_TURN', 'STALE_HOST_EPOCH', 'CANCEL_TARGET_INCOMPLETE', 'NO_ACTIVE_TURN']) {
    const notice = cancelFailureNotice(code)
    expect(notice.text).toContain('没有执行停止')
    expect(notice.text).not.toMatch(/已停止|已确认/)
  }
  expect(cancelFailureNotice('CONFIRMATION_REQUIRED').text).toContain('需要确认')
  expect(cancelFailureNotice('HTTP_500').kind).toBe('error')
})
