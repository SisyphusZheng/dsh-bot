import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ANCHOR_GAP_PX,
  DIAGNOSTIC_LIMIT,
  PROCESS_TYPE,
  WINDOW_PLACEMENT,
  WINDOW_ROLE,
  createWindowDiagnostics,
  createWindowLayerController,
  displayForAnchor,
  edgeDistance,
  fitBubbleWindowBounds,
  normalizeProcessType,
  processTypeTransition,
  selectBubblePlacement,
  skipTransformProcessTypeFor,
  windowInteractionPlan,
  windowLayerPlan,
} from '../src/window-layer-policy.mjs'

class FakeWindow {
  constructor() {
    this.calls = []
    this.visible = false
  }
  setAlwaysOnTop(...args) { this.calls.push(['setAlwaysOnTop', ...args]) }
  setVisibleOnAllWorkspaces(...args) { this.calls.push(['setVisibleOnAllWorkspaces', ...args]) }
  setIgnoreMouseEvents(...args) { this.calls.push(['setIgnoreMouseEvents', ...args]) }
  setFocusable(...args) { this.calls.push(['setFocusable', ...args]) }
  setBounds(...args) { this.calls.push(['setBounds', ...args]) }
  show() { this.calls.push(['show']); this.visible = true }
  showInactive() { this.calls.push(['showInactive']); this.visible = true }
  hide() { this.calls.push(['hide']); this.visible = false }
  focus() { this.calls.push(['focus']) }
  isDestroyed() { return false }
  find(kind) { return this.calls.filter(call => call[0] === kind) }
}

const workArea = { x: 0, y: 25, width: 1440, height: 800 }
const orbAt = (x, y) => ({ x, y, width: 172, height: 204 })
const place = (options = {}) => selectBubblePlacement({
  orbBounds: orbAt(600, 600),
  workArea,
  width: 380,
  height: 420,
  minHeight: 118,
  ...options,
})

/* ------------------------------------------------------------------ */
/* Layer / Spaces / process type                                       */
/* ------------------------------------------------------------------ */

test('pet is a normal floating always-on-top window, bubble is above it, main stays a normal app window', () => {
  const pet = windowLayerPlan({ role: WINDOW_ROLE.pet, processType: 'foreground' })
  const bubble = windowLayerPlan({ role: WINDOW_ROLE.bubble, processType: 'foreground' })
  const main = windowLayerPlan({ role: WINDOW_ROLE.main, processType: 'foreground' })
  assert.equal(pet.alwaysOnTop, true)
  assert.equal(pet.level, 'floating')
  assert.equal(bubble.alwaysOnTop, true)
  assert.equal(bubble.level, 'screen-saver')
  assert.notEqual(bubble.level, pet.level, 'bubble must be layered above the pet')
  for (const plan of [pet, bubble]) {
    assert.equal(plan.spaces.visibleOnAllWorkspaces, true)
    assert.equal(plan.spaces.visibleOnFullScreen, true)
    assert.equal(plan.focus.focusable, false)
    assert.equal(plan.focus.showMode, 'inactive')
    assert.equal(plan.clickThrough.defaultIgnoreMouseEvents, true)
    assert.equal(plan.chrome.skipTaskbar, true)
  }
  assert.equal(main.alwaysOnTop, false)
  assert.equal(main.level, null)
  assert.equal(main.spaces.visibleOnAllWorkspaces, false)
  assert.equal(main.focus.focusable, true)
  assert.equal(main.focus.showMode, 'active')
  // The fullscreen/level combination is recorded as intent for native
  // verification, never claimed as proven by this unit test.
  assert.ok(bubble.nativeVerification.includes('level:screen-saver'))
  assert.ok(bubble.nativeVerification.includes('visibleOnFullScreen'))
})

test('skipTransformProcessType is derived from the actual process type, not hard-coded true', () => {
  assert.equal(skipTransformProcessTypeFor('foreground'), true)
  assert.equal(skipTransformProcessTypeFor('regular'), true)
  assert.equal(skipTransformProcessTypeFor('uielement'), true)
  assert.equal(skipTransformProcessTypeFor('accessory'), true)
  assert.equal(skipTransformProcessTypeFor('prohibited'), false)
  assert.equal(skipTransformProcessTypeFor('unknown'), false)
  assert.equal(skipTransformProcessTypeFor(undefined), false)
  assert.equal(normalizeProcessType('Accessory'), PROCESS_TYPE.uielement)
  assert.equal(normalizeProcessType('NSApplicationActivationPolicyProhibited'), PROCESS_TYPE.prohibited)
  assert.equal(normalizeProcessType('other'), PROCESS_TYPE.unknown)
  const foreground = windowLayerPlan({ role: 'bubble', processType: 'foreground' })
  const prohibited = windowLayerPlan({ role: 'bubble', processType: 'prohibited' })
  assert.equal(foreground.spaces.skipTransformProcessType, true)
  assert.equal(prohibited.spaces.skipTransformProcessType, false)
})

test('process-type transitions only happen at startup or an explicit settings change', () => {
  const startup = processTypeTransition({ current: 'uielement', desiredDockVisible: true, reason: 'startup' })
  assert.equal(startup.apply, true)
  assert.equal(startup.target, PROCESS_TYPE.foreground)
  assert.equal(startup.skipTransformProcessType, true)
  const change = processTypeTransition({ current: 'foreground', desiredDockVisible: false, reason: 'user-setting-change' })
  assert.equal(change.apply, true)
  assert.equal(change.target, PROCESS_TYPE.uielement)
  for (const reason of ['window-show', 'window-hide', 'capture', 'periodic-poll']) {
    const plan = processTypeTransition({ current: 'foreground', desiredDockVisible: false, reason })
    assert.equal(plan.apply, false, `${reason} must never switch the process type`)
    assert.equal(plan.suppressedReason, 'not-a-settings-boundary')
  }
  const already = processTypeTransition({ current: 'foreground', desiredDockVisible: true, reason: 'startup' })
  assert.equal(already.apply, false)
  assert.equal(already.suppressedReason, 'already-applied')
  assert.equal(processTypeTransition({ platform: 'win32', current: 'foreground' }).supported, false)
  const restart = processTypeTransition({ current: 'prohibited', desiredDockVisible: true, reason: 'startup' })
  assert.equal(restart.requiresRestart, true)
  assert.equal(processTypeTransition({ current: 'unknown', reason: 'startup' }).apply, true)
  assert.equal(processTypeTransition({ current: 'unknown', reason: 'user-setting-change' }).apply, false)
})

test('the executor applies the layer plan once and derives Spaces options from the process type', () => {
  const window = new FakeWindow()
  const controller = createWindowLayerController({ platform: 'darwin', processType: 'uielement' })
  const plan = controller.applyLayer(window, { role: 'bubble' })
  assert.deepEqual(window.find('setAlwaysOnTop'), [['setAlwaysOnTop', true, 'screen-saver']])
  assert.deepEqual(window.find('setVisibleOnAllWorkspaces'), [['setVisibleOnAllWorkspaces', true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  }]])
  assert.equal(plan.spaces.skipTransformProcessType, true)

  const prohibitedWindow = new FakeWindow()
  createWindowLayerController({ platform: 'darwin', processType: 'prohibited' })
    .applyLayer(prohibitedWindow, { role: 'bubble' })
  assert.equal(prohibitedWindow.find('setVisibleOnAllWorkspaces')[0][2].skipTransformProcessType, false)
})

test('process-type switching is rate limited, bounded and refused outside settings boundaries', () => {
  let nowMs = 1_000
  const applied = []
  const application = { setActivationPolicy: policy => applied.push(policy) }
  const controller = createWindowLayerController({
    platform: 'darwin',
    processType: PROCESS_TYPE.foreground,
    now: () => nowMs,
  })
  const first = controller.applyProcessType({ desiredDockVisible: false, reason: 'user-setting-change', application })
  assert.equal(first.apply, true)
  assert.deepEqual(applied, ['uielement'])
  assert.equal(controller.processType(), 'uielement')

  // Same preference again: no switch.
  controller.applyProcessType({ desiredDockVisible: false, reason: 'user-setting-change', application })
  assert.deepEqual(applied, ['uielement'])
  // Visibility/capture paths never switch.
  controller.applyProcessType({ desiredDockVisible: true, reason: 'window-show', application })
  assert.deepEqual(applied, ['uielement'])
  // A second settings change within the quiet period is suppressed.
  nowMs += 2_000
  const rateLimited = controller.applyProcessType({ desiredDockVisible: true, reason: 'user-setting-change', application })
  assert.equal(rateLimited.apply, false)
  assert.equal(rateLimited.suppressedReason, 'rate-limited')
  assert.deepEqual(applied, ['uielement'])
  // After the quiet period a second (and final) transition is allowed.
  nowMs += 60_000
  controller.applyProcessType({ desiredDockVisible: true, reason: 'user-setting-change', application })
  assert.deepEqual(applied, ['uielement', 'foreground'])
  // Further churn is refused; a process type is not a per-show toggle.
  nowMs += 60_000
  const stable = controller.applyProcessType({ desiredDockVisible: false, reason: 'user-setting-change', application })
  assert.equal(stable.apply, false)
  assert.equal(stable.suppressedReason, 'transition-limit')
  assert.deepEqual(applied, ['uielement', 'foreground'])
  const kinds = controller.diagnostics.snapshot().map(entry => entry.kind)
  assert.ok(kinds.includes('desktop.process_type_stable'))
  assert.ok(kinds.includes('desktop.process_type_rate_limited'))
})

/* ------------------------------------------------------------------ */
/* Focus / click-through / no focus stealing                           */
/* ------------------------------------------------------------------ */

test('appearance and hover never take keyboard focus; only explicit text input does', () => {
  const appearance = windowInteractionPlan({ role: WINDOW_ROLE.bubble })
  assert.equal(appearance.focusable, false)
  assert.equal(appearance.showMode, 'inactive')
  assert.equal(appearance.ignoreMouseEvents, true)
  assert.equal(appearance.forwardMouseEvents, true)

  const hover = windowInteractionPlan({ role: WINDOW_ROLE.bubble, interactive: true })
  assert.equal(hover.focusable, false, 'receiving events must not steal another app keyboard focus')
  assert.equal(hover.showMode, 'inactive')
  assert.equal(hover.ignoreMouseEvents, false, 'the card can receive the click')
  assert.equal(hover.activation, 'inactive')

  const input = windowInteractionPlan({ role: WINDOW_ROLE.bubble, inputMode: true })
  assert.equal(input.focusable, true)
  assert.equal(input.showMode, 'active')
  assert.equal(input.focusWebContents, true)

  const main = windowInteractionPlan({ role: WINDOW_ROLE.main })
  assert.equal(main.focusable, true)
  assert.equal(main.showMode, 'active')
  assert.equal(main.ignoreMouseEvents, false)
})

test('the executor shows bubble/pet windows inactively and never focuses on hover', () => {
  const window = new FakeWindow()
  const controller = createWindowLayerController({ platform: 'darwin', processType: 'foreground' })
  controller.show(window, { role: 'bubble' })
  assert.deepEqual(window.find('showInactive'), [['showInactive']])
  assert.deepEqual(window.find('show'), [])
  assert.deepEqual(window.find('focus'), [])
  assert.deepEqual(window.find('setFocusable'), [['setFocusable', false]])

  controller.applyInteraction(window, { role: 'bubble', interactive: true })
  assert.deepEqual(window.find('focus'), [])
  assert.equal(window.find('setFocusable').length, 1, 'focusable is unchanged by hover')

  const focused = []
  controller.show(window, { role: 'bubble', inputMode: true, focus: () => focused.push('text-input') })
  assert.deepEqual(focused, ['text-input'])
  assert.deepEqual(window.find('show'), [['show']])
})

/* ------------------------------------------------------------------ */
/* Bounded diagnostics                                                 */
/* ------------------------------------------------------------------ */

test('window diagnostics stay bounded, coalesce repeats and sanitize detail', () => {
  let nowMs = 0
  const diagnostics = createWindowDiagnostics({ limit: 4, now: () => ++nowMs })
  for (let index = 0; index < 50; index++) diagnostics.record('desktop.test_repeat', { index })
  const repeats = diagnostics.snapshot()
  assert.equal(repeats.length, 1, 'repeated kinds coalesce into one bounded entry')
  assert.equal(repeats[0].count, 50)
  for (const kind of ['a', 'b', 'c', 'd', 'e', 'f']) diagnostics.record(kind)
  const snapshot = diagnostics.snapshot()
  assert.equal(snapshot.length, 4)
  assert.deepEqual(snapshot.map(entry => entry.kind), ['c', 'd', 'e', 'f'])
  const state = diagnostics.state()
  assert.equal(state.capacity, 4)
  assert.ok(state.dropped >= 2)
  diagnostics.record('desktop.long_detail', {
    message: 'x'.repeat(5_000),
    error: new Error('renderer exploded'),
    nested: { code: 'ERR', message: 'y'.repeat(5_000), ignored: { deep: true } },
  })
  const detail = diagnostics.snapshot().at(-1).detail
  assert.ok(detail.message.length <= 300)
  assert.equal(detail.error, 'renderer exploded')
  assert.ok(detail.nested.message.length <= 200)
  assert.equal(detail.nested.ignored, undefined)
  assert.ok(DIAGNOSTIC_LIMIT >= 4)
})

test('bounds are only applied when geometry actually changes, and bad bounds are recorded', () => {
  const window = new FakeWindow()
  const controller = createWindowLayerController({ platform: 'darwin', processType: 'foreground' })
  assert.equal(controller.applyBounds(window, { x: 10, y: 20, width: 380, height: 420 }), true)
  assert.equal(window.find('setBounds').length, 1)
  assert.equal(controller.applyBounds(window, { x: 10, y: 20, width: 380, height: 420 }), false)
  assert.equal(window.find('setBounds').length, 1)
  assert.equal(controller.applyBounds(window, { x: 10, y: 30, width: 380, height: 420 }), true)
  assert.equal(window.find('setBounds').length, 2)
  assert.equal(controller.applyBounds(window, { x: 0, y: 0, width: 0, height: 0 }), false)
  assert.ok(controller.diagnostics.snapshot().some(entry => entry.kind === 'desktop.window_bounds_rejected'))
})

/* ------------------------------------------------------------------ */
/* Geometry priority                                                   */
/* ------------------------------------------------------------------ */

test('head placement wins when it fits and keeps the tail anchor bottom', () => {
  const orb = orbAt(600, 600)
  const result = place({ orbBounds: orb })
  assert.equal(result.placement, WINDOW_PLACEMENT.above)
  assert.equal(result.slot, 'above')
  assert.deepEqual(result.bounds, { x: 496, y: 222, width: 380, height: 420 })
  assert.equal(result.bounds.y + result.bounds.height, orb.y + 42, 'tail anchor stays on the head')
  assert.equal(result.anchorGapPx, 0)
  assert.equal(result.withinAnchorBudget, true)
  assert.equal(result.fullyOnscreen, true)
  assert.equal(result.controlsOperable, true)
  assert.equal(result.scrollFallback, false)
  assert.equal(result.actionsClipped, false)
})

test('the 24 logical px anchor budget is used for side placements without drifting away', () => {
  const result = place({ orbBounds: orbAt(600, 60) })
  assert.equal(result.placement, WINDOW_PLACEMENT.side)
  assert.equal(result.slot, 'left')
  assert.equal(result.anchorGapPx, ANCHOR_GAP_PX)
  assert.equal(result.withinAnchorBudget, true)
  assert.ok(result.bounds.x >= workArea.x)
  assert.ok(result.bounds.x + result.bounds.width <= workArea.x + workArea.width)
  assert.ok(result.bounds.y >= workArea.y)
  assert.ok(result.bounds.y + result.bounds.height <= workArea.y + workArea.height)
  assert.equal(result.avoidOverlapPx2, 0)
})

test('after the head slot, the least-overlapping nearby side slot wins', () => {
  const withLeftWindow = place({
    orbBounds: orbAt(600, 60),
    avoidBounds: [{ x: 0, y: 25, width: 700, height: 800 }],
  })
  assert.equal(withLeftWindow.slot, 'right')
  assert.equal(withLeftWindow.anchorGapPx, ANCHOR_GAP_PX)
  assert.equal(withLeftWindow.avoidOverlapPx2, 0)
})

test('anchoring beats zero overlap: the head slot stays even when another window is behind it', () => {
  const result = place({
    orbBounds: orbAt(600, 600),
    avoidBounds: [{ x: 650, y: 200, width: 100, height: 500 }],
  })
  assert.equal(result.placement, WINDOW_PLACEMENT.above)
  assert.equal(result.anchorGapPx, 0)
  assert.ok(result.avoidOverlapPx2 > 0, 'fixture window must overlap the head slot')
})

test('a full-screen window behind the pet does not move the bubble to a far edge', () => {
  const result = place({
    orbBounds: orbAt(600, 600),
    avoidBounds: [{ ...workArea }],
  })
  assert.equal(result.anchorGapPx, 0)
  assert.ok(result.bounds.x >= workArea.x && result.bounds.x + result.bounds.width <= workArea.x + workArea.width)
  const centreDistance = Math.hypot(
    (result.bounds.x + result.bounds.width / 2) - (600 + 86),
    (result.bounds.y + result.bounds.height / 2) - (600 + 102),
  )
  assert.ok(centreDistance < 500, `bubble drifted ${centreDistance}px away from the pet`)
})

test('a top/bottom-edge pet keeps a nearby operable side slot instead of covering the pet', () => {
  // The pet is pushed below the work area (bottom edge / Dock case): the head
  // slot cannot fit and the clamped side slot must remain fully operable.
  const result = place({ orbBounds: orbAt(20, 850) })
  assert.equal(result.controlsOperable, true)
  assert.equal(result.fullyOnscreen, true)
  assert.ok(result.bounds.x >= workArea.x)
  assert.ok(result.bounds.y + result.bounds.height <= workArea.y + workArea.height)
  assert.ok(result.anchorGapPx <= ANCHOR_GAP_PX + 1)
  assert.equal(result.actionsClipped, false)
})

test('the 24px budget is a Phase-0 target: an edge-forced 25px gap is reported, not hidden', () => {
  const result = place({ orbBounds: orbAt(20, 850) })
  assert.equal(result.anchorGapPx, ANCHOR_GAP_PX + 1)
  assert.equal(result.withinAnchorBudget, false)
  assert.ok(result.diagnostics.some(entry => entry.kind === 'desktop.bubble_anchor_budget_exceeded'))
})

test('a short work area shrinks the scrollable content before allowing bounded overlap', () => {
  const result = place({
    orbBounds: orbAt(100, 100),
    workArea: { x: 0, y: 25, width: 500, height: 300 },
  })
  assert.equal(result.placement, WINDOW_PLACEMENT.boundedOverlap)
  assert.equal(result.scrollFallback, true)
  assert.ok(result.bounds.height >= 118)
  assert.ok(result.bounds.height <= 300)
  assert.equal(result.actionsClipped, false)
  assert.equal(result.controlsOperable, true)
  assert.equal(result.contentHeightLimitPx, result.bounds.height)
  assert.ok(result.bounds.y >= 25)
  assert.ok(result.bounds.y + result.bounds.height <= 25 + 300)
  assert.ok(result.diagnostics.some(entry => entry.kind === 'desktop.bubble_placement_fallback'))
})

test('a display smaller than the minimum card reports clipped actions instead of pretending PASS', () => {
  const result = place({
    orbBounds: orbAt(20, 150),
    workArea: { x: 0, y: 0, width: 300, height: 100 },
  })
  assert.equal(result.actionsClipped, true)
  assert.equal(result.placement, WINDOW_PLACEMENT.boundedOverlap)
  assert.ok(result.diagnostics.some(entry => entry.kind === 'desktop.bubble_display_too_small'))
})

test('a clamped slot that would cover the pet loses to a clean operable side slot', () => {
  // 800px-wide work area: the right slot has no room and its horizontal clamp
  // would sit on top of the pet; the left slot is clean, so it must win.
  const result = place({
    orbBounds: orbAt(600, 100),
    workArea: { x: 0, y: 25, width: 800, height: 800 },
  })
  assert.equal(result.slot, 'left')
  assert.equal(result.coversAnchor, false)
  assert.equal(result.fullyOnscreen, true)
  assert.equal(result.controlsOperable, true)
  // ...while a display too narrow for any clean slot falls back (bounded
  // overlap) instead of claiming a clean placement.
  const narrow = place({
    orbBounds: orbAt(600, 100),
    workArea: { x: 0, y: 25, width: 700, height: 800 },
  })
  assert.equal(narrow.fullyOnscreen, true)
  assert.equal(narrow.controlsOperable, true)
})

test('Dock offset / edge placement stays inside the work area and keeps the anchor', () => {
  // A left Dock already excluded from workArea: the head slot would start at
  // x=-24, so it is clamped to the Dock edge but stays anchored and onscreen.
  const result = place({
    orbBounds: orbAt(80, 300),
    workArea: { x: 72, y: 25, width: 1368, height: 800 },
  })
  assert.equal(result.placement, WINDOW_PLACEMENT.above)
  assert.ok(result.bounds.x >= 72)
  assert.equal(result.fullyOnscreen, true)
  assert.equal(result.anchorGapPx, 0)
  assert.equal(result.actionsClipped, false)
})

/* ------------------------------------------------------------------ */
/* Multi-display, negative coordinates, scale factors                  */
/* ------------------------------------------------------------------ */

const primaryDisplay = { id: 'primary', workArea: { x: 0, y: 25, width: 1440, height: 800 }, scaleFactor: 1 }
const leftDisplay = { id: 'left', workArea: { x: -1280, y: 0, width: 1280, height: 900 }, scaleFactor: 2 }

test('multi-display placement stays on the display that hosts the pet (negative coordinates)', () => {
  const result = place({
    orbBounds: { x: -900, y: 300, width: 172, height: 204 },
    displays: [primaryDisplay, leftDisplay],
    workArea: leftDisplay.workArea,
  })
  assert.equal(result.display.id, 'left')
  assert.equal(result.display.scaleFactor, 2)
  assert.equal(result.deviceGapBudgetPx, ANCHOR_GAP_PX * 2, 'device budget doubles on a 2x display')
  assert.ok(result.bounds.x >= -1280)
  assert.ok(result.bounds.x + result.bounds.width <= 0, 'the bubble must not spill onto the primary display')
  assert.ok(result.bounds.y >= 0)
  assert.ok(result.bounds.y + result.bounds.height <= 900)
  assert.equal(result.actionsClipped, false)
})

test('the anchor display is selected by containment, overlap and then distance', () => {
  const anchor = { x: -900, y: 300, width: 172, height: 204 }
  assert.equal(displayForAnchor(anchor, [primaryDisplay, leftDisplay]).id, 'left')
  assert.equal(displayForAnchor({ x: 100, y: 100, width: 172, height: 204 }, [primaryDisplay, leftDisplay]).id, 'primary')
  // Spanning the display seam: the display with the larger overlap wins.
  const spanning = { x: -150, y: 300, width: 300, height: 204 }
  assert.equal(displayForAnchor(spanning, [primaryDisplay, leftDisplay]).id, 'primary')
})

test('scale factor changes device pixels only, never the logical geometry', () => {
  const options = {
    orbBounds: orbAt(600, 300),
    width: 380,
    height: 420,
    minHeight: 118,
  }
  const first = selectBubblePlacement({ ...options, displays: [{ ...primaryDisplay, scaleFactor: 1 }] })
  const second = selectBubblePlacement({ ...options, displays: [{ ...primaryDisplay, scaleFactor: 2 }] })
  assert.deepEqual(first.bounds, second.bounds)
  assert.equal(first.deviceGapBudgetPx, 24)
  assert.equal(second.deviceGapBudgetPx, 48)
})

/* ------------------------------------------------------------------ */
/* Fallback invariants, vocabulary, input safety                       */
/* ------------------------------------------------------------------ */

test('placement vocabulary stays aligned with the kernel snapshot contract', () => {
  const allowed = new Set(Object.values(WINDOW_PLACEMENT))
  const scenarios = [
    place({ orbBounds: orbAt(600, 600) }),
    place({ orbBounds: orbAt(600, 60) }),
    place({ orbBounds: orbAt(20, 850) }),
    place({ orbBounds: orbAt(100, 100), workArea: { x: 0, y: 25, width: 500, height: 300 } }),
  ]
  for (const result of scenarios) assert.ok(allowed.has(result.placement), result.placement)
  assert.deepEqual(Object.values(WINDOW_PLACEMENT).sort(), ['above', 'bounded-overlap', 'side'])
})

test('placement never mutates its inputs', () => {
  const orb = orbAt(600, 600)
  const area = { ...workArea }
  const avoid = [{ x: 650, y: 200, width: 100, height: 500 }]
  const orbBefore = JSON.stringify(orb)
  const areaBefore = JSON.stringify(area)
  const avoidBefore = JSON.stringify(avoid)
  place({ orbBounds: orb, avoidBounds: avoid })
  assert.equal(JSON.stringify(orb), orbBefore)
  assert.equal(JSON.stringify(area), areaBefore)
  assert.equal(JSON.stringify(avoid), avoidBefore)
  assert.throws(() => selectBubblePlacement({ workArea: area }), /orbBounds/)
  assert.throws(() => selectBubblePlacement({ orbBounds: { x: 0, y: 0, width: 0, height: 10 }, workArea: area }), /orbBounds/)
})

test('the pet stays nearby and onscreen across edge/corner/negative-coordinate grids', () => {
  const areas = [
    workArea,
    { x: -1280, y: 0, width: 1280, height: 900 },
    { x: 72, y: 25, width: 1368, height: 800 },
  ]
  const avoid = [
    [],
    [{ x: 0, y: 0, width: 700, height: 800 }],
    [{ ...workArea }],
  ]
  for (const area of areas) {
    for (const avoidBounds of avoid) {
      for (const orb of [
        { x: area.x, y: area.y, width: 172, height: 204 },
        { x: area.x + area.width - 172, y: area.y, width: 172, height: 204 },
        { x: area.x, y: area.y + area.height - 204, width: 172, height: 204 },
        { x: area.x + Math.round(area.width / 2), y: area.y + Math.round(area.height / 2), width: 172, height: 204 },
        { x: area.x - 60, y: area.y - 40, width: 172, height: 204 },
      ]) {
        const result = selectBubblePlacement({ orbBounds: orb, workArea: area, avoidBounds, width: 380, height: 420, minHeight: 118 })
        assert.ok(result.bounds.x >= area.x, `x ${result.bounds.x} < ${area.x}`)
        assert.ok(result.bounds.x + result.bounds.width <= area.x + area.width)
        assert.ok(result.bounds.y >= area.y)
        assert.ok(result.bounds.y + result.bounds.height <= area.y + area.height)
        assert.ok(result.anchorGapPx <= 60, `anchor gap ${result.anchorGapPx} too far for ${JSON.stringify(orb)}`)
        assert.equal(result.actionsClipped, false)
      }
    }
  }
})

test('fitBubbleWindowBounds grows/shrinks upwards and clamps to min/max', () => {
  const base = { x: 10, y: 100, width: 380, height: 420 }
  assert.deepEqual(fitBubbleWindowBounds({ baseBounds: base }), { x: 10, y: 100, width: 380, height: 420 })
  const fitted = fitBubbleWindowBounds({ baseBounds: base, contentHeight: 200, minHeight: 118 })
  assert.deepEqual(fitted, { x: 10, y: 320, width: 380, height: 200 })
  assert.equal(fitted.y + fitted.height, base.y + base.height, 'bottom anchor never moves')
  assert.deepEqual(fitBubbleWindowBounds({ baseBounds: base, contentHeight: 10, minHeight: 118 }), { x: 10, y: 402, width: 380, height: 118 })
  assert.deepEqual(fitBubbleWindowBounds({ baseBounds: base, contentHeight: 9_999, minHeight: 118 }), base)
  // A shrunken fallback slot can be shorter than the normal minimum.
  assert.deepEqual(
    fitBubbleWindowBounds({ baseBounds: { x: 0, y: 0, width: 380, height: 80 }, minHeight: 118 }),
    { x: 0, y: 0, width: 380, height: 80 },
  )
  assert.throws(() => fitBubbleWindowBounds({ baseBounds: null }), /baseBounds/)
})

test('edgeDistance measures nearest edges and is zero for touching/overlapping rectangles', () => {
  assert.equal(edgeDistance({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 0, width: 10, height: 10 }), 10)
  assert.equal(edgeDistance({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), 0)
  assert.equal(edgeDistance({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 5, height: 5 }), 0)
  assert.equal(Math.round(edgeDistance({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 }) * 100) / 100, Math.round(Math.hypot(10, 10) * 100) / 100)
})

test('the pure policy module has no Electron import', () => {
  const source = readFileSync(new URL('../src/window-layer-policy.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from\s+['"]electron['"]/u)
  assert.doesNotMatch(source, /require\(['"]electron['"]\)/u)
})
