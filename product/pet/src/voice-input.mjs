// 语音输入（Body Runtime）：说话键、收听模式、输入气泡与错误气泡。
//
// 产品规则：语音链路由桌面壳的 gateway 持有，协议保持不变；桌宠只做
// OS 级身体（悬停麦克风按钮、说话键、识别文字气泡）。这个模块保持纯函数：
// 不 import electron、不碰计时器、不发网络请求，主进程/渲染层各自接线。
//
// 关于「全局按住 Option/Alt」的平台限制（已写进 evidence 的已知限制）：
// Electron 的 globalShortcut 只能注册带主键的组合（"Alt" 单独不是合法
// accelerator，也没有全局 keyup 回调），鼠标侧键同样没有全局监听。因此：
//   - 桌宠窗口获得焦点时（点击桌宠即聚焦），渲染层监听真实 keydown/keyup，
//     "按住 Option/Alt" 语义完整可用；
//   - 未聚焦时用可配置的全局组合键兜底（默认 Alt+Space）：按一次开始、
//     再按一次结束（等价于 hold 的降级），并带最长时长自动停止；
//   - 真正全局的「按住修饰键」需要原生事件 tap（Accessibility 权限），
//     属于壳侧/后续工作，不在此伪造。

export const VOICE_INPUT_MODES = Object.freeze(['hold', 'toggle', 'always'])

export const DEFAULT_VOICE_INPUT = Object.freeze({
  mode: 'hold',
  keyId: 'alt',
  fallbackAccelerator: 'Alt+Space',
  // 全局兜底「按住」无法感知松开：自动结束，避免麦克风一直开着。
  holdMaxMs: 15_000,
})

/**
 * 说话键预设。`rendererKey` 是渲染层可以监听的真实键盘按键（桌宠聚焦时），
 * `accelerator` 是 Electron globalShortcut 可注册的全局兜底组合。
 */
export const TALK_KEY_PRESETS = Object.freeze([
  Object.freeze({
    id: 'alt',
    label: 'Option / Alt（桌宠聚焦时按住）',
    rendererKey: 'Alt',
    accelerator: '',
  }),
  Object.freeze({
    id: 'alt-space',
    label: 'Alt+Space（全局）',
    rendererKey: null,
    accelerator: 'Alt+Space',
  }),
  Object.freeze({
    id: 'ctrl-shift-space',
    label: 'Control+Shift+Space（全局）',
    rendererKey: null,
    accelerator: 'Control+Shift+Space',
  }),
  Object.freeze({
    id: 'mouse4',
    label: '鼠标侧键 4（悬停桌宠时）',
    rendererKey: null,
    mouseButton: 3,
  }),
  Object.freeze({
    id: 'mouse5',
    label: '鼠标侧键 5（悬停桌宠时）',
    rendererKey: null,
    mouseButton: 4,
  }),
])

export function talkKeyPresetOf(id) {
  const wanted = String(id || '').trim()
  return TALK_KEY_PRESETS.find(preset => preset.id === wanted) || TALK_KEY_PRESETS[0]
}

/** Normalize a stored/partial voice-input preference document. */
export function normalizeVoiceInput(raw) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const mode = VOICE_INPUT_MODES.includes(String(value.mode || ''))
    ? String(value.mode)
    : DEFAULT_VOICE_INPUT.mode
  const keyId = talkKeyPresetOf(value.keyId).id
  const fallback = String(value.fallbackAccelerator || '').trim()
  const holdMaxMs = Number(value.holdMaxMs)
  return {
    mode,
    keyId,
    fallbackAccelerator: fallback || DEFAULT_VOICE_INPUT.fallbackAccelerator,
    holdMaxMs: Number.isFinite(holdMaxMs) && holdMaxMs >= 2_000
      ? Math.min(Math.round(holdMaxMs), 120_000)
      : DEFAULT_VOICE_INPUT.holdMaxMs,
    // 首启提示只显示一次；用户开始说话/点过麦克风后置 true（持久化在 pet prefs）。
    hintSeen: value.hintSeen === true,
  }
}

/**
 * Which physical gesture actually controls listening right now.
 *
 * - `global-option`：koffi + CGEventSourceKeyState 可用 → 真·全局按住 Option
 * - `accelerator`：koffi 不可用 → 退回可注册的全局组合键（按一次开始/结束）
 * - `mouse`：鼠标侧键（悬停桌宠时）
 * - `focused`：桌宠聚焦时的真实按键
 */
export function effectiveTalkKey({ settings, globalOption = null } = {}) {
  const value = normalizeVoiceInput(settings)
  const preset = talkKeyPresetOf(value.keyId)
  const mode = value.mode
  if (preset.id === 'alt' && globalOption?.available === true) {
    return { source: 'global-option', keyId: preset.id, mode, displayKey: 'Option/Alt', global: true }
  }
  if (preset.id === 'alt') {
    return { source: 'accelerator', keyId: preset.id, mode, displayKey: value.fallbackAccelerator, global: true }
  }
  if (preset.mouseButton !== undefined) {
    return { source: 'mouse', keyId: preset.id, mode, displayKey: preset.label, global: false, mouseButton: preset.mouseButton }
  }
  if (preset.accelerator) {
    return { source: 'accelerator', keyId: preset.id, mode, displayKey: preset.accelerator, global: true }
  }
  return { source: 'focused', keyId: preset.id, mode, displayKey: preset.rendererKey || preset.label, global: false }
}

/**
 * 提示文案必须与实际生效的按键一致（底部徽章 / hover 提示 / 托盘共用）。
 * @returns {{text: string, source: string, displayKey: string, global: boolean}}
 */
export function talkKeyHint({ settings, globalOption = null } = {}) {
  const effective = effectiveTalkKey({ settings, globalOption })
  const mode = effective.mode
  if (mode === 'always') {
    return { ...effective, text: '一直听（点麦克风可暂停）' }
  }
  if (effective.source === 'global-option') {
    return {
      ...effective,
      // 徽章宽度只有 ~158 CSS px：文案保持一行；“全局”信息由 source/托盘承载。
      text: mode === 'hold' ? '按住 Option/Alt 说话' : '按一下 Option/Alt 切换',
    }
  }
  if (effective.source === 'accelerator') {
    return { ...effective, text: `按 ${effective.displayKey} 开始/结束收听（全局）` }
  }
  if (effective.source === 'mouse') {
    return { ...effective, text: `${effective.displayKey}（悬停桌宠时）` }
  }
  return { ...effective, text: `按住 ${effective.displayKey} 说话（桌宠聚焦时）` }
}

/** One JSON-safe snapshot for the smoke status file / tray tooltip. */
export function talkKeyStatusPayload({ settings, globalOption = null, accelerator = '', registered = false } = {}) {
  const hint = talkKeyHint({ settings, globalOption })
  return {
    mode: hint.mode,
    keyId: hint.keyId,
    source: hint.source,
    displayKey: hint.displayKey,
    hint: hint.text,
    global: hint.global,
    accelerator,
    registered: registered === true,
    globalOption: {
      available: globalOption?.available === true,
      frameworkPath: globalOption?.frameworkPath || '',
      koffiPath: globalOption?.koffiPath || '',
      koffiVersion: globalOption?.koffiVersion || '',
      error: globalOption?.error || '',
    },
  }
}

export function talkKeyDescription(settings) {
  const value = normalizeVoiceInput(settings)
  const preset = talkKeyPresetOf(value.keyId)
  const modeLabel = {
    hold: '按住说话',
    toggle: '按一下切换',
    always: '一直听',
  }[value.mode]
  const suffix = preset.accelerator && preset.accelerator !== value.fallbackAccelerator
    ? ` · 全局 ${value.fallbackAccelerator}`
    : ''
  return `${modeLabel} · ${preset.label}${suffix}`
}

/**
 * One talk gesture → the mic action the renderer must apply.
 *
 * `phase` is 'down' (press / modifier down / mouse-button down) or 'up'
 * (release). `enabled` is what the renderer reports right now.
 */
export function talkGestureCommand({ mode, phase, enabled }) {
  const current = enabled === true
  if (mode === 'always') return { action: null, nextEnabled: current }
  if (mode === 'toggle') {
    if (phase !== 'down') return { action: null, nextEnabled: current }
    return current
      ? { action: 'disable', nextEnabled: false }
      : { action: 'enable', nextEnabled: true }
  }
  // hold (default)
  if (phase === 'down') {
    return current ? { action: null, nextEnabled: true } : { action: 'enable', nextEnabled: true }
  }
  if (phase === 'up') {
    return current ? { action: 'disable', nextEnabled: false } : { action: null, nextEnabled: false }
  }
  return { action: null, nextEnabled: current }
}

/** Whether the global fallback key may start/stop a pseudo-hold session. */
export function globalFallbackNext({ enabled, holdActive }) {
  if (!enabled) return { action: 'enable', holdActive: true }
  if (holdActive) return { action: 'disable', holdActive: false }
  return { action: 'disable', holdActive: false }
}

/** Mic hover button state for the injected renderer overlay. */
export function micButtonState({ enabled, waiting = false, mode = 'hold' }) {
  if (waiting) return { label: '取消等待语音', state: 'waiting', active: false }
  if (enabled) return { label: '麦克风静音（正在听）', state: 'listening', active: true }
  return {
    label: mode === 'always' ? '开启麦克风（一直听）' : '开启麦克风',
    state: 'muted',
    active: false,
  }
}

/** Soft status bubble shown after the talk key changes the mic state. */
export function voiceStatusBubble({ enabled, mode }) {
  const text = enabled
    ? (mode === 'always' ? '一直听着呢。' : '在听，请说。')
    : '好，先不听。'
  return { kind: 'status', icon: enabled ? '🎙️' : '🔇', text }
}

const ERROR_KINDS = Object.freeze({
  missing_key: {
    icon: '🔑',
    text: '语音还没配置好：去 DSH 设置 → Bot 填语音 API Key，再回来找我。',
  },
  gateway_down: {
    icon: '📡',
    text: '语音服务还没起来：包内语音 worker 未运行。重启应用后再试。',
  },
  network: {
    icon: '🌐',
    text: '连不上语音服务：网络或服务地址有问题。检查网络后重试，或去 DSH 设置 → Bot 改语音服务地址。',
  },
  auth: {
    icon: '🔑',
    text: '语音 API Key 无效或过期。去 DSH 设置 → Bot 换一个有效的 Key。',
  },
  model: {
    icon: '🧩',
    text: '语音模型不可用：所选 provider 不支持这个模型，去 DSH 设置 → Bot 换一个模型。',
  },
  unsupported: {
    icon: '🔇',
    text: '当前环境不支持麦克风输入（缺设备或被拒绝授权）。在系统设置里允许麦克风后重试。',
  },
  unknown: {
    icon: '⚠️',
    text: '语音出错了。稍后重试，或去 DSH 设置 → Bot 检查语音配置。',
  },
})

/**
 * Map a raw gateway/shell error to one readable, Chinese bubble.
 *
 * @param {'missing_key'|'gateway_down'|'network'|'auth'|'model'|'unsupported'|'unknown'|string} kind
 * @param {string} [detail] the provider's own text (already safe to display)
 */
export function voiceErrorBubble(kind, detail = '') {
  const template = ERROR_KINDS[kind] || ERROR_KINDS.unknown
  const suffix = String(detail || '').trim().slice(0, 120)
  return {
    kind: 'error',
    icon: template.icon,
    text: suffix ? `${template.text}\n（${suffix}）` : template.text,
  }
}

/** Classify a gateway/voice error string into one of the readable kinds. */
export function classifyVoiceError(raw) {
  const text = String(raw || '')
  if (!text) return 'unknown'
  if (/missing api key|缺少 api key|api key is required|no api key/i.test(text)) return 'missing_key'
  if (/permission|notallowed|not allowed|tcc|麦克风权限|device_missing|device_unavailable/i.test(text)) return 'unsupported'
  if (/401|403|unauthorized|invalid.*key|key.*invalid|鉴权/i.test(text)) return 'auth'
  if (/404|model.*(?:not|un)available|model.*not found|模型不可用|unknown model/i.test(text)) return 'model'
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timeout|超时|network|网络/i.test(text)) return 'network'
  return 'unknown'
}

/**
 * Recognizing text → the grey input bubble shown while the user speaks.
 * `kind: 'input'` makes the bubble renderer use the grey style + 取消 button.
 */
export function recognizingInputBubble(text, { fading = false } = {}) {
  const value = String(text || '').trim().slice(0, 200)
  return {
    kind: 'input',
    icon: '🎙️',
    text: value || '在听…',
    inputLabel: '识别中',
    cancel: { id: 'cancel-voice', label: '取消' },
    fading,
  }
}

/** After the turn starts, echo the user's recognised text as a grey input bubble. */
export function sentInputBubble(text) {
  const value = String(text || '').trim().slice(0, 200)
  if (!value) return null
  return {
    kind: 'input',
    icon: '💬',
    text: value,
    inputLabel: '你说',
    fading: true,
  }
}

/** Whether a renderer orb-bubble payload is the live recognition text. */
export function isRecognizingBubble(payload) {
  return Boolean(payload && payload.visible === true && payload.kind === 'listening')
}

/** First line of a Chinese explanation for the onboarding voice step. */
export function voiceProviderChoices(catalog) {
  return (Array.isArray(catalog) ? catalog : []).map(provider => ({
    id: String(provider.id || ''),
    label: String(provider.label || provider.id || ''),
  })).filter(choice => choice.id !== '')
}
