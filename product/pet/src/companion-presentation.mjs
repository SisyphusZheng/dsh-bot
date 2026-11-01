/** Desktop presentation: a pure projection of the Host Snapshot + versioned events.
 *
 *  Authority boundary (beta2 plan §8.2, kernel spec §2.1/§3.7):
 *  - The Host owns pending interactions, drafts, question progress, input drafts, the
 *    queue, execution/turn state and notices. This module reads them from
 *    `applySnapshot(snapshot)` and versioned `applyEvent(event)` deltas; it never
 *    creates a second authoritative copy.
 *  - UI-local state is limited to unsubmitted form text (queue edit / input-draft
 *    edit / custom answer), the question currently being viewed, transient desktop
 *    diagnostics and scroll/focus (kept by the bubble renderer).
 *  - UX timers are bound to a display owner (notice id, turn id, capture id): an
 *    expired callback only clears its own display and can never hide a newer
 *    approval, question, confirmation draft or reply.
 *  - Business expiry is applied only through snapshot content, never inferred from
 *    a local timer or from DOM presence.
 *
 *  The legacy `sync(legacySnapshot)` / `queue()` / `capture()` / `syncTaskState()`
 *  / `event(legacyEvent)` surface is the migration bridge used while the Host does
 *  not yet expose `/v2/snapshot`. It is selected explicitly by the runtime's v2
 *  probe and is removed before beta2 freeze (Phase 6).
 */

const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multi_edit', 'write_file'])
const READ_TOOLS = new Set(['read', 'list', 'glob', 'grep'])
const SHELL_TOOLS = /terminal|bash|shell|exec/i

const DEFAULT_PRIORITY = ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices']
const UNKNOWN_PRIORITY = new Set(DEFAULT_PRIORITY)
const FAILED_TERMINALS = new Set(['failed', 'error', 'interrupted', 'blocked', 'max-tokens'])
const ACTIVE_CAPTURE_STATES = new Set(['admitting', 'listening', 'transcribing', 'closing'])
const ACTIVE_EXECUTION_STATES = new Set(['submitting', 'working', 'cancel-requested'])
const LEGACY_EVENT_ALIASES = new Set([
  'turn.accepted', 'assistant.delta', 'assistant.message', 'tool.call', 'tool.result', 'agent.status', 'error', 'agent.error',
])

/** Turn an approval request into a Chinese summary plus expandable technical details.
 *  Only the tool name and the Host-provided reason are treated as facts: `read` is
 *  described as reading, `bash` only as running a command, anything else as an
 *  unspecified operation. No risk inference is made from the command text. */
export function approvalView(request) {
  const tool = String(request?.toolName || request?.operation?.toolName || '')
  const reason = String(request?.reason || request?.operation?.reason || '')
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
import { activityBubblePayload, ACTIVITY_RESULT_HOLD_MS } from './activity-bubble.mjs'

const str = (value, max = 4000) => (typeof value === 'string' ? value.slice(0, max) : '')
const intOr = (value, fallback = 0) => (Number.isInteger(value) ? value : fallback)
const objectOr = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null)
const msOf = (value) => {
  if (Number.isFinite(value)) return Number(value)
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

function emptyProjection() {
  return {
    legacy: false,
    hostEpoch: '',
    snapshotSeq: -1,
    identity: { sessionId: null, hostPid: 0, botSessionReady: false, workspace: '' },
    capture: {},
    playback: {},
    execution: {},
    interactions: { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: [],
    presentation: {},
  }
}

function normalizeOption(option, questionId, revision, index) {
  const label = str(option?.label ?? option?.text ?? option, 2000)
  const official = typeof option?.id === 'string' && option.id
    ? option.id
    : typeof option?.optionId === 'string' && option.optionId ? option.optionId : ''
  return {
    id: official || `legacy:${str(questionId, 120)}:${revision}:${index}:${label}`,
    label,
    description: str(option?.description, 1000),
  }
}

function normalizeQuestion(question, revision, index) {
  const id = typeof question?.id === 'string' && question.id ? question.id : String(index)
  return {
    id,
    header: str(question?.header, 300),
    question: str(question?.question, 4000),
    detail: str(question?.detail, 4000),
    multiSelect: question?.multiSelect === true,
    optional: question?.optional === true,
    options: (Array.isArray(question?.options) ? question.options : []).map((option, position) => normalizeOption(option, id, revision, position)),
  }
}

function normalizeInteraction(raw) {
  if (!raw || typeof raw !== 'object') return null
  const kind = raw.kind === 'approval' ? 'approval' : 'question'
  const semanticRevision = intOr(raw.semanticRevision, 1)
  const operation = objectOr(raw.operation)
  const questions = kind === 'question'
    ? (Array.isArray(raw.questions) ? raw.questions : []).map((question, index) => normalizeQuestion(question, semanticRevision, index))
    : null
  if (kind === 'question' && (!questions || questions.length === 0)) return null
  return {
    id: str(raw.id, 200),
    kind,
    sessionId: str(raw.sessionId, 200),
    semanticRevision,
    viewRevision: intOr(raw.viewRevision, 0),
    officialCallId: raw.officialCallId ?? raw.callId ?? null,
    createdAt: str(raw.createdAt, 40),
    expiresAt: raw.expiresAt ?? null,
    operation,
    toolName: str(raw.toolName || operation?.toolName, 200),
    reason: str(raw.reason || operation?.reason, 2000),
    questions,
  }
}

const pendingInteractions = (raw) => (Array.isArray(raw) ? raw : []).map(normalizeInteraction).filter(Boolean)

function normalizeDraft(interaction, raw) {
  if (!raw || typeof raw !== 'object') return null
  const answers = {}
  const rawAnswers = objectOr(raw.answers)
  for (const question of interaction.questions || []) {
    const entry = rawAnswers ? objectOr(rawAnswers[question.id]) : null
    const selected = Array.isArray(entry?.selected) ? entry.selected.filter((item) => typeof item === 'string') : []
    const custom = typeof entry?.custom === 'string' ? entry.custom : ''
    answers[question.id] = { selected, ...(custom ? { custom } : {}) }
  }
  const questions = interaction.questions || []
  if (questions.length === 1 && !rawAnswers) {
    const question = questions[0]
    const selected = Array.isArray(raw.selectedOptionIds) ? raw.selectedOptionIds.filter((item) => typeof item === 'string') : []
    const custom = typeof raw.customText === 'string' ? raw.customText : ''
    answers[question.id] = { selected, ...(custom ? { custom } : {}) }
  }
  return {
    semanticRevision: intOr(raw.semanticRevision, interaction.semanticRevision),
    selectionRevision: intOr(raw.selectionRevision, 0),
    answers,
    updatedAt: str(raw.updatedAt, 40),
  }
}

function normalizeQueueItem(item, revision) {
  return {
    id: str(item?.id, 200),
    text: str(item?.text, 20000),
    position: intOr(item?.position, 0),
    source: str(item?.source, 40),
    createdAt: str(item?.createdAt, 40),
    expiresAt: item?.expiresAt ?? null,
    waitedSeconds: intOr(item?.waitedSeconds, 0),
    needsConfirmation: item?.needsConfirmation === true,
    status: str(item?.status, 40) || (item?.needsConfirmation === true ? 'confirming' : 'waiting'),
    revision: intOr(item?.revision, revision),
  }
}

function normalizeQueue(raw) {
  const value = objectOr(raw) || {}
  const revision = intOr(value.revision, 0)
  const items = (Array.isArray(value.items) ? value.items : []).map((item) => normalizeQueueItem(item, revision)).filter((item) => item.id)
  return { revision, items }
}

function normalizeInputDraft(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id, 200)
  if (!id) return null
  return {
    id,
    text: str(raw.text, 20000),
    source: str(raw.source, 40) || 'voice',
    captureId: raw.captureId ? str(raw.captureId, 200) : null,
    createdAt: str(raw.createdAt, 40),
    expiresAt: raw.expiresAt ?? null,
    revision: intOr(raw.revision, 0),
    status: str(raw.status, 40) || 'pending',
    needsConfirmation: raw.needsConfirmation !== false,
  }
}

function normalizeNotice(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = str(raw.id, 200)
  if (!id) return null
  return {
    id,
    kind: str(raw.kind, 40) || 'status',
    severity: str(raw.severity, 40) || 'info',
    text: str(raw.text, 2000),
    createdAt: str(raw.createdAt, 40),
    expiresAt: raw.expiresAt ?? null,
    diagnosticId: raw.diagnosticId ? str(raw.diagnosticId, 200) : null,
    actions: Array.isArray(raw.actions)
      ? raw.actions.filter((action) => action && typeof action.id === 'string').map((action) => ({ id: action.id, label: str(action.label, 80) }))
      : [],
  }
}

/** Normalize a Host `/v2/snapshot` body (schema snapshot@1) into the projection shape. */
export function normalizeSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null
  const hostEpoch = str(raw.hostEpoch, 200)
  if (!hostEpoch) return null
  const schema = str(raw.schema, 40)
  if (schema !== 'snapshot@1' && !(raw.snapshotSeq !== undefined && raw.interactions && typeof raw.interactions === 'object')) return null
  const identity = objectOr(raw.identity) || {}
  const interactions = objectOr(raw.interactions) || {}
  const pending = pendingInteractions(interactions.pending).filter((interaction) => interaction.id)
  const activeIds = new Set(pending.map((interaction) => interaction.id))
  const drafts = {}
  const rawDrafts = objectOr(interactions.drafts) || {}
  for (const interaction of pending) {
    if (interaction.kind !== 'question' || !rawDrafts[interaction.id]) continue
    const draft = normalizeDraft(interaction, rawDrafts[interaction.id])
    if (draft) drafts[interaction.id] = draft
  }
  const notices = (Array.isArray(raw.notices) ? raw.notices : []).map(normalizeNotice).filter((notice) => notice && notice.id)
  const presentation = objectOr(raw.presentation) || {}
  const priority = Array.isArray(presentation.priority)
    ? presentation.priority.filter((item) => UNKNOWN_PRIORITY.has(item))
    : DEFAULT_PRIORITY
  return {
    legacy: false,
    hostEpoch,
    snapshotSeq: intOr(raw.snapshotSeq, 0),
    identity: {
      sessionId: identity.sessionId ?? null,
      hostPid: intOr(identity.hostPid, 0),
      botSessionReady: identity.botSessionReady === true,
      workspace: str(identity.workspace, 4000),
    },
    capture: objectOr(raw.capture) || {},
    playback: objectOr(raw.playback) || {},
    execution: objectOr(raw.execution) || {},
    interactions: {
      focusedId: interactions.focusedId ?? null,
      pending,
      drafts,
      activeIds,
      recentlyResolved: Array.isArray(interactions.recentlyResolved) ? interactions.recentlyResolved.slice(-8) : [],
    },
    inputDraft: normalizeInputDraft(raw.inputDraft),
    queue: normalizeQueue(raw.queue),
    notices,
    presentation: {
      displayMode: str(presentation.displayMode, 40),
      priority: priority.length ? priority : DEFAULT_PRIORITY,
      bubble: objectOr(presentation.bubble) || { visible: false, requestId: null, kind: null },
      bubblePolicy: objectOr(presentation.bubblePolicy) || { placement: 'above', anchorGapPx: 24 },
    },
  }
}

/** Small helpers used by the legacy migration bridge and by tests. */
export function legacyRequestShape(requests) {
  return Array.isArray(requests) ? requests : []
}

export function createCompanionPresentation({
  show,
  hide,
  animate,
  send,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  publishQuestion = () => {},
  now = () => Date.now(),
}) {
  if (typeof show !== 'function' || typeof hide !== 'function' || typeof animate !== 'function' || typeof send !== 'function')
    throw new Error('companion presentation requires show/hide/animate/send')

  // ---------------- authoritative projection ----------------
  let mode = 'unknown' // 'v2' | 'legacy'
  let projection = emptyProjection()
  let lastEventSeq = -1
  let stopped = false
  /** Host epochs already observed: a replay from an old epoch must never roll the projection back. */
  const knownEpochs = new Set()

  // Legacy migration bridge only: populated by the old REST surface until /v2/snapshot exists.
  const legacy = {
    pid: 0,
    sessionId: '',
    requests: [],
    queue: { revision: 0, items: [] },
    inputDraft: null,
    execution: null,
    drafts: {},
    seq: 0,
    working: false,
    startedAt: 0,
    inputSource: 'desktop',
  }
  let captureId = ''
  let captureIdentity = ''
  let captureTimer
  let legacyDraftTimer
  const expiredInputs = new Set()

  function clearInputDraft() {
    if (legacyDraftTimer !== undefined) { clearTimer(legacyDraftTimer); legacyDraftTimer = undefined }
    legacy.inputDraft = null
    inputDraftEdit = false
    inputDraftConflict = ''
    inputDraftSeenRevision = -1
  }

  // ---------------- UI-local presentation state ----------------
  let reply = { text: '', streaming: false, turnId: '', endedAt: 0, failed: false }
  let voiceState = 'idle'
  let voiceWasSpeaking = false
  let displayTone = '' // 'speech' | 'input' | 'activity' | 'action' | ... of the displayed payload
  let visible = false
  let lastPayloadKey = ''
  let display = { kind: '', requestId: '' }
  let lastShownNoticeId = ''
  const dismissedNoticeIds = new Set()
  let localNotice = null
  let localNoticeSeq = 0
  let questionView = null
  let questionKey = ''
  let questionRevision = 0
  let questionState = { interactionId: '', semanticRevision: null, index: 0, customInput: false, conflict: '' }
  let inputSeed = { key: '', value: '' }
  let draftOverlay = null
  let overlay = null // {kind:'queue'|'grants'|'recovery', ...}
  let manager = null
  let managerEpoch = 0
  let recovery = null
  let recoveryEpoch = 0
  let busy = null
  let persistentDraft = false
  let inputDraftEdit = false
  let inputDraftSeenRevision = -1
  let inputDraftConflict = ''
  let uxTimer = { id: null, owner: null }
  const consumedAnswers = new Set()

  // ---------------- small utilities ----------------

  const cancelUxTimer = () => {
    if (uxTimer.id !== null) clearTimer(uxTimer.id)
    uxTimer = { id: null, owner: null }
  }
  /** Schedule the single transient-display timer, bound to its display owner. */
  const scheduleUx = (owner, duration, action) => {
    cancelUxTimer()
    if (!(duration > 0) || stopped) return
    const id = setTimer(() => {
      clearTimer(id)
      if (uxTimer.id !== id || uxTimer.owner !== owner) return
      uxTimer = { id: null, owner: null }
      try { action() } catch { /* a timer must never break presentation */ }
    }, duration)
    uxTimer = { id, owner }
  }
  const working = () => ACTIVE_EXECUTION_STATES.has(String(projection.execution?.state || '')) || reply.streaming || (mode !== 'v2' && legacy.working)
  const focusedInteraction = () => {
    const pending = projection.interactions.pending || []
    if (!pending.length) return null
    return pending.find((item) => item.id === projection.interactions.focusedId) || pending[0]
  }
  const currentQuestion = (interaction) => (interaction && interaction.questions ? interaction.questions[questionState.index] || null : null)
  const optionValue = (option) => (mode === 'legacy' ? option.label : option.id)
  const isBusy = (owner) => Boolean(busy && (owner === undefined || busy.owner === owner))

  function seedInput(key, value) {
    const text = String(value ?? '')
    if (inputSeed.key !== key) { inputSeed = { key, value: text }; return text }
    if (inputSeed.value !== text) { inputSeed = { key, value: text }; return text }
    return undefined
  }
  /** Seed the editor only when it opens; snapshot re-renders must not overwrite typed text. */
  function seedInputOnce(key, value) {
    if (inputSeed.key === key) return undefined
    return seedInput(key, value)
  }

  function draftView(interaction) {
    const base = interaction ? projection.interactions.drafts?.[interaction.id] || null : null
    if (!interaction) return null
    if (mode === 'legacy') {
      if (!base) {
        const draft = {
          semanticRevision: interaction.semanticRevision,
          selectionRevision: 0,
          answers: Object.fromEntries((interaction.questions || []).map((question) => [question.id, { selected: [] }])),
        }
        projection.interactions.drafts = { ...projection.interactions.drafts, [interaction.id]: draft }
        legacy.drafts[interaction.id] = draft
        return draft
      }
      return base
    }
    if (draftOverlay && draftOverlay.interactionId === interaction.id) {
      if (draftOverlay.semanticRevision !== interaction.semanticRevision) { draftOverlay = null; return base }
      if (base && base.selectionRevision >= draftOverlay.selectionRevision) { draftOverlay = null; return base }
      return draftOverlay
    }
    return base
  }

  function answersOf(interaction) {
    return draftView(interaction)?.answers || {}
  }

  function selectedValues(interaction, question) {
    const entry = question ? answersOf(interaction)[question.id] : null
    return Array.isArray(entry?.selected) ? entry.selected : []
  }

  function selectedLabels(interaction, question) {
    const values = selectedValues(interaction, question)
    return question.options.filter((option) => values.includes(optionValue(option))).map((option) => option.label)
  }

  function setDraftEntry(interaction, question, entry) {
    const draft = draftView(interaction)
    if (!draft) return
    draft.answers = { ...draft.answers, [question.id]: { ...(draft.answers[question.id] || { selected: [] }), ...entry } }
    if (mode === 'legacy') draft.selectionRevision = intOr(draft.selectionRevision, 0) + 1
  }

  function allAnswered(interaction, answers) {
    const map = answers || answersOf(interaction)
    return (interaction.questions || []).every((question) => {
      const entry = map[question.id]
      if (!entry) return false
      const selected = Array.isArray(entry.selected) ? entry.selected : []
      const custom = typeof entry.custom === 'string' ? entry.custom.trim() : ''
      return selected.length > 0 || custom !== ''
    })
  }

  function nextUnanswered(interaction, from = 0) {
    const answers = answersOf(interaction)
    const questions = interaction.questions || []
    for (let index = from; index < questions.length; index += 1) {
      const question = questions[index]
      const entry = answers[question.id]
      if (!entry) return index
      const answered = (Array.isArray(entry.selected) && entry.selected.length > 0) || (typeof entry.custom === 'string' && entry.custom.trim() !== '')
      if (!answered) return index
    }
    return Math.max(0, questions.length - 1)
  }

  // ---------------- rendering surface ----------------

  function publish(payload) {
    if (stopped || !payload) return
    const key = JSON.stringify(payload)
    if (visible && key === lastPayloadKey) return
    visible = true
    lastPayloadKey = key
    display = { kind: str(payload.kind, 40), requestId: str(payload.requestId, 200) }
    displayTone = str(payload.kind, 40)
    show(payload)
  }

  function hideSurface() {
    if (!visible) return
    visible = false
    lastPayloadKey = ''
    display = { kind: '', requestId: '' }
    displayTone = ''
    hide()
  }

  function animation(cue = null) {
    if (stopped) return
    const interaction = focusedInteraction()
    animate({
      state: interaction ? 'awaiting-input' : voiceState !== 'idle' ? voiceState : working() ? 'working' : 'idle',
      baseWorking: working(),
      cue,
    })
  }

  function postNotice(value, kind = 'status', duration = 4500, capture = '', options = {}) {
    if (stopped) return
    if (focusedInteraction() || projection.inputDraft || manager || recovery || overlay) return
    localNotice = {
      id: ++localNoticeSeq,
      text: str(value, 4000),
      kind: str(kind, 40) || 'status',
      duration,
      capture: str(capture, 200),
      options: objectOr(options) || {},
    }
    render()
  }

  // ---------------- interaction rendering ----------------

  function updateQuestion() {
    if (stopped) return
    const interaction = focusedInteraction()
    let view = null
    if (interaction && interaction.kind === 'question') {
      const question = currentQuestion(interaction)
      if (question) {
        view = {
          requestId: interaction.id,
          sessionId: interaction.sessionId,
          questionId: question.id,
          index: questionState.index,
          question: question.question,
          options: question.options.map((option) => ({ label: option.label, description: option.description })),
          multiSelect: question.multiSelect === true,
          selected: selectedLabels(interaction, question),
          busy: Boolean(busy),
          semanticRevision: interaction.semanticRevision,
          ...(questionState.conflict ? { conflict: questionState.conflict } : {}),
        }
      }
    }
    if (!view && !questionView) {
      // Nothing to clear: do not emit a null question view before one was ever published.
      questionKey = JSON.stringify(view)
      return
    }
    const signature = JSON.stringify(view)
    if (signature === questionKey) return
    questionKey = signature
    questionView = view ? { ...view, revision: ++questionRevision } : null
    publishQuestion(questionView)
  }

  function pendingCount() {
    return (projection.interactions.pending || []).length
  }

  function renderInteraction(interaction, hint = '') {
    if (!interaction) return
    cancelUxTimer()
    animation()
    const count = pendingCount()
    const suffix = count > 1 ? ` · 还有 ${count - 1} 项` : ''
    const base = { visible: true, kind: 'action', requestId: interaction.id, busy: Boolean(busy), clickThrough: false, hint }
    if (interaction.kind === 'approval') {
      const approval = approvalView(interaction)
      publish({
        ...base,
        title: `需要批准${suffix}`,
        text: persistentDraft ? '持续允许完全相同的操作？更换命令、参数或工作目录仍会重新询问。' : approval.text,
        details: approval.details,
        approval: { id: interaction.id, allowLabel: persistentDraft ? '确认持续允许' : '允许一次' },
        secondary: interaction.operation ? [{ id: persistentDraft ? 'grant-back' : 'grant-confirm', label: persistentDraft ? '返回' : '始终允许此操作…' }] : [],
      })
      return
    }
    const question = currentQuestion(interaction)
    if (!question) return
    const multiQuestion = (interaction.questions || []).length > 1
    const needsSubmit = question.multiSelect === true
    const showInput = questionState.customInput || !question.options.length
    const draftEntry = answersOf(interaction)[question.id] || {}
    const savedCustom = typeof draftEntry.custom === 'string' ? draftEntry.custom : ''
    const seed = showInput ? seedInputOnce(`custom:${interaction.id}:${question.id}`, savedCustom) : undefined
    publish({
      ...base,
      hint: hint || questionState.conflict,
      title: question.header || `请你选择${suffix}`,
      text: [question.question, question.detail].filter(Boolean).join('\n\n'),
      progress: multiQuestion ? `${questionState.index + 1} / ${interaction.questions.length}` : '',
      choices: question.options.map((option, index) => ({
        id: String(index),
        label: option.label,
        description: option.description || '',
        selected: selectedLabels(interaction, question).includes(option.label),
      })),
      input: showInput
        ? { placeholder: '输入你的回答', submitLabel: questionState.index + 1 < interaction.questions.length ? '下一项' : '提交', ...(seed !== undefined ? { value: seed } : {}) }
        : null,
      secondary: [
        ...(needsSubmit && !showInput ? [{ id: 'submit', label: '提交' }] : []),
        ...(question.options.length && !questionState.customInput ? [{ id: 'other', label: '其他回答' }] : []),
        ...(questionState.index ? [{ id: 'back', label: '上一项' }] : []),
        ...(needsSubmit ? [] : [{ id: 'skip', label: '跳过' }]),
      ],
    })
    if (showInput && !questionState.customInput) questionState.customInput = true
  }

  // ---------------- input draft rendering ----------------

  function renderInputDraft(draft, hint = '') {
    if (!draft) return
    cancelUxTimer()
    animation()
    const seed = inputDraftEdit ? seedInputOnce(`input:${draft.id}`, draft.text) : undefined
    publish({
      visible: true,
      kind: 'action',
      requestId: `voice:${draft.id}`,
      title: '我听到（尚未发送）',
      text: draft.text,
      busy: isBusy(`voice:${draft.id}`),
      clickThrough: false,
      hint: hint || inputDraftConflict || '这句尚未发送，可能是环境声或不完整的识别。确认才会发送；可说“确认发送”或“取消输入”。',
      input: inputDraftEdit ? { placeholder: '纠正识别内容', submitLabel: '确认发送', ...(seed !== undefined ? { value: seed } : {}) } : null,
      secondary: [
        ...(!inputDraftEdit ? [{ id: 'voice-confirm', label: '确认发送' }, { id: 'voice-edit', label: '修改' }] : []),
        { id: 'voice-discard', label: '丢弃输入' },
      ],
    })
  }

  // ---------------- legacy overlays: grants / recovery / queue ----------------

  function renderManager(hint = '') {
    if (!manager || stopped || focusedInteraction() || projection.inputDraft || overlay) return
    cancelUxTimer()
    const rules = manager.rules
    publish({
      visible: true,
      kind: 'action',
      requestId: manager.id,
      title: '持续授权',
      text: hint || (rules.length ? '每项仅匹配完全相同的工具、参数和工作目录。点击可撤销。' : '没有持续授权。'),
      choices: rules.map((rule) => ({ id: rule.id, label: `撤销 ${rule.toolName}`, description: `${rule.createdAt} · ${String(rule.key || '').slice(0, 12)}` })),
      secondary: [{ id: 'grant-close', label: '关闭' }],
      busy: Boolean(busy),
      clickThrough: false,
    })
  }

  function renderRecovery(hint = '') {
    if (!recovery || stopped || focusedInteraction() || overlay) return
    cancelUxTimer()
    const recoveryMode = recovery.mode
    publish({
      visible: true,
      kind: 'action',
      requestId: `recovery:${recovery.token}`,
      title: recoveryMode ? '确认恢复任务' : '恢复上次任务',
      busy: Boolean(busy),
      clickThrough: false,
      text: recoveryMode === 'retry'
        ? '重新提交会开启新一轮任务，可能重复已经执行过的操作。确认结果和副作用后再执行。'
        : recoveryMode === 'continue'
          ? '将请 Nisse 先核对已完成内容和副作用，只继续未完成部分；无法确认时先询问你。'
          : recovery.warning,
      details: [`原指令：${recovery.originalText}`],
      hint,
      choices: recoveryMode
        ? []
        : [{ id: 'continue', label: '检查后继续', description: '先核对结果，只处理未完成部分。' }, { id: 'retry', label: '重新提交原指令', description: '可能重复执行；下一步仍需确认。' }],
      secondary: [
        ...(recoveryMode
          ? [{ id: 'recovery-confirm', label: recoveryMode === 'continue' ? '确认检查后继续' : '确认重新提交' }, { id: 'recovery-back', label: '返回' }]
          : []),
        { id: 'recovery-close', label: '暂不恢复' },
      ],
    })
  }

  function renderQueue(hint = '') {
    if (!overlay || overlay.kind !== 'queue' || stopped || focusedInteraction() || projection.inputDraft) return
    cancelUxTimer()
    const queue = projection.queue
    const items = queue.items
    let selected = overlay.id ? items.find((item) => item.id === overlay.id) : null
    if (overlay.id && !selected) { overlay = { kind: 'queue', id: '', edit: false }; selected = null }
    const seed = selected && overlay.edit ? seedInputOnce(`queue:${selected.id}`, selected.text) : undefined
    publish({
      visible: true,
      kind: 'action',
      requestId: `queue:${queue.revision}`,
      title: `等待输入 · ${items.length}`,
      text: selected
        ? selected.text
        : items.length
          ? '这些内容尚未交给 Agent，可修改、删除或确认继续排队。'
          : '没有等待的输入。',
      hint: hint || (selected?.needsConfirmation ? '这条输入需要重新确认，不会自动执行。' : ''),
      busy: Boolean(busy) && String(busy.owner || '').startsWith('queue:'),
      clickThrough: false,
      choices: selected
        ? []
        : items.map((item) => ({
          id: item.id,
          label: item.text,
          description: `第 ${item.position} 位 · 已等 ${item.waitedSeconds} 秒${item.needsConfirmation ? ' · 待确认' : ''}${item.status === 'expired' ? ' · 已过期' : ''}`,
        })),
      input: selected && overlay.edit ? { placeholder: '修改等待输入', submitLabel: '保存并确认', ...(seed !== undefined ? { value: seed } : {}) } : null,
      secondary: selected
        ? [
          ...(!overlay.edit ? [{ id: 'queue-confirm', label: '确认继续排队' }, { id: 'queue-edit', label: '修改' }] : []),
          { id: 'queue-delete', label: '删除这条' },
          { id: 'queue-back', label: '返回' },
        ]
        : [{ id: 'queue-close', label: '关闭' }],
    })
  }

  function renderOverlay(hint = '') {
    if (!overlay) return
    if (overlay.kind === 'queue') renderQueue(hint)
    else if (overlay.kind === 'grants') renderManager(hint)
    else if (overlay.kind === 'recovery') renderRecovery(hint)
  }

  // ---------------- transient / reply rendering ----------------

  function activeCapture() {
    if (mode === 'legacy') return null
    // A failed voice transport leaves the last snapshot stale; a recording
    // bubble must not shadow the failure notice that explains what happened.
    if (voiceState === 'failed') return null
    const capture = projection.capture || {}
    if (!ACTIVE_CAPTURE_STATES.has(String(capture.state || ''))) return null
    if (!capture.captureId) return null
    return capture
  }

  function renderCapture() {
    const capture = activeCapture()
    if (!capture) return false
    cancelUxTimer()
    animation()
    const preview = objectOr(capture.preview)
    const text = str(preview?.text, 400) || (capture.state === 'transcribing' ? '正在识别…' : capture.state === 'closing' ? '正在收尾…' : '正在听…')
    publish({
      visible: true,
      kind: 'input',
      requestId: str(capture.captureId, 200),
      title: capture.state === 'transcribing' ? '我听到（识别中）' : '我听到',
      text,
      clickThrough: false,
      hint: capture.state === 'admitting' ? '正在准备麦克风…' : '',
      cancel: { id: 'cancel-capture', label: '取消录音' },
    })
    return true
  }

  function renderLocalNotice() {
    const notice = localNotice
    cancelUxTimer()
    const secondary = Array.isArray(notice.options.secondary) ? notice.options.secondary : []
    const payload = {
      visible: true,
      kind: notice.kind,
      text: notice.text,
      clickThrough: !['input', 'speech'].includes(notice.kind) && !secondary.length,
      ...(notice.options.hint ? { hint: notice.options.hint } : {}),
      ...(secondary.length ? { secondary } : {}),
      ...(notice.kind === 'input' ? { title: '我听到（识别中）' } : {}),
      ...(notice.capture ? { cancel: { id: 'cancel-capture', label: '取消录音' }, requestId: notice.capture } : {}),
    }
    if (notice.kind === 'error' && notice.options.secondary) Object.assign(payload, { secondary })
    displayTone = notice.kind
    publish(payload)
    if (notice.duration > 0) {
      const own = notice.id
      scheduleUx(`local:${own}`, notice.duration, () => {
        if (localNotice?.id !== own) return
        localNotice = null
        render()
      })
    }
  }

  function renderReply(hint = '') {
    if (!reply.text) return false
    cancelUxTimer()
    animation()
    displayTone = 'speech'
    publish({ visible: true, kind: 'speech', text: reply.text, clickThrough: false, hint })
    if (!reply.streaming && reply.text) {
      const own = `reply:${reply.turnId}`
      const duration = voiceState === 'speaking' ? 12000 : 1800
      scheduleUx(own, duration, () => {
        if (reply.streaming || display.kind !== 'speech') return
        reply = { ...reply, text: '' }
        render()
      })
    }
    return true
  }

  function activeNotice() {
    if (mode === 'legacy') return null
    const current = now()
    const notices = projection.notices || []
    for (let index = notices.length - 1; index >= 0; index -= 1) {
      const notice = notices[index]
      if (notice.kind === 'input') continue
      if (dismissedNoticeIds.has(notice.id)) continue
      const expiry = notice.expiresAt ? msOf(notice.expiresAt) : 0
      if (expiry && expiry <= current) continue
      return notice
    }
    return null
  }

  function mapNoticeAction(action) {
    const id = str(action?.id, 80)
    if (id === 'open-main') return { id: 'open', label: str(action.label, 80) || '打开主窗口' }
    if (id === 'open' || id === 'inspect-task' || id === 'recover-task') return { id, label: str(action.label, 80) || id }
    if ((id === 'confirm-input' || id === 'cancel-input') && projection.inputDraft) return { id, label: str(action.label, 80) || (id === 'confirm-input' ? '发送' : '取消') }
    return null
  }

  function renderSnapshotNotice(notice) {
    cancelUxTimer()
    animation()
    const secondary = (notice.actions || []).map(mapNoticeAction).filter(Boolean)
    const kind = notice.kind === 'speech' ? 'speech' : notice.severity === 'error' || notice.kind === 'error' ? 'error' : 'status'
    lastShownNoticeId = notice.id
    displayTone = kind
    publish({
      visible: true,
      kind,
      text: notice.text,
      clickThrough: secondary.length ? false : kind !== 'speech',
      ...(secondary.length ? { secondary } : {}),
      hint: notice.diagnosticId ? `诊断 ${notice.diagnosticId}` : '',
    })
    const expiry = notice.expiresAt ? msOf(notice.expiresAt) - now() : 0
    const duration = expiry > 0 ? Math.min(expiry, 60_000) : 4500
    scheduleUx(`notice:${notice.id}`, duration, () => {
      if (lastShownNoticeId !== notice.id) return
      lastShownNoticeId = ''
      dismissedNoticeIds.add(notice.id)
      if (dismissedNoticeIds.size > 64) dismissedNoticeIds.delete(dismissedNoticeIds.values().next().value)
      render()
    })
  }

  // ---------------- render pipeline ----------------

  function render(hint = '') {
    if (stopped) return
    cancelUxTimer()
    updateQuestion()
    const interaction = focusedInteraction()
    if (interaction) return renderInteraction(interaction, hint)
    if (projection.inputDraft) return renderInputDraft(projection.inputDraft, hint)
    if (overlay) return renderOverlay(hint)
    if (manager) return renderManager(hint)
    if (recovery) return renderRecovery(hint)
    if (renderCapture()) return
    if (localNotice) return renderLocalNotice()
    if (reply.text) return renderReply(hint)
    const notice = activeNotice()
    if (notice) return renderSnapshotNotice(notice)
    animation()
    hideSurface()
    displayTone = ''
  }

  // ---------------- projection reconciliation ----------------

  function reconcileQuestionState(previousInteraction) {
    const interaction = focusedInteraction()
    if (!interaction) {
      questionState = { interactionId: '', semanticRevision: null, index: 0, customInput: false, conflict: '' }
      persistentDraft = false
      if (mode === 'v2') draftOverlay = null
      return
    }
    const same = interaction.id === questionState.interactionId
    const sameRevision = same && interaction.semanticRevision === questionState.semanticRevision
    if (!same || !sameRevision) {
      const semanticChange = same && !sameRevision
      const conflict = semanticChange
        ? '问题已更新，请重新检查后再选择或填写；你正在编辑的内容仍然保留。'
        : ''
      const index = semanticChange
        ? Math.min(questionState.index, Math.max(0, (interaction.questions || []).length - 1))
        : nextUnanswered(interaction, 0)
      // Keep an open custom-answer editor across a semantic change: the DOM keeps the
      // typed text because the same request id/input owner is rendered without a value.
      const keepCustomInput = semanticChange && questionState.customInput
      questionState = { interactionId: interaction.id, semanticRevision: interaction.semanticRevision, index, customInput: keepCustomInput, conflict }
      persistentDraft = false
      if (mode === 'v2' && (!draftOverlay || draftOverlay.interactionId !== interaction.id || draftOverlay.semanticRevision !== interaction.semanticRevision)) draftOverlay = null
    } else {
      const max = Math.max(0, (interaction.questions || []).length - 1)
      if (questionState.index > max) questionState.index = max
      if (questionState.interactionId !== interaction.id) questionState.interactionId = interaction.id
    }
    if (previousInteraction && previousInteraction.id === interaction.id && interaction.kind === 'approval' && questionState.interactionId === interaction.id && previousInteraction.semanticRevision !== interaction.semanticRevision) persistentDraft = false
    // A pending interaction always owns the bubble; close user-opened management panels.
    overlay = null
    manager = null
    managerEpoch += 1
    recovery = null
    recoveryEpoch += 1
  }

  function reconcileInputDraft() {
    const draft = projection.inputDraft
    if (!draft) {
      inputDraftEdit = false
      inputDraftSeenRevision = -1
      inputDraftConflict = ''
      return
    }
    if (inputDraftSeenRevision >= 0 && draft.revision !== inputDraftSeenRevision && inputDraftEdit) {
      inputDraftConflict = 'Host 已更新这条待确认输入；请检查后重新确认。你的修改不会自动覆盖。'
    }
    if (inputDraftEdit) inputDraftSeenRevision = draft.revision
  }

  function install(next) {
    if (stopped || !next) return { applied: false }
    const epochChanged = Boolean(projection.hostEpoch) && next.hostEpoch !== projection.hostEpoch
    const isLegacy = Boolean(next.legacy)
    if (epochChanged && knownEpochs.has(next.hostEpoch)) return { applied: false, staleEpoch: true }
    if (!epochChanged && next.snapshotSeq <= projection.snapshotSeq) return { applied: false, stale: true }
    const previous = projection
    const previousInteraction = focusedInteraction()
    mode = isLegacy ? 'legacy' : 'v2'
    knownEpochs.add(next.hostEpoch)
    projection = next
    if (!isLegacy) lastEventSeq = Math.max(lastEventSeq, next.snapshotSeq)
    if (epochChanged) {
      reply = { text: '', streaming: false, turnId: '', endedAt: 0, failed: false }
      localNotice = null
      lastShownNoticeId = ''
      dismissedNoticeIds.clear()
      overlay = null
      manager = null
      managerEpoch += 1
      recovery = null
      recoveryEpoch += 1
      draftOverlay = null
      questionState = { interactionId: '', semanticRevision: null, index: 0, customInput: false, conflict: '' }
      persistentDraft = false
      inputDraftEdit = false
      inputDraftConflict = ''
      lastEventSeq = isLegacy ? -1 : Number.isInteger(next.snapshotSeq) ? next.snapshotSeq : -1
    }
    reconcileQuestionState(previousInteraction || previous.interactions.pending[0])
    reconcileInputDraft()
    if (projection.inputDraft && !isLegacy) localNotice = null
    render()
    return { applied: true, epochChanged }
  }

  // ---------------- legacy projection bridge ----------------

  function legacyProjection() {
    legacy.seq += 1
    const requests = pendingInteractions(legacy.requests).filter((interaction) => interaction.id)
    const drafts = {}
    for (const interaction of requests) {
      if (interaction.kind === 'question' && legacy.drafts[interaction.id]) drafts[interaction.id] = legacy.drafts[interaction.id]
    }
    return {
      legacy: true,
      hostEpoch: `legacy:${legacy.pid}`,
      snapshotSeq: legacy.seq,
      identity: { sessionId: legacy.sessionId || null, hostPid: legacy.pid, botSessionReady: false, workspace: '' },
      capture: {},
      playback: {},
      execution: legacy.execution || {},
      interactions: { focusedId: requests[0]?.id ?? null, pending: requests, drafts, recentlyResolved: [] },
      inputDraft: legacy.inputDraft,
      queue: legacy.queue,
      notices: [],
      presentation: { displayMode: 'idle', priority: DEFAULT_PRIORITY, bubble: { visible: false } },
    }
  }

  function installLegacy() {
    return install(legacyProjection())
  }

  function currentCaptureDisplayId() {
    if (localNotice?.capture) return localNotice.capture
    if (captureId) return captureId
    if (mode === 'legacy') return ''
    return activeCapture()?.captureId || ''
  }

  // ---------------- legacy events ----------------

  function applyLegacyEvent(event) {
    const type = String(event?.type || '')
    const data = objectOr(event?.data) || {}
    const pending = Boolean(focusedInteraction() || projection.inputDraft)
    if (type === 'turn.started' || type === 'turn.accepted') {
      recovery = null
      recoveryEpoch += 1
      busy = null
      reply = { text: '', streaming: true, turnId: str(event.turnId, 200) || `legacy:${intOr(event.ioSeq, 0)}`, endedAt: 0, failed: false }
      legacy.working = true
      if (!legacy.startedAt) legacy.startedAt = now()
      legacy.inputSource = str(event.data?.inputSource, 20) || (type === 'turn.accepted' ? 'desktop' : legacy.inputSource)
      captureId = ''
      clearTimer(captureTimer)
      animation()
      render()
      return { applied: true }
    }
    if (type === 'assistant.delta') {
      if (pending) return { applied: false }
      reply = { ...reply, streaming: true }
      reply.text += str(data.text, 4000)
      displayTone = 'speech'
      render()
      scheduleUx(`legacy-reply:${reply.turnId}`, 6500, () => {
        if (focusedInteraction() || projection.inputDraft) return
        if (display.kind !== 'speech') return
        reply = { ...reply, text: '' }
        render()
        hideSurface()
      })
      return { applied: true }
    }
    if (type === 'assistant.message') {
      if (pending || !data.text) return { applied: false }
      reply = { ...reply, text: str(data.text, 4000), streaming: false }
      displayTone = 'speech'
      render()
      scheduleUx(`legacy-reply:${reply.turnId}`, 6500, () => {
        if (focusedInteraction() || projection.inputDraft || display.kind !== 'speech') return
        reply = { ...reply, text: '' }
        render()
      })
      return { applied: true }
    }
    if (type === 'tool.call' || type === 'tool.result') {
      const payload = activityBubblePayload({ type: type === 'tool.result' ? 'tool.result' : 'tool.call', data })
      if (!payload) return { applied: false }
      postNotice(payload.text, 'activity', type === 'tool.result' ? Math.max(1200, ACTIVITY_RESULT_HOLD_MS) : 4500)
      return { applied: true }
    }
    if (type === 'turn.ended') {
      legacy.working = false
      reply = { ...reply, streaming: false, turnId: reply.turnId || `legacy:${intOr(event.ioSeq, 0)}` }
      const failed = FAILED_TERMINALS.has(String(data?.reason?.kind || data?.terminal || ''))
      animation({ id: `turn:${intOr(event.ioSeq, 0)}`, name: failed ? 'failed' : 'jumping' })
      if (failed) {
        if (!pending) postNotice('上次任务未完成。先检查结果，再决定是否恢复。', 'error', 0, '', { secondary: [{ id: 'recover-task', label: '恢复上次任务…' }, { id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
      } else if (reply.text) {
        render()
      }
      return { applied: true }
    }
    if (type === 'error' || type === 'agent.error') {
      legacy.working = false
      reply = { ...reply, streaming: false, failed: true }
      animation({ id: `error:${intOr(event.ioSeq, 0)}`, name: 'failed' })
      postNotice(humanizeFailure(data.message), 'error', 9000, '', { secondary: [{ id: 'recover-task', label: '恢复上次任务…' }, { id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
      return { applied: true }
    }
    if (type === 'agent.status') {
      if (String(data.status || '') === 'idle') legacy.working = false
      render()
      return { applied: true }
    }
    return { applied: false }
  }

  // ---------------- versioned v2 events ----------------

  function applyEvent(event) {
    if (stopped || !event || typeof event !== 'object') return { applied: false }
    const type = String(event.type || '')
    if (mode !== 'v2') return applyLegacyEvent(event)
    const epoch = str(event.hostEpoch, 200)
    if (epoch && projection.hostEpoch && epoch !== projection.hostEpoch) return { applied: false, resync: true, reason: 'epoch' }
    const seq = Number.isInteger(event.seq) ? event.seq : null
    if (seq !== null) {
      if (seq <= lastEventSeq) return { applied: false, duplicate: true }
      if (lastEventSeq >= 0 && seq > lastEventSeq + 1) return { applied: false, resync: true, reason: 'gap' }
    }
    if (LEGACY_EVENT_ALIASES.has(type)) {
      const legacyResult = applyLegacyEvent(event)
      if (seq !== null) lastEventSeq = seq
      return legacyResult
    }
    const data = objectOr(event.data) || {}
    let applied = true
    switch (type) {
      case 'turn.started': {
        const pending = Boolean(focusedInteraction() || projection.inputDraft)
        reply = { text: '', streaming: true, turnId: str(event.turnId, 200) || `turn:${intOr(event.turn, 0)}`, endedAt: 0, failed: false }
        if (pending) reply.text = ''
        animation()
        break
      }
      case 'turn.delta': {
        if (focusedInteraction() || projection.inputDraft) { applied = false; break }
        reply = { ...reply, streaming: true, text: reply.text + str(data.text, 4000) }
        break
      }
      case 'turn.ended': {
        reply = { ...reply, streaming: false, turnId: reply.turnId || `turn:${intOr(event.turn, 0)}`, endedAt: now() }
        const failed = FAILED_TERMINALS.has(String(data?.reason?.kind || data?.terminal || ''))
        reply.failed = failed
        animation({ id: `turn:${intOr(event.turn, 0)}`, name: failed ? 'failed' : 'jumping' })
        if (failed) {
          postNotice(humanizeFailure(data?.reason?.error?.message || data?.message || '上次任务未完成。先检查结果，再决定是否恢复。'), 'error', 9000, '', { secondary: [{ id: 'recover-task', label: '恢复上次任务…' }, { id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
        }
        break
      }
      case 'turn.tool': {
        const payload = activityBubblePayload({ type: String(data.phase || '') === 'result' ? 'tool.result' : 'tool.call', data })
        if (!payload) { applied = false; break }
        postNotice(payload.text, 'activity', String(data.phase || '') === 'result' ? Math.max(1200, ACTIVITY_RESULT_HOLD_MS) : 4500)
        break
      }
      case 'error':
      case 'system.warning': {
        animation({ id: `error:${intOr(event.seq, 0)}`, name: 'failed' })
        postNotice(humanizeFailure(data.message), 'error', 9000, '', { secondary: [{ id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
        break
      }
      case 'execution.changed': {
        const execution = { ...projection.execution, ...data }
        projection.execution = execution
        if (!ACTIVE_EXECUTION_STATES.has(String(execution.state || ''))) {
          if (reply.streaming) reply = { ...reply, streaming: false, endedAt: reply.endedAt || now() }
          legacy.working = false
        }
        break
      }
      case 'playback.changed': {
        // Display-only projection: playback never decides business completion.
        projection.playback = { ...projection.playback, ...data }
        if (String(data.state || '') === 'speaking') { voiceWasSpeaking = true; cancelUxTimer() } else if (String(data.state || '') === 'idle' && voiceWasSpeaking) {
          voiceWasSpeaking = false
          if (reply.text && !reply.streaming && !focusedInteraction() && !projection.inputDraft) {
            scheduleUx('playback-idle', 1200, () => { if (!focusedInteraction() && !projection.inputDraft) { reply = { ...reply, text: '' }; render() } })
          }
        }
        break
      }
      case 'capture.changed': {
        projection.capture = { ...projection.capture, ...data }
        break
      }
      case 'queue.changed': {
        const revision = intOr(data.revision, projection.queue.revision)
        if (revision < projection.queue.revision) { applied = false; break }
        projection.queue = normalizeQueue({ revision, items: Array.isArray(data.items) ? data.items : projection.queue.items })
        break
      }
      case 'input-draft.changed': {
        projection.inputDraft = normalizeInputDraft(data.draft)
        if (!projection.inputDraft) { inputDraftEdit = false; inputDraftConflict = ''; inputDraftSeenRevision = -1 }
        reconcileInputDraft()
        break
      }
      case 'notice.added': {
        const notice = normalizeNotice(data.notice)
        if (!notice) { applied = false; break }
        projection.notices = [...projection.notices.filter((item) => item.id !== notice.id), notice].slice(-8)
        break
      }
      case 'notice.expired': {
        const id = str(data.id, 200)
        projection.notices = projection.notices.filter((notice) => notice.id !== id)
        if (lastShownNoticeId === id) lastShownNoticeId = ''
        break
      }
      case 'interaction.draft.changed': {
        const interactionId = str(data.interactionId || data.id, 200)
        const interaction = (projection.interactions.pending || []).find((item) => item.id === interactionId)
        if (!interaction) return { applied: false, resync: true, reason: type }
        const draft = normalizeDraft(interaction, data)
        if (!draft) { applied = false; break }
        projection.interactions.drafts = { ...projection.interactions.drafts, [interactionId]: draft }
        break
      }
      case 'interaction.requested':
      case 'interaction.updated':
      case 'interaction.resolved':
      case 'interaction.expired':
      case 'interaction.unknown':
      case 'interactions.changed':
      case 'host.epoch':
        // Authoritative interaction state lives in the snapshot; fetch a fresh one.
        return { applied: false, resync: true, reason: type }
      case 'command':
        applied = false
        break
      case 'connection.changed':
        break
      default:
        applied = false
    }
    if (seq !== null) lastEventSeq = seq
    if (applied) render()
    return { applied }
  }

  // ---------------- actions ----------------

  const alertMessage = (error) => {
    const code = str(error?.code, 80)
    if (code === 'REVISION_MISMATCH' || code === 'SELECTION_REVISION_MISMATCH') return '请求已经变化，正在同步最新状态；请重新确认后再提交。'
    if (error?.stale) return '这个请求已结束，正在同步…'
    return '提交失败，请重试；仍失败可双击桌宠打开主窗口查看。'
  }

  function receiptFailure(receipt) {
    if (!receipt || typeof receipt !== 'object') return null
    if (receipt.status === 'resolved' || receipt.status === 'accepted' || receipt.status === 'pending') return null
    const error = objectOr(receipt.error) || {}
    const failure = new Error(str(error.message, 300) || 'command was not accepted')
    failure.code = str(error.code, 80) || 'COMMAND_REJECTED'
    failure.receipt = receipt
    return failure
  }

  async function command(type, payload) {
    const receipt = await send(type, payload)
    const failure = receiptFailure(receipt)
    if (failure) throw failure
    return receipt
  }

  async function submitResolution(interaction, resolution, { successHint = '已提交，等待 Host 确认…', rollbackLegacy = true } = {}) {
    if (busy) return false
    busy = { owner: interaction.id }
    renderInteraction(interaction, '正在提交…')
    try {
      if (mode === 'legacy' || Array.isArray(resolution)) {
        // Legacy endpoint adapters (e.g. the durable-grant /approval path) keep their
        // HTTP shape until the v2 command exists; they forward to the same Host owner.
        const [path, body] = resolution
        await send(path, body)
        if (mode === 'legacy' && rollbackLegacy) {
          projection.interactions.pending = (projection.interactions.pending || []).filter((item) => item.id !== interaction.id)
          projection.interactions.focusedId = projection.interactions.pending[0]?.id ?? null
        }
        if (mode === 'legacy') {
          questionState = { interactionId: '', semanticRevision: null, index: 0, customInput: false, conflict: '' }
          persistentDraft = false
          busy = null
          render()
        } else {
          busy = null
          renderInteraction(interaction, successHint)
        }
        return true
      }
      await command('interaction.resolve', resolution)
      busy = null
      renderInteraction(interaction, successHint)
      return true
    } catch (error) {
      busy = null
      renderInteraction(interaction, alertMessage(error))
      return false
    }
  }

  function buildAnswerBatch(interaction) {
    const answers = answersOf(interaction)
    return (interaction.questions || []).map((question) => {
      const entry = answers[question.id] || {}
      const selected = Array.isArray(entry.selected) ? [...entry.selected] : []
      const custom = typeof entry.custom === 'string' ? entry.custom.trim() : ''
      return { id: question.id, selected, ...(custom ? { custom } : {}) }
    })
  }

  async function submitAnswer(interaction) {
    const answers = buildAnswerBatch(interaction)
    const missing = (interaction.questions || []).filter((question, index) => answers[index].selected.length === 0 && !answers[index].custom && question.multiSelect !== true)
    if (missing.length) return renderInteraction(interaction, '请选择一项或填写回答。')
    if (mode === 'legacy') {
      return submitResolution(interaction, ['/questions/answer', { id: interaction.id, sessionId: interaction.sessionId, answer: { answers } }])
    }
    // Bind the selectionRevision only while the Host draft is the current view; an
    // optimistic local toggle must not fabricate a revision the Host never issued.
    const base = projection.interactions.drafts?.[interaction.id] || null
    const selectionRevision = !draftOverlay && base && Number.isInteger(base.selectionRevision) ? base.selectionRevision : undefined
    return submitResolution(interaction, {
      interactionId: interaction.id,
      semanticRevision: interaction.semanticRevision,
      ...(selectionRevision !== undefined ? { selectionRevision } : {}),
      answer: { answers },
    })
  }

  async function saveDraftSelection(interaction, question, values, { selected }) {
    if (mode === 'legacy') {
      setDraftEntry(interaction, question, { selected: values })
      render()
      return true
    }
    const draft = draftView(interaction)
    const nextAnswers = {
      ...answersOf(interaction),
      [question.id]: { ...(answersOf(interaction)[question.id] || {}), selected: values },
    }
    draftOverlay = {
      interactionId: interaction.id,
      semanticRevision: interaction.semanticRevision,
      selectionRevision: (draft?.selectionRevision ?? 0) + 1,
      answers: nextAnswers,
      updatedAt: new Date(now()).toISOString(),
    }
    render()
    try {
      await command('interaction.draft.select', {
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
        selectionRevision: draft?.selectionRevision ?? 0,
        questionId: question.id,
        optionId: values.length ? values[values.length - 1] : selected?.optionId,
        selected: selected?.selected === true,
      })
      return true
    } catch (error) {
      draftOverlay = null
      renderInteraction(interaction, alertMessage(error))
      return false
    }
  }

  async function saveDraftCustom(interaction, question, text) {
    if (mode === 'legacy') { setDraftEntry(interaction, question, { custom: text }); return true }
    const draft = draftView(interaction)
    try {
      await command('interaction.draft.custom', {
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
        selectionRevision: draft?.selectionRevision ?? 0,
        questionId: question.id,
        text,
      })
      return true
    } catch (error) {
      renderInteraction(interaction, alertMessage(error))
      return false
    }
  }

  function advanceQuestion(interaction) {
    if (questionState.index + 1 < (interaction.questions || []).length) {
      questionState.index += 1
      questionState.customInput = false
      questionState.conflict = ''
    }
    render()
  }

  async function answerQuestion(interaction, action) {
    if (busy) return
    const question = currentQuestion(interaction)
    if (!question) return
    if (action.type === 'choice') {
      const option = question.options[Number(action.id)]
      if (!option) return
      const value = optionValue(option)
      if (question.multiSelect) {
        const current = selectedValues(interaction, question)
        const selected = !current.includes(value)
        const next = selected ? [...current, value] : current.filter((item) => item !== value)
        if (mode === 'legacy') {
          setDraftEntry(interaction, question, { selected: next })
          render()
          return
        }
        await saveDraftSelection(interaction, question, next, { selected: { optionId: value, selected } })
        return
      }
      // Single-select: store the answer progress through the Host draft, then submit or advance.
      const nextAnswers = { ...answersOf(interaction), [question.id]: { selected: [value] } }
      if (allAnswered(interaction, nextAnswers)) {
        if (mode === 'legacy') {
          setDraftEntry(interaction, question, { selected: [value] })
          await submitAnswer(interaction)
          return
        }
        draftOverlay = {
          interactionId: interaction.id,
          semanticRevision: interaction.semanticRevision,
          selectionRevision: (draftView(interaction)?.selectionRevision ?? 0) + 1,
          answers: nextAnswers,
          updatedAt: new Date(now()).toISOString(),
        }
        await submitAnswer(interaction)
        return
      }
      const ok = await saveDraftSelection(interaction, question, [value], { selected: { optionId: value, selected: true } })
      if (ok) advanceQuestion(interaction)
      return
    }
    if (action.type === 'input') {
      const typed = str(action.value, 20000).trim()
      if (!typed) return renderInteraction(interaction, '请选择一项或填写回答。')
      const nextAnswers = { ...answersOf(interaction), [question.id]: { selected: [], custom: typed } }
      if (allAnswered(interaction, nextAnswers)) {
        if (mode === 'legacy') {
          setDraftEntry(interaction, question, { selected: [], custom: typed })
          await submitAnswer(interaction)
          return
        }
        draftOverlay = {
          interactionId: interaction.id,
          semanticRevision: interaction.semanticRevision,
          selectionRevision: (draftView(interaction)?.selectionRevision ?? 0) + 1,
          answers: nextAnswers,
          updatedAt: new Date(now()).toISOString(),
        }
        await submitAnswer(interaction)
        return
      }
      if (mode === 'legacy') { setDraftEntry(interaction, question, { selected: [], custom: typed }); advanceQuestion(interaction); return }
      if (await saveDraftCustom(interaction, question, typed)) advanceQuestion(interaction)
      return
    }
    if (action.type === 'secondary') {
      if (action.id === 'other') { questionState.customInput = true; inputSeed = { key: '', value: '' }; render(); return }
      if (action.id === 'back' && questionState.index > 0) { questionState.index -= 1; questionState.customInput = false; render(); return }
      if (action.id === 'submit') {
        const entry = answersOf(interaction)[question.id] || {}
        const currentAnswered = (Array.isArray(entry.selected) && entry.selected.length > 0)
          || (typeof entry.custom === 'string' && entry.custom.trim() !== '')
        if (!currentAnswered) return renderInteraction(interaction, '请先回答每一个问题。')
        if (allAnswered(interaction)) await submitAnswer(interaction)
        else advanceQuestion(interaction)
        return
      }
      if (action.id === 'skip') {
        setDraftEntry(interaction, question, { selected: [], custom: '' })
        if (mode === 'legacy') {
          const questions = interaction.questions || []
          if (questionState.index + 1 < questions.length) { advanceQuestion(interaction); return }
          await submitAnswer(interaction)
          return
        }
        if (questionState.index + 1 < (interaction.questions || []).length) { advanceQuestion(interaction); return }
        setDraftEntryKeep(interaction, question, { selected: [], custom: '' })
        await submitAnswer(interaction)
      }
    }
  }

  function setDraftEntryKeep(interaction, question, entry) {
    // v2 skip has no Host draft command for "empty answer"; keep the empty answer in the submission overlay only.
    const answers = { ...answersOf(interaction), [question.id]: { ...entry } }
    draftOverlay = {
      interactionId: interaction.id,
      semanticRevision: interaction.semanticRevision,
      selectionRevision: (draftView(interaction)?.selectionRevision ?? 0) + 1,
      answers,
      updatedAt: new Date(now()).toISOString(),
    }
  }

  async function answerApproval(interaction, action) {
    if (busy) return
    if (action.type === 'secondary') {
      if (action.id === 'grant-confirm' && interaction.operation) { persistentDraft = true; render(); return }
      if (action.id === 'grant-back') { persistentDraft = false; render(); return }
      return
    }
    if (action.type !== 'approval') return
    const allow = action.decision === 'allow'
    if (mode === 'legacy') {
      const decision = allow && persistentDraft ? 'always-allow' : allow ? 'allow' : 'reject'
      return submitResolution(interaction, ['/approval', {
        id: interaction.id,
        sessionId: interaction.sessionId,
        decision,
        ...(decision === 'always-allow' ? { confirmExact: true } : {}),
      }])
    }
    if (allow && persistentDraft && interaction.operation) {
      // No v2 grant command in this round: the legacy /approval adapter forwards to the
      // same registry/policies owner (documented beta2 gap, same business owner).
      return submitResolution(interaction, ['/approval', { id: interaction.id, sessionId: interaction.sessionId, decision: 'always-allow', confirmExact: true }])
    }
    return submitResolution(interaction, {
      interactionId: interaction.id,
      semanticRevision: interaction.semanticRevision,
      decision: allow ? 'allowed-once' : 'rejected',
    })
  }

  async function managePolicies() {
    if (stopped) return
    if (focusedInteraction() || busy) { if (focusedInteraction()) renderInteraction(focusedInteraction(), '请先处理当前请求，再管理持续授权。'); return }
    overlay = null
    recovery = null
    recoveryEpoch += 1
    const epoch = ++managerEpoch
    try {
      const response = await send('/policies')
      if (stopped || focusedInteraction() || epoch !== managerEpoch) return
      manager = { id: `grants:${epoch}`, rules: Array.isArray(response?.rules) ? response.rules : [] }
      cancelUxTimer()
      renderManager(response?.error || '')
    } catch {
      postNotice('读取持续授权失败，请稍后重试。', 'error')
    }
  }

  async function recoverTask() {
    if (stopped) return
    if (focusedInteraction() || busy) { if (focusedInteraction()) renderInteraction(focusedInteraction(), '请先处理当前请求。'); return }
    overlay = null
    manager = null
    managerEpoch += 1
    const epoch = ++recoveryEpoch
    try {
      const preview = await send('/task/recovery')
      if (stopped || focusedInteraction() || epoch !== recoveryEpoch) return
      recovery = { ...preview, mode: null }
      cancelUxTimer()
      renderRecovery()
    } catch {
      postNotice('暂时无法恢复：任务可能仍在执行、没有可恢复的文字指令或状态已变化。请先检查任务状态。', 'error', 9000, '', { secondary: [{ id: 'inspect-task', label: '检查任务状态' }, { id: 'open', label: '打开主窗口' }] })
    }
  }

  async function manageQueue() {
    if (stopped) return
    if (focusedInteraction()) { renderInteraction(focusedInteraction(), '请先处理当前请求。'); return }
    manager = null
    managerEpoch += 1
    recovery = null
    recoveryEpoch += 1
    overlay = { kind: 'queue', id: '', edit: false }
    render()
    if (mode === 'legacy') {
      try { await send('voice-queue', { action: 'snapshot' }) } catch { /* the next legacy queue frame will refresh */ }
    }
  }

  function currentQueueItem() {
    if (!overlay || overlay.kind !== 'queue' || !overlay.id) return null
    return projection.queue.items.find((item) => item.id === overlay.id) || null
  }

  async function queueMutation(kind, text) {
    const item = currentQueueItem()
    if (!item || busy) return
    const revision = projection.queue.revision
    busy = { owner: `queue:${item.id}` }
    renderQueue()
    try {
      if (mode === 'legacy') {
        await send('voice-queue', { action: kind, id: item.id, revision, ...(kind === 'edit' ? { text } : {}) })
        if (kind === 'edit' && overlay) overlay.edit = false
      } else {
        const type = kind === 'edit' ? 'queue.edit' : kind === 'delete' ? 'queue.delete' : 'queue.confirm'
        await command(type, { revision, id: item.id, ...(kind === 'edit' ? { text } : {}) })
        if (kind === 'edit' && overlay) overlay.edit = false
        if (kind === 'delete' && overlay && overlay.id === item.id) overlay = { kind: 'queue', id: '', edit: false }
      }
      busy = null
      renderQueue()
    } catch (error) {
      busy = null
      renderQueue(alertMessage(error))
    }
  }

  // ---------------- public API ----------------

  return {
    applySnapshot(raw) {
      if (stopped) return { applied: false }
      const normalized = normalizeSnapshot(raw)
      if (normalized) {
        mode = 'v2'
        return install(normalized)
      }
      if (raw && Array.isArray(raw.requests)) {
        if (mode === 'v2') return { applied: false }
        mode = 'legacy'
        legacy.pid = intOr(raw.pid, 0)
        legacy.sessionId = str(raw.sessionId, 200)
        legacy.requests = raw.requests
        return installLegacy()
      }
      return { applied: false }
    },
    applyEvent(event) {
      if (stopped) return { applied: false }
      return applyEvent(event)
    },
    // Compatibility aliases used by the runtime and older tests.
    sync(raw) { return this.applySnapshot(raw) },
    event(event) { return this.applyEvent(event) },
    notice(value, kind = 'status', duration = 4500, capture = '', options = {}) {
      postNotice(value, kind, duration, capture, options)
    },
    state: () => ({
      working: working(),
      startedAt: mode === 'v2' ? msOf(projection.execution?.startedAt) : legacy.startedAt,
      inputSource: mode === 'v2' ? str(projection.execution?.inputSource, 40) || 'desktop' : legacy.inputSource,
      waiting: pendingCount() > 0,
      queued: projection.queue.items.length,
      mode,
      hostEpoch: projection.hostEpoch,
      snapshotSeq: projection.snapshotSeq,
      lastEventSeq,
    }),
    async action(action) {
      if (stopped || !action || typeof action !== 'object') return
      const type = String(action.type || '')
      // ---- transient capture cancel (both modes) ----
      if (type === 'cancel' && action.id === 'cancel-capture') {
        const owner = str(action.requestId, 200)
        const active = currentCaptureDisplayId()
        if (!owner || owner !== active) return
        if (mode !== 'v2') {
          // The legacy bridge has no Host snapshot to reconcile: clear the transient capture
          // surface synchronously so a double click cannot emit a second discard.
          captureId = ''
          clearTimer(captureTimer)
          if (localNotice?.capture === owner) localNotice = null
        }
        try { await send('control.cancel-capture', { captureId: owner }) } catch { /* legacy bridge retries on the next gesture */ }
        if (mode !== 'v2' && !focusedInteraction()) { hideSurface(); animation() }
        return
      }
      // ---- queue manager ----
      if (overlay && overlay.kind === 'queue' && !focusedInteraction()) {
        if (action.requestId !== `queue:${projection.queue.revision}`) return
        if (type === 'choice') {
          const item = projection.queue.items.find((entry) => entry.id === action.id)
          if (!item) return
          overlay = { kind: 'queue', id: item.id, edit: false }
          renderQueue()
          return
        }
        if (type === 'secondary' && action.id === 'queue-close') {
          overlay = null
          render()
          return
        }
        if (type === 'secondary' && action.id === 'queue-back') {
          overlay = { kind: 'queue', id: '', edit: false }
          renderQueue()
          return
        }
        if (type === 'secondary' && action.id === 'queue-edit') {
          overlay.edit = true
          inputSeed = { key: '', value: '' }
          renderQueue()
          return
        }
        if (type === 'secondary' && action.id === 'queue-confirm') { await queueMutation('confirm'); return }
        if (type === 'secondary' && action.id === 'queue-delete') { await queueMutation('delete'); return }
        if (type === 'input' && overlay.edit) { await queueMutation('edit', str(action.value, 20000)); return }
        return
      }
      // ---- grant manager overlay ----
      if (manager && !focusedInteraction() && action.requestId === manager.id && !busy) {
        if (type === 'secondary' && action.id === 'grant-close') { manager = null; managerEpoch += 1; render(); return }
        const rule = manager.rules.find((item) => item.id === action.id)
        if (type !== 'choice' || !rule) return
        const own = manager
        busy = { owner: own.id }
        renderManager('正在撤销…')
        try {
          await send(`/policies?id=${encodeURIComponent(rule.id)}`, { method: 'DELETE' })
          if (manager === own) {
            manager.rules = manager.rules.filter((item) => item.id !== rule.id)
            busy = null
            renderManager('已撤销。')
          }
        } catch {
          if (manager === own) { busy = null; renderManager('撤销失败，请重试。') }
        }
        return
      }
      // ---- task recovery overlay ----
      if (recovery && !focusedInteraction() && action.requestId === `recovery:${recovery.token}` && !busy) {
        if (type === 'choice' && ['continue', 'retry'].includes(action.id)) { recovery.mode = action.id; renderRecovery(); return }
        if (type !== 'secondary') return
        if (action.id === 'recovery-close') { recovery = null; recoveryEpoch += 1; render(); return }
        if (action.id === 'recovery-back') { recovery.mode = null; renderRecovery(); return }
        if (action.id !== 'recovery-confirm' || !recovery.mode) return
        const own = recovery
        busy = { owner: `recovery:${own.token}` }
        renderRecovery('正在提交…')
        try {
          await send('/task/recovery', { token: own.token, mode: own.mode, confirmSideEffects: true })
          if (recovery === own) { recovery = null; busy = null; render() }
        } catch {
          if (recovery === own) { recovery = null; busy = null; postNotice('状态已变化或提交失败。请重新检查任务，不会自动重复执行。', 'error', 9000, '', { secondary: [{ id: 'inspect-task', label: '检查任务状态' }] }) }
        }
        return
      }
      // ---- input draft ----
      const inputDraft = projection.inputDraft
      if (inputDraft && !focusedInteraction() && action.requestId === `voice:${inputDraft.id}` && !isBusy(`voice:${inputDraft.id}`)) {
        if (type === 'secondary' && action.id === 'voice-edit') {
          inputDraftEdit = true
          inputDraftSeenRevision = inputDraft.revision
          inputDraftConflict = ''
          inputSeed = { key: '', value: '' }
          renderInputDraft(inputDraft)
          return
        }
        if (type === 'secondary' && action.id === 'voice-discard') {
          const owner = `voice:${inputDraft.id}`
          busy = { owner }
          try {
            if (mode === 'legacy') await send('voice-input', { action: 'discard-input', id: inputDraft.id })
            else await command('input.reject', { id: inputDraft.id, revision: inputDraft.revision })
            busy = null
            if (mode === 'legacy') { clearInputDraft(); installLegacy() }
            else renderInputDraft(inputDraft, '已丢弃；Host 快照确认后关闭。')
          } catch (error) {
            busy = null
            renderInputDraft(inputDraft, alertMessage(error))
          }
          return
        }
        if (type === 'input' || (type === 'secondary' && action.id === 'voice-confirm')) {
          const typed = type === 'input' ? str(action.value, 20000).trim() : ''
          const text = type === 'input' ? typed : inputDraft.text
          if (!text || text.length > 20000) return
          const owner = `voice:${inputDraft.id}`
          busy = { owner }
          renderInputDraft(inputDraft, '正在提交…')
          try {
            if (mode === 'legacy') {
              await send('voice-input', { action: 'confirm-input', id: inputDraft.id, text })
              clearInputDraft()
              busy = null
              installLegacy()
            } else {
              await command('input.confirm', { id: inputDraft.id, revision: inputDraft.revision, ...(type === 'input' ? { text } : {}) })
              busy = null
              renderInputDraft(inputDraft, '已提交，等待 Host 确认…')
            }
          } catch (error) {
            busy = null
            renderInputDraft(inputDraft, alertMessage(error))
          }
          return
        }
        return
      }
      // ---- local diagnostic notice actions ----
      if (localNotice && !focusedInteraction() && action.requestId === localNotice.requestId && action.requestId) return
      if (type === 'secondary' && action.id === 'open') { await send('open'); return }
      if (type === 'secondary' && action.id === 'inspect-task') { await send('inspect-task'); return }
      if (type === 'secondary' && action.id === 'recover-task') { await recoverTask(); return }
      if (type === 'secondary' && action.id === 'retry-voice') { await send('retry-voice'); return }
      if (action.id === 'open-main') { await send('open'); return }
      // ---- snapshot notice actions ----
      if (type === 'secondary' && (action.id === 'confirm-input' || action.id === 'cancel-input') && projection.inputDraft) {
        const draft = projection.inputDraft
        busy = { owner: `voice:${draft.id}` }
        try {
          if (mode === 'legacy') await send('voice-input', { action: action.id === 'confirm-input' ? 'confirm-input' : 'discard-input', id: draft.id })
          else if (action.id === 'confirm-input') await command('input.confirm', { id: draft.id, revision: draft.revision })
          else await command('input.reject', { id: draft.id, revision: draft.revision })
          busy = null
          if (mode === 'legacy') { clearInputDraft(); installLegacy() } else render()
        } catch (error) { busy = null; postNotice(alertMessage(error), 'error') }
        return
      }
      // ---- pending interaction ----
      const interaction = focusedInteraction()
      if (!interaction || busy || action.requestId !== interaction.id) return
      if (interaction.kind === 'approval') { await answerApproval(interaction, action); return }
      await answerQuestion(interaction, action)
    },
    managePolicies,
    recoverTask,
    manageQueue,
    async voiceAnswer(value) {
      if (stopped || !questionView || busy || !value || typeof value.answerId !== 'string' || consumedAnswers.has(value.answerId)) return false
      const view = value.view
      if (!view || ['requestId', 'sessionId', 'questionId', 'index', 'revision'].some((key) => view[key] !== questionView[key])) return false
      if (questionView.semanticRevision !== undefined && view.semanticRevision !== undefined && view.semanticRevision !== questionView.semanticRevision) return false
      const interaction = focusedInteraction()
      if (!interaction || interaction.kind !== 'question' || interaction.id !== view.requestId) return false
      const question = currentQuestion(interaction)
      if (!question || question.id !== view.questionId) return false
      consumedAnswers.add(value.answerId)
      if (consumedAnswers.size > 128) consumedAnswers.delete(consumedAnswers.values().next().value)
      const action = questionVoiceAction(value.text, question)
      if (!action || (action.id === 'submit' && !question.multiSelect) || (action.id === 'skip' && question.multiSelect)) {
        renderInteraction(interaction, '没有识别到唯一选项。请说“第几个选项”、选项原文，或“其他回答…”；也可点击。')
        return false
      }
      await this.action({ ...action, requestId: interaction.id })
      return true
    },
    voice(state) {
      voiceState = str(state, 20) || 'idle'
      animation()
      if (voiceState === 'speaking') { voiceWasSpeaking = true; cancelUxTimer() }
      else if (voiceWasSpeaking && (voiceState === 'idle' || voiceState === 'listening') && displayTone === 'speech'
        && !working() && !focusedInteraction() && !projection.inputDraft && !manager && !recovery && !overlay) {
        voiceWasSpeaking = false
        scheduleUx('voice-idle', 1200, () => {
          if (working() || focusedInteraction() || projection.inputDraft) return
          reply = { ...reply, text: '' }
          render()
        })
      }
    },
    // ---- legacy migration bridge (removed in Phase 6) ----
    queue(value) {
      if (stopped || mode === 'v2' || !value || !Array.isArray(value.entries) || !Number.isInteger(value.revision)) return
      legacy.queue = normalizeQueue({ revision: value.revision, items: value.entries.slice(0, 20) })
      if (mode === 'legacy') installLegacy()
    },
    capture(status) {
      if (stopped || mode === 'v2' || !status || typeof status !== 'object') return
      if (status.kind === 'input-confirmation') {
        clearInputDraft()
        clearTimer(captureTimer)
        captureId = ''
        legacy.inputDraft = normalizeInputDraft({
          id: status.draftId, text: status.text, captureId: status.captureId, revision: 0,
          expiresAt: new Date(now() + Math.min(30000, Math.max(1, intOr(status.ttlMs, 30000)))).toISOString(),
          status: 'pending', source: 'voice', needsConfirmation: true,
        })
        const own = legacy.inputDraft?.id
        legacyDraftTimer = setTimer(() => {
          if (!legacy.inputDraft || legacy.inputDraft.id !== own) return
          legacyDraftTimer = undefined
          legacy.inputDraft = null
          inputDraftEdit = false
          if (mode === 'legacy') installLegacy()
        }, Math.min(30000, Math.max(1, intOr(status.ttlMs, 30000))))
        if (mode !== 'v2') { mode = 'legacy'; installLegacy() }
        return
      }
      if (status.kind === 'input-confirmation-ended') {
        if (legacy.inputDraft?.id === status.draftId) { clearInputDraft(); if (mode === 'legacy') installLegacy() }
        return
      }
      if (status.kind === 'capture-end' && legacy.inputDraft?.captureId === status.captureId) clearInputDraft()
      if (status.kind === 'capture-start' && status.captureId) {
        captureId = status.captureId
        captureIdentity = ''
        clearTimer(captureTimer)
        postNotice(status.text || '正在听…', 'input', 0, captureId)
        return
      }
      const identity = `${status.captureId}:${status.utteranceId || ''}`
      if (status.kind === 'input' && expiredInputs.has(identity)) return
      if (status.kind === 'input' && status.captureId && identity !== captureIdentity) {
        captureIdentity = identity
        captureId = status.captureId
        clearTimer(captureTimer)
        const own = captureId
        captureTimer = setTimer(() => {
          if (captureId === own) {
            captureId = ''
            expiredInputs.add(identity)
            if (expiredInputs.size > 64) expiredInputs.delete(expiredInputs.values().next().value)
            if (!focusedInteraction()) { localNotice = null; render() }
          }
        }, 15000)
      }
      if (status.kind === 'input' && status.captureId === captureId) postNotice(status.text, 'input', 4500, captureId)
      else if (status.kind === 'transcript' || status.kind === 'capture-end') {
        captureId = ''
        clearTimer(captureTimer)
        if (status.text) postNotice(status.text, 'transcript', 2200)
        else { localNotice = null; render() }
      }
    },
    cancelCapture(id) {
      if (!id || id !== currentCaptureDisplayId()) return false
      captureId = ''
      clearTimer(captureTimer)
      localNotice = null
      render()
      return true
    },
    syncTaskState(state) {
      if (stopped || mode === 'v2') return
      legacy.working = state?.status === 'running'
      if (legacy.working && !legacy.startedAt) legacy.startedAt = now()
      animation()
    },
    stop() {
      stopped = true
      clearTimer(captureTimer)
      clearTimer(legacyDraftTimer)
      cancelUxTimer()
      localNotice = null
      manager = null
      managerEpoch += 1
      recovery = null
      recoveryEpoch += 1
      overlay = null
      busy = null
      reply = { text: '', streaming: false, turnId: '', endedAt: 0, failed: false }
      projection = emptyProjection()
      legacy.inputDraft = null
      updateQuestion()
      publishQuestion(null)
      hideSurface()
    },
  }
}
