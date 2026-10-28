/** Desktop presentation of official DSH events and pending requests; owns no Agent. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'write_file'])
const READ_TOOLS = new Set(['read', 'list', 'glob', 'grep'])
const SHELL_TOOLS = /terminal|bash|shell|exec/i

/** Turn an approval request into a Chinese summary plus expandable technical details.
 *  Only the tool name and the Host-provided reason are treated as facts: `read` is
 *  described as reading, `bash` only as running a command, anything else as an
 *  unspecified operation. No risk inference is made from the command text. */
export function approvalView(request) {
  const tool = String(request?.toolName || '')
  const reason = String(request?.reason || '')
  const outside = reason.match(/outside workspace:\s*(.+)$/i)
  const target = outside ? outside[1].trim() : ''
  const action = WRITE_TOOLS.has(tool) ? '写入或修改工作区外的文件'
    : READ_TOOLS.has(tool) ? '读取工作区外的文件'
      : SHELL_TOOLS.test(tool) ? '在工作区外运行命令'
        : '执行一个需要你批准的操作'
  const text = target
    ? `Nisse 想${action}：\n${target}`
    : `Nisse 想${action}${tool ? `（工具：${tool}）` : ''}。`
  const details = [
    `工具：${tool || '未知'}`,
    ...(target ? [`目标：${target}`] : []),
    ...(reason ? [`原始原因：${reason}`] : []),
    '范围：仅本次请求；不会复用为后续操作的授权',
  ]
  return { text, details }
}

/** Replace upstream failure prose with a user-facing summary where we know the case. */
export function humanizeFailure(message) {
  const raw = String(message || '').trim()
  if (/DSH 进程在本轮完成前退出|DSH process .*before .*completed|interrupted/i.test(raw)) {
    return '上次任务被中断，可能还有未完成的工具调用，结果未知。请双击桌宠打开主窗口确认状态，再决定是否重试。'
  }
  return raw || '任务执行失败。'
}

import { activityBubblePayload } from './activity-bubble.mjs'

export function createCompanionPresentation({ show, hide, animate, send, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let requests = [], identity = '', text = '', timer, busy = false, stopped = false
  let questionIndex = 0, answers = [], selected = [], customInput = false
  let voice = 'idle', working = false, startedAt = 0, inputSource = 'desktop', captureId = '', captureIdentity = '', captureTimer
  const expiredInputs = new Set()
  const cancelTimer = () => { clearTimer(timer); timer = undefined }
  const animation = (cue = null) => animate({ state: requests.length ? 'awaiting-input' : voice !== 'idle' ? voice : working ? 'working' : 'idle', baseWorking: working, cue })
  const resetDraft = () => { questionIndex = 0; answers = []; selected = []; customInput = false; busy = false }
  function render(hint = '') {
    const request = requests[0]
    if (!request) return
    cancelTimer()
    animation()
    const base = { visible: true, kind: 'action', requestId: request.id, busy, clickThrough: false, hint,
      title: `${request.kind === 'approval' ? '需要批准' : '请你选择'}${requests.length > 1 ? ` · 还有 ${requests.length - 1} 项` : ''}` }
    if (request.kind === 'approval') {
      const approval = approvalView(request)
      show({ ...base, text: approval.text, details: approval.details, approval: { id: request.id } })
      return
    }
    const question = request.questions[questionIndex]
    const multiQuestion = request.questions.length > 1
    const needsSubmit = question.multiSelect === true
    const showInput = customInput || !question.options?.length
    show({ ...base, title: question.header || base.title,
      text: [question.question, question.detail].filter(Boolean).join('\n\n'),
      progress: multiQuestion ? `${questionIndex + 1} / ${request.questions.length}` : '',
      choices: (question.options || []).map((option, index) => ({ id: String(index), label: option.label, description: option.description || '', selected: selected.includes(option.label) })),
      input: showInput ? { placeholder: '输入你的回答', submitLabel: questionIndex + 1 < request.questions.length ? '下一项' : '提交' } : null,
      secondary: [
        ...(needsSubmit && !showInput ? [{ id: 'submit', label: '提交' }] : []),
        ...(question.options?.length && !customInput ? [{ id: 'other', label: '其他回答' }] : []),
        ...(questionIndex ? [{ id: 'back', label: '上一项' }] : []),
        ...(needsSubmit ? [] : [{ id: 'skip', label: '跳过' }]),
      ],
    })
  }
  function notice(value, kind = 'status', duration = 4500, capture = '', options = {}) {
    if (stopped || requests.length) return
    cancelTimer()
    show({ visible: true, kind, text: value, clickThrough: !['input', 'speech'].includes(kind), ...(kind === 'input' ? { requestId: capture, cancel: { id: 'cancel-capture', label: '取消录音' }, inputLabel: '你说' } : {}), ...options })
    if (duration > 0) timer = setTimer(() => { if (!requests.length && !stopped) hide() }, duration)
  }
  async function submit(request, body) {
    busy = true
    render('正在提交…')
    try {
      await send(request.kind === 'approval' ? '/approval' : '/questions/answer', { id: request.id, sessionId: request.sessionId, ...body })
      if (requests[0]?.id === request.id) {
        requests = requests.filter(item => item.id !== request.id)
        resetDraft()
        if (requests.length) render()
        else { hide(); animation() }
      }
    } catch (error) {
      if (requests[0]?.id !== request.id) return
      busy = false
      render(error?.stale ? '这个请求已结束，正在同步…' : '提交失败，请重试；仍失败可双击桌宠打开主窗口查看。')
    }
  }
  async function completeQuestion(request, custom, skipped = false) {
    const question = request.questions[questionIndex]
    if (!skipped && !selected.length && !custom?.trim()) return render('请选择一项或填写回答。')
    answers[questionIndex] = { id: question.id, selected: [...selected], ...(custom?.trim() ? { custom: custom.trim() } : {}) }
    if (questionIndex + 1 < request.questions.length) {
      questionIndex++; selected = []; customInput = false; render()
    } else await submit(request, { answer: { answers } })
  }
  return {
    notice,
    capture(status) {
      if (stopped) return
      if (status.kind === 'capture-start' && status.captureId) {
        captureId = status.captureId
        captureIdentity = ''
        clearTimer(captureTimer)
        notice(status.text || '正在听…', 'input', 0, captureId)
        return
      }
      const identity = `${status.captureId}:${status.utteranceId || ''}`
      if (status.kind === 'input' && expiredInputs.has(identity)) return
      if (status.kind === 'input' && status.captureId && identity !== captureIdentity) {
        captureIdentity = identity
        captureId = status.captureId
        clearTimer(captureTimer); const own = captureId
        captureTimer = setTimer(() => { if (captureId === own) { captureId = ''; expiredInputs.add(identity); if (expiredInputs.size > 64) expiredInputs.delete(expiredInputs.values().next().value); if (!requests.length) hide() } }, 15000)
      }
      if (status.kind === 'input' && status.captureId === captureId) notice(status.text, 'input', 4500, captureId)
      else if (status.kind === 'transcript' || status.kind === 'capture-end') { captureId = ''; clearTimer(captureTimer); if (status.text) notice(status.text, 'transcript', 2200); else if (!requests.length) hide() }
    },
    cancelCapture(id) { if (!id || id !== captureId) return false; captureId = ''; clearTimer(captureTimer); cancelTimer(); if (!requests.length) hide(); return true },
    sync(snapshot) {
      if (stopped) return
      const nextIdentity = `${snapshot.pid}:${snapshot.sessionId}`
      const changedOwner = identity !== nextIdentity
      identity = nextIdentity
      const previous = requests[0]?.id, previousCount = requests.length
      requests = snapshot.requests || []
      if (changedOwner || previous !== requests[0]?.id) {
        resetDraft(); cancelTimer()
        if (changedOwner) { working = false; text = ''; voice = 'idle' }
        if (requests.length) render()
        else { hide(); animation() }
      } else if (requests.length && previousCount !== requests.length) render()
    },
    event(event) {
      if (stopped) return
      if (event.type === 'turn.started' || event.type === 'turn.accepted') { text = ''; if (!working) startedAt = Date.now(); working = true; inputSource = event.data?.inputSource || (event.type === 'turn.accepted' ? 'desktop' : inputSource); captureId = ''; clearTimer(captureTimer); animation() }
      if (event.type === 'assistant.delta') { text += event.data?.text || ''; notice(text, 'speech', 6500) }
      if (event.type === 'assistant.message' && event.data?.text) notice(event.data.text, 'speech', 6500)
      if (event.type === 'tool.call') { const payload = activityBubblePayload(event); if (payload) notice(payload.text, 'activity') }
      if (event.type === 'turn.ended') {
        working = false
        const failed = event.data?.reason?.kind === 'failed'
        animation({ id: `turn:${event.ioSeq}`, name: failed ? 'failed' : 'jumping' })
        if (!requests.length) { cancelTimer(); timer = setTimer(hide, 1800) }
      }
      if (event.type === 'error') {
        working = false
        animation({ id: `error:${event.ioSeq}`, name: 'failed' })
        notice(humanizeFailure(event.data?.message), 'error', 9000, '', { secondary: [{ id: 'open', label: '打开主窗口' }] })
      }
    },
    voice(state) { voice = state; animation() },
    state: () => ({ working, startedAt, inputSource, waiting: requests.length > 0 }),
    async action(action) {
      if (stopped) return
      if (action.type === 'open') return send('open')
      if (action.type === 'secondary' && action.id === 'open') return send('open')
      const request = requests[0]
      if (!request || busy || action.requestId !== request.id) return
      if (action.type === 'approval' && request.kind === 'approval') return submit(request, { decision: action.decision })
      if (request.kind !== 'question') return
      const question = request.questions[questionIndex]
      if (action.type === 'choice') {
        const option = question.options?.[Number(action.id)]
        if (!option) return
        if (question.multiSelect) {
          selected = selected.includes(option.label) ? selected.filter(label => label !== option.label) : [...selected, option.label]
          render()
        } else { selected = [option.label]; await completeQuestion(request) }
      } else if (action.type === 'input') await completeQuestion(request, action.value)
      else if (action.type === 'secondary') {
        if (action.id === 'other') { customInput = true; render() }
        if (action.id === 'submit') await completeQuestion(request)
        if (action.id === 'skip') { selected = []; await completeQuestion(request, undefined, true) }
        if (action.id === 'back' && questionIndex > 0) { questionIndex--; selected = answers[questionIndex]?.selected || []; render() }
      }
    },
    stop() { stopped = true; cancelTimer(); clearTimer(captureTimer); requests = []; hide() },
  }
}
