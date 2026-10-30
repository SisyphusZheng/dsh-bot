/**
 * Pure conversation state models for beta2 kernel v1 §3.6.
 *
 * `createQueueModel`   — unsubmitted input waiting list (limit 5 / TTL 60 s budget):
 *                        identity based, user-same-text is NOT deduplicated, overflow
 *                        rejects new admission instead of evicting, TTL expiry keeps
 *                        inspectable records, edit/delete/confirm are bound to the
 *                        queue revision + item identity, and a submitted item can
 *                        never be cancelled by a queue delete.
 * `createDraftModel`   — single unsubmitted voice draft requiring explicit confirmation
 *                        (TTL 30 s): single-use confirm, exact revision, no silent loss.
 * `createTurnModel`    — product projection of the official DSH turn lifecycle:
 *                        idle/submitting/working/cancel-requested/unknown/error,
 *                        main-window turn observation, cancel target captured at request
 *                        time + expiry to unknown, and only an official result settles it.
 *
 * All timestamps returned by these models are epoch-ms numbers from the injected
 * `now()`; ConversationService converts them to ISO-8601 when building Snapshot.
 * No I/O, no timers, no DSH calls: callers drive them.
 */
import { newId as contractNewId } from './contracts.mjs'

export const QUEUE_LIMIT_DEFAULT = 5
export const QUEUE_TTL_MS_DEFAULT = 60000
export const DRAFT_TTL_MS_DEFAULT = 30000
export const MAX_TEXT_DEFAULT = 20000
export const TURN_STATES = Object.freeze(['idle', 'submitting', 'working', 'cancel-requested', 'unknown', 'error'])
export const QUEUE_ITEM_STATUSES = Object.freeze(['waiting', 'confirming', 'submitting', 'unknown'])
export const DRAFT_STATUSES = Object.freeze(['pending', 'editing', 'submitting', 'confirmed', 'expired', 'rejected'])
const DRAFT_ACTIVE_STATUSES = new Set(['pending', 'editing', 'submitting'])

function modelError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertTunable(name, value, min, max) {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw modelError('INVALID_TUNABLE', `${name} must be a finite number between ${min} and ${max}`)
  }
  return value
}

function assertFunction(name, value) {
  if (typeof value !== 'function') throw modelError('INVALID_TUNABLE', `${name} must be a function`)
  return value
}

function copy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseTimestamp(value, fallback) {
  if (isFiniteNumber(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (fallback !== undefined) return fallback
  throw modelError('INVALID_RECORD', 'timestamp is invalid')
}

function normalizeSource(value, fallback = 'voice') {
  if (value === undefined || value === null || value === '') return fallback
  if (value !== 'voice' && value !== 'desktop') {
    throw modelError('INVALID_SOURCE', 'input source must be voice or desktop')
  }
  return value
}

function normalizeText(text, maxChars, field = 'text') {
  if (typeof text !== 'string') throw modelError('INVALID_TEXT', '请输入有效内容。')
  const value = text.trim()
  if (value === '') throw modelError('INVALID_TEXT', '请输入有效内容。')
  if (value.length > maxChars) throw modelError('INVALID_TEXT', `输入内容不能超过 ${maxChars} 个字符。`)
  return value
}

/* ------------------------------------------------------------------------- */
/* Input queue                                                               */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {number} [options.limit=5]        max waiting items
 * @param {number} [options.ttlMs=60000]    waiting TTL before explicit re-confirmation
 * @param {() => number} [options.now]      epoch-ms clock (injectable)
 */
export function createQueueModel({
  limit = QUEUE_LIMIT_DEFAULT,
  ttlMs = QUEUE_TTL_MS_DEFAULT,
  now = () => Date.now(),
  newId = contractNewId,
  maxChars = MAX_TEXT_DEFAULT,
  submittedRetention = 256,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw modelError('INVALID_TUNABLE', 'queue limit must be an integer between 1 and 20')
  }
  assertTunable('ttlMs', ttlMs, 1, 86400000)
  assertTunable('maxChars', maxChars, 1, 200000)
  assertTunable('submittedRetention', submittedRetention, 8, 2048)
  assertFunction('now', now)
  assertFunction('newId', newId)

  /** @type {object[]} — waiting items in FIFO order. Path/CAS-protected by `revision`. */
  let items = []
  let revision = 0
  let submittedIds = []
  const submittedSet = new Set()
  let lastQuarantineReason = null

  function clock() {
    const value = now()
    if (!isFiniteNumber(value)) throw modelError('INVALID_CLOCK', 'now() must return a finite epoch-ms number')
    return value
  }

  function findItem(id) {
    return items.find((item) => item.id === id) || null
  }

  function rememberSubmitted(id) {
    if (submittedSet.has(id)) return
    submittedSet.add(id)
    submittedIds.push(id)
    if (submittedIds.length > submittedRetention) {
      submittedSet.delete(submittedIds.shift())
    }
  }

  function viewItem(item, position, t) {
    const expired = t >= item.expiresAt
    const needsConfirmation = item.needsConfirmation === true || expired
    return {
      id: item.id,
      text: item.text,
      source: item.source,
      position,
      createdAt: item.createdAt,
      expiresAt: item.expiresAt,
      waitedSeconds: Math.max(0, Math.floor((t - item.createdAt) / 1000)),
      needsConfirmation,
      status: needsConfirmation ? 'confirming' : 'waiting',
    }
  }

  /**
   * Admit one input. Capacity overflow throws with a Chinese user message and
   * never evicts an existing item. `id` is the product input identity: re-adding
   * the same identity is rejected, but identical text with a new identity is a
   * legitimate repeated request and is admitted.
   */
  function add({ id, text, source = 'voice', metadata = {}, needsConfirmation = false } = {}) {
    const value = normalizeText(text, maxChars)
    const normalizedSource = normalizeSource(source)
    const inputId = id === undefined || id === null || id === '' ? newId() : String(id)
    if (inputId.length > 200) throw modelError('INVALID_ID', 'input id is too long')
    if (submittedSet.has(inputId)) {
      throw modelError('DUPLICATE_INPUT', '这条输入已经提交，不能再次加入队列。', 409)
    }
    if (findItem(inputId)) {
      throw modelError('DUPLICATE_INPUT', '这条输入已在等待队列中，未重复加入。', 409)
    }
    if (items.length >= limit) {
      throw modelError('QUEUE_FULL', '等待队列已满，请先处理现有输入。', 409)
    }
    const t = clock()
    const item = {
      id: inputId,
      text: value,
      source: normalizedSource,
      metadata: plainObject(metadata) ? copy(metadata) : {},
      createdAt: t,
      expiresAt: t + ttlMs,
      needsConfirmation: needsConfirmation === true,
      status: needsConfirmation === true ? 'confirming' : 'waiting',
    }
    items.push(item)
    revision += 1
    return { ...copy(item), position: items.length, waitedSeconds: 0, needsConfirmation: item.needsConfirmation, status: item.status }
  }

  function snapshot() {
    const t = clock()
    return {
      revision,
      items: items.map((item, index) => viewItem(item, index + 1, t)),
      lastQuarantineReason,
    }
  }

  /**
   * CAS mutation bound to both the queue revision and the item identity.
   * action: 'edit' | 'delete' | 'confirm'
   */
  function edit(id, expectedRevision, action, text) {
    if (expectedRevision !== revision) {
      throw modelError('STALE_QUEUE_REVISION', '队列已变化，请重新查看。', 409)
    }
    if (!['edit', 'delete', 'confirm'].includes(action)) {
      throw modelError('INVALID_QUEUE_ACTION', '不支持的队列操作。')
    }
    const item = findItem(id)
    if (!item) {
      if (submittedSet.has(id)) {
        throw modelError('ITEM_ALREADY_SUBMITTED', '这条输入已经提交，不能从等待队列中取消。', 409)
      }
      throw modelError('UNKNOWN_QUEUE_ITEM', '这条输入已被接收或删除。', 404)
    }
    const t = clock()
    if (action === 'delete') {
      items = items.filter((candidate) => candidate.id !== id)
      revision += 1
      return { ok: true, revision, deletedId: id }
    }
    if (action === 'edit') {
      item.text = normalizeText(text, maxChars)
      item.needsConfirmation = false
      item.status = 'waiting'
      item.expiresAt = t + ttlMs
      item.editedAt = t
    } else {
      item.needsConfirmation = false
      item.status = 'waiting'
      item.expiresAt = t + ttlMs
      item.confirmedAt = t
    }
    revision += 1
    return { ok: true, revision, item: { ...copy(item), position: items.indexOf(item) + 1 } }
  }

  /** Submit the first unconfirmed, unexpired item (strict FIFO: no overtaking). */
  function take() {
    const t = clock()
    if (items.length === 0) return null
    const first = items[0]
    if (first.needsConfirmation === true || t >= first.expiresAt) return null
    items.shift()
    revision += 1
    rememberSubmitted(first.id)
    const submitted = { ...copy(first), status: 'submitting', takenAt: t }
    return submitted
  }

  /**
   * Restore an exactly-taken item after an admission conflict (same identity,
   * text and original wait timestamps). Restore is a rollback of an existing
   * admission, not a new one, so it may temporarily exceed the limit instead of
   * dropping text.
   */
  function restore(item) {
    if (!plainObject(item)) throw modelError('INVALID_RESTORE', 'restore requires the item returned by take()')
    const id = String(item.id || '')
    if (id === '') throw modelError('INVALID_RESTORE', 'restore requires an item id')
    const value = normalizeText(item.text, maxChars)
    const source = normalizeSource(item.source)
    if (findItem(id)) throw modelError('DUPLICATE_INPUT', '这条输入已在等待队列中，未重复加入。', 409)
    submittedSet.delete(id)
    submittedIds = submittedIds.filter((candidate) => candidate !== id)
    const t = clock()
    const restored = {
      id,
      text: value,
      source,
      metadata: plainObject(item.metadata) ? copy(item.metadata) : {},
      createdAt: parseTimestamp(item.createdAt, t),
      expiresAt: parseTimestamp(item.expiresAt, t + ttlMs),
      needsConfirmation: item.needsConfirmation === true,
      status: 'waiting',
    }
    items.unshift(restored)
    revision += 1
    return { ...copy(restored), position: 1 }
  }

  /**
   * Restore persisted waiting inputs after a Host restart. Everything restored
   * requires explicit re-confirmation (never auto-executes); identity, text and
   * original timestamps are preserved. Malformed or conflicting records throw so
   * corruption is surfaced instead of silently dropped.
   */
  function restoreFromPersisted(records) {
    if (!Array.isArray(records)) throw modelError('INVALID_RECORD', 'persisted queue must be an array')
    if (records.length > 100) throw modelError('INVALID_RECORD', 'persisted queue record count is not bounded')
    const t = clock()
    const restored = []
    const seen = new Set()
    for (const record of records) {
      if (!plainObject(record)) throw modelError('INVALID_RECORD', 'persisted queue record must be an object')
      const id = String(record.id || '')
      if (id === '') throw modelError('INVALID_RECORD', 'persisted queue record is missing its id')
      if (seen.has(id) || findItem(id)) throw modelError('INVALID_RECORD', 'persisted queue has a duplicate item id')
      seen.add(id)
      const value = normalizeText(record.text, maxChars)
      const source = normalizeSource(record.source)
      restored.push({
        id,
        text: value,
        source,
        metadata: plainObject(record.metadata) ? copy(record.metadata) : {},
        createdAt: parseTimestamp(record.createdAt, t),
        expiresAt: parseTimestamp(record.expiresAt, t + ttlMs),
        needsConfirmation: true, // Host restart: always re-confirm, never auto-execute
        status: 'confirming',
        restoredAt: t,
      })
    }
    if (restored.length > 0) {
      items = [...restored, ...items]
      revision += 1
    }
    return { restored: restored.length, revision }
  }

  /** Session change / media disconnect: keep every text, require confirmation again. */
  function quarantineAll(reason = '') {
    const t = clock()
    for (const item of items) {
      item.needsConfirmation = true
      item.status = 'confirming'
      item.quarantinedAt = t
    }
    lastQuarantineReason = String(reason || '')
    if (items.length > 0) revision += 1
    return { quarantined: items.length, revision }
  }

  function get(id) {
    const item = findItem(id)
    return item ? copy(item) : null
  }

  function has(id) {
    return Boolean(findItem(id))
  }

  function isSubmitted(id) {
    return submittedSet.has(id)
  }

  return {
    add,
    snapshot,
    edit,
    take,
    restore,
    restoreFromPersisted,
    quarantineAll,
    revision: () => revision,
    size: () => items.length,
    limit: () => limit,
    ttlMs: () => ttlMs,
    get,
    has,
    isSubmitted,
    submittedIds: () => submittedIds.slice(),
  }
}

/* ------------------------------------------------------------------------- */
/* Input draft (confirmation required)                                       */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {number} [options.ttlMs=30000] confirmation TTL
 * @param {() => number} [options.now]   epoch-ms clock (injectable)
 */
export function createDraftModel({
  ttlMs = DRAFT_TTL_MS_DEFAULT,
  now = () => Date.now(),
  newId = contractNewId,
  maxChars = MAX_TEXT_DEFAULT,
  historyLimit = 16,
} = {}) {
  assertTunable('ttlMs', ttlMs, 1, 86400000)
  assertTunable('maxChars', maxChars, 1, 200000)
  assertTunable('historyLimit', historyLimit, 1, 128)
  assertFunction('now', now)
  assertFunction('newId', newId)

  let draft = null
  let history = []

  function clock() {
    const value = now()
    if (!isFiniteNumber(value)) throw modelError('INVALID_CLOCK', 'now() must return a finite epoch-ms number')
    return value
  }

  function effectiveStatus(value, t) {
    if (!value) return null
    if (DRAFT_ACTIVE_STATUSES.has(value.status) && t >= value.expiresAt) return 'expired'
    return value.status
  }

  function archive(value, status, t, extra = {}) {
    if (!value) return
    if (value.archived === true) return
    value.archived = true
    const record = {
      id: value.id,
      text: value.text,
      source: value.source,
      captureId: value.captureId,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      revision: value.revision,
      status,
      resolvedAt: t,
      ...extra,
    }
    history.push(record)
    if (history.length > historyLimit) history.shift()
  }

  function view(value, t) {
    if (!value) return null
    return {
      id: value.id,
      text: value.text,
      source: value.source,
      captureId: value.captureId,
      createdAt: value.createdAt,
      expiresAt: value.expiresAt,
      revision: value.revision,
      status: effectiveStatus(value, t),
      needsConfirmation: true,
      metadata: copy(value.metadata),
    }
  }

  function expire(t) {
    if (!draft) return []
    if (!DRAFT_ACTIVE_STATUSES.has(draft.status)) return []
    if (t < draft.expiresAt) return []
    draft.status = 'expired'
    draft.expiredAt = t
    archive(draft, 'expired', t)
    return [draft.id]
  }

  /**
   * Offer a voice/desktop input that requires confirmation. Only one draft is
   * active at a time; a fresh active draft is preserved (throws) and only an
   * expired/terminal draft is replaced. Returns the full draft object.
   */
  function offer({ text, source = 'voice', captureId = null, metadata = {} } = {}) {
    const value = normalizeText(text, maxChars)
    const normalizedSource = normalizeSource(source)
    if (captureId !== null && captureId !== undefined && typeof captureId !== 'string') {
      throw modelError('INVALID_DRAFT', 'draft captureId must be a string or null')
    }
    const t = clock()
    expire(t)
    if (draft && DRAFT_ACTIVE_STATUSES.has(draft.status) && t < draft.expiresAt) {
      throw modelError('DRAFT_PENDING', '已有待确认的输入，请先确认或取消后再试。', 409)
    }
    archive(draft, effectiveStatus(draft, t), t)
    draft = {
      id: newId(),
      text: value,
      source: normalizedSource,
      captureId: typeof captureId === 'string' ? captureId : null,
      metadata: plainObject(metadata) ? copy(metadata) : {},
      createdAt: t,
      expiresAt: t + ttlMs,
      revision: 1,
      status: 'pending',
      needsConfirmation: true,
    }
    return view(draft, t)
  }

  function snapshot() {
    return view(draft, clock())
  }

  function requireCurrent(id, expectedRevision, action) {
    const t = clock()
    if (!draft) throw modelError('DRAFT_UNKNOWN', '没有待确认的输入。', 404)
    if (draft.id !== id) throw modelError('DRAFT_UNKNOWN', '这条输入已失效，请查看当前待确认内容。', 404)
    if (DRAFT_ACTIVE_STATUSES.has(draft.status) && t >= draft.expiresAt) {
      draft.status = 'expired'
      draft.expiredAt = t
      archive(draft, 'expired', t)
      throw modelError('DRAFT_EXPIRED', '输入确认已过期，请重新输入。', 409)
    }
    if (!DRAFT_ACTIVE_STATUSES.has(draft.status)) {
      throw modelError('DRAFT_RESOLVED', '该输入已确认或已失效。', 409)
    }
    if (expectedRevision !== draft.revision) {
      throw modelError('STALE_DRAFT_REVISION', '输入已变化，请重新查看。', 409)
    }
    return t
  }

  /** Single-use confirmation with exact revision; returns the item to submit. */
  function confirm(id, expectedRevision, text) {
    const t = requireCurrent(id, expectedRevision, 'confirm')
    if (text !== undefined) draft.text = normalizeText(text, maxChars)
    draft.status = 'confirmed'
    draft.confirmedAt = t
    const item = {
      id: draft.id,
      text: draft.text,
      source: draft.source,
      captureId: draft.captureId,
      metadata: copy(draft.metadata),
      createdAt: draft.createdAt,
      confirmedAt: t,
      revision: draft.revision,
    }
    archive(draft, 'confirmed', t)
    return { ok: true, item }
  }

  function reject(id, expectedRevision) {
    const t = requireCurrent(id, expectedRevision, 'reject')
    draft.status = 'rejected'
    draft.rejectedAt = t
    const item = { id: draft.id, text: draft.text, revision: draft.revision }
    archive(draft, 'rejected', t)
    return { ok: true, item }
  }

  function edit(id, expectedRevision, text) {
    const t = requireCurrent(id, expectedRevision, 'edit')
    draft.text = normalizeText(text, maxChars)
    draft.revision += 1
    draft.status = 'editing'
    draft.editedAt = t
    draft.expiresAt = t + ttlMs // active user edit renews the confirmation window
    return view(draft, t)
  }

  /** Mark the confirmed submission as in flight (status only; never executes). */
  function markSubmitting(id, expectedRevision) {
    requireCurrent(id, expectedRevision, 'submit')
    draft.status = 'submitting'
    draft.submittingAt = clock()
    return view(draft, clock())
  }

  /** Forget the current (terminal) draft view; the record stays in bounded history. */
  function clear() {
    if (!draft) return false
    archive(draft, effectiveStatus(draft, clock()), clock(), { cleared: true })
    draft = null
    return true
  }

  function expireNow() {
    return expire(clock())
  }

  return {
    offer,
    confirm,
    reject,
    edit,
    expire: expireNow,
    snapshot,
    clear,
    markSubmitting,
    history: () => history.map(copy),
    ttlMs: () => ttlMs,
    isActive: () => Boolean(draft && DRAFT_ACTIVE_STATUSES.has(draft.status) && clock() < draft.expiresAt),
  }
}

/* ------------------------------------------------------------------------- */
/* Turn model (official DSH lifecycle projection)                            */
/* ------------------------------------------------------------------------- */

function emptyLastTurn() {
  return { turn: null, terminal: null, reason: null }
}

function normalizeTarget(target, fallback) {
  if (target === null || target === undefined) return { ...fallback }
  if (!plainObject(target)) throw modelError('INVALID_CANCEL_TARGET', 'cancel target must be an object')
  return { ...copy(target) }
}

/**
 * @param {object} options
 * @param {() => number} [options.now] epoch-ms clock (injectable)
 */
export function createTurnModel({
  now = () => Date.now(),
} = {}) {
  assertFunction('now', now)

  let state = 'idle'
  let sessionId = null
  let clientTurnId = null
  let turn = null
  let turnId = null
  let startedAt = null
  let inputSource = null
  let mainWindow = false
  let cancelRequestedAt = null
  let cancelTarget = null
  let lastTurn = emptyLastTurn()
  let lastError = null
  let conflict = null
  let lastCancel = null
  let admissionText = ''
  let admittedAt = null

  function clock() {
    const value = now()
    if (!isFiniteNumber(value)) throw modelError('INVALID_CLOCK', 'now() must return a finite epoch-ms number')
    return value
  }

  function snapshot() {
    return {
      state,
      sessionId,
      clientTurnId,
      turn,
      turnId,
      startedAt,
      inputSource,
      cancelRequestedAt,
      cancelTarget: copy(cancelTarget),
      lastTurn: copy(lastTurn),
      mainWindow,
      lastError: copy(lastError),
      conflict,
      lastCancel: copy(lastCancel),
      admissionText,
      admittedAt,
    }
  }

  function resetActive(t) {
    turn = null
    turnId = null
    clientTurnId = null
    startedAt = null
    mainWindow = false
    cancelRequestedAt = null
    cancelTarget = null
    conflict = null
    admissionText = ''
    admittedAt = null
    void t
  }

  function identityMatches(event, reference) {
    if (!reference) return false
    if (event.turn !== null && event.turn !== undefined && reference.turn !== null && reference.turn !== undefined) {
      if (Number(event.turn) !== Number(reference.turn)) return false
      return true
    }
    if (event.turnId !== null && event.turnId !== undefined && reference.turnId !== null && reference.turnId !== undefined) {
      return String(event.turnId) === String(reference.turnId)
    }
    if (event.turn === null || event.turn === undefined) {
      if (event.turnId === null || event.turnId === undefined) return true
      return reference.turnId === null || reference.turnId === undefined
    }
    return reference.turn === null || reference.turn === undefined
  }

  function hasIdentity(event) {
    return (event.turn !== null && event.turn !== undefined) || (event.turnId !== null && event.turnId !== undefined)
  }

  /** Begin a Host-owned admission; only legal from idle. */
  function beginAdmission({ sessionId: session = null, clientTurnId: client = '', inputSource: source = 'voice', text = '' } = {}) {
    if (state !== 'idle') {
      throw modelError('TURN_BUSY', '当前任务尚未结束，无法接收新的指令。', 409)
    }
    const t = clock()
    state = 'submitting'
    sessionId = session === null || session === undefined ? null : String(session)
    clientTurnId = String(client || '').slice(0, 200) || null
    inputSource = typeof source === 'string' && source !== '' ? source : 'voice'
    turn = null
    turnId = null
    startedAt = t
    mainWindow = false
    conflict = null
    lastError = null
    cancelRequestedAt = null
    cancelTarget = null
    admissionText = typeof text === 'string' ? text.slice(0, 20000) : ''
    admittedAt = t
    return snapshot()
  }

  /** Host admission was accepted (DSH will/has started the turn). */
  function admitted({ turn: value = null } = {}) {
    if (state === 'submitting') {
      state = 'working'
      startedAt = startedAt ?? clock()
      if (value !== null && value !== undefined) turn = value
      return snapshot()
    }
    if (state === 'idle') {
      state = 'working'
      mainWindow = false
      startedAt = clock()
      inputSource = inputSource || 'desktop'
      if (value !== null && value !== undefined) turn = value
      return snapshot()
    }
    if (state === 'working') {
      if (value !== null && value !== undefined) turn = value
      return snapshot()
    }
    throw modelError('TURN_BUSY', '当前任务状态不允许再次准入。', 409)
  }

  /**
   * Observe an official turn/start. A start seen from idle is a main-window turn
   * (the Host did not admit it); a start during our submission may either adopt
   * our turn or reveal a main-window race. Stale starts never overwrite a busy
   * successor turn.
   */
  function observeTurnStart({ turnId: eventTurnId = null, turn: eventTurn = null, inputSource: source = null } = {}) {
    const t = clock()
    const event = { turnId: eventTurnId, turn: eventTurn }
    const adopted = {
      turnId: eventTurnId === null || eventTurnId === undefined ? null : eventTurnId,
      turn: eventTurn === null || eventTurn === undefined ? null : eventTurn,
    }
    const observedSource = typeof source === 'string' && source !== '' ? source : null

    if (state === 'idle') {
      state = 'working'
      mainWindow = true
      inputSource = observedSource || 'desktop'
      startedAt = t
      turn = adopted.turn
      turnId = adopted.turnId
      conflict = null
      return snapshot()
    }
    if (state === 'submitting') {
      state = 'working'
      startedAt = startedAt ?? t
      turn = adopted.turn
      turnId = adopted.turnId
      if (observedSource !== null && observedSource !== inputSource) {
        mainWindow = true
        conflict = 'main-window-race'
      } else {
        mainWindow = false
        conflict = null
      }
      return snapshot()
    }
    if (state === 'working') {
      if (identityMatches(event, { turn, turnId }) || !hasIdentity(event)) {
        if (adopted.turn !== null) turn = adopted.turn
        if (adopted.turnId !== null) turnId = adopted.turnId
        return snapshot()
      }
      conflict = 'turn-mismatch'
      return snapshot()
    }
    if (state === 'cancel-requested') {
      const currentRef = { turn, turnId }
      if (identityMatches(event, currentRef) || !hasIdentity(event)) {
        // Duplicate start for the turn we are cancelling; stay in cancel-requested.
        return snapshot()
      }
      // A successor turn started while the cancel was unconfirmed. The late cancel
      // result must not hit this successor: keep the stale target only for diagnosis.
      lastTurn = { turn: cancelTarget?.turn ?? turn ?? null, terminal: 'unknown', reason: { kind: 'superseded' } }
      lastCancel = { target: copy(cancelTarget), stale: true, supersededAt: t }
      state = 'working'
      mainWindow = observedSource !== null && observedSource !== inputSource ? true : false
      inputSource = observedSource || inputSource || 'desktop'
      startedAt = t
      turn = adopted.turn
      turnId = adopted.turnId
      cancelRequestedAt = null
      cancelTarget = null
      conflict = 'cancel-superseded'
      return snapshot()
    }
    // unknown | error: an official start is authoritative evidence of new activity.
    state = 'working'
    mainWindow = observedSource !== null && observedSource !== inputSource
    inputSource = observedSource || 'desktop'
    startedAt = t
    turn = adopted.turn
    turnId = adopted.turnId
    lastError = null
    conflict = null
    return snapshot()
  }

  /**
   * Observe an official turn end. Only `official:true` results settle the turn;
   * request success/HTTP failure/local timeouts are not completion. A late end
   * for an older turn must not settle (or cancel) a busy successor.
   */
  function observeTurnEnd({ turnId: eventTurnId = null, turn: eventTurn = null, terminal = null, reason = null, official = true } = {}) {
    const t = clock()
    if (official !== true) return snapshot()
    if (state === 'idle') return snapshot()
    const event = { turnId: eventTurnId, turn: eventTurn }
    const terminalKind = typeof terminal === 'string' && terminal !== ''
      ? terminal
      : (reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : 'unknown')

    let matched = null
    if (state === 'submitting') {
      if (!hasIdentity(event)) matched = { turn: null, turnId: clientTurnId }
      else if (clientTurnId !== null && eventTurnId !== null && eventTurnId !== undefined && String(eventTurnId) === String(clientTurnId)) {
        matched = { turn: eventTurn ?? null, turnId: eventTurnId }
      } else if (eventTurn !== null && eventTurn !== undefined) {
        // DSH is serial; an end arriving during our pending admission is that turn.
        matched = { turn: eventTurn, turnId: eventTurnId }
      }
    } else if (state === 'working') {
      if (hasIdentity(event) && !identityMatches(event, { turn, turnId })) {
        // Late end for a previous turn; keep the successor untouched.
        return snapshot()
      }
      matched = { turn, turnId }
    } else if (state === 'cancel-requested') {
      if (hasIdentity(event) && identityMatches(event, { turn, turnId })) {
        matched = { turn, turnId }
      } else if (cancelTarget && identityMatches(event, cancelTarget)) {
        matched = { turn: cancelTarget.turn ?? null, turnId: cancelTarget.turnId ?? null }
      } else if (!hasIdentity(event)) {
        matched = { turn, turnId }
      }
    } else if (state === 'unknown' || state === 'error') {
      if (hasIdentity(event) && identityMatches(event, { turn, turnId })) {
        matched = { turn, turnId }
      } else if (cancelTarget && identityMatches(event, cancelTarget)) {
        matched = { turn: cancelTarget.turn ?? null, turnId: cancelTarget.turnId ?? null }
      }
    }
    if (!matched) return snapshot()

    const wasCancelling = state === 'cancel-requested' || Boolean(cancelTarget)
    if (wasCancelling) {
      lastCancel = {
        target: copy(cancelTarget),
        confirmedAt: t,
        terminal: terminalKind,
        confirmed: terminalKind === 'cancelled',
      }
    }
    lastTurn = {
      turn: eventTurn ?? matched.turn ?? (cancelTarget ? cancelTarget.turn ?? null : null),
      terminal: terminalKind,
      reason: reason === null || reason === undefined ? null : copy(reason),
    }
    state = 'idle'
    resetActive(t)
    cancelRequestedAt = null
    cancelTarget = null
    lastError = null
    return snapshot()
  }

  /**
   * Ask to cancel the currently captured turn. The target is captured at request
   * time; a later confirmation can only settle that target, never a successor.
   */
  function requestCancel({ target = null } = {}) {
    if (state === 'idle' || state === 'unknown' || state === 'error') return snapshot()
    if (state === 'cancel-requested') return snapshot()
    const t = clock()
    const fallback = {
      sessionId,
      turn,
      turnId,
      clientTurnId,
      inputSource,
      queueItemId: null,
    }
    cancelTarget = normalizeTarget(target, fallback)
    if (cancelTarget.capturedAt === undefined) cancelTarget.capturedAt = t
    if (cancelTarget.turn === undefined) cancelTarget.turn = turn
    if (cancelTarget.turnId === undefined) cancelTarget.turnId = turnId
    if (cancelTarget.clientTurnId === undefined) cancelTarget.clientTurnId = clientTurnId
    if (cancelTarget.sessionId === undefined) cancelTarget.sessionId = sessionId
    cancelRequestedAt = t
    state = 'cancel-requested'
    return snapshot()
  }

  /**
   * Official cancellation recognised. Only this (or an official turn/end via
   * observeTurnEnd) turns the turn idle; a late confirmation for a superseded
   * target must not hit the successor turn.
   */
  function cancelConfirmed() {
    if (state === 'cancel-requested') {
      const target = cancelTarget
      if (turn !== null && target?.turn !== null && target?.turn !== undefined && Number(turn) !== Number(target.turn)) {
        // Defensive: the current turn is a successor; never cancel it by a stale token.
        return snapshot()
      }
      const t = clock()
      const cancelledTurn = target?.turn ?? turn ?? null
      lastTurn = { turn: cancelledTurn, terminal: 'cancelled', reason: { kind: 'cancelled' } }
      lastCancel = { target: copy(target), confirmedAt: t, terminal: 'cancelled', confirmed: true }
      state = 'idle'
      resetActive(t)
      lastError = null
      return snapshot()
    }
    if (state === 'unknown' && cancelTarget) {
      // Official result arrives after the diagnostic window: official result wins,
      // but only for the captured target (no successor has been observed).
      const t = clock()
      const cancelledTurn = cancelTarget?.turn ?? turn ?? null
      lastTurn = { turn: cancelledTurn, terminal: 'cancelled', reason: { kind: 'cancelled' } }
      lastCancel = { target: copy(cancelTarget), confirmedAt: t, terminal: 'cancelled', confirmed: true, recovered: true }
      state = 'idle'
      resetActive(t)
      lastError = null
      return snapshot()
    }
    // Late confirmation for an already-successor turn: no effect, no fake success.
    return snapshot()
  }

  /**
   * The diagnostic waiting window elapsed without official confirmation: the
   * state becomes `unknown`, never a claimed success.
   * @returns {boolean} true when this call escalated cancel-requested -> unknown
   */
  function cancelExpired({ expireMs = 30000 } = {}) {
    assertTunable('expireMs', expireMs, 0, 86400000)
    if (state !== 'cancel-requested') return false
    if (cancelRequestedAt === null) return false
    if (clock() - cancelRequestedAt < expireMs) return false
    state = 'unknown'
    lastError = {
      code: 'CANCEL_UNCONFIRMED',
      message: '取消请求等待官方确认超时，结果未知。',
      at: clock(),
    }
    return true
  }

  function markUnknown(reason = {}) {
    const t = clock()
    if (state === 'idle') return snapshot()
    state = 'unknown'
    lastError = {
      code: plainObject(reason) && typeof reason.code === 'string' ? reason.code : 'UNKNOWN',
      message: plainObject(reason) && typeof reason.message === 'string'
        ? reason.message
        : (typeof reason === 'string' ? reason : '结果未知，等待官方确认。'),
      at: t,
    }
    return snapshot()
  }

  function markError(reason = {}) {
    if (state === 'idle') return snapshot()
    state = 'error'
    lastError = {
      code: plainObject(reason) && typeof reason.code === 'string' ? reason.code : 'TURN_ERROR',
      message: plainObject(reason) && typeof reason.message === 'string'
        ? reason.message
        : (typeof reason === 'string' ? reason : '任务执行失败。'),
      at: clock(),
    }
    return snapshot()
  }

  /** Recover from unknown/error to idle after explicit inspection. */
  function reset() {
    state = 'idle'
    const t = clock()
    resetActive(t)
    cancelRequestedAt = null
    cancelTarget = null
    lastError = null
    conflict = null
    return snapshot()
  }

  function adoptOfficialSnapshot({ status = null, session = null, currentTurn = null } = {}) {
    // First connection/restart: never assume idle before the official status says so.
    if (status === null || status === undefined) return snapshot()
    const normalized = String(status)
    if (normalized === 'idle') return snapshot()
    if (state === 'idle') {
      state = 'working'
      mainWindow = true
      inputSource = 'recovery'
      startedAt = clock()
      turn = currentTurn === null || currentTurn === undefined ? null : currentTurn
      sessionId = session === null || session === undefined ? sessionId : String(session)
    }
    return snapshot()
  }

  return {
    beginAdmission,
    admitted,
    observeTurnStart,
    observeTurnEnd,
    requestCancel,
    cancelConfirmed,
    cancelExpired,
    markUnknown,
    markError,
    reset,
    adoptOfficialSnapshot,
    isBusy: () => state !== 'idle',
    isMainWindowTurn: () => state !== 'idle' && mainWindow,
    snapshot,
    state: () => state,
  }
}

export default { createQueueModel, createDraftModel, createTurnModel, QUEUE_LIMIT_DEFAULT, QUEUE_TTL_MS_DEFAULT, DRAFT_TTL_MS_DEFAULT }
