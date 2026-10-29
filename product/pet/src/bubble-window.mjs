// 头顶聊天气泡窗口：一个固定尺寸、透明、默认点击穿透、不抢焦点的独立
// BrowserWindow。它不参与主 orb 窗口的布局/resize —— 气泡出现或消失
// 都只改内容与显隐，orb 窗口位置与尺寸保持不变，因此不会出现
// 「窗口 resize 与渲染层 offset 跨进程不同步」造成的帧抽动。
//
// 气泡必须可交互（是/否审批按钮）：窗口默认 setIgnoreMouseEvents(true,
// { forward: true })，透明区域点击落到下面的窗口；渲染层检测到指针进入
// 气泡卡片时通过 IPC 请求 setInteractive(true)，卡片区域才接收点击。
// forward 让穿透状态下仍能收到 mousemove，指针移出卡片后立即恢复穿透。
//
// 几何：窗口底部在 orb 顶边下方 44px 处（尾巴尖落在鲸鱼娘头发上），
// 气泡内容在窗口内底部对齐；窗口向上/向左留出透明空间。
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_TASK_CARD_GAP,
  DESKTOP_TASK_CARD_HEIGHT,
  DESKTOP_TASK_STACK_LIFT,
  DESKTOP_TASK_STACK_PADDING,
} from './desktop-surface-layout.mjs'

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

/** 气泡窗口在屏幕上的位置（固定尺寸，底部对齐到 orb 顶边下 44px）。 */
function preferredBubbleWindowBounds({
  orbBounds,
  taskCount = 0,
  taskPlacement = 'below',
  workArea,
}) {
  const cards = taskPlacement === 'above' ? desktopTaskStackHeight(taskCount) : 0
  const centerX = orbBounds.x + Math.round(orbBounds.width / 2)
  const x = clamp(
    centerX - Math.round(ORB_BUBBLE_WINDOW_WIDTH / 2),
    workArea.x,
    workArea.x + workArea.width - ORB_BUBBLE_WINDOW_WIDTH,
  )
  // 让尾巴尖落在角色头顶（角色头顶相对 orb 窗口顶部的 offset，由皮肤/渲染层决定）。
  // 参考图效果：气泡本体在头顶上方，尾巴向下指向角色。
  // 窗口底边 = orb 顶边 + overlap（尾巴尖落在头发上）。
  const aboveY = orbBounds.y + ORB_BUBBLE_TAIL_OVERLAP - ORB_BUBBLE_WINDOW_HEIGHT - cards
  // 头顶没有足够空间时（例如 orb 贴近屏幕顶部），把气泡放到角色旁边的空白处，
  // 而不是把气泡窗口钳制在屏幕顶端、导致气泡压住角色头部。
  if (aboveY < workArea.y) {
    const gap = 12
    const leftX = orbBounds.x - ORB_BUBBLE_WINDOW_WIDTH - gap
    const rightX = orbBounds.x + orbBounds.width + gap
    let besideX
    if (leftX >= workArea.x) besideX = leftX
    else if (rightX + ORB_BUBBLE_WINDOW_WIDTH <= workArea.x + workArea.width) besideX = rightX
    else besideX = clamp(leftX, workArea.x, workArea.x + workArea.width - ORB_BUBBLE_WINDOW_WIDTH)
    const besideY = clamp(
      orbBounds.y - Math.round(ORB_BUBBLE_WINDOW_HEIGHT / 3),
      workArea.y,
      workArea.y + workArea.height - ORB_BUBBLE_WINDOW_HEIGHT,
    )
    return {
      x: Math.round(besideX),
      y: Math.round(besideY),
      width: ORB_BUBBLE_WINDOW_WIDTH,
      height: ORB_BUBBLE_WINDOW_HEIGHT,
      placement: 'beside',
    }
  }
  const y = clamp(
    aboveY,
    workArea.y,
    workArea.y + workArea.height - ORB_BUBBLE_WINDOW_HEIGHT,
  )
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: ORB_BUBBLE_WINDOW_WIDTH,
    height: ORB_BUBBLE_WINDOW_HEIGHT,
    placement: 'above',
  }
}

/** Prefer the head anchor; choose the least overlapping nearby position when the
 * main window is visible. Full-screen coverage may leave no collision-free slot. */
export function orbBubbleWindowBounds(options) {
  const preferred=preferredBubbleWindowBounds(options), avoided=options.avoidBounds||[]
  if(!avoided.length)return preferred
  const area=options.workArea,orb=options.orbBounds,w=preferred.width,h=preferred.height
  const fit=(x,y)=>({x:Math.round(clamp(x,area.x,area.x+area.width-w)),y:Math.round(clamp(y,area.y,area.y+area.height-h)),width:w,height:h,placement:'beside'})
  const candidates=[preferred,fit(orb.x-w-12,preferred.y),fit(orb.x+orb.width+12,preferred.y)]
  for(const r of avoided)candidates.push(fit(r.x-w-12,preferred.y),fit(r.x+r.width+12,preferred.y),fit(preferred.x,r.y-h-12),fit(preferred.x,r.y+r.height+12))
  const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y))
  const score=r=>avoided.reduce((sum,b)=>sum+overlap(r,b),0)+overlap(r,orb)*4
  return candidates.reduce((best,r)=>score(r)<score(best)?r:best,preferred)
}

/**
 * 气泡窗口管理器。主进程只通过 ensure/show/hide/reposition/destroy 操作它；
 * 不传 electron 依赖进来时，测试可以只测纯函数。
 */
export function createBubbleWindowController({
  BrowserWindow,
  logger = null,
  preloadPath = join(here, 'bubble-preload.cjs'),
  pagePath = join(here, 'bubble.html'),
  pageUrl = '',
} = {}) {
  let window = null
  let ready = false
  let visible = false
  let interactive = false
  let inputMode = false
  let lastPayload = null
  let bounds = null
  let baseBounds = null
  let contentHeight = null

  function fittedBounds() {
    if (!baseBounds) return null
    const height = clamp(Math.round(contentHeight ?? baseBounds.height), ORB_BUBBLE_WINDOW_MIN_HEIGHT, baseBounds.height)
    return {
      x: baseBounds.x,
      y: baseBounds.y + baseBounds.height - height,
      width: baseBounds.width,
      height,
    }
  }

  function applyFittedBounds() {
    const next = fittedBounds()
    if (!next) return
    bounds = next
    if (window && !window.isDestroyed()) {
      try { window.setBounds(next, false) } catch {}
    }
  }

  function applyMouseMode() {
    if (!window || window.isDestroyed()) return
    try {
      window.setIgnoreMouseEvents(!interactive, { forward: true })
    } catch (error) {
      logger?.warn?.('desktop.bubble_mouse_mode_failed', { error: String(error?.message || error) })
    }
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
    try {
      window.setAlwaysOnTop(true, 'floating')
      window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true })
    } catch (error) {
      logger?.warn?.('desktop.bubble_window_flags_failed', { error: String(error?.message || error) })
    }
    applyMouseMode()
    ready = false
    window.webContents.once('did-finish-load', () => {
      ready = true
      try { window.setFocusable(inputMode) } catch {}
      applyMouseMode()
      if (bounds) window.setBounds(bounds, false)
      if (lastPayload) send(lastPayload)
      if (visible) {
        if (inputMode) focusWindow()
        else { try { window.showInactive() } catch { window.show() } }
      }
    })
    window.on('closed', () => {
      window = null
      ready = false
      interactive = false
    })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    void (pageUrl ? window.loadURL(pageUrl) : window.loadFile(pagePath)).catch(error => {
      logger?.warn?.('desktop.bubble_window_load_failed', { error: String(error?.message || error) })
    })
    return window
  }

  function send(payload) {
    if (!window || window.isDestroyed() || !ready) return
    try { window.webContents.send('nisse-bubble:update', payload) } catch {}
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
    try { window.setFocusable(next) } catch (error) {
      logger?.warn?.('desktop.bubble_focusable_failed', { error: String(error?.message || error) })
    }
    if (next) focusWindow()
  }

  function focusWindow() {
    if (!window || window.isDestroyed() || !visible) return
    try { window.show() } catch {}
    try { window.focus() } catch (error) {
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
      if (inputMode) focusWindow()
      else { try { window.showInactive() } catch { window.show() } }
    }
  }

  function hide() {
    visible = false
    lastPayload = null
    interactive = false
    setInputMode(false)
    applyMouseMode()
    if (window && !window.isDestroyed()) window.hide()
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
    const clamped = clamp(Math.round(value), ORB_BUBBLE_WINDOW_MIN_HEIGHT, ORB_BUBBLE_WINDOW_HEIGHT)
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
    // 测试/诊断用
    _state: () => ({ visible, ready, interactive, inputMode, bounds, baseBounds, contentHeight, hasWindow: Boolean(window) }),
    _webContents: () => (
      window && !window.isDestroyed() ? window.webContents : null
    ),
  }
}
