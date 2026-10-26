// Voice Worker supervisor — shell-owned lifecycle for the Pipecat Python worker.
//
// Product rule (TASKBOOK §3.2/§10.1): Electron owns start/monitor/stop of the
// voice worker. This module is deliberately UI-free and testable with a fake
// worker; it does not choose providers or connect audio.
//
// States: stopped -> starting -> running -> stopping -> stopped
// Unexpected exit while running: restart with bounded backoff (bounded restarts)
// and surface the last exit so the UI can show a real error instead of pretending.

import { spawn } from 'node:child_process'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class VoiceWorkerSupervisor {
  constructor({
    command,
    args = [],
    cwd,
    env = process.env,
    healthUrl = 'http://127.0.0.1:8765/health',
    startupTimeoutMs = 90_000,
    stopTimeoutMs = 5_000,
    healthIntervalMs = 200,
    verifyPid = false,
    restart = true,
    maxRestarts = 3,
    restartDelayMs = 500,
    log = () => {},
  } = {}) {
    if (!command) throw new Error('voice worker command is required')
    Object.assign(this, {
      command,
      args,
      cwd,
      env,
      healthUrl,
      startupTimeoutMs,
      stopTimeoutMs,
      healthIntervalMs,
      verifyPid,
      restart,
      maxRestarts,
      restartDelayMs,
      log,
    })
    this.child = null
    this.state = 'stopped'
    this.pid = null
    this.restarts = 0
    this.lastExit = null
    this._stopping = false
  }

  async _healthy() {
    try {
      const response = await fetch(this.healthUrl, { signal: AbortSignal.timeout(1200) })
      if (!response.ok) return false
      const body = await response.json().catch(() => null)
      return (body?.ok === true || body?.status === 'ok') && (!this.verifyPid || body.pid === this.pid)
    } catch {
      return false
    }
  }

  async waitForHealthy(timeoutMs = this.startupTimeoutMs) {
    const deadline = Date.now() + timeoutMs
    while (!this._stopping && Date.now() < deadline) {
      if (await this._healthy()) return true
      if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return false
      await sleep(this.healthIntervalMs)
    }
    return false
  }

  _attachLifecycle(child) {
    child.once('exit', (code, signal) => {
      const expected = this._stopping
      this.child = null
      this.pid = null
      this.lastExit = { code, signal, at: new Date().toISOString(), expected }
      if (expected) {
        this.state = 'stopped'
        return
      }
      this.log('voice worker exited unexpectedly', this.lastExit)
      if (this.restart && this.restarts < this.maxRestarts) {
        this.restarts += 1
        this.state = 'stopped'
        this._restartTimer = setTimeout(() => {
          this.start().catch((error) => {
            this.state = 'stopped'
            this.log('voice worker restart failed', String(error?.message || error))
          })
        }, this.restartDelayMs)
      } else {
        this.state = 'stopped'
      }
    })
  }

  async start() {
    if (this.state === 'starting' || this.state === 'running') return { pid: this.pid, state: this.state }
    this._stopping = false
    this.state = 'starting'
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child.once('error', (error) => this.log('voice worker spawn failed', error.message))
    this.pid = this.child.pid
    const safeOutput = (data) => {
      const text = String(data)
      const key = this.env.DASHSCOPE_API_KEY
      return (key ? text.replaceAll(key, '[credential]') : text).trim().slice(0, 300)
    }
    this.child.stdout?.on('data', (data) => this.log('voice worker stdout', safeOutput(data)))
    this.child.stderr?.on('data', (data) => this.log('voice worker stderr', safeOutput(data)))
    this._attachLifecycle(this.child)
    const healthy = await this.waitForHealthy()
    if (!healthy) {
      await this.stop()
      throw new Error('voice worker did not become healthy')
    }
    this.state = 'running'
    return { pid: this.pid, state: this.state }
  }

  async stop() {
    this._stopping = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    if (!this.child) {
      this.state = 'stopped'
      return { stopped: true, wasRunning: false }
    }
    const child = this.child
    this.state = 'stopping'
    child.kill('SIGTERM')
    const deadline = Date.now() + this.stopTimeoutMs
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await sleep(50)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      const hardDeadline = Date.now() + 1000
      while (child.exitCode === null && child.signalCode === null && Date.now() < hardDeadline) await sleep(50)
    }
    this.child = null
    this.pid = null
    this.state = 'stopped'
    return { stopped: true, wasRunning: true }
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      restarts: this.restarts,
      lastExit: this.lastExit,
      healthy: null,
    }
  }
}
