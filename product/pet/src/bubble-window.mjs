// 头顶聊天气泡窗口：一个固定尺寸、透明、默认点击穿透、不抢焦点的独立
// BrowserWindow。它不参与主 orb 窗口的布局/resize —— 气泡出现或消失
// 都只改内容与显隐，orb 窗口位置与尺寸保持不变，因此不会出现
// 「窗口 resize 与渲染层 offset 跨进程不同步」造成的帧抽动。
//
// 本文件是 `window-layer-policy.mjs` 的薄执行器：层级/Spaces/焦点/点击穿透、
// 相对桌宠的几何位置、24 logical px 锚定预算与有界 fallback、进程类型决定的
// skipTransformProcessType、以及有界窗口诊断全部由 policy 决定；这里只负责
// 创建 BrowserWindow、加载页面、维护 ready/visible/inputMode 与内容高度适配。
// 纯函数（orbBubbleWindowBounds/desktopTaskStackHeight/orbBubbleHeadroom）仍然
// 导出并由既有测试/主进程使用。
//
// 气泡必须可交互（是/否审批按钮）：窗口默认 setIgnoreMouseEvents(true,
// { forward: true })，透明区域点击落到下面的窗口；渲染层检测到指针进入
// 气泡卡片时通过 IPC 请求 setInteractive(true)，卡片区域才接收点击。
// forward 让穿透状态下仍能收到 mousemove，指针移出卡片后立即恢复穿透。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_TASK_CARD_GAP,
  DESKTOP_TASK_CARD_HEIGHT,
  DESKTOP_TASK_STACK_LIFT,
  DESKTOP_TASK_STACK_PADDING,
} from './desktop-surface-layout.mjs'
import {
  ANCHOR_GAP_PX,
  createWindowLayerController,
  fitBubbleWindowBounds,
  normalizeProcessType,
  selectBubblePlacement,
} from './window-layer-policy.mjs'

const here = dirname(fileURLToPath(import.meta.url))

// 引导（onboarding）在气泡里带输入行 + 2×2 选项，窗口需要比纯文字气泡高
// 一些；卡片刻意底部对齐，所以窗口变高只向上扩透明区域。
export const ORB_BUBBLE_WINDOW_WIDTH = 380
export const ORB_BUBBLE_WINDOW_HEIGHT = 420
/** 短回复时窗口可以收拢到的最小高度；内容测量值由渲染层上报。 */
export const ORB_BUBBLE_WINDOW_MIN_HEIGHT = 118
const ORB_BUBBLE_TAIL_TIP_OFFSET = 42
export const ORB_BUBBLE_TAIL_OVERLAP = ORB_BUBBLE_TAIL_TIP_OFFSET
/** 气泡正文最多 3 行（与 bubble.css 的 line-clamp 保持一致）。 */
export const ORB_BUBBLE_MAX_LINES = 3

const clamp = (value, minimum, maximum) => Math.min(Math.max(minimum, value), maximum)

/** 上方任务卡栈占据的高度（与 desktop-surface-layout 的 taskSurfaceHeight 同源）。 */
export function desktopTaskStackHeight(taskCount) {
  const count = Math.max(0, Math.floor(Number(taskCount) || 0))
  if (!count) return 0
  return (
    count * DESKTOP_TASK_CARD_HEIGHT
    + Math.max(0, count - 1) * DESKTOP_TASK_CARD_GAP
    + DESKTOP_TASK_STACK_PADDING * 2
    - DESKTOP_TASK_STACK_LIFT
  )
}

/** orb 上方给气泡/卡片留下的可用空间（像素）。 */
export function orbBubbleHeadroom({ orbBounds, taskCount = 0, taskPlacement = 'below', workArea }) {
  const cards = taskPlacement === 'above' ? desktopTaskStackHeight(taskCount) : 0
  return Math.max(0, Math.round(orbBounds.y - workArea.y - cards))
}

/**
 * 气泡窗口在屏幕上的位置。
 *
 * 几何优先级（window-layer-policy §selectBubblePlacement，固定顺序）：
 * 屏内可见且关键控件可操作 → 贴近桌宠（24 logical px 预算）→ 减少重叠 →
 * 美观。头顶放不下时先缩内容区（渲染层滚动），再退到侧边；空间极端不足时
 * 允许有界重叠，但不把气泡送到远端、不裁掉审批按钮。多屏/负坐标/缩放/
 * Dock 边距由 policy 处理。
 */
export function orbBubbleWindowBounds(options) {
  const cards = options.taskPlacement === 'above' ? desktopTaskStackHeight(options.taskCount) : 0
  const requestedGap = Number(options.anchorGapPx)
  const gap = Number.isFinite(requestedGap) && requestedGap > 0 ? requestedGap : ANCHOR_GAP_PX
  // `placement` is the presentation intent from snapshot.presentation.bubblePolicy;
  // it is echoed for diagnostics but never overrides the safety priority in the
  // policy (onscreen/controls > anchor > overlap > aesthetics).
  const requestedPlacement = typeof options.placement === 'string' ? options.placement : null
  const placement = selectBubblePlacement({
    orbBounds: options.orbBounds,
    workArea: options.workArea,
    displays: options.displays ?? null,
    avoidBounds: options.avoidBounds ?? [],
    width: ORB_BUBBLE_WINDOW_WIDTH,
    height: ORB_BUBBLE_WINDOW_HEIGHT,
    minHeight: ORB_BUBBLE_WINDOW_MIN_HEIGHT,
    gap,
    tailOverlapPx: ORB_BUBBLE_TAIL_OVERLAP,
    blockedAbovePx: cards,
    scaleFactor: options.scaleFactor ?? null,
  })
  return {
    ...placement.bounds,
    placement: placement.placement,
    requestedPlacement,
    slot: placement.slot,
    display: placement.display,
    anchorGapPx: placement.anchorGapPx,
    gapBudgetPx: placement.gapBudgetPx,
    deviceGapBudgetPx: placement.deviceGapBudgetPx,
    withinAnchorBudget: placement.withinAnchorBudget,
    fullyOnscreen: placement.fullyOnscreen,
    controlsOperable: placement.controlsOperable,
    scrollFallback: placement.scrollFallback,
    contentHeightLimitPx: placement.contentHeightLimitPx,
    boundedOverlap: placement.boundedOverlap,
    actionsClipped: placement.actionsClipped,
    diagnostics: placement.diagnostics,
  }
}

/**
 * 气泡窗口管理器。主进程只通过 ensure/show/hide/reposition/destroy 操作它；
 * 不传 electron 依赖进来时，测试可以只测纯函数。
 *
 * `processType` 是实际激活策略（'foreground'/'uielement'/'prohibited'/
 * 'unknown'，或返回它的函数），用于决定 setVisibleOnAllWorkspaces 的
 * skipTransformProcessType；不提供时按前台应用处理（安全默认，不无条件 true）。
 */
export function createBubbleWindowController({
  BrowserWindow,
  logger = null,
  preloadPath = join(here, 'bubble-preload.cjs'),
  pagePath = join(here, 'bubble.html'),
  pageUrl = '',
  processType = 'foreground',
  platform = process.platform,
} = {}) {
  const layer = createWindowLayerController({ logger, platform, processType })
  let window = null
  let ready = false
  let visible = false
  let interactive = false
  let inputMode = false
  let lastPayload = null
  let bounds = null
  let baseBounds = null
  let contentHeight = null

  const currentProcessType = () => (
    typeof processType === 'function' ? normalizeProcessType(processType()) : normalizeProcessType(processType)
  )

  function fittedBounds() {
    if (!baseBounds) return null
    return fitBubbleWindowBounds({
      baseBounds,
      contentHeight,
      minHeight: ORB_BUBBLE_WINDOW_MIN_HEIGHT,
    })
  }

  function applyFittedBounds() {
    const next = fittedBounds()
    if (!next) return
    bounds = next
    layer.applyBounds(window, next, { role: 'bubble' })
  }

  function applyMouseMode() {
    if (!window || window.isDestroyed()) return
    layer.applyInteraction(window, { role: 'bubble', interactive, inputMode })
  }

  function record(kind, detail) {
    layer.diagnostics.record(kind, detail)
  }

  function ensure() {
    if (window && !window.isDestroyed()) return window
    if (typeof BrowserWindow !== 'function') return null
    window = new BrowserWindow({
      width: ORB_BUBBLE_WINDOW_WIDTH,
      height: ORB_BUBBLE_WINDOW_HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#00000000',
      title: 'Nisse 头顶气泡',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: preloadPath,
      },
    })
    // 层级/Spaces/进程类型策略统一由 window-layer-policy 决定；这里不再
    // 手写 screen-saver/skipTransformProcessType 组合。
    layer.applyLayer(window, { role: 'bubble' })
    layer.diagnostics.record('desktop.bubble_process_type', { processType: currentProcessType() })
    applyMouseMode()
    ready = false
    const webContents = window.webContents
    webContents.once('did-finish-load', () => {
      ready = true
      try { window.setFocusable(inputMode) } catch {}
      applyMouseMode()
      if (bounds) layer.applyBounds(window, bounds, { role: 'bubble' })
      if (lastPayload) send(lastPayload)
      if (visible) {
        layer.show(window, {
          role: 'bubble',
          interactive,
          inputMode,
          focus: focusWindow,
        })
      }
    })
    // 有界诊断：load/preload/renderer 错误不能只进入空 logger 后被静默吞掉。
    webContents.on?.('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      record('desktop.bubble_load_failed', {
        errorCode: Number(errorCode),
        errorDescription: String(errorDescription || ''),
        url: String(validatedURL || '').slice(0, 300),
      })
      logger?.warn?.('desktop.bubble_window_load_failed', { errorCode, errorDescription })
    })
    webContents.on?.('preload-error', (_event, preloadPathValue, error) => {
      record('desktop.bubble_preload_error', {
        preload: String(preloadPathValue || '').slice(0, 300),
        error: String(error?.message || error || ''),
      })
      logger?.warn?.('desktop.bubble_preload_failed', { error: String(error?.message || error) })
    })
    webContents.on?.('render-process-gone', (_event, details) => {
      record('desktop.bubble_render_process_gone', {
        reason: String(details?.reason || ''),
        exitCode: Number(details?.exitCode ?? 0),
      })
      logger?.warn?.('desktop.bubble_render_process_gone', { reason: details?.reason })
      ready = false
      visible = false
    })
    window.on('unresponsive', () => record('desktop.bubble_unresponsive'))
    window.on('closed', () => {
      record('desktop.bubble_closed')
      window = null
      ready = false
      interactive = false
    })
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', event => event.preventDefault())
    void (pageUrl ? window.loadURL(pageUrl) : window.loadFile(pagePath)).catch(error => {
      record('desktop.bubble_load_failed', { error: String(error?.message || error) })
      logger?.warn?.('desktop.bubble_window_load_failed', { error: String(error?.message || error) })
    })
    return window
  }

  function send(payload) {
    if (!window || window.isDestroyed() || !ready) return
    try { window.webContents.send('nisse-bubble:update', payload) } catch (error) {
      record('desktop.bubble_send_failed', { error: String(error?.message || error) })
    }
  }

  /**
   * 气泡里有文本输入（引导/名字/Key）时需要键盘焦点。
   * 默认窗口 focusable:false（不抢 DSH 焦点）；只有输入态才临时变成可聚焦。
   */
  function setInputMode(value) {
    const next = value === true
    if (next === inputMode) {
      if (next && visible) focusWindow()
      return
    }
    inputMode = next
    if (!window || window.isDestroyed()) return
    layer.applyInteraction(window, { role: 'bubble', interactive, inputMode })
    if (next) focusWindow()
  }

  function focusWindow() {
    if (!window || window.isDestroyed() || !visible) return
    try { window.show() } catch {}
    try {
      window.focus()
    } catch (error) {
      record('desktop.bubble_focus_failed', { error: String(error?.message || error) })
      logger?.warn?.('desktop.bubble_focus_failed', { error: String(error?.message || error) })
    }
    try { window.webContents.focus() } catch {}
  }

  function show(payload) {
    lastPayload = payload
    visible = true
    setInputMode(Boolean(payload?.input))
    if (!ensure()) return
    applyFittedBounds()
    send(payload)
    if (ready) {
      // 非文本交互只做非激活显示；只有 inputMode 才显式取焦点.
      layer.show(window, { role: 'bubble', interactive, inputMode, focus: focusWindow })
    }
  }

  function hide() {
    visible = false
    lastPayload = null
    interactive = false
    setInputMode(false)
    applyMouseMode()
    if (window && !window.isDestroyed()) layer.hide(window, { role: 'bubble' })
  }

  function setInteractive(value) {
    const next = value === true
    if (next === interactive) return
    interactive = next
    applyMouseMode()
  }

  function owns(webContents) {
    return Boolean(
      window
      && !window.isDestroyed()
      && webContents
      && window.webContents === webContents,
    )
  }

  function reposition(nextBounds) {
    baseBounds = nextBounds
    applyFittedBounds()
  }

  /** The renderer measured its card; keep the bottom anchor and shrink/grow the window. */
  function resize(height) {
    const value = Number(height)
    if (!Number.isFinite(value) || value <= 0) return
    const maximum = baseBounds?.height ?? ORB_BUBBLE_WINDOW_HEIGHT
    const clamped = clamp(Math.round(value), ORB_BUBBLE_WINDOW_MIN_HEIGHT, maximum)
    if (contentHeight !== null && Math.abs(clamped - contentHeight) < 2) return
    contentHeight = clamped
    applyFittedBounds()
  }

  function destroy() {
    visible = false
    lastPayload = null
    baseBounds = null
    contentHeight = null
    interactive = false
    inputMode = false
    if (window && !window.isDestroyed()) window.destroy()
    window = null
    ready = false
    record('desktop.bubble_destroyed')
  }

  return {
    show,
    hide,
    reposition,
    resize,
    destroy,
    setInteractive,
    setInputMode,
    focusWindow,
    owns,
    isVisible: () => visible,
    isInteractive: () => interactive,
    isInputMode: () => inputMode,
    lastPayload: () => lastPayload,
    /** Bounded window diagnostics for the actual native window (no silent errors). */
    diagnostics: () => layer.diagnostics.snapshot(),
    // 测试/诊断用
    _state: () => ({
      visible,
      ready,
      interactive,
      inputMode,
      bounds,
      baseBounds,
      contentHeight,
      hasWindow: Boolean(window),
      diagnostics: layer.diagnostics.state(),
    }),
    _layer: () => layer,
    _webContents: () => (
      window && !window.isDestroyed() ? window.webContents : null
    ),
  }
}
