/** Desktop presentation of official DSH events and pending requests; owns no Agent. */
import { activityBubblePayload } from './activity-bubble.mjs'

export function createCompanionPresentation({ show, hide, animate, send, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let requests = [], identity = '', text = '', timer, busy = false, stopped = false
  let questionIndex = 0, answers = [], selected = [], customInput = false
  let voice = 'idle', working = false, startedAt = 0
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
      show({ ...base, text: request.reason || `允许执行 ${request.toolName}？`, approval: { id: request.id }, secondary: [{ id: 'open', label: '在 DSH 中查看' }] })
      return
    }
    const question = request.questions[questionIndex]
    show({ ...base, title: question.header || base.title,
      text: [question.question, question.detail].filter(Boolean).join('\n\n'),
      progress: `${questionIndex + 1} / ${request.questions.length}`,
      choices: (question.options || []).map((option, index) => ({ id: String(index), label: option.label, description: option.description || '', selected: selected.includes(option.label) })),
      input: customInput || !question.options?.length ? { placeholder: '输入你的回答', submitLabel: questionIndex + 1 < request.questions.length ? '下一项' : '提交' } : null,
      secondary: [
        ...(question.multiSelect ? [{ id: 'submit', label: '确认选择' }] : []),
        ...(question.options?.length ? [{ id: 'other', label: '其他回答' }] : []),
        ...(questionIndex ? [{ id: 'back', label: '上一项' }] : []),
        { id: 'skip', label: '跳过这一项' },
        { id: 'open', label: '在 DSH 中查看' },
      ],
    })
  }
  function notice(value, kind = 'status', duration = 4500) {
    if (stopped || requests.length) return
    cancelTimer()
    show({ visible: true, kind, text: value, clickThrough: true })
    timer = setTimer(() => { if (!requests.length && !stopped) hide() }, duration)
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
      render(error?.stale ? '这个请求已结束，正在同步…' : '提交失败，请重试或打开 DSH。')
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
      if (event.type === 'turn.started' || event.type === 'turn.accepted') { text = ''; working = true; startedAt = Date.now(); animation() }
      if (event.type === 'assistant.delta') { text += event.data?.text || ''; notice(text.slice(-400), 'speech', 6500) }
      if (event.type === 'assistant.message' && event.data?.text) notice(event.data.text.slice(-400), 'speech', 6500)
      if (event.type === 'tool.call') { const payload = activityBubblePayload(event); if (payload) notice(payload.text, 'activity') }
      if (event.type === 'turn.ended') {
        working = false
        const failed = event.data?.reason?.kind === 'failed'
        animation({ id: `turn:${event.ioSeq}`, name: failed ? 'failed' : 'jumping' })
        if (!requests.length) { cancelTimer(); timer = setTimer(hide, 1800) }
      }
      if (event.type === 'error') { working = false; animation({ id: `error:${event.ioSeq}`, name: 'failed' }); notice(event.data?.message || '任务执行失败，请打开 DSH 查看。', 'error', 7000) }
    },
    voice(state) { voice = state; animation() },
    state: () => ({ working, startedAt, waiting: requests.length > 0 }),
    async action(action) {
      if (stopped) return
      if (action.type === 'open') return send('open')
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
        if (action.id === 'open') return send('open')
        if (action.id === 'other') { customInput = true; render() }
        if (action.id === 'submit') await completeQuestion(request)
        if (action.id === 'skip') { selected = []; await completeQuestion(request, undefined, true) }
        if (action.id === 'back' && questionIndex > 0) { questionIndex--; selected = answers[questionIndex]?.selected || []; render() }
      }
    },
    stop() { stopped = true; cancelTimer(); requests = []; hide() },
  }
}
