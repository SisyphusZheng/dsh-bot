import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createBubbleWindowController,
  orbBubbleWindowBounds,
  ORB_BUBBLE_WINDOW_HEIGHT,
  ORB_BUBBLE_WINDOW_MIN_HEIGHT,
} from '../src/bubble-window.mjs'

function fakeWindowClass() {
  class FakeWindow {
    static instances = []
    constructor(options) {
      this.options = options
      this.on = () => {}
      this.bounds = null
      this.visible = false
      this.webContents = {
        once() {}, on() {}, send() {}, setWindowOpenHandler() {}, focus() {},
      }
      FakeWindow.instances.push(this)
    }
    setBounds(bounds) { this.bounds = bounds }
    setIgnoreMouseEvents() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    setFocusable() {}
    show() { this.visible = true }
    showInactive() { this.visible = true }
    hide() { this.visible = false }
    focus() {}
    destroy() {}
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
  }
  return FakeWindow
}

test('bubble window grows up from a fixed bottom anchor and clamps to min/max', () => {
  const FakeWindow = fakeWindowClass()
  const controller = createBubbleWindowController({ BrowserWindow: FakeWindow, preloadPath: '/p', pagePath: '/b.html' })
  controller.reposition({ x: 100, y: 300, width: 380, height: ORB_BUBBLE_WINDOW_HEIGHT })
  controller.show({ text: 'hi' })
  const base = controller._state().bounds
  assert.deepEqual(base, { x: 100, y: 300, width: 380, height: 420 })

  controller.resize(180)
  assert.deepEqual(controller._state().bounds, { x: 100, y: 540, width: 380, height: 180 })
  assert.equal(controller._state().bounds.y + controller._state().bounds.height, base.y + base.height)

  controller.resize(10)
  assert.equal(controller._state().bounds.height, ORB_BUBBLE_WINDOW_MIN_HEIGHT)
  controller.resize(9999)
  assert.equal(controller._state().bounds.height, ORB_BUBBLE_WINDOW_HEIGHT)
  controller.resize(Number.NaN)
  assert.equal(controller._state().bounds.height, ORB_BUBBLE_WINDOW_HEIGHT)

  controller.reposition({ x: 10, y: 40, width: 380, height: ORB_BUBBLE_WINDOW_HEIGHT })
  controller.resize(200)
  assert.deepEqual(controller._state().bounds, { x: 10, y: 260, width: 380, height: 200 })
  controller.destroy()
})

test('main window avoidance keeps the bubble anchored to the pet and inside a scaled display',()=>{
 const orb={x:1400,y:800,width:172,height:204},area={x:0,y:0,width:1920,height:1080},main={x:1100,y:100,width:820,height:650}
 const before={...orb},bounds=orbBubbleWindowBounds({orbBounds:orb,workArea:area,avoidBounds:[main]})
 const distance=Math.hypot((bounds.x+bounds.width/2)-(orb.x+orb.width/2),(bounds.y+bounds.height/2)-(orb.y+orb.height/2))
 assert.ok(distance<500,`bubble drifted ${distance}px from the pet`);assert.deepEqual(orb,before)
 for(const avoid of [[{...area}],[]]){const b=orbBubbleWindowBounds({orbBounds:{x:-900,y:60,width:172,height:204},workArea:{x:-1280,y:0,width:1280,height:900},avoidBounds:avoid});assert.ok(b.x>=-1280&&b.y>=0&&b.x+b.width<=0&&b.y+b.height<=900)}
})

function recordingWindowClass() {
  class RecordingWindow {
    static instances = []
    constructor(options) {
      this.options = options
      this.calls = []
      this.handlers = {}
      this.onceHandlers = {}
      this.visible = false
      this.webContents = {
        calls: [],
        once: (event, fn) => { (this.onceHandlers[event] ||= []).push(fn) },
        on: (event, fn) => { (this.handlers[event] ||= []).push(fn) },
        send: (...args) => { this.webContents.calls.push(['send', ...args]) },
        setWindowOpenHandler: () => {},
        focus: () => { this.webContents.calls.push(['focus']) },
      }
      RecordingWindow.instances.push(this)
    }
    record(name, ...args) { this.calls.push([name, ...args]) }
    on(event, fn) { (this.handlers[event] ||= []).push(fn) }
    setAlwaysOnTop(...args) { this.record('setAlwaysOnTop', ...args) }
    setVisibleOnAllWorkspaces(...args) { this.record('setVisibleOnAllWorkspaces', ...args) }
    setIgnoreMouseEvents(...args) { this.record('setIgnoreMouseEvents', ...args) }
    setFocusable(...args) { this.record('setFocusable', ...args) }
    setBounds(...args) { this.record('setBounds', ...args); this.bounds = args[0] }
    show() { this.record('show'); this.visible = true }
    showInactive() { this.record('showInactive'); this.visible = true }
    hide() { this.record('hide'); this.visible = false }
    focus() { this.record('focus') }
    destroy() { this.record('destroy') }
    isDestroyed() { return false }
    loadURL() { return Promise.resolve() }
    loadFile() { return Promise.resolve() }
    getPosition() { return [0, 0] }
    emitOnce(event, ...args) { for (const fn of this.onceHandlers[event] || []) fn({}, ...args) }
    emit(event, ...args) { for (const fn of this.handlers[event] || []) fn({}, ...args) }
  }
  return RecordingWindow
}

test('bubble executor applies the policy layer and shows without stealing focus', () => {
  const RecordingWindow = recordingWindowClass()
  const controller = createBubbleWindowController({
    BrowserWindow: RecordingWindow,
    preloadPath: '/p',
    pagePath: '/b.html',
    processType: 'uielement',
  })
  controller.reposition({ x: 100, y: 300, width: 380, height: ORB_BUBBLE_WINDOW_HEIGHT })
  controller.show({ text: 'hi' })
  const window = RecordingWindow.instances[0]
  window.emitOnce('did-finish-load')
  assert.equal(window.options.focusable, false)
  assert.deepEqual(window.calls.filter(call => call[0] === 'setAlwaysOnTop').at(-1), ['setAlwaysOnTop', true, 'screen-saver'])
  assert.deepEqual(window.calls.filter(call => call[0] === 'setVisibleOnAllWorkspaces').at(-1), [
    'setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: true },
  ])
  assert.equal(window.calls.some(call => call[0] === 'showInactive'), true)
  assert.equal(window.calls.some(call => call[0] === 'show'), false)
  assert.equal(window.calls.some(call => call[0] === 'focus'), false)
  assert.equal(window.webContents.calls.some(call => call[0] === 'focus'), false)
  assert.deepEqual(controller._state().bounds, { x: 100, y: 300, width: 380, height: 420 })

  // The same controller only takes keyboard focus for an explicit text input.
  controller.show({ text: 'name?', input: true })
  assert.equal(window.calls.some(call => call[0] === 'show'), true)
  assert.equal(window.calls.some(call => call[0] === 'focus'), true)
  assert.equal(window.webContents.calls.some(call => call[0] === 'focus'), true)
  controller.destroy()
})

test('prohibited process type lets Electron transform instead of forcing skipTransformProcessType', () => {
  const RecordingWindow = recordingWindowClass()
  const controller = createBubbleWindowController({
    BrowserWindow: RecordingWindow,
    preloadPath: '/p',
    pagePath: '/b.html',
    processType: 'prohibited',
  })
  controller.show({ text: 'hi' })
  const window = RecordingWindow.instances.at(-1)
  assert.deepEqual(window.calls.filter(call => call[0] === 'setVisibleOnAllWorkspaces').at(-1), [
    'setVisibleOnAllWorkspaces', true, { visibleOnFullScreen: true, skipTransformProcessType: false },
  ])
  controller.destroy()
})

test('bubble window load/renderer failures are kept as bounded diagnostics, not swallowed', () => {
  const RecordingWindow = recordingWindowClass()
  const controller = createBubbleWindowController({
    BrowserWindow: RecordingWindow,
    preloadPath: '/p',
    pagePath: '/b.html',
  })
  controller.reposition({ x: 10, y: 300, width: 380, height: ORB_BUBBLE_WINDOW_HEIGHT })
  controller.show({ text: 'hi' })
  const window = RecordingWindow.instances[0]
  window.emitOnce('did-finish-load')
  window.emit('did-fail-load', -3, 'ERR_ABORTED', 'file:///bubble.html')
  window.emit('preload-error', '/p', new Error('preload exploded'))
  window.emit('render-process-gone', { reason: 'crashed', exitCode: 133 })
  const kinds = controller.diagnostics().map(entry => entry.kind)
  assert.ok(kinds.includes('desktop.bubble_load_failed'))
  assert.ok(kinds.includes('desktop.bubble_preload_error'))
  assert.ok(kinds.includes('desktop.bubble_render_process_gone'))
  assert.ok(kinds.includes('desktop.window_layer_applied'))
  assert.ok(controller._state().diagnostics.recorded >= 3)
  controller.destroy()
})

test('repositioned fallback slot caps the grown bubble height instead of clipping the card', () => {
  const FakeWindow = fakeWindowClass()
  const controller = createBubbleWindowController({ BrowserWindow: FakeWindow, preloadPath: '/p', pagePath: '/b.html' })
  // A short work area yields a bounded-overlap slot (height 300) from the policy.
  controller.reposition({ x: 0, y: 25, width: 380, height: 300 })
  controller.show({ text: 'hi' })
  controller.resize(9_999)
  assert.equal(controller._state().bounds.height, 300)
  assert.equal(controller._state().bounds.y, 25)
  assert.equal(controller._state().bounds.y + controller._state().bounds.height, 325)
  controller.destroy()
})

test('orbBubbleWindowBounds accepts the presentation intent and logical anchor budget without breaking safety', () => {
  const orb = { x: 600, y: 600, width: 172, height: 204 }
  const area = { x: 0, y: 25, width: 1440, height: 800 }
  const withIntent = orbBubbleWindowBounds({
    orbBounds: orb,
    workArea: area,
    placement: 'side',
    anchorGapPx: 48,
  })
  assert.equal(withIntent.requestedPlacement, 'side')
  assert.equal(withIntent.gapBudgetPx, 48)
  // A presentation hint is advisory: the safety priority still prefers the
  // anchored head slot when it fits in the same available space.
  assert.equal(withIntent.placement, 'above')
  const defaultBudget = orbBubbleWindowBounds({ orbBounds: orb, workArea: area })
  assert.equal(defaultBudget.gapBudgetPx, 24)
  assert.equal(defaultBudget.requestedPlacement, null)
})

test('orbBubbleWindowBounds stays inside the anchor display and reports the kernel placement vocabulary', () => {
  const leftDisplay = { id: 'left', workArea: { x: -1280, y: 0, width: 1280, height: 900 }, scaleFactor: 2 }
  const primary = { id: 'primary', workArea: { x: 0, y: 25, width: 1440, height: 800 }, scaleFactor: 1 }
  const bounds = orbBubbleWindowBounds({
    orbBounds: { x: -900, y: 300, width: 172, height: 204 },
    workArea: leftDisplay.workArea,
    displays: [primary, leftDisplay],
  })
  assert.ok(['above', 'side', 'bounded-overlap'].includes(bounds.placement))
  assert.equal(bounds.display.id, 'left')
  assert.equal(bounds.deviceGapBudgetPx, 48)
  assert.ok(bounds.x >= -1280 && bounds.x + bounds.width <= 0)
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 900)
})
