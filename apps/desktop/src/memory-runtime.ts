/** Owns Hindsight and its authenticated adapter as one restartable product service. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export type MemoryRuntimePhase = 'disabled' | 'starting' | 'ready' | 'failed'
export interface MemoryRuntimeStatus {
  enabled: boolean
  phase: MemoryRuntimePhase
  server: string | null
  sidecar: string | null
  bank: string | null
  dataRoot: string
  error: string
}
export interface MemorySidecarResult { ok?: boolean; error?: { code?: string; message?: string } | string; [key: string]: unknown }
export interface MemoryRuntimeResponse { status: number; json: MemorySidecarResult | null }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => port > 0 ? resolve(port) : reject(new Error('no loopback port')))
    })
  })
}
/** Terminate the owned process group, including children whose parent already exited. */
export async function stopProductProcess(child: ChildProcess | null): Promise<void> {
  if (child?.pid === undefined) return
  const pid = child.pid
  const signal = (name: NodeJS.Signals): void => {
    try { if (process.platform === 'win32') child.kill(name); else process.kill(-pid, name) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  const exit = exited() ? Promise.resolve() : new Promise<void>(resolve => child.once('exit', () => resolve()))
  signal('SIGTERM')
  await Promise.race([exit, sleep(3000)])
  signal('SIGKILL')
  if (!exited()) await exit
}

export class MemoryRuntime {
  private server: ChildProcess | null = null
  private sidecar: ChildProcess | null = null
  private descriptor: { port: number; token: string; bank: string } | null = null
  private lastError = ''
  private serverUrl: string | null = null
  private phase: MemoryRuntimePhase = 'disabled'
  private enabled = false
  private boot: Promise<MemoryRuntimeStatus> | null = null
  private stopping: Promise<MemoryRuntimeStatus> | null = null
  private abort = new AbortController()
  private monitor: ReturnType<typeof setInterval> | null = null
  constructor(
    private readonly dshHome: string,
    private readonly resourcesPath: string,
    private readonly appPath: string,
    private readonly development: boolean,
    private readonly timeouts = { server: 240_000, sidecar: 30_000 },
  ) {}
  get dataRoot(): string { return join(this.dshHome, 'memory') }
  private get payload(): string {
    return this.development ? process.env.NISSE_MEMORY_DIR || join(this.appPath, '..', '..', 'product', 'memory') : join(this.resourcesPath, 'memory')
  }
  get url(): string | null { return this.descriptor === null ? null : `http://127.0.0.1:${this.descriptor.port}` }
  get token(): string | null { return this.descriptor?.token ?? null }
  status(): MemoryRuntimeStatus {
    return { enabled: this.enabled, phase: this.phase, server: this.serverUrl, sidecar: this.url,
      bank: this.descriptor?.bank ?? null, dataRoot: this.dataRoot, error: this.lastError }
  }
  private assertStarting(): void {
    this.abort.signal.throwIfAborted()
    if (this.lastError) throw new Error(this.lastError)
  }
  private launch(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, label: string): ChildProcess {
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (chunk: Buffer): void => { output = (output + chunk.toString()).slice(-4000) }
    child.stdout?.on('data', collect); child.stderr?.on('data', collect)
    child.once('error', (error) => { this.lastError = `${label}: ${error.message}` })
    child.once('exit', (code, signal) => {
      if (!this.abort.signal.aborted && (this.phase === 'starting' || this.phase === 'ready')) {
        this.lastError = `${label} exited ${String(code ?? signal)}: ${output}`
        this.phase = 'failed'; this.descriptor = null
        rmSync(join(this.dataRoot, 'runtime.json'), { force: true })
      }
    })
    return child
  }
  private async healthyServer(): Promise<boolean> {
    if (this.serverUrl === null) return false
    try { return (await fetch(`${this.serverUrl}/health`, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2500)]) })).ok }
    catch { return false }
  }
  private async ensureServer(): Promise<void> {
    const external = this.development ? process.env.NISSE_HINDSIGHT_URL : undefined
    if (external && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(external)) throw new Error('development Hindsight URL must be loopback')
    this.serverUrl = external || `http://127.0.0.1:${await freePort()}`
    this.assertStarting()
    if (!external) {
      const script = join(this.payload, 'scripts', 'run-server.sh')
      if (!existsSync(script)) throw new Error(`Hindsight runtime missing: ${script}`)
      this.server = this.launch('/bin/bash', [script], join(this.payload, 'runtime', 'hindsight'), {
        ...process.env, NISSE_M1C_ROOT: join(this.dataRoot, 'runtime'), NISSE_M1C_PORT: new URL(this.serverUrl).port,
      }, 'Hindsight')
    }
    const deadline = Date.now() + this.timeouts.server
    while (Date.now() < deadline) {
      this.assertStarting()
      if (await this.healthyServer()) { this.assertStarting(); return }
      await sleep(100)
    }
    throw new Error('Hindsight health deadline exceeded')
  }
  private async healthySidecar(): Promise<boolean> {
    if (this.descriptor === null) return false
    try {
      const response = await fetch(`${this.url}/health`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(2500)]) })
      const json = await response.json() as { ok?: boolean; bankId?: string }
      return response.ok && json.ok === true && json.bankId === this.descriptor.bank
    } catch { return false }
  }
  private async ensureSidecar(): Promise<void> {
    const entry = join(this.payload, 'sidecar.mjs')
    if (!existsSync(entry) || this.serverUrl === null) throw new Error(`memory sidecar missing: ${entry}`)
    const token = randomUUID(), bank = 'whalegirl:bot'
    this.sidecar = this.launch(process.execPath, [entry], this.dataRoot, {
      ...process.env, ELECTRON_RUN_AS_NODE: '1', NISSE_M4_MEMORY_ROOT: this.dataRoot,
      NISSE_M4_MEMORY_TOKEN: token, NISSE_M4_BANK: bank, HINDSIGHT_URL: this.serverUrl,
    }, 'memory adapter')
    const deadline = Date.now() + this.timeouts.sidecar
    while (Date.now() < deadline) {
      this.assertStarting()
      try {
        const value = JSON.parse(readFileSync(join(this.dataRoot, 'sidecar.json'), 'utf8')) as { pid: number; port: number; token: string; bank: string }
        if (value.pid === this.sidecar.pid && value.token === token && value.bank === bank
          && Number.isInteger(value.port) && value.port > 0 && value.port < 65536) {
          this.descriptor = value
          if (await this.healthySidecar()) { this.assertStarting(); return }
          this.descriptor = null
        }
      } catch { /* descriptor is not yet published */ }
      await sleep(100)
    }
    throw new Error('memory adapter health deadline exceeded')
  }
  private async cleanup(): Promise<void> {
    if (this.monitor !== null) clearInterval(this.monitor)
    this.monitor = null
    await Promise.all([stopProductProcess(this.sidecar), stopProductProcess(this.server)])
    this.sidecar = null; this.server = null; this.descriptor = null; this.serverUrl = null
    for (const name of ['sidecar.json', 'runtime.json']) rmSync(join(this.dataRoot, name), { force: true })
  }
  start(config: { memory?: { enabled?: boolean } } = {}): Promise<MemoryRuntimeStatus> {
    if (config.memory?.enabled === false) return this.stop()
    if (this.stopping !== null) return this.stopping.then(() => this.start(config))
    if (this.boot !== null) return this.boot
    if (this.phase === 'ready') return Promise.resolve(this.status())
    this.enabled = true; this.lastError = ''; this.phase = 'starting'; this.abort = new AbortController()
    mkdirSync(this.dataRoot, { recursive: true, mode: 0o700 })
    this.boot = (async () => {
      try {
        await this.cleanup(); this.assertStarting(); await this.ensureServer(); await this.ensureSidecar(); this.assertStarting()
        this.phase = 'ready'; this.publishDescriptor()
        this.monitor = setInterval(() => { void this.healthySidecar().then((healthy) => {
          if (!healthy && this.phase === 'ready') { this.lastError = 'memory adapter health lost'; this.phase = 'failed'; this.descriptor = null; rmSync(join(this.dataRoot, 'runtime.json'), { force: true }) }
        }) }, 5000); this.monitor.unref()
      } catch (error) {
        this.lastError = this.abort.signal.aborted ? '' : String(error)
        this.phase = this.abort.signal.aborted ? 'disabled' : 'failed'
        await this.cleanup()
      } finally { this.boot = null }
      return this.status()
    })()
    return this.boot
  }
  stop(): Promise<MemoryRuntimeStatus> {
    this.abort.abort(); this.enabled = false
    if (this.stopping !== null) return this.stopping
    this.stopping = (async () => {
      await this.boot; await this.cleanup(); this.phase = 'disabled'; return this.status()
    })().finally(() => { this.stopping = null })
    return this.stopping
  }
  async restart(config: { memory?: { enabled?: boolean } } = {}): Promise<MemoryRuntimeStatus> {
    await this.stop(); return this.start(config)
  }
  async request(path: string, body: unknown = {}): Promise<MemoryRuntimeResponse> {
    if (this.phase !== 'ready' || this.descriptor === null) {
      return { status: 0, json: { ok: false, error: 'memory runtime unavailable' } }
    }
    try {
      const response = await fetch(`${this.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
      return { status: response.status, json: await response.json().catch(() => null) as MemorySidecarResult | null }
    } catch (error) { return { status: 0, json: { ok: false, error: String(error) } } }
  }
  publishDescriptor(): void {
    if (this.phase !== 'ready' || this.descriptor === null) return
    writeFileSync(join(this.dataRoot, 'runtime.json'), JSON.stringify({ ...this.descriptor, url: this.url, dataRoot: this.dataRoot }, null, 2) + '\n', { mode: 0o600 })
  }
}
