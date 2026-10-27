// 用户键鼠接管：仅由产品策略许可的桌面 turn 可停止；语音 turn 不参与。
//
// 实现约束（本机可用的 Electron API）：没有全局键鼠事件回调，但
// `powerMonitor.getSystemIdleTime()` 给出「系统空闲秒数」——用户按下键/移动
// 鼠标会把它清零。因此：
//   - 只在 turn 运行中轮询（<=2s 视为「刚有输入」）；
//   - turn 开始后留 grace（默认 2.5s），避开「刚点发送」的余温；
//   - 通过 idle 从大变小（或被持续清零）判断「新的用户输入」；
//   - 触发一次就调 bridge POST /cancel，并显示「已暂停，等你」。
//
// 桌宠自己播放动画/气泡不产生键鼠输入，所以不会被误判。纯逻辑，不 import
// electron：主进程把 powerMonitor 读数 + 计时器注入进来，测试注入假时钟。

export const DEFAULT_PAUSE_IDLE_SECONDS = 1.5
export const DEFAULT_PAUSE_POLL_MS = 1_000
export const DEFAULT_PAUSE_GRACE_MS = 2_500

/**
 * 「刚有用户输入吗？」—— idle 秒数从高于阈值跌到阈值内，或持续处于阈值内，
 * 都算。previous 为 null 时（首个采样）只看当前值。
 */
export function detectUserInputActivity({
  idleSeconds,
  previousIdleSeconds,
  thresholdSeconds = DEFAULT_PAUSE_IDLE_SECONDS,
} = {}) {
  if (idleSeconds === null || idleSeconds === undefined) return false
  const idle = Number(idleSeconds)
  if (!Number.isFinite(idle) || idle < 0) return false
  const threshold = Number.isFinite(Number(thresholdSeconds))
    ? Math.max(0.2, Number(thresholdSeconds))
    : DEFAULT_PAUSE_IDLE_SECONDS
  const previous = previousIdleSeconds === null || previousIdleSeconds === undefined
    ? null
    : Number(previousIdleSeconds)
  if (idle > threshold) return false
  if (previous === null || !Number.isFinite(previous)) return true
  // 刚产生一次输入：idle 被清零/明显回落。
  if (idle < previous - 0.4) return true
  // 用户在持续操作：连续多次采样都在阈值内。
  return previous <= threshold
}

/** Voice turns and talk gestures never participate in keyboard/mouse takeover.
 * @param {object} options Current preferences, turn origin and gesture activity.
 * @returns {boolean} Whether idle monitoring may stop this turn.
 */
export function canPauseDesktopTurn({ behavior, turn, inputActive = false }) {
  return behavior?.pauseOnInput !== false && turn?.inputSource !== 'voice' && !turn?.waiting && !inputActive
}

/**
 * Idle-pause monitor. Injected deps keep it deterministic:
 * @param {object} options
 * @param {() => number|null} options.getIdleSeconds
 * @param {() => boolean} options.isTurnActive
 * @param {() => number} [options.getTurnStartedAt]
 * @param {() => boolean} [options.shouldPause] extra policy (config behavior.pauseOnInput)
 * @param {(detail: object) => void} options.onPause
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {(handle: unknown) => void} [options.clearTimer]
 */
export function createPauseOnInputMonitor(options = {}) {
  const {
    getIdleSeconds,
    isTurnActive,
    getTurnStartedAt = () => 0,
    shouldPause = () => true,
    onPause = () => {},
    now = () => Date.now(),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = handle => clearInterval(handle),
    pollMs = DEFAULT_PAUSE_POLL_MS,
    thresholdSeconds = DEFAULT_PAUSE_IDLE_SECONDS,
    graceMs = DEFAULT_PAUSE_GRACE_MS,
    logger = null,
  } = options
  if (typeof getIdleSeconds !== 'function') throw new TypeError('getIdleSeconds is required')
  if (typeof isTurnActive !== 'function') throw new TypeError('isTurnActive is required')

  let timer = null
  let previousIdle = null
  let pauses = 0
  let lastPause = null
  let observedTurn = null, fired = false

  function reset() {
    previousIdle = null
    observedTurn = null; fired = false
  }

  function tick(nowMs = now()) {
    if (!isTurnActive()) {
      reset()
      return { paused: false, reason: 'no-turn' }
    }
    const startedAt = Number(getTurnStartedAt()) || 0
    if (observedTurn !== startedAt) { observedTurn = startedAt; previousIdle = null; fired = false }
    if (fired) return { paused: false, reason: 'already-stopped' }
    const withinGrace = startedAt > 0 && nowMs - startedAt < graceMs
    const idle = Number(getIdleSeconds())
    if (!Number.isFinite(idle) || idle < 0) {
      previousIdle = null
      return { paused: false, reason: 'idle-unavailable' }
    }
    if (withinGrace) {
      previousIdle = idle
      return { paused: false, reason: 'grace' }
    }
    const active = detectUserInputActivity({
      idleSeconds: idle,
      previousIdleSeconds: previousIdle,
      thresholdSeconds,
    })
    previousIdle = idle
    if (!active) return { paused: false, reason: 'idle' }
    if (!shouldPause()) {
      previousIdle = idle
      return { paused: false, reason: 'disabled' }
    }
    fired = true
    pauses += 1
    lastPause = { at: nowMs, idleSeconds: idle }
    try {
      onPause({ idleSeconds: idle, at: nowMs })
    } catch (error) {
      logger?.warn?.('pause.on_pause_failed', { error: String(error?.message || error) })
    }
    return { paused: true, reason: 'user-input', idleSeconds: idle }
  }

  return {
    start() {
      if (timer) return
      timer = setTimer(() => tick(), Math.max(200, Math.round(pollMs)))
      timer?.unref?.()
    },
    stop() {
      if (!timer) return
      clearTimer(timer)
      timer = null
      reset()
    },
    tick,
    state() {
      return { running: Boolean(timer), previousIdle, pauses, lastPause, thresholdSeconds, graceMs, pollMs }
    },
  }
}

/** Read `behavior.pauseOnInput` from the shell Bot config view (default on). */
export function pauseOnInputEnabled(config) {
  const behavior = config && typeof config === 'object' ? config.behavior : null
  if (!behavior || typeof behavior !== 'object') return true
  return behavior.pauseOnInput !== false
}

/** Bubble payload shown after a pause. */
export function pausedBubble() {
  return {
    kind: 'status',
    icon: '⏸️',
    text: '已停止当前任务，等你。想做别的直接说。',
  }
}

/** Bubble payload when the cancel request itself fails. */
export function pauseFailedBubble(detail = '') {
  const suffix = String(detail || '').trim().slice(0, 100)
  return {
    kind: 'error',
    icon: '⚠️',
    text: suffix ? `想暂停但没停成：${suffix}` : '想暂停但没停成，稍后再试。',
  }
}
