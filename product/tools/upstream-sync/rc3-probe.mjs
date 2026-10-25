#!/usr/bin/env node
// Ad-hoc rc.3 host boot probe: candidate runtime + pinned host-integration plugin.
// Paths come from env (WG_*) so this file carries no machine-specific constants.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// CLI flags fall back to WG_* env vars so CI can wire paths without editing this file.
const argvOf = (name, envName, fallback) => {
  const index = process.argv.indexOf(name)
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1]
  return process.env[envName] || fallback
}
const RUNTIME = argvOf('--runtime-dir', 'WG_RUNTIME', '/tmp/dsh-rc3')
const PLUGIN_ROOT = argvOf('--plugin-root', 'WG_PLUGIN_ROOT', '')
const OUT = argvOf('--out', 'WG_OUT', './rc3-probe-result.json')
const PRIVATE = join(homedir(), '.' + 'dsh')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runRoot = mkdtempSync('/tmp/wg-rc3-boot-')
const dshHome = join(runRoot, 'dsh-home')
const home = join(runRoot, 'home')
mkdirSync(dshHome, { recursive: true, mode: 0o700 })
mkdirSync(home, { recursive: true, mode: 0o700 })
const result = { schema: 'whalegirl.rc3-boot/1', runtime: RUNTIME, steps: [], ok: false }
const privateBefore = existsSync(PRIVATE) ? statSync(PRIVATE).mtimeMs : null
const step = (name, status, detail) => {
  result.steps.push({ name, status, detail })
  console.log(`${status} ${name} ${detail === undefined ? '' : JSON.stringify(detail)}`)
}
const fetchJson = async (url, init = {}, timeout = 30_000) => {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text }
}
const freePort = async () => {
  const server = createServer()
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}
async function stopChild(child, waitMs = 15_000) {
  if (child === null || child.exitCode !== null) return true
  child.kill('SIGTERM')
  const deadline = Date.now() + waitMs
  while (child.exitCode === null && Date.now() < deadline) await sleep(100)
  if (child.exitCode === null) { child.kill('SIGKILL'); await sleep(500) }
  return child.exitCode !== null
}

const PROFILE_JSON = `{
  "name": "dsh-profile-nisse",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "nisse-host-integration"
      ]
    }
  }
}
`

const CORDIS_TEMPLATE = `- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: opencode-go
    model: deepseek-v4.1-flash
    reasoningEffort: low
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      opencode-go:
        apiKeyEnv: OPENCODE_GO_API_KEY
        api: anthropic-messages
        baseURL: __MOCK_BASE__
- id: tool-fs
  disabled: false
  config:
    read: true
    readImage: false
    write: true
    edit: false
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:
        sandbox: read-only
        approval: ask
      workspace-write:
        sandbox: workspace-write
        approval: ask
      danger-full-access:
        sandbox: danger-full-access
        approval: never
      bot-outside-write:
        sandbox: danger-full-access
        approval: ask
        name: Bot
        description: Bot may operate the whole computer; outside-workspace writes ask per action.
- id: nisse-host-integration
  config:
    ipcDir: __DSH_HOME__/nisse
    workspaceDir: __DSH_HOME__/workspace
    dshLlmEntry: __LLM_ENTRY__
    permissionPreset: bot-outside-write
`

let host = null
let mock = null
let code = 3
try {
  if (!PLUGIN_ROOT) throw new Error('--plugin-root (or WG_PLUGIN_ROOT) is required: path to the fork host-integration bundle')
  const cli = join(RUNTIME, 'apps/cli/lib/bin.js')
  const llmEntry = join(RUNTIME, 'packages/llm/llm/lib/index.js')
  if (!existsSync(cli) || !existsSync(llmEntry)) throw new Error('candidate runtime is not built')
  const version = JSON.parse(readFileSync(join(RUNTIME, 'package.json'), 'utf8')).version
  step('candidate', 'PASS', { version })

  const profileDir = join(dshHome, 'profiles/rc3-probe')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), PROFILE_JSON)

  const mockLog = join(runRoot, 'mock.log')
  const mockPort = await freePort()
  const mockKey = 'probe-' + randomUUID().slice(0, 8)
  mock = spawn(process.execPath, ['--import', 'tsx', join(RUNTIME, 'packages/test-support/llm-mock-server/src/bin.ts'),
    '--sequence', 'success', '--success-text', 'rc.3 bridge probe OK.', '--port', String(mockPort), '--api-key', mockKey], {
    cwd: RUNTIME, env: { ...process.env, HOME: home, DSH_HOME: dshHome }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const mockOut = createWriteStream(mockLog, { flags: 'a' })
  mock.stdout.pipe(mockOut)
  mock.stderr.pipe(mockOut)
  let mockReady = null
  const mockDeadline = Date.now() + 120_000
  while (Date.now() < mockDeadline && mockReady === null) {
    await sleep(250)
    if (existsSync(mockLog)) {
      const line = readFileSync(mockLog, 'utf8').split('\n').find((entry) => entry.includes('"type":"ready"'))
      if (line) mockReady = JSON.parse(line).baseURL
    }
    if (mock.exitCode !== null) break
  }
  if (mockReady === null) throw new Error('mock LLM did not become ready')
  step('mock-llm', 'PASS', { baseURL: mockReady })

  const patch = CORDIS_TEMPLATE
    .replaceAll('__MOCK_BASE__', mockReady.replace(/\/v1$/, ''))
    .replaceAll('__DSH_HOME__', dshHome)
    .replaceAll('__LLM_ENTRY__', llmEntry)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), patch)
  symlinkSync(PLUGIN_ROOT, join(profileDir, 'node_modules/nisse-host-integration'), 'dir')
  step('profile', 'PASS', { profileDir, plugin: PLUGIN_ROOT })

  const hostLog = join(runRoot, 'host.log')
  const hostOut = createWriteStream(hostLog, { flags: 'a' })
  const startedAt = Date.now()
  host = spawn(process.execPath, [cli, '--profile', 'rc3-probe', '--port', '0', '--no-open'], {
    cwd: RUNTIME,
    env: {
      ...process.env,
      HOME: home,
      DSH_HOME: dshHome,
      OPENCODE_GO_API_KEY: mockKey,
      NISSE_DSH_LLM_ENTRY: llmEntry,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  host.stdout.pipe(hostOut)
  host.stderr.pipe(hostOut)
  const descriptorPath = join(dshHome, 'nisse', 'host-integration.json')
  let descriptor = null
  const descriptorDeadline = Date.now() + 180_000
  while (Date.now() < descriptorDeadline && descriptor === null) {
    if (existsSync(descriptorPath)) {
      try { descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8')) } catch { descriptor = null }
    }
    if (descriptor === null) {
      if (host.exitCode !== null) break
      await sleep(100)
    }
  }
  if (descriptor === null) throw new Error(`bridge descriptor never appeared (host exit=${host.exitCode}); log: ${hostLog}`)
  step('descriptor', 'PASS', { port: descriptor.port, ms: Date.now() - startedAt })
  result.bridgePort = descriptor.port

  const api = (path, init, timeout = 60_000) => fetchJson(`http://127.0.0.1:${descriptor.port}${path}`, {
    ...init, headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' },
  }, timeout)

  let health = null
  const healthDeadline = Date.now() + 180_000
  while (Date.now() < healthDeadline && health === null) {
    const response = await api('/health', { method: 'GET' }, 10_000).catch(() => null)
    if (response?.status === 200 && response.json?.agent?.ready === true) health = response.json
    else await sleep(250)
  }
  if (health === null) throw new Error(`agent never ready; log: ${hostLog}`)
  step('health-ready', 'PASS', { sessionId: health.agent.sessionId, ms: Date.now() - startedAt })

  const created = await api('/sessions/create', { method: 'POST', body: '{}' })
  step('sessions-create', created.status === 200 ? 'PASS' : 'FAIL', { status: created.status, sessionId: created.json?.sessionId })
  if (created.status !== 200) throw new Error('sessions/create returned ' + created.status)

  const turnStarted = Date.now()
  const turn = await api('/turn', { method: 'POST', body: JSON.stringify({ text: 'Reply with one short sentence.' }) }, 240_000)
  let events = []
  // Give the mock-model turn time to run to completion, then snapshot the log.
  await sleep(6000)
  const eventsResponse = await api('/events?after=0&limit=2000', { method: 'GET' }, 15_000).catch(() => null)
  events = eventsResponse?.json?.events ?? []
  const settledEvents = events.filter((event) => (event.contractType || event.type) === 'turn.settled')
  const settled = settledEvents.length > 0 ? settledEvents[settledEvents.length - 1] : null
  const deltas = events.filter((event) => (event.contractType || event.type) === 'turn.delta')
  const types = [...new Set(events.map((event) => event.contractType || event.type))]
  const assistantText = deltas.map((event) => event.data?.text || event.delta || event.text || '').join('').slice(0, 200)
  step('turn', settled && deltas.length > 0 ? 'PASS' : 'FAIL', { httpStatus: turn.status, eventCount: events.length, deltaCount: deltas.length, settled: Boolean(settled), eventTypes: types, assistantText, ms: Date.now() - turnStarted })
  result.turn = { httpStatus: turn.status, eventCount: events.length, deltaCount: deltas.length, settled: Boolean(settled) }
  result.turn.errorEvents = events.filter((event) => (event.contractType || event.type) === 'error').map((event) => JSON.stringify(event).slice(0, 600))
  result.turn.startedEvents = events.filter((event) => (event.contractType || event.type) === 'turn.started').map((event) => JSON.stringify(event).slice(0, 400))
  result.turn.settledEvents = settledEvents.map((event) => JSON.stringify(event).slice(0, 400))
  result.turn.events = events.map((event) => ({ ioSeq: event.ioSeq, type: event.type, contractType: event.contractType, data: event.data ?? null })).slice(0, 50)
  if (!settled || deltas.length === 0) throw new Error('turn did not produce assistant output')

  const exited = await stopChild(host, 20_000)
  host = null
  step('host-stop', exited ? 'PASS' : 'FAIL', { exitedGracefully: exited })
  const descriptorGone = !existsSync(descriptorPath)
  step('descriptor-removed', descriptorGone ? 'PASS' : 'FAIL', { descriptorGone })
  code = result.steps.every((entry) => entry.status === 'PASS') ? 0 : 2
} catch (error) {
  result.error = String(error?.message || error)
  step('probe', 'FAIL', result.error)
  code = result.steps.some((entry) => entry.status === 'FAIL') ? 2 : 3
  if (host) { await stopChild(host, 20_000); host = null }
} finally {
  if (mock) { await stopChild(mock, 10_000); mock = null }
  const privateAfter = existsSync(PRIVATE) ? statSync(PRIVATE).mtimeMs : null
  result.privateHomeTouched = privateBefore !== privateAfter
  step('private-home-untouched', result.privateHomeTouched ? 'FAIL' : 'PASS', { touched: result.privateHomeTouched })
  result.ok = code === 0 && !result.privateHomeTouched
  result.exitCode = code
  result.finishedAt = new Date().toISOString()
  result.hostLogTail = existsSync(join(runRoot, 'host.log')) ? readFileSync(join(runRoot, 'host.log'), 'utf8').split('\n').slice(-25) : []
  result.runRoot = runRoot
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  console.log('RESULT ok=' + result.ok + ' exit=' + code + ' out=' + OUT + ' runRoot=' + runRoot)
  process.exit(result.ok ? 0 : code)
}
