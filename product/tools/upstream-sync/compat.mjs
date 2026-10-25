#!/usr/bin/env node
// Minimal compatibility suite for a WhaleGirlBot release candidate.
//
// Runs the three gates that must hold for ANY runtime/plugin/voice change:
//   1. manifest contract  — versions.json validates (tag/commit/artifact/pins)
//   2. host preflight      — m4/preflight.mjs (single-flight ensureAgent, ready
//                            semantics, one plugin load) against the pinned runtime
//   3. voice worker health — packaged VoiceWorker answers GET /health on an
//                            isolated port with an isolated HOME
// Optional:
//   4. memory sidecar health — only when --memory-url is supplied (owned by the
//                            memory stream; this suite never starts the sidecar).
//
// Results are written as structured JSON to docs/reports/compat-<ts>.json plus a
// stable docs/reports/compat-latest.json. Exit codes mirror m4/preflight.mjs:
//   0 = PASS, 2 = PRODUCT_FAIL, 3 = COMPAT_FAIL, 4 = ENV_FAIL.
//
// Usage:
//   node tools/upstream-sync/compat.mjs [options]
//     --project-root <dir>       project root (default: WG_PROJECT_ROOT or repo root)
//     --reports-dir <dir>        evidence dir (default <project-root>/docs/reports)
//     --runs <n>                 preflight repetitions (default 1)
//     --skip-preflight           skip gate 2 (dry-run on a read-only host)
//     --preflight-evidence <f>   reuse a recorded m4 PREFLIGHT-*.json instead of
//                                running the host (mode: recorded)
//     --voice-worker <path>      VoiceWorker binary (default: dist/voice-worker/VoiceWorker)
//     --voice-timeout-ms <n>     health wait (default 90000)
//     --memory-url <url>         memory sidecar base url (optional)
//     --json                     also print the result JSON
//     --no-write                 do not write evidence files
//     --no-hash                  skip artifact sha256 verification (artifact still rebuilding)
//
// This suite never upgrades anything and never writes the product source tree.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { connect, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadManifest, defaultManifestPath, resolveProjectRoot, validateManifest } from './lib/manifest.mjs'

// Exit codes mirror m4/preflight.mjs so CI can classify failures the same way.
const CODES = { PASS: 0, PRODUCT_FAIL: 2, COMPAT_FAIL: 3, ENV_FAIL: 4 }

const PRIVATE_DSH_HOME = join(homedir(), '.' + 'dsh')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function parseArgs(argv) {
  const args = { runs: 1, voiceTimeoutMs: 90_000, json: false, write: true, skipPreflight: false, preflightEvidence: '', noHash: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--project-root') args.projectRoot = argv[++i]
    else if (arg === '--reports-dir') args.reportsDir = argv[++i]
    else if (arg === '--runs') args.runs = Number(argv[++i])
    else if (arg === '--skip-preflight') args.skipPreflight = true
    else if (arg === '--preflight-evidence') args.preflightEvidence = argv[++i]
    else if (arg === '--voice-worker') args.voiceWorker = argv[++i]
    else if (arg === '--voice-timeout-ms') args.voiceTimeoutMs = Number(argv[++i])
    else if (arg === '--memory-url') args.memoryUrl = argv[++i]
    else if (arg === '--json') args.json = true
    else if (arg === '--no-write') args.write = false
    else if (arg === '--no-hash') args.noHash = true
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/upstream-sync/compat.mjs [--project-root dir] [--reports-dir dir] [--runs n] [--skip-preflight] [--preflight-evidence file] [--voice-worker path] [--voice-timeout-ms n] [--memory-url url] [--json] [--no-write] [--no-hash]')
      process.exit(CODES.PASS)
    } else {
      console.error(`unknown argument: ${arg}`)
      process.exit(2)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const projectRoot = resolveProjectRoot(args.projectRoot)
const reportsDir = args.reportsDir ?? join(projectRoot, 'docs/reports')
const rawDir = join(reportsDir, 'raw')
const manifestPath = defaultManifestPath(projectRoot)
const voiceWorkerCandidate = args.voiceWorker ?? join(projectRoot, 'm5/voice-spike/dist/voice-worker/VoiceWorker/VoiceWorker')
const voiceWorker = existsSync(voiceWorkerCandidate) && statSync(voiceWorkerCandidate).isDirectory() ? join(voiceWorkerCandidate, 'VoiceWorker') : voiceWorkerCandidate
const suiteStarted = Date.now()
const suiteStartedAt = new Date().toISOString()
const privateMtimeBefore = existsSync(PRIVATE_DSH_HOME) ? statSync(PRIVATE_DSH_HOME).mtimeMs : null
const result = { schema: 'whalegirl.compat/1', startedAt: suiteStartedAt, projectRoot, manifestPath, reportsDir, gates: [] }
const cleanup = []
const sleepUntil = async (predicate, timeoutMs, intervalMs = 200) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(intervalMs)
  }
  return false
}

function gate(name, status, detail, extra = {}) {
  result.gates.push({ name, status, detail, durationMs: extra.durationMs ?? null, evidence: extra.evidence ?? null })
  console.log(`${status === 'PASS' ? 'PASS' : status} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
}

async function fetchJson(url, init = {}, timeoutMs = 15_000) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, json, text }
}

async function freePort() {
  const server = createServer()
  await new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok) })
  const { port } = server.address()
  await new Promise((ok) => server.close(ok))
  return port
}

async function portClosed(port) {
  return new Promise((ok) => {
    const socket = connect({ host: '127.0.0.1', port })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); ok(false) })
    socket.once('error', () => ok(true))
    socket.once('timeout', () => { socket.destroy(); ok(true) })
  })
}

function classifyPreflightStatus(exitCode) {
  if (exitCode === 0) return 'PASS'
  if (exitCode === 2) return 'PRODUCT_FAIL'
  if (exitCode === 4) return 'ENV_FAIL'
  return 'COMPAT_FAIL'
}

// ---- gate 1: manifest contract -------------------------------------------------
try {
  const startedMs = Date.now()
  if (!existsSync(manifestPath)) {
    gate('manifest', 'ENV_FAIL', `versions.json missing at ${manifestPath}`, { durationMs: Date.now() - startedMs })
  } else {
    const loaded = loadManifest(manifestPath)
    const validation = validateManifest(loaded.manifest, { manifestPath, projectRoot, checkArtifactHash: !args.noHash })
    const detail = {
      productVersion: loaded.manifest.product?.version ?? null,
      runtimeVersion: loaded.manifest.runtime?.dsh?.version ?? null,
      runtimeTag: loaded.manifest.runtime?.dsh?.upstreamTag ?? null,
      errors: validation.errors,
      warnings: validation.warnings,
    }
    gate('manifest', validation.ok ? 'PASS' : 'PRODUCT_FAIL', detail, { durationMs: Date.now() - startedMs })
  }
} catch (error) {
  gate('manifest', 'ENV_FAIL', String(error?.message || error), { durationMs: null })
}

// ---- gate 2: host preflight ----------------------------------------------------
try {
  const startedMs = Date.now()
  if (args.skipPreflight) {
    gate('preflight', 'SKIP', 'skipped by --skip-preflight', { durationMs: 0 })
  } else if (args.preflightEvidence) {
    if (!existsSync(args.preflightEvidence)) {
      gate('preflight', 'ENV_FAIL', `recorded evidence not found: ${args.preflightEvidence}`, { durationMs: 0 })
    } else {
      const recorded = JSON.parse(readFileSync(args.preflightEvidence, 'utf8'))
      const exitCode = Number(recorded.exitCode ?? (recorded.ok ? 0 : 3))
      gate('preflight', classifyPreflightStatus(exitCode), {
        mode: 'recorded',
        exitCode,
        recordedAt: recorded.startedAt ?? null,
        evidenceFile: args.preflightEvidence,
        productFailures: recorded.productFailures ?? [],
        preflightFailures: recorded.preflightFailures ?? [],
        envFailures: recorded.envFailures ?? [],
      }, { durationMs: 0, evidence: args.preflightEvidence })
    }
  } else {
    const script = join(projectRoot, 'm4/preflight.mjs')
    if (!existsSync(script)) {
      gate('preflight', 'ENV_FAIL', `preflight script missing: ${script}`, { durationMs: 0 })
    } else {
      let exitCode = 0
      let stdout = ''
      let stderr = ''
      // use m4/preflight evidence dir (owned by the gate); mkdir happens in that script
      if (existsSync(rawDir) === false) mkdirSync(rawDir, { recursive: true })
      const logFile = join(rawDir, `compat-${suiteStartedAt.replaceAll(':', '-')}-preflight.log`)
      try {
        stdout = execFileSync(process.execPath, [script, `--runs=${args.runs}`], {
          cwd: projectRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
          timeout: Math.max(600_000, args.runs * 300_000),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        exitCode = typeof error?.status === 'number' ? error.status : 3
        stdout = String(error?.stdout ?? '')
        stderr = String(error?.stderr ?? '')
      }
      writeFileSync(logFile, `exitCode=${exitCode}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`)
      let evidenceFile = null
      const lastJson = stdout.trim().split('\n').filter((line) => line.startsWith('{')).pop()
      if (lastJson) {
        try { evidenceFile = JSON.parse(lastJson).evidenceFile ?? null } catch { evidenceFile = null }
      }
      if (evidenceFile === null || !existsSync(evidenceFile)) {
        const evidenceRoot = join(projectRoot, 'm4/evidence')
        if (existsSync(evidenceRoot)) {
          const candidates = readdirSync(evidenceRoot).filter((name) => name.startsWith('PREFLIGHT-')).sort()
          evidenceFile = candidates.length > 0 ? join(evidenceRoot, candidates[candidates.length - 1]) : null
        }
      }
      gate('preflight', classifyPreflightStatus(exitCode), {
        mode: 'live',
        exitCode,
        runs: args.runs,
        evidenceFile,
        logFile,
        stdoutTail: stdout.split('\n').slice(-12),
      }, { durationMs: Date.now() - startedMs, evidence: logFile })
    }
  }
} catch (error) {
  gate('preflight', 'ENV_FAIL', String(error?.message || error), { durationMs: null })
}

// ---- gate 3: voice worker health ----------------------------------------------
async function voiceGate() {
  const startedMs = Date.now()
  if (!existsSync(voiceWorker)) {
    gate('voice-worker', 'ENV_FAIL', `VoiceWorker binary missing: ${voiceWorker}`, { durationMs: 0 })
    return
  }
  const root = mkdtempSync('/tmp/wg-compat-voice-')
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const logFile = join(rawDir, `compat-${suiteStartedAt.replaceAll(':', '-')}-voice.log`)
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true })
  const port = await freePort()
  const token = `compat-${randomUUID().slice(0, 12)}`
  const child = spawn(voiceWorker, [], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: home,
      TMPDIR: root,
      NISSE_VOICE_WORKER_PORT: String(port),
      PORT: String(port),
      G1_MODE: 'echo',
      SPIKE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.on('error', (error) => { chunks.push(`spawn error: ${error?.message || error}`) })
  cleanup.push({ child, root, label: 'voice-worker' })
  const chunks = []
  child.stdout.on('data', (data) => chunks.push(String(data)))
  child.stderr.on('data', (data) => chunks.push(String(data)))
  let health = null
  const ok = await sleepUntil(async () => {
    const response = await fetchJson(`http://127.0.0.1:${port}/health`, {}, 5000).catch(() => null)
    if (response?.status === 200 && response.json) { health = response.json; return true }
    return false
  }, args.voiceTimeoutMs, 250)
  const startupMs = Date.now() - startedMs
  const payload = health
    ? {
        service: health.service,
        mode: health.mode,
        pipecat: health.pipecat,
        ok: health.ok,
      }
    : null
  const healthy = ok && payload?.ok !== false
  if (!healthy) {
    writeFileSync(logFile, chunks.join(''))
    gate('voice-worker', child.exitCode === null ? 'COMPAT_FAIL' : 'ENV_FAIL', {
      error: `voice worker /health not ready within ${args.voiceTimeoutMs}ms (pid=${child.pid}, port=${port})`,
      logFile,
    }, { durationMs: startupMs, evidence: logFile })
    return
  }
  const killSentAt = Date.now()
  child.kill('SIGTERM')
  const exitedGracefully = await sleepUntil(async () => child.exitCode !== null, 10_000, 100)
  // A PyInstaller onedir bootloader can outlive its uvicorn child; what the
  // product contract needs is that the worker stops serving (port closed).
  const closed = await portClosed(port)
  if (!exitedGracefully) child.kill('SIGKILL')
  writeFileSync(logFile, chunks.join(''))
  gate('voice-worker', closed ? 'PASS' : 'COMPAT_FAIL', {
    port,
    startupMs,
    health: payload,
    shutdownMs: Date.now() - killSentAt,
    processExitedGracefully: exitedGracefully,
    note: exitedGracefully || !closed ? undefined : 'bootloader lingered after SIGTERM; port closed and SIGKILL was sent',
    logFile,
  }, { durationMs: Date.now() - startedMs, evidence: logFile })
}
await voiceGate()

// ---- gate 4: memory sidecar health (optional, owned by the memory stream) ------
if (args.memoryUrl) {
  const startedMs = Date.now()
  const base = String(args.memoryUrl).replace(/\/+$/, '')
  const response = await fetchJson(`${base}/health`, {}, 30_000).catch(() => null)
  if (response?.status === 200 && response.json) {
    gate('memory-sidecar', 'PASS', { url: `${base}/health`, health: response.json }, { durationMs: Date.now() - startedMs })
  } else {
    gate('memory-sidecar', 'COMPAT_FAIL', { url: `${base}/health`, status: response?.status ?? null, body: response?.text?.slice(0, 300) ?? null }, { durationMs: Date.now() - startedMs })
  }
} else {
  gate('memory-sidecar', 'SKIP', 'no --memory-url supplied; memory sidecar startup is owned by the memory stream', { durationMs: 0 })
}

// ---- finalize ------------------------------------------------------------------
for (const entry of cleanup) {
  const { child, root, label } = entry
  if (child && child.exitCode === null) child.kill('SIGKILL')
  if (label === 'voice-worker') {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* keep for debugging */ }
  }
}
const privateMtimeAfter = existsSync(PRIVATE_DSH_HOME) ? statSync(PRIVATE_DSH_HOME).mtimeMs : null
const privateTouched = privateMtimeBefore !== privateMtimeAfter
if (privateTouched) gate('private-home-untouched', 'FAIL', 'private DSH home mtime changed', { durationMs: 0 })
else gate('private-home-untouched', 'PASS', 'private DSH home mtime unchanged', { durationMs: 0 })

const statuses = result.gates.map((entry) => entry.status)
const failed = (value) => statuses.includes(value)
result.exitCode = failed('ENV_FAIL')
  ? CODES.ENV_FAIL
  : failed('PRODUCT_FAIL')
    ? CODES.PRODUCT_FAIL
    : failed('COMPAT_FAIL') || failed('FAIL')
      ? CODES.COMPAT_FAIL
      : CODES.PASS
result.ok = result.exitCode === CODES.PASS
result.finishedAt = new Date().toISOString()
result.durationMs = Date.now() - suiteStarted

if (args.write) {
  mkdirSync(reportsDir, { recursive: true })
  const payload = JSON.stringify(result, null, 2) + '\n'
  const stamp = result.startedAt.replaceAll(':', '-')
  writeFileSync(join(reportsDir, `compat-${stamp}.json`), payload)
  writeFileSync(join(reportsDir, 'compat-latest.json'), payload)
  console.log(`evidence: ${join(reportsDir, 'compat-latest.json')}`)
}
for (const entry of result.gates) {
  console.log(`${entry.status === 'PASS' ? 'PASS' : entry.status} ${entry.name}${entry.durationMs === null ? '' : ` (${Math.round(entry.durationMs / 100) / 10}s)`}`)
}
console.log(`RESULT ${result.ok ? 'PASS' : 'FAIL'} exitCode=${result.exitCode} (${result.gates.length} gates)`)
if (args.json) console.log(JSON.stringify(result, null, 2))
process.exit(result.exitCode)
