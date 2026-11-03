/**
 * ConversationService: the product business owner for beta2.
 *
 * Owns, after migration: utterance routing outcomes, input confirmation drafts,
 * the ordinary input queue, turn admission/observation and control commands.
 * It never executes an Agent loop itself: all DSH work goes through the injected
 * runtime adapter (index.js), and all official interaction decisions go through
 * the injected interaction registry.
 *
 * This module is deliberately runtime-independent so its behavior can be tested
 * with fakes (node:test), while index.js provides the real DSH/worker adapters.
 *
 * `snapshot@1` `interactions.unknown` (R2 user-visibility closure, 0.0.1):
 * an optional, additive array of interactions whose official outcome could not be
 * confirmed (the Host restarted before the official lifetime settled, or the
 * official lifetime ended without a confirmable result). Each entry is
 * `{ id, kind, sessionId, reason, at, action: { id: 'open-main', label } }`, is
 * read-only and final, and must never be answered again: the only recovery is the
 * user verifying the official state in the DSH main window. Existing fields
 * (`focusedId`, `pending`, `drafts`, `recentlyResolved`) keep their exact shape and
 * meaning, and the field may be absent from older Hosts; clients that ignore it
 * keep working, which is why the schema stays `snapshot@1` (see ./snapshot.mjs).
 *
 * The same projection also drives one Chinese user-visible warning notice plus the
 * safe "打开主窗口确认" action; that notice never resolves, retries or replays
 * anything on its own.
 */
import { ContractError, newId, nowIso, boundedString, stableOptionId, isIsoDate } from './contracts.mjs'
import { assertTaskCancelTarget, commandCancelTarget, currentCancelScope } from './cancel-routing.mjs'
import { createQueueModel, createDraftModel, createTurnModel } from './conversation-model.mjs'
import { createUtteranceAssembler, createSegmenter, SETTLE_MS_DEFAULT } from './utterance.mjs'
import { productIdentity } from './identity.mjs'

export const CONTROL_KINDS = new Set([
  'playback-stop', 'playback-brief', 'playback-full', 'task-stop', 'task-status', 'approval-allow', 'approval-reject', 'cancel-capture',
])

const GREETINGS = new Set(['你好', '我在', '想聊什么', '谢谢', '好的', 'hello', 'thanks', '在吗', '嗨'])
const ACTION_PREFIX = /^(打开|搜索|查找|整理|创建|读取|列出|翻译|计算|解释|总结|请|帮我|看看|检查|运行|执行)/
const DEFAULT_QUEUE_LIMIT = 5
const DEFAULT_QUEUE_TTL_MS = 60_000
const DEFAULT_DRAFT_TTL_MS = 30_000
const DEFAULT_CANCEL_CONFIRM_MS = 30_000
const DEFAULT_NOTICE_TTL_MS = 8_000
const MAX_NOTICES = 8
const MAX_CONSUMED = 512
const WORKER_STALE_MS = 15_000
/** Bounded projection of unconfirmed interactions, aligned with `recentlyResolved`. */
const MAX_SNAPSHOT_UNKNOWN = 8
/** The hint is worth keeping visible across a desktop reattach, not just one turn. */
const DEFAULT_UNKNOWN_NOTICE_TTL_MS = 30 * 60 * 1000
/** Poll cadence for a mid-session `unknown`; the startup path announces immediately. */
const UNKNOWN_SYNC_MS = 1000
const UNKNOWN_INTERACTION_NOTE = '上次审批或回答的结果尚未确认；请打开主窗口核实，不会自动重试。'
const UNKNOWN_INTERACTION_ACTION = Object.freeze({ id: 'open-main', label: '打开主窗口确认' })

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)
const ms = (value) => (Number.isFinite(Number(value)) ? Number(value) : Date.now())

/** Conservative confirmation policy for ordinary speech. Pure, testable. */
export function needsConfirmation(text, { mode = 'hold', assembled = true } = {}) {
  const normalized = String(text || '').toLowerCase().replace(/[^0-9a-z\u4e00-\u9fff]/g, '')
  if (mode === 'always') return { needed: true, reason: 'always-mode' }
  if (!assembled) return { needed: true, reason: 'not-assembled' }
  if (GREETINGS.has(normalized)) return { needed: false, reason: 'greeting' }
  if (ACTION_PREFIX.test(normalized)) return { needed: false, reason: 'explicit-action' }
  if (normalized.length > 0 && normalized.length <= 4) return { needed: true, reason: 'short-fragment' }
  return { needed: false, reason: 'ordinary' }
}

function normalizeQueueItem(item, revisionFallback = 0) {
  return {
    id: String(item?.id || newId('queue-')),
    text: boundedString(item?.text, 20000),
    source: String(item?.source || 'voice'),
    position: Number.isInteger(item?.position) ? item.position : 0,
    createdAt: iso(item?.createdAt) || nowIso(),
    expiresAt: iso(item?.expiresAt),
    waitedSeconds: Number.isFinite(Number(item?.waitedSeconds)) ? Number(item.waitedSeconds) : 0,
    needsConfirmation: item?.needsConfirmation === true,
    status: String(item?.status || (item?.needsConfirmation ? 'confirming' : 'waiting')),
    revision: revisionFallback,
  }
}

/**
 * Normalize recovered-unknown registry records into the public `snapshot@1`
 * `interactions.unknown` entries. Pure and bounded: malformed records are dropped
 * instead of being echoed into the protocol, ids are de-duplicated, and the stable
 * "verify in the main window" action is attached to every entry.
 *
 * @param {unknown} raw - `registry.snapshot().unknown` (may be absent on older registries).
 * @returns {{id: string, kind: string|null, sessionId: string|null, reason: string, at: string|null, action: {id: string, label: string}}[]}
 */
function normalizeUnknownInteractions(raw) {
  const source = Array.isArray(raw) ? raw : []
  const seen = new Set()
  const projection = []
  for (const item of source) {
    if (!item || typeof item !== 'object') continue
    const id = boundedString(item.id, 200)
    if (!id || seen.has(id)) continue
    seen.add(id)
    projection.push({
      id,
      kind: item.kind === 'approval' || item.kind === 'question' ? item.kind : null,
      sessionId: boundedString(item.sessionId, 200) || null,
      reason: boundedString(item.reason, 120) || 'INTERACTION_UNKNOWN',
      at: isIsoDate(item.at) ? new Date(Date.parse(item.at)).toISOString() : null,
      action: { ...UNKNOWN_INTERACTION_ACTION },
    })
    if (projection.length >= MAX_SNAPSHOT_UNKNOWN) break
  }
  return projection
}

export function createConversationService({
  hostEpoch,
  events,
  store = null,
  registry = null,
  runtime,
  config = {},
  log = () => {},
}) {
  if (typeof hostEpoch !== 'string' || hostEpoch === '') throw new Error('ConversationService requires hostEpoch')
  if (!events || typeof events.record !== 'function') throw new Error('ConversationService requires the snapshot event store')
  if (!runtime) throw new Error('ConversationService requires the DSH runtime adapter')

  const queueLimit = Number.isInteger(config.queueLimit) ? config.queueLimit : DEFAULT_QUEUE_LIMIT
  const queueTtlMs = Number.isFinite(config.queueTtlMs) ? config.queueTtlMs : DEFAULT_QUEUE_TTL_MS
  const draftTtlMs = Number.isFinite(config.draftTtlMs) ? config.draftTtlMs : DEFAULT_DRAFT_TTL_MS
  const settleMs = Number.isFinite(config.settleMs) ? config.settleMs : SETTLE_MS_DEFAULT
  const drainMs = Number.isFinite(config.drainMs) ? config.drainMs : 3000
  const cancelConfirmMs = Number.isFinite(config.cancelConfirmMs) ? config.cancelConfirmMs : DEFAULT_CANCEL_CONFIRM_MS
  const noticeTtlMs = Number.isFinite(config.noticeTtlMs) ? config.noticeTtlMs : DEFAULT_NOTICE_TTL_MS
  const unknownNoticeTtlMs = Number.isFinite(config.unknownNoticeTtlMs) ? config.unknownNoticeTtlMs : DEFAULT_UNKNOWN_NOTICE_TTL_MS
  const now = typeof config.now === 'function' ? config.now : () => Date.now()

  const queue = createQueueModel({ limit: queueLimit, ttlMs: queueTtlMs, now })
  const draft = createDraftModel({ ttlMs: draftTtlMs, now })
  const turn = createTurnModel({ now })
  const assembler = createUtteranceAssembler({ settleMs, drainMs, now })
  const segmenter = createSegmenter()

  const capture = {
    state: 'off', mode: 'hold', captureId: null, connectionId: null,
    preview: null, updatedAt: null, lastDiscardAt: null,
  }
  const playback = { state: 'idle', playbackId: null, sourceTurnId: null, style: 'full', updatedAt: null }
  const workerConnection = { state: 'disconnected', connectionId: null, lastSeenAt: null }
  const desktopConnection = { connected: false, lastSeenAt: null, lastEventSeq: 0 }
  const notices = new Map()
  const noticeTimers = new Map()
  const consumed = new Map()
  const recentlyResolved = []
  const ackedCommands = new Set()
  let admission = null
  let admissionTask = null
  let tickTimer = null
  let disposed = false
  let pendingCancel = null
  let cancelTimer = null
  let lastTurn = null
  let restoreNoticeId = null
  let persisted = null
  /** Id of the live "result unconfirmed" hint notice, if one was announced. */
  let unknownNoticeId = null
  /** Unknown interaction ids already announced, so a poll does not repeat the hint. */
  const announcedUnknownIds = new Set()
  let lastUnknownSyncAt = 0

  function emit(type, { source = 'host', sessionId = null, turn: turnNumber = null, causedByCommandId = null, data = {} } = {}) {
    return events.record(type, { source, sessionId, turn: turnNumber, causedByCommandId, data })
  }

  function currentSession() {
    try { return String(runtime.sessionId?.() || '') || null } catch { return null }
  }

  function desktopConnectedNow() {
    if (!desktopConnection.connected) return false
    const last = desktopConnection.lastSeenAt ? Date.parse(desktopConnection.lastSeenAt) : 0
    return Number.isFinite(last) && now() - last < WORKER_STALE_MS
  }

  function workerStateNow() {
    if (workerConnection.state !== 'connected') return workerConnection.state
    const last = workerConnection.lastSeenAt ? Date.parse(workerConnection.lastSeenAt) : 0
    return Number.isFinite(last) && now() - last > WORKER_STALE_MS ? 'stale' : 'connected'
  }

  // ---------------- persistence ----------------

  function persistState(reason = 'state') {
    if (!store) return
    try {
      store.update((data) => {
        data.version = 1
        data.savedAt = nowIso()
        data.reason = reason
        data.queue = queue.snapshot().items
        data.draft = draft.snapshot()
        data.lastTurn = lastTurn || turn.snapshot().lastTurn || null
        data.playbackStyle = playback.style
        data.workerConnection = { ...workerConnection }
        data.captureMode = capture.mode
        return data
      })
    } catch (error) {
      log('state persist failed: ' + String(error?.message || error))
    }
  }

  function restoreState() {
    if (!store) return
    let loaded
    try { loaded = store.load() } catch { return }
    persisted = loaded?.data || null
    if (loaded?.corruptBackup) {
      addNotice({ kind: 'error', severity: 'error', text: '产品状态记录损坏，已保留原件并停止自动恢复。请检查后重新确认输入。', diagnosticId: 'STATE_CORRUPT' })
    }
    if (!persisted) { persistState('init'); return }
    if (Array.isArray(persisted.queue) && persisted.queue.length) {
      try { queue.restoreFromPersisted(persisted.queue.filter((item) => item && typeof item.text === 'string')) }
      catch (error) { log('queue restore failed: ' + String(error?.message || error)) }
    }
    if (persisted.lastTurn && typeof persisted.lastTurn === 'object') lastTurn = persisted.lastTurn
    if (persisted.playbackStyle === 'brief') playback.style = 'brief'
    if (persisted.captureMode && ['hold', 'toggle', 'always'].includes(persisted.captureMode)) capture.mode = persisted.captureMode
    const previous = persisted.lastTurn || null
    const wasActive = persisted.reason === 'turn-started' || (previous && previous.terminal == null && previous.turn != null)
    if (wasActive || persisted.reason === 'turn-cancel-requested') {
      turn.markUnknown('host-restart')
      addNotice({ kind: 'warning', severity: 'warning', text: '上次任务在 Host 重启前尚未确认结束，结果未知。请打开主窗口检查；不会自动重放。', diagnosticId: 'EXECUTION_UNKNOWN' })
    }
    if (queue.snapshot().items.length || draft.snapshot()) {
      restoreNoticeId = addNotice({ kind: 'status', severity: 'info', text: 'Host 重启：未提交输入已恢复为待重新确认，不会自动执行。' })
    }
    persistState('restored')
  }

  // ---------------- notices ----------------

  function clearNoticeTimer(id) {
    const value = noticeTimers.get(id)
    if (value) { clearTimeout(value); noticeTimers.delete(id) }
  }

  function expireNotice(id) {
    if (!notices.has(id)) return
    notices.delete(id)
    clearNoticeTimer(id)
    emit('notice.expired', { data: { id } })
  }

  function addNotice({ kind = 'status', severity = 'info', text = '', ttlMs = noticeTtlMs, diagnosticId = null, actions = [] } = {}) {
    if (disposed) return null
    if (notices.size >= MAX_NOTICES) {
      const oldest = notices.keys().next().value
      if (oldest !== undefined) expireNotice(oldest)
    }
    const notice = {
      id: newId('notice-'), kind, severity, text: boundedString(text, 2000),
      createdAt: nowIso(), expiresAt: iso(now() + Math.max(0, ttlMs)),
      diagnosticId, actions: Array.isArray(actions) ? actions.slice(0, 4) : [],
    }
    notices.set(notice.id, notice)
    emit('notice.added', { data: { notice } })
    if (ttlMs > 0) {
      const timer = setTimeout(() => { noticeTimers.delete(notice.id); expireNotice(notice.id) }, ttlMs)
      timer.unref?.()
      noticeTimers.set(notice.id, timer)
    }
    return notice.id
  }

  // ---------------- interaction helpers ----------------

  function pendingInteractions() {
    try {
      const snapshot = registry?.snapshot?.()
      const base = snapshot && typeof snapshot === 'object' ? snapshot : { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] }
      const pending = Array.isArray(base.pending) ? [...base.pending] : []
      let continued = []
      try { continued = typeof runtime.continuedQuestions === 'function' ? runtime.continuedQuestions() || [] : [] } catch { continued = [] }
      for (const item of continued) {
        if (!item || pending.some((existing) => existing.id === item.id)) continue
        const questions = (Array.isArray(item.questions) ? item.questions : []).map((question) => ({
          ...question,
          options: (Array.isArray(question.options) ? question.options : []).map((option, index) => ({
            ...option,
            id: stableOptionId(option, question.id, 1, index),
          })),
        }))
        pending.push({
          id: String(item.id), kind: 'question', sessionId: String(item.sessionId || currentSession() || ''),
          semanticRevision: 1, viewRevision: 1, officialCallId: item.callId || null,
          createdAt: nowIso(), expiresAt: null, source: 'continued', questions,
        })
      }
      return { ...base, pending }
    } catch { return { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] } }
  }

  /**
   * Current unconfirmed-interaction projection (public `interactions.unknown` shape).
   * Read-only: it only reflects what the registry recovered, never a fabricated result.
   */
  function unknownInteractionsView() {
    try { return normalizeUnknownInteractions(pendingInteractions().unknown) } catch { return [] }
  }

  /**
   * Announce (or refresh) the single user-visible "result unconfirmed" hint.
   *
   * Idempotent per unknown id: polling cannot duplicate the hint, a genuinely new
   * unknown replaces it with the updated list, and a desktop that reattaches after
   * the hint expired gets it back — a hint the user never saw is not a user-visible
   * state. It only reads the registry projection, so it cannot resolve, retry or
   * replay anything.
   *
   * @param {{announceExisting?: boolean}} [options]
   */
  function syncUnknownInteractions({ announceExisting = false } = {}) {
    if (disposed) return
    const unknown = unknownInteractionsView()
    if (!unknown.length) {
      if (unknownNoticeId) { expireNotice(unknownNoticeId); unknownNoticeId = null }
      announcedUnknownIds.clear()
      return
    }
    const unseen = unknown.filter((item) => !announcedUnknownIds.has(item.id))
    const noticeLive = Boolean(unknownNoticeId && notices.has(unknownNoticeId))
    if (!unseen.length && !(announceExisting && !noticeLive)) return
    for (const item of unknown) announcedUnknownIds.add(item.id)
    if (unknownNoticeId) expireNotice(unknownNoticeId)
    unknownNoticeId = addNotice({
      kind: 'warning',
      severity: 'warning',
      text: UNKNOWN_INTERACTION_NOTE,
      ttlMs: unknownNoticeTtlMs,
      diagnosticId: 'INTERACTION_UNKNOWN',
      actions: [{ ...UNKNOWN_INTERACTION_ACTION }],
    })
  }

  /** Throttled mid-session check; startup and desktop reattach announce immediately. */
  function maybeSyncUnknownInteractions() {
    const at = now()
    if (at - lastUnknownSyncAt < UNKNOWN_SYNC_MS) return
    lastUnknownSyncAt = at
    syncUnknownInteractions()
  }

  function activeInteraction() {
    const pending = pendingInteractions().pending || []
    return pending.length ? pending[0] : null
  }

  function activeApproval() {
    const item = activeInteraction()
    return item && item.kind === 'approval' ? item : null
  }

  function activeQuestion() {
    const item = activeInteraction()
    return item && item.kind === 'question' ? item : null
  }

  function routingContext(utterance) {
    const question = activeQuestion()
    const approval = activeApproval()
    return {
      mode: utterance?.mode || capture.mode,
      captureId: utterance?.captureId || capture.captureId,
      utteranceId: utterance?.utteranceId || null,
      sessionId: currentSession(),
      interaction: question
        ? { kind: 'question', id: question.id, semanticRevision: question.semanticRevision, questions: question.questions || [] }
        : null,
      approval: approval ? { id: approval.id, semanticRevision: approval.semanticRevision, operation: approval.operation || null } : null,
    }
  }

  // ---------------- capture / voice facts ----------------

  /** Capture states that keep the recording bubble on screen. */
  const RECORDING_CAPTURE_STATES = new Set(['admitting', 'listening', 'closing', 'transcribing'])

  function captureData() {
    return {
      state: capture.state, mode: capture.mode, captureId: capture.captureId,
      preview: capture.preview, connectionId: capture.connectionId,
    }
  }

  /**
   * Project the assembler's capture lifecycle onto the Host capture state.
   *
   * The worker reports `finish` as a release fact; the assembler then drains
   * buffered finals. Nothing else used to move the projection back to `off`,
   * so the renderer kept an ended recording's bubble (and its "取消录音"
   * affordance) on screen indefinitely. A released capture with no buffered
   * utterance is already over; a finished/discarded capture is over even if a
   * late duplicate final arrives. Returns true when the projection changed.
   */
  function syncCaptureState() {
    const id = capture.captureId
    if (!id) return false
    if (!RECORDING_CAPTURE_STATES.has(capture.state)) return false
    const info = assembler.captureInfo(id)
    const finished = info.state === 'finished' || info.state === 'discarded'
    const drained = info.released && info.pendingGroups === 0
    if (!finished && !drained) return false
    capture.state = 'off'
    capture.preview = null
    capture.updatedAt = nowIso()
    return true
  }

  function emitCaptureChanged() {
    emit('capture.changed', { data: captureData() })
  }

  function applyCaptureFacts(payload) {
    const next = payload?.capture && typeof payload.capture === 'object' ? payload.capture : null
    if (next) {
      const incomingId = next.captureId !== undefined ? (next.captureId ? String(next.captureId) : null) : capture.captureId
      // A duplicate/late fact for a capture the Host already closed must not
      // resurrect its bubble; a new captureId is a new recording.
      const reopening = capture.state === 'off' && Boolean(incomingId) && incomingId === capture.captureId
      // The interaction mode is fixed when a capture starts. A release or
      // transcript fact must never rewrite it (older workers defaulted the
      // missing release mode to "always", which then needed confirmations and
      // was persisted as the user's mode).
      const startsCapture = capture.state === 'off' || !capture.captureId || incomingId !== capture.captureId
      if (next.captureId !== undefined) capture.captureId = incomingId
      if (next.mode && ['hold', 'toggle', 'always'].includes(String(next.mode)) && (startsCapture || capture.state === 'off')) capture.mode = String(next.mode)
      if (next.state && ['off', 'admitting', 'listening', 'transcribing', 'closing'].includes(String(next.state)) && !reopening) capture.state = String(next.state)
      capture.connectionId = payload?.connectionId ? String(payload.connectionId) : capture.connectionId
      capture.updatedAt = nowIso()
    }
    if (Array.isArray(payload?.items)) {
      for (const item of payload.items) {
        if (!item || typeof item !== 'object') continue
        const kind = String(item.kind || '')
        const result = assembler.fact({
          kind, captureId: item.captureId || capture.captureId, utteranceId: item.utteranceId,
          itemId: item.itemId, revision: Number.isInteger(item.revision) ? item.revision : 0,
          text: boundedString(item.text, 20000),
          confidence: Number.isFinite(item.confidence) ? item.confidence : null,
          at: item.at,
        }, { mode: capture.mode })
        if (!result?.accepted) continue
        if (kind === 'asr.partial') {
          capture.preview = {
            utteranceId: item.utteranceId || null,
            segmentCount: Number.isInteger(item.revision) ? item.revision + 1 : 1,
            text: boundedString(item.text, 400),
            revision: Number.isInteger(item.revision) ? item.revision : 0,
          }
          capture.state = capture.state === 'off' ? 'listening' : capture.state
        }
        capture.updatedAt = nowIso()
      }
    }
    if (payload?.release) {
      const released = assembler.release({ captureId: payload.release.captureId || capture.captureId, discard: payload.release.reason === 'discard' })
      if (payload.release.reason === 'discard') {
        capture.state = 'off'
        capture.preview = null
        capture.lastDiscardAt = nowIso()
      } else {
        capture.state = 'closing'
      }
      if (released && released.drained) capture.state = 'transcribing'
      capture.updatedAt = nowIso()
    }
    syncCaptureState()
    emitCaptureChanged()
  }

  function markConsumed(utteranceId, segmentId) {
    const key = `${utteranceId || ''}:${segmentId || ''}`
    if (consumed.has(key)) return false
    consumed.set(key, now())
    if (consumed.size > MAX_CONSUMED) consumed.delete(consumed.keys().next().value)
    return true
  }

  async function routeUtterance(utterance) {
    const routed = []
    const commands = []
    const context = routingContext(utterance)
    let decision
    try { decision = segmenter.route(utterance.text, context) }
    catch (error) {
      log('segmenter failed: ' + String(error?.message || error))
      addNotice({ kind: 'error', severity: 'error', text: '这次发言无法安全解析，已保留为待检查内容；不会创建任务。', diagnosticId: 'SEGMENTER_ERROR' })
      return { routed, commands, error: 'SEGMENTER_ERROR' }
    }
    if (decision?.interactionAnswerRejected) {
      addNotice({ kind: 'status', severity: 'warning', text: '没听清这是对当前问答的回答。请再说一次选项名称，或点气泡选择；我不会把它当成新任务。', diagnosticId: 'ANSWER_UNCLEAR' })
      routed.push({ segmentId: 'interaction-answer-rejected', path: 'clarify', reason: 'interaction-answer-rejected' })
      return { routed, commands }
    }
    if (Array.isArray(decision?.clarifications) && decision.clarifications.length) {
      const text = decision.clarifications
        .map((item) => (typeof item === 'string' ? item : item?.text || ''))
        .filter(Boolean)
        .slice(0, 2)
        .join(' ')
      addNotice({ kind: 'status', severity: 'warning', text: text || '这句话有歧义，请确认你的意思；我不会猜着执行。', diagnosticId: 'UTTERANCE_AMBIGUOUS' })
      const rawSegments = Array.isArray(decision?.segments) ? decision.segments : []
      for (const segment of rawSegments) {
        routed.push({ segmentId: segment.segmentId || newId(), path: segment.kind === 'ignore' ? 'ignore' : 'clarify', reason: segment.reason || 'clarify' })
      }
      if (!rawSegments.length) routed.push({ segmentId: 'clarify', path: 'clarify', reason: 'ambiguous' })
      syncCaptureState()
      emitCaptureChanged()
      return { routed, commands }
    }
    const segments = Array.isArray(decision?.segments) ? decision.segments : []
    if (!segments.length) {
      routed.push({ segmentId: 'empty', path: 'ignore', reason: 'no-segments' })
      return { routed, commands }
    }
    if (utterance.late) {
      for (const segment of segments) {
        routed.push({ segmentId: segment.segmentId || newId(), path: 'late-pending', reason: 'late-final' })
      }
      try { draft.offer({ text: String(utterance.text || '').trim(), source: 'voice', captureId: utterance.captureId, metadata: { late: true } }) }
      catch { /* an existing confirmation draft keeps precedence; the late text stays in diagnostics */ }
      addNotice({ kind: 'status', severity: 'warning', text: '收到一段迟到的识别内容，已放入待确认；不会自动执行。', diagnosticId: 'LATE_FINAL' })
      emit('input-draft.changed', { data: { draft: draft.snapshot() } })
      return { routed, commands }
    }
    for (const segment of segments) {
      const segmentId = segment.segmentId || newId('seg-')
      if (!markConsumed(utterance.utteranceId, segmentId)) {
        routed.push({ segmentId, path: 'ignore', reason: 'duplicate-segment' })
        continue
      }
      try {
        const outcome = await routeSegment(segment, utterance, context)
        routed.push({ segmentId, path: outcome.path, reason: outcome.reason, ...(outcome.detail || {}) })
        commands.push(...(outcome.commands || []))
      } catch (error) {
        routed.push({ segmentId, path: 'rejected', reason: boundedString(error?.message || error, 300) })
      }
    }
    syncCaptureState()
    emitCaptureChanged()
    return { routed, commands }
  }

  async function routeSegment(segment, utterance, context) {
    if (segment.kind === 'ignore') return { path: 'ignore', reason: segment.reason || 'ignored' }
    if (segment.kind === 'control') {
      const result = await executeControl(segment, context)
      return { path: 'control', reason: segment.control || '', commands: result.commands || [], detail: result.detail }
    }
    if (segment.kind === 'interaction-answer') {
      const result = await resolveInteractionAnswer(segment, context)
      return { path: 'interaction-answer', reason: result.outcome || '', detail: { interactionId: result.interactionId || null, outcome: result.outcome || null } }
    }
    if (segment.kind === 'input') {
      const result = await acceptInput(segment, utterance)
      return { path: 'input', reason: result.outcome || '', detail: result.detail }
    }
    return { path: 'ignore', reason: 'unknown-segment-kind' }
  }

  async function executeControl(segment, context) {
    const kind = String(segment.control || '')
    if (kind === 'playback-stop') {
      const playbackId = playback.playbackId || newId('playback-')
      playback.state = 'stopping'
      playback.updatedAt = nowIso()
      const commandId = emitCommand('playback.stop', { playbackId, reason: 'voice-control' })
      emit('playback.changed', { data: { state: playback.state, playbackId } })
      addNotice({ kind: 'status', severity: 'info', text: '已停止播报；任务仍在执行，需要取消请说“停止任务”。', ttlMs: 4000 })
      return { commands: [{ commandId, type: 'playback.stop' }], detail: { playbackId } }
    }
    if (kind === 'playback-brief' || kind === 'playback-full') {
      playback.style = kind === 'playback-brief' ? 'brief' : 'full'
      const commandId = emitCommand('playback.style', { style: playback.style })
      addNotice({ kind: 'status', severity: 'info', text: playback.style === 'brief' ? '后续播报将只说结论。' : '后续播报恢复完整内容。', ttlMs: 4000 })
      persistState('playback-style')
      return { commands: [{ commandId, type: 'playback.style' }], detail: { style: playback.style } }
    }
    if (kind === 'task-stop') {
      const normalized = String(segment.text || '').replace(/[^0-9a-z\u4e00-\u9fff]/g, '')
      const confirmed = segment.confirm === true || normalized.includes('确认停止')
      if (confirmed) {
        if (!pendingCancel) {
          addNotice({ kind: 'status', severity: 'warning', text: '当前没有待确认的停止请求。需要停止时，请先明确说“停止任务”。', diagnosticId: 'NO_PENDING_CANCEL' })
          return { commands: [], detail: { outcome: 'no-pending-cancel' } }
        }
        return requestCancelTask({ source: 'voice-confirm', confirmToken: pendingCancel.token })
      }
      return requestCancelConfirmation()
    }
    if (kind === 'cancel-capture') {
      const captureId = String(segment.captureId || context.captureId || capture.captureId || '')
      if (!captureId || !RECORDING_CAPTURE_STATES.has(capture.state) || captureId !== capture.captureId) {
        addNotice({ kind: 'status', severity: 'info', text: '当前没有正在进行的录音。', diagnosticId: 'NO_CAPTURE' })
        return { commands: [], detail: { outcome: 'no-capture' } }
      }
      const commandId = emitCommand('capture.command', { action: 'discard', captureId, reason: 'voice-control' })
      try { assembler.release({ captureId, discard: true }) } catch { /* the worker also discards locally */ }
      capture.state = 'off'
      capture.preview = null
      capture.lastDiscardAt = nowIso()
      capture.updatedAt = nowIso()
      emitCaptureChanged()
      addNotice({ kind: 'status', severity: 'info', text: '已取消录音；任务不受影响。', ttlMs: 4000 })
      return { commands: [{ commandId, type: 'capture.command' }], detail: { captureId } }
    }
    if (kind === 'task-status') {
      const state = turn.snapshot()
      const summary = state.state === 'idle'
        ? (lastTurn ? '当前没有任务在执行；上次任务已结束，请检查结果。' : '当前没有任务在执行。')
        : state.state === 'cancel-requested' ? '已请求停止任务，正在等待 DSH 确认。' : '任务仍在执行。'
      addNotice({ kind: 'status', severity: 'info', text: summary, ttlMs: 9000 })
      return { commands: [], detail: { state: state.state } }
    }
    if (kind === 'approval-allow' || kind === 'approval-reject') {
      if (!context.approval && !activeApproval()) {
        addNotice({ kind: 'status', severity: 'warning', text: '现在没有待处理的审批，我不会把这句话当成授权。', diagnosticId: 'NO_PENDING_APPROVAL' })
        return { commands: [], detail: { outcome: 'no-pending-approval' } }
      }
      const decision = segment.answer?.decision
        || (kind === 'approval-allow' ? 'allowed-once' : 'rejected')
      const outcome = await resolveInteractionAnswer({
        kind: 'interaction-answer',
        answer: { decision },
        text: segment.text,
      }, context)
      return { commands: [], detail: outcome }
    }
    return { commands: [], detail: { outcome: 'unknown-control' } }
  }

  async function resolveInteractionAnswer(segment, context) {
    const interaction = activeQuestion() || activeApproval()
    if (!interaction) {
      addNotice({ kind: 'status', severity: 'warning', text: '当前没有待处理的审批或问题。', diagnosticId: 'NO_PENDING_INTERACTION' })
      return { outcome: 'no-pending-interaction' }
    }
    const payload = segment.answer || {}
    // Continued official questions are still owned by DSH userQuestions; the product only
    // projects and forwards a validated answer batch (option ids -> official labels).
    if (String(interaction.id).startsWith('continued:')) {
      const questions = Array.isArray(interaction.questions) ? interaction.questions : []
      const converted = {
        answers: (payload.answers || []).map((answer) => {
          const question = questions.find((item) => item.id === answer.id)
          const selected = Array.isArray(answer.selected) ? answer.selected.map((id) => {
            const option = question?.options?.find((item) => item.id === id)
            return option?.label
          }).filter((label) => typeof label === 'string') : []
          return { id: answer.id, selected, ...(typeof answer.custom === 'string' && answer.custom.trim() ? { custom: answer.custom } : {}) }
        }),
      }
      let accepted = false
      try {
        accepted = Boolean(runtime.answerContinuedQuestion?.({ callId: interaction.officialCallId, questions, answer: converted }))
      } catch (error) {
        addNotice({ kind: 'error', severity: 'error', text: '官方问题服务未接受这个回答：' + boundedString(error?.message || error, 200), diagnosticId: 'CONTINUED_ANSWER_FAILED' })
        return { outcome: 'answer-failed' }
      }
      if (!accepted) {
        addNotice({ kind: 'status', severity: 'warning', text: '这题已在别处回答或已过期；不会重复提交。', diagnosticId: 'ANSWER_STALE' })
        return { outcome: 'answer-stale' }
      }
      emit('interaction.resolved', { data: { id: interaction.id, outcome: 'answered', via: 'voice' } })
      emit('interactions.changed', { data: pendingInteractions() })
      return { interactionId: interaction.id, outcome: 'answered' }
    }
    const result = registry?.resolve
      ? registry.resolve({
        commandId: newId('voice-answer-'),
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
        payload: interaction.kind === 'approval'
          ? { interactionId: interaction.id, semanticRevision: interaction.semanticRevision, decision: payload.decision || (String(segment.text || '').includes('不') ? 'rejected' : 'allowed-once') }
          : { interactionId: interaction.id, semanticRevision: interaction.semanticRevision, answer: { answers: payload.answers || [] }, ...(payload.selectionRevision ? { selectionRevision: payload.selectionRevision } : {}) },
        sourceConnectionId: 'worker',
      })
      : { status: 'rejected', error: { code: 'REGISTRY_UNAVAILABLE', message: 'interaction registry unavailable' } }
    if (result?.status === 'resolved' || result?.status === 'accepted') {
      emit('interaction.resolved', { data: { id: interaction.id, outcome: result.result?.outcome || null, via: 'voice' } })
      persistInteractionsSnapshot(result.result?.outcome)
    } else {
      addNotice({ kind: 'status', severity: 'warning', text: '这条回答没有生效：' + String(result?.error?.code || '未知原因') + '。请重新确认选项；不用换成新任务。', diagnosticId: 'ANSWER_REJECTED' })
    }
    emit('interactions.changed', { data: pendingInteractions() })
    return { interactionId: interaction.id, outcome: result?.result?.outcome || result?.error?.code || 'unknown' }
  }

  function persistInteractionsSnapshot(outcome) {
    if (!outcome) return
    recentlyResolved.push({ id: newId('resolved-'), outcome: String(outcome), resolvedAt: nowIso(), source: 'voice' })
    while (recentlyResolved.length > 8) recentlyResolved.shift()
  }

  function requestCancelConfirmation() {
    if (turn.snapshot().state === 'idle') {
      addNotice({ kind: 'status', severity: 'info', text: '当前没有正在运行的任务。', diagnosticId: 'NO_ACTIVE_TURN' })
      return { commands: [], detail: { outcome: 'no-active-turn' } }
    }
    const target = cancelTarget()
    pendingCancel = { token: newId('cancel-'), target, expiresAt: now() + cancelConfirmMs }
    if (cancelTimer) clearTimeout(cancelTimer)
    cancelTimer = setTimeout(() => { pendingCancel = null; cancelTimer = null }, cancelConfirmMs)
    cancelTimer.unref?.()
    addNotice({
      kind: 'status', severity: 'warning', ttlMs: cancelConfirmMs,
      text: '要停止当前任务吗？说“确认停止任务”。停止播报不会停止任务。',
      actions: [{ id: 'confirm-cancel-task', label: '确认停止任务' }],
    })
    return { commands: [], detail: { outcome: 'cancel-confirmation-required', expiresAt: iso(pendingCancel.expiresAt) } }
  }

  function cancelTarget() {
    const state = turn.snapshot()
    return {
      hostEpoch,
      sessionId: currentSession(),
      turn: state.turn ?? null,
      clientTurnId: state.clientTurnId || null,
      capturedAt: now(),
    }
  }

  /**
   * Stop the task that one request names.
   *
   * A stop is only forwarded for a target that was captured when the user asked
   * — either read back from the live turn model at confirmation time, or supplied
   * by a client that saw that turn. A request that names nothing, or names a turn
   * that already ended, is refused: answering `resolved` for whatever happens to
   * be running is how a late confirmation cancels a successor task.
   * @param {object} options - `source`, `explicitTarget` (client-observed), `confirmToken`.
   * @returns {object} command receipt; `resolved` only when DSH confirmed the exact target.
   */
  async function requestCancelTask({ source = 'control.cancel-task', explicitTarget = null, confirmToken = null } = {}) {
    const state = turn.snapshot()
    if (state.state === 'idle') return { status: 'rejected', error: { code: 'NO_ACTIVE_TURN', message: 'no active turn' }, result: {} }
    const current = currentCancelScope({ execution: state, sessionId: currentSession(), hostEpoch })
    // A client-supplied target must prove it still names this turn before it can
    // stand in for the confirmation token: an unnamed stop keeps the token gate.
    let bound = null
    if (explicitTarget !== null && explicitTarget !== undefined) {
      try {
        bound = assertTaskCancelTarget({ target: explicitTarget, current, hostEpoch })
      } catch (error) {
        return { status: 'rejected', error: { code: error.code || 'INVALID_CANCEL_TARGET', message: error.message }, result: {} }
      }
    }
    if (pendingCancel) {
      if (!confirmToken || confirmToken !== pendingCancel.token) {
        return { status: 'rejected', error: { code: 'STALE_CANCEL_REQUEST', message: 'cancel request expired or replaced' }, result: {} }
      }
      if (bound !== null && pendingCancel.target !== null) {
        for (const field of ['sessionId', 'turn', 'clientTurnId']) {
          const wanted = pendingCancel.target[field]
          if (wanted !== undefined && wanted !== null && bound[field] !== undefined && String(bound[field]) !== String(wanted)) {
            return { status: 'rejected', error: { code: 'STALE_CANCEL_REQUEST', message: 'the confirmation names a different turn than the captured target' }, result: {} }
          }
        }
      }
    } else if (bound === null) {
      // No confirmation is pending and no target was named: ask, never guess.
      return { status: 'rejected', error: { code: 'CONFIRMATION_REQUIRED', message: '停止任务需要确认：请说“确认停止任务”或提供本次任务的 target' }, result: {}, confirmation: requestCancelConfirmation().detail }
    }
    // The pending confirmation is the only other legal source, and its target was
    // captured when it was created; `cancelTarget()` is never consulted here.
    const target = bound ?? pendingCancel?.target ?? null
    if (target === null) return { status: 'rejected', error: { code: 'CANCEL_TARGET_REQUIRED', message: 'a task stop must name the turn it stops' }, result: {} }
    try {
      // The captured target must still be the live one. A confirmation that
      // outlived its turn is refused here, before the owner is asked, so a
      // successor turn is never even a candidate for it.
      assertTaskCancelTarget({ target, current, hostEpoch })
    } catch (error) {
      pendingCancel = null
      if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null }
      return { status: 'rejected', error: { code: 'STALE_CANCEL_REQUEST', message: 'the confirmed target is no longer the active turn: ' + error.message }, result: {} }
    }
    pendingCancel = null
    if (cancelTimer) { clearTimeout(cancelTimer); cancelTimer = null }
    turn.requestCancel({ target })
    emit('execution.changed', { data: turn.snapshot() })
    persistState('turn-cancel-requested')
    addNotice({ kind: 'status', severity: 'warning', text: '已请求停止任务，等待 DSH 确认。', ttlMs: 5000, diagnosticId: 'CANCEL_REQUESTED' })
    let result
    try {
      result = await runtime.cancelTurn({ source, target })
    } catch (error) {
      result = { cancelled: false, error: String(error?.message || error) }
    }
    const confirmed = result?.confirmed === true && result?.cancelled !== false
    if (confirmed) {
      turn.cancelConfirmed()
      addNotice({ kind: 'status', severity: 'info', text: 'DSH 已确认任务停止。', ttlMs: 5000 })
    } else if (result?.cancelled === true) {
      scheduleCancelUnknown(target)
    } else {
      turn.markUnknown('cancel-failed')
      addNotice({ kind: 'error', severity: 'error', text: '取消请求未被确认，任务结果未知。请打开主窗口检查；不会自动重试。', diagnosticId: 'CANCEL_UNKNOWN' })
    }
    emit('execution.changed', { data: turn.snapshot() })
    persistState(confirmed ? 'turn-ended' : 'turn-cancel-pending')
    return { status: confirmed ? 'resolved' : 'pending', result: { ...result, target: { sessionId: target.sessionId, turn: target.turn } } }
  }

  function scheduleCancelUnknown(target) {
    if (cancelTimer) clearTimeout(cancelTimer)
    cancelTimer = setTimeout(() => {
      cancelTimer = null
      const state = turn.snapshot()
      if (state.state !== 'cancel-requested') return
      turn.markUnknown('cancel-not-confirmed')
      emit('execution.changed', { data: turn.snapshot() })
      addNotice({ kind: 'error', severity: 'error', text: 'DSH 未在等待窗口内确认取消，任务结果未知；不会自动重放。', diagnosticId: 'CANCEL_UNKNOWN' })
      persistState('turn-cancel-unknown')
    }, cancelConfirmMs)
    cancelTimer.unref?.()
  }

  // ---------------- input admission / queue / draft ----------------

  async function acceptInput(segment, utterance) {
    const text = String(segment.text || '').trim()
    if (!text) return { outcome: 'ignore', detail: { reason: 'empty' } }
    if (utterance.legacyDirect === true) {
      if (turn.isBusy() || isMainWindowTurn()) return { outcome: 'busy', detail: { reason: 'agent-busy' } }
      const direct = await admitDirect(text, { source: 'voice', clientTurnId: utterance.clientTurnId || '', metadata: { captureId: utterance.captureId } })
      return { outcome: direct.ok ? 'submitted' : 'submit-failed', detail: { error: direct.error || null } }
    }
    const confirmation = segment.requiresConfirmation === true
      ? { needed: true, reason: 'segment-requires-confirmation' }
      : needsConfirmation(text, { mode: utterance.mode || capture.mode, assembled: utterance.assembled !== false })
    if (confirmation.needed) {
      if (draft.snapshot()) {
        addNotice({ kind: 'status', severity: 'warning', text: '已有一个待确认输入；请先在气泡里确认或取消。', diagnosticId: 'DRAFT_EXISTS' })
        return { outcome: 'draft-conflict', detail: { reason: 'existing-draft' } }
      }
      try {
        draft.offer({ text, source: 'voice', captureId: utterance.captureId, metadata: { reason: confirmation.reason, mode: utterance.mode || capture.mode } })
      } catch (error) {
        addNotice({ kind: 'status', severity: 'warning', text: '已有一个待确认输入；请先在气泡里确认或取消。', diagnosticId: 'DRAFT_EXISTS' })
        return { outcome: 'draft-conflict', detail: { reason: 'existing-draft' } }
      }
      emit('input-draft.changed', { data: { draft: draft.snapshot() } })
      persistState('draft-offered')
      addNotice({ kind: 'input', severity: 'info', text, ttlMs: draftTtlMs, diagnosticId: 'INPUT_CONFIRMATION', actions: [{ id: 'confirm-input', label: '发送' }, { id: 'cancel-input', label: '取消' }] })
      return { outcome: 'draft-offered', detail: { reason: confirmation.reason } }
    }
    if (turn.isBusy() || isMainWindowTurn()) {
      try {
        const item = queue.add({ text, source: 'voice', metadata: { captureId: utterance.captureId, mode: utterance.mode } })
        emit('queue.changed', { data: queue.snapshot() })
        persistState('queue-added')
        addNotice({ kind: 'status', severity: 'info', text: '任务在忙，这句话已加入等待队列。', ttlMs: 4000 })
        return { outcome: 'queued', detail: { queueItemId: item.id } }
      } catch (error) {
        addNotice({ kind: 'error', severity: 'error', text: String(error?.message || '队列已满'), diagnosticId: 'QUEUE_FULL' })
        draft.offer({ text, source: 'voice', captureId: utterance.captureId, metadata: { queueFull: true } })
        emit('input-draft.changed', { data: { draft: draft.snapshot() } })
        return { outcome: 'queue-full-draft', detail: {} }
      }
    }
    const result = await admitDirect(text, { source: 'voice', clientTurnId: utterance.clientTurnId || '', metadata: { captureId: utterance.captureId, mode: utterance.mode } })
    return { outcome: result.ok ? 'submitted' : 'submit-failed', detail: { error: result.error || null } }
  }

  /**
   * Adapter entry for transports that already deliver one assembled final utterance
   * (the pre-v2 worker's /voice/turn). The business decision is still made here.
   */
  async function handleFinalUtterance({ text, captureId = null, utteranceId = null, mode = 'hold', clientTurnId = '', source = 'voice', connectionId = null, direct = false } = {}) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return { routed: [], commands: [], utterances: 0 }
    if (connectionId) {
      workerConnection.connectionId = String(connectionId)
      workerConnection.state = 'connected'
      workerConnection.lastSeenAt = nowIso()
    }
    const utterance = {
      utteranceId: utteranceId || newId('utt-'), captureId: captureId || newId('cap-'),
      mode, text: trimmed, assembled: true, late: false, clientTurnId, legacyDirect: direct === true,
      segments: [{ segmentId: 'final', text: trimmed, itemIds: [], revision: 0 }],
      createdAt: now(),
    }
    capture.mode = ['hold', 'toggle', 'always'].includes(mode) ? mode : capture.mode
    const result = await routeUtterance(utterance)
    syncCaptureState()
    emitCaptureChanged()
    return { ...result, utterances: 1 }
  }

  function isMainWindowTurn() {
    return turn.isMainWindowTurn?.() === true
  }

  async function admitDirect(text, { source = 'voice', clientTurnId = '', metadata = {} } = {}) {
    if (disposed) return { ok: false, error: 'disposed' }
    if (admission) return { ok: false, error: 'admission-busy' }
    const own = {}
    admission = own
    turn.beginAdmission({ sessionId: currentSession(), clientTurnId: clientTurnId || newId('client-turn-'), inputSource: source, text })
    emit('execution.changed', { data: turn.snapshot() })
    persistState('turn-started')
    try {
      await runtime.ensureAgent()
      const result = await runtime.submitTurn(text, { source: source === 'queue' ? 'queue' : source, clientTurnId: clientTurnId || undefined })
      admissionTask = null
      turn.admitted({ turn: result?.turn ?? null })
      emit('execution.changed', { data: turn.snapshot() })
      emit('turn.started', { source: source === 'desktop' ? 'desktop' : source === 'queue' ? 'host' : 'worker', sessionId: currentSession(), data: { inputSource: source, chars: text.length } })
      persistState('turn-started')
      return { ok: true, result }
    } catch (error) {
      admissionTask = null
      turn.markUnknown('admission-failed')
      emit('execution.changed', { data: turn.snapshot() })
      addNotice({ kind: 'error', severity: 'error', text: '任务没有成功交给 DSH：' + boundedString(error?.message || error, 300) + '。输入已保留在待确认区。', diagnosticId: 'ADMISSION_FAILED' })
      if (!draft.snapshot()) {
        draft.offer({ text, source: source === 'queue' ? 'queue' : 'voice', metadata })
        emit('input-draft.changed', { data: { draft: draft.snapshot() } })
      }
      persistState('admission-failed')
      return { ok: false, error: boundedString(error?.message || error, 300) }
    } finally {
      if (admission === own) admission = null
      admissionTask = null
      drainQueue()
    }
  }

  function drainQueue() {
    if (disposed || admission || admissionTask) return
    if (turn.isBusy() || isMainWindowTurn()) return
    if (typeof runtime.agentReady === 'function' && runtime.agentReady() !== true) return
    let item = null
    try { item = queue.take() } catch { item = null }
    if (!item) return
    queue.snapshot()
    admissionTask = admitDirect(item.text, { source: 'queue', metadata: item.metadata || {} }).then((result) => {
      if (!result.ok) {
        try { queue.restore(item) } catch { /* already gone */ }
        emit('queue.changed', { data: queue.snapshot() })
      }
      return result
    }).finally(() => { admissionTask = null })
  }

  // ---------------- worker command / speech identity ----------------

  const pendingCommands = new Map()
  const speechSeq = new Map()
  const greetedConnections = new Set()

  /** Single outbound-command helper: records identity so acks can be matched to their effect. */
  function emitCommand(type, payload = {}) {
    const commandId = runtime.emitCommand(type, payload)
    pendingCommands.set(commandId, { type, payload, at: now() })
    if (pendingCommands.size > 256) pendingCommands.delete(pendingCommands.keys().next().value)
    return commandId
  }

  function speechKey(sessionId, turnNumber) {
    return `${sessionId || ''}:${turnNumber ?? ''}`
  }

  /** Host-owned welcome trigger: the worker only plays the text (never decides to greet). */
  function sendGreeting(connectionId) {
    const id = String(connectionId || workerConnection.connectionId || 'worker')
    if (greetedConnections.has(id)) return null
    greetedConnections.add(id)
    if (greetedConnections.size > 32) greetedConnections.delete(greetedConnections.values().next().value)
    const turnId = 'welcome-' + id + '-' + newId().slice(0, 8)
    let greeting = ''
    try { greeting = String(runtime.greeting?.() || '') } catch { greeting = '' }
    const text = greeting || '我在。按住 Option 说话，或者点一下麦克风。'
    emitCommand('speech.append', { turnId, text, seq: 1 })
    emitCommand('speech.end', { turnId, reason: 'greeting' })
    playback.playbackId = turnId
    playback.state = 'speaking'
    playback.updatedAt = nowIso()
    emit('playback.changed', { data: { state: 'speaking', playbackId: turnId, reason: 'greeting' } })
    addNotice({ kind: 'speech', severity: 'info', text, ttlMs: 6000 })
    return turnId
  }

  // ---------------- observed DSH turn lifecycle ----------------

  function onTurnStarted({ sessionId = null, turnId = null, turn: turnNumber = null, inputSource = 'desktop', hostInitiated = false } = {}) {
    if (disposed) return
    const isHost = hostInitiated || inputSource === 'voice' || inputSource === 'queue'
    turn.observeTurnStart({ turnId, turn: turnNumber, inputSource: isHost ? 'voice' : 'desktop' })
    if (!isHost) {
      addNotice({ kind: 'status', severity: 'info', text: '主窗口直接开始了任务；等待队列已暂停，不会重复提交。', ttlMs: 5000 })
    }
    emit('execution.changed', { data: turn.snapshot(), sessionId, turn: turnNumber })
    emit('turn.started', { source: isHost ? 'host' : 'dsh', sessionId, turn: turnNumber, data: { inputSource: isHost ? 'host' : 'desktop' } })
    persistState('turn-started')
  }

  function onTurnEnded({ sessionId = null, turn: turnNumber = null, terminal = 'unknown', reason = null } = {}) {
    if (disposed) return
    const state = turn.snapshot()
    lastTurn = { turn: turnNumber ?? state.turn ?? null, terminal: String(terminal || 'unknown'), reason: reason ?? null }
    turn.observeTurnEnd({ turnId: `${sessionId || ''}:${turnNumber ?? ''}`, turn: turnNumber, terminal: String(terminal || 'unknown'), reason, official: true })
    emit('execution.changed', { data: turn.snapshot(), sessionId, turn: turnNumber })
    emit('turn.ended', { source: 'dsh', sessionId, turn: turnNumber, data: { terminal: String(terminal || 'unknown'), reason } })
    const settled = ['completed', 'end_turn', 'turn-end'].includes(String(terminal || ''))
    if (settled) {
      persistState('turn-ended')
      drainQueue()
    } else {
      // Interrupted/cancelled/failed turns never silently re-execute queued input: keep
      // every text and require explicit confirmation after the user inspects the result.
      try {
        const quarantined = queue.quarantineAll('turn-' + String(terminal || 'unknown'))
        if (quarantined?.quarantined) {
          emit('queue.changed', { data: queue.snapshot() })
          addNotice({ kind: 'warning', severity: 'warning', text: '上次任务未正常结束；等待队列已转为待确认，不会自动执行。', diagnosticId: 'QUEUE_QUARANTINED' })
        }
      } catch (error) { log('queue quarantine failed: ' + String(error?.message || error)) }
      persistState('turn-ended-' + String(terminal || 'unknown'))
    }
  }

  function onAssistantDelta({ sessionId = null, turn: turnNumber = null, text = '' } = {}) {
    if (!text || disposed) return
    const turnId = speechKey(sessionId, turnNumber)
    const seq = (speechSeq.get(turnId) || 0) + 1
    speechSeq.set(turnId, seq)
    if (speechSeq.size > 32) speechSeq.delete(speechSeq.keys().next().value)
    playback.state = 'speaking'
    playback.playbackId = turnId
    playback.sourceTurnId = turnId
    playback.updatedAt = nowIso()
    emitCommand('speech.append', { turnId, turn: turnNumber, text: String(text).slice(0, 8000), seq })
    emit('playback.changed', { source: 'dsh', sessionId, turn: turnNumber, data: { state: 'speaking', playbackId: turnId, seq } })
    emit('turn.delta', { source: 'dsh', sessionId, turn: turnNumber, data: { text: String(text).slice(0, 500) } })
  }

  function onAssistantEnded({ sessionId = null, turn: turnNumber = null, outcome = 'completed' } = {}) {
    if (disposed) return
    const turnId = speechKey(sessionId, turnNumber)
    emitCommand('speech.end', { turnId, turn: turnNumber, reason: String(outcome) })
    speechSeq.delete(turnId)
    if (playback.playbackId === turnId || !playback.playbackId) {
      playback.state = 'idle'
      playback.updatedAt = nowIso()
      emit('playback.changed', { source: 'dsh', sessionId, turn: turnNumber, data: { state: 'idle', playbackId: turnId } })
    }
  }


  function onAgentStatus(status) {
    if (disposed) return
    if (status === 'idle') {
      const state = turn.snapshot()
      if (state.state === 'working' || state.state === 'submitting') {
        // The durable turn/end observer is authoritative; status alone must not
        // fabricate a completion. Only clear an admission that never became a turn.
        if (admissionTask === null && state.state === 'submitting') turn.markUnknown('agent-idle-without-turn')
      }
      drainQueue()
    }
  }

  /**
   * The Bot conversation was rotated or its Agent was disposed for refresh. Execution
   * state must not stay 'working' (a disposed Agent never emits a turn/end), and any
   * unsubmitted queue entry must require explicit confirmation instead of being drained
   * into a half-created Agent.
   */
  function onConversationRotated(reason = 'rotation') {
    if (disposed) return
    turn.reset()
    try {
      const quarantined = queue.quarantineAll('conversation-' + String(reason))
      if (quarantined?.quarantined) emit('queue.changed', { data: queue.snapshot() })
    } catch (error) { log('queue quarantine on rotation failed: ' + String(error?.message || error)) }
    emit('execution.changed', { data: turn.snapshot(), dataReason: reason })
    persistState('conversation-rotated')
  }

  // ---------------- commands ----------------

  function touchDesktop(sourceConnectionId, sessionId) {
    noteDesktopSeen()
  }

  /**
   * Any authenticated desktop poll/receipt proves the product UI is connected. Without
   * this, a UI that only reads snapshots/events would never appear in connection state.
   */
  function noteDesktopSeen() {
    const was = desktopConnection.connected
    desktopConnection.connected = true
    desktopConnection.lastSeenAt = nowIso()
    if (!was) {
      emit('connection.changed', { data: { desktop: { connected: true } } })
      // A returning desktop is the moment the user can actually see the hint: restore
      // an unconfirmed-interaction warning whose notice already expired. Read-only.
      syncUnknownInteractions({ announceExisting: true })
    }
  }

  function listInteractions() {
    const snapshot = pendingInteractions()
    return { ...snapshot, recentlyResolved: [...(snapshot.recentlyResolved || []), ...recentlyResolved].slice(-8) }
  }

  async function handleCommand(command) {
    if (disposed) throw new ContractError('HOST_DISPOSED', 'host disposed', 503)
    if (command.sourceConnectionId === 'desktop') touchDesktop()
    switch (command.type) {
      case 'voice.session': {
        const payload = command.payload
        const previous = workerConnection.state
        workerConnection.connectionId = payload.connectionId ? String(payload.connectionId) : workerConnection.connectionId
        workerConnection.state = payload.transport === 'connected' ? 'connected' : 'disconnected'
        workerConnection.lastSeenAt = nowIso()
        emit('connection.changed', { data: { worker: { ...workerConnection } } })
        // A microphone connection that dropped cannot still be recording. Clear
        // the projection so no stale "取消录音" bubble survives a transport loss.
        if (workerConnection.state === 'disconnected' && RECORDING_CAPTURE_STATES.has(capture.state)) {
          capture.state = 'off'
          capture.preview = null
          capture.updatedAt = nowIso()
          emitCaptureChanged()
        }
        if (workerConnection.state === 'connected' && previous !== 'connected') sendGreeting(workerConnection.connectionId)
        return { status: 'accepted', result: { connectionId: workerConnection.connectionId } }
      }
      case 'voice.facts': {
        const payload = command.payload
        if (payload.connectionId) {
          workerConnection.connectionId = String(payload.connectionId)
          workerConnection.state = 'connected'
          workerConnection.lastSeenAt = nowIso()
        }
        applyCaptureFacts(payload)
        const ready = assembler.tick()
        const routed = []
        const commands = []
        for (const utterance of ready) {
          const result = await routeUtterance(utterance)
          routed.push(...result.routed)
          commands.push(...(result.commands || []))
        }
        syncCaptureState()
        emitCaptureChanged()
        return { status: 'accepted', result: { routed, commands, utterances: ready.length } }
      }
      case 'interaction.resolve':
      case 'interaction.draft.select':
      case 'interaction.draft.custom': {
        if (!registry) return { status: 'rejected', error: { code: 'REGISTRY_UNAVAILABLE', message: 'interaction registry unavailable' } }
        const payload = command.payload
        let receiptResult
        if (command.type === 'interaction.resolve') {
          receiptResult = registry.resolve({
            commandId: command.commandId,
            interactionId: payload.interactionId,
            semanticRevision: payload.semanticRevision,
            payload,
            sourceConnectionId: command.sourceConnectionId,
          })
        } else if (command.type === 'interaction.draft.select') {
          receiptResult = registry.draftSelect({ commandId: command.commandId, ...payload })
        } else {
          receiptResult = registry.draftCustom({ commandId: command.commandId, ...payload })
        }
        emit('interactions.changed', { data: listInteractions() })
        // Only a real resolution is a resolution event; a successful draft edit is not.
        if (command.type === 'interaction.resolve' && (receiptResult?.status === 'resolved' || receiptResult?.status === 'accepted')) {
          emit('interaction.resolved', { data: { id: payload.interactionId, outcome: receiptResult.result?.outcome || null, via: command.sourceConnectionId } })
        }
        return receiptResult || { status: 'unknown', error: { code: 'REGISTRY_NO_RESULT', message: 'registry returned no receipt' } }
      }
      case 'queue.list': {
        const snapshot = queue.snapshot()
        return { status: 'accepted', result: { revision: snapshot.revision, items: snapshot.items.map((item) => normalizeQueueItem(item, snapshot.revision)) } }
      }
      case 'queue.edit':
      case 'queue.delete':
      case 'queue.confirm': {
        const payload = command.payload
        const action = command.type === 'queue.edit' ? 'edit' : command.type === 'queue.delete' ? 'delete' : 'confirm'
        try {
          queue.edit(String(payload.id || ''), Number(payload.revision), action, action === 'edit' ? payload.text : undefined)
        } catch (error) {
          return { status: 'rejected', error: { code: 'QUEUE_CONFLICT', message: boundedString(error?.message || error, 300) } }
        }
        const snapshot = queue.snapshot()
        emit('queue.changed', { data: snapshot })
        persistState('queue-changed')
        if (action === 'confirm') drainQueue()
        return { status: 'accepted', result: { revision: snapshot.revision, items: snapshot.items.map((item) => normalizeQueueItem(item, snapshot.revision)) } }
      }
      case 'input.confirm': {
        const payload = command.payload
        let confirmed
        try { confirmed = draft.confirm(String(payload.id || ''), Number(payload.revision), payload.text) }
        catch (error) { return { status: 'rejected', error: { code: 'DRAFT_CONFLICT', message: boundedString(error?.message || error, 300) } } }
        emit('input-draft.changed', { data: { draft: draft.snapshot() } })
        persistState('draft-confirmed')
        const result = await admitDirect(confirmed.item.text, { source: 'voice', metadata: {} })
        return { status: result.ok ? 'accepted' : 'unknown', result: { ok: result.ok }, ...(result.ok ? {} : { error: { code: 'ADMISSION_FAILED', message: result.error || 'admission failed' } }) }
      }
      case 'input.edit': {
        const payload = command.payload
        try { draft.edit(String(payload.id || ''), Number(payload.revision), String(payload.text || '')) }
        catch (error) { return { status: 'rejected', error: { code: 'DRAFT_CONFLICT', message: boundedString(error?.message || error, 300) } } }
        emit('input-draft.changed', { data: { draft: draft.snapshot() } })
        persistState('draft-edited')
        return { status: 'accepted', result: { draft: draft.snapshot() } }
      }
      case 'input.reject': {
        const payload = command.payload
        try { draft.reject(String(payload.id || ''), Number(payload.revision)) }
        catch (error) { return { status: 'rejected', error: { code: 'DRAFT_CONFLICT', message: boundedString(error?.message || error, 300) } } }
        emit('input-draft.changed', { data: { draft: draft.snapshot() } })
        persistState('draft-rejected')
        return { status: 'accepted', result: { draft: null } }
      }
      case 'control.stop-playback': {
        const playbackId = command.payload.playbackId || playback.playbackId
        playback.state = 'stopping'
        playback.updatedAt = nowIso()
        const commandId = emitCommand('playback.stop', { playbackId: playbackId || null, reason: 'explicit' })
        emit('playback.changed', { data: { state: playback.state, playbackId } })
        return { status: 'accepted', result: { commandId, playbackId: playbackId || null } }
      }
      case 'control.cancel-capture': {
        const captureId = String(command.payload.captureId || capture.captureId || '')
        if (!captureId) return { status: 'rejected', error: { code: 'NO_CAPTURE', message: 'no active capture' } }
        // Older builds left the projection in "closing"/"transcribing" after the
        // recording ended, so a stale bubble could still send this command. Only
        // a recording the user can still hear is cancellable; otherwise say so
        // instead of pretending the cancel worked.
        const active = RECORDING_CAPTURE_STATES.has(capture.state) && captureId === capture.captureId
        if (!active) {
          addNotice({ kind: 'status', severity: 'info', text: '这次录音已经结束，没有需要取消的录音；任务不受影响。', ttlMs: 4000 })
          return { status: 'rejected', error: { code: 'NO_ACTIVE_CAPTURE', message: 'capture already ended' } }
        }
        const commandId = emitCommand('capture.command', { action: 'discard', captureId, reason: 'user-cancel' })
        try { assembler.release({ captureId, discard: true }) } catch { /* tombstone is best effort; the worker also discards locally */ }
        capture.state = 'off'
        capture.preview = null
        capture.lastDiscardAt = nowIso()
        capture.updatedAt = nowIso()
        emitCaptureChanged()
        addNotice({ kind: 'status', severity: 'info', text: '已取消录音；任务不受影响。', ttlMs: 4000 })
        return { status: 'accepted', result: { commandId, captureId } }
      }
      case 'control.cancel-task':
        return requestCancelTask({
          source: 'control.cancel-task',
          confirmToken: command.payload.confirmToken || null,
          explicitTarget: commandCancelTarget(command.payload, { hostEpoch }) ?? null,
        }).then((value) => value)
      case 'control.playback-style': {
        playback.style = command.payload.style === 'brief' ? 'brief' : 'full'
        const commandId = emitCommand('playback.style', { style: playback.style })
        persistState('playback-style')
        return { status: 'accepted', result: { commandId, style: playback.style } }
      }
      case 'presentation.ack': {
        const payload = command.payload
        if (payload?.commandId && ackedCommands.has(String(payload.commandId))) {
          return { status: 'resolved', result: { duplicate: true } }
        }
        if (payload?.commandId) {
          ackedCommands.add(String(payload.commandId))
          if (ackedCommands.size > 512) ackedCommands.delete(ackedCommands.values().next().value)
        }
        const acknowledged = payload?.commandId ? pendingCommands.get(String(payload.commandId)) : null
        if (acknowledged) pendingCommands.delete(String(payload.commandId))
        const ackedPlaybackId = payload?.playbackId
          || (acknowledged && ['speech.append', 'speech.end', 'playback.stop'].includes(acknowledged.type)
            ? acknowledged.payload?.turnId || acknowledged.payload?.playbackId || null
            : null)
        if (ackedPlaybackId && ackedPlaybackId === playback.playbackId && payload?.state === 'applied') {
          playback.state = 'idle'
          playback.updatedAt = nowIso()
          emit('playback.changed', { data: { state: playback.state, playbackId: playback.playbackId } })
        } else if (payload?.playbackId && payload.playbackId === playback.playbackId) {
          playback.state = payload.state === 'applied' ? 'idle' : String(payload.state || 'idle')
          playback.updatedAt = nowIso()
          emit('playback.changed', { data: { state: playback.state, playbackId: playback.playbackId } })
        }
        return { status: 'accepted', result: { acked: true } }
      }
      case 'task.status': {
        return {
          status: 'accepted',
          result: {
            execution: turn.snapshot(), lastTurn,
            mainWindowTurn: isMainWindowTurn(), queuePending: queue.snapshot().items.length,
          },
        }
      }
      default:
        return { status: 'rejected', error: { code: 'UNKNOWN_COMMAND', message: 'unknown command type: ' + command.type } }
    }
  }

  // ---------------- snapshot ----------------

  function snapshotSections() {
    const interactions = listInteractions()
    const draftView = draft.snapshot()
    const queueView = queue.snapshot()
    const execution = turn.snapshot()
    const identity = {
      product: 'dsh-bot',
      productVersion: String(runtime.productVersion?.() || productIdentity().productVersion),
      runtimeVersion: String(runtime.runtimeVersion?.() || productIdentity().runtimeVersion),
      sessionId: currentSession(),
      botSessionReady: runtime.agentReady?.() === true,
      workspace: runtime.workspace?.() || '',
      conversationIndex: Number(runtime.conversationIndex?.() || 1),
      hostPid: process.pid,
      hostEpoch,
    }
    const pending = Array.isArray(interactions.pending) ? interactions.pending : []
    const unknown = normalizeUnknownInteractions(interactions.unknown)
    const displayMode = pending.length ? 'awaiting-input'
      : draftView ? 'confirming'
        : ['working', 'submitting'].includes(execution.state) ? 'working'
          : unknown.length ? 'unknown'
            : execution.state === 'unknown' ? 'error'
              : ['listening', 'transcribing', 'closing'].includes(capture.state) ? 'listening'
                : playback.state === 'speaking' ? 'speaking'
                  : playback.state === 'stopping' ? 'stopping'
                    : 'idle'
    const focused = pending.find((item) => item.id === interactions.focusedId) || pending[0] || null
    return {
      identity,
      connection: {
        worker: { state: workerStateNow(), connectionId: workerConnection.connectionId, lastSeenAt: workerConnection.lastSeenAt },
        desktop: {
          connected: desktopConnectedNow(),
          lastSeenAt: desktopConnection.lastSeenAt,
          lastEventSeq: events.seq(),
        },
      },
      capture: { ...capture, updatedAt: capture.updatedAt || null },
      playback: { ...playback, updatedAt: playback.updatedAt || null },
      execution: {
        state: execution.state,
        sessionId: execution.sessionId ?? currentSession(),
        requestId: execution.requestId ?? null,
        clientTurnId: execution.clientTurnId || null,
        turn: execution.turn ?? null,
        startedAt: iso(execution.startedAt),
        inputSource: execution.inputSource || 'desktop',
        cancelRequestedAt: iso(execution.cancelRequestedAt),
        cancelTarget: execution.cancelTarget || null,
        lastTurn: lastTurn || execution.lastTurn || { turn: null, terminal: null, reason: null },
        mainWindowTurn: isMainWindowTurn(),
      },
      interactions: {
        focusedId: interactions.focusedId ?? focused?.id ?? null,
        pending,
        drafts: interactions.drafts || {},
        recentlyResolved: listInteractions().recentlyResolved,
        // Additive `snapshot@1` field (R2): final interactions whose official outcome
        // could not be confirmed. Empty on a clean session and on older Hosts absent.
        unknown,
      },
      inputDraft: draftView
        ? {
          id: draftView.id, text: draftView.text, source: draftView.source, captureId: draftView.captureId,
          createdAt: iso(draftView.createdAt), expiresAt: iso(draftView.expiresAt),
          revision: draftView.revision, status: draftView.status, needsConfirmation: true,
        }
        : null,
      queue: {
        revision: queueView.revision,
        items: queueView.items.map((item) => normalizeQueueItem(item, queueView.revision)),
      },
      notices: [...notices.values()],
      presentation: {
        displayMode,
        priority: ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices'],
        bubble: focused
          ? { visible: true, requestId: focused.id, kind: focused.kind }
          : draftView
            ? { visible: true, requestId: 'input:' + draftView.id, kind: 'input' }
            : { visible: false, requestId: null, kind: null },
        bubblePolicy: { placement: 'above', anchorGapPx: 24 },
      },
    }
  }

  // ---------------- lifecycle ----------------

  function tick() {
    if (disposed) return
    maybeSyncUnknownInteractions()
    if (syncCaptureState()) emitCaptureChanged()
    let ready = []
    try { ready = assembler.tick() } catch (error) { log('utterance tick failed: ' + String(error?.message || error)); return }
    if (!ready.length) return
    for (const utterance of ready) {
      void routeUtterance(utterance)
        .then(() => {
          if (disposed) return
          if (syncCaptureState()) emitCaptureChanged()
        })
        .catch((error) => log('utterance route failed: ' + String(error?.message || error)))
    }
  }

  let started = false
  function start() {
    if (started) return
    started = true
    restoreState()
    tickTimer = setInterval(tick, 100)
    tickTimer.unref?.()
    addNotice({ kind: 'status', severity: 'info', text: 'Host 已就绪；产品交互由 Host 统一记录。', ttlMs: 3000 })
    // Announced last so it is the notice the pet surface shows first after a crash restart.
    syncUnknownInteractions()
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (tickTimer) clearInterval(tickTimer)
    if (cancelTimer) clearTimeout(cancelTimer)
    for (const timer of noticeTimers.values()) clearTimeout(timer)
    noticeTimers.clear()
    persistState('shutdown')
  }

  return {
    start, dispose, tick,
    handleCommand, handleFinalUtterance,
    snapshotSections,
    onTurnStarted, onTurnEnded, onAssistantDelta, onAssistantEnded, onAgentStatus,
    onConversationRotated, noteDesktopSeen,
    // Presence is the product UI's own signal: the pet polls the v2 snapshot, the voice worker does not.
    desktopConnected: desktopConnectedNow,
    addNotice, listInteractions,
    // test/inspection helpers (not used as authority by clients)
    inspect: () => ({ queue: queue.snapshot(), draft: draft.snapshot(), turn: turn.snapshot(), capture: { ...capture }, playback: { ...playback }, pendingCancel }),
    queueModel: queue, draftModel: draft, turnModel: turn, assembler,
  }
}
