import { it, expect, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const state = vi.hoisted(() => ({
  urls: [] as string[],
  events: [] as { channel: string; data: { phase?: string; offerUrl?: string } }[],
  destroyed: false,
  menu: [] as { label?: string; click?: () => void }[],
  owners: [] as object[],
  handlers: new Map<string, (event: { sender: object }, value?: unknown) => unknown>(),
}))
vi.mock('electron', () => ({
  BrowserWindow: class {
    constructor() { state.owners.push(this.webContents) }
    webContents = {
      send: (channel: string, data: object) => state.events.push({ channel, data }),
      setWindowOpenHandler: () => {},
      on: () => {},
      once: () => {},
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
    setBounds() {}
    setAlwaysOnTop() {}
    setFocusable() {}
    showInactive() {}
    hide() {}
    on() {}
    setVisibleOnAllWorkspaces() {}
    setIgnoreMouseEvents() {}
    getBounds() { return { x:0,y:0,width:172,height:204 } }
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
  Menu: { buildFromTemplate: (items: { label?: string; click?: () => void }[]) => { state.menu = items; return { popup() {} } } },
  session: { fromPartition: () => ({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} }) },
  Notification:{ isSupported:()=>false },
  systemPreferences: {},
  globalShortcut: { register: () => true, unregister() {} },
  dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
}))
import { ProductPet } from '../src/pet-runtime.ts'
it('reconnects speech without reloading the pet document and authenticates signaling', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pet-live-')),
    resources = join(root, 'resources'),
    home = join(root, 'user')
  const paths: string[] = []
  const host = createServer((req, res) => {
    paths.push(req.url || '')
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
  mkdirSync(join(home,'pet'), { recursive:true })
  writeFileSync(join(home,'pet/pet-experience.json'),JSON.stringify({ onboarding:{ completed:true } }))
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
  let quitRequested = false
  const pet = new ProductPet({
    resources,
    home,
    development: true,
    appPath: join(root, 'apps/desktop'),
    voicePort: signalingAddress.port,
    toggleMain: () => {},
    quit: () => { quitRequested = true },
  })
  let stage = 'configure'
  try {
    await pet.start({ voice: { apiKey: 'fake-key' } })
    state.handlers.get('pet:menu')?.({ sender: state.owners[0]! })
    expect(state.menu.some(item => item.label === '检查任务状态')).toBe(true)
    state.menu.find(item => item.label === '退出 dsh-bot')?.click?.()
    expect(quitRequested).toBe(true)
    await pet.configure({ voice: { apiKey: 'fake-key' } })
    expect(state.events.filter(x => x.channel === 'pet:voice-state').at(-1)?.data.phase).toBe('unconfigured')
    await pet.configure({ llm: { apiKey: 'fixture-model-key' }, voice: { apiKey: 'fake-key', voice: 'Serena' } })
    expect(state.urls).toHaveLength(1)
    const firstUrl = state.urls[0]
    if (!firstUrl) throw new Error('Pet document unavailable')
    const voice = state.events.filter(x => x.channel === 'pet:voice-state').at(-1)?.data
    expect(voice?.phase).toBe('available')
    if (!voice?.offerUrl) throw new Error('No signaling URL')
    const petOwner = state.owners[0]
    if (!petOwner) throw new Error('Missing owned pet')
    const status = state.handlers.get('pet:voice-status'), action = state.handlers.get('pet:bubble-action')
    status?.({ sender:petOwner }, { kind:'capture-start',captureId:'capture-a',text:'正在听…' })
    const bubbleOwner=state.owners[1]
    if (!bubbleOwner) throw new Error('Missing owned bubble')
    action?.({ sender:bubbleOwner }, { type:'cancel',id:'cancel-capture',requestId:'capture-a' })
    expect(state.events.at(-1)).toMatchObject({ channel:'pet:voice-command',data:{ action:'discard',captureId:'capture-a' } })
    const count = state.events.length
    action?.({ sender:bubbleOwner }, { type:'cancel',id:'cancel-capture',requestId:'capture-a' })
    expect(state.events.length).toBe(count)
    status?.({ sender:petOwner }, { kind:'input',captureId:'capture-b',text:'打开窗口' })
    status?.({ sender:petOwner }, { kind:'transcript',captureId:'capture-b',text:'打开窗口' })
    action?.({ sender:bubbleOwner }, { type:'cancel',id:'cancel-capture',requestId:'capture-b' })
    expect(state.events.filter(x=>x.channel==='pet:voice-command')).toHaveLength(1)
    expect(paths.some(path=>path.startsWith('/cancel'))).toBe(false)
    expect(() => action?.({ sender:{} },{ type:'cancel',id:'cancel-capture',requestId:'capture-a' })).toThrow('Unowned bubble')
    stage = 'pet document'
    const document = await fetch(firstUrl)
    expect(document.status).toBe(200)
    expect(await document.text()).not.toContain('fake-key')
    stage = 'served bubble script closure'
    const bubbleUrl = new URL('bubble.html', firstUrl)
    const bubbleResponse = await fetch(bubbleUrl)
    expect(bubbleResponse.status).toBe(200)
    const bubbleHtml = await bubbleResponse.text()
    const scripts = [...bubbleHtml.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]!)
    expect(scripts).toContain('./bubble-markdown.js')
    for (const script of scripts) {
      const resource = await fetch(new URL(script, bubbleUrl))
      expect(resource.status, script).toBe(200)
      expect(resource.headers.get('content-type'), script).toContain('text/javascript')
      expect((await resource.text()).length, script).toBeGreaterThan(0)
    }
    expect((await fetch(new URL('/bubble-markdown.js', firstUrl))).status).toBe(404)
    stage = 'authenticated signaling'
    expect(
      await (
        await fetch(voice.offerUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      ).json(),
    ).toEqual({ authenticated: true })
    stage = 'foreign origin rejection'
    expect(
      (await fetch(voice.offerUrl, { method: 'POST', headers: { origin: 'https://foreign.example' }, body: '{}' }))
        .status,
    ).toBe(403)
    stage = 'nonce protection'
    expect((await fetch(new URL('/index.html', voice.offerUrl))).status).toBe(404)
  } catch (error) {
    throw new Error(`Pet integration failed during ${stage}`, { cause:error })
  } finally {
    await pet.stop()
    await new Promise<void>(done => signaling.close(() => done()))
    await new Promise<void>(done => host.close(() => done()))
    rmSync(root, { recursive: true, force: true })
  }
  expect(state.destroyed).toBe(true)
  await expect(fetch(state.urls[0] || 'http://127.0.0.1:1')).rejects.toThrow()
}, 20000)
