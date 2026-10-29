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
  const text = `Nisse 想${action}。`
  const operation = request?.operation
  const details = [
    `工具：${tool || '未知'}`,
    ...(target ? [`目标：${target}`] : []),
    ...(operation ? [`工作目录：${operation.cwd}`, `实际参数：${JSON.stringify(operation.arguments, null, 2)}`] : ['未取得真实参数；只能批准本次请求。']),
    ...(reason ? [`原始原因：${reason}`] : []),
    '允许一次仅作用于本次；持续允许只匹配同一工具、工作目录和完全相同的参数，可在右键菜单撤销。',
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

import { questionVoiceAction } from './question-voice.mjs'
import { activityBubblePayload } from './activity-bubble.mjs'

export function createCompanionPresentation({ show, hide, animate, send, setTimer = setTimeout, clearTimer = clearTimeout, publishQuestion = () => {} }) {
  let requests = [], identity = '', text = '', timer, busy = false, stopped = false
  let persistentDraft = false, manager = null, managerEpoch = 0, recovery = null, recoveryEpoch = 0
  let questionIndex = 0, answers = [], selected = [], customInput = false
  let voice = 'idle', working = false, startedAt = 0, inputSource = 'desktop', captureId = '', captureIdentity = '', captureTimer
  let speechVisible = false, voiceWasSpeaking = false
  let inputDraft = null, inputDraftTimer, inputDraftBusy = false
  let queued = {revision:0,entries:[]}, queueView = null
  let questionView = null, questionSignature = '', questionRevision = 0
  const consumedAnswers=new Set()
  function updateQuestion() {
    const request=requests[0], question=request?.kind==='question'?request.questions[questionIndex]:null
    const view=question?{requestId:request.id,sessionId:request.sessionId,questionId:question.id,index:questionIndex,question:question.question,options:question.options||[],multiSelect:question.multiSelect===true,selected:[...selected],busy}:null
    const signature=JSON.stringify(view)
    if(signature!==questionSignature){questionSignature=signature;questionView=view?{...view,revision:++questionRevision}:null;publishQuestion(questionView)}
  }
  const expiredInputs = new Set()
  const cancelTimer = () => { clearTimer(timer); timer = undefined }
  const animation = (cue = null) => animate({ state: requests.length ? 'awaiting-input' : voice !== 'idle' ? voice : working ? 'working' : 'idle', baseWorking: working, cue })
  const resetDraft = () => { questionIndex = 0; answers = []; selected = []; customInput = false; busy = false; persistentDraft = false }
  function render(hint = '') {
    updateQuestion()
    const request = requests[0]
    if (!request) return
    cancelTimer()
    animation()
    const base = { visible: true, kind: 'action', requestId: request.id, busy, clickThrough: false, hint,
      title: `${request.kind === 'approval' ? '需要批准' : '请你选择'}${requests.length > 1 ? ` · 还有 ${requests.length - 1} 项` : ''}` }
    if (request.kind === 'approval') {
      const approval = approvalView(request)
      show({ ...base, text: persistentDraft ? '持续允许完全相同的操作？更换命令、参数或工作目录仍会重新询问。' : approval.text,
        details: approval.details, approval: { id: request.id, allowLabel: persistentDraft ? '确认持续允许' : '允许一次' },
        secondary: request.operation ? [{ id: persistentDraft ? 'grant-back' : 'grant-confirm', label: persistentDraft ? '返回' : '始终允许此操作…' }] : [] })
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
    if (stopped || requests.length || manager || recovery || inputDraft || queueView) return
    cancelTimer()
    speechVisible = kind === 'speech'
    show({ visible: true, kind, text: value, clickThrough: !['input', 'speech'].includes(kind) && !options.secondary?.length, ...(['input','transcript'].includes(kind) ? { title: kind === 'input' ? '我听到（识别中）' : '我听到（已提交）' } : {}), ...(kind === 'input' ? { requestId: capture, cancel: { id: 'cancel-capture', label: '取消录音' } } : {}), ...options })
    if (duration > 0) timer = setTimer(() => { if (!requests.length && !stopped) hide() }, duration)
  }
  function renderManager(hint = '') {
    if (!manager || requests.length || stopped) return
    const rules = manager.rules
    show({ visible: true, kind: 'action', requestId: manager.id, title: '持续授权', text: hint || (rules.length ? '每项仅匹配完全相同的工具、参数和工作目录。点击可撤销。' : '没有持续授权。'),
      choices: rules.map(rule => ({ id: rule.id, label: `撤销 ${rule.toolName}`, description: `${rule.createdAt} · ${rule.key.slice(0, 12)}` })),
      secondary: [{ id: 'grant-close', label: '关闭' }], busy, clickThrough: false })
  }
  async function managePolicies() {
    queueView=null
    if (stopped) return
    if (requests.length || busy) { if (requests.length) render('请先处理当前请求，再管理持续授权。'); return }
    recovery = null; recoveryEpoch++
    const epoch = ++managerEpoch
    try {
      const response = await send('/policies')
      if (stopped || requests.length || epoch !== managerEpoch) return
      manager = { id: `grants:${epoch}`, rules: response.rules || [] }
      cancelTimer(); renderManager(response.error || '')
    } catch { notice('读取持续授权失败，请稍后重试。', 'error') }
  }
  function renderRecovery(hint = '') {
    if (!recovery || requests.length || stopped) return
    const mode = recovery.mode
    show({visible:true,kind:'action',requestId:`recovery:${recovery.token}`,title:mode ? '确认恢复任务' : '恢复上次任务',busy,clickThrough:false,
      text: mode === 'retry' ? '重新提交会开启新一轮任务，可能重复已经执行过的操作。确认结果和副作用后再执行。' : mode === 'continue' ? '将请 Nisse 先核对已完成内容和副作用，只继续未完成部分；无法确认时先询问你。' : recovery.warning,
      details:[`原指令：${recovery.originalText}`], hint,
      choices:mode ? [] : [{id:'continue',label:'检查后继续',description:'先核对结果，只处理未完成部分。'},{id:'retry',label:'重新提交原指令',description:'可能重复执行；下一步仍需确认。'}],
      secondary:[...(mode ? [{id:'recovery-confirm',label:mode==='continue'?'确认检查后继续':'确认重新提交'},{id:'recovery-back',label:'返回'}] : []),{id:'recovery-close',label:'暂不恢复'}]})
  }
  async function recoverTask() {
    queueView=null
    if (stopped) return
    if (requests.length || busy) { if (requests.length) render('请先处理当前请求。'); return }
    manager = null; managerEpoch++
    const epoch = ++recoveryEpoch
    try {
      const preview = await send('/task/recovery')
      if (stopped || requests.length || epoch !== recoveryEpoch) return
      recovery = {...preview,mode:null}; cancelTimer(); renderRecovery()
    } catch { notice('暂时无法恢复：任务可能仍在执行、没有可恢复的文字指令或状态已变化。请先检查任务状态。','error',9000,'',{secondary:[{id:'inspect-task',label:'检查任务状态'},{id:'open',label:'打开主窗口'}]}) }
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
        else { updateQuestion(); if(inputDraft)renderInputDraft();else hide(); animation() }
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
  function renderInputDraft() {
    if (!inputDraft || stopped || requests.length || manager || recovery) return
    cancelTimer()
    show({visible:true,kind:'action',requestId:`voice:${inputDraft.id}`,title:'我听到（尚未发送）',text:inputDraft.text,busy:inputDraftBusy,clickThrough:false,
      hint:'这句尚未发送，可能是环境声或不完整的识别。确认才会发送；可说“确认发送”或“取消输入”。',
      input:inputDraft.edit ? {value:inputDraft.text,placeholder:'纠正识别内容',submitLabel:'确认发送'} : null,
      secondary:[...(!inputDraft.edit ? [{id:'voice-confirm',label:'确认发送'},{id:'voice-edit',label:'修改'}] : []),{id:'voice-discard',label:'丢弃输入'}]})
  }
  function clearInputDraft() { inputDraft = null; inputDraftBusy = false; clearTimer(inputDraftTimer); inputDraftTimer = undefined }
  function renderQueue(hint='') {
    if(!queueView||requests.length||stopped)return
    cancelTimer()
    const item=queued.entries.find(entry=>entry.id===queueView.id)
    show({visible:true,kind:'action',requestId:`queue:${queued.revision}`,title:`等待输入 · ${queued.entries.length}`,text:item?item.text:queued.entries.length?'这些内容尚未交给 Agent，可修改、删除或确认继续排队。':'没有等待的输入。',hint:hint||(item?.needsConfirmation?'这条输入需要重新确认，不会自动执行。':''),clickThrough:false,
      choices:item?[]:queued.entries.map(entry=>({id:entry.id,label:entry.text,description:`第 ${entry.position} 位 · 已等 ${entry.waitedSeconds} 秒${entry.needsConfirmation?' · 待确认':''}`})),
      input:item&&queueView.edit?{value:item.text,placeholder:'修改等待输入',submitLabel:'保存并确认'}:null,
      secondary:item?[...(!queueView.edit?[{id:'queue-confirm',label:'确认继续排队'},{id:'queue-edit',label:'修改'}]:[]),{id:'queue-delete',label:'删除这条'},{id:'queue-back',label:'返回'}]:[{id:'queue-close',label:'关闭'}]})
  }
  async function manageQueue() { if(requests.length){render('请先处理当前请求。');return};manager=null;recovery=null;queueView={id:'',edit:false};renderQueue();await send('voice-queue',{action:'snapshot'}) }
  return {
    notice,
    managePolicies,
    recoverTask,
    manageQueue,
    async voiceAnswer(value) {
      if(stopped||!questionView||busy||!value||typeof value.answerId!=='string'||consumedAnswers.has(value.answerId))return false
      const view=value.view
      if(!view||['requestId','sessionId','questionId','index','revision'].some(k=>view[k]!==questionView[k]))return false
      consumedAnswers.add(value.answerId);if(consumedAnswers.size>128)consumedAnswers.delete(consumedAnswers.values().next().value)
      const question=requests[0].questions[questionIndex], action=questionVoiceAction(value.text,question)
      if(!action||action.id==='submit'&&!question.multiSelect||action.id==='skip'&&question.multiSelect){render('没有识别到唯一选项。请说“第几个选项”、选项原文，或“其他回答…”；也可点击。');return false}
      await this.action({...action,requestId:questionView.requestId})
      return true
    },
    queue(value) {
      if(stopped||!value||!Array.isArray(value.entries)||!Number.isInteger(value.revision))return
      queued={revision:value.revision,entries:value.entries.slice(0,20)}
      if(queueView?.id&&!queued.entries.some(entry=>entry.id===queueView.id))queueView={id:'',edit:false}
      renderQueue(value.error||'')
    },
    capture(status) {
      if (stopped) return
      if (status.kind === 'input-confirmation') {
        clearInputDraft(); clearTimer(captureTimer); captureId = ''
        inputDraft = {id:status.draftId,text:status.text,captureId:status.captureId,edit:false}
        const own = inputDraft
        inputDraftTimer = setTimer(()=>{if(inputDraft===own){clearInputDraft();if(!requests.length)hide()}},Math.min(30000,Math.max(1,status.ttlMs||30000)))
        renderInputDraft();return
      }
      if (status.kind === 'input-confirmation-ended') { if(inputDraft?.id===status.draftId){clearInputDraft();if(!requests.length)hide()};return }
      if (status.kind === 'capture-end' && inputDraft?.captureId === status.captureId) { clearInputDraft() }
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
      if (changedOwner) clearInputDraft()
      if (changedOwner || snapshot.requests?.length) queueView=null
      identity = nextIdentity
      const previous = requests[0]?.id, previousCount = requests.length
      requests = snapshot.requests || []
      if (changedOwner || requests.length) { manager = null; managerEpoch++; recovery = null; recoveryEpoch++ }
      if (changedOwner || previous !== requests[0]?.id) {
        resetDraft(); cancelTimer()
        if (changedOwner) { working = false; text = ''; voice = 'idle' }
        if (requests.length) render()
        else { updateQuestion(); if(inputDraft)renderInputDraft();else hide(); animation() }
      } else if (requests.length && previousCount !== requests.length) render()
      const before=questionSignature;updateQuestion();if(requests.length&&before!==questionSignature)render()
    },
    event(event) {
      if (stopped) return
      if (event.type === 'turn.started' || event.type === 'turn.accepted') { recovery = null; recoveryEpoch++; busy = false; text = ''; if (!working) startedAt = Date.now(); working = true; inputSource = event.data?.inputSource || (event.type === 'turn.accepted' ? 'desktop' : inputSource); captureId = ''; clearTimer(captureTimer); animation() }
      if (event.type === 'assistant.delta') { text += event.data?.text || ''; notice(text, 'speech', 6500) }
      if (event.type === 'assistant.message' && event.data?.text) notice(event.data.text, 'speech', 6500)
      if (event.type === 'tool.call') { const payload = activityBubblePayload(event); if (payload) notice(payload.text, 'activity') }
      if (event.type === 'turn.ended') {
        working = false
        const failed = ['failed','error','interrupted','blocked','max-tokens'].includes(event.data?.reason?.kind)
        animation({ id: `turn:${event.ioSeq}`, name: failed ? 'failed' : 'jumping' })
        if (failed) notice('上次任务未完成。先检查结果，再决定是否恢复。','error',0,'',{secondary:[{id:'recover-task',label:'恢复上次任务…'},{id:'inspect-task',label:'检查任务状态'},{id:'open',label:'打开主窗口'}]})
        else if (!requests.length && !manager && !recovery) {
          cancelTimer()
          // Keep the reply visible while TTS is still playing; the Worker starts audio
          // after the text turn ends. A fallback hides text-only replies.
          timer = setTimer(hide, speechVisible ? 12000 : 1800)
        }
      }
      if (event.type === 'error') {
        working = false
        animation({ id: `error:${event.ioSeq}`, name: 'failed' })
        notice(humanizeFailure(event.data?.message), 'error', 9000, '', { secondary: [{ id: 'recover-task', label: '恢复上次任务…' }, { id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
      }
    },
    syncTaskState(state) {if(stopped)return;working=state?.status==='running';if(working&&!startedAt)startedAt=Date.now();animation()},
    voice(state) {
      voice = state
      animation()
      if (state === 'speaking') { voiceWasSpeaking = true; cancelTimer() }
      else if (voiceWasSpeaking && (state === 'idle' || state === 'listening') && speechVisible
        && !working && !requests.length && !inputDraft && !manager && !recovery && !queueView) {
        voiceWasSpeaking = false
        cancelTimer()
        timer = setTimer(hide, 1200)
      }
    },
    state: () => ({ working, startedAt, inputSource, waiting: requests.length > 0, queued:queued.entries.length }),
    async action(action) {
      if (stopped) return
      if(queueView&&!requests.length&&action.requestId===`queue:${queued.revision}`){
        if(action.type==='choice'){queueView={id:action.id,edit:false};renderQueue();return}
        if(action.type==='secondary'&&action.id==='queue-close'){queueView=null;if(inputDraft)renderInputDraft();else hide();return}
        if(action.type==='secondary'&&action.id==='queue-back'){queueView={id:'',edit:false};renderQueue();return}
        if(action.type==='secondary'&&action.id==='queue-edit'){queueView.edit=true;renderQueue();return}
        const operation=action.type==='input'?'edit':action.id==='queue-delete'?'delete':action.id==='queue-confirm'?'confirm':null
        if(operation){const item=queued.entries.find(entry=>entry.id===queueView.id);if(item)await send('voice-queue',{action:operation,id:item.id,revision:queued.revision,...(operation==='edit'?{text:action.value}:{})})}
        return
      }
      if (inputDraft && !requests.length && action.requestId === `voice:${inputDraft.id}` && !inputDraftBusy) {
        if(action.type==='secondary'&&action.id==='voice-edit'){inputDraft.edit=true;renderInputDraft();return}
        if(action.type==='secondary'&&action.id==='voice-discard'){const id=inputDraft.id;clearInputDraft();hide();await send('voice-input',{action:'discard-input',id});return}
        if(action.type==='input'||action.type==='secondary'&&action.id==='voice-confirm'){
          const text=action.type==='input'?String(action.value||'').trim():inputDraft.text
          if(!text||text.length>20000)return
          inputDraftBusy=true;renderInputDraft()
          try { await send('voice-input',{action:'confirm-input',id:inputDraft.id,text}) }
          catch { inputDraftBusy=false;renderInputDraft() }
          return
        }
        return
      }
      if (action.type === 'open') return send('open')
      if (action.type === 'secondary' && action.id === 'open') return send('open')
      if (action.type === 'secondary' && action.id === 'inspect-task') return send('inspect-task')
      if (action.type === 'secondary' && action.id === 'recover-task') return recoverTask()
      if (recovery && !requests.length && action.requestId === `recovery:${recovery.token}` && !busy) {
        if (action.type === 'choice' && ['continue','retry'].includes(action.id)) { recovery.mode = action.id; renderRecovery(); return }
        if (action.type !== 'secondary') return
        if (action.id === 'recovery-close') { recovery = null; recoveryEpoch++; hide(); return }
        if (action.id === 'recovery-back') { recovery.mode = null; renderRecovery(); return }
        if (action.id !== 'recovery-confirm' || !recovery.mode) return
        const own = recovery; busy = true; renderRecovery('正在提交…')
        try {
          await send('/task/recovery',{token:own.token,mode:own.mode,confirmSideEffects:true})
          if (recovery === own) { recovery = null; busy = false; hide() }
        } catch { if (recovery === own) { recovery = null; busy = false; notice('状态已变化或提交失败。请重新检查任务，不会自动重复执行。','error',9000,'',{secondary:[{id:'inspect-task',label:'检查任务状态'}]}) } }
        return
      }
      if (manager && !requests.length && action.requestId === manager.id && !busy) {
        if (action.type === 'secondary' && action.id === 'grant-close') { manager = null; managerEpoch++; hide(); return }
        const rule = manager.rules.find(item => item.id === action.id)
        if (action.type !== 'choice' || !rule) return
        const own = manager; busy = true; renderManager('正在撤销…')
        try {
          await send(`/policies?id=${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
          if (manager === own) { manager.rules = manager.rules.filter(item => item.id !== rule.id); busy = false; renderManager('已撤销。') }
        } catch { if (manager === own) { busy = false; renderManager('撤销失败，请重试。') } }
        return
      }
      const request = requests[0]
      if (!request || busy || action.requestId !== request.id) return
      if (request.kind === 'approval' && action.type === 'secondary') {
        if (action.id === 'grant-confirm' && request.operation) persistentDraft = true
        else if (action.id === 'grant-back') persistentDraft = false
        else return
        render(); return
      }
      if (action.type === 'approval' && request.kind === 'approval') return submit(request, { decision: action.decision === 'allow' && persistentDraft ? 'always-allow' : action.decision, ...(action.decision === 'allow' && persistentDraft ? { confirmExact: true } : {}) })
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
    stop() { stopped = true; clearInputDraft(); manager = null; managerEpoch++; recovery = null; recoveryEpoch++; cancelTimer(); clearTimer(captureTimer); requests = []; updateQuestion(); hide() },
  }
}
