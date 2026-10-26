import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const state = vi.hoisted(() => ({
  urls: [] as string[],
  events: [] as { channel: string; data: { phase?: string; offerUrl?: string } }[],
  destroyed: false,
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    webContents = {
      send: (channel: string, data: object) => state.events.push({ channel, data }),
      setWindowOpenHandler: () => {},
      on: () => {},
    }
    loadURL(url: string) {
      state.urls.push(url)
      return Promise.resolve()
    }
    isDestroyed() {
      return state.destroyed
    }
    destroy() {
      state.destroyed = true
    }
    getPosition() {
      return [0, 0]
    }
    setPosition() {}
    on() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    getBounds() { return { x:0,y:0,width:172,height:204 } }
  },
  ipcMain: { handle: () => {}, removeHandler: () => {} },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    getAllDisplays: () => [{ id: 1, workArea: { x: 0, y: 0, width: 1000, height: 800 } }],
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
  },
  powerMonitor: { getSystemIdleTime: () => 100 },
  Menu: { buildFromTemplate: () => ({ popup() {} }) },
  session: { fromPartition: () => ({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} }) },
  systemPreferences: {},
  globalShortcut: { register: () => true, unregister() {} },
  dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
}))
import { ProductPet } from '../src/pet-runtime.ts'
it('reconnects speech without reloading the pet document and authenticates signaling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-live-')),
    resources = join(root, 'resources'),
    home = join(root, 'user')
  const host = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, events: [] }))
  })
  await new Promise<void>(done => host.listen(0, '127.0.0.1', done))
  const address = host.address()
  if (!address || typeof address === 'string') throw new Error('No host')
  mkdirSync(join(home, 'dsh-home/bot'), { recursive: true })
  writeFileSync(
    join(home, 'dsh-home/bot/bridge.json'),
    JSON.stringify({ port: address.port, pid: process.pid, token: 'fixture-bridge' }),
  )
  mkdirSync(resources, { recursive: true })
  cpSync(resolve('apps/desktop/resources/pet'), join(resources, 'pet'), { recursive: true })
  cpSync(resolve('apps/desktop/resources/whale-girl'), join(resources, 'whale-girl'), { recursive: true })
  // An explicit signaling fixture; real Python process supervision has its own smoke test.
  const tokenFile = join(root, 'signaling-token')
  const signaling = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ authenticated: req.headers['x-spike-token'] === readFileSync(tokenFile, 'utf8') }))
  })
  await new Promise<void>(done => signaling.listen(0, '127.0.0.1', done))
  const signalingAddress = signaling.address()
  if (!signalingAddress || typeof signalingAddress === 'string') throw new Error('No signaling')
  writeFileSync(
    join(resources, 'pet/voice-worker-runtime.mjs'),
    `import {writeFileSync} from 'node:fs';export function createVoiceWorkerRuntime({env}){return{async start(){writeFileSync(${JSON.stringify(tokenFile)},env.NISSE_PIPECAT_TOKEN);return{state:'running'}},async stop(){}}}`,
  )
  const pet = new ProductPet({
    resources,
    home,
    development: true,
    appPath: join(root, 'apps/desktop'),
    voicePort: signalingAddress.port,
    toggleMain: () => {},
  })
  try {
    await pet.start({ voice: { apiKey: 'fake-key' } })
    await pet.configure({ voice: { apiKey: 'fake-key', voice: 'Serena' } })
    expect(state.urls).toHaveLength(1)
    const firstUrl = state.urls[0]
    if (!firstUrl) throw new Error('Pet document unavailable')
    const voice = state.events.filter(x => x.channel === 'pet:voice-state').at(-1)?.data
    expect(voice?.phase).toBe('available')
    if (!voice?.offerUrl) throw new Error('No signaling URL')
    const document = await fetch(firstUrl)
    expect(document.status).toBe(200)
    expect(await document.text()).not.toContain('fake-key')
    expect(
      await (
        await fetch(voice.offerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      ).json(),
    ).toEqual({ authenticated: true })
    expect(
      (await fetch(voice.offerUrl, { method: 'POST', headers: { origin: 'https://foreign.example' }, body: '{}' }))
        .status,
    ).toBe(403)
    expect((await fetch(new URL('/index.html', voice.offerUrl))).status).toBe(404)
  } finally {
    await pet.stop()
    await new Promise<void>(done => signaling.close(() => done()))
    await new Promise<void>(done => host.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
  expect(state.destroyed).toBe(true)
  await expect(fetch(state.urls[0] || 'http://127.0.0.1:1')).rejects.toThrow()
}, 20000)
