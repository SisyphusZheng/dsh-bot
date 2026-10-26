// 头顶气泡渲染层：白底黑边卡片 + 尾巴；支持回答文本、活动图标、灰色输入气泡、
// 引导流程的输入行/选项/次要按钮、审批是/否。
//
// 窗口默认点击穿透；这里负责在指针进入卡片时请求可交互（按钮/输入），离开后
// 恢复穿透。活动气泡（clickThrough）永远不请求可交互，避免挡住用户操作。
const bubble = document.getElementById('bubble')
const card = document.getElementById('bubble-card')
const iconEl = document.getElementById('bubble-icon')
const titleEl = document.getElementById('bubble-title')
const progressEl = document.getElementById('bubble-progress')
const textEl = document.getElementById('bubble-text')
const hintEl = document.getElementById('bubble-hint')
const inputRow = document.getElementById('bubble-input-row')
const inputLabel = document.getElementById('bubble-input-label')
const inputEl = document.getElementById('bubble-input')
const inputSubmit = document.getElementById('bubble-input-submit')
const choicesEl = document.getElementById('bubble-choices')
const secondaryEl = document.getElementById('bubble-secondary')
const actions = document.getElementById('bubble-actions')
const actionButtons = [...actions.querySelectorAll('button')]
const cancelBtn = document.getElementById('bubble-cancel')
const closeBtn = document.getElementById('bubble-close')

let approvalId = ''
let requestId = ''
let submitting = false
let lastKey = ''
let interactive = false
let clickThrough = false
let cancelAction = null
let hasInput = false
let inputOwner = ''

function setInteractive(next) {
  if (next === interactive) return
  interactive = next
  window.petBubble?.setInteractive?.(next)
}

function requestInputFocus(next) {
  window.petBubble?.requestInputFocus?.(next === true)
}

function ui(payload) {
  return window.petBubble?.action?.({ ...payload, requestId })
}

function hide() {
  lastKey = ''
  bubble.classList.add('hidden')
  bubble.classList.remove('fading', 'entering')
  approvalId = ''
  cancelAction = null
  hasInput = false
  clickThrough = false
  setInteractive(false)
  requestInputFocus(false)
}

function setText(el, value, className) {
  const text = String(value || '')
  el.textContent = text
  el.classList.toggle('hidden', text === '')
  if (className !== undefined) el.className = `${className}${text ? '' : ' hidden'}`
}

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = String(label || '')
  button.tabIndex = 0
  button.addEventListener('click', event => {
    event.stopPropagation()
    onClick()
  })
  return button
}

function render(payload) {
  const value = String(payload?.text || '').trim()
  const title = String(payload?.title || '').trim()
  if (!value && !title) return hide()

  requestId = String(payload?.requestId || '')
  submitting = payload?.busy === true
  const kind = String(payload?.kind || 'speech')
  clickThrough = payload?.clickThrough === true
  hasInput = Boolean(payload?.input)
  const controlsKey = JSON.stringify({
    kind,
    requestId,
    busy: submitting,
    title,
    value,
    hint: payload?.hint || '',
    icon: payload?.icon || '',
    progress: payload?.progress || '',
    input: payload?.input || null,
    choices: payload?.choices || null,
    secondary: payload?.secondary || null,
    cancel: payload?.cancel || null,
    approval: payload?.approval || null,
    clickThrough,
    fading: payload?.fading === true,
  })
  if (controlsKey === lastKey) return
  lastKey = controlsKey

  const wasHidden = bubble.classList.contains('hidden')
  bubble.dataset.kind = kind
  bubble.classList.toggle('click-through', clickThrough)
  bubble.classList.remove('hidden', 'fading', 'entering')
  // 活动气泡把图标放在正文行内（紧凑），其余气泡图标留在 head。
  clearChildren(textEl)
  if (kind === 'activity' && payload?.icon) {
    const iconSpan = document.createElement('span')
    iconSpan.className = 'activity-icon'
    iconSpan.setAttribute('aria-hidden', 'true')
    iconSpan.textContent = payload.icon
    textEl.appendChild(iconSpan)
  }
  textEl.appendChild(document.createTextNode(value))
  setText(titleEl, title, 'title')
  setText(iconEl, payload?.icon || '', 'icon')
  setText(progressEl, payload?.progress || '', 'progress')
  setText(hintEl, payload?.hint || '', 'hint')
  hintEl.classList.toggle('ok', String(payload?.hint || '').startsWith('✓'))
  hintEl.classList.toggle('fail', String(payload?.hint || '').startsWith('✗'))

  if (payload?.input) {
    inputEl.type = payload.input.type === 'password' ? 'password' : payload.input.type === 'number' ? 'number' : 'text'
    inputEl.placeholder = String(payload.input.placeholder || '')
    const owner = `${requestId}:${payload.progress || ''}`
    if (owner !== inputOwner || payload.input.value !== undefined) inputEl.value = String(payload.input.value || '')
    inputOwner = owner
    inputSubmit.textContent = String(payload.input.submitLabel || '发送')
    setText(inputLabel, payload.input.label || '', 'input-label')
    inputRow.classList.remove('hidden')
    requestInputFocus(true)
  } else {
    inputRow.classList.add('hidden')
    requestInputFocus(false)
  }

  // 选项卡（2×2）
  clearChildren(choicesEl)
  if (Array.isArray(payload?.choices) && payload.choices.length) {
    for (const choice of payload.choices) {
      const button = makeButton(choice.label, 'choice', () => { void ui({ type: 'choice', id: choice.id }) })
      button.classList.toggle('selected', choice.selected === true)
      button.setAttribute('aria-pressed', String(choice.selected === true))
      if (choice.description) {
        const detail = document.createElement('small'); detail.textContent = choice.description
        button.appendChild(detail)
      }
      choicesEl.appendChild(button)
    }
    choicesEl.classList.remove('hidden')
  } else {
    choicesEl.classList.add('hidden')
  }

  // 次要按钮（跳过/上一步/自己写）
  clearChildren(secondaryEl)
  if (Array.isArray(payload?.secondary) && payload.secondary.length) {
    for (const item of payload.secondary) {
      secondaryEl.appendChild(makeButton(item.label, 'link', () => {
        ui({ type: 'secondary', id: item.id })
      }))
    }
    secondaryEl.classList.remove('hidden')
  } else {
    secondaryEl.classList.add('hidden')
  }

  // 审批气泡：是/否
  approvalId = String(payload?.approval?.id || '')
  actionButtons[0].textContent = '是'
  actionButtons[1].textContent = '否'
  actions.classList.toggle('hidden', !approvalId)

  closeBtn.hidden = Boolean(requestId)
  for (const button of card.querySelectorAll('button')) button.disabled = submitting
  inputEl.disabled = submitting

  // 输入气泡的取消链接
  cancelAction = payload?.cancel && typeof payload.cancel === 'object' ? payload.cancel : null
  cancelBtn.textContent = cancelAction ? String(cancelAction.label || '取消') : '取消'
  cancelBtn.classList.toggle('hidden', !cancelAction)

  if (payload?.fading) {
    bubble.classList.add('fading')
    return
  }
  if (wasHidden) {
    void bubble.offsetWidth
    bubble.classList.add('entering')
  }
}

// The Host acknowledgement and pending snapshot own removal; failed submits remain retryable.
actionButtons.forEach((button, index) => button.addEventListener('click', event => {
  event.stopPropagation()
  if (!approvalId || submitting) return
  void ui({ type: 'approval', decision: index === 0 ? 'allow' : 'reject' })
}))

cancelBtn.addEventListener('click', event => {
  event.stopPropagation()
  if (!cancelAction) return
  ui({ type: 'cancel', id: cancelAction.id })
  hide()
})

closeBtn.addEventListener('click', event => {
  event.stopPropagation()
  ui({ type: 'close' })
  hide()
})

inputRow.addEventListener('submit', event => {
  event.preventDefault()
  event.stopPropagation()
  ui({ type: 'input', value: inputEl.value })
})
inputEl.addEventListener('pointerdown', event => {
  event.stopPropagation()
  setInteractive(true)
  requestInputFocus(true)
})

// 气泡窗口默认穿透（forward:true 时 mousemove 仍会送达渲染层）；
// 只有指针真正落在卡片上才让窗口接收点击。活动气泡永远保持穿透。
const overCard = event => Boolean(
  !clickThrough
  && event?.target instanceof Element
  && event.target.closest('#bubble .card'),
)
document.addEventListener('mousemove', event => setInteractive(overCard(event)))
document.addEventListener('pointerdown', event => {
  if (overCard(event)) setInteractive(true)
})
bubble.addEventListener('mouseleave', () => {
  if (hasInput) return
  setInteractive(false)
})
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || requestId) return
  if (cancelAction) {
    ui({ type: 'cancel', id: cancelAction.id })
    hide()
  } else if (hasInput) {
    ui({ type: 'close' })
    hide()
  }
})
// W6：双击气泡与双击桌宠同义 —— 交给主进程请桌面壳切换 DSH 窗口。
document.addEventListener('dblclick', event => {
  if (clickThrough || event.target.closest('button,input')) return
  window.petBubble?.openDsh?.()
})
window.petBubble?.onUpdate?.(payload => {
  if (payload?.visible) render(payload)
  else hide()
})

/* Read-only presentation diagnostics. */
window.__nisseBubbleState = () => ({
  kind: bubble.dataset.kind || '',
  visible: !bubble.classList.contains('hidden'),
  clickThrough,
  interactive,
  hasInput,
  text: textEl.textContent || '',
  title: titleEl.textContent || '',
  hint: hintEl.textContent || '',
  hintOk: hintEl.classList.contains('ok'),
  hintFail: hintEl.classList.contains('fail'),
  choices: [...choicesEl.querySelectorAll('button')].map(button => button.textContent),
  secondary: [...secondaryEl.querySelectorAll('button')].map(button => button.textContent),
  approval: approvalId !== '',
  cancel: cancelAction !== null,
})
