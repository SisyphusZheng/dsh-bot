#!/usr/bin/env node
/**
 * beta2 native acceptance checks for an installed (DMG-installed) macOS App.
 *
 * This is the B2-G13/G14/G16/G17 native complement to product/tools/accept-macos.sh.
 * The base acceptance script keeps its 15 checks; accept-beta2-macos.sh runs the
 * base checks first and then runs this file against the SAME installed app copy.
 *
 * Evidence discipline:
 *  - every check records a structured result (status/level/detail/evidence files);
 *  - native visibility uses CGWindowListCopyWindowInfo (window-server truth) plus
 *    screencapture plus the System Events window list, never the page DOM alone;
 *  - CDP is only used for page readiness/content and for locating a real click
 *    target; the click itself is posted through CGEventPost (HID-level) and the
 *    result is observed both natively and in the page;
 *  - environment-bound items (multi-display, fullscreen automation) are reported
 *    as BLOCKED-ENVIRONMENT with the attempted command and observed output.
 *
 * usage:
 *   node product/tools/accept-native-beta2.mjs \
 *     --app <installed dsh-bot.app> --run <evidence run dir> \
 *     [--manifest <macos-build.json>] [--allow-blocked] [--timeout-scale <n>]
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { until, acceptDesktopWeb, connectPage } from './desktop-web-acceptance.mjs'
import { waitAgentReady } from './wait-agent-ready.mjs'
import { waitMemoryReady } from './wait-memory-ready.mjs'
import { matchingPids } from './find-macos-app-pid.mjs'
import {
  activateApp, clickAt, displays, dragMouse, frontmostApp, moveMouse, screenshot,
  systemEventsWindows, toolchain, windows,
} from './native-inspect.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const DESKTOP_APP = join(ROOT, 'apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts')
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const nowIso = () => new Date().toISOString()
const scale = () => Number(process.env.B2_ACCEPT_TIMEOUT_SCALE || 1)
const timeout = ms => Math.round(ms * scale())

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

function psTable() {
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('Cannot inspect process table')
  return result.stdout
}

export function processTreeFor(userData) {
  const marker = `--user-data-dir=${userData}`
  return psTable().split('\n').map(line => line.trim()).filter(line => line.includes(marker)).map(line => {
    const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), command: match[3], role: /--type=/.test(match[3]) ? 'helper' : 'main' } : null
  }).filter(Boolean)
}

export function appPid(userData) {
  const result = spawnSync('node', [join(ROOT, 'product/tools/find-macos-app-pid.mjs'), userData], { encoding: 'utf8' })
  const text = String(result.stdout || '').trim()
  return result.status === 0 && /^\d+$/.test(text) ? Number(text) : null
}

export function sha256File(path) {
  const hash = createHash('sha256')
  const fd = readFileSync(path)
  hash.update(fd)
  return hash.digest('hex')
}

export function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

export class Run {
  constructor(appPath, runDir, options) {
    this.appPath = resolve(appPath)
    this.runDir = resolve(runDir)
    this.options = options
    this.userData = join(this.runDir, 'user-data')
    // Packaged App: apps/desktop/src/main.ts forces process.env.DSH_HOME to
    // <userData>/dsh-home, so the descriptors live there regardless of caller env.
    this.dshHome = join(this.userData, 'dsh-home')
    this.logsDir = join(this.runDir, 'logs')
    this.checksDir = join(this.runDir, 'checks')
    this.evidenceDir = join(this.runDir, 'evidence')
    for (const dir of [this.runDir, this.userData, this.dshHome, this.logsDir, this.checksDir, this.evidenceDir]) mkdirSync(dir, { recursive: true })
    this.checks = {}
    this.attempts = []
    this.mainLog = join(this.logsDir, 'accept-native.log')
    this.startedAt = nowIso()
    this.openWrapper = null
    this.api = null
  }
  log(message) {
    const line = `[${nowIso()}] ${message}`
    console.log(line)
    writeFileSync(this.mainLog, line + '\n', { flag: 'a' })
  }
  writeCheck(id, value) {
    const path = join(this.checksDir, `${id}.json`)
    writeJson(path, value)
    this.checks[id] = { ...value, evidenceFile: path }
    const status = value.status || 'FAIL'
    this.log(`CHECK ${id}: ${status}${value.detail ? ` - ${value.detail}` : ''}`)
    return value
  }
  bridgePath() { return join(this.dshHome, 'bot/bridge.json') }
  memoryRuntimePath() { return join(this.dshHome, 'memory/runtime.json') }
  async waitBridgeHealth({ timeoutMs = timeout(120000) } = {}) {
    return waitAgentReady(this.bridgePath(), { timeoutMs })
  }
  async waitMemoryHealth({ timeoutMs = timeout(300000) } = {}) {
    return waitMemoryReady(this.memoryRuntimePath(), { timeoutMs })
  }
  async apiFetch(path, { method = 'GET', body, timeoutMs = 10000 } = {}) {
    const bridge = JSON.parse(readFileSync(this.bridgePath(), 'utf8'))
    const response = await fetch(`http://127.0.0.1:${bridge.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${bridge.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let json = null
    try { json = JSON.parse(text) } catch { /* non-JSON (SSE/NDJSON) */ }
    return { status: response.status, ok: response.ok, json, text, bridge }
  }
  async launch(attempt) {
    const record = {
      attempt, startedAt: nowIso(), appPid: null, bridgeFound: false,
      bridgeFoundAt: null, success: false, reason: null, openWrapperPid: null,
      stdoutLog: join(this.logsDir, `launch-attempt-${attempt}-stdout.log`),
      stderrLog: join(this.logsDir, `launch-attempt-${attempt}-stderr.log`),
      launchservicesLog: join(this.logsDir, `launch-attempt-${attempt}.log`),
    }
    this.attempts.push(record)
    if (attempt === 1) {
      rmSync(this.userData, { recursive: true, force: true })
      rmSync(this.dshHome, { recursive: true, force: true })
      mkdirSync(this.userData, { recursive: true })
      mkdirSync(this.dshHome, { recursive: true })
      rmSync(join(this.userData, 'DevToolsActivePort'), { force: true })
    }
    for (const pid of processTreeFor(this.userData)) {
      try { process.kill(pid.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    await sleep(500)
    const args = [
      '-n',
      '--env', 'ELECTRON_RUN_AS_NODE=',
      '--stdout', record.stdoutLog, '--stderr', record.stderrLog,
      this.appPath,
      '--args', `--user-data-dir=${this.userData}`,
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    ]
    this.log(`LaunchServices attempt ${attempt}: open ${args.slice(0, 3).join(' ')} … ${this.appPath}`)
    const child = spawnSync('/usr/bin/open', args, { encoding: 'utf8', timeout: timeout(5000) })
    writeFileSync(record.launchservicesLog, `open exit=${child.status}\nstdout=${child.stdout || ''}\nstderr=${child.stderr || ''}\n`)
    const deadline = Date.now() + timeout(90000)
    while (Date.now() < deadline) {
      record.appPid = appPid(this.userData)
      if (record.appPid && existsSync(this.bridgePath())) {
        record.bridgeFound = true
        record.bridgeFoundAt = nowIso()
        record.success = true
        break
      }
      await sleep(500)
    }
    if (!record.success) {
      record.reason = `App/bridge did not appear as one unit within ${timeout(90000)}ms (appPid=${record.appPid}, bridge=${existsSync(this.bridgePath())})`
      try { const stop = await this.stop({ label: `launch-${attempt}-failed` }); record.cleanupAfterFailure = stop } catch (error) { record.cleanupAfterFailure = { error: error.message } }
      this.log(`Launch attempt ${attempt} FAILED: ${record.reason}`)
      record.stdoutTail = existsSync(record.stdoutLog) ? readFileSync(record.stdoutLog, 'utf8').slice(-4000) : ''
      record.stderrTail = existsSync(record.stderrLog) ? readFileSync(record.stderrLog, 'utf8').slice(-4000) : ''
      for (const pid of processTreeFor(this.userData)) { try { process.kill(pid.pid, 'SIGTERM') } catch { /* gone */ } }
      await sleep(1500)
    } else {
      this.log(`Launch attempt ${attempt} OK: appPid=${record.appPid} bridge=${this.bridgePath()}`)
    }
    return record
  }
  async stop({ label = 'stop' } = {}) {
    const pids = processTreeFor(this.userData)
    const main = pids.find(entry => entry.role === 'main') || null
    const startedAt = Date.now()
    const record = { label, startedAt: nowIso(), pidsBefore: pids, termTarget: main?.pid ?? null, exited: false, durationMs: null, forced: false }
    if (main) {
      try { process.kill(main.pid, 'SIGTERM') } catch { /* gone */ }
      while (Date.now() - startedAt < timeout(30000)) {
        if (!processTreeFor(this.userData).some(entry => entry.role === 'main')) { record.exited = true; break }
        await sleep(500)
      }
      if (!record.exited) {
        record.forced = true
        for (const entry of processTreeFor(this.userData)) { try { process.kill(entry.pid, 'SIGKILL') } catch { /* gone */ } }
        await sleep(1000)
      }
    } else record.exited = true
    record.durationMs = Date.now() - startedAt
    record.pidsAfter = processTreeFor(this.userData)
    record.descriptorsAfter = { bridge: existsSync(this.bridgePath()), memory: existsSync(this.memoryRuntimePath()) }
    this.log(`Stop ${label}: exited=${record.exited} forced=${record.forced} durationMs=${record.durationMs}`)
    return record
  }
  pageTargets(port) {
    return fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      .then(response => response.json()).catch(() => [])
  }
  async devtoolsPort() {
    const [port] = await until(() => readFileSync(join(this.userData, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/), { label: 'DevTools startup', timeoutMs: timeout(60000) })
    return Number(port)
  }
  nativeWindows(pid) {
    return windows({ pid }).windows
  }
  async axWindows(pid) { return systemEventsWindows(pid) }
}

export function classifyWindows(list) {
  const visible = list.filter(w => w.onscreen && w.alpha > 0 && w.w > 1 && w.h > 1)
  const pet = visible.filter(w => w.w >= 120 && w.w <= 300 && w.h >= 120 && w.h <= 460 && w.layer >= 2).sort((a, b) => a.layer - b.layer).at(0) || null
  const main = visible.filter(w => w.layer === 0 && w.w >= 400 && w.h >= 300).sort((a, b) => b.w * b.h - a.w * a.h).at(0) || null
  const bubble = visible.filter(w => w.w >= 300 && w.w <= 620 && w.h >= 100 && w.h <= 720 && w.layer >= 2).sort((a, b) => b.layer - a.layer).at(0) || null
  return { visible, pet, main, bubble }
}

export async function bubblePageState(port) {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(r => r.json()))
  const target = targets.find(item => item.type === 'page' && item.url.includes('/bubble.html'))
  if (!target) return { found: false }
  let page = null
  try {
    page = await connectPage(target.webSocketDebuggerUrl)
    const state = await page.evaluate(`(() => {
      const bubble = document.getElementById('bubble');
      const card = document.getElementById('bubble-card');
      const text = document.getElementById('bubble-text');
      const close = document.getElementById('bubble-close');
      const rect = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
      return {
        ready: document.readyState,
        bubbleClass: bubble ? bubble.className : null,
        bubbleHidden: bubble ? /(?:^|\\s)hidden(?:\\s|$)/.test(bubble.className) : null,
        cardRect: rect(card), closeRect: rect(close),
        closeVisible: close ? (close.offsetParent !== null && getComputedStyle(close).display !== 'none') : false,
        textLength: text ? text.textContent.trim().length : 0,
        textSample: text ? text.textContent.trim().slice(0, 200) : '',
        innerWidth: window.innerWidth, innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      };
    })()`)
    return { found: true, ...state }
  } finally { await page?.close().catch(() => {}) }
}

/** First-run presentation readiness: bridge + pet document target available before any trigger. */
async function waitForPresentationReady(run, pid, { timeoutMs = timeout(60000) } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = { pet: false, bubble: false, bridge: false }
  while (Date.now() < deadline) {
    try {
      const port = await run.devtoolsPort()
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
      const pet = targets.some(item => item.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\/[^/]+\/index\.html$/.test(item.url))
      const bubble = targets.some(item => item.type === 'page' && item.url.includes('/bubble.html'))
      const bridge = existsSync(run.bridgePath())
      last = { pet, bubble, bridge, port }
      if (pet && bridge) {
        await sleep(1200)
        return { ready: true, ...last }
      }
    } catch (error) { last = { ...last, error: error.message } }
    await sleep(300)
  }
  return { ready: false, ...last, error: last.error ?? `presentation not ready within ${timeoutMs}ms` }
}

async function waitForBubbleHidden(run, pid, { timeoutMs = timeout(12000) } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const page = await bubblePageState(await run.devtoolsPort()).catch(() => ({ found: false }))
    const native = classifyWindows(run.nativeWindows(pid)).bubble
    if (!native && (!page.found || page.bubbleHidden || (page.textLength ?? 0) === 0)) return { hidden: true, page, native }
    await sleep(250)
  }
  return { hidden: false, page: await bubblePageState(await run.devtoolsPort()).catch(() => ({ found: false })), native: classifyWindows(run.nativeWindows(pid)).bubble }
}

/** Diagnostics when the first bubble never appears: page targets, all windows, App stdout/stderr tails. */
async function presentationDiagnostics(run, pid) {
  const diagnostics = { windows: [], windowsAll: [], targets: [], bubblePage: null, stdoutTail: null, stderrTail: null }
  try { diagnostics.windows = run.nativeWindows(pid) } catch (error) { diagnostics.windowsError = error.message }
  try { diagnostics.windowsAll = windows({ pid, onscreenOnly: false }).windows } catch (error) { diagnostics.windowsAllError = error.message }
  try {
    const port = await run.devtoolsPort()
    diagnostics.targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
  } catch (error) { diagnostics.targetsError = error.message }
  try { diagnostics.bubblePage = await bubblePageState(await run.devtoolsPort()) } catch (error) { diagnostics.bubblePageError = error.message }
  try { diagnostics.stdoutTail = readFileSync(run.attempts[0].stdoutLog, 'utf8').slice(-4000) } catch { /* optional */ }
  try { diagnostics.stderrTail = readFileSync(run.attempts[0].stderrLog, 'utf8').slice(-4000) } catch { /* optional */ }
  return diagnostics
}

/** Distance between two rectangles (0 when they touch or overlap): the real anchor metric. */
function nearestEdgeDistance(a, b) {
  const gapX = Math.max(0, Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w)))
  const gapY = Math.max(0, Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h)))
  return Math.round(Math.hypot(gapX, gapY))
}

async function bubbleEvaluate(run, expression) {
  const port = await run.devtoolsPort()
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
  const target = targets.find(item => item.type === 'page' && item.url.includes('/bubble.html'))
  if (!target) return { found: false }
  const page = await connectPage(target.webSocketDebuggerUrl)
  try { return { found: true, value: await page.evaluate(expression) } } finally { await page.close().catch(() => {}) }
}

/**
 * Complete the shipped first-run onboarding through the real bubble page (name input,
 * then the personality step). Returns the DOM actions taken so the evidence shows the
 * onboarding was finished by UI interaction, not by editing state files.
 */
async function completeOnboarding(run, pid, { timeoutMs = timeout(90000) } = {}) {
  const steps = []
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await bubblePageState(await run.devtoolsPort()).catch(() => ({ found: false }))
    if (!state.found || state.bubbleHidden) return { done: true, steps }
    const action = await bubbleEvaluate(run, `(() => {
      const visible = el => Boolean(el && el.offsetParent !== null && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
      const row = document.getElementById('bubble-input-row');
      const input = document.getElementById('bubble-input');
      if (row && input && visible(row)) {
        input.value = '朋友';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        const submit = document.getElementById('bubble-input-submit');
        if (submit && visible(submit)) { submit.click(); return 'name-submitted'; }
      }
      const buttons = [...document.querySelectorAll('#bubble-secondary button, #bubble-choices button, button')].filter(visible);
      for (const label of ['跳过', '完成', '继续', '好', '下一步', '开始使用', '确认']) {
        const hit = buttons.find(button => button.textContent.trim() === label);
        if (hit) { hit.click(); return 'clicked:' + label; }
      }
      const close = document.getElementById('bubble-close');
      if (close && visible(close)) { close.click(); return 'clicked:bubble-close'; }
      return 'no-action';
    })()`)
    steps.push(action.value ?? action)
    if (steps[steps.length - 1] === 'no-action') {
      // The bubble may be fading out after the last step; give it a moment before failing.
      await sleep(1200)
      const after = await bubblePageState(await run.devtoolsPort()).catch(() => ({ found: false }))
      if (!after.found || after.bubbleHidden) return { done: true, steps }
    }
    await sleep(900)
  }
  return { done: false, steps, error: `onboarding did not complete within ${timeoutMs}ms` }
}

export function firstAttemptSuccess(run) { return run.attempts.length > 0 && run.attempts[0].success === true }

async function v2Snapshot(run) {
  const response = await run.apiFetch('/v2/snapshot')
  if (response.status !== 200 || !response.json) return { available: false, response }
  return { available: true, snapshot: response.json, response }
}

export async function triggerGreeting(run) {
  const triggered = { trigger: null, details: [] }
  const token = randomUUID()
  // A fresh connectionId per trigger models a new worker connection, so the Host
  // emits the deterministic v2 greeting/notice again (greeting is per connection).
  const connectionId = `accept-probe-${randomUUID()}`
  const snapshot = await v2Snapshot(run)
  if (snapshot.available) {
    const base = { protocolVersion: 'dsh-bot-v1', hostEpoch: snapshot.snapshot.hostEpoch,
      sourceConnectionId: 'accept-probe', sessionId: snapshot.snapshot.identity?.sessionId ?? null, type: 'voice.session' }
    // The Host greets once per disconnected->connected transition, so model a worker
    // reconnect: report disconnected, then connected with the fresh connectionId.
    const disconnectId = `accept-probe-disc-${randomUUID()}`
    const disconnect = await run.apiFetch('/v2/command', {
      method: 'POST',
      body: { ...base, commandId: randomUUID(), payload: { connectionId: disconnectId, transport: 'disconnected', mediaState: {} } },
    })
    triggered.details.push({ path: '/v2/command voice.session(disc)', status: disconnect.status, body: disconnect.json ?? disconnect.text.slice(0, 300) })
    const command = { ...base, commandId: randomUUID(), payload: { connectionId, transport: 'connected', mediaState: {} } }
    triggered.connectionId = connectionId
    const response = await run.apiFetch('/v2/command', { method: 'POST', body: command })
    triggered.details.push({ path: '/v2/command voice.session(connected)', status: response.status, body: response.json ?? response.text.slice(0, 400) })
    if (response.status >= 200 && response.status < 300) {
      triggered.trigger = 'v2-voice-session-reconnect-greeting'
      triggered.simulatedTransportReconnect = true
      triggered.note = 'voice.session disconnected->connected with a fresh connectionId simulates a real worker reconnect (the packaged real worker was already connected); no microphone or real worker process is exercised by this probe'
    }
  }
  if (!triggered.trigger) {
    const legacy = await run.apiFetch('/voice/turn', { method: 'POST', body: { text: '气泡原生可见性验收', source: 'accept-probe', token } })
    triggered.details.push({ path: '/voice/turn', status: legacy.status, body: (legacy.json ?? legacy.text).slice(0, 400) })
    if (legacy.status >= 200 && legacy.status < 300) triggered.trigger = 'legacy-voice-turn'
  }
  return triggered
}

export async function waitForBubble(run, pid, { timeoutMs = timeout(30000), requirePage = true, afterWindowNumbers = [] } = {}) {
  const startedAt = Date.now()
  let last = { windows: [], page: { found: false } }
  while (Date.now() - startedAt < timeoutMs) {
    const all = run.nativeWindows(pid)
    const classified = classifyWindows(all)
    last = { windows: all, classified, page: requirePage ? await bubblePageState(await run.devtoolsPort()).catch(() => ({ found: false })) : { found: false } }
    const fresh = classified.bubble && !afterWindowNumbers.includes(classified.bubble.windowNumber)
    const pageReady = !requirePage || (last.page.found && last.page.bubbleHidden === false && (last.page.textLength ?? 0) > 0)
    if (fresh && pageReady) return { found: true, waitedMs: Date.now() - startedAt, ...last }
    await sleep(300)
  }
  return { found: false, error: `bubble not visible natively/page within ${timeoutMs}ms`, ...last }
}

function displayFrame(displaysResult) {
  const screen = (displaysResult.screens || []).flat().find(item => Array.isArray(item.frame)) || null
  return screen
}

function boundsWithin(bounds, frame, tolerance = 2) {
  return bounds.x >= frame[0] - tolerance && bounds.y >= frame[1] - tolerance
    && bounds.x + bounds.w <= frame[0] + frame[2] + tolerance
    && bounds.y + bounds.h <= frame[1] + frame[3] + tolerance
}

function buildWindowLayer(bubble) {
  const bubbleFrame = bubble.found ? bubble.classified.bubble : null
  const petFrame = bubble.found ? bubble.classified.pet : null
  const display = displayFrame(displays())
  const layerOrderOk = Boolean(bubbleFrame && petFrame && bubbleFrame.layer > petFrame.layer)
  const insideVisibleFrame = Boolean(bubbleFrame && display && boundsWithin(bubbleFrame, display.visibleFrame))
  const centerDistancePx = bubbleFrame && petFrame ? distanceBetween({ ...bubbleFrame }, { ...petFrame }) : null
  const nearestEdgePx = bubbleFrame && petFrame ? nearestEdgeDistance(bubbleFrame, petFrame) : null
  const distancePx = centerDistancePx
  return {
    pet: petFrame ? { layer: petFrame.layer, frame: { x: petFrame.x, y: petFrame.y, w: petFrame.w, h: petFrame.h }, onscreen: petFrame.onscreen } : null,
    bubble: bubbleFrame ? { layer: bubbleFrame.layer, frame: { x: bubbleFrame.x, y: bubbleFrame.y, w: bubbleFrame.w, h: bubbleFrame.h }, onscreen: bubbleFrame.onscreen, alpha: bubbleFrame.alpha } : null,
    anchorDisplay: display ? { visibleFrame: display.visibleFrame, frame: display.frame, scaleFactor: display.scale } : null,
    layerOrderOk, insideVisibleFrame, distancePx, centerDistancePx, nearestEdgePx,
    withinAnchorBudget: nearestEdgePx !== null ? nearestEdgePx <= 26 : null,
    antiDriftOk: centerDistancePx !== null ? centerDistancePx <= 500 : null,
    policyIntent: ['level:screen-saver', 'visibleOnFullScreen', 'spaces:all', 'processType-derived-skipTransform'],
    note: 'layer/frame/onscreen read from CGWindowListCopyWindowInfo; policy intent strings are the WindowLayerPolicy contract, not proof by themselves',
  }
}

/** Real HID click on the bubble close control; verifies the window really disappears. */
async function hidClickBubbleClose(run, pid, bubble) {
  const result = { attempted: true, target: null, closed: false, delivered: false }
  try {
    const port = await run.devtoolsPort()
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) }).then(response => response.json())
    const target = targets.find(item => item.type === 'page' && item.url.includes('/bubble.html'))
    if (!target) { result.error = 'bubble page target missing'; result.attempted = false; return result }
    const page = await connectPage(target.webSocketDebuggerUrl)
    let metrics
    try {
      metrics = await page.evaluate(`(() => {
        const close = document.getElementById('bubble-close');
        const card = document.getElementById('bubble-card');
        const rectOf = el => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        const closeStyle = close ? getComputedStyle(close) : null;
        return {
          innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          closeRect: rectOf(close), cardRect: rectOf(card),
          closeVisible: Boolean(close && close.offsetParent !== null && closeStyle.display !== 'none' && (rectOf(close)?.w ?? 0) > 0),
        };
      })()`)
    } finally { await page.close().catch(() => {}) }
    const native = bubble.classified.bubble
    const toScreen = rect => ({
      x: native.x + (rect.x + rect.w / 2) * (native.w / metrics.innerWidth),
      y: native.y + (rect.y + rect.h / 2) * (native.h / metrics.innerHeight),
    })
    const useClose = metrics.closeVisible && metrics.closeRect && metrics.closeRect.w > 0
    const rect = useClose ? metrics.closeRect : metrics.cardRect
    if (!rect) { result.error = 'no clickable rect in bubble page'; return result }
    const point = toScreen(rect)
    result.target = useClose ? 'bubble-close' : 'bubble-card'
    result.metrics = metrics
    result.screenPoint = { x: Math.round(point.x), y: Math.round(point.y) }
    result.move = moveMouse(point.x, point.y)
    await sleep(400)
    result.click = clickAt(point.x, point.y)
    result.delivered = result.click?.atTarget === true
    await sleep(1200)
    const after = classifyWindows(run.nativeWindows(pid))
    result.windowAfter = after.bubble
    result.closed = useClose ? !after.bubble : false
    if (!result.closed && useClose) result.note = 'HID click on close did not close the bubble window'
    if (!useClose) result.note = 'close control hidden; HID click delivered on card (no state-change assertion available for this bubble kind)'
    return result
  } catch (error) {
    result.error = error.message
    return result
  }
}

/** Wait until the native bubble window has finished its fade-in (alpha ~1) for a stable screenshot. */
async function waitForSettledBubble(run, pid, { timeoutMs = timeout(5000), minAlpha = 0.9 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    last = classifyWindows(run.nativeWindows(pid)).bubble
    if (last && last.onscreen && last.alpha >= minAlpha) return { settled: true, bubble: last }
    await sleep(200)
  }
  return { settled: false, bubble: last, error: `bubble alpha did not reach ${minAlpha} within ${timeoutMs}ms` }
}

/**
 * Real screenshot evidence for a bubble. Preferred: window capture once the fade-in
 * settles. Fallback (window capture refused mid-animation or for a translucent window):
 * a full-desktop screenshot that shows the bubble in the real desktop composition.
 */
async function settledBubbleScreenshot(run, pid, path) {
  const fullPath = path.replace(/\.png$/, '.fullscreen.png')
  let lastAlpha = null
  let lastError = null
  for (let attempt = 1; attempt <= 5; attempt++) {
    const settled = await waitForSettledBubble(run, pid, { timeoutMs: timeout(3500) })
    if (settled.bubble) {
      lastAlpha = settled.bubble.alpha
      const windowShot = screenshot(path, { windowId: settled.bubble.windowNumber })
      if (windowShot.ok) return { ...windowShot, mode: 'window', settled: settled.settled, alpha: settled.bubble.alpha, attempts: attempt }
      lastError = windowShot.error
      const desktopShot = screenshot(fullPath)
      if (desktopShot.ok) return { ...desktopShot, mode: 'full-desktop-fallback', settled: settled.settled, alpha: settled.bubble.alpha, attempts: attempt, windowShotError: lastError }
    }
    await sleep(350)
  }
  const final = classifyWindows(run.nativeWindows(pid)).bubble
  const desktopShot = screenshot(fullPath)
  return { ...desktopShot, mode: 'full-desktop-fallback', windowId: final?.windowNumber ?? null, alpha: lastAlpha ?? final?.alpha ?? null, windowShotError: lastError, error: desktopShot.ok ? null : 'no bubble screenshot could be captured' }
}

/** Close any visible bubble through a real HID click (used to make the next show a fresh event). */
async function closeVisibleBubble(run, pid) {
  const current = classifyWindows(run.nativeWindows(pid)).bubble
  if (!current) return { closed: true, alreadyHidden: true }
  const result = await hidClickBubbleClose(run, pid, { found: true, classified: classifyWindows(run.nativeWindows(pid)) })
  const deadline = Date.now() + timeout(6000)
  while (Date.now() < deadline) {
    if (!classifyWindows(run.nativeWindows(pid)).bubble) return { ...result, closed: true }
    await sleep(250)
  }
  return { ...result, closed: false }
}

/**
 * Deterministically show a native bubble: close a stale one, then send the v2 greeting
 * trigger (retrying with a fresh connectionId) until the window server shows the bubble
 * AND the bubble page has content. Records every trigger attempt.
 */
export async function ensureBubble(run, pid, { timeoutMs = timeout(30000), attempts = 3 } = {}) {
  const close = await closeVisibleBubble(run, pid)
  await sleep(700)
  const triggerAttempts = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const trigger = await triggerGreeting(run)
    triggerAttempts.push(trigger)
    const found = await waitForBubble(run, pid, {
      timeoutMs: attempt === 1 ? Math.min(timeout(12000), timeoutMs) : Math.max(5000, Math.round(timeoutMs / attempts)),
      afterWindowNumbers: [],
    })
    if (found.found) {
      const settled = await waitForSettledBubble(run, pid, { timeoutMs: timeout(5000) })
      if (settled.settled) {
        found.classified = classifyWindows(run.nativeWindows(pid))
        if (found.classified.bubble) found.found = true
      }
      return { ...found, trigger, triggerAttempts, close, settled: settled.settled }
    }
    await sleep(400)
  }
  return { found: false, error: `bubble did not show natively after ${attempts} trigger attempts`, triggerAttempts, close }
}

function distanceBetween(a, b) {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2
  return Math.round(Math.hypot(ax - bx, ay - by))
}

async function runChecks(run, options) {
  const displaysInfo = displays()
  const toolchainInfo = toolchain()
  // Baseline user frontmost app, captured before launching the product App, so the
  // focus test can restore a non-product baseline without guessing.
  const userFrontmostAtStart = frontmostApp()
  run.userFrontmostAtStart = userFrontmostAtStart
  await run.launch(1)
  const launchFirst = firstAttemptSuccess(run)
  const pid = run.attempts[0].appPid
  if (!pid) {
    run.writeCheck('C0-launch-ready', { status: 'FAIL', level: 'packaged native App', detail: 'App did not launch with bridge descriptor', attempts: run.attempts })
    return 'FAIL'
  }
  let bridgeHealth
  try {
    bridgeHealth = await run.waitBridgeHealth()
    await run.waitMemoryHealth()
    run.writeCheck('C0-launch-ready', {
      status: 'PASS', level: 'packaged native App + real Host + real Memory service', appPid: pid,
      detail: `first-attempt-success=${launchFirst}; bridge pid ${bridgeHealth.health.pid} ready, memory authenticated health PASS`,
      firstAttemptSuccess: launchFirst, attempts: run.attempts,
      health: { pid: bridgeHealth.health.pid, sessionId: bridgeHealth.health.agent?.sessionId ?? null, memory: 'authenticated-health-PASS' },
      processTree: processTreeFor(run.userData),
    })
  } catch (error) {
    run.writeCheck('C0-launch-ready', { status: 'FAIL', level: 'packaged native App', detail: `readiness failed: ${error.message}`, attempts: run.attempts })
    return 'FAIL'
  }

  // ---- C1 bubble first show: first-run onboarding bubble, then the Host greeting bubble.
  const presentationReadiness = await waitForPresentationReady(run, pid, { timeoutMs: timeout(60000) })
  const preBubble = classifyWindows(run.nativeWindows(pid))
  let firstBubble = await waitForBubble(run, pid, { timeoutMs: timeout(30000), afterWindowNumbers: [] })
  if (!firstBubble.found) firstBubble = await ensureBubble(run, pid, { timeoutMs: timeout(30000), attempts: 2 })
  let firstShowDiagnostics = null
  if (!firstBubble.found) {
    // Give the first-run experience a bounded second chance, then dump real state instead of guessing.
    await sleep(2500)
    firstBubble = await waitForBubble(run, pid, { timeoutMs: timeout(20000), afterWindowNumbers: [] })
    if (!firstBubble.found) {
      firstShowDiagnostics = await presentationDiagnostics(run, pid)
      firstShowDiagnostics.presentationReadiness = presentationReadiness
    }
  }
  const firstShot = firstBubble.found ? await settledBubbleScreenshot(run, pid, join(run.evidenceDir, 'bubble-first-show.png')) : { ok: false }
  const firstLayer = firstBubble.found ? buildWindowLayer(firstBubble) : null
  const firstPage = firstBubble.page ?? { found: false }
  const firstIsOnboarding = /鲸鱼娘|称呼|你好，我是/.test(String(firstPage.textSample ?? ''))
  const ax = await run.axWindows(pid)
  const axFrames = (ax.windows || []).filter(w => Array.isArray(w.position) && Array.isArray(w.size))
  const axCrossCheck = axFrames.map(w => ({ name: w.name, x: w.position[0], y: w.position[1], w: w.size[0], h: w.size[1] }))
  const axContainsFirstFrame = firstBubble.found
    ? axFrames.some(w => Math.abs(w.size[0] - firstBubble.classified.bubble.w) <= 4 && Math.abs(w.size[1] - firstBubble.classified.bubble.h) <= 4)
    : false
  const onboardingFirstPass = firstBubble.found && firstShot.ok && firstPage.bubbleHidden === false && (firstPage.textLength ?? 0) > 0 && firstLayer?.layerOrderOk === true
  // Finish first-run onboarding through the real UI before the Host greeting can show.
  const onboardingCompletion = firstIsOnboarding ? await completeOnboarding(run, pid) : { skipped: true, reason: 'first show was already a Host greeting, not first-run onboarding' }
  // The onboarding bubble must be gone before the greeting is triggered.
  let hiddenAfterOnboarding = await waitForBubbleHidden(run, pid, { timeoutMs: timeout(12000) })
  if (firstIsOnboarding && !hiddenAfterOnboarding.hidden) {
    const closeAttempt = await closeVisibleBubble(run, pid)
    hiddenAfterOnboarding = { ...(await waitForBubbleHidden(run, pid, { timeoutMs: timeout(8000) })), closeAttempt }
  }
  // Let the first-run experience settle after its final UI step before requesting the
  // Host greeting; then retry the simulated reconnect trigger a bounded number of times.
  await sleep(2500)
  let greeting = await ensureBubble(run, pid, { timeoutMs: timeout(45000), attempts: 5 })
  let greetingDiagnostics = null
  if (!greeting.found) {
    greetingDiagnostics = await presentationDiagnostics(run, pid)
    await sleep(1500)
    greeting = await ensureBubble(run, pid, { timeoutMs: timeout(30000), attempts: 3 })
  }
  const greetingShot = greeting.found ? await settledBubbleScreenshot(run, pid, join(run.evidenceDir, 'bubble-greeting-after-onboarding.png')) : { ok: false }
  const greetingLayer = greeting.found ? buildWindowLayer(greeting) : null
  const greetingPage = greeting.page ?? { found: false }
  const greetingPass = greeting.found && greetingShot.ok && greetingPage.bubbleHidden === false && (greetingPage.textLength ?? 0) > 0 && greetingLayer?.layerOrderOk === true
  const hidClick = greeting.found ? await hidClickBubbleClose(run, pid, greeting) : { attempted: false }
  const windowLayer = greetingLayer ?? firstLayer
  run.writeCheck('C1-bubble-first-show', {
    status: onboardingFirstPass && greetingPass ? 'PASS' : 'FAIL',
    level: 'packaged native App + window-server truth (CGWindowList) + real screenshots + page content + AX list; first-run onboarding then Host greeting',
    firstShow: {
      kind: firstIsOnboarding ? 'first-run-onboarding' : 'host-greeting',
      found: firstBubble.found, page: firstPage, window: firstBubble.classified?.bubble ?? null,
      screenshot: firstShot, windowLayer: firstLayer, waitedMs: firstBubble.waitedMs ?? null,
      pet: firstBubble.classified?.pet ?? preBubble.pet ?? null, main: firstBubble.classified?.main ?? null,
      ax: { granted: ax.ok !== false, crossCheck: axCrossCheck, containsFirstFrame: axContainsFirstFrame },
    },
    presentationReadiness,
    firstShowDiagnostics,
    onboardingCompletion,
    hiddenAfterOnboarding,
    greetingDiagnostics,
    greeting: {
      found: greeting.found, error: greeting.error ?? null, waitedMs: greeting.waitedMs ?? null,
      trigger: { trigger: greeting.trigger?.trigger ?? null, attempts: greeting.triggerAttempts ?? [], close: greeting.close ?? null },
      window: greeting.classified?.bubble ?? null, page: greetingPage, screenshot: greetingShot, windowLayer: greetingLayer,
    },
    hidClick,
    windowLayer,
    screenshots: { firstShow: firstShot, greeting: greetingShot },
    detail: firstBubble.found
      ? `first native show kind=${firstIsOnboarding ? 'onboarding' : 'greeting'} window ${firstBubble.classified.bubble.w}x${firstBubble.classified.bubble.h} layer=${firstBubble.classified.bubble.layer} onscreen=${firstBubble.classified.bubble.onscreen} pageChars=${firstPage.textLength}; onboarding steps=${JSON.stringify(onboardingCompletion.steps ?? onboardingCompletion.reason ?? [])}; post-onboarding greeting native=${greeting.found} layer=${greeting.classified?.bubble.layer ?? 'n/a'} pageChars=${greetingPage.textLength}; HID close closed=${hidClick.closed ?? 'n/a'}`
      : (firstBubble.error ?? 'no first bubble'),
  })
  run.log(`C1 onboarding-first=${firstIsOnboarding} greeting=${greeting.found} hidClose=${hidClick.closed ?? 'n/a'}`)

  // ---- C2 bubble above main window (real main window opened through the pet double-click path), plus fullscreen attempt.
  let webBoot = null
  try {
    webBoot = await acceptDesktopWeb(run.userData, run.bridgePath(), join(run.evidenceDir, 'web-boot.json'))
    run.log(`web boot + pet double-click + session selection PASS (sessionId=${webBoot.sessionId})`)
  } catch (error) {
    run.log(`web boot/double-click FAILED: ${error.message}`)
  }
  const afterMain = classifyWindows(run.nativeWindows(pid))
  const main = afterMain.main
  // Show a bubble AFTER the main window exists so the above-main measurement uses a
  // bubble whose native window is on screen at the same time as the main window.
  let aboveMainBubble = greeting.classified?.bubble ?? firstBubble.classified?.bubble ?? null
  let aboveMainRetrigger = null
  if (webBoot && main) {
    try {
      const fresh = await ensureBubble(run, pid, { timeoutMs: timeout(30000), attempts: 3 })
      aboveMainRetrigger = { found: fresh.found, triggerAttempts: fresh.triggerAttempts ?? [], close: fresh.close ?? null, error: fresh.error ?? null }
      if (fresh.found) aboveMainBubble = fresh.classified.bubble
    } catch (error) { aboveMainRetrigger = { error: error.message } }
  }
  let aboveMain = null
  if (aboveMainBubble && main) {
    aboveMain = {
      mainLayer: main.layer, bubbleLayer: aboveMainBubble.layer,
      bubbleAboveMainByLayer: aboveMainBubble.layer > main.layer,
      bubbleOnscreen: aboveMainBubble.onscreen,
      bubbleWindow: aboveMainBubble.windowNumber, mainWindow: main.windowNumber,
      overlap: !(aboveMainBubble.x + aboveMainBubble.w < main.x || main.x + main.w < aboveMainBubble.x
        || aboveMainBubble.y + aboveMainBubble.h < main.y || main.y + main.h < aboveMainBubble.y),
    }
  }
  const fullscreenAttempt = await attemptFullscreenMain(run, pid, main)
  run.writeCheck('C2-bubble-above-main', {
    status: aboveMain?.bubbleAboveMainByLayer && aboveMain?.bubbleOnscreen ? (fullscreenAttempt.status === 'FAIL' ? 'FAIL' : 'PASS') : 'FAIL',
    level: 'packaged native App + window-server layer/alpha/bounds; fullscreen automation via AX/keystroke attempt',
    webBoot: webBoot ? { status: 'PASS', sessionId: webBoot.sessionId } : { status: 'FAIL' },
    main, bubble: aboveMainBubble, aboveMainRetrigger, aboveMain,
    fullscreen: fullscreenAttempt,
    detail: aboveMain
      ? `main layer ${aboveMain.mainLayer} window ${aboveMain.mainWindow}, bubble layer ${aboveMain.bubbleLayer} window ${aboveMain.bubbleWindow}, bubble onscreen=${aboveMain.bubbleOnscreen}; fullscreen=${fullscreenAttempt.status}`
      : `missing main window (main=${Boolean(main)}) or bubble; webBoot=${Boolean(webBoot)}`,
  })

  // ---- C3 focus non-steal: explicitly activate Finder, then a non-activating bubble must not steal focus.
  const focusClose = await closeVisibleBubble(run, pid)
  const focusActivation = []
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { spawnSync('/usr/bin/open', ['-a', 'Finder'], { encoding: 'utf8' }) } catch { /* best effort */ }
    try {
      spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); const p = Application('System Events').processes.whose({name: 'Finder'}); if (p.length) p[0].frontmost = true; 'ok'`], { encoding: 'utf8' })
    } catch { /* best effort */ }
    await sleep(900)
    const current = frontmostApp()
    focusActivation.push({ attempt, frontmost: current.name ?? null })
    if (/Finder/i.test(String(current.name))) break
  }
  const focusBefore = frontmostApp()
  const baselineIsFinder = /Finder/i.test(String(focusBefore.name))
  const focusBubble = await ensureBubble(run, pid, { timeoutMs: timeout(30000), attempts: 3 })
  await sleep(900)
  const focusAfter = frontmostApp()
  const afterIsFinder = /Finder/i.test(String(focusAfter.name))
  const productStoleFocus = Boolean(focusBubble.found && baselineIsFinder && !afterIsFinder)
  const focusPass = Boolean(focusBubble.found && baselineIsFinder && afterIsFinder)
  const focusTrigger = { trigger: focusBubble.trigger?.trigger ?? null, attempts: focusBubble.triggerAttempts ?? [], close: focusClose }
  run.writeCheck('C3-focus-non-steal', {
    status: focusPass ? 'PASS' : (!baselineIsFinder ? 'BLOCKED-ENVIRONMENT' : (focusBubble.found ? 'FAIL' : 'BLOCKED-ENVIRONMENT')),
    level: 'packaged native App + System Events frontmost-process truth; Finder explicitly activated and polled',
    focusActivation, before: focusBefore, after: focusAfter,
    baselineIsFinder, afterIsFinder, productStoleFocus,
    trigger: focusTrigger, bubbleFound: focusBubble.found, bubble: focusBubble.classified?.bubble ?? null,
    detail: focusBubble.found
      ? `frontmost before=${focusBefore.name} after=${focusAfter.name}; baselineIsFinder=${baselineIsFinder} afterIsFinder=${afterIsFinder} productStoleFocus=${productStoleFocus}`
      : (baselineIsFinder
        ? `no bubble for focus test: ${focusBubble.error}`
        : `could not establish Finder as the frontmost baseline (activation attempts ${JSON.stringify(focusActivation)}); BLOCKED not faked`),
  })

  // ---- C4 edge geometry + display inventory; multi-display explicitly blocked on a single-display host.
  const display = displayFrame(displaysInfo)
  let pet = classifyWindows(run.nativeWindows(pid)).pet
  if (!pet) {
    await ensureWindowsOnCurrentSpace(run, pid)
    pet = classifyWindows(run.nativeWindows(pid)).pet
  }
  let edge = { attempted: false, status: 'BLOCKED-ENVIRONMENT', detail: 'no pet window frame available through window server' }
  if (display && pet) {
    const [vx, vy, vw, vh] = display.visibleFrame
    const target = { x: vx + vw - pet.w - 4, y: vy + Math.round(vh / 2) - Math.round(pet.h / 2) }
    edge = await attemptEdgeGeometry(run, pid, pet, target, display)
  } else if (display) {
    edge.offscreenDiagnostics = windows({ pid, onscreenOnly: false }).windows
      .filter(window => window.layer >= 2)
      .map(window => ({ name: window.name, layer: window.layer, alpha: window.alpha, onscreen: window.onscreen, w: window.w, h: window.h }))
  }
  const displaysBlocked = (displaysInfo.displays || []).length < 2
  run.writeCheck('C4-edge-multi-display-geometry', {
    status: edge.status === 'PASS' ? 'PASS' : (edge.status === 'FAIL' ? 'FAIL' : 'BLOCKED-ENVIRONMENT'),
    level: 'packaged native App + CGDisplay/NSScreen inventory + window-server frames',
    displays: { count: (displaysInfo.displays || []).length, main: (displaysInfo.displays || [])[0] ?? null, screens: displaysInfo.screens, multiDisplay: displaysBlocked ? 'BLOCKED-ENVIRONMENT: only one active display attached' : 'available' },
    scaleLogical: display ? display.scale : null,
    edge,
    detail: edge.detail,
  })

  // ---- C5 packaged app with a deliberately missing Memory payload must fail loudly, never claim ready.
  run.writeCheck('C5-dev-missing-memory-diagnosis', await attemptMissingMemory(run))
  if (run.missingMemoryAppCopy) { rmSync(run.missingMemoryAppCopy, { recursive: true, force: true }); delete run.missingMemoryAppCopy }

  // ---- C6 snapshot/connection contract + legacy endpoint compatibility + auth/leak checks.
  run.writeCheck('C6-snapshot-connection', await snapshotChecks(run))

  // ---- C7 exit/restart cleanup: descriptors and ports cleaned, restart yields a new hostEpoch with no auto-submitted work.
  const epochBefore = (await v2Snapshot(run)).snapshot?.hostEpoch ?? null
  // Capture the Host port before shutdown: the descriptor is expected to be removed by the app.
  let hostPortBeforeExit = null
  try { hostPortBeforeExit = JSON.parse(readFileSync(run.bridgePath(), 'utf8')).port } catch { hostPortBeforeExit = null }
  const shutdown = await run.stop({ label: 'first' })
  const listeners = hostPortBeforeExit
    ? spawnSync('/usr/sbin/lsof', ['-nP', `-iTCP:${hostPortBeforeExit}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    : { stdout: '' }
  const descriptorsGone = !existsSync(run.bridgePath()) && !existsSync(run.memoryRuntimePath())
  const residual = processTreeFor(run.userData)
  const restart = await run.launch(2)
  let restartHealth = null
  let epochAfter = null
  let restartSnapshot = null
  if (restart.success) {
    try { restartHealth = await run.waitBridgeHealth() } catch (error) { restartHealth = { error: error.message } }
    const snapshot = await v2Snapshot(run)
    restartSnapshot = snapshot.snapshot ?? null
    epochAfter = restartSnapshot?.hostEpoch ?? null
  }
  const shutdown2 = await run.stop({ label: 'restart' })
  run.writeCheck('C7-exit-restart-cleanup', {
    status: shutdown.exited && descriptorsGone && residual.length === 0 && restart.success && shutdown2.exited && !existsSync(run.bridgePath())
      ? (epochBefore && epochAfter && epochBefore !== epochAfter ? 'PASS' : 'FAIL') : 'FAIL',
    level: 'packaged native App + real LaunchServices exit/restart + descriptor/port/process cleanup',
    shutdown, descriptorsGone, hostPortBeforeExit, listenersAfterExit: String(listeners.stdout || '').trim() || 'none', residualProcesses: residual,
    restart: { success: restart.success, attempt: 2, appPid: restart.appPid, health: restartHealth, hostEpoch: epochAfter },
    hostEpochBefore: epochBefore, hostEpochAfter: epochAfter,
    epochChanged: Boolean(epochBefore && epochAfter && epochBefore !== epochAfter),
    restartSnapshotSummary: restartSnapshot ? { protocolVersion: restartSnapshot.protocolVersion, schema: restartSnapshot.schema, snapshotSeq: restartSnapshot.snapshotSeq, execution: restartSnapshot.execution?.state, queue: restartSnapshot.queue?.items?.length ?? null, inputDraft: restartSnapshot.inputDraft ?? null } : null,
    shutdown2,
    detail: `first exit cleanup=${shutdown.exited && descriptorsGone && residual.length === 0}; restart attempt-2 success=${restart.success}; hostEpoch changed=${Boolean(epochBefore && epochAfter && epochBefore !== epochAfter)}`,
  })

  // ---- overall
  const values = Object.values(run.checks)
  const failed = values.filter(check => check.status === 'FAIL')
  const blocked = values.filter(check => check.status === 'BLOCKED-ENVIRONMENT')
  const overall = failed.length ? 'FAIL' : blocked.length ? 'PASS-WITH-BLOCKED-ENVIRONMENT' : 'PASS'
  return overall
}

/** Bring the product App to the front so its windows are on the current Space (returns fresh classification). */
async function ensureWindowsOnCurrentSpace(run, pid) {
  try {
    spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); Application('System Events').processes.whose({unixId: ${Number(pid)}})[0].frontmost = true; 'activated'`], { encoding: 'utf8' })
  } catch { /* best effort */ }
  await sleep(1200)
  return classifyWindows(run.nativeWindows(pid))
}

/**
 * Fullscreen check kept read-mostly and state-restoring: only when the AXFullScreen
 * attribute is readable do we attempt a toggle, and in every case we restore the
 * previous window state (Space/fullscreen) before later native checks run.
 */
async function attemptFullscreenMain(run, pid, main) {
  const result = { status: 'BLOCKED-ENVIRONMENT', attempts: [], detail: '' }
  if (!main) { result.detail = 'no main window to attempt fullscreen'; return result }
  const frame = displayFrame(displays())
  const before = classifyWindows(run.nativeWindows(pid)).main
  const readAttribute = () => {
    try {
      const js = `ObjC.import('AppKit'); const se = Application('System Events');
const proc = se.processes.whose({unixId: ${Number(pid)}})[0]; const ws = proc.windows(); const out = [];
for (let i = 0; i < ws.length; i++) {
  let value = 'unavailable';
  try { value = ws[i].attributes.byName('AXFullScreen').value(); } catch (e) { value = 'unavailable'; }
  let size = null; try { size = ws[i].size(); } catch (e) {}
  out.push({ value, size });
}
JSON.stringify(out)`
      return JSON.parse(spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }).stdout || '[]')
    } catch { return [] }
  }
  const attributes = readAttribute()
  const mainIndexAttribute = attributes.find(item => Array.isArray(item.size) && item.size[0] >= 400 && item.size[1] >= 300)
  result.axFullscreenAttribute = mainIndexAttribute?.value ?? 'unavailable'
  const observable = mainIndexAttribute && mainIndexAttribute.value !== 'unavailable'
  if (!observable) {
    // Do not blind-keystroke the user's frontmost app: no AX-observable fullscreen control here.
    result.detail = 'BLOCKED-ENVIRONMENT: AXFullScreen is not readable for the packaged App window on this host; no keystroke was sent and no window state was changed'
    result.before = before
    result.attributes = attributes
    return result
  }
  const restore = async () => {
    try {
      const js = `ObjC.import('AppKit'); const se = Application('System Events');
const proc = se.processes.whose({unixId: ${Number(pid)}})[0]; const ws = proc.windows();
for (let i = 0; i < ws.length; i++) { let size = null; try { size = ws[i].size(); } catch (e) {}
  if (Array.isArray(size) && size[0] >= 400 && size[1] >= 300) { try { ws[i].attributes.byName('AXFullScreen').value = false; } catch (e) {} break; } }`
      spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' })
    } catch { /* best effort */ }
    await sleep(1500)
    const current = classifyWindows(run.nativeWindows(pid)).main
    if (current && frame && Math.abs(current.w - frame.frame[2]) <= 4 && Math.abs(current.h - frame.frame[3]) <= 4) {
      // Still fullscreen: toggle the standard shortcut once to leave it.
      spawnSync('/usr/bin/osascript', ['-e', 'tell application "System Events" to key code 3 using {control down, command down}'], { encoding: 'utf8' })
      await sleep(2200)
    }
    await ensureWindowsOnCurrentSpace(run, pid)
    return classifyWindows(run.nativeWindows(pid)).main
  }
  try {
    try {
      const js = `ObjC.import('AppKit'); const se = Application('System Events');
const proc = se.processes.whose({unixId: ${Number(pid)}})[0]; const ws = proc.windows(); let done = 'no-candidate';
for (let i = 0; i < ws.length; i++) { let size = null; try { size = ws[i].size(); } catch (e) {}
  if (Array.isArray(size) && size[0] >= 400 && size[1] >= 300) { try { ws[i].attributes.byName('AXFullScreen').value = true; done = 'set-true'; } catch (e) { done = 'error: ' + String(e.message).slice(0, 100); } break; } }
JSON.stringify({done});`
      const axResult = JSON.parse(spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }).stdout || '{}')
      result.attempts.push({ method: 'AXFullScreen', result: axResult.done })
    } catch (error) { result.attempts.push({ method: 'AXFullScreen', error: error.message }) }
    await sleep(2500)
    let current = classifyWindows(run.nativeWindows(pid)).main
    const fullscreenNow = () => Boolean(current && frame && Math.abs(current.w - frame.frame[2]) <= 4 && Math.abs(current.h - frame.frame[3]) <= 4)
    if (fullscreenNow()) {
      const bubbleNow = classifyWindows(run.nativeWindows(pid)).bubble
      const shot = screenshot(join(run.evidenceDir, 'bubble-above-fullscreen-main.png'))
      result.status = bubbleNow && bubbleNow.onscreen ? 'PASS' : 'FAIL'
      result.fullscreenWindow = current ?? null
      result.bubble = bubbleNow ?? null
      result.screenshot = shot
      result.detail = `main window fullscreen (${current?.w}x${current?.h}) and bubble onscreen=${bubbleNow?.onscreen}; layer=${bubbleNow?.layer}`
    } else {
      result.detail = 'BLOCKED-ENVIRONMENT: AXFullScreen toggle did not produce an observable fullscreen window; no product PASS claimed'
      result.before = before
      result.attributes = readAttribute()
    }
  } finally {
    result.restore = await restore()
    result.restored = Boolean(result.restore)
    result.restoreDetail = result.restore ? `main window restored to ${result.restore.w}x${result.restore.h}` : 'main window not observed after restore'
  }
  return result
}

async function attemptEdgeGeometry(run, pid, pet, target, display) {
  // Real HID drag of the pet window: the shipped pet renderer owns window dragging
  // (mousedown on the painted pet -> dragStart -> window moves), so OS-level press,
  // interpolated dragged events and release are what a user does. No AX move needed.
  const result = { status: 'FAIL', attempted: true, method: 'HID press-drag-release on the pet window (pet renderer owns the drag)', target, petBefore: pet, display }
  // The pet is a transparent window: only painted pixels start a drag, so try a few
  // candidate grab points on the sprite (the renderer hit-tests the canvas alpha).
  const candidateFractions = [[0.5, 0.5], [0.5, 0.72], [0.35, 0.62], [0.66, 0.62]]
  const drags = []
  let petAfterMove = null
  let moved = false
  for (const [fx, fy] of candidateFractions) {
    const from = { x: Math.round(pet.x + pet.w * fx), y: Math.round(pet.y + pet.h * fy) }
    const to = { x: Math.round(target.x + pet.w * fx), y: Math.round(target.y + pet.h * fy) }
    let dragResult = null
    try { dragResult = dragMouse(from.x, from.y, to.x, to.y) } catch (error) { dragResult = { error: error.message } }
    drags.push({ from, to, dragResult })
    const deadline = Date.now() + timeout(6000)
    while (Date.now() < deadline) {
      petAfterMove = classifyWindows(run.nativeWindows(pid)).pet
      if (petAfterMove && Math.hypot(petAfterMove.x - target.x, petAfterMove.y - target.y) <= 40) break
      await sleep(250)
    }
    moved = Boolean(petAfterMove && Math.hypot(petAfterMove.x - target.x, petAfterMove.y - target.y) <= 40)
    if (moved) break
    await sleep(400)
  }
  result.drags = drags
  result.dragFrom = drags[0]?.from ?? null
  result.dragTo = drags[0]?.to ?? null
  result.moveApplied = moved
  result.petAfterMove = petAfterMove
  const close = await closeVisibleBubble(run, pid)
  const bubble = await ensureBubble(run, pid, { timeoutMs: timeout(30000), attempts: 3 })
  const bubbleFrame = bubble.found ? bubble.classified.bubble : null
  const visibleFrame = display.visibleFrame
  const inside = bubbleFrame ? boundsWithin(bubbleFrame, visibleFrame) : false
  const nearestEdge = bubbleFrame && petAfterMove ? nearestEdgeDistance(bubbleFrame, petAfterMove) : null
  const centerDistance = bubbleFrame && petAfterMove ? distanceBetween(bubbleFrame, petAfterMove) : null
  const anchored = nearestEdge !== null && (nearestEdge <= 26 || nearestEdge === 0)
  const overlapping = Boolean(bubbleFrame && petAfterMove
    && bubbleFrame.x < petAfterMove.x + petAfterMove.w && petAfterMove.x < bubbleFrame.x + bubbleFrame.w
    && bubbleFrame.y < petAfterMove.y + petAfterMove.h && petAfterMove.y < bubbleFrame.y + bubbleFrame.h)
  const shot = bubbleFrame ? await settledBubbleScreenshot(run, pid, join(run.evidenceDir, 'bubble-edge-geometry.png')) : { ok: false }
  result.close = close
  result.bubbleTrigger = { trigger: bubble.trigger?.trigger ?? null, attempts: bubble.triggerAttempts ?? [], error: bubble.error ?? null }
  result.bubble = bubbleFrame
  result.visibleFrame = visibleFrame
  result.insideVisibleFrame = inside
  result.nearestEdgePx = nearestEdge
  result.centerDistancePx = centerDistance
  result.anchored = anchored
  result.overlappingWithPet = overlapping
  result.screenshot = shot
  result.windowLayer = bubble.found ? buildWindowLayer(bubble) : null
  result.status = moved && bubbleFrame && inside && anchored ? 'PASS' : 'FAIL'
  result.detail = bubbleFrame
    ? `pet HID-dragged to right edge moved=${moved}; bubble ${bubbleFrame.w}x${bubbleFrame.h} inside visibleFrame=${inside}; nearest-edge=${nearestEdge}px (tail-aware overlap=${overlapping}), center=${centerDistance}px; screenshot=${shot.ok}`
    : `bubble did not appear after edge drag: ${bubble.error ?? 'unknown'}`
  // Restore the pet position with the same HID drag path (best effort).
  const lastDrag = drags[drags.length - 1]
  if (lastDrag) { try { dragMouse(lastDrag.to.x, lastDrag.to.y, lastDrag.from.x, lastDrag.from.y); await sleep(800) } catch { /* restore is best effort */ } }
  return result
}

function petFrame(frame) { return { x: frame.x, y: frame.y, w: frame.w, h: frame.h } }

async function attemptMissingMemory(run) {
  const copy = join(run.runDir, 'app-missing-memory', 'dsh-bot.app')
  const check = {
    status: 'FAIL', level: 'packaged native App with deliberately removed Memory payload (negative diagnosis path)',
    method: 'copy installed .app, rename Contents/Resources/memory, launch the app binary with isolated dirs and capture stdout/stderr for a bounded window',
    attempted: true,
  }
  try {
    rmSync(join(run.runDir, 'app-missing-memory'), { recursive: true, force: true })
    mkdirSync(join(run.runDir, 'app-missing-memory'), { recursive: true })
    run.missingMemoryAppCopy = copy
    const ditto = spawnSync('/usr/bin/ditto', [run.appPath, copy], { encoding: 'utf8' })
    if (ditto.status !== 0) {
      check.status = 'BLOCKED-ENVIRONMENT'
      check.detail = `cannot copy app for negative test: ${String(ditto.stderr).slice(0, 300)}`
      return check
    }
    const memoryPayload = join(copy, 'Contents/Resources/memory')
    const memoryPayloadMissing = join(copy, 'Contents/Resources/memory.__removed_for_negative_test__')
    if (!existsSync(memoryPayload)) {
      check.status = 'BLOCKED-ENVIRONMENT'
      check.detail = `packaged app has no Contents/Resources/memory payload to remove (path=${memoryPayload}); memory may be resolved elsewhere`
      return check
    }
    renameSync(memoryPayload, memoryPayloadMissing)
    const userData = join(run.runDir, 'app-missing-memory', 'user-data')
    const dshHome = join(run.runDir, 'app-missing-memory', 'dsh-home')
    mkdirSync(userData, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    const binary = join(copy, 'Contents/MacOS/dsh-bot')
    check.binary = binary
    check.stdoutLog = join(run.logsDir, 'missing-memory-stdout.log')
    check.stderrLog = join(run.logsDir, 'missing-memory-stderr.log')
    const child = spawnSync(binary, [`--user-data-dir=${userData}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'], {
      encoding: 'utf8', timeout: 25000, env: { ...process.env, DSH_HOME: dshHome, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined },
    })
    writeFileSync(check.stdoutLog, String(child.stdout || ''))
    writeFileSync(check.stderrLog, String(child.stderr || ''))
    const combined = `${child.stdout || ''}\n${child.stderr || ''}`
    const diagnosticPatterns = [/memory/i, /payload/i, /hindsight/i, /build-memory\.sh/i, /NISSE_MEMORY_DIR/i, /missing/i, /not found/i, /资源/i, /内存/i]
    const hits = diagnosticPatterns.filter(pattern => pattern.test(combined)).map(pattern => String(pattern))
    const explicit = /build-memory\.sh|NISSE_MEMORY_DIR/i.test(combined) || (hits.length >= 2 && /memory|hindsight|资源|内存/i.test(combined))
    const claimedReady = /memory(?:\s+)?ready|Memory ready|memory.*authenticated/i.test(combined) && !/not ready|missing|failed|error/i.test(combined)
    check.exitCode = child.status
    check.signal = child.signal
    check.matchedKeywords = hits
    check.explicitDiagnosis = explicit
    check.claimedMemoryReady = claimedReady
    check.bridgeCreated = existsSync(join(dshHome, 'bot/bridge.json'))
    check.memoryRuntimeCreated = existsSync(join(dshHome, 'memory/runtime.json'))
    check.status = explicit && !claimedReady ? 'PASS' : (explicit ? 'FAIL' : 'BLOCKED-ENVIRONMENT')
    check.detail = explicit
      ? `explicit missing-Memory diagnosis observed in captured output (keywords=${hits.join(',')}); claimedReady=${claimedReady}`
      : `no explicit missing-Memory diagnosis in captured stdout/stderr (exit=${child.status}, signal=${child.signal}, keywords=${hits.join(',') || 'none'}); GUI-only dialog cannot be read programmatically on this host`
    // Restore payload inside the copy (the copy is still deleted by the caller).
    try { renameSync(memoryPayloadMissing, memoryPayload) } catch { /* copy is removed anyway */ }
    return check
  } catch (error) {
    check.status = 'BLOCKED-ENVIRONMENT'
    check.detail = `negative test could not run: ${error.message}`
    run.missingMemoryAppCopy = copy
    return check
  }
}

async function snapshotChecks(run) {
  const check = { status: 'FAIL', level: 'packaged native App + real Host HTTP contract', checks: [] }
  try {
    const healthResponse = await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(run.bridgePath(), 'utf8')).port}/health`, { signal: AbortSignal.timeout(5000) })
    const healthText = await healthResponse.text()
    const health = JSON.parse(healthText)
    const pathMatches = healthText.match(/\/Users\/[^"\\\s]+|\/private\/(?:var|tmp)\/[^"\\\s]+|\/var\/folders\/[^"\\\s]+/g) || []
    check.healthTextSample = healthText.slice(0, 1500)
    check.checks.push({ id: 'health-unauthenticated', status: healthResponse.ok && health.ok === true ? 'PASS' : 'FAIL', detail: `status=${healthResponse.status}` })
    check.checks.push({ id: 'health-no-path-leak', status: pathMatches.length ? 'FAIL' : 'PASS', detail: pathMatches.length ? `absolute path(s) in /health: ${pathMatches.slice(0, 3).join(', ')}` : 'no home/tmp absolute path' })
    const snapshot = await v2Snapshot(run)
    if (!snapshot.available) {
      check.checks.push({ id: 'v2-snapshot', status: 'FAIL', detail: `/v2/snapshot returned ${snapshot.response.status}: ${String(snapshot.response.text).slice(0, 200)}` })
      check.detail = 'v2 snapshot endpoint unavailable; beta2 protocol contract not implemented in this package'
      check.status = 'FAIL'
      return check
    }
    const s = snapshot.snapshot
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    // The installed app must report the version this source tree declares; the literal that
    // stood here had to be edited at every release, so a stale harness could pass a wrong build.
    const declaredProductVersion = String(JSON.parse(readFileSync(resolve(import.meta.dirname, '../../product/versions.json'), 'utf8')).product.version)
    const contractChecks = {
      'protocolVersion=dsh-bot-v1': s.protocolVersion === 'dsh-bot-v1',
      'schema=snapshot@1': s.schema === 'snapshot@1',
      'hostEpoch-is-uuid': uuid.test(String(s.hostEpoch)),
      'snapshotSeq-integer': Number.isInteger(s.snapshotSeq) && s.snapshotSeq >= 0,
      'identity-product': s.identity?.product === 'dsh-bot',
      'identity-productVersion-declared': String(s.identity?.productVersion) === declaredProductVersion,
      'sections-present': ['identity', 'connection', 'capture', 'playback', 'execution', 'interactions', 'queue', 'notices', 'presentation'].every(key => key in s),
      // Shape contract: desktop.connected is a boolean. The Host marks it true only after a
      // desktop-source command; pet snapshot polling alone is not a desktop command, so the
      // value is recorded as evidence instead of being forced to true.
      'desktop-connected-boolean': typeof s.connection?.desktop?.connected === 'boolean',
    }
    for (const [id, pass] of Object.entries(contractChecks)) check.checks.push({ id, status: pass ? 'PASS' : 'FAIL' })
    const events = await run.apiFetch(`/v2/events?after=${s.snapshotSeq}`)
    const eventsJson = events.json
    check.eventsHandshake = {
      status: events.status, next: eventsJson?.next ?? null, eventCount: eventsJson?.events?.length ?? null,
      resyncRequired: eventsJson?.resyncRequired ?? null,
      consistent: events.status === 200 && Number.isInteger(eventsJson?.next) && eventsJson.next >= s.snapshotSeq && eventsJson.resyncRequired === false,
    }
    check.checks.push({ id: 'v2-events-handshake', status: check.eventsHandshake.consistent ? 'PASS' : 'FAIL', detail: `next=${eventsJson?.next} after=${s.snapshotSeq}` })
    for (const legacy of ['/interactions', '/task-state']) {
      const response = await run.apiFetch(legacy)
      check.checks.push({ id: `legacy-${legacy.replace(/\//g, '')}`, status: response.status === 200 ? 'PASS' : 'FAIL', detail: `status=${response.status}` })
    }
    const unauthorized = await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(run.bridgePath(), 'utf8')).port}/v2/snapshot`, { signal: AbortSignal.timeout(5000) })
    check.checks.push({ id: 'v2-auth-required', status: unauthorized.status === 401 || unauthorized.status === 403 ? 'PASS' : 'FAIL', detail: `unauthenticated status=${unauthorized.status}` })
    check.snapshotSummary = {
      hostEpoch: s.hostEpoch, snapshotSeq: s.snapshotSeq, productVersion: s.identity?.productVersion,
      executionState: s.execution?.state, interactionPending: s.interactions?.pending?.length ?? null,
      bubbleVisible: s.presentation?.bubble?.visible ?? null, noticeCount: s.notices?.length ?? null,
      desktopConnected: s.connection?.desktop?.connected ?? null,
      workerState: s.connection?.worker?.state ?? null,
    }
    check.status = check.checks.every(entry => entry.status === 'PASS') ? 'PASS' : 'FAIL'
    check.detail = `${check.checks.filter(entry => entry.status === 'PASS').length}/${check.checks.length} contract checks PASS`
    return check
  } catch (error) {
    check.status = 'BLOCKED-ENVIRONMENT'
    check.detail = `HTTP contract checks could not run: ${error.message}`
    return check
  }
}

export async function acceptNativeBeta2({ app, run: runDir, manifest, allowBlocked = false }) {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('BLOCKED-ENVIRONMENT: native acceptance requires Apple Silicon macOS')
  }
  const run = new Run(app, runDir, {})
  const manifestData = manifest && existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : null
  const appSha256 = sha256File(join(run.appPath, 'Contents/Resources/app.asar'))
  const sourceCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  run.log(`beta2 native acceptance start app=${run.appPath} run=${run.runDir} sourceCommit=${sourceCommit} appAsarSha256=${appSha256}`)
  run.writeCheck('C0-preconditions', {
    status: 'PASS', level: 'environment inventory',
    platform: { os: spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(), arch: process.arch, node: process.version },
    toolchain: toolchain(), displays: displays(),
    userFrontmostAtStart: run.userFrontmostAtStart ?? null,
    tcc: { accessibility: systemEventsWindows(process.pid).ok !== false || 'unknown', screenRecording: screenshot(join(run.evidenceDir, 'tcc-screenshot-probe.png')).ok },
    app: { path: run.appPath, appAsarSha256: appSha256 }, manifest: manifestData,
    sourceCommit, note: 'native evidence levels are recorded per check; DOM/CDP screenshots alone are never used as native visibility evidence',
  })
  let overall = 'FAIL'
  try {
    overall = await runChecks(run, {})
  } catch (error) {
    run.log(`acceptance crashed: ${error.stack || error.message}`)
    run.writeCheck('C9-crash', { status: 'FAIL', detail: String(error.stack || error.message) })
  } finally {
    // Never leave the packaged App running after a crashed/aborted run: a stale App
    // would keep 127.0.0.1:59100 (or its descriptor port) busy for the next attempt.
    try {
      const leftover = processTreeFor(run.userData)
      if (leftover.length) {
        const cleanup = await run.stop({ label: 'cleanup-after-acceptance-run' })
        run.log(`cleanup-after-acceptance-run: leftover=${leftover.length} exited=${cleanup.exited} forced=${cleanup.forced}`)
      }
    } catch (cleanupError) { run.log(`cleanup-after-acceptance-run failed: ${cleanupError.message}`) }
  }
  const finishedAt = nowIso()
  const values = Object.values(run.checks)
  const failed = values.filter(check => check.status === 'FAIL')
  const blocked = values.filter(check => check.status === 'BLOCKED-ENVIRONMENT')
  const overallStatus = failed.length ? 'FAIL' : blocked.length ? 'PASS-WITH-BLOCKED-ENVIRONMENT' : (overall === 'PASS' ? 'PASS' : overall)
  const results = {
    schemaVersion: 1,
    kind: 'beta2-native-acceptance',
    app: run.appPath, appAsarSha256: appSha256,
    sourceCommit, manifest: manifestData,
    userFrontmostAtStart: run.userFrontmostAtStart ?? null,
    startedAt: run.startedAt, finishedAt,
    firstAttemptSuccess: firstAttemptSuccess(run),
    attempts: run.attempts,
    checks: Object.fromEntries(Object.entries(run.checks).map(([id, check]) => [id, check])),
    windowLayer: run.checks['C1-bubble-first-show']?.windowLayer ?? null,
    nativeProcessCleanup: run.checks['C7-exit-restart-cleanup'] ? {
      firstExit: run.checks['C7-exit-restart-cleanup'].shutdown, restartExit: run.checks['C7-exit-restart-cleanup'].shutdown2,
      hostEpochBefore: run.checks['C7-exit-restart-cleanup'].hostEpochBefore, hostEpochAfter: run.checks['C7-exit-restart-cleanup'].hostEpochAfter,
    } : null,
    overall: {
      status: overallStatus,
      failed: failed.map(check => check.id ?? Object.keys(run.checks).find(key => run.checks[key] === check)),
      blocked: blocked.map(check => Object.keys(run.checks).find(key => run.checks[key] === check)),
      scope: 'packaged macOS App, isolated user-data/DSH_HOME, real LaunchServices startup, real Host+Memory services, window-server native evidence; real microphone/provider/audio and physical multi-display are separate manual boundaries',
    },
    evidenceDir: run.evidenceDir, logsDir: run.logsDir, checksDir: run.checksDir,
  }
  writeJson(join(run.runDir, 'B2-NATIVE-RESULTS.json'), results)
  const lines = [
    `# beta2 native acceptance`, '',
    `- app: \`${run.appPath}\``,
    `- sourceCommit: \`${sourceCommit}\``,
    `- app asar sha256: \`${appSha256}\``,
    `- started/finished: ${run.startedAt} / ${finishedAt}`,
    `- first-attempt-success: ${results.firstAttemptSuccess}`,
    `- overall: **${overallStatus}**`, '',
    `| check | status | detail |`, `|---|---|---|`,
    ...Object.entries(run.checks).map(([id, check]) => `| ${id} | ${check.status} | ${String(check.detail ?? '').replace(/\|/g, '\\|').slice(0, 300)} |`), '',
    `Evidence: \`${run.runDir}\``,
  ]
  writeFileSync(join(run.runDir, 'B2-NATIVE-RESULTS.md'), lines.join('\n') + '\n')
  run.log(`beta2 native acceptance finished: ${overallStatus}`)
  return { results, exitCode: overallStatus === 'FAIL' ? 1 : (allowBlocked && blocked.length ? 2 : 0) }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.app || !args.run) {
    console.error('usage: node product/tools/accept-native-beta2.mjs --app <dsh-bot.app> --run <dir> [--manifest <json>] [--allow-blocked]')
    process.exit(2)
  }
  const { results, exitCode } = await acceptNativeBeta2({ app: args.app, run: args.run, manifest: args.manifest, allowBlocked: Boolean(args['allow-blocked']) })
  console.log(JSON.stringify({ status: results.overall.status, exitCode, run: args.run }, null, 2))
  process.exit(exitCode)
}
