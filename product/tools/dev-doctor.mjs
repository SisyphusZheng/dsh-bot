#!/usr/bin/env node
/**
 * Read-only development doctor for the dsh-bot desktop dev entry (plan §9.2 / B2-G14).
 *
 * It inspects, in this order: source/artifact identity, the dev Memory payload
 * resolution + Hindsight payload/version/key files, the voice venv/lock, loopback
 * ports and their owning PIDs, published bridge/memory descriptors and their live
 * health, the DevTools flags, and the actual launch path. TCC/microphone state is
 * reported as UNKNOWN/manual because it cannot be queried from a plain Node
 * process — it is never faked as PASS.
 *
 * Guarantees:
 *   - default read-only: no process is killed, nothing is deleted, no file is
 *     written, no build is triggered and no credential/token is printed;
 *   - actions requiring a wider scope (killing an old DSH, rebuilding Memory,
 *     resetting TCC) are only ever printed as remediation text for the user;
 *   - every check is classified PASS / FAIL / WARN / UNKNOWN, and the JSON
 *     report is stable enough for a gate-map to consume.
 *
 * CLI:
 *   node product/tools/dev-doctor.mjs            # human diagnosis + JSON block
 *   node product/tools/dev-doctor.mjs --json     # JSON only (gate-map friendly)
 *   node product/tools/dev-doctor.mjs --repo <dir> [--user-data <dir>] [--home <dshHome>]
 * Exit codes: 0 no FAIL check, 1 at least one FAIL check, 2 internal/usage error.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { arch, platform as hostPlatform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  DEV_MEMORY_ENV,
  MEMORY_BUILD_COMMAND,
  findWorkspaceRoot,
  resolveDevMemoryPayload,
} from '../pet/src/dev-memory-resolver.mjs'

export const DOCTOR_SCHEMA = 'dsh-bot.dev-doctor/1'

/** Status vocabulary kept compatible with the plan's gate result vocabulary. */
export const DOCTOR_STATUS = Object.freeze({
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  unknown: 'UNKNOWN',
  blockedEnvironment: 'BLOCKED-ENVIRONMENT',
})

const VOICE_DEFAULT_PORT = 8765
const DEFAULT_DEVTOOLS = Object.freeze({ main: 9229, renderer: 9222, host: 9230 })
const MEMORY_TCC_NOTE = [
  'TCC/microphone state is not programmatically queryable from a plain Node process; this is UNKNOWN/manual, never PASS.',
  'Manual check: open System Settings > Privacy & Security > Microphone and confirm the dev Electron/dsh-bot entry is enabled; then start dev:desktop and confirm the microphone actually captures (level meter moves).',
]

const sha256Of = bytes => createHash('sha256').update(bytes).digest('hex')

function defaultExec(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 10_000,
    maxBuffer: 4 * 1024 * 1024,
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
  })
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

async function defaultHttpGet(url, { headers = {}, timeoutMs = 2_500 } = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* health endpoints are expected to be JSON */ }
    return { ok: response.ok, status: response.status, json, text: text.slice(0, 500), error: null }
  } catch (error) {
    return { ok: false, status: 0, json: null, text: '', error: String(error?.message || error) }
  }
}

const readJson = path => {
  try { return { value: JSON.parse(readFileSync(path, 'utf8')), error: null } } catch (error) { return { value: null, error: String(error?.message || error) } }
}

const isExecutableFile = path => {
  try {
    const stat = statSync(path)
    return stat.isFile() && (stat.mode & 0o111) !== 0
  } catch { return false }
}

const check = (id, label, status, detail, extra = {}) => ({ id, label, status, detail, ...extra })
const pass = (id, label, detail, extra) => check(id, label, DOCTOR_STATUS.pass, detail, extra)
const fail = (id, label, detail, extra) => check(id, label, DOCTOR_STATUS.fail, detail, extra)
const warn = (id, label, detail, extra) => check(id, label, DOCTOR_STATUS.warn, detail, extra)
const unknown = (id, label, detail, extra) => check(id, label, DOCTOR_STATUS.unknown, detail, extra)

/** Resolve the target desktop development paths without importing Electron. */
export function resolveDoctorPaths({ repositoryRoot, env = process.env, userData = null, dshHome = null, platform = hostPlatform, arch: cpuArch = arch() }) {
  const appRoot = join(repositoryRoot, 'apps', 'desktop')
  const developmentRoot = join(appRoot, '.desktop-build', 'development')
  const resolvedUserData = resolve(userData ?? env.DSH_DESKTOP_USER_DATA_DIR ?? join(developmentRoot, 'electron-user-data'))
  const resolvedDshHome = resolve(dshHome ?? join(resolvedUserData, 'dsh-home'))
  const target = platform === 'win32' ? 'win-x64' : platform === 'darwin' ? (cpuArch === 'arm64' ? 'mac-arm64' : 'mac-x64') : null
  const primaryRuntime = target
    ? join(appRoot, '.desktop-build', 'targets', target, 'runtime', 'primary-runtime')
    : null
  return {
    repositoryRoot,
    appRoot,
    developmentRoot,
    userData: resolvedUserData,
    dshHome: resolvedDshHome,
    target,
    primaryRuntime,
    bridgeDescriptor: join(resolvedDshHome, 'bot', 'bridge.json'),
    memoryDescriptor: join(resolvedDshHome, 'memory', 'runtime.json'),
    voicePython: resolve(env.DSH_BOT_VOICE_PYTHON ?? join(repositoryRoot, '.mvv-build', 'voice-venv', 'bin', 'python')),
  }
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into {command,pid,port} rows. */
export function parseLsofListeners(stdout) {
  const listeners = []
  for (const line of String(stdout || '').split(/\r?\n/u)) {
    if (!line.trim() || /^COMMAND\s/u.test(line)) continue
    const fields = line.trim().split(/\s+/u)
    if (fields.length < 9) continue
    const [command, pidText] = fields
    const name = fields.slice(8).join(' ')
    const portMatch = name.match(/[:.](\d+)(?:\s|$)/u)
    if (!portMatch) continue
    const pid = Number(pidText)
    const port = Number(portMatch[1])
    if (!Number.isInteger(port) || port <= 0) continue
    listeners.push({ command, pid: Number.isInteger(pid) ? pid : null, port, address: name })
  }
  return listeners
}

function checkMemoryPayload({ paths, env }) {
  const resolved = resolveDevMemoryPayload({ repositoryRoot: paths.repositoryRoot, env })
  const evidence = {
    source: resolved.source,
    valid: resolved.valid,
    workspacePath: resolved.workspacePath,
    selectedPath: resolved.path,
    schema: resolved.validation?.version?.schema ?? null,
    generatedAt: resolved.validation?.version?.generatedAt ?? null,
    product: resolved.validation?.version?.product ?? null,
    runtime: resolved.validation?.version?.runtime ?? null,
    components: resolved.validation?.version?.components ?? null,
    sidecarSha256Match: resolved.validation?.sidecarSha256Match ?? null,
    noImplicitMachinePath: true,
    envOverride: resolved.envOverride?.present
      ? {
        name: DEV_MEMORY_ENV,
        path: resolved.envOverride.path,
        valid: resolved.envOverride.validation?.valid ?? false,
        problems: resolved.envOverride.validation?.problems?.map(problem => problem.code) ?? [],
      }
      : null,
    warnings: resolved.warnings,
    problems: resolved.validation?.problems ?? [],
  }
  if (resolved.source === 'workspace' && resolved.valid) {
    return pass('memory.payload', 'dev Memory payload', resolved.message, { evidence, remediation: null })
  }
  if (resolved.source === 'env-override') {
    return warn(
      'memory.payload',
      'dev Memory payload',
      resolved.message,
      {
        evidence,
        remediation: MEMORY_BUILD_COMMAND,
      },
    )
  }
  return fail('memory.payload', 'dev Memory payload', resolved.message, {
    evidence,
    remediation: MEMORY_BUILD_COMMAND,
  })
}

function collectListeners({ exec, platform }) {
  const lsof = exec('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeoutMs: 5_000 })
  if (lsof.ok) return { available: true, tool: 'lsof', listeners: parseLsofListeners(lsof.stdout) }
  if (platform === 'linux') {
    const ss = exec('ss', ['-ltnp'], { timeoutMs: 5_000 })
    if (ss.ok) {
      const listeners = []
      for (const line of ss.stdout.split(/\r?\n/u)) {
        const match = line.match(/\s(?:[\d.*]+):(\d+)\s/u)
        const pidMatch = line.match(/pid=(\d+)/u)
        if (match) listeners.push({ command: pidMatch ? 'ss' : 'unknown', pid: pidMatch ? Number(pidMatch[1]) : null, port: Number(match[1]), address: line.trim().slice(0, 200) })
      }
      return { available: true, tool: 'ss', listeners }
    }
  }
  return { available: false, tool: null, listeners: [], error: lsof.error || lsof.stderr?.slice(0, 200) || null }
}

function listenerOwnership(listener, ownedPids) {
  if (listener.pid !== null && ownedPids.has(listener.pid)) return 'owned'
  if (/electron|dsh-bot|dsh_bot/iu.test(listener.command || '')) return 'likely-dsh-bot'
  return 'other'
}

function loopbackUrlPort(value) {
  if (typeof value !== 'string') return null
  const match = value.match(/^http:\/\/127\.0\.0\.1:(\d+)$/u)
  return match ? Number(match[1]) : null
}

function portsChecks({ paths, listenersInfo, ownedPids, env, verifiedPorts = new Set() }) {
  const checks = []
  const configured = {
    bridge: null,
    memory: null,
    voice: Number(env.NISSE_PIPECAT_PORT ?? VOICE_DEFAULT_PORT),
    devtools: {
      main: Number(env.DSH_DESKTOP_MAIN_INSPECT_PORT ?? DEFAULT_DEVTOOLS.main),
      renderer: Number(env.DSH_DESKTOP_RENDERER_DEBUG_PORT ?? DEFAULT_DEVTOOLS.renderer),
      host: Number(env.DSH_DESKTOP_HOST_INSPECT_PORT ?? DEFAULT_DEVTOOLS.host),
    },
  }
  const bridge = readJson(paths.bridgeDescriptor)
  if (bridge.value && Number.isInteger(bridge.value.port)) configured.bridge = bridge.value.port
  const memory = readJson(paths.memoryDescriptor)
  const memoryPort = loopbackUrlPort(memory.value?.url)
  if (memoryPort !== null) configured.memory = memoryPort
  if (!listenersInfo.available) {
    checks.push(unknown('ports.listeners', 'loopback listeners', `Neither lsof nor ss is available; port ownership cannot be inspected (${listenersInfo.error ?? 'unknown reason'}).`, { evidenceLevel: 'manual' }))
    return checks
  }
  const byPort = port => listenersInfo.listeners.filter(listener => listener.port === port)
  const describe = port => byPort(port).map(listener => `${listener.command || 'unknown'} pid=${listener.pid ?? '?'} ${listenerOwnership(listener, ownedPids)}`)
  const inspectPort = (id, label, port, { expectedWhenRunning = true, ownerPids = ownedPids } = {}) => {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      checks.push(unknown(id, label, id === 'ports.bridge' || id === 'ports.memory' ? 'No live descriptor published yet (desktop dev entry not running).' : `Invalid configured port: ${String(port)}`))
      return
    }
    const hits = byPort(port)
    if (hits.length === 0) {
      checks.push(unknown(id, label, `Port ${port} is free (no listener). The dev entry is not running or this service is not started yet; nothing was killed.`))
      return
    }
    const details = hits.map(listener => ({
      command: listener.command,
      pid: listener.pid,
      ownership: listenerOwnership(listener, ownerPids),
      address: listener.address,
    }))
    const owned = details.some(entry => entry.ownership === 'owned')
    const likely = details.some(entry => entry.ownership === 'likely-dsh-bot')
    if (!owned && verifiedPorts.has(port)) {
      // The descriptor-verified service (authenticated memory health / bridge
      // health with the recorded pid) proves the listener belongs to this dev
      // entry even though the pid is not the bridge pid.
      checks.push(pass(id, label, `Port ${port} is verified as this dev entry's service by its published descriptor + live health (${details.map(entry => `pid=${entry.pid ?? '?'} ${entry.command}`).join(', ')}).`, { evidence: { port, listeners: details, descriptorVerified: true } }))
    } else if (owned) checks.push(pass(id, label, `Port ${port} is owned by the recorded dev process (${details.map(entry => `pid=${entry.pid ?? '?'} ${entry.command}`).join(', ')}).`, { evidence: { port, listeners: details } }))
    else if (likely) checks.push(warn(id, label, `Port ${port} is in use by a likely dsh-bot/Electron process (${details.map(entry => `pid=${entry.pid ?? '?'} ${entry.command}`).join(', ')}); doctor did not kill it.`, { evidence: { port, listeners: details }, remediation: 'If this is a stale dev instance, quit it yourself (or restart it); the read-only doctor never kills other DSH processes.' }))
    else checks.push(warn(id, label, `Port ${port} is in use by another process (${details.map(entry => `pid=${entry.pid ?? '?'} ${entry.command}`).join(', ')}); doctor did not kill it.`, { evidence: { port, listeners: details }, remediation: `Close the other process or choose a different port${expectedWhenRunning ? ' before starting dev:desktop' : ''}; the doctor never terminates unrelated processes.` }))
  }
  if (configured.bridge !== null) inspectPort('ports.bridge', 'Host bridge port', configured.bridge)
  if (configured.memory !== null) inspectPort('ports.memory', 'Memory adapter port', configured.memory)
  inspectPort('ports.voice', 'Voice worker port', configured.voice)
  for (const [name, port] of Object.entries(configured.devtools)) {
    inspectPort(`ports.devtools-${name}`, `DevTools ${name} port`, port)
  }
  return checks
}

function descriptorChecks({ paths }) {
  const checks = []
  // Bridge descriptor: published by Host Integration on every Host start.
  const bridge = readJson(paths.bridgeDescriptor)
  let bridgeValid = false
  if (bridge.error) {
    checks.push(unknown('bridge.descriptor', 'Host bridge descriptor', `No valid descriptor at ${paths.bridgeDescriptor} (${bridge.error}); the desktop dev entry is not running yet.`, { evidenceLevel: 'file' }))
  } else {
    const value = bridge.value ?? {}
    const problems = []
    if (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65_535) problems.push('port')
    if (typeof value.token !== 'string' || value.token.length < 8) problems.push('token')
    if (!Number.isInteger(value.pid) || value.pid <= 0) problems.push('pid')
    if (problems.length > 0) {
      checks.push(fail('bridge.descriptor', 'Host bridge descriptor', `Descriptor ${paths.bridgeDescriptor} is malformed (missing/invalid: ${problems.join(', ')}).`, {
        evidence: { path: paths.bridgeDescriptor, problems },
        remediation: 'Restart dev:desktop so Host Integration republishes bot/bridge.json; the doctor does not edit or delete the descriptor.',
      }))
    } else {
      bridgeValid = true
      checks.push(pass('bridge.descriptor', 'Host bridge descriptor', `Descriptor is structurally valid (port=${value.port}, pid=${value.pid}; token redacted).`, {
        evidence: { path: paths.bridgeDescriptor, port: value.port, pid: value.pid, token: '<redacted>' },
      }))
    }
  }
  // Memory descriptor: published only when the adapter is ready.
  const memory = readJson(paths.memoryDescriptor)
  let memoryDescriptorValid = false
  if (memory.error) {
    checks.push(unknown('memory.descriptor', 'Memory adapter descriptor', `No valid descriptor at ${paths.memoryDescriptor} (${memory.error}); Memory is not ready or the desktop dev entry is not running.`, { evidenceLevel: 'file' }))
  } else {
    const value = memory.value ?? {}
    const problems = []
    if (typeof value.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(value.url)) problems.push('url')
    if (typeof value.token !== 'string' || value.token.length < 8) problems.push('token')
    if (problems.length > 0) {
      checks.push(fail('memory.descriptor', 'Memory adapter descriptor', `Descriptor ${paths.memoryDescriptor} is malformed (missing/invalid: ${problems.join(', ')}).`, {
        evidence: { path: paths.memoryDescriptor, problems },
        remediation: 'Restart dev:desktop and inspect the Memory runtime status; the doctor does not edit or delete the descriptor.',
      }))
    } else {
      memoryDescriptorValid = true
      checks.push(pass('memory.descriptor', 'Memory adapter descriptor', `Descriptor is structurally valid (${value.url}; token redacted).`, {
        evidence: { path: paths.memoryDescriptor, url: value.url, token: '<redacted>' },
      }))
    }
  }
  return { checks, bridgeValid, memoryDescriptorValid, bridgeValue: bridge.value ?? null, memoryValue: memory.value ?? null }
}

async function healthChecks({ bridgeValid, memoryDescriptorValid, bridgeValue, memoryValue, httpGet }) {
  const checks = []
  if (memoryDescriptorValid) {
    const response = await httpGet(`${memoryValue.url}/health`, { headers: { authorization: `Bearer ${memoryValue.token}` }, timeoutMs: 2_500 })
    if (response.ok && response.json && response.json.ok === true) {
      const bankId = typeof response.json.bankId === 'string' ? response.json.bankId : null
      checks.push(pass('memory.health', 'Memory authenticated health', `Memory adapter /health is live${bankId ? ` (bankId=${bankId})` : ''}.`, { evidence: { url: memoryValue.url, status: response.status, bankId } }))
    } else {
      checks.push(fail('memory.health', 'Memory authenticated health', `Memory descriptor exists but /health failed (status=${response.status}${response.error ? `, ${response.error}` : ''}).`, {
        evidence: { url: memoryValue.url, status: response.status, error: response.error },
        remediation: 'Inspect the Memory runtime status in dev:desktop; rebuild the payload with `bash product/tools/build-memory.sh` only if the payload is invalid. Do not kill other DSH processes.',
      }))
    }
  } else {
    checks.push(unknown('memory.health', 'Memory authenticated health', 'No published Memory descriptor, so authenticated /health was not probed (desktop dev entry not running).', { evidenceLevel: 'manual' }))
  }
  if (bridgeValid) {
    const url = `http://127.0.0.1:${bridgeValue.port}`
    const response = await httpGet(`${url}/health`, { timeoutMs: 2_500 })
    const pid = response.json && typeof response.json.pid === 'number' ? response.json.pid : null
    if (response.ok && response.json) {
      const pidMatches = pid === null || pid === bridgeValue.pid
      if (!pidMatches) {
        checks.push(fail('bridge.health', 'Host bridge health', `bridge.json pid=${bridgeValue.pid} but /health reports pid=${pid}; the descriptor is stale or belonged to another process.`, {
          evidence: { url, descriptorPid: bridgeValue.pid, healthPid: pid },
          remediation: 'Restart dev:desktop so Host Integration republishes the descriptor; the doctor does not kill the process.',
        }))
      } else {
        checks.push(pass('bridge.health', 'Host bridge health', `Host bridge /health is live at ${url} (pid=${pid ?? bridgeValue.pid}).`, { evidence: { url, pid: pid ?? bridgeValue.pid } }))
      }
    } else {
      checks.push(fail('bridge.health', 'Host bridge health', `bridge.json exists but ${url}/health failed (status=${response.status}${response.error ? `, ${response.error}` : ''}); the descriptor is stale.`, {
        evidence: { url, status: response.status, error: response.error },
        remediation: 'Restart dev:desktop; the read-only doctor never kills the stale process.',
      }))
    }
  } else {
    checks.push(unknown('bridge.health', 'Host bridge health', 'No valid bridge descriptor, so Host /health was not probed (desktop dev entry not running).', { evidenceLevel: 'manual' }))
  }
  return checks
}

/**
 * Run the read-only doctor and return the structured report.
 * @param {object} [options]
 * @param {string} [options.repositoryRoot] dsh-bot workspace root.
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {string|null} [options.userData]
 * @param {string|null} [options.dshHome]
 * @param {(command: string, args: string[], options?: object) => object} [options.exec]
 * @param {(url: string, options?: object) => Promise<object>} [options.httpGet]
 * @param {() => Date} [options.now]
 * @returns {Promise<object>}
 */
export async function runDevDoctor(options = {}) {
  const env = options.env ?? process.env
  const platform = options.platform ?? hostPlatform()
  const cpuArch = options.arch ?? arch()
  const now = options.now ?? (() => new Date())
  const exec = options.exec ?? defaultExec
  const httpGet = options.httpGet ?? defaultHttpGet
  const repositoryRoot = options.repositoryRoot ? resolve(options.repositoryRoot) : findWorkspaceRoot(options.startDirectory ?? process.cwd())
  const checks = []
  if (!repositoryRoot) {
    checks.push(fail('identity.repository', 'workspace identity', 'dsh-bot workspace root not found; run the doctor from the repository (or pass --repo).', { remediation: 'cd <dsh-bot checkout> && node product/tools/dev-doctor.mjs --json' }))
    return finalize({ repositoryRoot: null, checks, now, platform, cpuArch, paths: null })
  }
  const paths = resolveDoctorPaths({ repositoryRoot, env, userData: options.userData, dshHome: options.dshHome, platform, arch: cpuArch })
  const identity = {}

  // Source identity (read-only git probes).
  const gitHead = exec('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, timeoutMs: 5_000 })
  const gitTree = exec('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repositoryRoot, timeoutMs: 5_000 })
  const gitBranch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repositoryRoot, timeoutMs: 5_000 })
  const gitStatus = exec('git', ['status', '--porcelain'], { cwd: repositoryRoot, timeoutMs: 10_000 })
  if (gitHead.ok) {
    identity.head = gitHead.stdout.trim()
    identity.tree = gitTree.ok ? gitTree.stdout.trim() : null
    identity.branch = gitBranch.ok ? gitBranch.stdout.trim() : null
    identity.dirty = gitStatus.ok ? gitStatus.stdout.trim().split(/\r?\n/u).filter(Boolean).length > 0 : null
    checks.push(identity.dirty === true
      ? warn('identity.source', 'git source identity', `HEAD ${identity.head}${identity.tree ? ` tree ${identity.tree}` : ''} (branch ${identity.branch ?? '?'}); the worktree is dirty, so this is not a frozen source identity.`, { evidence: identity, remediation: 'Commit or stash the intended changes before freezing/packaging; the doctor only reports the state.' })
      : pass('identity.source', 'git source identity', `HEAD ${identity.head}${identity.tree ? ` tree ${identity.tree}` : ''} (branch ${identity.branch ?? '?'}; clean=${identity.dirty === false}).`, { evidence: identity }))
  } else {
    checks.push(warn('identity.source', 'git source identity', `git is unavailable or this is not a git checkout (${gitHead.error ?? gitHead.stderr?.trim() ?? 'unknown'}); source identity is not verifiable.`, { evidence: { error: gitHead.error } }))
  }

  // Product/runtime versions and artifact identity.
  const versionsFile = join(repositoryRoot, 'product', 'versions.json')
  const versions = readJson(versionsFile)
  const desktopManifest = readJson(join(paths.appRoot, 'package.json'))
  const cliManifest = readJson(join(repositoryRoot, 'apps', 'cli', 'package.json'))
  const hostManifest = readJson(join(repositoryRoot, 'apps', 'desktop-host', 'package.json'))
  if (versions.error) {
    checks.push(fail('identity.product', 'product versions', `product/versions.json is missing or unreadable: ${versions.error}`, { remediation: 'Restore the repository from the frozen source; do not edit this file by hand.' }))
  } else {
    const productVersion = versions.value?.product?.version ?? null
    const runtimeVersion = versions.value?.runtime?.version ?? null
    const desktopVersion = desktopManifest.value?.version ?? null
    const cliVersion = cliManifest.value?.version ?? null
    identity.productVersion = productVersion
    identity.runtimeVersion = runtimeVersion
    identity.desktopVersion = desktopVersion
    identity.cliVersion = cliVersion
    identity.memoryDependencies = versions.value?.memory ?? null
    const problems = []
    if (typeof productVersion !== 'string') problems.push('product.version')
    if (typeof runtimeVersion !== 'string') problems.push('runtime.version')
    if (typeof desktopVersion === 'string' && typeof productVersion === 'string' && desktopVersion !== productVersion) problems.push(`apps/desktop version ${desktopVersion} != product ${productVersion}`)
    if (typeof cliVersion === 'string' && typeof runtimeVersion === 'string' && cliVersion !== runtimeVersion) problems.push(`apps/cli version ${cliVersion} != runtime ${runtimeVersion}`)
    if (problems.length > 0) {
      checks.push(fail('identity.product', 'product versions', `Version identity is inconsistent: ${problems.join('; ')}.`, { evidence: identity, remediation: 'Align product/versions.json, apps/desktop and apps/cli metadata; a released product must not report a version that differs from the version it was built as.' }))
    } else {
      checks.push(pass('identity.product', 'product versions', `Product ${productVersion}; Runtime ${runtimeVersion}; apps/desktop ${desktopVersion}; apps/cli ${cliVersion}.`, { evidence: identity }))
    }
  }
  const hostVersion = hostManifest.value?.version ?? null
  if (hostVersion === null) checks.push(warn('identity.host', 'desktop host package', 'apps/desktop-host/package.json is missing or unreadable.', { evidenceLevel: 'file' }))

  // Build/launch artifacts used by the unpackaged dev entry.
  const requiredArtifacts = [
    join(paths.appRoot, 'lib', 'main.js'),
    join(repositoryRoot, 'apps', 'desktop-host', 'lib', 'index.js'),
    join(paths.appRoot, 'resources', 'pet', 'pet.html'),
    join(paths.appRoot, 'resources', 'pet', 'bubble.html'),
    join(paths.appRoot, 'resources', 'pet', 'bubble-window.mjs'),
    join(paths.appRoot, 'resources', 'pet', 'window-layer-policy.mjs'),
  ]
  const missingArtifacts = requiredArtifacts.filter(path => !existsSync(path))
  if (missingArtifacts.length > 0) {
    checks.push(fail('identity.build', 'dev build artifacts', `Missing dev artifacts: ${missingArtifacts.map(path => path.replace(`${repositoryRoot}/`, '')).join(', ')}.`, {
      evidence: { missing: missingArtifacts },
      remediation: 'Run `pnpm run dev:desktop` (it builds first) rather than `start:desktop --skip-build`; do not delete or fake artifacts.',
    }))
  } else {
    checks.push(pass('identity.build', 'dev build artifacts', 'Built main/host/pet resources exist, including resources/pet/window-layer-policy.mjs.', { evidenceLevel: 'file' }))
  }

  // Actual launch path and flags.
  const launcher = join(paths.appRoot, 'scripts', 'dev.ts')
  // Resolve the Electron executable by reading the installed package's
  // path.txt instead of `require('electron')`: the package's index.js starts a
  // binary download as a side effect when the distribution is missing, and this
  // doctor must stay strictly read-only (no network, no installs).
  let electronPath = null
  let electronError = null
  try {
    const electronPackage = join(paths.appRoot, 'node_modules', 'electron')
    const relative = readFileSync(join(electronPackage, 'path.txt'), 'utf8').trim()
    const candidate = join(electronPackage, 'dist', relative)
    if (relative && existsSync(candidate)) electronPath = candidate
    else electronError = `installed Electron binary is missing: ${candidate}`
  } catch (error) { electronError = String(error?.message || error) }
  const launch = {
    command: 'pnpm run dev:desktop  (or: node apps/desktop/scripts/dev.ts via tsx)',
    appRoot: paths.appRoot,
    developmentRoot: paths.developmentRoot,
    userData: paths.userData,
    dshHome: paths.dshHome,
    bridgeDescriptor: paths.bridgeDescriptor,
    memoryDescriptor: paths.memoryDescriptor,
    voicePython: paths.voicePython,
    target: paths.target,
    primaryRuntime: paths.primaryRuntime,
    electron: electronPath,
    devtools: {
      enabledByDefault: true,
      openDevtoolsEnv: env.DSH_DESKTOP_OPEN_DEVTOOLS ?? null,
      openDevtools: (env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '1') !== '0',
      ports: {
        main: Number(env.DSH_DESKTOP_MAIN_INSPECT_PORT ?? DEFAULT_DEVTOOLS.main),
        renderer: Number(env.DSH_DESKTOP_RENDERER_DEBUG_PORT ?? DEFAULT_DEVTOOLS.renderer),
        host: Number(env.DSH_DESKTOP_HOST_INSPECT_PORT ?? DEFAULT_DEVTOOLS.host),
      },
    },
    hostInspectEnv: env.DSH_DESKTOP_HOST_INSPECT_PORT ?? null,
  }
  if (!existsSync(launcher)) {
    checks.push(fail('launch.path', 'dev launch path', `apps/desktop/scripts/dev.ts is missing; cannot launch the dev entry.`, { evidence: launch }))
  } else if (electronPath === null) {
    checks.push(fail('launch.path', 'dev launch path', `Electron executable is not resolvable from apps/desktop: ${electronError || 'unknown reason'}.`, { evidence: launch, remediation: 'Run `npx --yes pnpm@11.28.5 install --frozen-lockfile` in the workspace root.' }))
  } else {
    checks.push(pass('launch.path', 'dev launch path', `Launch ${launch.command}; userData=${paths.userData}; DSH_HOME=${paths.dshHome}; resources=${join(paths.appRoot, 'resources')}.`, { evidence: launch }))
  }
  if (paths.primaryRuntime && !existsSync(paths.primaryRuntime)) {
    checks.push(warn('launch.primary-runtime', 'dev primary runtime', `Primary runtime directory is missing: ${paths.primaryRuntime}; dev:desktop prepares it, start:desktop --skip-build will fail.`, { remediation: 'Run `pnpm run dev:desktop` (without --skip-build) or `pnpm run prepare:primary-runtime`.' }))
  } else if (paths.primaryRuntime) {
    checks.push(pass('launch.primary-runtime', 'dev primary runtime', `Primary runtime present: ${paths.primaryRuntime}.`, { evidenceLevel: 'file' }))
  } else {
    checks.push(unknown('launch.primary-runtime', 'dev primary runtime', `No supported dev target for ${platform}/${cpuArch}; primary runtime path is unknown.`, { evidenceLevel: 'manual' }))
  }
  checks.push(pass('launch.devtools', 'DevTools flags', launch.devtools.openDevtools
    ? `DevTools open by default (DSH_DESKTOP_OPEN_DEVTOOLS=${launch.devtools.openDevtoolsEnv ?? '<unset=>1>'}), inspector ports main=${launch.devtools.ports.main}, renderer=${launch.devtools.ports.renderer}, host=${launch.devtools.ports.host}.`
    : `DevTools disabled via DSH_DESKTOP_OPEN_DEVTOOLS=0 (inspector ports main=${launch.devtools.ports.main}, renderer=${launch.devtools.ports.renderer}, host=${launch.devtools.ports.host}).`, { evidence: launch.devtools }))

  // Memory payload + descriptors + live health.
  const descriptors = descriptorChecks({ paths })
  checks.push(...descriptors.checks)
  const ownedPids = new Set()
  if (descriptors.bridgeValid && Number.isInteger(descriptors.bridgeValue?.pid)) ownedPids.add(descriptors.bridgeValue.pid)
  // One read-only listener snapshot (lsof/ss); the doctor never signals PIDs.
  const listenersInfo = collectListeners({ exec, platform })
  checks.push(checkMemoryPayload({ paths, env }))
  const liveHealthChecks = await healthChecks({
    bridgeValid: descriptors.bridgeValid,
    memoryDescriptorValid: descriptors.memoryDescriptorValid,
    bridgeValue: descriptors.bridgeValue,
    memoryValue: descriptors.memoryValue,
    httpGet,
  })
  checks.push(...liveHealthChecks)
  const verifiedPorts = new Set()
  if (liveHealthChecks.some(entry => entry.id === 'memory.health' && entry.status === DOCTOR_STATUS.pass)) {
    const port = loopbackUrlPort(descriptors.memoryValue?.url)
    if (port !== null) verifiedPorts.add(port)
  }
  if (liveHealthChecks.some(entry => entry.id === 'bridge.health' && entry.status === DOCTOR_STATUS.pass) && Number.isInteger(descriptors.bridgeValue?.port)) {
    verifiedPorts.add(descriptors.bridgeValue.port)
  }

  // Voice venv dependencies + pinned lock identity.
  const voiceChecks = []
  if (!isExecutableFile(paths.voicePython)) {
    voiceChecks.push(fail('voice.venv', 'voice Python env', `Voice Python is missing or not executable: ${paths.voicePython}.`, {
      remediation: 'Create it with uv (Python 3.12.13) and sync the hash-locked requirements: uv venv --clear --python 3.12.13 .mvv-build/voice-venv && uv pip sync --python .mvv-build/voice-venv/bin/python --require-hashes product/voice-worker-src/requirements-macos.lock',
    }))
  } else {
    const version = exec(paths.voicePython, ['--version'], { timeoutMs: 10_000 })
    const imports = exec(paths.voicePython, ['-c', 'import pipecat, aiortc, av, fastapi, uvicorn; print("voice-deps-ok")'], { timeoutMs: 30_000 })
    if (imports.ok && imports.stdout.includes('voice-deps-ok')) {
      voiceChecks.push(pass('voice.venv', 'voice Python env', `${version.ok ? version.stdout.trim() : 'python available'} with pipecat/aiortc/av/fastapi/uvicorn importable.`, { evidence: { python: paths.voicePython } }))
    } else {
      voiceChecks.push(fail('voice.venv', 'voice Python env', `Voice venv exists but required deps do not import: ${(imports.stderr || imports.stdout || imports.error || 'unknown').trim().slice(0, 300)}.`, {
        evidence: { python: paths.voicePython },
        remediation: 'Sync the hash-locked requirements into .mvv-build/voice-venv (see plan §12.3); do not reuse an unknown old venv.',
      }))
    }
  }
  const lockPath = join(repositoryRoot, 'product', 'voice-worker-src', 'requirements-macos.lock')
  const expectedLock = versions.value?.voice?.lockSha256 ?? null
  if (!existsSync(lockPath)) {
    voiceChecks.push(fail('voice.lock', 'voice dependency lock', `Missing ${lockPath.replace(`${repositoryRoot}/`, '')}.`, { remediation: 'Restore the pinned lock file from the frozen source.' }))
  } else if (typeof expectedLock === 'string' && expectedLock.length > 0) {
    try {
      const actual = sha256Of(readFileSync(lockPath))
      if (actual === expectedLock) voiceChecks.push(pass('voice.lock', 'voice dependency lock', `requirements-macos.lock matches product/versions.json voice.lockSha256 (${actual.slice(0, 12)}…).`, { evidence: { sha256: actual } }))
      else voiceChecks.push(fail('voice.lock', 'voice dependency lock', `requirements-macos.lock sha256 ${actual.slice(0, 12)}… does not match the frozen ${expectedLock.slice(0, 12)}….`, { evidence: { actual, expected: expectedLock }, remediation: 'Do not silently update the lock; restore the frozen lock or record an explicit dependency change.' }))
    } catch (error) {
      voiceChecks.push(warn('voice.lock', 'voice dependency lock', `Unable to hash the voice lock: ${String(error?.message || error)}.`))
    }
  } else {
    voiceChecks.push(pass('voice.lock', 'voice dependency lock', 'requirements-macos.lock exists (no expected hash recorded in product/versions.json).', { evidenceLevel: 'file' }))
  }
  const voicePort = Number(env.NISSE_PIPECAT_PORT ?? VOICE_DEFAULT_PORT)
  const voiceListeners = listenersInfo.available
    ? listenersInfo.listeners.filter(listener => listener.port === voicePort)
    : []
  const voiceHealth = await httpGet(`http://127.0.0.1:${voicePort}/health`, { timeoutMs: 1_500 })
  if (!voiceHealth.ok) {
    voiceChecks.push(unknown('voice.health', 'voice worker health', `Voice worker /health not reachable on port ${voicePort} (${voiceHealth.error ?? `status ${voiceHealth.status}`}); expected before the dev entry starts.`, { evidenceLevel: 'manual' }))
  } else if (!listenersInfo.available) {
    voiceChecks.push(warn('voice.health', 'voice worker health', `Port ${voicePort} answered /health, but the owning process cannot be inspected without lsof/ss; ownership is unknown, so this is not reported as PASS.`, { evidence: { status: voiceHealth.status }, evidenceLevel: 'manual' }))
  } else {
    const attributed = voiceListeners.filter(listener => listenerOwnership(listener, ownedPids) !== 'other')
    if (attributed.length > 0) {
      voiceChecks.push(pass('voice.health', 'voice worker health', `Voice worker /health is live on port ${voicePort} (listener ${attributed.map(listener => `${listener.command} pid=${listener.pid ?? '?'}`).join(', ')}).`, { evidence: { status: voiceHealth.status } }))
    } else {
      voiceChecks.push(warn('voice.health', 'voice worker health', `Port ${voicePort} answered /health, but the listener (${voiceListeners.map(listener => `${listener.command} pid=${listener.pid ?? '?'}`).join(', ') || 'unknown'}) is not attributable to this dev entry; it may belong to another DSH/worker instance. Not reported as PASS.`, {
        evidence: { status: voiceHealth.status, listeners: voiceListeners.map(listener => ({ command: listener.command, pid: listener.pid })) },
        remediation: 'Confirm which process owns the voice worker port before starting another dev instance; the doctor never kills it.',
      }))
    }
  }
  checks.push(...voiceChecks)

  // Ports + owning PIDs (read-only observation; never kills).
  checks.push(...portsChecks({ paths, listenersInfo, ownedPids, env, verifiedPorts }))

  // TCC/microphone: never faked as PASS.
  checks.push(unknown('platform.tcc-microphone', 'TCC / microphone permission', MEMORY_TCC_NOTE[0], {
    evidenceLevel: 'manual',
    remediation: MEMORY_TCC_NOTE[1],
  }))

  return finalize({ repositoryRoot, identity, launch, checks, now, platform, cpuArch, paths })
}

function finalize({ repositoryRoot, identity = {}, launch = null, checks, now, platform, cpuArch, paths }) {
  const summary = { pass: 0, fail: 0, warn: 0, unknown: 0, total: checks.length }
  const nextActions = []
  const diagnosis = []
  for (const entry of checks) {
    if (entry.status === DOCTOR_STATUS.pass) summary.pass += 1
    else if (entry.status === DOCTOR_STATUS.fail) {
      summary.fail += 1
      diagnosis.push(`FAIL ${entry.id}: ${entry.detail}`)
      if (entry.remediation) nextActions.push(entry.remediation)
    } else if (entry.status === DOCTOR_STATUS.warn) {
      summary.warn += 1
      diagnosis.push(`WARN ${entry.id}: ${entry.detail}`)
      if (entry.remediation) nextActions.push(entry.remediation)
    } else {
      summary.unknown += 1
      diagnosis.push(`${entry.status} ${entry.id}: ${entry.detail}`)
      if (entry.remediation && entry.id === 'platform.tcc-microphone') nextActions.push(entry.remediation)
    }
  }
  const status = summary.fail > 0 ? DOCTOR_STATUS.fail : DOCTOR_STATUS.pass
  const human = [
    `dsh-bot dev doctor (${status}) — read-only: no process killed, nothing deleted or written`,
    `workspace: ${repositoryRoot ?? '<not found>'}`,
    ...(paths
      ? [
        `launch: ${launch?.command ?? 'unknown'}`,
        `userData: ${paths.userData}`,
        `DSH_HOME: ${paths.dshHome}`,
        `voice python: ${paths.voicePython}`,
      ]
      : []),
    `checks: ${summary.pass} PASS, ${summary.fail} FAIL, ${summary.warn} WARN, ${summary.unknown} UNKNOWN`,
    ...diagnosis,
    ...(nextActions.length > 0 ? ['next actions:', ...[...new Set(nextActions)].map(action => `- ${action}`)] : []),
  ]
  return {
    schema: DOCTOR_SCHEMA,
    generatedAt: now().toISOString(),
    readOnly: true,
    status,
    platform: { platform, arch: cpuArch, release: release() },
    repositoryRoot,
    identity,
    launch,
    checks,
    summary,
    diagnosis: human,
    nextActions: [...new Set(nextActions)],
  }
}

/** Human-readable lines without the JSON block (used by the default CLI). */
export function formatDoctorHuman(report) {
  return report.diagnosis.join('\n')
}

function parseCli(argv) {
  const options = { json: false, repositoryRoot: null, userData: null, dshHome: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--repo') options.repositoryRoot = argv[++index] ?? null
    else if (arg === '--user-data') options.userData = argv[++index] ?? null
    else if (arg === '--home') options.dshHome = argv[++index] ?? null
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

async function main() {
  const options = parseCli(process.argv.slice(2))
  if (options.help) {
    console.log('usage: node product/tools/dev-doctor.mjs [--json] [--repo <dir>] [--user-data <dir>] [--home <dshHome>]')
    console.log('Read-only dsh-bot dev doctor. Exit 0 = no FAIL check, 1 = at least one FAIL, 2 = usage/internal error.')
    return
  }
  const report = await runDevDoctor(options)
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    console.log(formatDoctorHuman(report))
    console.log('\n--- structured ---')
    console.log(JSON.stringify(report, null, 2))
  }
  if (report.status !== DOCTOR_STATUS.pass) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(`dev-doctor internal error: ${String(error?.stack || error)}`)
    process.exitCode = 2
  })
}
