// Unified desktop window-layer policy for the dsh-bot pet (plan v2.1 §9.1,
// kernel contract §3.7). It owns the *decisions* for pet/bubble/main windows:
//
//   - level and always-on-top intent,
//   - Spaces / full-screen visibility intent and the process-type dependent
//     `skipTransformProcessType` flag,
//   - focus, activation and click-through rules,
//   - bubble geometry with the fixed priority
//     "onscreen and key controls operable > near the pet anchor > minimize
//      overlap > aesthetics",
//   - the bounded-overlap / shrink-and-scroll fallbacks around the 24 logical
//     px Phase-0 anchor budget,
//   - bounded diagnostics for load/renderer/window events.
//
// This module is pure ESM: no `electron` import, no filesystem, no timers and
// no mutation of its arguments. `bubble-window.mjs` (or the desktop main
// process) is the executor: it turns these plans into BrowserWindow calls with
// an injected/faked BrowserWindow in tests. The pure part must stay importable
// from plain Node so the priority/fallback rules are unit-testable without
// Electron.
//
// What this module deliberately does NOT claim:
//   - `screen-saver` + `visibleOnFullScreen` + `skipTransformProcessType` is the
//     combination beta1 already used; repeating the value is not proof it
//     renders above every system surface. It is an intent recorded here and
//     verified natively (B2-G13), never a PASS by construction.
//   - 24 logical px is the Phase-0 anchor budget, not a universal guarantee.
//     Edges, multi-display, scale factors and full-screen coverage may force
//     bounded overlap or a shorter scrollable content area; sending the bubble
//     far away or clipping approval buttons is never an acceptable fallback.

/** Roles that participate in the desktop window policy. */
export const WINDOW_ROLE = Object.freeze({
  pet: 'pet',
  bubble: 'bubble',
  main: 'main',
})

/**
 * Kernel Snapshot vocabulary for `presentation.bubblePolicy.placement`
 * (beta2-kernel.md §2.1). Extra detail lives in `slot`.
 */
export const WINDOW_PLACEMENT = Object.freeze({
  above: 'above',
  side: 'side',
  boundedOverlap: 'bounded-overlap',
})

/** Concrete anchor slots considered by the geometry policy. */
export const ANCHOR_SLOT = Object.freeze({
  above: 'above',
  topGap: 'top-gap',
  left: 'left',
  right: 'right',
  below: 'below',
})

/**
 * Phase-0 budget for the nearest-edge distance between the bubble card and the
 * pet. `presentation.bubblePolicy.anchorGapPx` in the kernel snapshot uses the
 * same constant. Values are logical pixels (Electron DIP): a Retina display
 * only multiplies the *device* pixel budget, never the layout coordinates.
 */
export const ANCHOR_GAP_PX = 24

/** Bounded diagnostics keep the last N window events and coalesce repeats. */
export const DIAGNOSTIC_LIMIT = 64

/** A process-type switch is only considered again after this quiet period. */
export const PROCESS_TYPE_MIN_INTERVAL_MS = 10_000

/** Process-type aliases accepted from the Electron/main-process integration. */
export const PROCESS_TYPE = Object.freeze({
  foreground: 'foreground',
  uielement: 'uielement',
  prohibited: 'prohibited',
  unknown: 'unknown',
})

const PROCESS_TYPE_ALIASES = Object.freeze({
  foreground: PROCESS_TYPE.foreground,
  regular: PROCESS_TYPE.foreground,
  nsapplicationactivationpolicyregular: PROCESS_TYPE.foreground,
  uielement: PROCESS_TYPE.uielement,
  accessory: PROCESS_TYPE.uielement,
  nsapplicationactivationpolicyaccessory: PROCESS_TYPE.uielement,
  prohibited: PROCESS_TYPE.prohibited,
  background: PROCESS_TYPE.prohibited,
  nsapplicationactivationpolicyprohibited: PROCESS_TYPE.prohibited,
})

const clamp = (value, minimum, maximum) => Math.min(Math.max(minimum, value), maximum)

const round = value => Math.round(Number(value) || 0)

/** Normalize any reported activation policy value into the policy vocabulary. */
export function normalizeProcessType(value) {
  if (typeof value === 'boolean') return value ? PROCESS_TYPE.foreground : PROCESS_TYPE.uielement
  if (typeof value !== 'string') return PROCESS_TYPE.unknown
  const key = value.trim().toLowerCase().replace(/[\s_-]+/gu, '')
  return PROCESS_TYPE_ALIASES[key] ?? PROCESS_TYPE.unknown
}

/**
 * Decide the Electron `skipTransformProcessType` option from the *actual*
 * process type instead of hard-coding it.
 *
 * Electron's `setVisibleOnAllWorkspaces` transforms a Prohibited process into
 * an Accessory process by default so a background-only window can join every
 * Space. A foreground/accessory process does not need that transformation, so
 * skipping it keeps the Dock/activation behaviour stable. For an unknown
 * process type we let Electron decide (false) instead of forcing a value.
 * @param {unknown} processType Reported activation policy.
 * @returns {boolean}
 */
export function skipTransformProcessTypeFor(processType) {
  const type = normalizeProcessType(processType)
  return type === PROCESS_TYPE.foreground || type === PROCESS_TYPE.uielement
}

/**
 * Layer / Spaces / focus / click-through plan for one window role.
 * @param {object} options
 * @param {'pet'|'bubble'|'main'} options.role
 * @param {string} [options.platform] `process.platform` value.
 * @param {unknown} [options.processType] Actual activation policy, when known.
 * @returns {Readonly<object>}
 */
export function windowLayerPlan({ role = WINDOW_ROLE.bubble, platform = 'darwin', processType = PROCESS_TYPE.unknown } = {}) {
  if (!Object.prototype.hasOwnProperty.call(WINDOW_ROLE, role)) {
    throw new TypeError(`windowLayerPlan: unknown role ${String(role)}`)
  }
  const type = normalizeProcessType(processType)
  const isMain = role === WINDOW_ROLE.main
  const base = {
    role,
    platform,
    processType: type,
    alwaysOnTop: !isMain,
    level: role === WINDOW_ROLE.bubble ? 'screen-saver' : role === WINDOW_ROLE.pet ? 'floating' : null,
    spaces: {
      visibleOnAllWorkspaces: !isMain,
      visibleOnFullScreen: !isMain,
      skipTransformProcessType: isMain ? false : skipTransformProcessTypeFor(type),
    },
    focus: {
      focusable: isMain,
      activateOnShow: isMain,
      showMode: isMain ? 'active' : 'inactive',
    },
    clickThrough: {
      defaultIgnoreMouseEvents: !isMain,
      forwardMouseEvents: !isMain,
    },
    chrome: {
      skipTaskbar: !isMain,
      hasShadow: isMain,
    },
    // Explicit intent list: the executor records this in diagnostics and the
    // native B2-G13 probe must confirm it on real hardware.
    nativeVerification: isMain
      ? Object.freeze([])
      : Object.freeze(
        role === WINDOW_ROLE.bubble
          ? ['level:screen-saver', 'visibleOnFullScreen', 'spaces:all', 'processType-derived-skipTransform']
          : ['level:floating', 'visibleOnFullScreen', 'spaces:all', 'processType-derived-skipTransform'],
      ),
  }
  return Object.freeze(base)
}

/**
 * Pure decision for the macOS process-type / Dock setting. The desktop app maps
 * its "show Dock icon" preference to a target activation policy; this function
 * decides whether a transition is allowed at all. Visibility changes (show /
 * hide / capture) must never reach here with an allowed reason, which is how
 * "no frequent process-type switching" is enforced structurally.
 * @param {object} [options]
 * @param {string} [options.platform]
 * @param {unknown} [options.current]
 * @param {boolean} [options.desiredDockVisible]
 * @param {'startup'|'user-setting-change'|'window-show'|'window-hide'|'capture'|string} [options.reason]
 * @returns {object}
 */
export function processTypeTransition({
  platform = 'darwin',
  current = PROCESS_TYPE.unknown,
  desiredDockVisible = true,
  reason = 'startup',
} = {}) {
  const supported = platform === 'darwin'
  const from = normalizeProcessType(current)
  const target = desiredDockVisible === false ? PROCESS_TYPE.uielement : PROCESS_TYPE.foreground
  const reasonAllowed = reason === 'startup' || reason === 'user-setting-change'
  const unknownAtStartup = from === PROCESS_TYPE.unknown && reason === 'startup'
  const already = from === target
  const apply = supported && reasonAllowed && !already && (from !== PROCESS_TYPE.unknown || unknownAtStartup)
  let suppressedReason = null
  if (!supported) suppressedReason = 'unsupported-platform'
  else if (!reasonAllowed) suppressedReason = 'not-a-settings-boundary'
  else if (already) suppressedReason = 'already-applied'
  else if (from === PROCESS_TYPE.unknown) suppressedReason = 'unknown-current-type'
  return {
    supported,
    current: from,
    target,
    apply,
    // A Prohibited (background-only) app that must become a Dock app generally
    // needs its activation policy set before windows are created; report a
    // restart requirement instead of silently mutating a running app.
    requiresRestart: supported && from === PROCESS_TYPE.prohibited && target === PROCESS_TYPE.foreground,
    skipTransformProcessType: skipTransformProcessTypeFor(target),
    reasonAllowed,
    suppressedReason,
    reason,
  }
}

/**
 * Focus / click-through plan for one interaction state.
 *
 * Rules from the plan: non-text interaction never activates the window; only an
 * explicit text-input click may take keyboard focus; receiving events (hover,
 * approval clicks) must not steal another app's keyboard focus.
 * @param {object} [options]
 * @param {'pet'|'bubble'|'main'} [options.role]
 * @param {boolean} [options.interactive] The renderer reports the pointer is over an interactive card.
 * @param {boolean} [options.inputMode] The user explicitly asked for text input.
 * @param {string} [options.reason]
 * @returns {object}
 */
export function windowInteractionPlan({
  role = WINDOW_ROLE.bubble,
  interactive = false,
  inputMode = false,
  reason = 'appearance',
} = {}) {
  if (role === WINDOW_ROLE.main) {
    return Object.freeze({
      role,
      focusable: true,
      showMode: 'active',
      focusWebContents: false,
      ignoreMouseEvents: false,
      forwardMouseEvents: false,
      activation: 'active',
      reason: 'main-window',
    })
  }
  const wantsTextInput = inputMode === true
  const cardInteractive = wantsTextInput || interactive === true
  return Object.freeze({
    role,
    // Only an explicit text-input intent may take keyboard focus.
    focusable: wantsTextInput,
    showMode: wantsTextInput ? 'active' : 'inactive',
    focusWebContents: wantsTextInput,
    ignoreMouseEvents: !cardInteractive,
    forwardMouseEvents: true,
    activation: wantsTextInput ? 'active' : 'inactive',
    reason: wantsTextInput
      ? 'explicit-text-input'
      : cardInteractive
        ? 'card-interaction'
        : reason === 'appearance' ? 'appearance' : String(reason),
  })
}

/**
 * Bounded, coalescing diagnostics buffer for window lifecycle events.
 * Every detail value is reduced to a short primitive so a renderer error object
 * can never grow memory without bound or leak a large payload.
 * @param {object} [options]
 * @param {number} [options.limit]
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createWindowDiagnostics({ limit = DIAGNOSTIC_LIMIT, now = () => Date.now() } = {}) {
  const capacity = Math.max(1, Math.floor(Number(limit) || DIAGNOSTIC_LIMIT))
  const entries = []
  let dropped = 0
  let recorded = 0

  const sanitize = (detail) => {
    if (detail === null || detail === undefined) return {}
    if (typeof detail !== 'object') return { value: String(detail).slice(0, 300) }
    const output = {}
    for (const [key, value] of Object.entries(detail)) {
      if (value === null || value === undefined) continue
      if (typeof value === 'number' && Number.isFinite(value)) output[key] = value
      else if (typeof value === 'boolean') output[key] = value
      else if (typeof value === 'string') output[key] = value.slice(0, 300)
      else if (value instanceof Error) output[key] = String(value.message || value.name || 'error').slice(0, 300)
      else if (typeof value === 'object') {
        // One bounded nesting level (error-like {code, message} shapes).
        const nested = {}
        for (const [childKey, childValue] of Object.entries(value).slice(0, 8)) {
          if (['string', 'number', 'boolean'].includes(typeof childValue)) {
            nested[childKey] = typeof childValue === 'string' ? childValue.slice(0, 200) : childValue
          }
        }
        if (Object.keys(nested).length > 0) output[key] = nested
      }
    }
    return output
  }

  const push = (kind, detail) => {
    recorded += 1
    const last = entries[entries.length - 1]
    if (last && last.kind === kind) {
      // Coalesce a repeated kind (e.g. repeated failed bounds applies) into one
      // bounded entry with a counter instead of growing the buffer.
      last.count += 1
      last.lastAt = now()
      last.detail = sanitize(detail)
      return last
    }
    const entry = { kind: String(kind), at: now(), count: 1, detail: sanitize(detail) }
    entries.push(entry)
    while (entries.length > capacity) {
      entries.shift()
      dropped += 1
    }
    return entry
  }

  return {
    record: push,
    snapshot() {
      return entries.map(entry => ({ ...entry, detail: { ...entry.detail } }))
    },
    state() {
      return { capacity, recorded, dropped, retained: entries.length }
    },
  }
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

function normalizeRect(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height }
}

function rightOf(rect) {
  return rect.x + rect.width
}

function bottomOf(rect) {
  return rect.y + rect.height
}

function overlapArea(a, b) {
  const width = Math.min(rightOf(a), rightOf(b)) - Math.max(a.x, b.x)
  const height = Math.min(bottomOf(a), bottomOf(b)) - Math.max(a.y, b.y)
  return width > 0 && height > 0 ? width * height : 0
}

function totalOverlap(rect, others) {
  return others.reduce((sum, other) => sum + overlapArea(rect, other), 0)
}

/** Smallest distance between two rectangles (0 when they overlap). */
export function edgeDistance(a, b) {
  const left = a.x + a.width <= b.x ? b.x - (a.x + a.width) : b.x + b.width <= a.x ? a.x - (b.x + b.width) : 0
  const top = a.y + a.height <= b.y ? b.y - (a.y + a.height) : b.y + b.height <= a.y ? a.y - (b.y + b.height) : 0
  return Math.hypot(left, top)
}

function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y
    && rightOf(inner) <= rightOf(outer) && bottomOf(inner) <= bottomOf(outer)
}

/** Pick the display hosting the anchor: containment, else largest overlap, else nearest centre. */
export function displayForAnchor(anchor, displays = []) {
  const list = displays.filter(display => normalizeRect(display?.workArea))
  if (list.length === 0) return null
  const centreX = anchor.x + anchor.width / 2
  const centreY = anchor.y + anchor.height / 2
  const containing = list.find((display) => {
    const area = display.workArea
    return centreX >= area.x && centreX < area.x + area.width
      && centreY >= area.y && centreY < area.y + area.height
  })
  if (containing) return containing
  let best = null
  let bestOverlap = -1
  for (const display of list) {
    const overlap = overlapArea(anchor, display.workArea)
    if (overlap > bestOverlap) {
      bestOverlap = overlap
      best = display
    }
  }
  if (bestOverlap > 0) return best
  let nearest = list[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (const display of list) {
    const area = display.workArea
    const distance = Math.hypot(area.x + area.width / 2 - centreX, area.y + area.height / 2 - centreY)
    if (distance < bestDistance) {
      bestDistance = distance
      nearest = display
    }
  }
  return nearest
}

function slotBase({ slot, x, y, width, height, scrollFallback = false }) {
  return { slot, x: round(x), y: round(y), width: round(width), height: round(height), scrollFallback }
}

/**
 * Build the candidate slots anchored to the pet. Each slot keeps the bubble
 * near the pet; no candidate is generated at a far screen edge, which is how
 * "never send the bubble far away to reach zero overlap" is enforced.
 */
function anchoredCandidates({
  orb,
  area,
  width,
  height,
  minHeight,
  gap,
  tailOverlap,
  blockedAbove,
}) {
  const centreX = orb.x + orb.width / 2
  const sideY = orb.y - Math.round(height / 3)
  const aboveBottom = orb.y + tailOverlap - blockedAbove
  const candidates = []
  const push = candidate => candidates.push(candidate)
  const above = slot => {
    push(slotBase({
      slot: ANCHOR_SLOT.above,
      x: centreX - width / 2,
      y: aboveBottom - slot.height,
      width,
      height: slot.height,
      scrollFallback: slot.scrollFallback === true,
    }))
  }
  // "Above the head" first: the tail anchor. Shrink the height (renderer then
  // scrolls the content area) before giving up the head slot.
  const aboveRoom = aboveBottom - area.y
  if (aboveRoom >= height) {
    above({ height })
  } else if (aboveRoom >= minHeight) {
    above({ height: aboveRoom, scrollFallback: true })
  }
  // "Beside the head" next, then a top gap variant that leaves the pet clear.
  push(slotBase({
    slot: ANCHOR_SLOT.left,
    x: orb.x - width - gap,
    y: sideY,
    width,
    height,
  }))
  push(slotBase({
    slot: ANCHOR_SLOT.right,
    x: orb.x + orb.width + gap,
    y: sideY,
    width,
    height,
  }))
  const topGapY = orb.y - gap - height
  if (topGapY >= area.y) {
    push(slotBase({
      slot: ANCHOR_SLOT.topGap,
      x: centreX - width / 2,
      y: topGapY,
      width,
      height,
    }))
  }
  const shortTopGapY = orb.y - gap - minHeight
  if (shortTopGapY >= area.y) {
    // Shorter top-gap position anchored immediately above the pet.
    push(slotBase({
      slot: ANCHOR_SLOT.topGap,
      x: centreX - width / 2,
      y: shortTopGapY,
      width,
      height: minHeight,
      scrollFallback: true,
    }))
  }
  // Last-resort nearby slot: below the pet (rarely pretty, never far away).
  push(slotBase({
    slot: ANCHOR_SLOT.below,
    x: centreX - width / 2,
    y: orb.y + orb.height + gap,
    width,
    height,
  }))
  return candidates
}

function evaluateCandidate(candidate, { area, orb, avoid, tailAllowancePx }) {
  const bounds = {
    x: candidate.x,
    y: candidate.y,
    width: candidate.width,
    height: candidate.height,
  }
  const horizontalInside = bounds.x >= area.x && rightOf(bounds) <= rightOf(area)
  const verticalInside = bounds.y >= area.y && bottomOf(bounds) <= bottomOf(area)
  const fullyOnscreen = horizontalInside && verticalInside
  // The bubble card is bottom-aligned inside its window (bubble.css layout),
  // so a visible bottom edge is what keeps approval buttons operable. A
  // horizontal overflow would clip the buttons themselves.
  const controlsOperable = horizontalInside && bottomOf(bounds) <= bottomOf(area)
    && (bounds.y >= area.y || candidate.scrollFallback === true)
  const anchorOverlap = overlapArea(bounds, orb)
  const allowedAnchorOverlap = candidate.slot === ANCHOR_SLOT.above ? tailAllowancePx : 0
  const anchorOverlapCost = candidate.slot === ANCHOR_SLOT.above
    ? Math.max(0, anchorOverlap - allowedAnchorOverlap)
    : anchorOverlap
  // "Near the pet" never means "on top of the pet": outside the deliberate
  // tail overlap, a candidate that covers the pet is only used when the display
  // offers no clean alternative.
  const coversAnchor = anchorOverlapCost > 0
  const avoidOverlap = totalOverlap(bounds, avoid)
  const distance = edgeDistance(bounds, orb)
  const slotRank = candidate.slot === ANCHOR_SLOT.above
    ? 0
    : candidate.slot === ANCHOR_SLOT.topGap
      ? 1
      : candidate.slot === ANCHOR_SLOT.left
        ? 2
        : candidate.slot === ANCHOR_SLOT.right ? 3 : 4
  const centreOffset = Math.abs((bounds.x + bounds.width / 2) - (orb.x + orb.width / 2))
  return {
    ...candidate,
    bounds,
    horizontalInside,
    verticalInside,
    fullyOnscreen,
    controlsOperable,
    coversAnchor,
    anchorOverlap,
    anchorOverlapCost,
    avoidOverlap,
    overlapCost: avoidOverlap + anchorOverlapCost * 2,
    distance,
    slotRank,
    aesthetics: slotRank * 1000 + centreOffset,
  }
}

function clampCandidates(candidate, area, minHeight) {
  const width = candidate.width
  const height = candidate.height
  const targetX = clamp(candidate.x, area.x, Math.max(area.x, rightOf(area) - width))
  const maxBottom = Math.min(bottomOf(candidate.bounds), bottomOf(area))
  const bottom = Math.max(maxBottom, area.y + Math.min(minHeight, height))
  const targetHeight = clamp(bottom - area.y, Math.min(minHeight, height), height)
  return {
    ...candidate,
    x: round(targetX),
    y: round(bottom - targetHeight),
    height: round(targetHeight),
    scrollFallback: candidate.scrollFallback || targetHeight < height,
    clamped: true,
  }
}

function compareCandidates(a, b) {
  if (a.controlsOperable !== b.controlsOperable) return a.controlsOperable ? -1 : 1
  if (a.fullyOnscreen !== b.fullyOnscreen) return a.fullyOnscreen ? -1 : 1
  // "Near the pet" must not degenerate into "on top of the pet": a clean
  // anchored slot always wins over one covering the pet's head/body.
  if (a.coversAnchor !== b.coversAnchor) return a.coversAnchor ? 1 : -1
  if (a.distance !== b.distance) return a.distance - b.distance
  if (a.overlapCost !== b.overlapCost) return a.overlapCost - b.overlapCost
  if (a.slotRank !== b.slotRank) return a.slotRank - b.slotRank
  return a.aesthetics - b.aesthetics
}

function selected(pool, chosen) {
  return { pool, chosen }
}

function pickBest(evaluated, pools) {
  for (const pool of pools) {
    const candidates = evaluated.filter(pool)
    if (candidates.length > 0) {
      const winner = candidates.reduce((best, candidate) => (compareCandidates(candidate, best) < 0 ? candidate : best))
      return selected(candidates, winner)
    }
  }
  const winner = evaluated.reduce((best, candidate) => (compareCandidates(candidate, best) < 0 ? candidate : best))
  return selected(evaluated, winner)
}

/**
 * Place the bubble window relative to the pet.
 *
 * Priority is fixed and lexicographic: fully onscreen with operable controls,
 * then nearest pet anchor, then least overlap, then aesthetics. The 24 logical
 * px budget is used for the preferred side gaps; when the display/edge does not
 * have room the policy first shrinks the content height (the renderer scrolls),
 * then allows a *bounded* clamp/overlap near the pet. It never generates a far
 * candidate and never returns a window whose approval buttons are offscreen
 * unless the display itself is smaller than the minimum window.
 *
 * @param {object} options
 * @param {{x:number,y:number,width:number,height:number}} options.orbBounds Pet window bounds (DIP).
 * @param {{x:number,y:number,width:number,height:number}} options.workArea Work area of the anchor display (DIP).
 * @param {Array<{id?:unknown,workArea:object,scaleFactor?:number}>} [options.displays] All displays; defaults to `workArea`.
 * @param {Array<object>} [options.avoidBounds] Other windows the bubble should overlap as little as possible.
 * @param {number} [options.width] Bubble window width.
 * @param {number} [options.height] Maximum bubble window height.
 * @param {number} [options.minHeight] Minimum height that keeps approval buttons usable.
 * @param {number} [options.gap] Logical anchor gap budget (default 24).
 * @param {number} [options.tailOverlapPx] Transparent tail overlap with the pet's head.
 * @param {number} [options.blockedAbovePx] Task-card stack height above the pet.
 * @param {number|null} [options.scaleFactor] Override the anchor display's scale factor.
 * @returns {object}
 */
export function selectBubblePlacement({
  orbBounds,
  workArea,
  displays = null,
  avoidBounds = [],
  width = 380,
  height = 420,
  minHeight = 118,
  gap = ANCHOR_GAP_PX,
  tailOverlapPx = 42,
  blockedAbovePx = 0,
  scaleFactor = null,
} = {}) {
  const orb = normalizeRect(orbBounds)
  if (!orb) throw new TypeError('selectBubblePlacement: orbBounds must be a finite non-empty rectangle')
  const displayList = Array.isArray(displays) && displays.length > 0
    ? displays
    : [{ id: 'default', workArea }]
  const anchorDisplay = displayForAnchor(orb, displayList)
  if (!anchorDisplay) throw new TypeError('selectBubblePlacement: workArea must be a finite non-empty rectangle')
  const area = normalizeRect(anchorDisplay.workArea)
  if (!area) throw new TypeError('selectBubblePlacement: workArea must be a finite non-empty rectangle')

  const bubbleWidth = Math.max(1, round(width))
  const maxHeight = Math.max(1, round(height))
  const minimumHeight = clamp(Math.max(1, round(minHeight)), 1, maxHeight)
  const anchorGap = Math.max(0, round(gap))
  const tailOverlap = Math.max(0, round(tailOverlapPx))
  const blockedAbove = Math.max(0, round(blockedAbovePx))
  const avoid = (Array.isArray(avoidBounds) ? avoidBounds : [])
    .map(normalizeRect)
    .filter(Boolean)
  const scale = Number.isFinite(Number(scaleFactor)) && Number(scaleFactor) > 0
    ? Number(scaleFactor)
    : Number.isFinite(Number(anchorDisplay.scaleFactor)) && Number(anchorDisplay.scaleFactor) > 0
      ? Number(anchorDisplay.scaleFactor)
      : 1

  const diagnostics = []
  const candidates = anchoredCandidates({
    orb,
    area,
    width: bubbleWidth,
    height: maxHeight,
    minHeight: minimumHeight,
    gap: anchorGap,
    tailOverlap,
    blockedAbove,
  }).map(candidate => slotBase(candidate)).map((candidate) => {
    // Horizontal clamp keeps the card (and its buttons) fully inside the
    // display while preserving the anchored vertical position.
    const variants = [candidate]
    const clampedX = clamp(candidate.x, area.x, Math.max(area.x, rightOf(area) - candidate.width))
    if (clampedX !== candidate.x) {
      variants.push({ ...candidate, x: round(clampedX), xClamped: true })
    }
    // A side slot next to a pet that touches the top/bottom work-area edge is
    // still usable: only the vertical position is clamped, the horizontal gap
    // to the pet (the actual anchoring intent) stays exact.
    if (candidate.slot !== ANCHOR_SLOT.above && candidate.slot !== ANCHOR_SLOT.topGap) {
      for (const variant of [...variants]) {
        const clampedY = clamp(variant.y, area.y, Math.max(area.y, bottomOf(area) - variant.height))
        if (clampedY !== variant.y) {
          variants.push({ ...variant, y: round(clampedY), yClamped: true })
        }
      }
    }
    return variants
  }).flat()

  const evaluationContext = { area, orb, avoid, tailAllowancePx: tailOverlap * bubbleWidth }
  const evaluated = candidates.map(candidate => evaluateCandidate(candidate, evaluationContext))
  const result = pickBest(evaluated, [
    // Fixed priority: fully onscreen + operable controls first; the pet must not
    // be covered when a clean anchored slot exists; then the nearest/least
    // overlapping candidate wins.
    candidate => candidate.controlsOperable && candidate.fullyOnscreen && !candidate.coversAnchor,
    candidate => candidate.controlsOperable && candidate.fullyOnscreen,
    candidate => candidate.controlsOperable && !candidate.coversAnchor,
    candidate => candidate.controlsOperable,
  ])
  let chosen = result.chosen
  let fallbackReason = null
  let placement = chosen.slot === ANCHOR_SLOT.above || chosen.slot === ANCHOR_SLOT.topGap
    ? WINDOW_PLACEMENT.above
    : WINDOW_PLACEMENT.side
  if (!chosen.controlsOperable || !chosen.fullyOnscreen) {
    // Fallback: keep the bubble near the pet but clamp it into the display and
    // shrink the scrollable content area so the bottom-anchored card (with the
    // approval buttons) stays on screen. This is explicit bounded overlap, not
    // a silent move to the far edge.
    fallbackReason = chosen.controlsOperable ? 'not-fully-onscreen' : 'insufficient-space'
    const clamped = evaluated.map(candidate => evaluateCandidate(
      clampCandidates(candidate, area, minimumHeight),
      evaluationContext,
    ))
    chosen = clamped.reduce((best, candidate) => (compareCandidates(candidate, best) < 0 ? candidate : best))
    placement = WINDOW_PLACEMENT.boundedOverlap
    diagnostics.push({
      kind: 'desktop.bubble_placement_fallback',
      reason: fallbackReason,
      slot: chosen.slot,
      workArea: { ...area },
    })
  }
  const clippedHorizontally = bubbleWidth > area.width
  const tooShortForActions = area.height < minimumHeight
  if (clippedHorizontally || tooShortForActions) {
    fallbackReason = fallbackReason ?? 'display-smaller-than-window'
    placement = WINDOW_PLACEMENT.boundedOverlap
    diagnostics.push({
      kind: 'desktop.bubble_display_too_small',
      workAreaWidth: area.width,
      workAreaHeight: area.height,
      width: bubbleWidth,
      minHeight: minimumHeight,
    })
  }
  const bounds = {
    x: round(chosen.bounds.x),
    y: round(chosen.bounds.y),
    width: round(chosen.bounds.width),
    height: round(chosen.bounds.height),
  }
  const anchorDistance = edgeDistance(bounds, orb)
  const withinAnchorBudget = anchorDistance <= anchorGap + 0.5
  if (!withinAnchorBudget) {
    // The budget is a Phase-0 target, not an absolute promise: an edge/Dock
    // constrained slot may end up slightly farther away. Record it so the
    // native probe can review the real value instead of silently passing.
    diagnostics.push({
      kind: 'desktop.bubble_anchor_budget_exceeded',
      anchorGapPx: Math.round(anchorDistance * 100) / 100,
      budgetPx: anchorGap,
      slot: chosen.slot,
    })
  }
  return {
    bounds,
    placement,
    slot: chosen.slot,
    display: {
      id: anchorDisplay.id ?? null,
      workArea: { ...area },
      scaleFactor: scale,
    },
    anchorGapPx: Math.round(anchorDistance * 100) / 100,
    gapBudgetPx: anchorGap,
    deviceGapBudgetPx: Math.round(anchorGap * scale),
    withinAnchorBudget,
    fullyOnscreen: chosen.fullyOnscreen,
    controlsOperable: chosen.controlsOperable,
    coversAnchor: chosen.coversAnchor === true,
    scrollFallback: chosen.scrollFallback === true,
    contentHeightLimitPx: bounds.height,
    boundedOverlap: placement === WINDOW_PLACEMENT.boundedOverlap,
    fallbackReason,
    actionsClipped: clippedHorizontally || tooShortForActions,
    avoidOverlapPx2: chosen.avoidOverlap,
    anchorOverlapPx2: chosen.anchorOverlap,
    diagnostics,
  }
}

/**
 * Fit a measured content height into the bottom-anchored bubble slot.
 * The bottom edge never moves, so the bubble grows/shrinks upwards and the tail
 * keeps pointing at the pet's head.
 * @param {object} options
 * @param {{x:number,y:number,width:number,height:number}} options.baseBounds Maximum slot returned by the placement policy.
 * @param {number|null} [options.contentHeight] Height measured by the renderer.
 * @param {number} [options.minHeight] Minimum usable height.
 * @returns {{x:number,y:number,width:number,height:number}}
 */
export function fitBubbleWindowBounds({ baseBounds, contentHeight = null, minHeight = 1 } = {}) {
  const base = normalizeRect(baseBounds)
  if (!base) throw new TypeError('fitBubbleWindowBounds: baseBounds must be a finite non-empty rectangle')
  const maximum = round(base.height)
  const minimum = clamp(round(minHeight), 1, maximum)
  const measured = Number(contentHeight)
  const height = Number.isFinite(measured) && measured > 0
    ? clamp(round(measured), minimum, maximum)
    : maximum
  return {
    x: round(base.x),
    y: round(base.y) + maximum - height,
    width: round(base.width),
    height,
  }
}

/* ------------------------------------------------------------------ */
/* Executor controller (no Electron import; BrowserWindow is injected)  */
/* ------------------------------------------------------------------ */

/**
 * Executor used by the Electron main process. It applies the pure plans above
 * to a BrowserWindow-like object and records bounded diagnostics. Tests inject
 * a fake BrowserWindow/application, so this file stays Electron-free.
 * @param {object} [options]
 * @param {object|null} [options.logger] Logger with optional warn/info methods.
 * @param {object|null} [options.diagnostics] Injected diagnostics buffer.
 * @param {string} [options.platform]
 * @param {unknown} [options.processType] Actual activation policy.
 * @param {() => number} [options.now]
 * @returns {object}
 */
export function createWindowLayerController({
  logger = null,
  diagnostics = null,
  platform = 'darwin',
  processType = PROCESS_TYPE.unknown,
  now = () => Date.now(),
} = {}) {
  const buffer = diagnostics ?? createWindowDiagnostics({ now })
  const initialType = normalizeProcessType(processType)
  let currentType = initialType
  let appliedDockVisible = null
  let lastTransitionAt = null
  let transitions = 0
  const applied = new Map()

  const warn = (kind, detail, error) => {
    buffer.record(kind, { ...detail, error: error ? String(error?.message || error) : undefined })
    try {
      logger?.warn?.(kind, { ...detail, error: error ? String(error?.message || error) : undefined })
    } catch {
      // A broken logger must never break window policy execution.
    }
  }

  const safely = (kind, detail, operation) => {
    try {
      return operation()
    } catch (error) {
      warn(kind, detail, error)
      return undefined
    }
  }

  const layerFor = (role) => windowLayerPlan({ role, platform, processType: currentType })

  return {
    diagnostics: buffer,
    layerFor,
    processType: () => currentType,

    /** Apply level/Spaces/process-type policy once per window (idempotent). */
    applyLayer(window, { role = WINDOW_ROLE.bubble } = {}) {
      if (!window || typeof window !== 'object') return null
      const plan = layerFor(role)
      if (plan.alwaysOnTop) {
        safely('desktop.window_layer_failed', { role, level: plan.level }, () => {
          if (typeof window.setAlwaysOnTop === 'function') window.setAlwaysOnTop(true, plan.level)
        })
      }
      if (plan.spaces.visibleOnAllWorkspaces) {
        safely('desktop.window_spaces_failed', { role, ...plan.spaces }, () => {
          window.setVisibleOnAllWorkspaces?.(true, {
            visibleOnFullScreen: plan.spaces.visibleOnFullScreen,
            skipTransformProcessType: plan.spaces.skipTransformProcessType,
          })
        })
      }
      applied.set(role, plan)
      buffer.record('desktop.window_layer_applied', { role, level: plan.level, skipTransformProcessType: plan.spaces.skipTransformProcessType })
      return plan
    },

    /** Apply the click-through / focusable part of the interaction plan. */
    applyInteraction(window, { role = WINDOW_ROLE.bubble, interactive = false, inputMode = false } = {}) {
      if (!window || typeof window !== 'object') return null
      const plan = windowInteractionPlan({ role, interactive, inputMode })
      safely('desktop.window_focusable_failed', { role, inputMode }, () => {
        if (typeof window.setFocusable === 'function' && applied.get(`${role}:focusable`) !== plan.focusable) {
          window.setFocusable(plan.focusable)
          applied.set(`${role}:focusable`, plan.focusable)
        }
      })
      const mouseKey = `${role}:mouse:${plan.ignoreMouseEvents}:${plan.forwardMouseEvents}`
      if (applied.get(`${role}:mouse-mode`) !== mouseKey) {
        safely('desktop.window_mouse_mode_failed', { role, interactive }, () => {
          if (typeof window.setIgnoreMouseEvents === 'function') {
            window.setIgnoreMouseEvents(plan.ignoreMouseEvents, { forward: plan.forwardMouseEvents })
          }
        })
        applied.set(`${role}:mouse-mode`, mouseKey)
      }
      return plan
    },

    /**
     * Show with the planned activation mode: `showInactive` unless the user
     * explicitly asked for text input. Never focuses on plain appearance.
     */
    show(window, { role = WINDOW_ROLE.bubble, interactive = false, inputMode = false, focus = null } = {}) {
      if (!window || typeof window !== 'object') return null
      const plan = this.applyInteraction(window, { role, interactive, inputMode })
      if (plan.showMode === 'active') {
        safely('desktop.window_show_failed', { role, mode: 'active' }, () => {
          if (typeof window.show === 'function') window.show()
          else window.showInactive?.()
        })
        safely('desktop.window_focus_failed', { role }, () => {
          if (plan.focusWebContents && typeof focus === 'function') focus()
          else window.focus?.()
        })
      } else {
        safely('desktop.window_show_inactive_failed', { role }, () => {
          if (typeof window.showInactive === 'function') window.showInactive()
          else window.show?.()
        })
      }
      buffer.record('desktop.window_shown', { role, mode: plan.showMode })
      return plan
    },

    /**
     * Apply bounds only when geometry actually changed, so frequent 300 ms
     * status polls cannot cause window jitter or redundant native calls.
     * @returns {boolean} Whether the native call happened.
     */
    applyBounds(window, bounds, { role = WINDOW_ROLE.bubble } = {}) {
      const next = normalizeRect(bounds)
      if (!next) {
        warn('desktop.window_bounds_rejected', { role, bounds })
        return false
      }
      const key = `${next.x},${next.y},${next.width},${next.height}`
      if (applied.get(`${role}:bounds`) === key) return false
      const ok = safely('desktop.window_bounds_failed', { role, bounds: next }, () => {
        if (typeof window?.setBounds === 'function') window.setBounds(next, false)
        else if (typeof window?.setBounds === 'function') window.setBounds(next)
        return true
      })
      if (ok) {
        applied.set(`${role}:bounds`, key)
        buffer.record('desktop.window_bounds', { role, ...next })
        return true
      }
      return false
    },

    hide(window, { role = WINDOW_ROLE.bubble } = {}) {
      safely('desktop.window_hide_failed', { role }, () => window?.hide?.())
      buffer.record('desktop.window_hidden', { role })
    },

    /**
     * Decide (and optionally apply) a Dock/process-type transition. Only
     * startup and an explicit user setting change may switch; visibility and
     * capture paths are suppressed with a diagnostic.
     */
    applyProcessType({ desiredDockVisible = true, reason = 'startup', application = null } = {}) {
      const plan = processTypeTransition({
        platform,
        current: currentType,
        desiredDockVisible,
        reason,
      })
      if (!plan.apply) {
        buffer.record('desktop.process_type_stable', {
          reason: plan.suppressedReason ?? reason,
          current: plan.current,
          target: plan.target,
        })
        return plan
      }
      if (lastTransitionAt !== null && now() - lastTransitionAt < PROCESS_TYPE_MIN_INTERVAL_MS) {
        buffer.record('desktop.process_type_rate_limited', { current: currentType, target: plan.target })
        return { ...plan, apply: false, suppressedReason: 'rate-limited' }
      }
      if (transitions >= 2) {
        buffer.record('desktop.process_type_stable', { reason: 'transition-limit', current: currentType })
        return { ...plan, apply: false, suppressedReason: 'transition-limit' }
      }
      const ok = safely('desktop.process_type_failed', { target: plan.target }, () => {
        if (typeof application?.setActivationPolicy !== 'function') return undefined
        application.setActivationPolicy(plan.target)
        return true
      })
      if (ok !== true) return { ...plan, apply: false, suppressedReason: 'apply-failed' }
      currentType = plan.target
      appliedDockVisible = desiredDockVisible !== false
      lastTransitionAt = now()
      transitions += 1
      buffer.record('desktop.process_type_applied', { target: plan.target, dockVisible: appliedDockVisible })
      return { ...plan, apply: true, applied: true }
    },

    state() {
      return {
        currentType,
        appliedDockVisible,
        transitions,
        lastTransitionAt,
        diagnostics: buffer.state(),
      }
    },
  }
}
