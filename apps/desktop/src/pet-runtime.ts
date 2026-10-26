/** Own the pet window and Pipecat worker within the desktop Electron process. */
import { BrowserWindow, ipcMain, screen, session, systemPreferences, Menu, powerMonitor } from 'electron'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type { BotRuntimeConfig } from './bot-runtime.ts'
type VoiceState = { phase: string; error?: string; offerUrl?: string }
type Worker = { start(): Promise<{ state: string; lastError?: string }>; stop(): Promise<unknown> }
type WorkerModule = {
  createVoiceWorkerRuntime(options: {
    env: NodeJS.ProcessEnv
    projectRoot: string
    logger: { info(message: string, detail?: unknown): void }
  }): Worker
}
type PendingInteraction = { id: string; kind: string; sessionId: string; questions?: object[] }
type Presentation = {
  sync(snapshot: { pid: number; sessionId: string; requests: PendingInteraction[] }): void
  event(event: { ioSeq: number; type: string }): void
  notice(text: string, kind?: string): void
  voice(state: string): void
  action(value: object): Promise<void>
  state(): { working: boolean; startedAt: number; waiting: boolean }
  stop(): void
}
type BubbleController = {
  show(payload: object): void
  hide(): void
  destroy(): void
  reposition(bounds: Electron.Rectangle): void
  owns(contents: Electron.WebContents): boolean
  setInteractive(value: boolean): void
  setInputMode(value: boolean): void
}
type PetModules = {
  createBubbleWindowController(options: { BrowserWindow: typeof BrowserWindow; preloadPath: string; pageUrl: string }): BubbleController
  orbBubbleWindowBounds(options: { orbBounds: Electron.Rectangle; workArea: Electron.Rectangle }): Electron.Rectangle
}
export class ProductPet {
  private window: BrowserWindow | null = null
  private server: Server | null = null
  private worker: Worker | null = null
  private voice: VoiceState = { phase: 'disabled' }
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private token = ''
  private offerUrl = ''
  private poll: ReturnType<typeof setInterval> | null = null
  private polling = false
  private pollTask: Promise<void> | null = null
  private requests = new AbortController()
  private lastSeq = 0
  private identity = ''
  private bubble: BubbleController | null = null
  private bubbleModule: PetModules | null = null
  private presentation: Presentation | null = null
  private pause: { start(): void; stop(): void } | null = null
  private config: BotRuntimeConfig = {}
  private microphone = false
  private drag: { x: number; y: number; wx: number; wy: number } | null = null
  private readonly channels = [
    'state',
    'toggle-main',
    'approval',
    'cancel',
    'voice-status',
    'drag-start',
    'drag-move',
    'drag-end', 'menu', 'hit', 'bubble-action', 'bubble-interactive', 'bubble-focus', 'bubble-open',
  ]
  constructor(
    private readonly options: {
      resources: string
      home: string
      development: boolean
      appPath: string
      voicePort?: number
      toggleMain(reveal?: boolean): void
    },
  ) {}
  private log(message: string, detail?: unknown): void {
    const dir = join(this.options.home, 'pet/logs'),
      file = join(dir, 'desktop.log')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (existsSync(file) && statSync(file).size > 1_000_000) renameSync(file, file + '.previous')
    appendFileSync(file, `${new Date().toISOString()} ${message} ${JSON.stringify(detail ?? '')}\n`, { mode: 0o600 })
  }
  private publish(state: VoiceState): void {
    this.voice = state
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('pet:voice-state', state)
  }
  private descriptor(): { port: number; token: string; pid: number } {
    return JSON.parse(readFileSync(join(this.options.home, 'dsh-home/bot/bridge.json'), 'utf8')) as {
      port: number
      token: string
      pid: number
    }
  }
  private request(path: string, body?: object): Promise<Response> {
    const d = this.descriptor()
    return fetch(`http://127.0.0.1:${d.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${d.token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(4000), this.requests.signal]),
    })
  }
  async start(config: BotRuntimeConfig): Promise<void> {
    this.config = config
    const nonce = randomUUID(),
      root = this.options.resources
    const files = new Map<string, readonly [string, string]>([
      ['index.html', [join(root, 'pet/pet.html'), 'text/html']],
      ['bubble.html', [join(root, 'pet/bubble.html'), 'text/html']],
      ['bubble.css', [join(root, 'pet/bubble.css'), 'text/css']],
      ['bubble.js', [join(root, 'pet/bubble.js'), 'text/javascript']],
      ['skins/whale-girl/pet.json', [join(root, 'whale-girl/pet.json'), 'application/json']],
      ['skins/whale-girl/spritesheet.webp', [join(root, 'whale-girl/spritesheet.webp'), 'image/webp']],
      ['voice-client.js', [join(root, 'pet/voice-client.js'), 'text/javascript']],
      ['whale-girl/pet.json', [join(root, 'whale-girl/pet.json'), 'application/json']],
      ['whale-girl/spritesheet.webp', [join(root, 'whale-girl/spritesheet.webp'), 'image/webp']],
    ])
    const listener = createServer((req, res) => {
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
      if (req.headers.origin && req.headers.origin !== new URL(this.offerUrl).origin) {
        res.writeHead(403)
        res.end()
        return
      }
      if (path === `/${nonce}/api/offer` && ['POST', 'PATCH'].includes(req.method || '')) {
        if (!this.token) {
          res.writeHead(503)
          res.end()
          return
        }
        const upstream = httpRequest(
          {
            host: '127.0.0.1',
            port: this.options.voicePort ?? 8765,
            path: '/api/offer',
            method: req.method,
            headers: { 'content-type': 'application/json', 'x-spike-token': this.token },
          },
          (r) => {
            res.writeHead(r.statusCode || 502, { 'content-type': 'application/json' })
            r.pipe(res)
          },
        )
        upstream.setTimeout(60000, () => upstream.destroy(new Error('Signaling timeout')))
        upstream.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        req.pipe(upstream)
        return
      }
      const item = path.startsWith(`/${nonce}/`) ? files.get(path.slice(nonce.length + 2)) : undefined
      if (!item) {
        res.writeHead(404)
        res.end()
        return
      }
      res.setHeader('content-type', item[1])
      res.setHeader('referrer-policy', 'no-referrer')
      res.setHeader(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:",
      )
      res.end(readFileSync(item[0]))
    })
    this.server = listener
    await new Promise<void>((done, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', done)
    })
    if (this.stopped) {
      listener.closeAllConnections()
      await new Promise<void>(done => listener.close(() => done()))
      return
    }
    const addr = listener.address()
    if (!addr || typeof addr === 'string') throw new Error('Pet listener unavailable')
    const origin = `http://127.0.0.1:${addr.port}`
    this.offerUrl = `${origin}/${nonce}/api/offer`
    const ownSession = session.fromPartition('persist:dsh-bot-pet')
    ownSession.setPermissionCheckHandler(
      (contents, permission, url, details) =>
        permission === 'media' &&
        contents === this.window?.webContents &&
        details.isMainFrame &&
        new URL(url).origin === origin &&
        details.mediaType === 'audio',
    )
    ownSession.setPermissionRequestHandler((contents, permission, reply, details) => {
      if (
        permission !== 'media' ||
        contents !== this.window?.webContents ||
        !details.isMainFrame ||
        new URL(details.requestingUrl).origin !== origin ||
        !('mediaTypes' in details) ||
        details.mediaTypes.length !== 1 ||
        details.mediaTypes[0] !== 'audio'
      ) {
        reply(false)
        return
      }
      if (process.platform === 'darwin')
        void systemPreferences.askForMediaAccess('microphone').then(reply, () => reply(false))
      else reply(true)
    })
    const area = screen.getPrimaryDisplay().workArea
    const window = new BrowserWindow({
      width: 172,
      height: 204,
      x: area.x + area.width - 196,
      y: area.y + area.height - 228,
      hasShadow: false,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(root, 'pet/pet-preload.cjs'),
        session: ownSession,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    })
    this.window = window
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    window.setIgnoreMouseEvents(true, { forward: true })
    const geometry = await import(pathToFileURL(join(root, 'pet/bubble-window.mjs')).href) as PetModules
    this.bubbleModule = geometry
    this.bubble = geometry.createBubbleWindowController({ BrowserWindow, preloadPath: join(root, 'pet/bubble-preload.cjs'), pageUrl: `${origin}/${nonce}/bubble.html` })
    const presenter = await import(pathToFileURL(join(root, 'pet/companion-presentation.mjs')).href) as {
      createCompanionPresentation(options: {
        show(payload: object): void
        hide(): void
        animate(payload: object): void
        send(path: string, body?: object): Promise<void>
      }): Presentation
    }
    this.presentation = presenter.createCompanionPresentation({
      show: (payload) => { this.positionBubble(); this.bubble?.show(payload) },
      hide: () => this.bubble?.hide(),
      animate: payload => this.window?.webContents.send('pet:presentation', payload),
      send: async (path, body) => {
        if (path === 'open') { this.options.toggleMain(true); return }
        const response = await this.request(path, body)
        if (!response.ok) throw Object.assign(new Error(`DSH request failed: ${response.status}`), { stale: response.status === 409 })
      },
    })
    const placement = await import(pathToFileURL(join(root, 'pet/orb-placement.mjs')).href) as {
      createOrbPlacement(options: {
        getDisplays(): Electron.Display[]
        orbSize: { width: number; height: number }
        loadState(): object | null
        saveState(position: object): void
      }): {
        initialPosition(): { x: number; y: number }
        recordPosition(point: { x: number; y: number }): void
      }
    }
    const positionFile = join(this.options.home, 'pet/position.json')
    const position = placement.createOrbPlacement({
      getDisplays: () => screen.getAllDisplays(), orbSize: { width: 172, height: 204 },
      loadState: () => { try { return JSON.parse(readFileSync(positionFile, 'utf8')) as object } catch { return { x: area.x + area.width - 196, y: area.y + area.height - 228 } } },
      saveState: (value) => { mkdirSync(join(this.options.home, 'pet'), { recursive: true, mode: 0o700 }); writeFileSync(positionFile, JSON.stringify(value), { mode: 0o600 }) },
    })
    const initial = position.initialPosition()
    window.setPosition(initial.x, initial.y)
    window.on('move', () => this.positionBubble())
    const pauseModule = await import(pathToFileURL(join(root, 'pet/pause-on-input.mjs')).href) as {
      createPauseOnInputMonitor(options: {
        getIdleSeconds(): number
        isTurnActive(): boolean
        getTurnStartedAt(): number
        shouldPause(): boolean
        onPause(): void
      }): { start(): void; stop(): void }
    }
    this.pause = pauseModule.createPauseOnInputMonitor({
      getIdleSeconds: () => powerMonitor.getSystemIdleTime(),
      isTurnActive: () => this.presentation?.state().working === true,
      getTurnStartedAt: () => this.presentation?.state().startedAt || 0,
      shouldPause: () => this.config.behavior?.pauseOnInput !== false && !this.presentation?.state().waiting,
      onPause: () => { void this.request('/cancel', {}).then(response => this.presentation?.notice(response.ok ? '已暂停，等你。' : '暂停失败，请打开 DSH 查看。'), () => this.presentation?.notice('暂停失败，请打开 DSH 查看。', 'error')) },
    })
    this.pause.start()
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault()
    })
    const assertOwner = (sender: Electron.WebContents): void => {
      if (sender !== this.window?.webContents) throw new Error('Unowned pet renderer')
    }
    const assertBubble = (sender: Electron.WebContents): void => { if (!this.bubble?.owns(sender)) throw new Error('Unowned bubble renderer') }
    ipcMain.handle('pet:bubble-action', (e, value: unknown) => { assertBubble(e.sender); if (!value || typeof value !== 'object') throw new Error('Invalid action'); return this.presentation?.action(value) })
    ipcMain.handle('pet:bubble-interactive', (e, value: unknown) => { assertBubble(e.sender); this.bubble?.setInteractive(value === true) })
    ipcMain.handle('pet:bubble-focus', (e, value: unknown) => { assertBubble(e.sender); this.bubble?.setInputMode(value === true) })
    ipcMain.handle('pet:bubble-open', (e) => { assertBubble(e.sender); this.options.toggleMain(true) })
    ipcMain.handle('pet:hit', (e, value: unknown) => { assertOwner(e.sender); window.setIgnoreMouseEvents(value !== true, { forward: true }) })
    ipcMain.handle('pet:menu', (e) => {
      assertOwner(e.sender)
      const active = this.presentation?.state().working === true
      Menu.buildFromTemplate([
        { label: '打开 DSH', click: () => this.options.toggleMain(true) },
        { label: this.microphone ? '关闭语音' : '开启语音', click: () => window.webContents.send('pet:voice-command', { action: 'toggle' }) },
        ...(active ? [{ label: '停止任务', click: () => { void this.request('/cancel', {}).catch(() => this.presentation?.notice('停止失败，请打开 DSH 查看。', 'error')) } }] : []),
      ]).popup({ window })
    })
    ipcMain.handle('pet:state', (e) => {
      assertOwner(e.sender)
      return this.voice
    })
    ipcMain.handle('pet:toggle-main', (e) => {
      assertOwner(e.sender)
      this.options.toggleMain()
    })
    ipcMain.handle('pet:approval', async (e, id: unknown, decision: unknown) => {
      assertOwner(e.sender)
      if (typeof id !== 'string' || !['allow', 'reject'].includes(String(decision))) throw new Error('Invalid approval')
      if (!(await this.request('/approval', { id, decision })).ok) throw new Error('Approval failed')
    })
    ipcMain.handle('pet:cancel', async (e) => {
      assertOwner(e.sender)
      if (!(await this.request('/cancel', {})).ok) throw new Error('Cancellation failed')
    })
    ipcMain.handle('pet:voice-status', (e, message: unknown) => {
      assertOwner(e.sender)
      if (message && typeof message === 'object') {
        const status = message as { text?: string; phase?: string; enabled?: boolean; notify?: boolean }
        if (typeof status.enabled === 'boolean') this.microphone = status.enabled
        if (['idle', 'listening', 'speaking', 'processing'].includes(status.phase || '')) this.presentation?.voice(status.phase || 'idle')
        if (status.notify && status.text) this.presentation?.notice(status.text)
        this.log('voice-client', String(status.text || status.phase || '').slice(0, 400))
      } else this.log('voice-client', String(message).slice(0, 400))
    })
    ipcMain.handle('pet:drag-start', (e, x: unknown, y: unknown) => {
      assertOwner(e.sender)
      if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return
      const [wx, wy] = window.getPosition()
      this.drag = { x, y, wx: wx ?? 0, wy: wy ?? 0 }
    })
    ipcMain.handle('pet:drag-move', (e, x: unknown, y: unknown) => {
      assertOwner(e.sender)
      if (!this.drag || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y))
        return
      const nx = Math.round(this.drag.wx + x - this.drag.x),
        ny = Math.round(this.drag.wy + y - this.drag.y)
      if (Math.abs(nx) < 1e6 && Math.abs(ny) < 1e6) window.setPosition(nx, ny)
    })
    ipcMain.handle('pet:drag-end', (e) => {
      assertOwner(e.sender)
      this.drag = null
      const [x, y] = window.getPosition(); position.recordPosition({ x: x || 0, y: y || 0 })
      this.positionBubble()
    })
    await this.window.loadURL(`${origin}/${nonce}/index.html`)
    this.poll = setInterval(() => {
      if (!this.pollTask) this.pollTask = this.pollEvents().finally(() => { this.pollTask = null })
    }, 300)
    void this.configure(config).catch(error => this.publish({ phase: 'failed', error: String(error) }))
  }
  private async pollEvents(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      const d = this.descriptor(),
        identity = `${d.pid}:${d.port}`
      const changedOwner = identity !== this.identity
      if (changedOwner) {
        this.lastSeq = 0
        this.identity = identity
      }
      const response = await this.request(`/events?after=${this.lastSeq}`)
      if (!response.ok) return
      const payload = (await response.json()) as { events?: { ioSeq: number; type: string }[] }
      const pending = await this.request('/interactions')
      if (pending.ok) {
        const snapshot = await pending.json() as { pid: number; sessionId: string; requests: PendingInteraction[] }
        if (Array.isArray(snapshot.requests)) this.presentation?.sync(snapshot)
      }
      for (const event of payload.events || []) {
        if (event.ioSeq <= this.lastSeq) continue
        this.lastSeq = event.ioSeq
        if (!changedOwner) { this.presentation?.event(event); this.window?.webContents.send('pet:agent-event', event) }
      }
    } catch {
      this.presentation?.sync({ pid: 0, sessionId: '', requests: [] })
    } finally {
      this.polling = false
    }
  }
  private positionBubble(): void {
    if (!this.window || !this.bubbleModule) return
    const orbBounds = this.window.getBounds()
    this.bubble?.reposition(this.bubbleModule.orbBubbleWindowBounds({ orbBounds, workArea: screen.getDisplayMatching(orbBounds).workArea }))
  }
  updateBehavior(config: BotRuntimeConfig): void { this.config = config }
  configure(config: BotRuntimeConfig): Promise<void> {
    this.config = config
    const apply = async (): Promise<void> => {
      this.publish({ phase: 'reconnecting' })
      await this.worker?.stop()
      if (this.stopped) return
      const source = resolve(this.options.appPath, '../../product/voice-worker-src'),
        python =
          process.env.DSH_BOT_VOICE_PYTHON || resolve(this.options.appPath, '../../.mvv-build/voice-venv/bin/python'),
        dir = this.options.development ? source : join(this.options.resources, 'voice-worker')
      this.token = randomUUID()
      const mod = (await import(
        pathToFileURL(join(this.options.resources, 'pet/voice-worker-runtime.mjs')).href,
      )) as WorkerModule
      const key = config.voice?.apiKey || ''
      if (!key) {
        this.worker = null
        this.publish({ phase: 'unconfigured', error: '请先在 Bot 设置中填写语音 API Key' })
        return
      }
      this.worker = mod.createVoiceWorkerRuntime({
        projectRoot: this.options.resources,
        env: {
          ...process.env,
          NISSE_PIPECAT_WORKER: '1',
          NISSE_PIPECAT_PORT: String(this.options.voicePort ?? 8765),
          NISSE_VOICE_WORKER_PORT: String(this.options.voicePort ?? 8765),
          NISSE_PIPECAT_WORKER_COMMAND: this.options.development ? python : join(dir, 'VoiceWorker'),
          NISSE_PIPECAT_WORKER_DIR: dir,
          NISSE_PIPECAT_WORKER_ARGS_JSON: JSON.stringify(
            this.options.development ? [join(source, 'run_worker.py')] : [],
          ),
          NISSE_PIPECAT_BRIDGE_DESCRIPTOR: join(this.options.home, 'dsh-home/bot/bridge.json'),
          NISSE_PIPECAT_TOKEN: this.token,
          DASHSCOPE_API_KEY: key,
          DSH_WAKE_PHRASE: config.voice?.wakeWord || '',
          DASHSCOPE_REALTIME_URL: config.voice?.baseUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          DASHSCOPE_ASR_MODEL: config.voice?.model || 'qwen3-asr-flash-realtime',
          DASHSCOPE_TTS_MODEL: 'qwen3-tts-flash-realtime',
          DASHSCOPE_TTS_VOICE: config.voice?.voice || 'Cherry',
        },
        logger: {
          info: (message, detail) => {
            const text = JSON.stringify(detail ?? '')
            this.log(message, key ? text.replaceAll(key, '[credential]') : text)
          },
        },
      })
      const state = await this.worker.start()
      if (this.stopped) {
        await this.worker.stop()
        return
      }
      this.publish(
        state.state === 'running'
          ? { phase: 'available', offerUrl: this.offerUrl }
          : { phase: 'failed', error: state.lastError || state.state },
      )
    }
    const pending = this.queue.then(apply)
    this.queue = pending.catch(() => {})
    return pending
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.requests.abort()
    if (this.poll) clearInterval(this.poll)
    this.pause?.stop()
    this.presentation?.stop()
    this.bubble?.destroy()
    await this.pollTask
    await this.worker?.stop()
    await this.queue
    for (const name of this.channels) ipcMain.removeHandler('pet:' + name)
    this.window?.destroy()
    this.window = null
    await new Promise<void>((done) => {
      if (this.server) {
        this.server.close(() => done())
        this.server.closeAllConnections()
      } else done()
    })
  }
}
