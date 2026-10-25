// 全局「按住 Option/Alt 说话」：macOS CGEventSourceKeyState 轮询。
//
// 背景：Electron 的 globalShortcut 不能注册纯修饰键，也没有全局 keyup，
// 所以「未聚焦时按住 Option」在 round1 只能降级成 Alt+Space 开关。round2
// 用 koffi FFI 直接问 macOS：
//
//   CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, keycode)
//
// 左 Option = 58，右 Option = 61。每 ~60ms 读一次，按下/松开产生边沿事件。
// koffi 是原生模块，dev 阶段从 research/qwen-audio-agent 或 nisse-dsh 的
// pnpm store 绝对路径 require；打包前需要把 koffi 内置进桌宠包（写进报告）。
//
// 纯逻辑在 createGlobalOptionWatcher（注入 readPressed/计时器，可单测）；
// loadGlobalOptionKeyState 负责 koffi/框架加载与失败降级（返回 available:false，
// 主进程据此回退到 Alt+Space 并让提示文案显示实际按键）。

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'

export const OPTION_KEYCODES = Object.freeze({ left: 58, right: 61 })
/** kCGEventSourceStateCombinedSessionState */
export const COMBINED_SESSION_STATE = 0
export const DEFAULT_OPTION_POLL_MS = 60
export const DEFAULT_OPTION_STABLE_POLLS = 2

export const FRAMEWORK_PATHS = Object.freeze([
  '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices',
  '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics',
])

export const DEFAULT_KOFFI_CANDIDATES = Object.freeze([
  // 打包后放到桌宠自己的 node_modules 里（首选）
  '$HOME/projects/dsh-bot-workspace/m3/pet/desktop/node_modules/koffi',
  // dev 期实际可用的位置（nisse-dsh 的 pnpm store）
  '$HOME/projects/dsh-bot/node_modules/.pnpm/koffi@3.1.1/node_modules/koffi',
  // 任务书给的 research 路径（当前机器上没有，保留兼容）
  '$HOME/projects/dsh-bot-workspace/research/qwen-audio-agent/node_modules/koffi',
])

/** Candidate koffi module paths: env override first, then the known dev paths. */
export function koffiCandidates(env = process.env) {
  const fromEnv = String(env?.NISSE_KOFFI_PATH || '').trim()
  return (fromEnv ? [fromEnv, ...DEFAULT_KOFFI_CANDIDATES] : [...DEFAULT_KOFFI_CANDIDATES])
}

function messageOf(error) {
  return String(error?.message || error || 'unknown error')
}

/**
 * Load koffi + CGEventSourceKeyState.
 *
 * Never throws: a missing/incompatible koffi (or a non-darwin host) returns
 * `{ available: false, error }` so the body runtime can fall back to a
 * globalShortcut combo instead of breaking voice input.
 *
 * @param {object} [options]
 * @param {string} [options.platform] defaults to process.platform
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(id: string) => any} [options.requireImpl]
 * @param {readonly string[]} [options.candidates]
 * @param {readonly string[]} [options.frameworks]
 * @param {{info?: Function, warn?: Function}} [options.logger]
 * @returns {{available: boolean, readKeyState?: () => boolean, readKey?: (keycode: number) => boolean, koffiPath?: string, frameworkPath?: string, koffiVersion?: string, error?: string, probe?: boolean}}
 */
export function loadGlobalOptionKeyState({
  platform = process.platform,
  env = process.env,
  requireImpl = createRequire(import.meta.url),
  candidates = koffiCandidates(env),
  frameworks = FRAMEWORK_PATHS,
  exists = existsSync,
  logger = null,
} = {}) {
  if (platform !== 'darwin') {
    return { available: false, error: `unsupported platform: ${platform}` }
  }
  const failures = []
  let koffi = null
  let koffiPath = ''
  for (const candidate of candidates) {
    try {
      if (exists(candidate) === false) {
        failures.push(`${candidate}: not found`)
        continue
      }
      koffi = requireImpl(candidate)
      koffiPath = candidate
      break
    } catch (error) {
      failures.push(`${candidate}: ${messageOf(error).slice(0, 160)}`)
    }
  }
  if (!koffi) {
    return { available: false, error: `koffi unavailable (${failures.join(' | ').slice(0, 400)})` }
  }
  let koffiVersion = ''
  try {
    koffiVersion = String(requireImpl(`${koffiPath}/package.json`)?.version || '')
  } catch {
    koffiVersion = ''
  }
  for (const frameworkPath of frameworks) {
    try {
      const library = koffi.load(frameworkPath)
      const keyState = library.func('bool CGEventSourceKeyState(int state, uint16 keycode)')
      const readKey = keycode => Boolean(keyState(COMBINED_SESSION_STATE, Number(keycode)))
      // 立即探测一次：证明导出与调用都可用（不要求此刻真的按着 Option）。
      const probe = readKey(OPTION_KEYCODES.left) || readKey(OPTION_KEYCODES.right)
      logger?.info?.('global_option.loaded', {
        koffiPath,
        koffiVersion,
        frameworkPath,
        probe,
      })
      return {
        available: true,
        readKeyState: () => readKey(OPTION_KEYCODES.left) || readKey(OPTION_KEYCODES.right),
        readKey,
        koffiPath,
        koffiVersion,
        frameworkPath,
        probe,
      }
    } catch (error) {
      failures.push(`${frameworkPath}: ${messageOf(error).slice(0, 160)}`)
    }
  }
  return {
    available: false,
    koffiPath,
    koffiVersion,
    error: `CGEventSourceKeyState unavailable (${failures.join(' | ').slice(0, 400)})`,
  }
}

/**
 * Edge detector over a polled boolean.
 *
 * `stablePolls` consecutive equal readings are required before a transition is
 * reported (default 2 → ~120ms at 60ms polling), which filters FFI/event-state
 * jitter without affecting normal hold-to-talk latency.
 *
 * @param {object} options
 * @param {() => boolean} options.readPressed
 * @param {number} [options.pollMs]
 * @param {number} [options.stablePolls]
 * @param {() => void} [options.onDown]
 * @param {() => void} [options.onUp]
 * @param {(error: Error) => void} [options.onError]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createGlobalOptionWatcher({
  readPressed,
  pollMs = DEFAULT_OPTION_POLL_MS,
  stablePolls = DEFAULT_OPTION_STABLE_POLLS,
  onDown = () => {},
  onUp = () => {},
  onError = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = handle => clearInterval(handle),
  logger = null,
} = {}) {
  if (typeof readPressed !== 'function') throw new TypeError('readPressed is required')
  const interval = Math.max(20, Math.round(Number(pollMs) || DEFAULT_OPTION_POLL_MS))
  const required = Math.max(1, Math.floor(Number(stablePolls) || 1))
  let timer = null
  let pressed = false
  let candidate = false
  let candidateCount = 0
  let polls = 0
  let errors = 0
  let downCount = 0
  let upCount = 0
  let lastChangeAt = 0
  let lastError = ''

  function tick() {
    polls += 1
    let reading
    try {
      reading = readPressed() === true
    } catch (error) {
      errors += 1
      lastError = messageOf(error)
      logger?.warn?.('global_option.poll_failed', { error: lastError.slice(0, 160) })
      if (errors <= 3) onError?.(error)
      return { pressed, changed: false }
    }
    if (reading === candidate) {
      candidateCount = Math.min(required, candidateCount + 1)
    } else {
      candidate = reading
      candidateCount = 1
    }
    if (candidateCount < required || candidate === pressed) {
      return { pressed, changed: false }
    }
    pressed = candidate
    lastChangeAt = now()
    if (pressed) {
      downCount += 1
      logger?.info?.('global_option.down', { polls })
      onDown()
    } else {
      upCount += 1
      logger?.info?.('global_option.up', { polls })
      onUp()
    }
    return { pressed, changed: true }
  }

  return {
    start() {
      if (timer) return
      timer = setTimer(tick, interval)
      timer?.unref?.()
    },
    stop() {
      if (!timer) return
      clearTimer(timer)
      timer = null
      candidate = false
      candidateCount = 0
    },
    tick,
    /** test/smoke helper: force the internal pressed state without FFI */
    _forceState(value) {
      pressed = value === true
      candidate = pressed
      candidateCount = 0
    },
    state() {
      return {
        running: Boolean(timer),
        pressed,
        polls,
        errors,
        downCount,
        upCount,
        lastChangeAt,
        lastError,
        pollMs: interval,
        stablePolls: required,
      }
    },
  }
}
