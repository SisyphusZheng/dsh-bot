// WhaleGirl Bot — Body Runtime (pet side).
//
// Product rule: DSH is the only agent/chat/session owner. This Electron app is
// the OS-level body the desktop shell spawns:
//   - transparent, always-on-top whale-girl orb: animation, drag, position
//     memory, wake word, voice I/O (owned by the shell's gateway);
//   - head bubble: DSH turn text + approval 是/否 buttons;
//   - bridge polling of the shell's host-integration /events;
//   - double-click → POST /bot/toggle-main on the shell (W6).
//
// W1 removed the legacy qwen desktop surfaces: no settings window, no chat /
// conversation panel, no onboarding/first-run window, no independent session.
// Settings live in DSH Settings → Bot; chat owns DSH sessions.
//
// Bridge mode (NISSE_BRIDGE_ONLY=1, how the desktop shell spawns this app):
// the shell owns the voice gateway and passes its origin in
// QWEN_AUDIO_AGENT_URL; this process never starts an embedded gateway.

import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createLogger } from '../../shared/logger.mjs'
import { userConfigDirectory } from '../../shared/runtime-paths.mjs'
import {
  desktopOrbUrl,
  isSafeExternalUrl,
  isSameOrigin,
} from './security.mjs'
import {
  desktopTranslator,
  effectiveDesktopLanguage,
} from './i18n.mjs'
import {
  DESKTOP_ORB_HEIGHT,
  DESKTOP_ORB_WIDTH,
  desktopOrbBounds,
  desktopSurfaceLayout,
} from './desktop-surface-layout.mjs'
import {
  createBubbleWindowController,
  orbBubbleHeadroom,
  orbBubbleWindowBounds,
} from './bubble-window.mjs'
import { createOrbPlacement } from './orb-placement.mjs'
import { bindOrbShell, configureOrbWindow } from './orb-shell.mjs'
import { createSettingsStore } from './settings-store.mjs'
import { desktopClientPaths } from './client-paths.mjs'
import { DesktopWakeWordRuntime } from './wake-word/runtime.mjs'
import {
  DEFAULT_WAKE_WORD_PHRASE,
  wakeWordKeywordsLine,
} from './wake-word/keyword-phrase.mjs'
import { effectiveOrbSkin as resolveEffectiveOrbSkin } from './skin-store.mjs'
import { startDesktopRendererServer } from './renderer-server.mjs'
import { createGracefulShutdown } from './graceful-shutdown.mjs'
import { createVoiceWorkerRuntime } from './voice-worker-runtime.mjs'
import { DesktopPresence } from './desktop-presence.mjs'
import { nisseBridgeFile } from './nisse-bridge.mjs'
import {
  BRIDGE_FILE_ENV,
  approvalBubblePayload,
  bridgeEventToBubble,
  bridgeEventsEndpoint,
  bridgeGatewayOrigin,
  isBridgeOnly,
  nextBridgeSeq,
  parseBridgeDescriptor,
  readBotConfig,
  readBotRuntimeStatus,
  requestBridgeCancel,
  requestMainToggle,
  requestOpenDshSettings,
  resolveShellControlUrl,
  sendApprovalDecision,
  testLlmConnection,
  testVoiceConnection,
  updateBotConfig,
} from './body-runtime.mjs'
import { normalizeBubblePayload } from './bubble-payload.mjs'
import {
  createGlobalOptionWatcher,
  loadGlobalOptionKeyState,
} from './global-option.mjs'
import { createExperienceStore } from './experience-store.mjs'
import {
  configEditFromProgress,
  llmSectionOf,
  normalizeProgress,
  onboardingResumeLabel,
  onboardingView,
  reduceOnboarding,
  shouldAutoStart,
  startProgress,
  voiceSectionOf,
} from './onboarding.mjs'
import {
  createPauseOnInputMonitor,
  pauseFailedBubble,
  pauseOnInputEnabled,
  pausedBubble,
} from './pause-on-input.mjs'
import {
  activityBubblePayload,
  activityEndsTurn,
  ACTIVITY_HOLD_MS,
} from './activity-bubble.mjs'
import {
  TALK_KEY_PRESETS,
  classifyVoiceError,
  DEFAULT_VOICE_INPUT,
  isRecognizingBubble,
  normalizeVoiceInput,
  recognizingInputBubble,
  sentInputBubble,
  talkKeyHint,
  talkKeyPresetOf,
  talkKeyStatusPayload,
  voiceErrorBubble,
  voiceStatusBubble,
} from './voice-input.mjs'

// Gateway paths belong to the Gateway; Electron's userData holds only client
// preferences, presentation assets and local caches.
app.setName('Nisse')
const clientPaths = desktopClientPaths(app.getPath('userData'))

// G0 voice spike test mode only (default off): fake media devices for unattended runs.
if (process.env.WG_G0_FAKE_MEDIA === '1') {
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  // Unattended G0 runs have no user gesture; allow WebAudio playback so the
  // media pipeline can initialise without a click.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
}

const here = dirname(fileURLToPath(import.meta.url))
const sourceRoot = resolve(here, '../..')
const voiceProjectRoot = app.isPackaged ? app.getAppPath() : resolve(here, '../../../..')
const bridgeOnly = isBridgeOnly(process.env)
const logger = createLogger({
  component: 'desktop',
  fileName: 'desktop.log',
  directory: clientPaths.logDirectory,
})
// Pipecat worker lifecycle is feature-flagged; legacy Qwen gateway remains the
// product default. This only manages the worker process, not the renderer
// protocol (attached in a later increment).
const voiceWorkerRuntime = createVoiceWorkerRuntime({
  env: process.env,
  projectRoot: voiceProjectRoot,
  logger: {
    info: (message, detail) => logger.info(message, detail),
    warn: (message, detail) => logger.warn(message, detail),
  },
})
let voiceWorkerStartPromise = Promise.resolve(voiceWorkerRuntime.snapshot())
const skinsRoot = clientPaths.skinsDirectory

// Client-owned preferences (orb skin/position, wake word, language). Settings
// themselves live in DSH; the pet only reads the presentation subset it needs.
const desktopSettingsStore = createSettingsStore({
  configDir: userConfigDirectory(process.env),
  clientDir: clientPaths.directory,
})

const DEFAULT_CLIENT_PREFERENCES = Object.freeze({
  language: 'zh',
  gatewayUrl: 'http://127.0.0.1:3101',
  orbSkin: 'whale-girl',
  autoHideSeconds: 0,
  wakeShortcut: 'CommandOrControl+Shift+Space',
  wakeWordEnabled: false,
  wakeWordPhrase: DEFAULT_WAKE_WORD_PHRASE,
})

function loadClientPreferences() {
  try {
    const settings = desktopSettingsStore.load()
    return {
      language: settings.language,
      gatewayUrl: settings.gatewayUrl,
      orbSkin: settings.orbSkin,
      autoHideSeconds: settings.autoHideSeconds,
      wakeShortcut: settings.wakeShortcut,
      wakeWordEnabled: settings.wakeWordEnabled,
      wakeWordPhrase: settings.wakeWordPhrase,
    }
  } catch (error) {
    logger.warn('desktop.client_preferences_fallback', { error: String(error?.message || error) })
    return { ...DEFAULT_CLIENT_PREFERENCES }
  }
}

const initialPreferences = loadClientPreferences()

// Install bundled skins into the client skin directory on startup, so the
// whale-girl skin is available (and can be the default) without a manual
// import. Copy through readFileSync/writeFileSync: packaged builds read the
// bundled skins from app.asar, and Node's cpSync cannot copy out of an asar.
function copyBundledDirectory(source, target) {
  mkdirSync(target, { recursive: true })
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = resolve(source, entry.name)
    const to = resolve(target, entry.name)
    if (entry.isDirectory()) copyBundledDirectory(from, to)
    else writeFileSync(to, readFileSync(from))
  }
}

function ensureBundledSkins() {
  const bundledRoot = resolve(sourceRoot, 'desktop/build/builtin-skins')
  if (!existsSync(bundledRoot)) return
  try {
    for (const entry of readdirSync(bundledRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const target = resolve(skinsRoot, entry.name)
      if (existsSync(resolve(target, 'pet.json'))) continue
      copyBundledDirectory(resolve(bundledRoot, entry.name), target)
      logger.info('skin.bundled_installed', { id: entry.name })
    }
  } catch (error) {
    logger.warn('skin.bundled_install_failed', { error })
  }
}
ensureBundledSkins()

const orbPlacement = createOrbPlacement({
  getDisplays: () => screen.getAllDisplays(),
  orbSize: { width: DESKTOP_ORB_WIDTH, height: DESKTOP_ORB_HEIGHT },
  loadState: () => desktopSettingsStore.orbPosition.load(),
  saveState: state => desktopSettingsStore.orbPosition.save(state),
})

// 生效皮肤：内置 id 直接用；导入皮肤缺包时回退 fluid（skin-store 单一实现）。
function effectiveOrbSkin(orbSkin) {
  return resolveEffectiveOrbSkin(orbSkin, { skinsRoot })
}

logger.info('desktop.starting', {
  version: app.getVersion(),
  packaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  bridgeOnly,
})

const fallbackPage = resolve(here, 'orb-unavailable.html')
const fallbackUrl = pathToFileURL(fallbackPage).href
const webRoot = resolve(sourceRoot, 'web/dist')
let desktopLanguage = initialPreferences.language
let desktopWakeWordEnabled = initialPreferences.wakeWordEnabled
// 唤醒词短语在 DSH 设置/Bot 配置中校验；这里只处理手工改坏配置的兜底，
// 保证应用可启动。
function resolveWakeWordKeywords(phrase, { warn = false } = {}) {
  try {
    return wakeWordKeywordsLine(phrase || DEFAULT_WAKE_WORD_PHRASE)
  } catch (error) {
    if (warn) logger.warn('wake_word.phrase_invalid', { error })
    return wakeWordKeywordsLine(DEFAULT_WAKE_WORD_PHRASE)
  }
}
let desktopWakeWordPhrase = initialPreferences.wakeWordPhrase
let desktopWakeWordKeywords = resolveWakeWordKeywords(
  desktopWakeWordPhrase,
  { warn: true },
)
const desktopText = (text, params) => desktopTranslator(
  desktopLanguage,
  app.getLocale(),
)(text, params)

const preloadPath = resolve(here, 'preload.cjs')
const bubblePreloadPath = resolve(here, 'bubble-preload.cjs')
const voiceControlsPath = resolve(here, 'voice-controls-injected.js')

/**
 * 注入到 orb 渲染层的语音输入小控制器配置。渲染层是上游构建产物（只读），
 * 说话键/悬停麦克风状态/输入气泡都通过注入层 + preload 通道完成。
 */
function currentTalkKeyHint() {
  return talkKeyHint({ settings: voiceInputSettings, globalOption: globalOptionStatus })
}

function voiceControlsConfig() {
  const preset = talkKeyPresetOf(voiceInputSettings.keyId)
  const hint = currentTalkKeyHint()
  return {
    mode: voiceInputSettings.mode,
    keyId: voiceInputSettings.keyId,
    rendererKey: preset.rendererKey || null,
    mouseButton: preset.mouseButton ?? null,
    displayKey: hint.displayKey,
    // round2：提示文案必须与实际生效按键一致；不再常驻，首启一次 + hover。
    hintText: hint.text,
    hintSource: hint.source,
    hintOnce: voiceInputSettings.hintSeen !== true,
    hintOnceMs: Number(process.env.NISSE_HINT_ONCE_MS) || 5_000,
    hintHoverMs: Number(process.env.NISSE_HINT_HOVER_MS) || 3_000,
    dryRun: process.env.NISSE_SMOKE_VOICE_DRY_RUN === '1',
    fallbackAccelerator: voiceInputSettings.fallbackAccelerator,
    globalOption: globalOptionStatus.available === true,
  }
}

function injectVoiceControls(window) {
  if (!window || window.isDestroyed()) return Promise.resolve(false)
  let script
  try {
    script = readFileSync(voiceControlsPath, 'utf8')
  } catch (error) {
    logger.warn('voice.controls_script_missing', { error: String(error?.message || error) })
    return Promise.resolve(false)
  }
  const wrapped = `window.__nisseVoiceConfig = ${JSON.stringify(voiceControlsConfig())};\n${script}`
  return window.webContents.executeJavaScript(wrapped).then(() => true).catch(error => {
    logger.warn('voice.controls_inject_failed', { error: String(error?.message || error) })
    return false
  })
}

function pushVoiceControlsConfig() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const config = voiceControlsConfig()
  void mainWindow.webContents.executeJavaScript(
    `window.__nisseVoice?.updateConfig?.(${JSON.stringify(config)}); true`,
  ).catch(() => {})
}

// The voice gateway is provided by the desktop shell (bridge mode) or by a
// separately managed Gateway for a standalone launch. The pet never spawns
// one: DSH owns the agent, and the shell owns the voice process.
let appOrigin = ''
try {
  appOrigin = bridgeGatewayOrigin(process.env, initialPreferences.gatewayUrl)
} catch (error) {
  logger.error('desktop.gateway_origin_missing', { error: String(error?.message || error) })
}
const shellControlUrl = (() => {
  try {
    return resolveShellControlUrl(process.env)
  } catch (error) {
    logger.warn('desktop.shell_control_url_invalid', { error: String(error?.message || error) })
    return ''
  }
})()
const gatewayAccessToken = String(
  process.env.QWEN_AUDIO_GATEWAY_CLIENT_TOKEN
  || process.env.QWEN_AUDIO_AGENT_ACCESS_TOKEN
  || '',
).trim()

let mainWindow = null
let rendererServer = null
let desktopTaskCount = 0
let desktopTaskPlacement = 'below'
let desktopOrbOffsetX = 0
// orb 顶边到工作区顶边的可用空间，渲染层据此决定气泡最多显示几行。
let desktopBubbleHeadroom = 0
// 头顶气泡窗口（独立 BrowserWindow，固定尺寸，不参与 orb 窗口 resize）。
let orbBubbleController = null
let orbBubblePayload = null
let reconnectTimer = null
const lastApprovalIds = new Set()
let lastShellToggle = null
let lastShellApproval = null
let bridgePollTimer = null
let bridgePollActive = false

// ---- 桌宠体验（onboarding / 语音输入 / 活动气泡 / 碰键鼠暂停）----
// 权威设置仍在 DSH（壳的 bot/config.json）；这里只维护体验态：引导进度、
// 语音输入偏好、当前 DSH turn 是否在跑、以及给 smoke/诊断用的状态。
const experienceStore = createExperienceStore({ directory: clientPaths.directory })
const storedExperience = experienceStore.load()
let onboardingProgress = storedExperience.onboarding
  ? normalizeProgress(storedExperience.onboarding)
  : null
let onboardingActive = false
let onboardingBusy = false
let voiceInputSettings = normalizeVoiceInput(storedExperience.voiceInput)
let shellConfigView = null
let shellConfigLastReadAt = 0
let lastVoiceReport = { enabled: false, waiting: false, mode: voiceInputSettings.mode, reports: 0 }
let turnActive = false
let turnStartedAt = 0
let activityHideTimer = null
let talkKeyStatus = { accelerator: '', registered: false, fallback: '', mode: voiceInputSettings.mode, keyId: voiceInputSettings.keyId }
let globalOptionStatus = { available: false, error: '', frameworkPath: '', koffiPath: '', koffiVersion: '' }
let globalOptionWatcher = null
let globalOptionReadKeyState = null
let optionHoldWanted = false
let optionToggleAt = 0
let optionDownAt = 0
let optionLatched = false
let holdReleaseTimer = null
let listenStartedAt = 0
let heardSinceListen = false
let smokeOptionPressedOverride = null
let talkKeyAutoStopTimer = null
let pauseMonitor = null
let pauseStatus = { paused: 0, lastPause: null, lastError: '' }
let smokeIdleSecondsOverride = null
let lastHeardText = ''
let lastHeardAt = 0
// smoke/诊断用：临时不把 bridge turn 事件计入「turn 运行中」，避免真实
// 系统 idle 波动在大屏录制时误触发暂停。
let bridgeEventsSuppressed = false

const desktopPresence = new DesktopPresence({
  getWindow: () => mainWindow,
  globalShortcut,
  logger,
})

const desktopWakeWord = new DesktopWakeWordRuntime({
  modelRoot: clientPaths.wakeWordModelDirectory,
  keywords: desktopWakeWordKeywords,
  onDetected: () => desktopPresence.wake('wake-word'),
  onReady: () => logger.info('wake_word.ready', { phrase: desktopWakeWordPhrase }),
  onError: error => logger.warn('wake_word.failed', { error }),
})
desktopWakeWord.setEnabled(desktopWakeWordEnabled)

// ---- desktop shell control (W6 double-click, approvals, DSH settings) ----

function openDshSettingsInShell() {
  void requestOpenDshSettings().then(result => {
    logger.info('desktop.dsh_settings_request', result)
  })
}

/** Fallback only when the shell control surface is unreachable. */
function launchDshFallback() {
  const command = process.env.NISSE_DSH_OPEN_CMD
  const script = process.env.NISSE_DSH_OPEN_SCRIPT
    || '$HOME/projects/dsh-bot-workspace/m3/pet/open-dsh.sh'
  try {
    const child = spawn('/bin/bash', ['-lc', command || script], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    return { ok: true, result: 'spawned' }
  } catch (error) {
    logger.warn('desktop.open_dsh_failed', { error: String(error?.message || error) })
    return { ok: false, error: String(error?.message || error) }
  }
}

let lastOpenDshAt = 0
ipcMain.handle('nisse:open-dsh', async () => {
  // 一次双击会同时触发 document dblclick 与可能的重复事件；忽略 600ms 内的
  // 重复请求，避免 shell 先 shown 又 minimized。
  const now = Date.now()
  if (now - lastOpenDshAt < 600) return { ok: true, result: 'deduped' }
  lastOpenDshAt = now
  if (bridgeOnly) {
    const toggle = await requestMainToggle()
    lastShellToggle = toggle
    logger.info('desktop.open_dsh_toggle', toggle)
    if (toggle.ok) return toggle
  }
  // 桌面壳控制面不可达：退回到 open-dsh.sh（脚本自己也会先尝试 toggle）。
  const fallback = launchDshFallback()
  logger.info('desktop.open_dsh_fallback', fallback)
  return fallback
})

ipcMain.on('qwen-audio-agent:wake-word-audio', (event, payload) => {
  if (
    !desktopWakeWordEnabled
    || desktopPresence.state !== 'hidden'
    || !mainWindow
    || mainWindow.isDestroyed()
    || event.sender !== mainWindow.webContents
  ) return
  const audio = typeof payload?.audio === 'string' ? payload.audio : ''
  const sampleRate = Number(payload?.sampleRate)
  if (!audio || audio.length > 128 * 1024 || sampleRate !== 16_000) return
  desktopWakeWord.accept(audio, sampleRate)
})

// ---- window surface ----

function isDesktopRendererUrl(value) {
  return Boolean(
    rendererServer
    && isSameOrigin(value, rendererServer.origin),
  )
}

function configurePermissions(window) {
  const electronSession = window.webContents.session
  electronSession.setPermissionCheckHandler((
    _webContents,
    permission,
    requestingOrigin,
    details,
  ) => {
    const origin = details?.securityOrigin || requestingOrigin
    return permission === 'media' && isDesktopRendererUrl(origin)
  })
  electronSession.setPermissionRequestHandler((
    webContents,
    permission,
    callback,
    details,
  ) => {
    const source = details?.requestingUrl
      || details?.securityOrigin
      || webContents.getURL()
    const mediaTypes = details?.mediaTypes || []
    const audioOnly = !mediaTypes.length
      || mediaTypes.every(type => type === 'audio')
    callback(
      permission === 'media'
      && audioOnly
      && isDesktopRendererUrl(source),
    )
  })
}

async function showUnavailable(window) {
  if (window.isDestroyed()) return
  await window.loadFile(fallbackPage, {
    query: { target: appOrigin },
  })
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => {
    if (mainWindow === window && !window.isDestroyed()) {
      void loadQwenAudioAgent(window)
    }
  }, 3000)
}

// W1 工具条裁剪：桌面壳只保留语音前台。对话/设置/退出等旧 qwen 入口没有
// 独立窗口可开，直接在渲染层隐藏；双击（W6）统一走 preload → 主进程 →
// 桌面壳 POST /bot/toggle-main。
function installBodyRuntimeControls(window) {
  window.webContents.insertCSS(
    '.desktop-orb-controls button[aria-label="打开对话"],'
    + ' .desktop-orb-controls button[aria-label="设置"],'
    + ' .desktop-orb-controls button[aria-label="退出"],'
    + ' .desktop-orb-controls button[aria-label="收起"],'
    + ' .desktop-orb-controls button[aria-label="收起为悬浮球"]'
    + ' { display: none !important; }',
  ).catch(() => {})
  const script = `(() => {
    const openDsh = (event) => {
      try {
        event.preventDefault();
        event.stopPropagation();
        window.qwenAudioAgentDesktop?.openDsh?.();
      } catch {}
    };
    if (!document.documentElement.dataset.bodyRuntimeDblclick) {
      document.documentElement.dataset.bodyRuntimeDblclick = '1';
      document.addEventListener('dblclick', openDsh, true);
    }
  })()`
  window.webContents.executeJavaScript(script).catch(() => {})
  // 语音输入注入层（说话键 / 悬停麦克风状态 / 输入气泡取消）。
  void injectVoiceControls(window)
}

async function loadQwenAudioAgent(window) {
  try {
    if (!rendererServer) throw new Error('desktop renderer is unavailable')
    const skin = effectiveOrbSkin(initialPreferences.orbSkin)
    await window.loadURL(desktopOrbUrl(rendererServer.baseUrl, {
      orbSkin: skin,
      autoHideSeconds: initialPreferences.autoHideSeconds,
      wakeWordEnabled: desktopWakeWordEnabled,
      language: effectiveDesktopLanguage(desktopLanguage, app.getLocale()),
    }))
    installBodyRuntimeControls(window)
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  } catch {
    await showUnavailable(window)
  }
}

function showDesktop(reason = 'tray') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    desktopPresence.wake(reason)
    return
  }
  void ensureDesktopUi().then(() => desktopPresence.wake(reason))
}

let tray = null

function voiceInputTraySubmenu() {
  const modes = [
    ['hold', '按住说话'],
    ['toggle', '按一下切换'],
    ['always', '一直听'],
  ].map(([mode, label]) => ({
    label,
    type: 'radio',
    checked: voiceInputSettings.mode === mode,
    click: () => { setVoiceMode(mode) },
  }))
  const keys = TALK_KEY_PRESETS.map(preset => ({
    label: preset.label,
    type: 'radio',
    checked: voiceInputSettings.keyId === preset.id,
    click: () => { setTalkKey(preset.id) },
  }))
  return [
    ...modes,
    { type: 'separator' },
    ...keys,
    { type: 'separator' },
    {
      label: (lastVoiceReport.enabled || lastVoiceReport.waiting) ? '停止收听' : '开始收听',
      click: () => { void toggleVoiceListening() },
    },
    {
      label: `当前：${currentTalkKeyHint().text}`,
      enabled: false,
    },
    {
      label: globalOptionStatus.available
        ? '全局：Option/Alt 按住说话（CGEventSourceKeyState，koffi）'
        : `全局兜底：${talkKeyStatus.accelerator || '不可用'}（koffi 不可用）`,
      enabled: false,
    },
  ]
}

function trayMenuTemplate() {
  const resumeLabel = onboardingProgress
    ? onboardingResumeLabel(onboardingProgress)
    : '开始引导'
  return [
    {
      label: desktopText('显示悬浮球'),
      click: () => showDesktop('tray'),
    },
    {
      label: resumeLabel === '重新引导' ? '重新引导（气泡内）' : '继续引导（气泡内）',
      click: () => startOnboarding({ restart: true }),
    },
    {
      // 设置归 DSH Settings → Bot：桌宠不打开独立设置窗。
      label: 'Bot 设置…',
      click: () => openDshSettingsInShell(),
    },
    { type: 'separator' },
    {
      label: '语音输入',
      submenu: voiceInputTraySubmenu(),
    },
    { type: 'separator' },
    {
      label: desktopText('退出 Nisse 家灵'),
      click: () => app.quit(),
    },
  ]
}

function updateTrayMenu() {
  if (!tray) return
  try {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
  } catch (error) {
    logger.warn('tray.menu_update_failed', { error: String(error?.message || error) })
  }
}

function createTray() {
  if (!tray) {
    const iconPath = resolve(
      sourceRoot,
      process.platform === 'darwin'
        ? 'desktop/build/trayTemplate.png'
        : 'desktop/build/icon.png',
    )
    let icon = nativeImage.createFromPath(iconPath)
    if (process.platform !== 'darwin' && !icon.isEmpty()) {
      icon = icon.resize({ width: 18, height: 18 })
    }
    if (process.platform === 'darwin') icon.setTemplateImage(true)
    tray = new Tray(icon)
    tray.setToolTip('Nisse 家灵')
  }
  updateTrayMenu()
  return tray
}

function currentOrbBounds() {
  const bounds = mainWindow.getBounds()
  return desktopOrbBounds(bounds, {
    taskCount: desktopTaskCount,
    placement: desktopTaskPlacement,
    orbOffsetX: desktopOrbOffsetX,
  })
}

function sendDesktopTaskPlacement() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const orbBounds = currentOrbBounds()
  const workArea = screen.getDisplayMatching(orbBounds).workArea
  desktopBubbleHeadroom = orbBubbleHeadroom({
    orbBounds,
    taskCount: desktopTaskCount,
    taskPlacement: desktopTaskPlacement,
    workArea,
  })
  mainWindow.webContents.send(
    'qwen-audio-agent:ta[REDACTED_KEY]',
    {
      placement: desktopTaskPlacement,
      orbOffsetX: desktopOrbOffsetX,
      headroom: desktopBubbleHeadroom,
    },
  )
}

function ensureBubbleController() {
  if (!orbBubbleController) {
    orbBubbleController = createBubbleWindowController({
      BrowserWindow,
      logger,
      preloadPath: bubblePreloadPath,
    })
  }
  return orbBubbleController
}

/** 头顶气泡窗口的定位/显隐。气泡是独立窗口，orb 窗口尺寸与位置不受影响。 */
function updateBubbleGeometry() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    orbBubbleController?.hide()
    return
  }
  if (!mainWindow.isVisible()) {
    orbBubbleController?.hide()
    return
  }
  const orbBounds = currentOrbBounds()
  const workArea = screen.getDisplayMatching(orbBounds).workArea
  const bubbleBounds = orbBubbleWindowBounds({
    orbBounds,
    taskCount: desktopTaskCount,
    taskPlacement: desktopTaskPlacement,
    workArea,
  })
  if (process.env.QWAUDIO_DEBUG_BUBBLE === '1') {
    logger.info('debug.bubble_geometry', {
      orbBounds,
      bubbleBounds,
      taskCount: desktopTaskCount,
      taskPlacement: desktopTaskPlacement,
    })
  }
  orbBubbleController?.reposition(bubbleBounds)
}

/**
 * Show a bubble. Every payload goes through normalizeBubblePayload so the
 * renderer only ever sees a bounded, whitelisted shape.
 *
 * Sources: DSH bridge (speech/activity/approval), voice recognition (input),
 * onboarding steps, and pause/voice status messages.
 */
function showBubble(payload, { source = 'generic' } = {}) {
  const normalized = normalizeBubblePayload(payload)
  if (!normalized) {
    hideBubble('empty-payload')
    return false
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    hideBubble('show-without-window')
    return false
  }
  const approval = normalized.approval || null
  // 审批气泡是粘性的：在用户点「是/否」之前，不能被 turn/活动/引导/状态气泡
  // 覆盖（否则审批请求会静默丢失）。
  if (orbBubblePayload?.approval && !approval) {
    logger.info('bubble.suppressed_by_approval', { source, kind: normalized.kind })
    return false
  }
  // orb 窗口还没显示（启动中/自动休眠）：审批/引导不能丢，先唤醒并在窗口
  // show 时补显示；普通 turn 文本不强行弹窗。
  if (!mainWindow.isVisible()) {
    if (approval || normalized.kind === 'onboarding') {
      orbBubblePayload = normalized
      desktopPresence.wake(approval ? 'approval' : 'onboarding')
      return true
    }
    hideBubble('window-not-visible-speech')
    return false
  }
  orbBubblePayload = normalized
  ensureBubbleController().show(normalized)
  updateBubbleGeometry()
  logger.info('bubble.show', { source, kind: normalized.kind, clickThrough: normalized.clickThrough })
  return true
}

function hideBubble(reason = '') {
  if (orbBubblePayload) logger.info('bubble.hide', { reason })
  clearTimeout(activityHideTimer)
  activityHideTimer = null
  orbBubblePayload = null
  orbBubbleController?.hide()
}

/** 渲染层自定义气泡（旧 qwen 渲染层的 setOrbBubble；不创建任何会话）。 */
function updateOrbBubble(payload) {
  const data = payload && typeof payload === 'object' ? payload : {}
  if (data.visible === true) {
    showBubble({
      kind: typeof data.kind === 'string' ? data.kind : 'speech',
      text: String(data.text || '').slice(0, 400),
      fading: data.fading === true,
    })
  } else {
    hideBubble('orb-bubble-hidden')
  }
}

// ---- 活动气泡（P1）：DSH 事件 → 小图标 + 文件名，永不挡点击 ----

function showActivityBubble(payload) {
  const shown = showBubble(payload, { source: 'activity' })
  clearTimeout(activityHideTimer)
  activityHideTimer = null
  if (!shown) return false
  const explicit = Number(payload?.holdMs)
  const holdMs = Number.isFinite(explicit) && explicit > 0
    ? explicit
    : (payload?.activity === 'think' ? 4_000 : 0)
  if (holdMs > 0) {
    activityHideTimer = setTimeout(() => {
      if (orbBubblePayload?.kind === 'activity') hideBubble('activity-expired')
    }, Math.max(400, Math.min(10_000, holdMs)))
  }
  return true
}

// ---- 语音输入：说话键 / 悬停麦克风 / 输入气泡 / 错误气泡 ----

function showVoiceBubble(payload) {
  if (onboardingActive) return false
  return showBubble(payload, { source: 'voice' })
}

async function refreshShellConfig({ quiet = true } = {}) {
  const reply = await readBotConfig({ timeoutMs: 4_000 })
  if (reply.ok) {
    shellConfigView = reply.config
    shellConfigLastReadAt = Date.now()
    return reply.config
  }
  if (!quiet) logger.warn('shell.config_read_failed', { error: reply.error })
  return null
}

let lastVoiceErrorKind = ''
let lastVoiceErrorAt = 0

function showVoiceError(kindOrMessage, detail = '') {
  const kind = ['missing_key', 'gateway_down', 'network', 'auth', 'model', 'unsupported', 'unknown']
    .includes(kindOrMessage)
    ? kindOrMessage
    : classifyVoiceError(kindOrMessage)
  const now = Date.now()
  // Retry loops and concurrent launches must not stack identical error cards.
  if (kind === lastVoiceErrorKind && now - lastVoiceErrorAt < 8_000) {
    logger.info('voice.error_bubble_suppressed', { kind, sinceMs: now - lastVoiceErrorAt })
    return false
  }
  lastVoiceErrorKind = kind
  lastVoiceErrorAt = now
  const bubble = voiceErrorBubble(
    kind,
    detail || (kind === kindOrMessage ? '' : kindOrMessage),
  )
  logger.info('voice.error_bubble', { kind })
  return showVoiceBubble(bubble)
}

async function checkPipecatMicAccess({ ask = true } = {}) {
  if (process.platform !== 'darwin' || typeof systemPreferences?.getMediaAccessStatus !== 'function') {
    return { ok: true, status: 'not-applicable' }
  }
  // Test-only override for denied-state integration tests; never set in production.
  const override = String(process.env.NISSE_TEST_MIC_STATUS || '').trim()
  if (override) return { ok: override === 'granted', status: override, testOverride: true }
  try {
    let status = systemPreferences.getMediaAccessStatus('microphone')
    if (status === 'not-determined' && ask && typeof systemPreferences.askForMediaAccess === 'function') {
      const granted = await systemPreferences.askForMediaAccess('microphone')
      status = granted ? 'granted' : 'denied'
      logger.info('pipecat.mic_permission_asked', { granted })
    }
    return { ok: status === 'granted', status }
  } catch (error) {
    logger.warn('pipecat.mic_permission_check_failed', { error: String(error?.message || error) })
    return { ok: false, status: 'unknown', error: String(error?.message || error) }
  }
}

/**
 * 说话前确认语音真的可用：先读壳的 Bot 设置（有没有 Key），再看语音网关
 * 状态。任一步失败都在气泡里说清楚（缺少 key / 网络失败 / 网关未启动）。
 */
async function ensureVoiceReady() {
  if (onboardingActive) return { ok: false, kind: 'onboarding' }
  const config = await refreshShellConfig({ quiet: true })
  if (!config) {
    showVoiceError('network', '读不到 DSH 设置，桌面壳可能还没起来')
    return { ok: false, kind: 'network' }
  }
  if (process.platform === 'darwin' && typeof systemPreferences?.getMediaAccessStatus === 'function') {
    try {
      let mic = systemPreferences.getMediaAccessStatus('microphone')
      if (mic === 'not-determined' && typeof systemPreferences.askForMediaAccess === 'function') {
        const granted = await systemPreferences.askForMediaAccess('microphone')
        mic = granted ? 'granted' : 'denied'
        logger.info('voice.mic_permission_asked', { granted })
      }
      if (mic !== 'granted') {
        showVoiceError('unsupported', '麦克风权限未开启：系统设置 → 隐私与安全性 → 麦克风 → 打开「Harness Dev / WhaleGirlBot」，然后重试')
        return { ok: false, kind: 'mic_permission' }
      }
    } catch (error) {
      logger.warn('voice.mic_permission_check_failed', { error: String(error?.message || error) })
    }
  }
  const voice = config.voice && typeof config.voice === 'object' ? config.voice : {}
  const provider = String(voice.provider || '')
  const local = provider === 'local'
  if (!local && voice.apiKeySet !== true) {
    showVoiceError('missing_key')
    return { ok: false, kind: 'missing_key' }
  }
  const statusReply = await readBotRuntimeStatus({ timeoutMs: 2_500 })
  if (!statusReply.ok) {
    showVoiceError('gateway_down', statusReply.error)
    return { ok: false, kind: 'gateway_down' }
  }
  const voiceAvailable = statusReply.status?.voiceAvailable === true
  if (!voiceAvailable) {
    const detail = String(statusReply.status?.error || '语音 worker 未运行')
    showVoiceError('gateway_down', detail)
    return { ok: false, kind: 'gateway_down', detail }
  }
  return { ok: true, config, status: statusReply.status }
}

function sendTalkPhase(phase) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  logger.info('voice.talk_phase_sent', { phase })
  try { mainWindow.webContents.send('nisse-talk-key', { phase }) } catch {}
}

function sendVoiceCommand(action, source = 'main') {
  if (!mainWindow || mainWindow.isDestroyed()) return
  logger.info('voice.command_sent', { action, source })
  try { mainWindow.webContents.send('nisse-voice-command', { action, source }) } catch {}
}

// ---- 全局按住 Option/Alt（koffi + CGEventSourceKeyState 轮询） ----

function startGlobalOptionWatcher() {
  if (globalOptionWatcher || globalOptionStatus.available !== true) return null
  globalOptionReadKeyState = globalOptionStatus.readKeyState
  globalOptionWatcher = createGlobalOptionWatcher({
    // smoke 用注入值驱动同一路径；生产读真实 CGEventSourceKeyState。
    readPressed: () => (smokeOptionPressedOverride !== null
      ? smokeOptionPressedOverride === true
      : globalOptionReadKeyState?.() === true),
    pollMs: Number(process.env.NISSE_OPTION_POLL_MS) || 60,
    stablePolls: Number(process.env.NISSE_OPTION_STABLE_POLLS) || 2,
    onDown: () => { void onGlobalOptionDown() },
    onUp: () => onGlobalOptionUp(),
    logger,
  })
  globalOptionWatcher.start()
  logger.info('global_option.watcher_started', globalOptionWatcher.state())
  return globalOptionWatcher
}

function stopGlobalOptionWatcher() {
  globalOptionWatcher?.stop()
  globalOptionWatcher = null
}

async function onGlobalOptionDown() {
  if (onboardingActive) return
  const mode = voiceInputSettings.mode
  if (mode === 'always') return
  if (optionLatched) {
    // 第一次是轻点开麦，第二次轻点=结束并发送。
    optionLatched = false
    sendVoiceCommand('disable', 'global-option')
    return
  }
  optionDownAt = Date.now()
  const active = lastVoiceReport.enabled || lastVoiceReport.waiting
  if (mode === 'toggle') {
    // Option 按一下切换（防抖，避免长按触发多次）。
    if (Date.now() - optionToggleAt < 500) return
    optionToggleAt = Date.now()
    if (active) {
      sendVoiceCommand('disable', 'global-option')
      return
    }
    const ready = await ensureVoiceReady()
    if (!ready.ok) return
    if (globalOptionWatcher?.state().pressed === true) {
      sendVoiceCommand('enable', 'global-option')
    }
    return
  }
  // hold：按下开始，松开结束
  if (active) return
  const ready = await ensureVoiceReady()
  if (!ready.ok) return
  // 等 GET/状态期间用户可能已经松手：松手了就不再开麦。
  if (globalOptionWatcher?.state().pressed !== true) return
  optionHoldWanted = true
  if (holdReleaseTimer) { clearTimeout(holdReleaseTimer); holdReleaseTimer = null }
  sendVoiceCommand('enable', 'global-option')
}

function onGlobalOptionUp() {
  if (voiceInputSettings.mode !== 'hold' || !optionHoldWanted) return
  const heldMs = Date.now() - optionDownAt
  optionHoldWanted = false
  // 轻点（<650ms 且还没听到内容）= 开始听；再说一次 Option 结束。
  // 长按（按住说话）松开：不要立刻断开连接，否则 ASR 还没 finalize、DSH turn
  // 也会被取消。等 ASR/回复走完再关麦。
  if (heldMs < 650 && !heardSinceListen) {
    optionLatched = true
    showVoiceBubble({ kind: 'status', icon: '🎙️', text: '在听，请说；说完再按一次 Option 结束。' })
    return
  }
  if (holdReleaseTimer) clearTimeout(holdReleaseTimer)
  const graceMs = Number(process.env.NISSE_HOLD_RELEASE_GRACE_MS) || 8000
  showVoiceBubble({ kind: 'status', icon: '🎙️', text: '听到了，正在处理…' })
  holdReleaseTimer = setTimeout(() => {
    holdReleaseTimer = null
    sendVoiceCommand('disable', 'global-option-release')
  }, graceMs)
}

async function onGlobalTalkTrigger() {
  if (onboardingActive) return
  const ready = await ensureVoiceReady()
  if (!ready.ok) return
  const mode = voiceInputSettings.mode
  if (mode === 'always') {
    sendVoiceCommand('enable', 'accelerator')
    return
  }
  sendTalkPhase('global')
  clearTimeout(talkKeyAutoStopTimer)
  if (mode === 'hold') {
    // 全局组合键没有 keyup 回调：到时长自动收麦，避免一直开着。
    talkKeyAutoStopTimer = setTimeout(
      () => sendTalkPhase('auto-stop'),
      voiceInputSettings.holdMaxMs,
    )
  }
}

function registerTalkKey() {
  const preset = talkKeyPresetOf(voiceInputSettings.keyId)
  const accelerator = preset.accelerator || voiceInputSettings.fallbackAccelerator
  if (talkKeyStatus.accelerator) {
    try { globalShortcut.unregister(talkKeyStatus.accelerator) } catch {}
  }
  let registered = false
  try {
    registered = globalShortcut.register(accelerator, () => { void onGlobalTalkTrigger() })
  } catch (error) {
    logger.warn('voice.talk_key_register_failed', { accelerator, error: String(error?.message || error) })
  }
  if (!registered) logger.warn('voice.talk_key_unavailable', { accelerator })
  const hint = currentTalkKeyHint()
  talkKeyStatus = {
    ...talkKeyStatusPayload({
      settings: voiceInputSettings,
      globalOption: globalOptionStatus,
      accelerator,
      registered,
    }),
    presetLabel: preset.label,
    hintText: hint.text,
    dryRun: process.env.NISSE_SMOKE_VOICE_DRY_RUN === '1',
    fallback: voiceInputSettings.fallbackAccelerator,
  }
  return talkKeyStatus
}

function applyVoiceInputSettings(next, { persist = true } = {}) {
  voiceInputSettings = normalizeVoiceInput(next)
  if (persist) {
    try {
      experienceStore.saveVoiceInput(voiceInputSettings)
    } catch (error) {
      logger.warn('voice.settings_save_failed', { error: String(error?.message || error) })
    }
  }
  registerTalkKey()
  pushVoiceControlsConfig()
  updateTrayMenu()
  logger.info('voice.settings_applied', { ...voiceInputSettings, talkKey: talkKeyStatus })
  return voiceInputSettings
}

function setVoiceMode(mode) {
  return applyVoiceInputSettings({ ...voiceInputSettings, mode })
}

function setTalkKey(keyId) {
  const preset = talkKeyPresetOf(keyId)
  const next = { ...voiceInputSettings, keyId: preset.id }
  if (preset.accelerator) next.fallbackAccelerator = preset.accelerator
  return applyVoiceInputSettings(next)
}

async function toggleVoiceListening() {
  if (lastVoiceReport.enabled || lastVoiceReport.waiting) {
    sendVoiceCommand('disable')
    return
  }
  const ready = await ensureVoiceReady()
  if (!ready.ok) return
  sendVoiceCommand('enable')
}

function onVoiceStateReport(payload) {
  const next = {
    enabled: payload?.enabled === true,
    waiting: payload?.waiting === true,
    mode: String(payload?.mode || lastVoiceReport.mode || ''),
    reports: Math.max(0, Math.floor(Number(payload?.reports) || 0)),
    dryRun: payload?.dryRun === true,
    hintSeen: payload?.hintSeen === true,
    hintVisible: payload?.hintVisible === true,
    hintShows: Math.max(0, Math.floor(Number(payload?.hintShows) || 0)),
    clickCount: Math.max(0, Math.floor(Number(payload?.clickCount) || 0)),
    enabledBy: String(payload?.enabledBy || ''),
  }
  const changed = next.enabled !== lastVoiceReport.enabled
    || next.waiting !== lastVoiceReport.waiting
  const wasListening = lastVoiceReport.enabled
  lastVoiceReport = next
  logger.info('voice.state_report', next)
  // round2：第一次真正开始说话后把「提示已看过」持久化，下次启动不再常驻提示。
  if (next.enabled && voiceInputSettings.hintSeen !== true) {
    voiceInputSettings = normalizeVoiceInput({ ...voiceInputSettings, hintSeen: true })
    try {
      experienceStore.saveVoiceInput(voiceInputSettings)
      logger.info('voice.hint_seen_persisted', {})
    } catch (error) {
      logger.warn('voice.hint_seen_save_failed', { error: String(error?.message || error) })
    }
    pushVoiceControlsConfig()
  }
  if (!next.enabled && !next.waiting) {
    optionHoldWanted = false
    optionLatched = false
  }
  if (next.enabled && !wasListening) {
    listenStartedAt = Date.now()
    heardSinceListen = false
  }
  if (changed && !onboardingActive) {
    if (!next.enabled && !next.waiting && listenStartedAt > 0) {
      // 结束收音：区分「说到内容了」「什么都没听到」和「主动静音」。
      const heard = heardSinceListen || lastHeardAt > listenStartedAt + 150
      const bubble = heard
        ? { kind: 'status', icon: '🎙️', text: '听到了，正在发送给 DSH…' }
        : (Date.now() - listenStartedAt > 650
            ? { kind: 'status', icon: '🔇', text: '没听到内容，再说一次？' }
            : voiceStatusBubble({ enabled: false, mode: next.mode || voiceInputSettings.mode }))
      showVoiceBubble(bubble)
      listenStartedAt = 0
    } else {
      showVoiceBubble(voiceStatusBubble({
        enabled: next.enabled,
        mode: next.mode || voiceInputSettings.mode,
      }))
    }
    if (wasListening !== next.enabled) updateTrayMenu()
  }
}

// ---- 碰键鼠立即暂停：powerMonitor idle 轮询 → bridge POST /cancel ----

async function pauseCurrentTurn(idleSeconds) {
  if (!turnActive) return
  turnActive = false
  const { descriptor } = await readBridgeDescriptor()
  const reply = descriptor
    ? await requestBridgeCancel(descriptor, { timeoutMs: 2_500 })
    : { ok: false, error: 'DSH bridge descriptor missing' }
  pauseStatus = {
    paused: pauseStatus.paused + 1,
    lastPause: {
      at: new Date().toISOString(),
      idleSeconds,
      ok: reply.ok === true,
      cancelled: reply.result?.cancelled === true,
      error: reply.ok ? '' : String(reply.error || ''),
    },
    lastError: reply.ok ? '' : String(reply.error || ''),
  }
  logger.info('pause.user_input', pauseStatus.lastPause)
  if (!onboardingActive) {
    if (reply.ok && reply.result?.cancelled !== false) {
      showBubble(pausedBubble(), { source: 'pause' })
    } else {
      showBubble(pauseFailedBubble(pauseStatus.lastError), { source: 'pause' })
    }
  }
}

function startPauseMonitor() {
  if (pauseMonitor) return
  pauseMonitor = createPauseOnInputMonitor({
    getIdleSeconds: () => {
      if (smokeIdleSecondsOverride !== null) return smokeIdleSecondsOverride
      try { return powerMonitor.getSystemIdleTime() } catch { return null }
    },
    isTurnActive: () => turnActive,
    getTurnStartedAt: () => turnStartedAt,
    shouldPause: () => !onboardingActive
      && !bridgeEventsSuppressed
      && pauseOnInputEnabled(shellConfigView),
    onPause: ({ idleSeconds }) => { void pauseCurrentTurn(idleSeconds) },
    pollMs: Number(process.env.NISSE_PAUSE_POLL_MS) || 1_000,
    ...(Number(process.env.NISSE_PAUSE_GRACE_MS) > 0
      ? { graceMs: Number(process.env.NISSE_PAUSE_GRACE_MS) }
      : {}),
    logger,
  })
  pauseMonitor.start()
  logger.info('pause.monitor_started', pauseMonitor.state())
}

function stopPauseMonitor() {
  pauseMonitor?.stop()
  pauseMonitor = null
}

// ---- Pet-led onboarding：气泡内分步引导，写配置只走壳 HTTP ----

let onboardingEffectQueue = Promise.resolve()

function persistOnboarding() {
  if (!onboardingProgress) return
  try {
    experienceStore.saveOnboarding(onboardingProgress)
  } catch (error) {
    logger.warn('onboarding.persist_failed', { error: String(error?.message || error) })
  }
}

function showOnboardingStep() {
  if (!onboardingProgress) return
  onboardingActive = !onboardingProgress.completed
  if (!onboardingActive) return
  showBubble(onboardingView(onboardingProgress), { source: 'onboarding' })
}

function enqueueOnboardingEffects(effects) {
  if (!Array.isArray(effects) || !effects.length) return onboardingEffectQueue
  onboardingEffectQueue = onboardingEffectQueue
    .then(() => runOnboardingEffects(effects))
    .catch(error => logger.warn('onboarding.effect_failed', { error: String(error?.message || error) }))
  return onboardingEffectQueue
}

async function runOnboardingEffects(effects) {
  for (const effect of effects) {
    if (effect.type === 'read-config') {
      const config = await refreshShellConfig({ quiet: true })
      applyOnboarding({ type: 'config-read', config })
      continue
    }
    if (effect.type === 'save-config') {
      const edit = configEditFromProgress(onboardingProgress, shellConfigView)
      const reply = await updateBotConfig(edit, { timeoutMs: 6_000 })
      if (reply.ok) {
        shellConfigView = reply.config
        const approvalPersisted = Boolean(
          reply.config && reply.config.approval && reply.config.behavior,
        )
        if (onboardingProgress) {
          onboardingProgress = { ...onboardingProgress, approvalPersisted }
          persistOnboarding()
        }
        logger.info('onboarding.config_saved', {
          approvalPersisted,
          needsShellFields: approvalPersisted ? [] : edit.unsupportedUntilShell,
        })
        applyOnboarding({ type: 'save-result', ok: true })
      } else {
        logger.warn('onboarding.config_save_failed', { error: reply.error })
        applyOnboarding({ type: 'save-result', ok: false, error: reply.error })
      }
      continue
    }
    if (effect.type === 'test-llm') {
      const reply = await testLlmConnection(llmSectionOf(onboardingProgress), { timeoutMs: 16_000 })
      const result = reply.ok
        ? reply.result
        : { ok: false, detail: reply.error, hint: classifyVoiceError(reply.error) === 'network' ? '网络请求失败' : String(reply.error) }
      applyOnboarding({ type: 'test-result', target: 'llm', result })
      continue
    }
    if (effect.type === 'test-voice') {
      const reply = await testVoiceConnection(voiceSectionOf(onboardingProgress), { timeoutMs: 16_000 })
      const result = reply.ok ? reply.result : { ok: false, detail: reply.error, hint: String(reply.error) }
      applyOnboarding({ type: 'test-result', target: 'voice', result })
      continue
    }
    if (effect.type === 'open-dsh-settings') {
      openDshSettingsInShell()
      continue
    }
    if (effect.type === 'complete') {
      finishOnboarding()
    }
  }
}

function applyOnboarding(action) {
  if (!onboardingProgress) return null
  const reduced = reduceOnboarding(onboardingProgress, action)
  onboardingProgress = reduced.state
  onboardingBusy = reduced.state.substate === 'testing'
  persistOnboarding()
  const effects = Array.isArray(reduced.effects) ? reduced.effects : []
  if (reduced.state.completed) {
    onboardingActive = false
    logger.info('onboarding.completed', { step: reduced.state.stepId })
    if (!effects.some(effect => effect.type === 'complete')) finishOnboarding()
  } else {
    showOnboardingStep()
  }
  enqueueOnboardingEffects(effects)
  return reduced
}

function finishOnboarding() {
  onboardingActive = false
  if (onboardingProgress) {
    onboardingProgress = {
      ...onboardingProgress,
      completed: true,
      paused: false,
      updatedAt: new Date().toISOString(),
    }
    persistOnboarding()
  }
  hideBubble('onboarding-finished')
  setTimeout(() => {
    void refreshShellConfig({ quiet: true }).then(config => {
      if (config) showVoiceBubble({
        kind: 'status',
        icon: '✅',
        text: '设置好了。想改随时去 DSH 设置 → Bot。',
      })
    })
  }, 600)
  updateTrayMenu()
}

let onboardingDeferTimer = null
function startOnboarding({ restart = false, attempt = 0 } = {}) {
  // 有未决审批时让审批先显示；审批答完后由 bridge approval.decided 重新拉起引导。
  if (orbBubblePayload?.approval && attempt < 20) {
    clearTimeout(onboardingDeferTimer)
    onboardingDeferTimer = setTimeout(
      () => startOnboarding({ restart, attempt: attempt + 1 }),
      1_500,
    )
    logger.info('onboarding.deferred_for_approval', { attempt })
    return null
  }
  onboardingProgress = startProgress({ restart, previous: onboardingProgress })
  onboardingActive = !onboardingProgress.completed
  onboardingBusy = false
  if (restart) {
    try { experienceStore.saveOnboarding(onboardingProgress) } catch {}
  }
  persistOnboarding()
  logger.info('onboarding.started', { restart, step: onboardingProgress.stepId })
  if (onboardingActive) {
    showDesktop('onboarding')
    showOnboardingStep()
    enqueueOnboardingEffects([{ type: 'read-config' }])
  }
  updateTrayMenu()
  return onboardingProgress
}

function handleOnboardingUi(payload) {
  if (!onboardingActive || !onboardingProgress) return false
  const type = String(payload?.type || '')
  if (onboardingBusy && !['close'].includes(type)) return true
  if (type === 'close') {
    applyOnboarding({ type: 'close' })
    onboardingActive = false
    hideBubble('onboarding-closed')
    updateTrayMenu()
    return true
  }
  if (type === 'choice') {
    applyOnboarding({ type: 'choice', id: String(payload.id || '') })
    return true
  }
  if (type === 'secondary') {
    const id = String(payload.id || '')
    if (id === 'skip' || id === 'back') applyOnboarding({ type: 'choice', id })
    else if (id === 'custom-persona') applyOnboarding({ type: 'choice', id })
    return true
  }
  if (type === 'input') {
    applyOnboarding({ type: 'input', value: String(payload.value || '') })
    return true
  }
  if (type === 'cancel') {
    applyOnboarding({ type: 'close' })
    onboardingActive = false
    hideBubble('onboarding-cancelled')
    updateTrayMenu()
    return true
  }
  return false
}

// ---- 语音识别中的灰色输入气泡（渲染层 setOrbBubble → 主进程） ----

function showRecognizingBubble(text) {
  lastHeardText = String(text || '').slice(0, 200)
  if (String(text || '').trim() !== '') heardSinceListen = true
  lastHeardAt = Date.now()
  showBubble(recognizingInputBubble(lastHeardText), { source: 'voice-input' })
}

function updateDesktopTaskSurface(value) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const taskCount = Math.min(100, Math.max(0, Math.floor(Number(value) || 0)))
  const bounds = mainWindow.getBounds()
  const orbBounds = desktopOrbBounds(bounds, {
    taskCount: desktopTaskCount,
    placement: desktopTaskPlacement,
    orbOffsetX: desktopOrbOffsetX,
  })
  const workArea = screen.getDisplayMatching(orbBounds).workArea
  const layout = desktopSurfaceLayout({
    bounds,
    currentTaskCount: desktopTaskCount,
    taskCount,
    placement: desktopTaskPlacement,
    orbOffsetX: desktopOrbOffsetX,
    workArea,
  })
  desktopTaskCount = taskCount
  desktopTaskPlacement = layout.placement
  desktopOrbOffsetX = layout.orbOffsetX
  sendDesktopTaskPlacement()
  updateBubbleGeometry()
  const next = layout.bounds
  if (
    bounds.x !== next.x
    || bounds.y !== next.y
    || bounds.width !== next.width
    || bounds.height !== next.height
  ) {
    mainWindow.setBounds(next, false)
  }
}

ipcMain.on('qwen-audio-agent:task-card-count', (event, value) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  updateDesktopTaskSurface(value)
})

let rendererBubbleIgnoredLogged = false
ipcMain.on('qwen-audio-agent:orb-bubble', (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (bridgeOnly) {
    // 桥模式下 turn/审批气泡由 DSH bridge 事件驱动；但渲染层的「听到：…」
    // 是语音输入的唯一来源，要作为灰色输入气泡放行（识别中/可取消）。
    if (isRecognizingBubble(payload)) {
      showRecognizingBubble(payload.text)
      return
    }
    // 识别结束：不要把用户刚说的话立刻吞掉。先把它作为「你说：…」的灰色输入
    // 气泡留在屏幕上，等 DSH 的 turn/活动气泡到来再替换，让用户看得清自己说了
    // 什么、也能在动作开始前用取消/暂停（碰键鼠）中止。
    if (payload?.visible === false && orbBubblePayload?.kind === 'input') {
      const echoed = sentInputBubble(lastHeardText)
      if (echoed) {
        showBubble(echoed, { source: 'voice-input-sent' })
        return
      }
      hideBubble('recognition-ended')
      return
    }
    if (!rendererBubbleIgnoredLogged) {
      rendererBubbleIgnoredLogged = true
      logger.info('bubble.renderer_driven_bubble_ignored', {
        visible: payload?.visible === true,
        kind: String(payload?.kind || ''),
      })
    }
    return
  }
  updateOrbBubble(payload)
})

// ---- 气泡控件事件：引导选项/输入、语音取消、关闭 ----

ipcMain.on('nisse-bubble:ui', (event, payload) => {
  if (!orbBubbleController?.owns(event.sender)) return
  const data = payload && typeof payload === 'object' ? payload : {}
  const type = String(data.type || '')
  if (type === 'cancel' && String(data.id || '') === 'cancel-voice') {
    sendVoiceCommand('cancel')
    hideBubble('voice-input-cancelled')
    showVoiceBubble({ kind: 'status', icon: '🔇', text: '已取消，先不听。' })
    return
  }
  if (handleOnboardingUi(data)) return
  if (type === 'close') {
    hideBubble('bubble-closed')
    return
  }
  logger.info('bubble.ui_ignored', { type })
})

ipcMain.on('nisse-bubble:input-focus', (event, focus) => {
  if (!orbBubbleController?.owns(event.sender)) return
  if (focus === true) {
    orbBubbleController.setInputMode(true)
    orbBubbleController.focusWindow?.()
  }
})

// 渲染层（注入的语音小控制器）上报收听状态 → 状态气泡 + 托盘刷新。
ipcMain.on('nisse:voice-state', (event, payload) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  onVoiceStateReport(payload)
})

// 渲染层按下说话键前先问主进程「语音可用吗」：缺 key/网关未启动时由主进程
// 在气泡里说清楚，渲染层不点麦克风。
ipcMain.handle('nisse:voice-ready', async () => {
  const ready = await ensureVoiceReady()
  return {
    ok: ready.ok === true,
    kind: ready.kind || '',
    detail: ready.detail || '',
  }
})

ipcMain.handle('nisse:voice-worker-status', async () => ({
  worker: voiceWorkerRuntime.snapshot(),
  bridge: await voiceWorkerRuntime.checkBridge(),
}))

// 审批气泡按钮 → 桌面壳 /bot/approval → bridge /approval → DSH。
ipcMain.on('whale-girl:approval', async (_event, payload) => {
  const result = await sendApprovalDecision(payload?.id, payload?.decision)
  lastShellApproval = { id: String(payload?.id || ''), decision: String(payload?.decision || ''), ...result }
  logger.info('approval.forwarded', lastShellApproval)
})

// 气泡窗口默认点击穿透；渲染层指针进入气泡卡片时请求可交互（是/否按钮）。
ipcMain.on('nisse-bubble:set-interactive', (event, interactive) => {
  if (!orbBubbleController?.owns(event.sender)) return
  orbBubbleController.setInteractive(interactive === true)
})

// ---- bridge: DSH state → bubble ----

async function readBridgeDescriptor() {
  const bridgeFile = String(process.env[BRIDGE_FILE_ENV] || nisseBridgeFile())
  try {
    return {
      bridgeFile,
      descriptor: parseBridgeDescriptor(await readFile(bridgeFile, 'utf8')),
    }
  } catch {
    return { bridgeFile, descriptor: null }
  }
}

async function pollBridgeOnce(lastSeq) {
  const { descriptor } = await readBridgeDescriptor()
  if (!descriptor) return lastSeq
  const response = await fetch(bridgeEventsEndpoint(descriptor, lastSeq), {
    headers: { authorization: `Bearer ${descriptor.token}` },
    signal: AbortSignal.timeout(2500),
  })
  if (!response.ok) return lastSeq
  const payload = await response.json()
  const events = Array.isArray(payload?.events) ? payload.events : []
  for (const event of events) {
    const eventType = String(event?.type || '')
    // 审批永远是最高优先级：引导/活动气泡都要让位，答完再回到引导。
    if (eventType === 'approval.request') {
      const approval = approvalBubblePayload(event)
      if (approval && !lastApprovalIds.has(approval.id)) {
        lastApprovalIds.add(approval.id)
        logger.info('bridge.approval_request', { id: approval.id })
        showBubble(approval.payload, { source: 'approval' })
      }
      continue
    }
    if (eventType === 'approval.decided') {
      // 审批已由 DSH 侧落定：收起是/否气泡，避免过期操作。
      hideBubble('approval-decided')
      if (onboardingActive) setTimeout(() => showOnboardingStep(), 500)
      continue
    }

    // turn 运行状态 → 碰键鼠暂停只在这个窗口内生效。
    if (!bridgeEventsSuppressed) {
      if (['turn.started', 'turn.accepted', 'user.message'].includes(eventType)) {
        turnActive = true
        turnStartedAt = Date.now()
      } else if (activityEndsTurn(event)) {
        turnActive = false
      }
    }

    if (onboardingActive) continue

    // P1 活动气泡：思考/阅读/搜索/写文件/用电脑 + 文件名（点击穿透）。
    const activity = activityBubblePayload(event)
    if (activity) {
      logger.info('bridge.activity', {
        type: eventType,
        activity: activity.activity,
        fileName: activity.fileName || '',
      })
      showActivityBubble(activity)
      continue
    }

    const bubble = bridgeEventToBubble(event)
    if (!bubble) continue
    if (bubble.action === 'show') {
      logger.info('bridge.turn_event', { type: eventType })
      // 说出来的回答优先于活动气泡；但输入气泡（识别中）允许被回答覆盖。
      showBubble(bubble.payload, { source: 'bridge' })
    } else if (bubble.action === 'hide') {
      const delay = Number(bubble.delayMs) || 0
      setTimeout(() => hideBubble(`turn-${eventType}`), delay)
    }
  }
  return nextBridgeSeq(lastSeq, events)
}

function startBridgeEventPoller() {
  if (bridgePollTimer) return
  bridgePollActive = true
  let lastSeq = 0
  const tick = async () => {
    try {
      lastSeq = await pollBridgeOnce(lastSeq)
    } catch (error) {
      logger.warn('bridge.poll_failed', { error: String(error?.message || error) })
    }
    bridgePollTimer = setTimeout(tick, 600)
  }
  void tick()
}

// ---- local bubble/approval HTTP surface (loopback only) ----
//
// The shell may also push a bubble/approval directly (e.g. when it has the
// approval in hand before the bridge page is polled). No chat/session surface
// is served here.

let approvalBridgeServer = null
const APPROVAL_BRIDGE_PORT = Number(process.env.NISSE_BUBBLE_PORT) || 59102

function startApprovalBridgeServer() {
  if (approvalBridgeServer) return
  ensureBubbleController()
  approvalBridgeServer = createServer((req, res) => {
    const respond = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.method !== 'POST') {
      respond(404, { ok: false })
      return
    }
    if (req.url === '/approval') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}')
          const id = String(payload.id || '').trim()
          if (!id) return respond(400, { ok: false })
          showBubble({
            kind: 'action',
            text: String(payload.text || 'DSH 请求确认'),
            approval: { id },
          })
          respond(200, { ok: true })
        } catch {
          respond(400, { ok: false })
        }
      })
      return
    }
    if (req.url === '/bubble') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try {
          const payload = JSON.parse(body || '{}')
          updateOrbBubble({ visible: true, ...payload })
          respond(200, { ok: true })
        } catch {
          respond(400, { ok: false })
        }
      })
      return
    }
    respond(404, { ok: false })
  })
  approvalBridgeServer.on('error', error => {
    logger.warn('bubble.server_failed', { error: String(error?.message || error) })
  })
  approvalBridgeServer.listen(APPROVAL_BRIDGE_PORT, '127.0.0.1')
  app.on('will-quit', () => { try { approvalBridgeServer?.close() } catch {} })
}

// ---- G0 voice spike test mode (default off; formal behavior unchanged) ----
// Injects the locked Pipecat JS client into the existing orb renderer so the
// media path is exercised inside the real m3/pet Electron window. The offer URL
// (with its scoped token) is passed from the main process at runtime and is not
// part of the bundle or logs.
function installG0VoiceTest(window) {
  const testMode = process.env.WG_G0_VOICE_TEST === '1'
  const productMode = process.env.NISSE_PIPECAT_WORKER === '1'
  if (!testMode && !productMode) return
  window.webContents.on('did-finish-load', () => {
    void (async () => {
      try {
        const productRoot = voiceProjectRoot
        const bundlePath = String(
          process.env.WG_G0_VOICE_BUNDLE
          || (productMode ? resolve(productRoot, 'm5/voice-spike/client/inject-bundle.js') : ''),
        ).trim()
        const token = productMode
          ? voiceWorkerRuntime.config.token
          : String(process.env.SPIKE_TOKEN || 'dev-token')
        const explicitOfferUrl = String(process.env.WG_G0_OFFER_URL || '').trim()
        const offerUrl = explicitOfferUrl !== ''
          ? explicitOfferUrl
          : (rendererServer && rendererServer.baseUrl
              ? rendererServer.baseUrl + 'g0-voice/api/offer?token=' + encodeURIComponent(token)
              : '')
        if (!bundlePath || !offerUrl || !existsSync(bundlePath)) {
          logger.warn('g0 voice injection skipped: bundle/offer missing', { bundlePath, hasOffer: Boolean(offerUrl) })
          if (productMode) showBubble({ kind: 'speech', text: '语音服务启动失败：缺少 Pipecat 客户端或 Worker 地址。' })
          return
        }
        if (productMode && !testMode) {
          // Product flag: do not inject until the shell-managed worker is healthy
          // and the DSH bridge descriptor is actually reachable. Worker /health
          // alone is not enough.
          const worker = await voiceWorkerStartPromise
          if (worker?.state !== 'running') {
            const detail = worker?.lastError || worker?.state || 'unknown'
            logger.warn('pipecat client not injected: worker not ready', { state: worker?.state, detail })
            showBubble({ kind: 'speech', text: '语音服务未就绪：' + String(detail).slice(0, 160) })
            return
          }
          const bridge = await voiceWorkerRuntime.waitForBridge(30_000)
          if (!bridge?.ok) {
            logger.warn('pipecat client not injected: bridge not ready', bridge)
            showBubble({ kind: 'speech', text: '语音服务未就绪：DSH Bridge 不可达。' })
            return
          }
        }
        let autoConnect = productMode ? true : process.env.WG_G0_AUTO_CONNECT === '1'
        if (productMode && !testMode) {
          const mic = await checkPipecatMicAccess({ ask: true })
          if (!mic.ok) {
            autoConnect = false
            logger.warn('pipecat client: microphone permission not granted', mic)
            showBubble({ kind: 'speech', text: '麦克风权限未开启：请在系统设置 → 隐私与安全性 → 麦克风允许本应用，然后点击麦克风重试。' })
          }
        }
        const bundleSource = readFileSync(bundlePath, 'utf8')
        const cfg = { offerUrl, autoConnect }
        await window.webContents.executeJavaScript(
          'window.__WG_VOICE_CONFIG__ = ' + JSON.stringify(cfg) + ';',
        )
        await window.webContents.executeJavaScript(bundleSource)
        logger.info('pipecat voice client injected', { productMode, testMode })
      } catch (error) {
        logger.warn('pipecat voice client injection failed: ' + String(error?.message || error))
        if (productMode) showBubble({ kind: 'speech', text: '语音服务连接失败：' + String(error?.message || error).slice(0, 140) })
      }
    })()
  })
}

// ---- orb window ----

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  const width = DESKTOP_ORB_WIDTH
  const height = DESKTOP_ORB_HEIGHT
  const initialPosition = orbPlacement.initialPosition()
  const window = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: workArea.width,
    maxHeight: workArea.height,
    x: initialPosition.x,
    y: initialPosition.y,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Nisse 家灵',
    autoHideMenuBar: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The floating window is normally unfocused. Keep its renderer timers
      // aligned with Web Audio so playback receipts are not delayed and retried.
      backgroundThrottling: false,
      preload: preloadPath,
    },
  })

  // 悬浮层级与全屏空间可见性统一走 orb-shell 契约。
  configureOrbWindow(window)
  configurePermissions(window)

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (isDesktopRendererUrl(url) || url.startsWith(fallbackUrl)) return
    event.preventDefault()
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
  })
  window.once('ready-to-show', () => window.show())
  window.on('blur', () => {
    orbShell.cancelDrag()
  })
  // 头顶气泡跟随 orb 窗口：位置/显隐变化时重新定位；隐藏/睡眠时一并隐藏。
  window.on('move', () => updateBubbleGeometry())
  window.on('resize', () => updateBubbleGeometry())
  window.on('hide', () => orbBubbleController?.hide())
  window.on('show', () => {
    if (orbBubblePayload?.visible) {
      orbBubbleController?.show(orbBubblePayload)
      updateBubbleGeometry()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
      mainWindow = null
      desktopTaskCount = 0
      desktopTaskPlacement = 'below'
      desktopOrbOffsetX = 0
      desktopBubbleHeadroom = 0
      orbBubbleController?.destroy()
      orbBubbleController = null
      orbBubblePayload = null
    }
  })
  window.webContents.on('did-finish-load', () => installBodyRuntimeControls(window))
  installG0VoiceTest(window)

  void loadQwenAudioAgent(window)
  return window
}

// 悬浮球 IPC（拖拽、生命周期、请求退出）统一走 orb-shell 契约。
// 设置入口指向 DSH Settings → Bot；没有独立设置窗口。
const orbShell = bindOrbShell({
  ipc: ipcMain,
  getWindow: () => mainWindow,
  presence: desktopPresence,
  logger,
  onOpenSettings: () => openDshSettingsInShell(),
  onQuit: () => app.quit(),
  onDragEnd: () => {
    const [x, y] = mainWindow.getPosition()
    orbPlacement.recordPosition({ x, y })
    updateDesktopTaskSurface(desktopTaskCount)
  },
})

async function ensureDesktopUi() {
  if (!rendererServer) {
    rendererServer = await startDesktopRendererServer({
      webRoot,
      target: () => appOrigin,
      skinsRoot,
      accessToken: () => gatewayAccessToken,
    })
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow()
  }
  startApprovalBridgeServer()
  startBridgeEventPoller()
}

// ---- smoke probe (env-gated diagnostics for m3/pet/evidence) ----

const smokeProbeFile = String(process.env.NISSE_SMOKE_PROBE_FILE || '').trim()
let smokeProbeStarted = false

function writeSmokeStatus(extra = {}) {
  if (!smokeProbeFile) return
  let windows = []
  try {
    windows = BrowserWindow.getAllWindows().map(window => ({
      title: window.getTitle(),
      visible: window.isVisible(),
      destroyed: window.isDestroyed(),
      url: (() => {
        try { return window.webContents.getURL() } catch { return '' }
      })(),
    }))
  } catch {}
  const status = {
    generatedAt: new Date().toISOString(),
    bridgeOnly,
    gatewayOrigin: appOrigin,
    shellControlUrl,
    bridgeFile: String(process.env[BRIDGE_FILE_ENV] || nisseBridgeFile()),
    bridgePollActive,
    settingsWindowPresent: windows.some(window => window.title === '设置'),
    windows,
    bubble: {
      visible: Boolean(orbBubblePayload?.visible),
      interactive: Boolean(orbBubbleController?.isInteractive?.()),
      inputMode: Boolean(orbBubbleController?.isInputMode?.()),
      kind: String(orbBubblePayload?.kind || ''),
      text: String(orbBubblePayload?.text || ''),
      title: String(orbBubblePayload?.title || ''),
      clickThrough: orbBubblePayload?.clickThrough === true,
    },
    experience: {
      onboarding: {
        active: onboardingActive,
        busy: onboardingBusy,
        stepId: onboardingProgress?.stepId || '',
        substate: onboardingProgress?.substate || '',
        completed: onboardingProgress?.completed === true,
        paused: onboardingProgress?.paused === true,
        approvalPersisted: onboardingProgress?.approvalPersisted === true,
        answers: (() => {
          const answers = onboardingProgress?.answers
          if (!answers) return null
          const clone = JSON.parse(JSON.stringify(answers))
          for (const section of ['llm', 'voice']) {
            if (clone[section] && clone[section].apiKey) {
              clone[section].apiKey = '<redacted>'
              clone[section].apiKeyLength = String(answers[section].apiKey).length
            }
          }
          return clone
        })(),
      },
      voice: {
        settings: voiceInputSettings,
        talkKey: talkKeyStatus,
        hint: currentTalkKeyHint(),
        lastReport: lastVoiceReport,
        globalOption: {
          available: globalOptionStatus.available,
          frameworkPath: globalOptionStatus.frameworkPath || '',
          koffiPath: globalOptionStatus.koffiPath || '',
          koffiVersion: globalOptionStatus.koffiVersion || '',
          error: globalOptionStatus.error || '',
          watcher: globalOptionWatcher?.state?.() || null,
          smokeOverride: smokeOptionPressedOverride,
        },
      },
      pause: {
        turnActive,
        turnStartedAt,
        ...pauseStatus,
        monitor: pauseMonitor?.state?.() || null,
      },
      lastHeardText,
    },
    shell: {
      lastToggle: lastShellToggle,
      lastApproval: lastShellApproval,
    },
    ...extra,
  }
  try {
    writeFileSync(smokeProbeFile, `${JSON.stringify(status, null, 2)}\n`)
  } catch (error) {
    logger.warn('smoke.status_write_failed', { error: String(error?.message || error) })
  }
}


// ---- 体验五项 smoke（env 门控，真实 Electron + 壳/bridge stub 驱动）----
//
// 完全走真实代码路径：气泡 DOM 由 executeJavaScript 点击/填写（等价用户操作），
// 壳的 GET/PUT /bot/config、/bot/test/*、/bot/status、bridge /events 与 /cancel
// 都由外部 stub 应答。外部 smoke 用 POST /__smoke/stage 控制 stub 的下一个阶段。

let experienceProbeLast = null
let voiceUxProbeLast = null

async function runExperienceSmokeProbe() {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const smokeLog = message => console.log(`[smoke] ${message}`)
  const evidenceDir = String(process.env.NISSE_SMOKE_EVIDENCE_DIR || '').trim()
  const inner = {
    stages: [],
    shots: [],
    assertions: {},
    clicks: 0,
    errors: [],
  }
  const shellBase = shellControlUrl

  experienceProbeLast = inner
  const setStage = async stage => {
    inner.stages.push(stage)
    try {
      await fetch(new URL('/__smoke/stage', shellBase).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage }),
        signal: AbortSignal.timeout(2_000),
      })
    } catch (error) {
      inner.errors.push(`stage:${stage}:${String(error?.message || error)}`)
    }
  }

  const bubbleEval = async js => {
    const contents = orbBubbleController?._webContents?.()
    if (!contents || contents.isDestroyed()) return null
    try { return await contents.executeJavaScript(js) } catch (error) {
      inner.errors.push(`bubbleEval:${String(error?.message || error).slice(0, 120)}`)
      return null
    }
  }
  const orbEval = async js => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    try { return await mainWindow.webContents.executeJavaScript(js) } catch (error) {
      inner.errors.push(`orbEval:${String(error?.message || error).slice(0, 120)}`)
      return null
    }
  }
  const bubbleState = async () => bubbleEval('window.__nisseBubbleState ? window.__nisseBubbleState() : null')
  const waitFor = async (check, label, timeoutMs = 20_000, intervalMs = 160) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = await check()
      if (value) return value
      await sleep(intervalMs)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
  const captureShot = async (name, target = 'bubble') => {
    if (!evidenceDir) return
    try {
      const contents = target === 'orb'
        ? (mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null)
        : orbBubbleController?._webContents?.()
      if (!contents || contents.isDestroyed()) return
      const image = await contents.capturePage()
      const file = join(evidenceDir, name)
      writeFileSync(file, image.toPNG())
      inner.shots.push({ name, file })
      smokeLog(`shot ${name}`)
    } catch (error) {
      inner.errors.push(`shot:${name}:${String(error?.message || error)}`)
    }
  }
  const clickBubbleText = async (text, label = '') => {
    const deadline = Date.now() + 4_000
    let lastLabels = []
    while (Date.now() < deadline) {
      const result = await bubbleEval(`(() => {
        const buttons = [...document.querySelectorAll('#bubble-choices button,#bubble-secondary button,#bubble-actions button')];
        const labels = buttons.map(button => button.textContent.trim());
        const hit = buttons.find(button => button.textContent.trim() === ${JSON.stringify(text)});
        if (!hit) return { clicked: false, labels };
        hit.click();
        return { clicked: true, labels };
      })()`)
      lastLabels = result?.labels || lastLabels
      if (result?.clicked) {
        inner.clicks += 1
        return true
      }
      await sleep(120)
    }
    const state = await bubbleState()
    inner.errors.push(`click:${label || text}:labels=${JSON.stringify(lastLabels)}:bubble=${JSON.stringify(state)}`)
    return false
  }
  const submitBubbleInput = async (value, label = '') => {
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const submitted = await bubbleEval(`(() => {
        const input = document.getElementById('bubble-input');
        const row = document.getElementById('bubble-input-row');
        if (!input || !row) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (typeof row.requestSubmit === 'function') row.requestSubmit();
        else row.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      })()`)
      if (submitted) {
        inner.clicks += 1
        return true
      }
      await sleep(120)
    }
    const state = await bubbleState()
    inner.errors.push(`input:${label || 'value'}:bubble=${JSON.stringify(state)}`)
    return false
  }

  const waitStepTitle = async (title, timeoutMs = 22_000) => waitFor(async () => {
    const state = await bubbleState()
    return state && state.title === title ? state : null
  }, `onboarding step ${title}`, timeoutMs)

  // ---- (d) Pet-led onboarding：气泡内完成 称呼→人格→模型→语音→权限 ----
  await waitFor(async () => {
    const state = await bubbleState()
    return state && state.kind === 'onboarding' ? state : null
  }, 'onboarding first bubble', 25_000)
  inner.assertions.onboardingAutoStarted = true
  await captureShot('pet-onboarding-address.png')
  await waitStepTitle('认识一下')
  inner.assertions.stepAddress = true

  if (!(await submitBubbleInput('小智'))) throw new Error('failed to submit address input')
  await waitStepTitle('我的性格')
  inner.assertions.stepPersona = true
  if (!(await clickBubbleText('温柔可靠'))) throw new Error('failed to click persona preset')

  await waitStepTitle('模型服务')
  inner.assertions.stepLlmProvider = true
  if (!(await clickBubbleText('OpenCode Go（默认）'))) throw new Error('failed to pick LLM provider')
  await waitStepTitle('模型 Key')
  await captureShot('pet-onboarding-llm-key.png')
  if (!(await submitBubbleInput('[REDACTED_KEY]'))) throw new Error('failed to submit LLM key')
  // 测试连接走壳 POST /bot/test/llm（stub 返回 ok），随后进入语音服务步骤。
  await waitStepTitle('语音服务')

  if (!(await clickBubbleText('DashScope Qwen Realtime（默认）'))) throw new Error('failed to pick voice provider')
  await waitStepTitle('语音 Key')
  if (!(await submitBubbleInput('[REDACTED_KEY]'))) throw new Error('failed to submit voice key')
  await waitStepTitle('唤醒词')
  if (!(await submitBubbleInput('小鲸小鲸'))) throw new Error('failed to submit wake word')
  // 语音测试走壳 POST /bot/test/voice（stub 返回 ok）→ 权限步骤。
  await waitStepTitle('权限')
  inner.assertions.llmAndVoiceTested = true
  if (!(await clickBubbleText('每次都问'))) throw new Error('failed to pick approval mode')
  await waitStepTitle('好啦')
  await captureShot('pet-onboarding-done.png')
  if (!(await clickBubbleText('完成'))) throw new Error('failed to complete onboarding')
  await waitFor(async () => onboardingActive === false, 'onboarding finished', 10_000)
  inner.assertions.onboardingCompleted = onboardingProgress?.completed === true
  inner.assertions.onboardingApprovalPersisted = onboardingProgress?.approvalPersisted === true
  inner.assertions.onboardingAnswers = onboardingProgress?.answers || null
  inner.assertions.onboardingProgressPersisted = Boolean(
    storedExperience && experienceStore.load().onboarding?.completed === true,
  )
  await sleep(900)

  // ---- (c) 悬停麦克风按钮 + 说话键 + 输入气泡 + 错误气泡 ----
  let hoverForced = false
  try {
    const contents = mainWindow.webContents
    contents.debugger.attach('1.3')
    await contents.debugger.sendCommand('DOM.enable')
    await contents.debugger.sendCommand('CSS.enable')
    const document = await contents.debugger.sendCommand('DOM.getDocument', { depth: -1 })
    const stageNode = await contents.debugger.sendCommand('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: '.desktop-orb-stage',
    })
    if (stageNode?.nodeId) {
      await contents.debugger.sendCommand('CSS.forcePseudoState', {
        nodeId: stageNode.nodeId,
        forcedPseudoClasses: ['hover'],
      })
      hoverForced = true
    }
  } catch (error) {
    inner.errors.push(`hover:${String(error?.message || error).slice(0, 120)}`)
  }
  await sleep(350)
  const hoverState = await orbEval(`(() => {
    const stage = document.querySelector('.desktop-orb-stage');
    const nav = document.querySelector('.desktop-orb-controls');
    if (!nav) return { found: false };
    const style = getComputedStyle(nav);
    const mic = nav.querySelector('button');
    const hoverRule = [...document.styleSheets].some(sheet => {
      try { return [...sheet.cssRules].some(rule => String(rule.cssText || '').includes('.desktop-orb-controls') && String(rule.cssText || '').includes(':hover')) } catch { return false }
    });
    return {
      found: true,
      stage: Boolean(stage),
      buttons: nav.querySelectorAll('button').length,
      micLabel: mic ? (mic.getAttribute('aria-label') || mic.getAttribute('title') || '') : '',
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      hoverRule,
    };
  })()`)
  const badgeState = await orbEval(`(() => {
    const badge = document.querySelector('.nisse-voice-badge');
    if (!badge) return null;
    const rect = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return { text: badge.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height, display: style.display, opacity: style.opacity, background: style.backgroundColor };
  })()`)
  inner.assertions.badgeState = badgeState
  inner.assertions.micHoverButton = Boolean(hoverState?.found && hoverState?.buttons > 0 && hoverState?.micLabel)
  inner.assertions.micHoverCss = Boolean(hoverState?.hoverRule)
  inner.assertions.micHoverVisible = hoverForced ? hoverState?.opacity === '1' : null
  inner.hoverForced = hoverForced
  inner.hoverState = hoverState
  await captureShot('pet-orb-hover-controls.png', 'orb')
  try { mainWindow.webContents.debugger.detach() } catch {}

  inner.assertions.talkKey = talkKeyStatus
  inner.assertions.injectedVoiceControls = await orbEval(
    'window.__nisseVoice?.state?.() || null',
  )
  // 走真实路径：onGlobalTalkTrigger → ensureVoiceReady(GET config+status) →
  // 主进程 IPC → preload → 注入层（dryRun 只记录，不申请真实麦克风）。
  const voiceSamples = []
  const sampler = setInterval(() => {
    void orbEval('window.__nisseVoice?.state?.() || null').then(state => {
      if (state) {
        voiceSamples.push({ at: Date.now(), enabled: state.enabled, applied: state.applied, actions: state.actions })
        if (voiceSamples.length > 60) voiceSamples.shift()
      }
    })
  }, 80)
  await onGlobalTalkTrigger()
  let listeningState
  try {
    listeningState = await waitFor(async () => {
      const state = await orbEval('window.__nisseVoice?.state?.() || null')
      return state && state.enabled ? state : null
    }, 'injected voice controller enabled', 8_000)
  } catch (error) {
    inner.voiceSamples = voiceSamples
    inner.lastVoiceState = await orbEval('window.__nisseVoice?.state?.() || null')
    clearInterval(sampler)
    throw error
  }
  clearInterval(sampler)
  inner.voiceSamples = voiceSamples
  inner.assertions.talkKeyEnabledListening = Boolean(listeningState?.enabled)
  inner.assertions.talkKeyApplied = Number(listeningState?.applied) >= 1
  sendTalkPhase('auto-stop')
  await waitFor(async () => {
    const state = await orbEval('window.__nisseVoice?.state?.() || null')
    return state && state.enabled === false ? state : null
  }, 'injected voice controller stopped', 8_000)
  inner.assertions.talkKeyStopped = true

  // 识别中的灰色输入气泡（渲染层 setOrbBubble → 主进程 → 气泡），带取消。
  await orbEval(`window.qwenAudioAgentDesktop.setOrbBubble({ visible: true, kind: 'listening', text: '帮我看下今天的安排' })`)
  const inputBubble = await waitFor(async () => {
    const state = await bubbleState()
    return state && state.kind === 'input' ? state : null
  }, 'recognizing input bubble', 6_000)
  inner.assertions.inputBubbleText = inputBubble.text
  inner.assertions.inputBubbleCancel = inputBubble.cancel === true
  await captureShot('pet-voice-input-bubble.png')
  await bubbleEval("document.getElementById('bubble-cancel').click()")
  const cancelledBubble = await waitFor(async () => {
    const state = await bubbleState()
    return state && /已取消/.test(state.text || '') ? state : null
  }, 'voice cancel status bubble', 6_000)
  inner.assertions.inputBubbleCancelled = Boolean(cancelledBubble)

  // 语音错误气泡：壳里没有 Key 时点说话键 → 明确说「去 DSH 设置填 Key」。
  await setStage('voice-error')
  await sleep(400)
  await onGlobalTalkTrigger()
  const errorBubble = await waitFor(async () => {
    const state = await bubbleState()
    return state && state.kind === 'error' ? state : null
  }, 'voice missing-key error bubble', 8_000)
  inner.assertions.voiceErrorBubble = /API Key/.test(errorBubble.text || '')
  await captureShot('pet-voice-error-bubble.png')
  await setStage('voice-restore')
  await sleep(700)

  // ---- (a) 活动气泡：binding /events tool.call → 图标 + 文件名 + 点击穿透 ----
  // 活动阶段先关闭 turn 跟踪，避免真实系统 idle 波动误触发暂停。
  bridgeEventsSuppressed = true
  await setStage('activity')
  const activityBubble = await waitFor(async () => {
    const state = await bubbleState()
    return state && state.kind === 'activity' ? state : null
  }, 'activity bubble', 15_000)
  inner.assertions.activityText = activityBubble.text
  inner.assertions.activityHasFileName = /report\.md/.test(activityBubble.text || '')
  inner.assertions.activityClickThrough = activityBubble.clickThrough === true
  inner.assertions.activityNotInteractive = orbBubbleController?.isInteractive?.() === false
  await captureShot('pet-activity-write-file.png')
  await setStage('activity-done')
  await waitFor(async () => {
    // 主进程是权威：hideBubble() 会把 orbBubblePayload 置空（气泡窗口只是被
    // 隐藏，渲染层 DOM 的 class 不会自动变）。
    return orbBubblePayload === null || orbBubblePayload.kind !== 'activity'
  }, 'activity bubble cleared', 12_000)
  inner.assertions.activityCleared = true

  // ---- (b) 碰键鼠立即暂停：turn 运行中注入 idle=0.25s → bridge POST /cancel ----
  bridgeEventsSuppressed = false
  await setStage('pause')
  await waitFor(() => turnActive === true, 'bridge turn running', 15_000)
  smokeIdleSecondsOverride = 0.25
  await waitFor(() => pauseStatus.paused >= 1, 'pause triggered by idle', 12_000)
  const pausedBubbleState = await waitFor(async () => {
    const state = await bubbleState()
    return state && /已暂停/.test(state.text || '') ? state : null
  }, 'paused bubble', 8_000)
  inner.assertions.pauseBubble = pausedBubbleState.text
  inner.assertions.pauseStatus = pauseStatus
  inner.assertions.pauseTurnActiveAfter = turnActive
  await captureShot('pet-paused-bubble.png')
  smokeIdleSecondsOverride = null
  await setStage('pause-done')
  await sleep(600)

  inner.assertions.bridgeCancel = pauseStatus.lastPause
  smokeLog(`experience probe done stages=${inner.stages.join(',')}`)
  return inner
}


// ---- PET-VOICE-UX-ROUND2 smoke（env 门控）----
// 验证：提示不再常驻（首启一次 + hover）/ koffi 全局 Option 轮询接线 /
// 麦克风点击 toggle 语义（mouseup 不取消、不发 bridge /cancel）。
async function runVoiceUxRestartProbe() {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const inner = { assertions: {}, errors: [] }
  voiceUxProbeLast = inner
  const waitFor = async (check, label, timeoutMs = 20_000) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = await check()
      if (value) return value
      await sleep(120)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
  const voiceState = async () => {
    try { return await mainWindow.webContents.executeJavaScript('window.__nisseVoice?.state?.() || null') } catch { return null }
  }
  await waitFor(async () => {
    const state = await voiceState()
    return state && state.hasButton ? state : null
  }, 'injected voice controls (restart)', 25_000)
  // 首启提示只显示一次：第二次启动不应自动出现（只有 hover 才显示）。
  await sleep(1_800)
  const state = await voiceState()
  inner.assertions.hintHiddenOnSecondLaunch = state?.hintVisible !== true
  inner.assertions.hintConsumedOnSecondLaunch = state?.hintConsumed === true
  inner.assertions.hintText = state?.hintText
  inner.assertions.effectiveHint = currentTalkKeyHint()
  return inner
}

async function runVoiceUxSmokeProbe() {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const smokeLog = message => console.log(`[smoke] ${message}`)
  const evidenceDir = String(process.env.NISSE_SMOKE_EVIDENCE_DIR || '').trim()
  const inner = { assertions: {}, shots: [], errors: [], stages: [] }
  voiceUxProbeLast = inner
  const orbEval = async js => {
    if (!mainWindow || mainWindow.isDestroyed()) return null
    try { return await mainWindow.webContents.executeJavaScript(js) } catch (error) {
      inner.errors.push(`orbEval:${String(error?.message || error).slice(0, 160)}`)
      return null
    }
  }
  const waitFor = async (check, label, timeoutMs = 12_000, intervalMs = 120) => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      const value = await check()
      if (value) return value
      await sleep(intervalMs)
    }
    throw new Error(`timeout waiting for ${label}`)
  }
  const voiceState = () => orbEval('window.__nisseVoice?.state?.() || null')
  const captureShot = async name => {
    if (!evidenceDir) return
    try {
      const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null
      if (!contents) return
      const image = await contents.capturePage()
      const file = join(evidenceDir, name)
      writeFileSync(file, image.toPNG())
      inner.shots.push({ name, file })
      smokeLog(`shot ${name}`)
    } catch (error) {
      inner.errors.push(`shot:${name}:${String(error?.message || error)}`)
    }
  }
  const hintStatus = () => ({
    hint: currentTalkKeyHint(),
    globalOption: globalOptionStatus.available === true,
    talkKey: talkKeyStatus,
  })

  // 控制器的注入层要等渲染层加载完并找到麦克风按钮。
  await waitFor(async () => {
    const state = await voiceState()
    return state && state.hasButton ? state : null
  }, 'injected voice controls', 25_000)
  inner.assertions.injectedControlsReady = true
  inner.assertions.effectiveHint = currentTalkKeyHint()
  inner.assertions.globalOptionAvailable = globalOptionStatus.available === true
  inner.assertions.globalOptionDiagnostics = {
    frameworkPath: globalOptionStatus.frameworkPath || '',
    koffiVersion: globalOptionStatus.koffiVersion || '',
    error: globalOptionStatus.error || '',
    watcher: globalOptionWatcher?.state?.() || null,
  }

  // ---- 1) 首启提示：显示一次（不再常驻），说话/点击后隐藏 ----
  const firstRun = await waitFor(async () => {
    const state = await voiceState()
    return state && state.hintVisible === true ? state : null
  }, 'first-run hint visible', 10_000)
  inner.assertions.firstRunHintVisible = true
  inner.assertions.firstRunHintText = firstRun.hintText
  inner.assertions.firstRunHintShows = firstRun.hintShows
  inner.assertions.firstRunBadgeStyle = await orbEval(`(() => {
    const badge = document.querySelector('.nisse-voice-badge');
    if (!badge) return null;
    const rect = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return { text: badge.textContent, width: rect.width, height: rect.height, opacity: style.opacity, display: style.display, fontSize: style.fontSize, scrollWidth: badge.scrollWidth };
  })()`)
  await sleep(350)
  await captureShot('pet-hint-first-run.png')
  const onceMs = Number(process.env.NISSE_HINT_ONCE_MS) || 5_000
  await sleep(onceMs + 900)
  const afterOnce = await voiceState()
  inner.assertions.firstRunHintAutoHides = afterOnce?.hintVisible !== true

  // ---- hover 显示 / 移出隐藏 ----
  await orbEval(`(() => {
    const stage = document.querySelector('.desktop-orb-stage');
    const target = stage || document.body;
    target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, cancelable: true, relatedTarget: null }));
    return true;
  })()`)
  const hoverShown = await waitFor(async () => {
    const state = await voiceState()
    return state && state.hintVisible === true ? state : null
  }, 'hover hint visible', 5_000)
  inner.assertions.hoverHintVisible = true
  inner.assertions.hoverHintText = hoverShown.hintText
  inner.assertions.hintMatchesEffectiveKey = hoverShown.hintText === currentTalkKeyHint().text
  inner.assertions.hoverBadgeStyle = await orbEval(`(() => {
    const badge = document.querySelector('.nisse-voice-badge');
    if (!badge) return null;
    const rect = badge.getBoundingClientRect();
    const style = getComputedStyle(badge);
    return { text: badge.textContent, width: rect.width, height: rect.height, x: rect.x, y: rect.y, opacity: style.opacity, display: style.display, fontSize: style.fontSize, scrollWidth: badge.scrollWidth };
  })()`)
  // 等一帧合成再截图，避免抓到 transition 起点。
  await sleep(350)
  await captureShot('pet-hint-hover.png')
  await orbEval(`(() => {
    const stage = document.querySelector('.desktop-orb-stage');
    const target = stage || document.body;
    target.dispatchEvent(new PointerEvent('pointerout', {
      bubbles: true, cancelable: true,
      relatedTarget: document.documentElement,
    }));
    return true;
  })()`)
  await sleep(900)
  const afterHover = await voiceState()
  inner.assertions.hoverHintHides = afterHover?.hintVisible !== true

  // ---- 2) 全局 Option 轮询：注入按下/松开 → 收听开/关 ----
  if (globalOptionStatus.available === true) {
    smokeOptionPressedOverride = true
    const listening = await waitFor(async () => {
      const state = await voiceState()
      return state && state.enabled === true ? state : null
    }, 'global option down enables listening', 8_000)
    inner.assertions.optionPressStartsListening = true
    inner.assertions.optionPressEnabledBy = listening.enabledBy
    inner.assertions.optionWatcherState = globalOptionWatcher?.state?.() || null
    inner.assertions.hintHiddenWhenListening = listening.hintVisible !== true
    await captureShot('pet-global-option-listening.png')
    await waitFor(() => lastVoiceReport.hintSeen === true, 'hintSeen persisted report', 5_000)
    inner.assertions.hintSeenPersisted = true
    smokeOptionPressedOverride = false
    await waitFor(async () => {
      const state = await voiceState()
      return state && state.enabled === false ? state : null
    }, 'global option release stops listening', 8_000)
    inner.assertions.optionReleaseStopsListening = true
    inner.assertions.optionWatcherAfter = globalOptionWatcher?.state?.() || null
  } else {
    // 降级路径：提示必须显示实际生效的全局组合键（Alt+Space）。
    inner.assertions.fallbackHint = currentTalkKeyHint()
    inner.assertions.optionFallbackHintShown = currentTalkKeyHint().source === 'accelerator'
  }

  // ---- 3) 麦克风点击 toggle：mouseup 不取消、不发 /cancel ----
  // 先切到 dry-run 层验证「状态 开 → mouseup → 仍开 → 再点 → 关」。
  await orbEval(`window.__nisseVoice.updateConfig({ dryRun: true }); true`)
  const enableResult = await orbEval(`window.__nisseVoice.applyAction('enable', 'click'); true`)
  await waitFor(async () => {
    const state = await voiceState()
    return state && state.enabled === true ? state : null
  }, 'dry-run click enable', 6_000)
  inner.assertions.toggleFirstClickEnables = true
  const appliedBeforeMouseup = (await voiceState())?.applied
  const samples = []
  const sampler = setInterval(() => {
    void voiceState().then(state => {
      if (!state) return
      samples.push({ at: Date.now(), enabled: state.enabled, enabledBy: state.enabledBy, actions: state.actions, log: state.debugLog })
      if (samples.length > 40) samples.shift()
    })
  }, 120)
  // 模拟用户松开鼠标：pointerup + mouseup 都不允许停止/取消。
  await orbEval(`(() => {
    const button = document.querySelector('.desktop-orb-controls button');
    const target = button || document;
    target.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
    target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0 }));
    document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
    return true;
  })()`)
  await sleep(700)
  clearInterval(sampler)
  inner.toggleSamples = samples
  const afterMouseup = await voiceState()
  inner.assertions.mouseupKeepsListening = afterMouseup?.enabled === true
  inner.assertions.mouseupSendsNoDisable = (afterMouseup?.applied || 0) === (appliedBeforeMouseup || 0)
  inner.assertions.noBridgeCancelDuringToggle = (pauseStatus.paused || 0) === 0
  // 第二次点击 = 结束并发送（这里用同一条 toggle 关闭动作表达）。
  await orbEval(`window.__nisseVoice.applyAction('disable', 'click'); true`)
  await waitFor(async () => {
    const state = await voiceState()
    return state && state.enabled === false ? state : null
  }, 'dry-run second click stops listening', 6_000)
  inner.assertions.toggleSecondClickStops = true
  const finalState = await voiceState()
  inner.assertions.toggleClicksApplied = finalState?.applied || 0
  inner.assertions.hintStaysHiddenAfterUse = finalState?.hintVisible !== true
  inner.assertions.hintConsumed = finalState?.hintConsumed === true
  inner.assertions.hintSeenPersistedFile = (() => {
    try { return experienceStore.load().voiceInput?.hintSeen === true } catch { return false }
  })()
  inner.assertions.bridgeCancelsFromPet = {
    pauseStatus: pauseStatus.paused || 0,
  }
  inner.finalVoiceState = finalState
  inner.finalHint = hintStatus()
  inner.hintDebugLog = (await voiceState())?.debugLog || []
  smokeLog('voice-ux probe done')
  return inner
}

async function runSmokeProbe() {
  if (!smokeProbeFile || smokeProbeStarted) return
  smokeProbeStarted = true
  const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
  const details = { shots: [] }
  const smokeLog = message => console.log(`[smoke] ${message}`)
  try {
    smokeLog('probe-start')
    await sleep(Number(process.env.NISSE_SMOKE_DELAY_MS || 2500))
    smokeLog(`probe-delay-done main=${Boolean(mainWindow)} destroyed=${mainWindow?.isDestroyed?.()}`)
    if (process.env.NISSE_SMOKE_VOICE_UX === '1') {
      details.voiceUx = await runVoiceUxSmokeProbe()
      smokeLog('voice-ux-probe-done')
    } else if (process.env.NISSE_SMOKE_VOICE_UX === '2') {
      details.voiceUxRestart = await runVoiceUxRestartProbe()
      smokeLog('voice-ux-restart-probe-done')
    }
    if (process.env.NISSE_SMOKE_EXPERIENCE === '1') {
      details.experienceSmoke = await runExperienceSmokeProbe()
      smokeLog('experience-probe-done')
    }
    if (process.env.NISSE_SMOKE_DBLCLICK === '1' && mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.executeJavaScript(
        "document.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))",
      )
      await sleep(600)
      details.dblclickDispatched = true
      smokeLog('dblclick-dispatched')
    }
    if (process.env.NISSE_SMOKE_APPROVAL === '1') {
      // 审批气泡必须来自 bridge /events 的 approval.request（W4 链路），
      // 这里只等待，不伪造气泡内容。
      const waitStarted = Date.now()
      while (!orbBubblePayload?.approval && Date.now() - waitStarted < 8000) {
        await sleep(200)
      }
      const approval = orbBubblePayload?.approval
      smokeLog(`approval-bubble from bridge id=${approval?.id || 'missing'}`)
      if (!approval) throw new Error('bridge approval.request did not reach the bubble')
      await sleep(300)
      const contents = orbBubbleController?._webContents?.()
      if (contents && !contents.isDestroyed()) {
        await contents.executeJavaScript(
          "document.querySelector('.card')?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))",
        )
        await sleep(200)
        details.bubbleInteractiveAfterMouseMove = orbBubbleController?.isInteractive?.() === true
        const bubbleShotEnv = String(process.env.NISSE_SMOKE_SCREENSHOT || '').trim()
        if (bubbleShotEnv) {
          const bubbleShot = bubbleShotEnv.replace(/\.png$/i, '') + '-bubble.png'
          try {
            const bubbleImage = await contents.capturePage()
            writeFileSync(bubbleShot, bubbleImage.toPNG())
            details.shots.push(bubbleShot)
            smokeLog(`screenshot-bubble ${bubbleShot}`)
          } catch (error) {
            smokeLog(`screenshot-bubble-error ${String(error?.message || error)}`)
          }
        }
        await contents.executeJavaScript(
          "document.querySelectorAll('#bubble-actions button')[0]?.click()",
        )
        await sleep(600)
        details.approvalClicked = true
        smokeLog('approval-clicked')
      }
    }
    const screenshotPath = String(process.env.NISSE_SMOKE_SCREENSHOT || '').trim()
    if (screenshotPath && mainWindow && !mainWindow.isDestroyed()) {
      const image = await mainWindow.webContents.capturePage()
      writeFileSync(screenshotPath, image.toPNG())
      details.shots.push(screenshotPath)
      smokeLog(`screenshot-orb ${screenshotPath}`)
    }
  } catch (error) {
    details.error = String(error?.message || error)
    details.experienceProbePartial = experienceProbeLast
    details.voiceUxProbePartial = voiceUxProbeLast
    smokeLog(`probe-error ${details.error}`)
  }
  smokeLog('probe-done')
  writeSmokeStatus(details)
  if (process.env.NISSE_SMOKE_EXIT === '1') app.quit()
}

// ---- app lifecycle ----

// The desktop shell removes Electron's SingletonLock files before spawning the
// pet (to recover from stale locks). Keep our own pid marker so two pets can
// never render overlapping windows/error bubbles for the same userData.
function claimPetInstance() {
  const markerPath = join(app.getPath('userData'), 'whalegirl-pet.instance.json')
  try {
    if (existsSync(markerPath)) {
      const info = JSON.parse(readFileSync(markerPath, 'utf8'))
      const pid = Number(info?.pid)
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0)
          logger.info('desktop.instance_already_running', { pid })
          return false
        } catch (error) {
          if (error?.code !== 'ESRCH') {
            logger.warn('desktop.instance_probe_failed', { pid, error: String(error?.message || error) })
            return false
          }
        }
      }
    }
    writeFileSync(markerPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + '\n')
    app.on('will-quit', () => {
      try {
        const info = JSON.parse(readFileSync(markerPath, 'utf8'))
        if (Number(info?.pid) === process.pid) rmSync(markerPath, { force: true })
      } catch {}
    })
    return true
  } catch (error) {
    logger.warn('desktop.instance_marker_failed', { error: String(error?.message || error) })
    return true
  }
}

if (!claimPetInstance() || !app.requestSingleInstanceLock()) {
  app.exit(0)
} else {
  app.on('second-instance', () => {
    showDesktop('second-instance')
  })

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && process.defaultApp) {
      app.setActivationPolicy('accessory')
      app.dock?.hide()
    }
    createTray()
    voiceWorkerStartPromise = voiceWorkerRuntime.config.enabled
      ? voiceWorkerRuntime.start().then((snapshot) => {
        logger.info('voice_worker.ready_state', snapshot)
        return snapshot
      }).catch((error) => {
        logger.warn('voice_worker.start_threw', { error: String(error?.message || error) })
        return voiceWorkerRuntime.snapshot()
      })
      : Promise.resolve(voiceWorkerRuntime.snapshot())
    const voiceWorkerStart = voiceWorkerStartPromise
    if (process.env.NISSE_VOICE_WORKER_SMOKE_FILE) {
      const smokeFile = String(process.env.NISSE_VOICE_WORKER_SMOKE_FILE)
      setTimeout(async () => {
        try {
          await voiceWorkerStart
          const status = { worker: voiceWorkerRuntime.snapshot(), bridge: await voiceWorkerRuntime.checkBridge() }
          try {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const raw = await mainWindow.webContents.executeJavaScript(
                `JSON.stringify({ config: window.__WG_VOICE_CONFIG__ || null, status: window.__wgVoice?.getStatus?.() || null })`,
              )
              status.client = JSON.parse(raw)
            }
          } catch (error) {
            status.client = { error: String(error?.message || error) }
          }
          writeFileSync(smokeFile, JSON.stringify(status, null, 2) + '\n')
        } catch (error) {
          try { writeFileSync(smokeFile, JSON.stringify({ error: String(error?.message || error) }) + '\n') } catch {}
        } finally {
          app.quit()
        }
      }, Number(process.env.NISSE_VOICE_WORKER_SMOKE_DELAY_MS || 3000))
    }
    const refreshDesktopTaskSurface = () => {
      updateDesktopTaskSurface(desktopTaskCount)
    }
    screen.on('display-added', refreshDesktopTaskSurface)
    screen.on('display-removed', refreshDesktopTaskSurface)
    screen.on('display-metrics-changed', refreshDesktopTaskSurface)
    if (!desktopPresence.registerShortcut(initialPreferences.wakeShortcut)) {
      logger.warn('desktop.wake_shortcut_unavailable', {
        accelerator: initialPreferences.wakeShortcut,
      })
    }
    // 语音输入 round2：优先 koffi+CGEventSourceKeyState 实现真正全局「按住
    // Option/Alt」；不可用则自动回退 Alt+Space 全局组合键，提示文案随实际按键。
    globalOptionStatus = loadGlobalOptionKeyState({ env: process.env, logger })
    logger.info('global_option.status', {
      available: globalOptionStatus.available,
      koffiPath: globalOptionStatus.koffiPath || '',
      koffiVersion: globalOptionStatus.koffiVersion || '',
      frameworkPath: globalOptionStatus.frameworkPath || '',
      error: globalOptionStatus.error || '',
      probe: globalOptionStatus.probe,
    })
    if (globalOptionStatus.available) startGlobalOptionWatcher()
    // 语音输入：注册说话键（全局兜底）并同步注入层配置。
    registerTalkKey()
    try {
      await ensureDesktopUi()
    } catch (error) {
      // 不弹独立设置窗：记录错误，桌面壳负责把语音/配置问题显示在 DSH。
      logger.error('desktop.ui_start_failed', { error: String(error?.message || error) })
    }
    // 碰键鼠暂停 + 壳 Bot 设置的初始读取（behavior.pauseOnInput / voice key）。
    startPauseMonitor()
    void refreshShellConfig({ quiet: true }).then(config => {
      if (!config) return
      logger.info('shell.config_loaded', {
        voiceProvider: config.voice?.provider,
        voiceKeySet: config.voice?.apiKeySet === true,
        llmProvider: config.llm?.provider,
        approval: config.approval || null,
        behavior: config.behavior || null,
      })
    })
    // Pet-led onboarding：首启自动开始；有未完成进度自动续上；已完成不打扰。
    if (!onboardingProgress || shouldAutoStart(onboardingProgress)) {
      setTimeout(() => {
        if (!onboardingActive) startOnboarding({ restart: false })
      }, Number(process.env.NISSE_ONBOARDING_DELAY_MS) || 1_600)
    } else {
      updateTrayMenu()
    }
    // 「一直听」模式：启动后确认语音可用再开麦（默认 hold，不会自动开麦）。
    if (voiceInputSettings.mode === 'always') {
      setTimeout(() => {
        void ensureVoiceReady().then(ready => {
          if (ready.ok) sendVoiceCommand('enable')
        })
      }, 6_000)
    }
    if (process.env.QWAUDIO_DEBUG_BUBBLE === '1') {
      setTimeout(() => {
        try {
          showBubble({
            text: process.env.QWAUDIO_DEBUG_BUBBLE_TEXT || '示例：长回答气泡（调试用）。',
            kind: process.env.QWAUDIO_DEBUG_BUBBLE_KIND || 'speech',
          })
        } catch (error) {
          logger.warn('debug.bubble_failed', { error: String(error) })
        }
      }, Number(process.env.QWAUDIO_DEBUG_BUBBLE_DELAY_MS || 6000))
    }
    if (smokeProbeFile && mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.webContents.isLoading()) {
        mainWindow.webContents.once('did-finish-load', () => { void runSmokeProbe() })
      } else {
        void runSmokeProbe()
      }
    }
    app.on('activate', () => {
      showDesktop('activate')
    })
  }).catch(error => {
    const message = error?.stack || error?.message || String(error)
    logger.fatal('desktop.start_failed', { error, message })
    app.quit()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', createGracefulShutdown({
    app,
    cleanup: async () => {
      logger.info('desktop.stopping')
      desktopPresence.destroy()
      desktopWakeWord.stop()
      stopPauseMonitor()
      stopGlobalOptionWatcher()
      clearTimeout(talkKeyAutoStopTimer)
      talkKeyAutoStopTimer = null
      clearTimeout(activityHideTimer)
      activityHideTimer = null
      clearTimeout(bridgePollTimer)
      bridgePollTimer = null
      bridgePollActive = false
      tray?.destroy()
      tray = null
      const server = rendererServer
      rendererServer = null
      await Promise.allSettled([
        server?.close(),
        voiceWorkerRuntime.stop(),
      ])
      await logger.flush?.()
    },
    onError: error => logger.error('desktop.stop_failed', { error }),
  }))
}
