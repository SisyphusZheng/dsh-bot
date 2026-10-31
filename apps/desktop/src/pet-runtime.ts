/** Own the pet window and Pipecat worker within the desktop Electron process. */
import { app, BrowserWindow, ipcMain, screen, session, systemPreferences, Menu, powerMonitor, globalShortcut, dialog, Notification } from 'electron'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { resolvePetVoiceRoute } from './pet-voice-route.ts'
import type { BotRuntimeConfig } from './bot-runtime.ts'
type VoiceState = { phase: string; error?: string; offerUrl?: string; notice?: string }
type Worker = { start(): Promise<{ state: string; lastError?: string }>; stop(): Promise<unknown> }
type WorkerModule = {
  createVoiceWorkerRuntime(options: {
    env: NodeJS.ProcessEnv
    projectRoot: string
    logger: { info(message: string, detail?: unknown): void }
  }): Worker
}
type PendingInteraction = {
  id: string
  kind: string
  sessionId: string
  semanticRevision?: number
  questions?: { id?: string; options?: { id?: string; label?: string }[] }[]
}
type PresentationState = {
  working: boolean
  startedAt: number
  inputSource: string
  waiting: boolean
  queued: number
  mode?: string
  hostEpoch?: string
  snapshotSeq?: number
  lastEventSeq?: number
}
type KernelResult = { applied?: boolean; resync?: boolean; duplicate?: boolean; stale?: boolean; staleEpoch?: boolean; reason?: string }
type Presentation = {
  applySnapshot(snapshot: object): KernelResult
  applyEvent(event: object): KernelResult
  sync(snapshot: { pid: number; sessionId: string; requests: PendingInteraction[] }): void
  event(event: { ioSeq?: number; seq?: number; type: string; data?: object }): KernelResult | void
  notice(text: string, kind?: string, duration?: number, capture?: string, options?: object): void
  capture(status: object): void
  cancelCapture(id: string): boolean
  voice(state: string): void
  syncTaskState(state: object): void
  action(value: object): Promise<void>
  state(): PresentationState
  managePolicies(): Promise<void>
  recoverTask(): Promise<void>
  manageQueue(): Promise<void>
  queue(value: object): void
  voiceAnswer(value: object): Promise<boolean>
  stop(): void
}
type KernelEvent = {
  seq?: number
  type?: string
  sessionId?: string | null
  turn?: number | null
  turnId?: string | null
  data?: Record<string, unknown>
}
type KernelSnapshot = {
  hostEpoch?: string
  snapshotSeq?: number
  identity?: { sessionId?: string | null; hostPid?: number }
  execution?: { state?: string; sessionId?: string | null; turn?: number | null; turnId?: string | null; clientTurnId?: string | null }
  interactions?: { pending?: PendingInteraction[] }
  presentation?: { bubblePolicy?: { placement?: string; anchorGapPx?: number } }
}
type KernelReceipt = { status?: string; result?: Record<string, unknown>; error?: { code?: string; message?: string } | null }

/**
 * User-facing text for one Host cancel receipt.
 *
 * A confirmed stop needs no extra line because the Host already announced it. A
 * pending or rejected stop must not read like a success: the desktop's own message
 * is then the only thing the user may see before the Host's confirmation arrives.
 * @param receipt - receipt returned by `POST /v2/command` for `control.cancel-task`.
 * @returns the notice to show, or null when the Host already reported a confirmed stop.
 */
export function cancelReceiptNotice(receipt: KernelReceipt): { kind: string; text: string } | null {
  if (receipt.status === 'resolved' && receipt.result?.['confirmed'] === true) return null
  if (receipt.status === 'pending') return { kind: 'status', text: '已请求停止任务，正在等待 DSH 确认；确认到达前不会显示为已停止。' }
  return { kind: 'error', text: '停止请求未被接受，任务仍在执行或结果未知；请打开主窗口检查。' }
}

/**
 * User-facing text for a refused or unknown cancel.
 * @param code - product error code (`STALE_TURN`, `CONFIRMATION_REQUIRED`, ...).
 * @returns the notice to show.
 */
export function cancelFailureNotice(code: string): { kind: string; text: string } {
  if (code === 'CONFIRMATION_REQUIRED') return { kind: 'status', text: '停止任务需要确认：请在桌宠气泡里确认「确认停止任务」。' }
  if (/STALE|CANCEL_TARGET|NO_ACTIVE_TURN/.test(code)) return { kind: 'status', text: '要停止的任务已经结束或不是当前任务；没有执行停止。' }
  return { kind: 'error', text: '停止请求未被确认，任务结果未知；请打开主窗口检查，不会自动重试。' }
}
type ProcessType = 'foreground' | 'uielement'
type WindowPolicyModule = {
  windowLayerPlan?(options: { role: string; platform: string; processType: string }): {
    alwaysOnTop?: boolean
    level?: string | null
    spaces?: { visibleOnAllWorkspaces?: boolean; visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }
    focus?: { focusable?: boolean }
    clickThrough?: { defaultIgnoreMouseEvents?: boolean; forwardMouseEvents?: boolean }
  } | null
}
type BubbleController = {
  show(payload: object): void
  hide(): void
  destroy(): void
  reposition(bounds: Electron.Rectangle): void
  resize(height: number): void
  owns(contents: Electron.WebContents): boolean
  setInteractive(value: boolean): void
  setInputMode(value: boolean): void
}
type PetModules = {
  createBubbleWindowController(options: {
    BrowserWindow: typeof BrowserWindow
    preloadPath: string
    pageUrl: string
    processType?: ProcessType | (() => ProcessType)
  }): BubbleController
  orbBubbleWindowBounds(options: {
    orbBounds: Electron.Rectangle
    workArea: Electron.Rectangle
    avoidBounds?: Electron.Rectangle[]
    displays?: Electron.Display[]
    placement?: string
    anchorGapPx?: number
  }): Electron.Rectangle
}
type ExperienceState = {
  showDockIcon?: boolean
  systemNotifications?: boolean
  onboarding?: boolean
  wakeWordEnabled: boolean
  wakeWordPhrase: string
}
type Experience = {
  state(): ExperienceState
  menu(): Electron.MenuItemConstructorOptions[]
  start(): void
  action(value: object): Promise<boolean>
  sync(snapshot: { requests: PendingInteraction[] }): void
  voice(status: object): void
  gesture(phase: string): void
  inputActive(): boolean
  wake(): void
  stop(): Promise<void>
  skinPath(id: string, name: string): string
}
type WakeRuntime = {
  setEnabled(value: boolean): void
  setKeywords(value: string): void
  accept(audio: string, rate: number): boolean
  stop(): Promise<void>
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
  private mode: 'unknown' | 'v2' | 'legacy' = 'unknown'
  private kernel = { lastSeq: 0, hostEpoch: '', snapshotSeq: -1, needsSnapshot: false, legacyNoticeShown: false }
  private kernelSnapshot: KernelSnapshot | null = null
  private legacyRequests: PendingInteraction[] = []
  private processType: (() => ProcessType) | null = null
  private bubble: BubbleController | null = null
  private bubbleModule: PetModules | null = null
  private presentation: Presentation | null = null
  private pause: { start(): void; stop(): void } | null = null
  private config: BotRuntimeConfig = {}
  private attention: { sync(snapshot: object): void;stop(): void } | null = null
  private experience: Experience | null = null
  private wake: WakeRuntime | null = null
  private drag: { x: number; y: number; wx: number; wy: number } | null = null
  private readonly channels = [
    'state',
    'toggle-main',
    'approval',
    'cancel',
    'voice-status', 'queue-open',
    'drag-start',
    'drag-move',
    'drag-end', 'menu', 'hit', 'bubble-action', 'bubble-interactive', 'bubble-focus', 'bubble-open', 'experience', 'gesture', 'wake-audio',
  ]
  constructor(
    private readonly options: {
      resources: string
      home: string
      development: boolean
      appPath: string
      voicePort?: number
      mainBounds?(): Electron.Rectangle[]
      showDockIcon?(visible: boolean): void
      settingsRequest?(path: string, body?: object, method?: string): Promise<Record<string, unknown>>
      quit?(): void
      toggleMain(reveal?: boolean): void
    },
  ) {}
  /**
   * Last classified provider failure reported by the worker health endpoint.
   * /health carries only summary/diagId (no stack), enough to replace the opaque
   * transport error bubble with an actionable message.
   */
  private async lastWorkerVoiceError(): Promise<{ kind?: string; summary?: string; diagId?: string; retryable?: boolean } | null> {
    const port = this.options.voicePort ?? 8765
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(1500) })
      if (!response.ok) return null
      const body = await response.json() as {
        last_error?: { kind?: string; summary?: string; diagId?: string; retryable?: boolean; at?: number }
      }
      const error = body.last_error
      if (!error || typeof error.at !== 'number' || Date.now() - error.at > 120_000) return null
      return error
    } catch { return null }
  }
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
  private async inspectTask(): Promise<void> {
    try {
      if (this.mode === 'v2') {
        const receipt = await this.sendKernelCommand('task.status', {})
        const execution = (receipt.result?.execution || {}) as { state?: string; lastTurn?: { terminal?: string } }
        const waiting = Boolean(this.kernelSnapshot?.interactions?.pending?.length)
        const state = execution.state || 'idle'
        const summary = waiting
          ? '任务正在等你处理审批或回答。'
          : state === 'idle'
            ? (execution.lastTurn?.terminal ? '当前没有任务在执行。上次任务已结束；请确认结果和副作用后再决定是否重试。' : '当前没有任务在执行。')
            : ['submitting', 'working'].includes(state)
              ? '任务仍在执行。停止播报不会停止任务；需要取消时请选择「停止任务」。'
              : '任务状态未知或正在取消；不会自动重试，请打开主窗口确认。'
        this.presentation?.notice(summary, 'status', 9000)
        return
      }
      const response = await this.request('/task-state')
      if (!response.ok) throw new Error('Unavailable')
      const state = await response.json() as { waiting?: boolean; status?: string; lastTurn?: { terminal?: string } }
      const summary = state.waiting ? '任务正在等你处理审批或回答。' : state.status === 'idle' ? (state.lastTurn ? '当前没有任务在执行。上次任务已结束；请确认结果和副作用后再决定是否重试。' : '当前没有任务在执行。') : '任务仍在执行。停止播报不会停止任务；需要取消时请选择「停止任务」。'
      this.presentation?.notice(summary, 'status', 9000)
    } catch { this.presentation?.notice('暂时无法确认任务状态。请打开主窗口检查；不会自动重复执行。', 'error', 9000, '', { secondary: [{ id: 'open', label: '打开主窗口' }] }) }
  }
  private request(path: string, body?: object, method?: string): Promise<Response> {
    const d = this.descriptor()
    return fetch(`http://127.0.0.1:${d.port}${path}`, {
      method: method || (body ? 'POST' : 'GET'),
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
      ['bubble-markdown.js', [join(root, 'pet/bubble-markdown.js'), 'text/javascript']],
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
      const skinMatch = path.match(new RegExp(`^/${nonce}/skins/([a-z0-9_-]+)/(.+)$`))
      const skinId = skinMatch?.[1], skinName = skinMatch?.[2]
      if (skinId && skinName && skinId !== 'whale-girl' && this.experience) {
        try { const file = this.experience.skinPath(skinId, decodeURIComponent(skinName)); res.setHeader('content-type', skinName.endsWith('.json') ? 'application/json' : 'image/webp'); res.end(readFileSync(file)); return }
        catch { res.writeHead(404); res.end(); return }
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
        "default-src 'self'; script-src 'self' 'unsafe-inline' blob:; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:",
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
    this.processType = () => (process.platform === 'darwin' && app.dock && app.dock.isVisible() === false ? 'uielement' : 'foreground')
    try {
      const policy = await import(pathToFileURL(join(root, 'pet/window-layer-policy.mjs')).href) as WindowPolicyModule
      const plan = typeof policy.windowLayerPlan === 'function'
        ? policy.windowLayerPlan({ role: 'pet', platform: process.platform, processType: this.processType() })
        : null
      if (plan) {
        if (plan.alwaysOnTop && plan.level) window.setAlwaysOnTop(true, plan.level as Parameters<typeof window.setAlwaysOnTop>[1])
        if (plan.spaces?.visibleOnAllWorkspaces !== false) {
          window.setVisibleOnAllWorkspaces(true, {
            visibleOnFullScreen: plan.spaces?.visibleOnFullScreen !== false,
            skipTransformProcessType: plan.spaces?.skipTransformProcessType !== false,
          })
        }
        if (typeof plan.focus?.focusable === 'boolean') window.setFocusable(plan.focus.focusable)
        if (typeof plan.clickThrough?.defaultIgnoreMouseEvents === 'boolean') {
          window.setIgnoreMouseEvents(plan.clickThrough.defaultIgnoreMouseEvents, {
            forward: plan.clickThrough.forwardMouseEvents !== false,
          })
        }
      } else {
        window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
        window.setIgnoreMouseEvents(true, { forward: true })
      }
    } catch (error) {
      this.log('window.policy_unavailable', error instanceof Error ? error.message : String(error))
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      window.setIgnoreMouseEvents(true, { forward: true })
    }
    const geometry = await import(pathToFileURL(join(root, 'pet/bubble-window.mjs')).href) as PetModules
    this.bubbleModule = geometry
    this.bubble = geometry.createBubbleWindowController({
      BrowserWindow,
      preloadPath: join(root, 'pet/bubble-preload.cjs'),
      pageUrl: `${origin}/${nonce}/bubble.html`,
      processType: this.processType,
    })
    const presenter = await import(pathToFileURL(join(root, 'pet/companion-presentation.mjs')).href) as {
      createCompanionPresentation(options: {
        show(payload: object): void
        hide(): void
        animate(payload: object): void
        send(path: string, body?: object): Promise<unknown>
        publishQuestion(view: object | null): void
      }): Presentation
    }
    this.presentation = presenter.createCompanionPresentation({
      show: (payload) => { if (this.experience?.state().onboarding) return; this.positionBubble(); this.bubble?.show(payload) },
      publishQuestion: view => window.webContents.send('pet:voice-command', { action:'question-view',view }),
      hide: () => { if (!this.experience?.state().onboarding) this.bubble?.hide() },
      animate: payload => this.window?.webContents.send('pet:presentation', payload),
      send: async (path: string, body?: object) => this.dispatchPresentationCall(path, body),
    })
    const experienceModule = await import(pathToFileURL(join(root, 'pet/experience-runtime.mjs')).href) as {
      createPetExperience(options: object): Experience
    }
    this.experience = experienceModule.createPetExperience({
      home: this.options.home, window, emit: (channel: string, value: object) => window.webContents.send(`pet:${channel}`, value),
      show: (payload: object) => { this.positionBubble(); this.bubble?.show(payload) }, hide: () => this.bubble?.hide(),
      shortcuts: globalShortcut, idle: () => powerMonitor.getSystemIdleTime(), systemLanguage: process.env.LANG,
      notice: (text: string) => this.presentation?.notice(text), openMain: () => this.options.toggleMain(true),
      openSettings: () => {
        if (this.options.settingsRequest) void this.options.settingsRequest('/bot/open-settings', {}).catch(() => this.presentation?.notice('打开设置失败，请双击桌宠后进入 DSH 设置。', 'error'))
        else this.options.toggleMain(true)
      }, nativeRequire: createRequire(join(this.options.appPath, 'package.json')),
      request: this.options.settingsRequest ?? (async () => { throw new Error('DSH 设置服务尚未就绪，请稍后继续引导。') }),
      dialogs: {
        pickSkin: async () => (await dialog.showOpenDialog(window, { properties: ['openFile', 'openDirectory'], filters: [{ name: 'Pet skin', extensions: ['zip', 'json'] }] })).filePaths[0],
        pickPreferences: async () => (await dialog.showOpenDialog(window, { properties: ['openFile'], filters: [{ name: 'Pet preferences', extensions: ['json'] }] })).filePaths[0],
      }, onPreferences: (state: ExperienceState) => {
        this.options.showDockIcon?.(state.showDockIcon !== false)
        void this.configureWake(state)
      },
    })
    const attentionModule=await import(pathToFileURL(join(root,'pet/desktop-attention.mjs')).href) as {
      createInteractionAttention(options:object):NonNullable<ProductPet['attention']>
    }
    this.attention=attentionModule.createInteractionAttention({
      enabled:()=>this.experience?.state().systemNotifications!==false,
      open:()=>this.options.toggleMain(true),
      show:({ title,body,click }:{ title:string;body:string;click:()=>void })=>{
        if(!Notification.isSupported())return null
        const notification=new Notification({ title,body,silent:false });notification.on('click',click);notification.show();return notification
      } })
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
      canPauseDesktopTurn(options: { behavior: BotRuntimeConfig['behavior']; turn: ReturnType<Presentation['state']> | undefined; inputActive: boolean | undefined }): boolean
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
      shouldPause: () => pauseModule.canPauseDesktopTurn({
        behavior: this.config.behavior, turn: this.presentation?.state(), inputActive: this.experience?.inputActive(),
      }),
      onPause: () => { void this.stopTask('idle-pause').catch(() => this.presentation?.notice('暂停失败，请打开 DSH 查看。', 'error')) },
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
    ipcMain.handle('pet:bubble-action', (e, value: unknown) => {
      assertBubble(e.sender)
      if (!value || typeof value !== 'object') throw new Error('Invalid action')
      // Capture cancel must take effect on the same tick as the click (old bubble behavior),
      // so it routes straight to the projection instead of the async experience dispatcher.
      if ('type' in value && value.type === 'cancel' && 'id' in value && value.id === 'cancel-capture') {
        return this.presentation?.action(value)
      }
      if ('type' in value && value.type === 'secondary' && 'id' in value && value.id === 'retry-voice') {
        this.window?.webContents.send('pet:voice-command', { action: 'retry' })
        this.presentation?.notice('正在重新连接语音…')
        return undefined
      }
      return this.experience?.action(value).then(handled => (handled ? undefined : this.presentation?.action(value)))
    })
    ipcMain.handle('pet:bubble-interactive', (e, value: unknown) => { assertBubble(e.sender); this.bubble?.setInteractive(value === true) })
    ipcMain.handle('pet:bubble-focus', (e, value: unknown) => { assertBubble(e.sender); this.bubble?.setInputMode(value === true) })
    ipcMain.handle('pet:bubble-resize', (e, value: unknown) => { assertBubble(e.sender); if (typeof value === 'number') this.bubble?.resize(value) })
    ipcMain.handle('pet:bubble-open', (e) => { assertBubble(e.sender); this.options.toggleMain(true) })
    ipcMain.handle('pet:queue-open', (e) => { assertOwner(e.sender); return this.presentation?.manageQueue() })
    ipcMain.handle('pet:hit', (e, value: unknown) => { assertOwner(e.sender); window.setIgnoreMouseEvents(value !== true, { forward: true }) })
    ipcMain.handle('pet:menu', (e) => {
      assertOwner(e.sender)
      const active = this.presentation?.state().working === true
      Menu.buildFromTemplate([
        ...(this.experience?.menu() ?? []),
        { label: '恢复上次任务…', click: () => { void this.presentation?.recoverTask() } },
        { label: '检查任务状态', click: () => { void this.inspectTask() } },
        { label: '管理持续授权…', click: () => { void this.presentation?.managePolicies() } },
        { label: '查看等待输入…', click: () => { void this.presentation?.manageQueue() } },
        ...(active ? [{ label: '停止任务', click: () => { void this.stopTask().catch(() => this.presentation?.notice('停止失败，请打开 DSH 查看。', 'error')) } }] : []),
        ...(this.options.quit ? [{ type: 'separator' as const }, { label: '退出 dsh-bot', click: () => this.options.quit?.() }] : []),
      ]).popup({ window })
    })
    ipcMain.handle('pet:experience', (e) => { assertOwner(e.sender); return this.experience?.state() })
    ipcMain.handle('pet:gesture', (e, phase: unknown) => { assertOwner(e.sender); if (phase === 'down' || phase === 'up') this.experience?.gesture(phase) })
    ipcMain.handle('pet:wake-audio', (e, audio: unknown, rate: unknown) => { assertOwner(e.sender); if (typeof audio === 'string' && audio.length <= 100000 && rate === 16000) this.wake?.accept(audio, rate) })
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
      if (this.mode === 'v2') {
        const pending = (this.kernelSnapshot?.interactions?.pending || []).find(item => item.id === id)
        if (!pending) throw new Error('Approval no longer pending')
        await this.sendKernelCommand('interaction.resolve', {
          interactionId: id,
          semanticRevision: pending.semanticRevision,
          decision: decision === 'allow' ? 'allowed-once' : 'rejected',
        })
        return
      }
      if (!(await this.request('/approval', { id, decision })).ok) throw new Error('Approval failed')
    })
    ipcMain.handle('pet:cancel', async (e) => {
      assertOwner(e.sender)
      await this.stopTask()
    })
    ipcMain.handle('pet:voice-status', async (e, message: unknown) => {
      assertOwner(e.sender)
      if (message && typeof message === 'object') {
        if ('kind' in message && message.kind === 'queue-state' && 'state' in message && message.state && typeof message.state === 'object') { this.presentation?.queue(message.state); return }
        if ('kind' in message && message.kind === 'question-answer' && 'data' in message && message.data && typeof message.data === 'object') { const accepted=await this.presentation?.voiceAnswer(message.data); window.webContents.send('pet:voice-command',{ action:'question-receipt',accepted:accepted===true }); return }
        const status = message as {
          text?: string
          phase?: string
          enabled?: boolean
          notify?: boolean
          kind?: string
          captureId?: string
          utteranceId?: string
          retryable?: boolean
          diagId?: string
          errorKind?: string
        }
        this.experience?.voice(status)
        if (['idle', 'listening', 'speaking', 'processing'].includes(status.phase || '')) this.presentation?.voice(status.phase || 'idle')
        const retry = status.retryable === false ? {} : { secondary: [{ id: 'retry-voice', label: '重试' }] }
        if (['capture-start', 'input', 'transcript', 'capture-end', 'input-confirmation', 'input-confirmation-ended'].includes(status.kind || '')) this.presentation?.capture(status)
        else if (status.kind === 'task-error' && status.text) this.presentation?.notice(status.text, 'error', 0, '', { secondary: [{ id: 'inspect-task', label: '检查任务状态' }, { id: 'recover-task', label: '恢复上次任务…' }] })
        else if (status.kind === 'error' && status.text) this.presentation?.notice(status.text, 'error', 15_000, '', retry)
        else if (status.phase === 'failed') {
          // Prefer the worker's classified failure over the opaque transport text.
          const detail = await this.lastWorkerVoiceError()
          if (detail?.summary) {
            const diag = detail.diagId ? `诊断 ${detail.diagId}。` : ''
            this.presentation?.notice(`${detail.summary}${diag ? `（${diag}）` : ''}\n点“重试”重新连接语音。`, 'error', 15_000, '', { secondary: [{ id: 'retry-voice', label: '重试' }] })
            this.log('voice-error', detail)
          } else if (status.text) this.presentation?.notice(status.text, 'error', 15_000, '', { secondary: [{ id: 'retry-voice', label: '重试' }] })
        } else if (status.notify && status.text) this.presentation?.notice(status.text, status.kind)
        this.log('voice-client', String(status.text || status.phase || '').slice(0, 400) + (status.diagId ? ` diag=${status.diagId}` : ''))
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
    let experienceStarted = false
    this.window.webContents.on('did-finish-load', () => { if (experienceStarted) return; experienceStarted = true; this.experience?.start(); if (this.experience) { this.options.showDockIcon?.(this.experience.state().showDockIcon!==false);void this.configureWake(this.experience.state()) } })
    await this.window.loadURL(`${origin}/${nonce}/index.html`)
    this.poll = setInterval(() => {
      if (!this.pollTask) this.pollTask = this.pollKernel().finally(() => { this.pollTask = null })
    }, 300)
    void this.configure(config).catch(error => this.publish({ phase: 'failed', error: String(error) }))
  }
  /** One poll tick: probe the v2 kernel once, then follow that mode until restart. */
  private async pollKernel(): Promise<void> {
    if (this.polling || this.stopped) return
    this.polling = true
    try {
      if (this.mode === 'unknown') await this.probeKernel()
      if (this.mode === 'v2') await this.pollKernelV2()
      else if (this.mode === 'legacy') await this.pollLegacy()
    } catch (error) {
      this.log('kernel.poll_failed', error instanceof Error ? error.message : String(error))
    } finally {
      this.polling = false
    }
  }
  /** Only a missing v2 surface (404 / unavailable endpoint) selects the migration bridge. */
  private async probeKernel(): Promise<void> {
    let response: Response
    try {
      response = await this.request('/v2/snapshot')
    } catch (error) {
      this.log('kernel.probe_unreachable', error instanceof Error ? error.message : String(error))
      return
    }
    if (response.status === 401 || response.status === 403) { this.log('kernel.probe_unauthorized', response.status); return }
    if (response.status === 404) { this.enterLegacyMode('v2 snapshot 404'); return }
    if (!response.ok) { this.enterLegacyMode(`v2 snapshot ${response.status}`); return }
    let body: KernelSnapshot
    try { body = await response.json() as KernelSnapshot } catch { this.enterLegacyMode('invalid v2 snapshot json'); return }
    if ((body as { schema?: string }).schema !== 'snapshot@1') {
      this.enterLegacyMode('Host does not expose snapshot@1')
      return
    }
    this.mode = 'v2'
    this.applyKernelSnapshot(body)
    this.log('kernel.v2_connected', { snapshotSeq: this.kernel.snapshotSeq })
  }
  private enterLegacyMode(reason: string): void {
    if (this.mode === 'legacy') return
    this.mode = 'legacy'
    this.log('kernel.legacy_fallback', reason)
    if (!this.kernel.legacyNoticeShown) {
      this.kernel.legacyNoticeShown = true
      this.presentation?.notice('Host v2 未就绪，使用兼容投影。', 'status', 9000)
    }
  }
  private applyKernelSnapshot(body: KernelSnapshot | null | undefined): void {
    if (!body || typeof body !== 'object') return
    this.kernelSnapshot = body
    const result = this.presentation?.applySnapshot(body)
    if (!result?.applied) return
    this.kernel.hostEpoch = body.hostEpoch || ''
    this.kernel.snapshotSeq = body.snapshotSeq || 0
    this.kernel.lastSeq = Math.max(this.kernel.lastSeq, this.kernel.snapshotSeq)
    const requests = body.interactions?.pending || []
    const compat = {
      pid: body.identity?.hostPid || 0,
      sessionId: body.identity?.sessionId || '',
      requests,
    }
    this.experience?.sync(compat)
    this.attention?.sync(compat)
  }
  private async refreshKernelSnapshot(): Promise<boolean> {
    this.kernel.needsSnapshot = false
    const response = await this.request('/v2/snapshot')
    if (!response.ok) return false
    let body: KernelSnapshot
    try { body = await response.json() as KernelSnapshot } catch { return false }
    if ((body as { schema?: string }).schema !== 'snapshot@1') return false
    this.applyKernelSnapshot(body)
    return true
  }
  private async pollKernelV2(): Promise<void> {
    if (this.kernel.needsSnapshot) {
      if (!(await this.refreshKernelSnapshot())) return
    }
    const response = await this.request(`/v2/events?after=${this.kernel.lastSeq}`)
    if (response.status === 409) {
      // Retention gap or stale epoch: take a new snapshot and continue from its seq.
      this.kernel.needsSnapshot = true
      return
    }
    if (!response.ok) { this.log('kernel.events_failed', response.status); return }
    const payload = await response.json() as { events?: KernelEvent[]; next?: number; resyncRequired?: boolean }
    if (payload.resyncRequired) { this.kernel.needsSnapshot = true; return }
    let resync = false
    for (const event of payload.events || []) {
      if (event.type === 'command') continue
      const result = this.presentation?.applyEvent(event)
      if (result?.resync) { resync = true; break }
      this.window?.webContents.send('pet:agent-event', this.legacyEventOf(event))
    }
    if (Number.isInteger(payload.next)) this.kernel.lastSeq = Math.max(this.kernel.lastSeq, Number(payload.next))
    if (resync) this.kernel.needsSnapshot = true
    this.positionBubble()
  }
  /** Compact legacy-shaped events for the pet window task cards. */
  private legacyEventOf(event: KernelEvent): {
    type?: string | undefined
    ioSeq?: number | undefined
    turnId?: string | null
    data?: object | undefined
  } {
    const data = event.data || {}
    const turnId = `${event.sessionId || ''}:${event.turn ?? ''}`
    if (event.type === 'turn.tool') {
      return {
        type: (typeof data.phase === 'string' ? data.phase : '') === 'result' ? 'tool.result' : 'tool.call',
        ioSeq: event.seq,
        turnId,
        data: {
          name: data.name,
          toolName: data.name,
          argumentsPreview: data.argumentsPreview,
          resultPreview: data.resultPreview,
          isError: data.isError,
        },
      }
    }
    if (event.type === 'turn.ended') {
      const reason = data.reason && typeof data.reason === 'object'
        ? data.reason
        : { kind: typeof data.terminal === 'string' ? data.terminal : 'unknown' }
      return { type: 'turn.ended', ioSeq: event.seq, turnId, data: { reason } }
    }
    return { type: event.type, ioSeq: event.seq, turnId, data }
  }
  /** Legacy migration bridge: poll the pre-v2 REST surface until the Host kernel is live. */
  private async pollLegacy(): Promise<void> {
    const d = this.descriptor()
    const identity = `${d.pid}:${d.port}`
    const changedOwner = identity !== this.identity
    if (changedOwner) {
      this.lastSeq = 0
      this.identity = identity
      this.window?.webContents.send('pet:agent-event', { type: 'runtime.owner' })
    }
    const response = await this.request(`/events?after=${this.lastSeq}`)
    if (!response.ok) return
    const payload = (await response.json()) as { events?: { ioSeq: number; type: string }[] }
    const pending = await this.request('/interactions')
    if (pending.ok) {
      const snapshot = await pending.json() as { pid: number; sessionId: string; requests: PendingInteraction[] }
      if (Array.isArray(snapshot.requests)) {
        this.legacyRequests = snapshot.requests
        this.experience?.sync(snapshot); this.presentation?.sync(snapshot); this.attention?.sync(snapshot)
      }
    }
    if (changedOwner) {
      const task = await this.request('/task-state')
      if (task.ok) this.presentation?.syncTaskState(await task.json() as object)
    }
    this.positionBubble()
    for (const event of payload.events || []) {
      if (event.ioSeq <= this.lastSeq) continue
      this.lastSeq = event.ioSeq
      if (!changedOwner) { this.presentation?.event(event); this.window?.webContents.send('pet:agent-event', event) }
    }
  }
  /** Presentation `send` bridge: UI-local actions, legacy adapters, and v2 commands. */
  private async dispatchPresentationCall(path: string, body?: object): Promise<unknown> {
    if (path === 'open') { this.options.toggleMain(true); return undefined }
    if (path === 'inspect-task') { await this.inspectTask(); return undefined }
    if (path === 'retry-voice') {
      this.window?.webContents.send('pet:voice-command', { action: 'retry' })
      this.presentation?.notice('正在重新连接语音…')
      return undefined
    }
    if (path === 'voice-input') { this.window?.webContents.send('pet:voice-command', body); return undefined }
    if (path === 'voice-queue') { this.window?.webContents.send('pet:voice-command', { action: 'queue-control', data: body }); return undefined }
    if (path.startsWith('/')) {
      // Legacy adapters sharing the same Host owner: /policies (durable grants) and /task/recovery.
      const method = path.startsWith('/policies') && body && 'method' in body ? String((body as { method?: string }).method) : undefined
      const response = await this.request(path, method === 'DELETE' ? undefined : body, method)
      if (!response.ok) throw Object.assign(new Error(`DSH request failed: ${response.status}`), { stale: response.status === 409 })
      return response.json()
    }
    if (this.mode !== 'v2') return this.dispatchLegacyCall(path, body || {})
    return this.sendKernelCommand(path, body || {})
  }
  private async sendKernelCommand(type: string, payload: object): Promise<KernelReceipt> {
    const commandId = randomUUID()
    const sessionId = this.kernelSnapshot?.identity?.sessionId ?? null
    this.log('kernel.command', { type })
    const response = await this.request('/v2/command', {
      protocolVersion: 'dsh-bot-v1',
      commandId,
      hostEpoch: this.kernel.hostEpoch,
      sourceConnectionId: 'desktop',
      sessionId,
      type,
      payload,
    })
    let receipt: KernelReceipt = {}
    try { receipt = await response.json() as KernelReceipt } catch { receipt = {} }
    if (!response.ok) {
      receipt = { status: 'rejected', error: receipt.error || { code: `HTTP_${response.status}`, message: `Host command failed: ${response.status}` } }
    }
    if (receipt.status === 'rejected' || receipt.status === 'unknown') {
      const code = receipt.error?.code || 'COMMAND_REJECTED'
      const stale = /MISMATCH|STALE|CONFLICT|EXPIRED|IN_FLIGHT|NOT_FOUND/.test(code)
      if (stale) this.kernel.needsSnapshot = true
      throw Object.assign(new Error(receipt.error?.message || code), { code, stale })
    }
    return receipt
  }
  private legacyOptionLabel(interactionId: string, questionId: string, optionId: string): string {
    const request = this.legacyRequests.find(item => item.id === interactionId)
    const question = (request?.questions || []).find(candidate => candidate.id === questionId)
    const option = (question?.options || []).find(candidate => candidate.id === optionId)
    if (typeof option?.label === 'string' && option.label) return option.label
    const parts = optionId.split(':')
    return parts[0] === 'legacy' && parts.length >= 5 ? parts.slice(4).join(':') : optionId
  }
  private async dispatchLegacyCall(type: string, payload: object): Promise<unknown> {
    const value = payload as Record<string, unknown>
    if (type === 'interaction.resolve') {
      if (typeof value.decision === 'string') {
        const decision = value.decision === 'rejected' ? 'reject' : 'allow'
        const response = await this.request('/approval', { id: value.interactionId, sessionId: this.kernelSnapshot?.identity?.sessionId ?? undefined, decision })
        if (!response.ok) throw Object.assign(new Error(`DSH request failed: ${response.status}`), { stale: response.status === 409 })
        return response.json()
      }
      const answer = value.answer as { answers?: { id?: string; selected?: string[]; custom?: string }[] } | undefined
      const translated = (answer?.answers || []).map(entry => ({
        id: entry.id,
        selected: (entry.selected || []).map(optionId => this.legacyOptionLabel(
          typeof value.interactionId === 'string' ? value.interactionId : '',
          entry.id || '',
          optionId,
        )),
        ...(entry.custom ? { custom: entry.custom } : {}),
      }))
      const response = await this.request('/questions/answer', { id: value.interactionId, sessionId: this.kernelSnapshot?.identity?.sessionId ?? undefined, answer: { answers: translated } })
      if (!response.ok) throw Object.assign(new Error(`DSH request failed: ${response.status}`), { stale: response.status === 409 })
      return response.json()
    }
    if (type === 'interaction.draft.select' || type === 'interaction.draft.custom') return { status: 'accepted', result: {} }
    if (type === 'queue.list' || type === 'queue.edit' || type === 'queue.delete' || type === 'queue.confirm') {
      const action = type === 'queue.list' ? 'snapshot' : type.split('.')[1]
      this.window?.webContents.send('pet:voice-command', { action: 'queue-control', data: { action, ...value } })
      return { status: 'accepted', result: {} }
    }
    if (type === 'input.confirm') {
      this.window?.webContents.send('pet:voice-command', { action: 'confirm-input', id: value.id, ...(typeof value.text === 'string' ? { text: value.text } : {}) })
      return { status: 'accepted', result: {} }
    }
    if (type === 'input.edit' || type === 'input.reject') {
      this.window?.webContents.send('pet:voice-command', { action: 'discard-input', id: value.id })
      return { status: 'accepted', result: {} }
    }
    if (type === 'control.cancel-capture') {
      this.window?.webContents.send('pet:voice-command', { action: 'discard', captureId: value.captureId })
      return { status: 'accepted', result: {} }
    }
    if (type === 'control.cancel-task') { await this.legacyCancelTask(); return { status: 'accepted', result: {} } }
    if (type === 'control.stop-playback') {
      this.window?.webContents.send('pet:voice-command', { action: 'stop-playback' })
      return { status: 'accepted', result: {} }
    }
    if (type === 'control.playback-style') {
      this.window?.webContents.send('pet:voice-command', { action: 'playback-style', style: value.style })
      return { status: 'accepted', result: {} }
    }
    if (type === 'session.open-main') { this.options.toggleMain(true); return { status: 'accepted', result: {} } }
    throw Object.assign(new Error(`unsupported legacy command: ${type}`), { code: 'UNKNOWN_COMMAND' })
  }
  /**
   * Capture the turn identity this client last observed.
   *
   * A stop must name the turn the user actually saw. Reading the Host again at
   * request time would describe whatever started since then, which is how a late
   * pause or a retried click stops a task the user never asked about.
   * @returns the target to send, or null when nothing is running.
   */
  private captureCancelTarget(): { hostEpoch: string; sessionId: string; turn?: number; turnId?: string; clientTurnId?: string } | null {
    const execution = this.kernelSnapshot?.execution
    const hostEpoch = this.kernel.hostEpoch || String(this.kernelSnapshot?.hostEpoch || '')
    const sessionId = String(execution?.sessionId || this.kernelSnapshot?.identity?.sessionId || '')
    if (!execution || hostEpoch === '' || sessionId === '') return null
    if (!['submitting', 'working', 'cancel-requested'].includes(String(execution.state || ''))) return null
    const target: { hostEpoch: string; sessionId: string; turn?: number; turnId?: string; clientTurnId?: string } = { hostEpoch, sessionId }
    if (execution.turn !== null && execution.turn !== undefined) target.turn = Number(execution.turn)
    if (typeof execution.turnId === 'string' && execution.turnId !== '') target.turnId = execution.turnId
    if (typeof execution.clientTurnId === 'string' && execution.clientTurnId !== '') target.clientTurnId = execution.clientTurnId
    if (target.turn === undefined && target.turnId === undefined && target.clientTurnId === undefined) return null
    return target
  }
  /** Report a Host cancel receipt without ever turning an unconfirmed stop into a success. */
  private reportCancelReceipt(receipt: KernelReceipt): void {
    const notice = cancelReceiptNotice(receipt)
    if (notice !== null) this.presentation?.notice(notice.text, notice.kind, 9000)
  }
  /** Report a refused or unknown cancel without falling back to an unscoped stop. */
  private reportCancelFailure(error: unknown): void {
    const code = String((error as { code?: string } | null)?.code || '')
    this.log('kernel.cancel_task_failed', code || (error instanceof Error ? error.message : String(error)))
    if (/STALE|CANCEL_TARGET|NO_ACTIVE_TURN/.test(code)) this.kernel.needsSnapshot = true
    const notice = cancelFailureNotice(code)
    if (notice !== null) this.presentation?.notice(notice.text, notice.kind, 12000)
  }
  /**
   * Stop the task as it was observed, never "whatever the Host currently runs".
   *
   * In v2 the request carries the captured target and stays in the v2 path even
   * when it fails: falling back to the legacy endpoint would drop the target and
   * cancel the successor turn instead. The legacy endpoint gets the same identity
   * read back from `/task-state` in the same request.
   * @param source - legacy cancellation source (`task-stop` or `idle-pause`).
   */
  private async stopTask(source = 'task-stop'): Promise<void> {
    if (this.mode === 'v2') {
      const target = this.captureCancelTarget()
      if (target === null) {
        this.presentation?.notice('当前没有正在执行的任务，未发生停止。', 'status', 8000)
        return
      }
      try {
        this.reportCancelReceipt(await this.sendKernelCommand('control.cancel-task', { target }))
      } catch (error) {
        this.reportCancelFailure(error)
      }
      return
    }
    await this.legacyCancelTask(source)
  }
  /**
   * Legacy cancellation for a Host without the v2 command channel.
   *
   * The identity is read from `/task-state` immediately before the request so the
   * stop names one turn; the reply's `confirmed` flag decides what the user is
   * told, because an HTTP 200 only means the request was accepted.
   * @param source - cancellation source recorded by the Host (`task-stop`, `idle-pause`).
   */
  private async legacyCancelTask(source = 'task-stop'): Promise<void> {
    const stateResponse = await this.request('/task-state')
    if (!stateResponse.ok) throw new Error('Task state unavailable')
    const state = await stateResponse.json() as {
      sessionId?: string
      clientTurnId?: string | null
      turn?: number | null
      hostEpoch?: string
    }
    const hostEpoch = String(state.hostEpoch || '')
    const sessionId = String(state.sessionId || '')
    const target: { hostEpoch: string; sessionId: string; turn?: number; clientTurnId?: string } = { hostEpoch, sessionId }
    if (state.turn !== null && state.turn !== undefined) target.turn = Number(state.turn)
    if (typeof state.clientTurnId === 'string' && state.clientTurnId !== '') target.clientTurnId = state.clientTurnId
    if (hostEpoch === '' || sessionId === '' || (target.turn === undefined && target.clientTurnId === undefined)) {
      this.presentation?.notice('当前没有正在执行的任务，未发生停止。', 'status', 8000)
      return
    }
    const response = await this.request('/cancel', { source, ...target })
    let body: { cancelled?: boolean; confirmed?: boolean } = {}
    try { body = await response.json() as typeof body } catch { body = {} }
    if (!response.ok) {
      this.presentation?.notice('停止请求被拒绝；当前任务未确认停止，请打开主窗口检查。', 'error', 12000)
      return
    }
    if (body.confirmed === true && body.cancelled !== false) { this.presentation?.notice('DSH 已确认任务停止。', 'status', 6000); return }
    if (body.cancelled === true) { this.presentation?.notice('已请求停止任务，正在等待 DSH 确认；确认到达前不会显示为已停止。', 'status', 9000); return }
    this.presentation?.notice('没有正在执行的任务，未发生停止。', 'status', 8000)
  }
  private positionBubble(): void {
    if (!this.window || !this.bubbleModule) return
    const orbBounds = this.window.getBounds()
    const bubblePolicy = this.kernelSnapshot?.presentation?.bubblePolicy
    this.bubble?.reposition(this.bubbleModule.orbBubbleWindowBounds({
      orbBounds,
      workArea: screen.getDisplayMatching(orbBounds).workArea,
      avoidBounds: this.options.mainBounds?.() || [],
      displays: screen.getAllDisplays(),
      ...(bubblePolicy?.placement ? { placement: bubblePolicy.placement } : {}),
      ...(Number.isFinite(bubblePolicy?.anchorGapPx) ? { anchorGapPx: Number(bubblePolicy?.anchorGapPx) } : {}),
    }))
  }
  updateBehavior(config: BotRuntimeConfig): void { this.config = config }
  private async configureWake(state: ExperienceState): Promise<void> {
    if (this.stopped) return
    try {
      if (!state.wakeWordEnabled) { await this.wake?.stop(); this.window?.webContents.send('pet:wake-state', { ready: false, enabled: false }); return }
      const module = await import(pathToFileURL(join(this.options.resources, 'pet/wake-word/runtime.mjs')).href) as {
        DesktopWakeWordRuntime: new (options: object) => WakeRuntime
      }
      const phrase = await import(pathToFileURL(join(this.options.resources, 'pet/wake-word/keyword-phrase.mjs')).href) as {
        wakeWordKeywordsLine(text: string): string
      }
      if (!this.wake) this.wake = new module.DesktopWakeWordRuntime({
        modelRoot: join(this.options.home, 'pet/cache/models/wake-word'), bundledRoot: join(this.options.resources, 'pet/wake-model'),
        engineEntry: createRequire(join(this.options.appPath, 'package.json')).resolve('sherpa-onnx-node'),
        onDetected: () => this.experience?.wake(),
        onReady: () => this.window?.webContents.send('pet:wake-state', { ready: true, enabled: true }),
        onError: (error: Error) => { this.presentation?.notice(`离线唤醒失败：${error.message}`, 'error'); this.window?.webContents.send('pet:wake-state', { ready: false, enabled: true, error: error.message }) },
      })
      this.wake.setKeywords(phrase.wakeWordKeywordsLine(state.wakeWordPhrase || '你好小鲸')); this.wake.setEnabled(true)
    } catch (error) { const detail = error instanceof Error ? error.message : String(error); this.log('wake-word.failed', detail); this.presentation?.notice(`离线唤醒失败：${detail}`, 'error'); this.window?.webContents.send('pet:wake-state', { ready: false, enabled: state.wakeWordEnabled, error: detail }) }
  }
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
      const route = resolvePetVoiceRoute(config.voice)
      if (!route.ok) { this.worker = null; this.publish({ phase: 'failed', error: route.error }); return }
      const key = config.voice?.apiKey || ''
      if (!config.llm?.apiKey) {
        this.worker = null
        this.publish({ phase: 'unconfigured', error: '请先在 DSH → Bot 设置中保存主模型 API Key，再开启语音。' })
        return
      }
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
          DSH_WAKE_PHRASE: '',
          DSH_CAPTURE_CONTROL: '1',
          DASHSCOPE_REALTIME_URL: config.voice?.baseUrl || 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          DASHSCOPE_ASR_MODEL: route.model,
          DASHSCOPE_TTS_MODEL: 'qwen3-tts-flash-realtime',
          DASHSCOPE_TTS_VOICE: route.voice,
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
          ? { phase: 'available', offerUrl: this.offerUrl, ...(route.notice ? { notice: route.notice } : {}) }
          : { phase: 'failed', error: state.lastError || state.state },
      )
    }
    const pending = this.queue.then(apply)
    this.queue = pending.catch(() => {})
    return pending
  }
  async stop(): Promise<void> {
    this.stopped = true
    await this.experience?.stop()
    await this.wake?.stop()
    this.requests.abort()
    if (this.poll) clearInterval(this.poll)
    this.pause?.stop()
    this.attention?.stop();this.attention=null
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
