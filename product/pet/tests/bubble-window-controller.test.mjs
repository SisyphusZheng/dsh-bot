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

test('main window avoidance chooses free space without moving the pet and stays inside a scaled display',()=>{
 const orb={x:1400,y:800,width:172,height:204},area={x:0,y:0,width:1920,height:1080},main={x:1100,y:100,width:820,height:650}
 const before={...orb},bounds=orbBubbleWindowBounds({orbBounds:orb,workArea:area,avoidBounds:[main]})
 const overlap=(a,b)=>Math.max(0,Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x))*Math.max(0,Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y))
 assert.equal(overlap(bounds,main),0);assert.deepEqual(orb,before)
 for(const avoid of [[{...area}],[]]){const b=orbBubbleWindowBounds({orbBounds:{x:-900,y:60,width:172,height:204},workArea:{x:-1280,y:0,width:1280,height:900},avoidBounds:avoid});assert.ok(b.x>=-1280&&b.y>=0&&b.x+b.width<=0&&b.y+b.height<=900)}
})
