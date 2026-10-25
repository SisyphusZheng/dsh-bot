// 气泡 payload 的归一化（主进程 → 气泡窗口的唯一出口）。
//
// 气泡窗口只信任主进程；但主进程的输入来自 bridge/渲染层，仍要在这里把
// 类型、长度、按钮数量夹紧，避免一个坏 payload 撑爆窗口或注入不需要的控件。
// 纯函数。

export const BUBBLE_KINDS = Object.freeze([
  'speech',
  'status',
  'activity',
  'input',
  'onboarding',
  'action',
  'error',
])

export const BUBBLE_MAX_TEXT = 400
export const BUBBLE_MAX_HINT = 200
export const BUBBLE_MAX_TITLE = 40
export const BUBBLE_MAX_INPUT_VALUE = 400
export const BUBBLE_MAX_CHOICES = 4
export const BUBBLE_MAX_SECONDARY = 3
export const BUBBLE_MAX_LABEL = 40
export const BUBBLE_MAX_ICON = 8

const APPROVAL_ID = /^[A-Za-z0-9_.:-]{1,120}$/

function clampText(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function buttonsOf(raw, max) {
  if (!Array.isArray(raw)) return null
  const buttons = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id = clampText(item.id, 60).trim()
    const label = clampText(item.label, BUBBLE_MAX_LABEL).trim()
    if (!id || !label) continue
    buttons.push({ id, label })
    if (buttons.length >= max) break
  }
  return buttons.length ? buttons : null
}

/**
 * Normalize a bubble payload for the bubble window.
 *
 * @param {object} raw main-process payload
 * @returns {object|null} null means "hide the bubble"
 */
export function normalizeBubblePayload(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.visible === false) return null
  const text = clampText(raw.text, BUBBLE_MAX_TEXT).trim()
  const title = clampText(raw.title, BUBBLE_MAX_TITLE).trim()
  const hint = clampText(raw.hint, BUBBLE_MAX_HINT).trim()
  if (!text && !title) return null
  const kind = BUBBLE_KINDS.includes(raw.kind) ? raw.kind : 'speech'
  const approvalId = raw.approval && typeof raw.approval === 'object'
    ? clampText(raw.approval.id, 120).trim()
    : ''
  const approval = APPROVAL_ID.test(approvalId) ? { id: approvalId } : null
  const rawInput = raw.input && typeof raw.input === 'object' ? raw.input : null
  const input = rawInput
    ? {
      placeholder: clampText(rawInput.placeholder, 120),
      value: clampText(rawInput.value, BUBBLE_MAX_INPUT_VALUE),
      label: clampText(rawInput.label, 20),
      submitLabel: clampText(rawInput.submitLabel, 16) || '发送',
      type: ['text', 'password', 'number'].includes(rawInput.type) ? rawInput.type : 'text',
    }
    : null
  const cancel = raw.cancel && typeof raw.cancel === 'object'
    ? { id: clampText(raw.cancel.id, 60) || 'cancel', label: clampText(raw.cancel.label, 16) || '取消' }
    : null
  const payload = {
    visible: true,
    kind,
    text,
    ...(title ? { title } : {}),
    ...(hint ? { hint } : {}),
    ...(raw.icon ? { icon: clampText(raw.icon, BUBBLE_MAX_ICON) } : {}),
    ...(raw.progress ? { progress: clampText(raw.progress, 12) } : {}),
    ...(input ? { input } : {}),
    ...(cancel ? { cancel } : {}),
    ...(approval ? { approval } : {}),
    clickThrough: raw.clickThrough === true || kind === 'activity',
    fading: raw.fading === true,
  }
  const choices = buttonsOf(raw.choices, BUBBLE_MAX_CHOICES)
  if (choices) payload.choices = choices
  const secondary = buttonsOf(raw.secondary, BUBBLE_MAX_SECONDARY)
  if (secondary) payload.secondary = secondary
  // 审批气泡必须是可交互的（是/否），其余按 clickThrough 决定。
  if (approval) payload.clickThrough = false
  if (input) payload.clickThrough = false
  return payload
}

/** Whether the payload shows any control the user can click/type into. */
export function hasBubbleControls(payload) {
  return Boolean(
    payload
    && (payload.approval || payload.input || payload.choices || payload.secondary || payload.cancel),
  )
}
