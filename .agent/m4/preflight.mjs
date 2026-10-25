// Deterministic preflight for the Bot host integration (Phase 0 gate).
//
// Reproduces the M4 setup-host race deterministically: it fires concurrent
// /sessions/create requests as soon as the bridge descriptor appears (before the
// startup agent exists), then requires a single ready agent, one plugin load and
// no ownership/lifecycle errors. Isolated HOME/DSH_HOME/ports under /tmp; the
// user's main ~/.dsh is never opened.
//
// Exit codes: 0 = PASS, 2 = PRODUCT_FAIL, 3 = PREFLIGHT_FAIL, 4 = ENV_FAIL.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'

const FORK = '$HOME/projects/dsh-bot'
const EVIDENCE = '$HOME/projects/dsh-bot-workspace/m4/evidence'
const MAIN_DSH = '$HOME/.dsh'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const startedAt = new Date().toISOString()
const runs = Number(process.argv.find((a) => a.startsWith('--runs='))?.slice(7) ?? 1) || 1
const result = { suite: 'whalegirl preflight', startedAt, runs: [], ok: false }

/** Product bugs observed directly, not by log-message heuristics alone. */
const productFailures = []
const preflightFailures = []
const envFailures = []

function classify() {
  if (productFailures.length > 0) return 2
  if (preflightFailures.length > 0) return 3
  if (envFailures.length > 0) return 4
  return 0
}

async function fetchJson(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(180_000) })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON body */ }
  return { status: response.status, json, text }
}

async function oneRun(index) {
  const root = `/tmp/whalegirl-preflight-${Date.now()}-${index}-${randomUUID().slice(0, 8)}`
  const dshHome = join(root, 'dsh-home')
  const home = join(root, 'home')
  mkdirSync(dshHome, { recursive: true, mode: 0o700 })
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const logFile = join(root, 'host.log')
  const report = { index, root, steps: [], ok: false }

  const step = (name, status, detail) => {
    report.steps.push({ name, status, detail })
    console.log(`${status === 'PASS' ? 'PASS' : status} ${name}${detail === undefined ? '' : ' ' + JSON.stringify(detail)}`)
  }

  let host = null
  try {
    // 1. Install an isolated profile (writes only under root).
    try {
      execFileSync(join(FORK, 'nisse/scripts/install-profile.sh'), [dshHome, 'nisse-smoke', 'true'], { stdio: 'pipe' })
      step('install-profile', 'PASS', { profile: join(dshHome, 'profiles', 'nisse-smoke') })
    } catch (error) {
      envFailures.push(`run${index}: install-profile failed: ${error?.message || error}`)
      step('install-profile', 'ENV_FAIL', { error: String(error?.message || error) })
      throw error
    }

    // 2. Start the isolated DSH host.
    host = new DshHostSupervisor({ forkDir: FORK, profile: 'nisse-smoke', dshHome, homeDir: home, logFile, startupTimeoutMs: 120_000 })
    try {
      const started = await host.start()
      step('host-start', 'PASS', { pid: started.pid, port: started.port })
    } catch (error) {
      envFailures.push(`run${index}: host start failed: ${error?.message || error}`)
      step('host-start', 'ENV_FAIL', { error: String(error?.message || error) })
      throw error
    }

    // 3. Wait for the bridge descriptor, then deliberately race /sessions/create
    //    before the startup agent exists. This used to fail with
    //    SessionAlreadyOwnedError when ensureAgent had no single-flight guard.
    let descriptor = null
    try {
      const deadline = Date.now() + 90_000
      while (Date.now() < deadline) {
        const file = join(dshHome, 'nisse', 'host-integration.json')
        if (existsSync(file)) {
          descriptor = JSON.parse(readFileSync(file, 'utf8'))
          break
        }
        await sleep(100)
      }
      if (descriptor === null) throw new Error('bridge descriptor never appeared')
      step('descriptor', 'PASS', { port: descriptor.port, tokenPresent: Boolean(descriptor.token) })
    } catch (error) {
      preflightFailures.push(`run${index}: ${error?.message || error}`)
      step('descriptor', 'PREFLIGHT_FAIL', { error: String(error?.message || error) })
      throw error
    }

    const api = (path, init) => fetchJson(`http://127.0.0.1:${descriptor.port}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json', ...(init?.headers || {}) },
    })

    let createdAtOnce = null
    try {
      const responses = await Promise.all(Array.from({ length: 4 }, () => api('/sessions/create', { method: 'POST', body: '{}' })))
      const statuses = responses.map((r) => r.status)
      const sessionIds = [...new Set(responses.map((r) => r.json?.sessionId).filter(Boolean))]
      const structuredErrors = responses.filter((r) => r.status >= 400).map((r) => ({ status: r.status, error: r.json?.error || r.text.slice(0, 120) }))
      createdAtOnce = { statuses, sessionIds, structuredErrors }
      const allOk = statuses.every((s) => s === 200)
      if (!allOk || sessionIds.length !== 1) {
        productFailures.push(`run${index}: concurrent /sessions/create did not converge: ${JSON.stringify(createdAtOnce)}`)
        step('concurrent-sessions-create', 'PRODUCT_FAIL', createdAtOnce)
      } else {
        step('concurrent-sessions-create', 'PASS', createdAtOnce)
      }
    } catch (error) {
      preflightFailures.push(`run${index}: concurrent create request failed: ${error?.message || error}`)
      step('concurrent-sessions-create', 'PREFLIGHT_FAIL', { error: String(error?.message || error) })
    }

    // 4. The agent must eventually report ready, with no startup error.
    let health = null
    try {
      const deadline = Date.now() + 150_000
      while (Date.now() < deadline) {
        const response = await api('/health', { method: 'GET' })
        if (response.status === 200 && response.json?.agent?.ready === true) { health = response.json; break }
        await sleep(250)
      }
      if (health === null) throw new Error('agent never became ready')
      step('agent-ready', 'PASS', { sessionId: health.agent.sessionId, created: health.agent.created })
    } catch (error) {
      const detail = { error: String(error?.message || error) }
      // A startup error recorded by the plugin is a product defect, not a harness bug.
      try {
        const response = await api('/health', { method: 'GET' })
        detail.health = response.json?.agent ?? response.text.slice(0, 300)
        if (response.json?.agent?.lastStartupError) productFailures.push(`run${index}: startup error: ${response.json.agent.lastStartupError}`)
      } catch { /* keep the timeout detail */ }
      productFailures.push(`run${index}: agent never ready: ${JSON.stringify(detail)}`)
      step('agent-ready', 'PRODUCT_FAIL', detail)
    }
  } catch {
    // classification already recorded for the failed step
  } finally {
    if (host !== null) {
      try { await host.stop() } catch (error) { preflightFailures.push(`run${index}: stop failed: ${error?.message || error}`) }
    }
  }

  // 5. Post-stop assertions: descriptor removed, and the host log shows one plugin
  //    load, one bridge listener, no ownership/inactive-context errors.
  try {
    const descriptorGone = !existsSync(join(dshHome, 'nisse', 'host-integration.json'))
    if (!descriptorGone) preflightFailures.push(`run${index}: descriptor survived stop`)
    step('descriptor-removed', descriptorGone ? 'PASS' : 'PREFLIGHT_FAIL', { descriptorGone })
  } catch (error) {
    preflightFailures.push(`run${index}: descriptor removal check failed: ${error?.message || error}`)
  }

  try {
    const log = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const counts = {
      moduleLoaded: (log.match(/\[nisse-host-integration\] module loaded/g) || []).length,
      bridgeListening: (log.match(/\[nisse-host-integration\] bridge listening/g) || []).length,
      fixtureDisposed: (log.match(/\[nisse-host-integration\] fixture disposed/g) || []).length,
      alreadyOwned: (log.match(/already owned by an active write handle/g) || []).length,
      inactiveContext: (log.match(/inactive context/g) || []).length,
    }
    report.logCounts = counts
    if (counts.moduleLoaded !== 1 || counts.bridgeListening !== 1) {
      productFailures.push(`run${index}: plugin loaded ${counts.moduleLoaded} times, bridge listened ${counts.bridgeListening} times`)
    }
    if (counts.alreadyOwned > 0) productFailures.push(`run${index}: ownership error appeared ${counts.alreadyOwned} times`)
    if (counts.inactiveContext > 0) productFailures.push(`run${index}: inactive context error appeared ${counts.inactiveContext} times`)
    step('log-assertions', productFailures.length === 0 ? 'PASS' : 'PRODUCT_FAIL', counts)
  } catch (error) {
    preflightFailures.push(`run${index}: log assertions failed: ${error?.message || error}`)
  }

  report.ok = report.steps.every((s) => s.status === 'PASS')
  return report
}

// Metadata-only check that the main DSH home was not touched (no file contents read).
const mainDshMtimeBefore = existsSync(MAIN_DSH) ? statSync(MAIN_DSH).mtimeMs : null
const mainDshChildrenBefore = existsSync(MAIN_DSH) ? statSync(MAIN_DSH).mtimeMs : null

for (let index = 1; index <= runs; index += 1) {
  console.log(`--- preflight run ${index}/${runs}`)
  result.runs.push(await oneRun(index))
}

const mainDshMtimeAfter = existsSync(MAIN_DSH) ? statSync(MAIN_DSH).mtimeMs : null
if (mainDshMtimeAfter !== mainDshMtimeBefore || mainDshMtimeAfter !== mainDshChildrenBefore) {
  envFailures.push('main DSH home mtime changed during preflight')
}

result.mainDshTouched = mainDshMtimeAfter !== mainDshMtimeBefore
result.productFailures = productFailures
result.preflightFailures = preflightFailures
result.envFailures = envFailures
result.finishedAt = new Date().toISOString()
result.exitCode = classify()
result.ok = result.exitCode === 0

mkdirSync(EVIDENCE, { recursive: true })
const evidenceFile = join(EVIDENCE, `PREFLIGHT-${startedAt.replaceAll(':', '-')}.json`)
writeFileSync(evidenceFile, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ok: result.ok, exitCode: result.exitCode, evidenceFile, productFailures, preflightFailures, envFailures }, null, 2))
process.exit(result.exitCode)
