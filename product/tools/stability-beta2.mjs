#!/usr/bin/env node
/**
 * beta2 three-round stability acceptance on the SAME DMG (plan §10.1 Phase 6,
 * §11.1 B2-G18, §12.6).
 *
 * Rules implemented here:
 *  - the same artifact SHA-256 is re-verified at the start of every round;
 *  - every round gets its own isolated user-data-dir, DSH_HOME, logs and marker
 *    files; nothing from a previous round is reused as evidence;
 *  - every LaunchServices launch attempt is recorded, including failed retries:
 *    a round only passes when the FIRST attempt succeeded (a retry can never
 *    mask a first-attempt failure), and any retry is reported;
 *  - each round keeps its own Memory persistence restart check (write -> quit ->
 *    restart -> semantic recall) instead of inheriting another round's PASS;
 *  - per-round process tree before/after, bridge/memory descriptor creation and
 *    cleanup, hostEpoch change and port release are recorded;
 *  - summary JSON + summary Markdown are written; exit code is non-zero if any
 *    round failed.
 *
 * usage:
 *   node product/tools/stability-beta2.mjs \
 *     --dmg /abs/path/candidate.dmg --manifest .mvv-build/evidence/macos-build.json \
 *     --run .agent/evidence/beta2/<run>/native/stability [--rounds 3] [--app <installed app>]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Run, classifyWindows, firstAttemptSuccess, processTreeFor, sha256File, triggerGreeting, waitForBubble, writeJson,
} from './accept-native-beta2.mjs'
import { waitAgentReady } from './wait-agent-ready.mjs'
import { waitMemoryReady } from './wait-memory-ready.mjs'
import { displays, screenshot, toolchain, windows } from './native-inspect.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const nowIso = () => new Date().toISOString()

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    out[key] = next && !next.startsWith('--') ? (i++, next) : true
  }
  return out
}

async function sha256FileAsync(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function runNode(script, args, logPath) {
  const result = spawnSync('node', [join(ROOT, 'product/tools', script), ...args], { encoding: 'utf8', timeout: 180000 })
  writeFileSync(logPath, `exit=${result.status}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}\n`)
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', log: logPath }
}

function listenersForPort(port) {
  const result = spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  return String(result.stdout || '').trim()
}

async function installAppFromDmg(dmgPath, runRoot) {
  const mount = join(runRoot, 'mount')
  const appDir = join(runRoot, 'app')
  mkdirSync(mount, { recursive: true })
  mkdirSync(appDir, { recursive: true })
  const attach = spawnSync('/usr/bin/hdiutil', ['attach', dmgPath, '-readonly', '-nobrowse', '-mountpoint', mount], { encoding: 'utf8' })
  if (attach.status !== 0) throw new Error(`hdiutil attach failed: ${String(attach.stderr).slice(0, 400)}`)
  try {
    const find = spawnSync('/usr/bin/find', [mount, '-maxdepth', '1', '-name', '*.app', '-print', '-quit'], { encoding: 'utf8' })
    const source = String(find.stdout || '').trim()
    if (!source) throw new Error('no .app inside DMG')
    const dest = join(appDir, 'dsh-bot.app')
    rmSync(dest, { recursive: true, force: true })
    const ditto = spawnSync('/usr/bin/ditto', [source, dest], { encoding: 'utf8' })
    if (ditto.status !== 0) throw new Error(`ditto failed: ${String(ditto.stderr).slice(0, 400)}`)
    return dest
  } finally {
    spawnSync('/usr/bin/hdiutil', ['detach', mount], { encoding: 'utf8' })
  }
}

async function roundRun(session, { restartMemoryCheck }) {
  const round = {
    round: session.round, startedAt: nowIso(),
    userDataDir: session.userData, dshHome: session.dshHome,
    attempts: [], firstLaunchAttemptSuccess: false,
    bridge: {}, memory: {}, processTree: {}, checks: {}, timings: {},
  }
  const bridgePath = session.bridgePath()
  const memoryPath = session.memoryRuntimePath()
  round.checks.descriptorsAbsentBeforeLaunch = !existsSync(bridgePath) && !existsSync(memoryPath)
  round.processTree.before = processTreeFor(session.userData)
  const launchStartedAt = Date.now()
  const first = await session.launch(1)
  round.timings.launchMs = Date.now() - launchStartedAt
  round.attempts.push(first)
  round.firstLaunchAttemptSuccess = first.success
  round.checks.firstAttemptSucceeded = first.success === true
  if (!first.success) {
    // Record a diagnostic retry so the failure is not hidden; a retry can never make the round pass.
    const retry = await session.launch(2)
    round.attempts.push(retry)
    round.checks.retryUsed = true
    round.checks.retrySucceeded = retry.success === true
    round.failure = `first launch attempt failed: ${first.reason}`
    return round
  }
  round.bridge.descriptorWritten = existsSync(bridgePath)
  round.memory.descriptorWritten = existsSync(memoryPath)
  try {
    const bridge = await waitAgentReady(bridgePath, { timeoutMs: 120000 })
    const memory = await waitMemoryReady(memoryPath, { timeoutMs: 300000 })
    round.checks.agentReady = true
    round.checks.memoryReady = true
    round.bridge.pid = bridge.health.pid
    round.bridge.sessionId = bridge.health.agent?.sessionId ?? null
    round.memory.bank = memory.bank ?? null
    const bridgeJson = JSON.parse(readFileSync(bridgePath, 'utf8'))
    round.bridge.port = bridgeJson.port
    round.processTree.afterReady = processTreeFor(session.userData)
    const snapshot = await session.apiFetch('/v2/snapshot')
    round.checks.v2SnapshotStatus = snapshot.status
    round.hostEpoch = snapshot.json?.hostEpoch ?? null
    round.checks.v2SnapshotAvailable = snapshot.status === 200 && Boolean(snapshot.json?.protocolVersion)
    const snap = snapshot.json
    round.snapshotSummary = snap ? {
      protocolVersion: snap.protocolVersion, schema: snap.schema, snapshotSeq: snap.snapshotSeq,
      productVersion: snap.identity?.productVersion, execution: snap.execution?.state,
      worker: snap.connection?.worker?.state, desktopConnected: snap.connection?.desktop?.connected,
      bubbleVisible: snap.presentation?.bubble?.visible ?? null,
    } : null
    // Native bubble first show in this round.
    const pid = first.appPid
    const before = classifyWindows(windows({ pid }).windows)
    const trigger = await triggerGreeting(session)
    const bubble = await waitForBubble(session, pid, { timeoutMs: 30000, afterWindowNumbers: before.visible.map(w => w.windowNumber) })
    const shot = bubble.found ? screenshot(join(session.evidenceDir, 'round-bubble.png'), { windowId: bubble.classified.bubble.windowNumber }) : { ok: false }
    round.bubble = {
      found: bubble.found, trigger,
      window: bubble.classified?.bubble ?? null, page: bubble.page ?? null,
      waitedMs: bubble.waitedMs ?? null, screenshot: shot,
    }
    round.checks.bubbleNativeVisible = bubble.found && shot.ok
    round.checks.bubbleAbovePet = bubble.found && bubble.classified?.pet ? bubble.classified.bubble.layer >= bubble.classified.pet.layer : null
    // Per-round Memory persistence check: write marker into this round's isolated bank.
    const markerPath = join(session.runDir, 'memory-marker.json')
    if (restartMemoryCheck) {
      const write = runNode('memory-acceptance.mjs', [memoryPath, markerPath, 'write', bridgePath], join(session.logsDir, 'memory-write.log'))
      round.memory.write = { status: write.status, log: write.log }
      round.checks.memoryWrite = write.status === 0
    }
  } catch (error) {
    round.failure = `readiness/native checks failed: ${error.message}`
    round.checks.error = error.message
  }
  // Shutdown + cleanup.
  const shutdown = await session.stop({ label: 'round-first' })
  round.shutdownFirst = shutdown
  round.processTree.afterFirstExit = processTreeFor(session.userData)
  round.bridge.cleanedAfterExit = !existsSync(bridgePath)
  round.memory.cleanedAfterExit = !existsSync(memoryPath)
  round.checks.descriptorsCleaned = round.bridge.cleanedAfterExit && round.memory.cleanedAfterExit
  round.checks.noResidualProcesses = round.processTree.afterFirstExit.length === 0
  round.checks.portReleased = round.bridge.port ? listenersForPort(round.bridge.port) === '' : null
  round.checks.cleanShutdown = shutdown.exited === true
  // Restart within the same round (memory persistence + hostEpoch change).
  if (restartMemoryCheck && round.checks.memoryWrite) {
    const restart = await session.launch(2)
    round.restartAttempt = restart
    if (restart.success) {
      try {
        await waitAgentReady(bridgePath, { timeoutMs: 120000 })
        await waitMemoryReady(memoryPath, { timeoutMs: 300000 })
        round.checks.restartReady = true
        const snapshot = await session.apiFetch('/v2/snapshot')
        round.hostEpochAfterRestart = snapshot.json?.hostEpoch ?? null
        round.checks.hostEpochChanged = Boolean(round.hostEpoch && round.hostEpochAfterRestart && round.hostEpoch !== round.hostEpochAfterRestart)
        round.checks.noAutoSubmittedWork = (snapshot.json?.queue?.items?.length ?? 0) === 0 && !snapshot.json?.inputDraft
        const verify = runNode('memory-acceptance.mjs', [memoryPath, join(session.runDir, 'memory-marker.json'), 'verify'], join(session.logsDir, 'memory-recall.log'))
        round.memory.recall = { status: verify.status, log: verify.log }
        round.checks.memoryRecallAfterRestart = verify.status === 0
      } catch (error) {
        round.checks.restartError = error.message
      }
      const shutdown2 = await session.stop({ label: 'round-restart' })
      round.shutdownRestart = shutdown2
      round.processTree.afterRestartExit = processTreeFor(session.userData)
      round.checks.restartCleanShutdown = shutdown2.exited === true
      round.checks.descriptorsCleanedAfterRestart = !existsSync(bridgePath) && !existsSync(memoryPath)
      round.checks.noResidualAfterRestart = processTreeFor(session.userData).length === 0
    } else {
      round.failure = `restart launch failed: ${restart.reason}`
    }
  }
  const required = [
    'firstAttemptSucceeded', 'agentReady', 'memoryReady', 'bubbleNativeVisible', 'descriptorsCleaned',
    'noResidualProcesses', 'cleanShutdown',
  ]
  if (restartMemoryCheck) required.push('restartReady', 'hostEpochChanged', 'memoryRecallAfterRestart', 'restartCleanShutdown', 'descriptorsCleanedAfterRestart', 'noResidualAfterRestart')
  round.checks.allRequiredPass = !round.failure && required.every(key => round.checks[key] === true)
  round.status = round.checks.allRequiredPass ? 'PASS' : 'FAIL'
  round.finishedAt = nowIso()
  return round
}

export async function stabilityBeta2({ dmg, manifest: manifestPath, run: runRoot, rounds = 3, app: appOverride }) {
  if (process.platform !== 'darwin') throw new Error('BLOCKED-ENVIRONMENT: stability acceptance requires macOS')
  runRoot = resolve(runRoot)
  mkdirSync(runRoot, { recursive: true })
  const summary = {
    schemaVersion: 1, kind: 'beta2-stability-3-rounds', startedAt: nowIso(),
    dmg: resolve(dmg), manifestPath: resolve(manifestPath), rounds: [], checks: {}, platform: { os: process.platform, arch: process.arch, node: process.version },
    toolchain: toolchain(), displays: displays(),
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  summary.manifest = manifest
  summary.sourceCommit = manifest.sourceCommit
  summary.chart = { dmgSha256: null, sameShaEveryRound: null }
  const actualSha = await sha256FileAsync(summary.dmg)
  summary.chart.dmgSha256 = actualSha
  summary.checks.dmgMatchesManifest = actualSha === manifest.artifact?.sha256
  summary.checks.manifestPathMatchesDmg = resolve(manifest.artifact?.path || '') === summary.dmg
  if (!summary.checks.dmgMatchesManifest) {
    summary.overall = { status: 'FAIL', reason: `DMG sha256 ${actualSha} != manifest ${manifest.artifact?.sha256}` }
    finalize(summary, runRoot)
    return summary
  }
  const warnings = []
  const preexisting = spawnSync('/usr/sbin/lsof', ['-nP', '-iTCP:59100', '-sTCP:LISTEN'], { encoding: 'utf8' })
  summary.checks.port59100RefusalPrecondition = String(preexisting.stdout || '').trim() || 'free'
  if (String(preexisting.stdout || '').trim()) warnings.push('127.0.0.1:59100 is still held by another process; base accept-macos.sh refuses in that state. Stability runner uses random bridge ports so it proceeds, but the documented precondition stands.')
  summary.warnings = warnings
  let appPath = appOverride ? resolve(appOverride) : null
  if (!appPath) appPath = await installAppFromDmg(summary.dmg, runRoot)
  summary.appPath = appPath
  summary.appAsarSha256 = sha256File(join(appPath, 'Contents/Resources/app.asar'))
  const ourUserDataMarker = join(runRoot, 'round-')
  const stray = String(spawnSync('/bin/ps', ['-axo', 'command='], { encoding: 'utf8' }).stdout || '').split('\n').filter(line => line.includes(ourUserDataMarker))
  if (stray.length) warnings.push(`stray processes with this run's user-data dir exist before round 1: ${stray.length}`)
  summary.checks.noStrayProcessesBeforeStart = stray.length === 0
  for (let roundNumber = 1; roundNumber <= rounds; roundNumber++) {
    const roundDir = join(runRoot, `round-${roundNumber}`)
    rmSync(roundDir, { recursive: true, force: true })
    mkdirSync(roundDir, { recursive: true })
    const session = new Run(appPath, roundDir, {})
    session.round = roundNumber
    const roundSha = await sha256FileAsync(summary.dmg)
    const round = await roundRun(session, { restartMemoryCheck: true })
    round.dmgSha256AtRoundStart = roundSha
    round.checks.sameShaAsManifest = roundSha === manifest.artifact?.sha256
    round.checks.dmgUnchanged = roundSha === actualSha
    round.status = round.checks.allRequiredPass && round.checks.sameShaAsManifest ? 'PASS' : 'FAIL'
    writeJson(join(roundDir, 'round.json'), round)
    summary.rounds.push(round)
    console.log(`[stability] round ${roundNumber}: ${round.status} (first-attempt=${round.firstLaunchAttemptSuccess}, attempts=${round.attempts.length})`)
  }
  summary.checks.allRoundsFirstAttemptSuccess = summary.rounds.every(round => round.firstLaunchAttemptSuccess === true)
  summary.checks.allRoundsSameSha = summary.rounds.every(round => round.checks.dmgUnchanged === true)
  summary.checks.allRoundsPass = summary.rounds.every(round => round.status === 'PASS')
  summary.checks.noHiddenRetry = summary.rounds.every(round => (round.attempts || [])[0]?.success === true)
  summary.checks.recordedAttempts = summary.rounds.reduce((total, round) => total + (round.attempts || []).length, 0)
  summary.checks.failedLaunchAttempts = summary.rounds.reduce((total, round) => total + (round.attempts || []).filter(attempt => attempt.success === false).length, 0)
  summary.overall = {
    status: summary.checks.allRoundsPass && summary.checks.allRoundsFirstAttemptSuccess && summary.checks.allRoundsSameSha ? 'PASS' : 'FAIL',
    rounds: summary.rounds.length,
    firstAttemptSuccesses: summary.rounds.filter(round => round.firstLaunchAttemptSuccess).length,
    sameShaEveryRound: summary.checks.allRoundsSameSha,
  }
  finalize(summary, runRoot)
  return summary
}

function finalize(summary, runRoot) {
  summary.finishedAt = nowIso()
  writeJson(join(runRoot, 'summary.json'), summary)
  const lines = [
    '# beta2 three-round stability acceptance', '',
    `- DMG: \`${summary.dmg}\``,
    `- DMG sha256: \`${summary.chart.dmgSha256}\``,
    `- manifest sha256: \`${summary.manifest?.artifact?.sha256}\``,
    `- sourceCommit: \`${summary.sourceCommit}\``,
    `- app asar sha256: \`${summary.appAsarSha256}\``,
    `- rounds: ${summary.rounds.length}`,
    `- overall: **${summary.overall?.status}**`,
    `- all rounds first-attempt success: ${summary.checks.allRoundsFirstAttemptSuccess}`,
    `- same SHA every round: ${summary.checks.allRoundsSameSha}`, '',
    '| round | status | first attempt | attempts | launch ms | bubble native | memory recall after restart | clean shutdown | user-data |',
    '|---|---|---|---|---|---|---|---|---|',
    ...summary.rounds.map(round => `| ${round.round} | ${round.status} | ${round.firstLaunchAttemptSuccess} | ${round.attempts?.length ?? 0} | ${round.timings?.launchMs ?? ''} | ${round.checks?.bubbleNativeVisible ?? false} | ${round.checks?.memoryRecallAfterRestart ?? 'n/a'} | ${round.checks?.cleanShutdown ?? false} | \`${round.userDataDir}\` |`),
    '',
    ...(summary.rounds.some(round => round.failure) ? ['## Failures', '', ...summary.rounds.filter(round => round.failure).map(round => `- round ${round.round}: ${round.failure}`), ''] : []),
    ...(summary.warnings?.length ? ['## Warnings', '', ...summary.warnings.map(warning => `- ${warning}`), ''] : []),
    `Evidence root: \`${runRoot}\``,
  ]
  writeFileSync(join(runRoot, 'summary.md'), lines.join('\n') + '\n')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.dmg || !args.manifest || !args.run) {
    console.error('usage: node product/tools/stability-beta2.mjs --dmg <dmg> --manifest <macos-build.json> --run <dir> [--rounds 3] [--app <installed app>]')
    process.exit(2)
  }
  const summary = await stabilityBeta2({ dmg: args.dmg, manifest: args.manifest, run: args.run, rounds: Number(args.rounds || 3), app: args.app })
  console.log(JSON.stringify({ status: summary.overall?.status, rounds: summary.rounds.length, firstAttemptSuccesses: summary.overall?.firstAttemptSuccesses, run: args.run }, null, 2))
  process.exit(summary.overall?.status === 'PASS' ? 0 : 1)
}
