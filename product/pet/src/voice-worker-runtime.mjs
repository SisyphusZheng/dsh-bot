// Pipecat Voice Worker runtime for the Nisse/pet shell.
//
// Feature-flag only: when NISSE_PIPECAT_WORKER=1 (or WG_VOICE_RUNTIME=pipecat)
// the shell owns the Python worker lifecycle. When off, the legacy Qwen gateway
// remains the product default and this module never spawns anything.
//
// Worker health and DSH bridge health are reported separately: a healthy
// /health endpoint does not prove the DSH bridge descriptor/session is alive.

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { VoiceWorkerSupervisor } from './voice-worker-supervisor.mjs'

function asJsonArray(value) {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map(String) : null
  } catch {
    return null
  }
}

export function resolveVoiceWorkerConfig({ env = process.env, projectRoot } = {}) {
  const enabled = env.NISSE_PIPECAT_WORKER === '1' || env.WG_VOICE_RUNTIME === 'pipecat'
  const spikeRoot = resolve(projectRoot, 'm5/voice-spike')
  const workerDir = env.NISSE_PIPECAT_WORKER_DIR || resolve(spikeRoot, 'worker')
  const command = env.NISSE_PIPECAT_WORKER_COMMAND || resolve(spikeRoot, '.venv/bin/python')
  const port = Number(env.NISSE_PIPECAT_PORT || 8765)
  const mode = env.NISSE_PIPECAT_MODE || 'dsh'
  const descriptor = env.NISSE_PIPECAT_BRIDGE_DESCRIPTOR || env.DSH_BRIDGE_DESCRIPTOR || ''
  const token = env.NISSE_PIPECAT_TOKEN || env.SPIKE_TOKEN || 'dev-token'
  const apiKey = env.NISSE_PIPECAT_DASHSCOPE_API_KEY || env.DASHSCOPE_API_KEY || ''
  const args = asJsonArray(env.NISSE_PIPECAT_WORKER_ARGS_JSON)
    || ['-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', String(port)]
  return {
    enabled, command, args, cwd: workerDir, port, mode, descriptor, token, apiKey,
    healthUrl: env.NISSE_PIPECAT_HEALTH_URL || `http://127.0.0.1:${port}/health`,
    spikeRoot,
  }
}

export function createVoiceWorkerRuntime({ env = process.env, projectRoot, logger = () => {} } = {}) {
  const config = resolveVoiceWorkerConfig({ env, projectRoot })
  let supervisor = null
  let state = config.enabled ? 'idle' : 'disabled'
  let lastError = null
  let stopRequested = false
  let startedAt = null

  const log = (message, detail) => {
    try {
      logger.info?.(message, detail)
    } catch {}
  }

  function validate() {
    const problems = []
    if (!existsSync(config.command)) problems.push(`worker command not found: ${config.command}`)
    if (!existsSync(config.cwd)) problems.push(`worker cwd not found: ${config.cwd}`)
    if (config.mode === 'dsh' && !config.descriptor) problems.push('DSH bridge descriptor is required in dsh mode')
    if (config.mode === 'dsh' && config.descriptor && !existsSync(config.descriptor)) {
      problems.push(`DSH bridge descriptor not found: ${config.descriptor}`)
    }
    if (!Number.isInteger(config.port) || config.port <= 0) problems.push(`invalid worker port: ${config.port}`)
    if (!config.apiKey) problems.push('DASHSCOPE_API_KEY is required for ASR/TTS')
    return problems
  }

  async function checkBridge() {
    // Bridge health is deliberately separate from worker health: a live worker
    // with a stale/dead descriptor must not look like a working voice chain.
    if (!config.descriptor) return { ok: false, error: 'no descriptor configured' }
    try {
      const descriptor = JSON.parse(readFileSync(config.descriptor, 'utf8'))
      const port = Number(descriptor.port)
      const token = String(descriptor.token || '')
      const pid = Number(descriptor.pid)
      let pidAlive = false
      try {
        process.kill(pid, 0)
        pidAlive = true
      } catch {}
      let health = null
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(2500),
        })
        health = await response.json().catch(() => null)
      } catch (error) {
        return { ok: false, pid, port, pidAlive, error: String(error?.message || error) }
      }
      return { ok: pidAlive && health?.ok === true, pid, port, pidAlive, health }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  function snapshot() {
    return {
      enabled: config.enabled,
      state,
      pid: supervisor?.pid || null,
      healthUrl: config.healthUrl,
      port: config.port,
      mode: config.mode,
      restarts: supervisor?.restarts || 0,
      lastExit: supervisor?.lastExit || null,
      lastError,
      startedAt,
    }
  }

  async function waitForBridge(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      last = await checkBridge()
      if (last.ok) return last
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return last || { ok: false, error: 'bridge health timeout' }
  }

  async function start() {
    if (!config.enabled) return snapshot()
    if (stopRequested) return snapshot()
    if (state === 'starting' || state === 'running') return snapshot()
    const problems = validate()
    if (problems.length) {
      state = 'failed'
      lastError = problems.join('; ')
      log('voice_worker.config_invalid', { error: lastError })
      return snapshot()
    }
    state = 'starting'
    lastError = null
    const childEnv = { ...env }
    delete childEnv.ELECTRON_RUN_AS_NODE
    delete childEnv.NODE_OPTIONS
    Object.assign(childEnv, {
      SPIKE_TOKEN: config.token,
      G1_MODE: config.mode,
      DASHSCOPE_API_KEY: config.apiKey,
      DSH_BRIDGE_DESCRIPTOR: config.descriptor,
    })
    supervisor = new VoiceWorkerSupervisor({
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: childEnv,
      healthUrl: config.healthUrl,
      restart: true,
      maxRestarts: 3,
      log: (message, detail) => log(`voice_worker.${message}`, detail),
    })
    try {
      await supervisor.start()
      startedAt = new Date().toISOString()
      state = 'running'
      log('voice_worker.started', snapshot())
    } catch (error) {
      state = 'failed'
      lastError = String(error?.message || error)
      log('voice_worker.start_failed', { error: lastError })
      try { await supervisor.stop() } catch {}
    }
    return snapshot()
  }

  async function stop() {
    stopRequested = true
    if (!supervisor) {
      if (config.enabled && state !== 'disabled') state = 'stopped'
      return snapshot()
    }
    state = 'stopping'
    try {
      await supervisor.stop()
      state = 'stopped'
    } catch (error) {
      state = 'failed'
      lastError = String(error?.message || error)
      log('voice_worker.stop_failed', { error: lastError })
    }
    return snapshot()
  }

  return { config, start, stop, snapshot, checkBridge, waitForBridge }
}
