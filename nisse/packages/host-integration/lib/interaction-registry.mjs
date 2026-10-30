/**
 * InteractionRegistry: the product identity / versioning / idempotency / receipt
 * layer that rides on top of the official DSH interaction lifetime.
 *
 * Authority (see .agent/plan/beta2-kernel.md §3.4 and plan v2.1 §6):
 * - DSH's official approval/question service still owns every decision and its
 *   lifetime. This module never fabricates an approval, a rejection or a
 *   question result; it maps product commands onto the official answerer
 *   (through InteractionMirror by default) and converges on whatever the
 *   official lifetime observed.
 * - The registry owns: product interaction identity, semanticRevision /
 *   viewRevision, the multi-select draft, idempotency keys + receipts, and the
 *   pending/resolving/resolved/expired/cancelled/unknown projection.
 *
 * Guarantees implemented here (plan §6.1-§6.4, §11 B2-G01/G03):
 * - at most one official decision per interaction, across voice / click /
 *   main-window, whichever path arrives first;
 * - same idempotency key + same canonical content + same target returns the
 *   same receipt and never re-executes; same key with different content or
 *   target is an IDEMPOTENCY_CONFLICT;
 * - observed official result > in-flight local decision > local pending;
 * - a late answer after the official result returns a `resolved` receipt with
 *   the final status and never calls the official service again;
 * - semantic changes (questions, options, constraints, operation) bump
 *   `semanticRevision` and invalidate old positions/ids unless equivalence is
 *   provable; display-only changes only bump `viewRevision` and keep answers
 *   valid;
 * - multi-select drafts use `selectionRevision` + set-selected semantics (no
 *   toggle), and a submit binds the draft revision it was shown;
 * - an interaction whose official outcome cannot be confirmed is exposed as
 *   `unknown` and is never replayed blindly.
 *
 * This module is dependency-free apart from ./contracts.mjs and pure Node, so it
 * can be unit-tested without DSH and reused by the conversation service.
 */
import {
  ContractError,
  digest,
  isPlainObject,
  newId,
  receipt,
  stableOptionId,
} from './contracts.mjs'

export const INTERACTION_STATES = Object.freeze([
  'pending', 'resolving', 'resolved', 'expired', 'cancelled', 'unknown',
])

const OPEN_STATES = new Set(['pending', 'resolving'])
const FINAL_STATES = new Set(['resolved', 'expired', 'cancelled', 'unknown'])
const DECISIONS = new Set(['allowed-once', 'rejected'])
const OFFICIAL_APPROVAL_OUTCOMES = new Set(['allowed-once', 'rejected', 'cancelled', 'unavailable'])
const MAX_DRAFT_TEXT = 20000
const MAX_RECENTLY_RESOLVED = 64
const MAX_INTERACTION_RECORDS = 512
const MAX_KEYS_PER_INTERACTION = 16
const MAX_RECEIPTS_IN_MEMORY = 512
const MAX_REVISIONS = 8
const MAX_UNBOUND_OFFICIAL = 32
const MAX_TIMER_MS = 2147483647
const DEFAULT_APPROVAL_TIMEOUT_MS = 120000
const DEFAULT_QUESTION_TIMEOUT_MS = 600000
const RECEIPT_KIND = 'interaction.resolve'

const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null)

function stringOrEmpty(value) {
  return typeof value === 'string' ? value : ''
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function errorInfo(error, fallbackCode = 'INTERACTION_ERROR') {
  const code = typeof error?.code === 'string' && error.code ? error.code : fallbackCode
  const message = typeof error?.message === 'string' && error.message
    ? error.message
    : String(error ?? code)
  return { code, message: message.slice(0, 1000) }
}

function isPromiseLike(value) {
  return value !== null && typeof value === 'object' && typeof value.then === 'function'
}

function safeDigest(value) {
  try { return digest(value) } catch { return null }
}

function officialOptionIdOf(option) {
  if (!isPlainObject(option)) return ''
  const raw = option.id ?? option.optionId ?? option.value?.id
  return typeof raw === 'string' && raw !== '' ? raw : ''
}

/**
 * Normalize the official question list (AskUserQuestionItem[]) into the internal
 * shape. Official options carry no guaranteed id in DSH 0.2.1-rc.3, so the
 * product id is derived per semantic revision (kernel §3.4, §6.3).
 */
function normalizeQuestions(raw) {
  if (!Array.isArray(raw)) return []
  const questions = []
  for (const item of raw) {
    if (!isPlainObject(item)) continue
    const id = String(item.id ?? '')
    if (id === '') continue
    const options = []
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isPlainObject(option)) continue
        options.push({
          label: String(option.label ?? ''),
          description: option.description === undefined ? '' : String(option.description),
          officialId: officialOptionIdOf(option),
        })
      }
    }
    questions.push({
      id,
      header: item.header === undefined ? '' : String(item.header),
      question: String(item.question ?? ''),
      detail: item.detail === undefined ? '' : String(item.detail),
      multiSelect: item.multiSelect === true,
      optional: item.optional === true,
      options,
    })
  }
  return questions
}

function optionShape(option) {
  return option && option.officialId
    ? { id: option.officialId, label: option.label }
    : { label: option?.label ?? '' }
}

/** Product-facing option id, stable for the lifetime of one semantic revision. */
function exposedOptionId(record, question, option, index) {
  return stableOptionId(optionShape(option), question.id, record.semanticRevision, index)
}

/** Revision-independent option identity used to prove semantic equivalence. */
function identityOptionId(question, option, index) {
  return stableOptionId(optionShape(option), question.id, 0, index)
}

function sortedOptionIdentities(question) {
  const list = question.options.map((option, index) => ({
    id: identityOptionId(question, option, index),
    label: option.label,
  }))
  return list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Semantic identity: what the question *means*. Display-only fields are excluded. */
function semanticIdentity(record, questions, operationDigest) {
  return {
    kind: record.kind,
    operation: record.kind === 'approval' ? operationDigest : null,
    questions: (questions || []).map((question) => ({
      id: question.id,
      question: question.question,
      multiSelect: question.multiSelect,
      optional: question.optional,
      options: sortedOptionIdentities(question),
    })),
  }
}

/** Display identity: what the UI shows for the same semantic content. */
function viewIdentity(questions) {
  return {
    questions: (questions || []).map((question) => ({
      id: question.id,
      header: question.header,
      detail: question.detail,
      order: question.options.map((option) => option.label),
      descriptions: question.options.map((option) => option.description),
    })),
  }
}

function normalizeOperation(raw) {
  if (!isPlainObject(raw)) return null
  const operation = {}
  if (typeof raw.toolName === 'string' && raw.toolName !== '') operation.toolName = raw.toolName
  if (raw.arguments !== undefined) operation.arguments = raw.arguments
  if (typeof raw.cwd === 'string' && raw.cwd !== '') operation.cwd = raw.cwd
  return Object.keys(operation).length ? operation : null
}

function operationDigestOf(operation) {
  return operation ? safeDigest(operation) : null
}

/** In-memory receipt store used when the Host does not inject a persisted one. */
function createMemoryReceiptStore(maxEntries = MAX_RECEIPTS_IN_MEMORY) {
  let entries = []
  let loaded = false
  return {
    file: null,
    load() { loaded = true; return { entries: entries.map((entry) => ({ ...entry })), corruptBackup: null } },
    get(key) { return entries.find((entry) => entry.key === key) || null },
    put(key, record) {
      entries = entries.filter((entry) => entry.key !== key)
      entries.push({ key, at: isoOf(Date.now()), ...record })
      if (entries.length > maxEntries) entries = entries.slice(-maxEntries)
      return entries.length
    },
    size: () => entries.length,
    stats: () => ({ loaded, size: entries.length, corruptBackup: null }),
    close() { loaded = false },
  }
}

/**
 * @param {object} options
 * @param {object} options.mirror - InteractionMirror (see ./interactions.mjs).
 * @param {object} [options.receipts] - createReceiptStore() from ./persistence.mjs.
 * @param {object} [options.store] - optional createStateStore() for restart recovery of drafts/unknowns.
 * @param {Function} [options.emit] - host event emitter `(type, {sessionId, data})`.
 * @param {Function} [options.now] - millisecond clock.
 * @param {string} [options.hostEpoch] - Host process epoch for receipts.
 * @param {Function} [options.getSessionId] - current Bot session id fallback.
 * @param {Function} [options.officialAnswer] - applies a decision to the official
 *   service. Receives `{interactionId, mirrorId, kind, sessionId, semanticRevision,
 *   commandId, decision, answer, operation, operationDigest, interaction}` and
 *   returns boolean (accepted by the official answerer), a Promise, or a concrete
 *   `{status, outcome}` result. Defaults to `mirror.answer(...)`.
 * @param {number} [options.approvalTimeoutMs]
 * @param {number} [options.questionTimeoutMs]
 * @param {number} [options.graceMs] - expiry grace after the official deadline.
 */
export function createInteractionRegistry({
  mirror = null,
  receipts = null,
  store = null,
  emit = null,
  now = () => Date.now(),
  hostEpoch = '',
  getSessionId = () => null,
  officialAnswer = null,
  approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS,
  questionTimeoutMs = DEFAULT_QUESTION_TIMEOUT_MS,
  graceMs = 750,
} = {}) {
  const clock = typeof now === 'function' ? now : () => Date.now()
  const isoNow = () => isoOf(clock())
  const receiptsStore = receipts && typeof receipts.put === 'function' && typeof receipts.get === 'function'
    ? receipts
    : createMemoryReceiptStore()
  const stateStore = store && typeof store.update === 'function' ? store : null
  if (!mirror && typeof officialAnswer !== 'function') {
    throw new ContractError('REGISTRY_INVALID', 'InteractionRegistry requires a mirror or an officialAnswer function')
  }

  const officialAnswerer = typeof officialAnswer === 'function' ? officialAnswer : null
  const approvalTimeout = Number.isFinite(approvalTimeoutMs) && approvalTimeoutMs >= 0 ? approvalTimeoutMs : DEFAULT_APPROVAL_TIMEOUT_MS
  const questionTimeout = Number.isFinite(questionTimeoutMs) && questionTimeoutMs >= 0 ? questionTimeoutMs : DEFAULT_QUESTION_TIMEOUT_MS
  const expiryGrace = Number.isFinite(graceMs) && graceMs >= 0 ? graceMs : 0

  /** Product interactions by product id (= mirror id when the mirror presented it). */
  const interactions = new Map()
  const byMirrorId = new Map()
  const byOfficialRequestId = new Map()
  const byOfficialCallId = new Map()
  const unboundOfficialIds = new Map()
  const expiryTimers = new Map()
  const memoryReceipts = new Map()
  const keysByInteraction = new Map()
  /** Read-only recovery from persisted receipts (no replay, no new official call). */
  const recoveredKeys = new Map()
  const recoveredByInteraction = new Map()
  const recentlyResolved = []
  const unknownInteractions = []
  const unsubscribers = []
  let focusedId = null
  let officialCalls = 0
  let disposed = false

  // ---------------------------------------------------------------- helpers

  function emitEvent(type, record, data = {}) {
    if (typeof emit !== 'function') return
    try {
      emit(type, {
        sessionId: record?.sessionId ?? null,
        data: {
          id: record?.id ?? null,
          interactionId: record?.id ?? null,
          kind: record?.kind ?? null,
          semanticRevision: record?.semanticRevision ?? null,
          viewRevision: record?.viewRevision ?? null,
          at: isoNow(),
          ...data,
        },
      })
    } catch { /* an event sink must never break the registry transaction */ }
  }

  function makeReceipt({ commandId = '', status, result = {}, error = null, at = isoNow() }) {
    return receipt({
      commandId,
      hostEpoch: hostEpoch || '',
      status,
      result,
      error,
      at,
    })
  }

  function rejectedReceipt(commandId, code, message, extra = {}) {
    return makeReceipt({
      commandId,
      status: 'rejected',
      result: extra.result || {},
      error: { code, message },
    })
  }

  function statusForState(state, error = null) {
    if (state === 'resolved') return { status: 'resolved', error: null }
    if (state === 'expired') {
      return {
        status: 'rejected',
        error: error || { code: 'INTERACTION_EXPIRED', message: 'the interaction expired before a decision arrived' },
      }
    }
    if (state === 'cancelled') return { status: 'resolved', error: null }
    return {
      status: 'unknown',
      error: error || { code: 'INTERACTION_UNKNOWN', message: 'the official result could not be confirmed' },
    }
  }

  function isOpen(record) {
    return Boolean(record) && OPEN_STATES.has(record.state)
  }

  function optionIdsFor(record) {
    const mapping = {}
    for (const question of record.questions || []) {
      mapping[question.id] = question.options.map((option, index) => exposedOptionId(record, question, option, index))
    }
    return mapping
  }

  function currentIdentityToOption(record) {
    const mapping = {}
    for (const question of record.questions || []) {
      mapping[question.id] = {}
      question.options.forEach((option, index) => {
        mapping[question.id][identityOptionId(question, option, index)] = exposedOptionId(record, question, option, index)
      })
    }
    return mapping
  }

  function currentOptionToIdentity(record) {
    const mapping = {}
    for (const question of record.questions || []) {
      mapping[question.id] = {}
      question.options.forEach((option, index) => {
        mapping[question.id][exposedOptionId(record, question, option, index)] = identityOptionId(question, option, index)
      })
    }
    return mapping
  }

  function questionsProjection(record) {
    return (record.questions || []).map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      detail: question.detail,
      multiSelect: question.multiSelect,
      options: question.options.map((option, index) => ({
        id: exposedOptionId(record, question, option, index),
        label: option.label,
        description: option.description,
      })),
    }))
  }

  function projectionOf(record) {
    return {
      id: record.id,
      kind: record.kind,
      sessionId: record.sessionId || null,
      semanticRevision: record.semanticRevision,
      viewRevision: record.viewRevision,
      officialCallId: record.officialRequestId || record.officialCallId || null,
      createdAt: isoOf(record.createdAt),
      expiresAt: isoOf(record.expiresAt),
      // Top-level official request label. The presentation layer prefers these
      // over the richer operation summary so a localized approval bubble never
      // degrades to generic text; questions carry null for both.
      toolName: record.toolName || null,
      reason: record.reason || null,
      operation: record.kind === 'approval' ? record.operation : null,
      questions: record.kind === 'question' ? questionsProjection(record) : null,
    }
  }

  function newDraft(record) {
    const answers = {}
    for (const question of record.questions || []) answers[question.id] = { selected: [] }
    return {
      semanticRevision: record.semanticRevision,
      selectionRevision: 0,
      answers,
      updatedAt: record.createdAt,
    }
  }

  function draftAnswersOf(record) {
    const answers = {}
    for (const question of record.questions || []) {
      const entry = record.draft?.answers?.[question.id] || {}
      const selected = Array.isArray(entry.selected) ? [...entry.selected] : []
      const custom = typeof entry.custom === 'string' ? entry.custom : ''
      answers[question.id] = { selected, ...(custom !== '' ? { custom } : {}) }
    }
    return answers
  }

  function draftViewOf(record) {
    const answers = draftAnswersOf(record)
    const questions = record.questions || []
    const view = {
      semanticRevision: record.semanticRevision,
      selectionRevision: record.draft?.selectionRevision ?? 0,
      answers,
      updatedAt: isoOf(record.draft?.updatedAt ?? record.createdAt),
    }
    if (questions.length === 1) {
      const entry = answers[questions[0].id] || { selected: [] }
      view.selectedOptionIds = [...entry.selected]
      view.customText = entry.custom || ''
    }
    return view
  }

  function draftResult(record) {
    const view = draftViewOf(record)
    return {
      interactionId: record.id,
      kind: 'question',
      semanticRevision: record.semanticRevision,
      selectionRevision: view.selectionRevision,
      answers: view.answers,
      ...(view.selectedOptionIds ? { selectedOptionIds: view.selectedOptionIds } : {}),
      ...(view.customText !== undefined ? { customText: view.customText } : {}),
      updatedAt: view.updatedAt,
    }
  }

  // ------------------------------------------------------- record lifecycle

  function nextOpenId() {
    for (const record of interactions.values()) if (OPEN_STATES.has(record.state)) return record.id
    return null
  }

  function setFocusNext() {
    if (focusedId) {
      const current = interactions.get(focusedId)
      if (isOpen(current)) return
    }
    focusedId = nextOpenId()
  }

  function initRecord(record) {
    record.semanticDigest = safeDigest(semanticIdentity(record, record.questions, record.operationDigest))
    record.viewDigest = safeDigest(viewIdentity(record.questions))
    record.updatedAt = record.createdAt
    record.draft = record.kind === 'question' ? newDraft(record) : null
    const timeout = record.kind === 'approval' ? approvalTimeout : questionTimeout
    record.expiresAt = timeout > 0 ? record.createdAt + timeout : null
    interactions.set(record.id, record)
    if (record.mirrorId) byMirrorId.set(record.mirrorId, record.id)
    if (record.officialCallId) byOfficialCallId.set(record.officialCallId, record.id)
    bindUnboundOfficial(record)
    scheduleExpiry(record)
    if (!focusedId) focusedId = record.id
    emitEvent('interaction.requested', record)
    persistState()
    pruneRecords()
    return record
  }

  /**
   * The official request's own label (tool name + asker reason). The mirror view
   * and the original request source both carry it; some adapters nest one under
   * the other, so every accepted shape is checked. Blank values fall through so
   * a later official event (approval/asked) can still fill them in.
   */
  function requestMeta(view, source) {
    const toolName = stringOrEmpty(view?.toolName)
      || stringOrEmpty(source?.toolName)
      || stringOrEmpty(source?.source?.toolName)
      || stringOrEmpty(source?.operation?.toolName)
    const reason = stringOrEmpty(view?.reason)
      || stringOrEmpty(source?.reason)
      || stringOrEmpty(source?.source?.reason)
    return {
      toolName: toolName.slice(0, 200),
      reason: reason.slice(0, 4000),
    }
  }

  function createRecord({
    id, mirrorId = null, kind, sessionId, officialCallId = null, operation = null,
    questions = [], toolName = '', reason = '', createdAt = null,
  }) {
    const record = {
      id,
      mirrorId,
      kind,
      sessionId: String(sessionId || ''),
      officialRequestId: null,
      officialCallId: officialCallId || null,
      toolCallId: officialCallId || null,
      toolName: stringOrEmpty(toolName).slice(0, 200),
      reason: stringOrEmpty(reason).slice(0, 4000),
      operation: kind === 'approval' ? normalizeOperation(operation) : null,
      operationDigest: null,
      semanticRevision: 1,
      viewRevision: 1,
      semanticDigest: null,
      viewDigest: null,
      revisions: [],
      state: 'pending',
      outcome: null,
      source: null,
      createdAt: createdAt ?? clock(),
      updatedAt: null,
      expiresAt: null,
      resolvedAt: null,
      questions: kind === 'question' ? questions : [],
      draft: null,
      deciding: null,
      answerBatch: null,
      officialOutcome: null,
      confirmedByOfficial: false,
    }
    record.operationDigest = operationDigestOf(record.operation)
    return initRecord(record)
  }

  function bindUnboundOfficial(record) {
    if (!unboundOfficialIds.size) return
    for (const [officialId, info] of unboundOfficialIds) {
      const matchesCall = info.callId && record.officialCallId && info.callId === record.officialCallId
      const matchesKind = info.kind === record.kind
      if (!matchesKind || !matchesCall) continue
      record.officialRequestId = officialId
      record.officialCallId = officialId
      byOfficialRequestId.set(officialId, record.id)
      byOfficialCallId.set(officialId, record.id)
      unboundOfficialIds.delete(officialId)
      break
    }
  }

  function scheduleExpiry(record) {
    const existing = expiryTimers.get(record.id)
    if (existing) clearTimeout(existing)
    expiryTimers.delete(record.id)
    if (!record.expiresAt || disposed) return
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, record.expiresAt - clock()) + expiryGrace)
    const timer = setTimeout(() => {
      expiryTimers.delete(record.id)
      expireInteraction(record)
    }, delay)
    timer.unref?.()
    expiryTimers.set(record.id, timer)
  }

  function clearExpiry(record) {
    const timer = expiryTimers.get(record.id)
    if (timer) clearTimeout(timer)
    expiryTimers.delete(record.id)
  }

  function expireInteraction(record) {
    if (!isOpen(record)) return false
    // Withdraw the product surface first (fail closed through the official
    // answerer's own lifetime); then converge this registry.
    if (record.mirrorId && typeof mirror?.expire === 'function') {
      try { mirror.expire(record.mirrorId) } catch { /* best effort */ }
    }
    if (isOpen(record)) {
      finalize(record, {
        state: 'expired',
        outcome: 'expired',
        source: 'local',
        error: { code: 'INTERACTION_EXPIRED', message: 'no decision arrived within the interaction lifetime' },
      })
    }
    return true
  }

  function pushResolved(record, outcome, source) {
    const entry = {
      id: record.id,
      kind: record.kind,
      outcome,
      resolvedAt: isoNow(),
      semanticRevision: record.semanticRevision,
      source: source === 'official' ? 'official' : 'local',
    }
    const existingIndex = recentlyResolved.findIndex((item) => item.id === record.id)
    if (existingIndex >= 0) recentlyResolved.splice(existingIndex, 1)
    recentlyResolved.unshift(entry)
    if (recentlyResolved.length > MAX_RECENTLY_RESOLVED) recentlyResolved.length = MAX_RECENTLY_RESOLVED
    return entry
  }

  function upgradeReceipts(record, { state, outcome, error }) {
    const keys = keysByInteraction.get(record.id)
    if (!keys || !keys.size) return
    const mapped = statusForState(state, error)
    for (const key of keys) {
      const held = memoryReceipts.get(key)
      if (!held) continue
      if (held.status !== 'accepted' && held.status !== 'pending') continue
      held.status = mapped.status
      held.outcome = outcome
      held.error = mapped.error
      held.upgraded = true
      held.at = isoNow()
      if (held.persist) persistReceipt(held)
    }
  }

  function finalize(record, { state, outcome, source = 'official', error = null, officialOutcome = null, answerBatch = null, force = false }) {
    if (!FINAL_STATES.has(state)) return false
    if (FINAL_STATES.has(record.state) && !force) {
      // Observed official result can still outperform a local fail-closed result
      // (plan §6.2: observed official result > local pending/expiry).
      if (source === 'official' && state === 'resolved' && record.state !== 'resolved') {
        // fall through and adopt the official result
      } else {
        if (source === 'official' && record.state === 'resolved') record.confirmedByOfficial = true
        persistState()
        return false
      }
    }
    record.state = state
    record.outcome = outcome
    record.resolvedAt = clock()
    record.updatedAt = record.resolvedAt
    record.source = source
    record.deciding = null
    if (officialOutcome) record.officialOutcome = officialOutcome
    if (answerBatch) record.answerBatch = answerBatch
    clearExpiry(record)
    // If the official result arrived out of band (durable event / projection)
    // the mirror may still be presenting the request: withdraw the product
    // surface without fabricating a second decision.
    if (record.mirrorId && source === 'official' && typeof mirror?.expire === 'function') {
      try {
        const stillPresented = typeof mirror.snapshot === 'function'
          ? mirror.snapshot().some((view) => view.id === record.mirrorId)
          : false
        if (stillPresented) mirror.expire(record.mirrorId)
      } catch { /* best effort */ }
    }
    upgradeReceipts(record, { state, outcome, error })
    pushResolved(record, outcome, source)
    if (state === 'expired') emitEvent('interaction.expired', record, { reason: error?.code || 'expired' })
    else if (state === 'unknown') {
      const unknown = { id: record.id, kind: record.kind, sessionId: record.sessionId, reason: error?.code || 'UNKNOWN', at: isoNow() }
      if (!unknownInteractions.some((item) => item.id === record.id)) unknownInteractions.push(unknown)
      emitEvent('interaction.unknown', record, { reason: error?.code || 'UNKNOWN' })
    } else emitEvent('interaction.resolved', record, { outcome, source })
    setFocusNext()
    persistState()
    pruneRecords()
    return true
  }

  function pruneRecords() {
    if (interactions.size <= MAX_INTERACTION_RECORDS) return
    for (const [id, record] of interactions) {
      if (interactions.size <= MAX_INTERACTION_RECORDS) break
      if (OPEN_STATES.has(record.state)) continue
      if (!recoveredByInteraction.has(id)) {
        recoveredByInteraction.set(id, {
          status: record.state === 'expired' ? 'rejected' : record.state === 'cancelled' ? 'resolved' : record.state,
          outcome: record.outcome,
          semanticRevision: record.semanticRevision,
          at: isoOf(record.resolvedAt),
        })
      }
      interactions.delete(id)
      if (record.mirrorId) byMirrorId.delete(record.mirrorId)
      if (record.officialCallId) byOfficialCallId.delete(record.officialCallId)
      keysByInteraction.delete(id)
    }
  }

  // ------------------------------------------------------------- semantics

  function refreshSemantics(record, { questions, operation }) {
    const nextQuestions = record.kind === 'question' ? (questions ?? record.questions) : []
    const nextOperation = record.kind === 'approval' ? (operation ?? record.operation) : null
    const nextOperationDigest = operationDigestOf(nextOperation)
    const nextSemantic = safeDigest(semanticIdentity(record, nextQuestions, nextOperationDigest))
    const nextView = safeDigest(viewIdentity(nextQuestions))
    const semanticChanged = nextSemantic !== record.semanticDigest
    if (!semanticChanged && nextView === record.viewDigest) return null
    if (!semanticChanged) {
      record.questions = nextQuestions
      record.operation = nextOperation
      record.operationDigest = nextOperationDigest
      record.viewDigest = nextView
      record.viewRevision += 1
      record.updatedAt = clock()
      emitEvent('interaction.updated', record, { viewOnly: true })
      persistState()
      return 'view'
    }
    // Semantic change: keep the previous revision for equivalence proof, bump
    // semanticRevision, and invalidate product ids / draft of the old revision.
    const previousRevision = record.semanticRevision
    record.revisions.push({
      revision: previousRevision,
      digest: record.semanticDigest,
      optionToIdentity: currentOptionToIdentity(record),
    })
    if (record.revisions.length > MAX_REVISIONS) record.revisions.splice(0, record.revisions.length - MAX_REVISIONS)
    record.semanticRevision = previousRevision + 1
    record.semanticDigest = nextSemantic
    record.viewDigest = nextView
    record.questions = nextQuestions
    record.operation = nextOperation
    record.operationDigest = nextOperationDigest
    record.viewRevision += 1
    record.updatedAt = clock()
    const hadDraft = record.draft && draftAnswersOf(record)
      && Object.values(record.draft.answers || {}).some((entry) => (entry.selected || []).length || entry.custom)
    record.draft = newDraft(record)
    if (hadDraft) emitEvent('interaction.draft.changed', record, { reason: 'semantic-revision', ...draftViewOf(record) })
    emitEvent('interaction.updated', record, { viewOnly: false, previousSemanticRevision: previousRevision })
    persistState()
    return 'semantic'
  }

  /**
   * Map a command's selection from an older semantic revision to the current one
   * only when the older revision is provably equivalent (same digest). Product
   * option ids are revision-scoped, so an answer from a non-equivalent revision
   * is never reinterpreted by position or by label.
   */
  function prepareAnswersForRevision(record, semanticRevision, rawAnswers) {
    if (semanticRevision === null || semanticRevision === record.semanticRevision) return { answers: rawAnswers }
    const previous = record.revisions.find((entry) => entry.revision === semanticRevision)
    if (!previous || previous.digest !== record.semanticDigest) {
      return { error: { code: 'REVISION_MISMATCH', message: 'the interaction changed semantically; re-ask instead of re-interpreting the old answer' } }
    }
    const current = currentIdentityToOption(record)
    const canMap = Array.isArray(rawAnswers)
    const translated = []
    for (const answer of canMap ? rawAnswers : []) {
      if (!isPlainObject(answer)) return { error: { code: 'INVALID_ANSWER', message: 'invalid answer item' } }
      const questionId = String(answer.id ?? '')
      const selected = Array.isArray(answer.selected) ? answer.selected : []
      const nextSelected = []
      for (const optionId of selected) {
        const identity = previous.optionToIdentity?.[questionId]?.[optionId]
        const mapped = identity ? current[questionId]?.[identity] : undefined
        if (!mapped) return { error: { code: 'INVALID_ANSWER', message: 'the selected option does not belong to this interaction revision' } }
        nextSelected.push(mapped)
      }
      translated.push({ ...answer, selected: nextSelected })
    }
    return { answers: translated }
  }

  // --------------------------------------------------------------- receipts

  function bindKey(interactionId, key) {
    let keys = keysByInteraction.get(interactionId)
    if (!keys) { keys = new Set(); keysByInteraction.set(interactionId, keys) }
    keys.add(key)
    if (keys.size > MAX_KEYS_PER_INTERACTION) keys.delete(keys.values().next().value)
  }

  function persistReceipt(held) {
    try {
      receiptsStore.put(held.key, {
        commandId: held.commandId,
        kind: RECEIPT_KIND,
        interactionId: held.interactionId,
        interactionKind: held.kind,
        status: held.status,
        outcome: held.outcome,
        error: held.error,
        contentDigest: held.contentDigest,
        targetDigest: held.targetDigest,
        semanticRevision: held.semanticRevision,
        at: held.at,
      })
    } catch { /* receipts are a recovery aid: memory still answers this process */ }
  }

  function rememberReceipt(held) {
    memoryReceipts.set(held.key, held)
    while (memoryReceipts.size > MAX_RECEIPTS_IN_MEMORY) {
      const oldest = memoryReceipts.keys().next().value
      memoryReceipts.delete(oldest)
    }
  }

  function receiptFromHeld(held, { commandId, alreadyResolved = false }) {
    if (held.kind === 'draft' && held.result) {
      return makeReceipt({
        commandId: commandId || held.commandId,
        status: held.status,
        result: { ...held.result, at: held.at },
        error: held.error || null,
        at: held.at,
      })
    }
    let status = held.status
    let outcome = held.outcome ?? null
    let error = held.error ?? null
    const record = interactions.get(held.interactionId)
    if (record && FINAL_STATES.has(record.state)) {
      const mapped = statusForState(record.state, error)
      status = mapped.status
      outcome = record.outcome
      error = mapped.error
    }
    const result = {
      interactionId: held.interactionId,
      outcome,
      semanticRevision: record?.semanticRevision ?? held.semanticRevision ?? null,
      at: held.at,
    }
    if (alreadyResolved || held.upgraded) result.alreadyResolved = true
    return makeReceipt({ commandId: commandId || held.commandId, status, result, error, at: held.at })
  }

  function receiptFromRecovered(entry, { commandId }) {
    const status = String(entry.status || 'unknown')
    // A receipt persisted while a decision was still in flight is read-only
    // history after a restart: the Host cannot know whether the official service
    // applied it, so it reports `unknown` and never replays the decision.
    if (status === 'accepted' || status === 'pending' || status === '') {
      return makeReceipt({
        commandId: commandId || entry.commandId || '',
        status: 'unknown',
        result: {
          interactionId: entry.interactionId ?? null,
          outcome: 'unknown',
          semanticRevision: entry.semanticRevision ?? null,
          at: entry.at ?? null,
          recovered: true,
          readOnly: true,
        },
        error: entry.error || { code: 'INTERACTION_UNKNOWN_AFTER_RESTART', message: 'the Host restarted before the official interaction settled; verify before retrying' },
        at: entry.at ?? isoNow(),
      })
    }
    const normalizedStatus = status === 'resolved' || status === 'rejected' ? status : 'unknown'
    return makeReceipt({
      commandId: commandId || entry.commandId || '',
      status: normalizedStatus,
      result: {
        interactionId: entry.interactionId ?? null,
        outcome: entry.outcome ?? null,
        semanticRevision: entry.semanticRevision ?? null,
        at: entry.at ?? null,
        recovered: true,
        ...(normalizedStatus === 'resolved' ? { alreadyResolved: true } : {}),
      },
      error: entry.error || null,
      at: entry.at ?? isoNow(),
    })
  }

  function loadRecovery() {
    let loaded = null
    try { loaded = receiptsStore.load?.() } catch { loaded = null }
    const entries = Array.isArray(loaded?.entries) ? loaded.entries : []
    for (const entry of entries) {
      if (!isPlainObject(entry) || typeof entry.key !== 'string') continue
      if (entry.kind !== RECEIPT_KIND) continue
      recoveredKeys.set(entry.key, entry)
      const interactionId = stringOrEmpty(entry.interactionId)
      if (!interactionId) continue
      const status = String(entry.status || '')
      const at = entry.at ?? null
      if (status === 'resolved') {
        recoveredByInteraction.set(interactionId, {
          status: 'resolved', outcome: entry.outcome ?? 'answered', semanticRevision: entry.semanticRevision ?? null, at,
        })
      } else if (status === 'rejected') {
        const previous = recoveredByInteraction.get(interactionId)
        if (!previous || previous.status !== 'resolved') {
          recoveredByInteraction.set(interactionId, {
            status: 'rejected', outcome: entry.outcome ?? 'expired', error: entry.error || { code: 'INTERACTION_EXPIRED', message: 'the interaction expired before a decision arrived' }, semanticRevision: entry.semanticRevision ?? null, at,
          })
        }
      } else if (status === 'accepted' || status === 'pending') {
        // A receipt persisted while the decision was still in flight means the
        // Host restarted without observing the official result: fail closed to
        // `unknown`, never replay the decision.
        const previous = recoveredByInteraction.get(interactionId)
        if (!previous || (previous.status !== 'resolved' && previous.status !== 'rejected')) {
          recoveredByInteraction.set(interactionId, {
            status: 'unknown', outcome: 'unknown', error: { code: 'INTERACTION_UNKNOWN_AFTER_RESTART', message: 'the Host restarted before the official interaction settled; verify before retrying' }, semanticRevision: entry.semanticRevision ?? null, at,
          })
        }
      } else if (status === 'unknown') {
        const previous = recoveredByInteraction.get(interactionId)
        if (!previous) {
          recoveredByInteraction.set(interactionId, {
            status: 'unknown', outcome: 'unknown', error: entry.error || { code: 'INTERACTION_UNKNOWN' }, semanticRevision: entry.semanticRevision ?? null, at,
          })
        }
      }
    }
    for (const [id, info] of recoveredByInteraction) {
      if (info.status !== 'unknown') continue
      if (unknownInteractions.some((item) => item.id === id)) continue
      unknownInteractions.push({ id, kind: null, sessionId: null, reason: info.error?.code || 'INTERACTION_UNKNOWN', at: info.at || isoNow() })
    }
  }

  function loadStateRecovery() {
    if (!stateStore) return
    let loaded = null
    try { loaded = stateStore.load?.() } catch { loaded = null }
    const data = loaded?.data
    if (!isPlainObject(data)) return
    if (Array.isArray(data.recentlyResolved)) {
      for (const item of data.recentlyResolved) {
        if (!isPlainObject(item) || !item.id) continue
        if (recentlyResolved.some((entry) => entry.id === item.id)) continue
        recentlyResolved.push(item)
      }
      if (recentlyResolved.length > MAX_RECENTLY_RESOLVED) recentlyResolved.length = MAX_RECENTLY_RESOLVED
    }
    const records = isPlainObject(data.interactions) ? data.interactions : {}
    for (const key of Object.keys(records)) {
      const saved = records[key]
      if (!isPlainObject(saved)) continue
      const id = String(saved.id || key)
      if (OPEN_STATES.has(saved.state)) {
        recoveredByInteraction.set(id, {
          status: 'unknown',
          outcome: 'unknown',
          error: { code: 'INTERACTION_UNKNOWN_AFTER_RESTART', message: 'the Host restarted before the official interaction settled; verify before retrying' },
          semanticRevision: saved.semanticRevision ?? null,
          at: saved.createdAt ?? null,
        })
        if (!unknownInteractions.some((item) => item.id === id)) {
          unknownInteractions.push({ id, kind: saved.kind ?? null, sessionId: saved.sessionId ?? null, reason: 'HOST_RESTARTED', at: isoNow(), draft: saved.draft ?? null })
        }
      } else if (saved.state === 'expired') {
        if (!recoveredByInteraction.has(id)) {
          recoveredByInteraction.set(id, { status: 'rejected', outcome: 'expired', error: { code: 'INTERACTION_EXPIRED' }, semanticRevision: saved.semanticRevision ?? null, at: saved.resolvedAt ?? null })
        }
      } else if (saved.state === 'resolved' || saved.state === 'cancelled') {
        if (!recoveredByInteraction.has(id)) {
          recoveredByInteraction.set(id, { status: 'resolved', outcome: saved.outcome || (saved.state === 'cancelled' ? 'cancelled' : 'answered'), semanticRevision: saved.semanticRevision ?? null, at: saved.resolvedAt ?? null })
        }
      } else if (saved.state === 'unknown' && !recoveredByInteraction.has(id)) {
        recoveredByInteraction.set(id, { status: 'unknown', outcome: 'unknown', error: { code: 'INTERACTION_UNKNOWN' }, semanticRevision: saved.semanticRevision ?? null, at: saved.resolvedAt ?? null })
      }
    }
  }

  function serializeRecord(record) {
    return {
      id: record.id,
      kind: record.kind,
      sessionId: record.sessionId,
      mirrorId: record.mirrorId,
      officialCallId: record.officialCallId,
      officialRequestId: record.officialRequestId,
      toolName: record.toolName,
      reason: record.reason,
      operation: record.operation,
      semanticRevision: record.semanticRevision,
      viewRevision: record.viewRevision,
      state: record.state,
      outcome: record.outcome,
      createdAt: isoOf(record.createdAt),
      expiresAt: isoOf(record.expiresAt),
      resolvedAt: isoOf(record.resolvedAt),
      questions: record.kind === 'question' ? questionsProjection(record) : null,
      draft: record.kind === 'question' && record.draft ? draftViewOf(record) : null,
    }
  }

  function persistState() {
    if (!stateStore || disposed) return
    try {
      stateStore.update((data) => {
        const next = isPlainObject(data) ? data : {}
        const records = {}
        for (const record of interactions.values()) records[record.id] = serializeRecord(record)
        next.interactions = records
        next.recentlyResolved = recentlyResolved.slice(0, 32)
        return next
      })
    } catch { /* persistence is a recovery aid; in-memory authority keeps working */ }
  }

  // --------------------------------------------------- official result path

  function settleOutcomeFor(record, payload) {
    if (payload.kind === 'approval') {
      if (payload.answer === null || payload.answer === undefined) return { state: 'cancelled', outcome: 'cancelled', officialOutcome: 'cancelled' }
      if (!DECISIONS.has(payload.answer)) {
        return { state: 'unknown', outcome: 'unknown', officialOutcome: String(payload.answer), error: { code: 'UNKNOWN_OFFICIAL_OUTCOME', message: 'unrecognized official approval outcome' } }
      }
      return { state: 'resolved', outcome: payload.answer, officialOutcome: payload.answer }
    }
    if (payload.answer === null || payload.answer === undefined) return { state: 'cancelled', outcome: 'cancelled', officialOutcome: 'cancelled' }
    return { state: 'resolved', outcome: 'answered', officialOutcome: 'answered', answerBatch: labelsToAnswerBatch(record, payload.answer) }
  }

  function labelsToAnswerBatch(record, officialAnswer) {
    const rawAnswers = Array.isArray(officialAnswer?.answers) ? officialAnswer.answers : []
    const answers = []
    for (const item of rawAnswers) {
      if (!isPlainObject(item)) continue
      const question = (record.questions || []).find((candidate) => candidate.id === String(item.id ?? ''))
      if (!question) continue
      const selected = []
      for (const label of Array.isArray(item.selected) ? item.selected : []) {
        const index = question.options.findIndex((option) => option.label === label)
        if (index >= 0) selected.push(exposedOptionId(record, question, question.options[index], index))
      }
      const custom = typeof item.custom === 'string' && item.custom.trim() !== '' ? item.custom.trim() : undefined
      answers.push({ id: question.id, selected, ...(custom ? { custom } : {}) })
    }
    return answers.length ? { answers } : null
  }

  function onMirrorSettled(payload) {
    if (disposed) return
    const mirrorId = String(payload.id)
    let record = interactions.get(mirrorId) || interactions.get(byMirrorId.get(mirrorId) || '')
    if (!record) record = adoptMirrorView(payload)
    if (!record) return
    const reason = String(payload.reason || '')
    if (reason === 'timeout' || reason === 'expired') {
      if (isOpen(record)) {
        finalize(record, {
          state: 'expired',
          outcome: 'expired',
          source: 'local',
          error: { code: 'INTERACTION_EXPIRED', message: 'the official interaction lifetime ended before a decision' },
        })
      }
      return
    }
    const source = reason === 'official' ? 'official' : reason === 'local' ? 'local' : reason === 'no-answerer' ? 'official' : 'official'
    const mapped = settleOutcomeFor(record, payload)
    if (source === 'local') {
      // The product decision was handed to the official answerer; mirror.answer
      // only resolves after the official service accepted it.
      finalize(record, {
        state: mapped.state,
        outcome: mapped.outcome,
        source: 'local',
        answerBatch: mapped.answerBatch ?? record.answerBatch,
        error: mapped.error ?? null,
      })
      return
    }
    if (FINAL_STATES.has(record.state)) {
      if (record.state === 'resolved') {
        record.confirmedByOfficial = true
        if (mapped.officialOutcome) record.officialOutcome = mapped.officialOutcome
        if (mapped.answerBatch && !record.answerBatch) record.answerBatch = mapped.answerBatch
        persistState()
        return
      }
      if (mapped.state === 'resolved') {
        // Observed official result outranks a local expiry/cancel/unknown.
        finalize(record, {
          state: 'resolved',
          outcome: mapped.outcome,
          source: 'official',
          officialOutcome: mapped.officialOutcome,
          answerBatch: mapped.answerBatch ?? null,
          force: true,
        })
      }
      return
    }
    finalize(record, {
      state: mapped.state,
      outcome: mapped.outcome,
      source: 'official',
      officialOutcome: mapped.officialOutcome,
      answerBatch: mapped.answerBatch ?? null,
      error: mapped.state === 'unknown' ? { code: 'UNKNOWN_OFFICIAL_OUTCOME', message: 'unrecognized official interaction outcome' } : null,
    })
  }

  function adoptMirrorView(payload) {
    const view = isPlainObject(payload.view) ? payload.view : {}
    const kind = payload.kind === 'question' ? 'question' : payload.kind === 'approval' ? 'approval' : null
    if (!kind) return null
    const id = String(payload.id)
    const existingId = byMirrorId.get(id)
    if (existingId) return interactions.get(existingId) || null
    const request = isPlainObject(payload.source) ? payload.source : {}
    const officialCallId = kind === 'approval' ? (view.callId || request.callId || null) : (view.callId || request.wait?.callId || null)
    const meta = requestMeta(view, request)
    return createRecord({
      id,
      mirrorId: id,
      kind,
      sessionId: payload.sessionId || request.agent?.session?.id || getSessionId(),
      officialCallId,
      operation: request.operation,
      questions: normalizeQuestions(view.questions || request.questions),
      toolName: meta.toolName,
      reason: meta.reason,
      createdAt: clock(),
    })
  }

  function onMirrorRequest(payload) {
    if (disposed) return
    const id = String(payload.id)
    if (interactions.has(id) || byMirrorId.has(id)) return
    adoptMirrorView(payload)
  }

  // -------------------------------------------------------- official events

  function normalizeOfficialEvent(event) {
    if (!isPlainObject(event)) return null
    const type = String(event.type || event.name || '')
    if (!type) return null
    const data = isPlainObject(event.data) ? event.data : event
    const sessionId = stringOrEmpty(data.sessionId)
      || stringOrEmpty(data.agent?.session?.id)
      || stringOrEmpty(data.session?.id)
      || stringOrEmpty(getSessionId())
    return { type, data, sessionId }
  }

  function bindOfficialRequest(data, kindHint = null) {
    const officialId = stringOrEmpty(data.id) || stringOrEmpty(data.officialId) || stringOrEmpty(data.requestId)
    if (!officialId) return false
    const callId = stringOrEmpty(data.callId) || stringOrEmpty(data.wait?.callId) || stringOrEmpty(data.call?.id)
    let record = null
    if (callId) {
      const mappedId = byOfficialCallId.get(callId)
      record = mappedId ? interactions.get(mappedId) : null
    }
    if (!record) {
      const candidates = [...interactions.values()].filter((candidate) => isOpen(candidate)
        && (kindHint === null || candidate.kind === kindHint)
        && (!callId || candidate.officialCallId === callId || candidate.toolCallId === callId))
      if (candidates.length === 1) record = candidates[0]
    }
    if (record) {
      record.officialRequestId = officialId
      record.officialCallId = officialId
      byOfficialRequestId.set(officialId, record.id)
      byOfficialCallId.set(officialId, record.id)
      if (callId) byOfficialCallId.set(callId, record.id)
      // Binding must never drop the official label if the record was adopted
      // before the approval/asked event named the tool.
      const meta = requestMeta(data, data)
      if (!record.toolName && meta.toolName) record.toolName = meta.toolName
      if (!record.reason && meta.reason) record.reason = meta.reason
      persistState()
      return true
    }
    unboundOfficialIds.set(officialId, { officialId, callId, kind: kindHint, at: clock() })
    while (unboundOfficialIds.size > MAX_UNBOUND_OFFICIAL) {
      unboundOfficialIds.delete(unboundOfficialIds.keys().next().value)
    }
    return false
  }

  function findOfficialTarget(kind, data, { allowSinglePending = false } = {}) {
    const explicit = stringOrEmpty(data.interactionId)
    if (explicit && interactions.has(explicit)) return interactions.get(explicit)
    const officialId = stringOrEmpty(data.id) || stringOrEmpty(data.officialId) || stringOrEmpty(data.requestId)
    if (officialId) {
      const mapped = byOfficialRequestId.get(officialId)
      if (mapped && interactions.has(mapped)) return interactions.get(mapped)
      const callMapped = byOfficialCallId.get(officialId)
      if (callMapped && interactions.has(callMapped)) return interactions.get(callMapped)
    }
    const callId = stringOrEmpty(data.callId) || stringOrEmpty(data.wait?.callId)
    if (callId) {
      const mapped = byOfficialCallId.get(callId)
      if (mapped && interactions.has(mapped)) return interactions.get(mapped)
    }
    if (!allowSinglePending) return null
    // Last resort for observed *official* (durable) events: an unambiguous
    // single official request of this kind. Never "the first request" when more
    // than one is pending, and never used for the mirror's own settle echo (its
    // events carry no durable seq / official marker), which would otherwise
    // mask local decisions and timeouts as official results.
    const candidates = [...interactions.values()].filter((candidate) => isOpen(candidate) && candidate.kind === kind)
    if (candidates.length === 1) return candidates[0]
    return null
  }

  function isObservableOfficialEvent(data) {
    return Boolean(data) && (data.durableSeq !== undefined || data.official === true || data.direct === true)
  }

  function officialOutcomeFor(kind, data) {
    const raw = data.outcome ?? data.decision ?? data.status ?? null
    if (kind === 'approval') {
      if (raw === null || raw === undefined) return { state: 'unknown', outcome: 'unknown', error: { code: 'UNKNOWN_OFFICIAL_OUTCOME', message: 'official approval ended without an outcome' } }
      if (raw === 'allowed-once' || raw === 'rejected') return { state: 'resolved', outcome: raw, officialOutcome: raw }
      if (raw === 'cancelled' || raw === 'unavailable') return { state: 'cancelled', outcome: 'cancelled', officialOutcome: raw }
      return { state: 'unknown', outcome: 'unknown', officialOutcome: String(raw), error: { code: 'UNKNOWN_OFFICIAL_OUTCOME', message: 'unrecognized official approval outcome: ' + String(raw) } }
    }
    if (raw === 'cancelled') return { state: 'cancelled', outcome: 'cancelled', officialOutcome: raw }
    if (raw === 'expired') return { state: 'expired', outcome: 'expired', officialOutcome: raw }
    if (raw === 'unknown' || raw === null || raw === undefined) return { state: 'unknown', outcome: 'unknown', error: { code: 'UNKNOWN_OFFICIAL_OUTCOME', message: 'official question ended without a confirmable answer' } }
    return { state: 'resolved', outcome: 'answered', officialOutcome: String(raw) }
  }

  function applyOfficialDecision(kind, data) {
    const record = findOfficialTarget(kind, data, { allowSinglePending: isObservableOfficialEvent(data) })
    if (!record) return false
    const mapped = officialOutcomeFor(kind, data)
    if (mapped.state === 'resolved' && kind === 'question') {
      mapped.answerBatch = labelsToAnswerBatch(record, data.answers ? { answers: data.answers } : data.answer)
    }
    if (FINAL_STATES.has(record.state)) {
      if (record.state === 'resolved') {
        record.confirmedByOfficial = true
        if (mapped.officialOutcome) record.officialOutcome = mapped.officialOutcome
        persistState()
        return true
      }
      if (mapped.state === 'resolved') {
        finalize(record, { state: 'resolved', outcome: mapped.outcome, source: 'official', officialOutcome: mapped.officialOutcome, answerBatch: mapped.answerBatch ?? null, force: true })
        return true
      }
      return true
    }
    finalize(record, {
      state: mapped.state,
      outcome: mapped.outcome,
      source: 'official',
      officialOutcome: mapped.officialOutcome ?? null,
      answerBatch: mapped.answerBatch ?? null,
      error: mapped.error ?? null,
    })
    return true
  }

  function viewFromEventData(kind, data) {
    return {
      id: data.interactionId || data.id,
      mirrorId: data.mirrorId,
      kind,
      sessionId: data.sessionId || data.agent?.session?.id,
      callId: data.callId || data.wait?.callId,
      questions: data.questions,
      operation: data.operation,
      toolName: data.toolName,
      reason: data.reason,
    }
  }

  function observeOfficial(event) {
    if (disposed) return false
    const normalized = normalizeOfficialEvent(event)
    if (!normalized) return false
    const { type, data, sessionId } = normalized
    if (sessionId && !data.sessionId) data.sessionId = sessionId
    const typeLower = type.toLowerCase()
    if (typeLower === 'approval/asked' || typeLower === 'approval.asked' || typeLower === 'approval-asked') {
      return bindOfficialRequest(data, 'approval')
    }
    if (typeLower === 'approval/decided' || typeLower === 'approval.decided' || typeLower === 'approval-decided') {
      return applyOfficialDecision('approval', data)
    }
    if (typeLower === 'approval/request' || typeLower === 'approval.request') {
      const view = viewFromEventData('approval', data)
      return syncOfficialRequests([view]) > 0
    }
    if (typeLower === 'question/decided' || typeLower === 'question.decided' || typeLower === 'question-decided'
      || typeLower === 'user-questions/decided' || typeLower === 'user-questions.decided' || typeLower === 'user-questions-decided') {
      return applyOfficialDecision('question', data)
    }
    if (typeLower === 'user-questions/request' || typeLower === 'user-questions.request' || typeLower === 'question/request' || typeLower === 'question.request') {
      const view = viewFromEventData('question', data)
      return syncOfficialRequests([view]) > 0
    }
    if (typeLower === 'interaction/resolved' || typeLower === 'interaction.resolved') {
      if (data.source && data.source !== 'official' && data.direct !== true) return false
      const record = findOfficialTarget(data.kind === 'approval' ? 'approval' : 'question', data, { allowSinglePending: data.direct === true })
      if (!record) return false
      return applyOfficialDecision(record.kind, { ...data, direct: true })
    }
    if (typeLower === 'interaction/expired' || typeLower === 'interaction.expired') {
      const record = findOfficialTarget(data.kind === 'question' ? 'question' : 'approval', data, { allowSinglePending: data.direct === true })
      if (!record) return false
      return expireInteraction(record)
    }
    if (typeLower === 'interaction/updated' || typeLower === 'interaction.updated'
      || typeLower === 'interaction/requested' || typeLower === 'interaction.requested') {
      const record = stringOrEmpty(data.interactionId) ? interactions.get(data.interactionId) : null
      if (record && data.questions) return refreshSemantics(record, { questions: normalizeQuestions(data.questions), operation: data.operation ?? record.operation }) !== null
      const view = viewFromEventData(data.kind === 'approval' ? 'approval' : 'question', data)
      return syncOfficialRequests([view]) > 0
    }
    return false
  }

  function syncOfficialRequests(requests) {
    if (!Array.isArray(requests)) return 0
    let changed = 0
    for (const raw of requests) {
      if (!isPlainObject(raw)) continue
      const kind = raw.kind === 'approval' ? 'approval' : raw.kind === 'question' ? 'question' : null
      if (!kind) continue
      const meta = requestMeta(raw, raw)
      const explicitId = stringOrEmpty(raw.interactionId)
      const rawId = stringOrEmpty(raw.id) || stringOrEmpty(raw.mirrorId)
      const mirrorId = explicitId && interactions.has(explicitId) ? explicitId
        : rawId && interactions.has(rawId) ? rawId
          : stringOrEmpty(raw.mirrorId)
      const officialCallId = kind === 'approval'
        ? stringOrEmpty(raw.callId) || stringOrEmpty(raw.toolCallId)
        : stringOrEmpty(raw.callId) || stringOrEmpty(raw.wait?.callId)
      let record = mirrorId ? interactions.get(mirrorId) : null
      if (!record && rawId) record = interactions.get(byMirrorId.get(rawId) || '') || null
      if (!record && officialCallId) record = interactions.get(byOfficialCallId.get(officialCallId) || '') || null
      if (!record && explicitId) record = interactions.get(explicitId) || null
      const sessionId = raw.sessionId || raw.agent?.session?.id || getSessionId()
      if (!record) {
        // A consumer-supplied interactionId is the product identity to adopt;
        // otherwise the mirror id is used, and a pure official projection gets
        // a generated product id that stays bound to its official call id.
        const adoptId = explicitId || mirrorId || stringOrEmpty(raw.mirrorId) || newId('int_')
        const adoptMirrorId = mirrorId || stringOrEmpty(raw.mirrorId) || null
        record = createRecord({
          id: adoptId,
          mirrorId: adoptMirrorId,
          kind,
          sessionId,
          officialCallId,
          operation: raw.operation,
          questions: normalizeQuestions(raw.questions),
          toolName: meta.toolName,
          reason: meta.reason,
          createdAt: clock(),
        })
        changed += 1
        continue
      }
      if (!record.officialCallId && officialCallId) {
        record.officialCallId = officialCallId
        record.toolCallId = officialCallId
        byOfficialCallId.set(officialCallId, record.id)
      }
      if (!record.toolName && meta.toolName) record.toolName = meta.toolName
      if (!record.reason && meta.reason) record.reason = meta.reason
      if (!record.officialRequestId && raw.officialRequestId) {
        record.officialRequestId = String(raw.officialRequestId)
        byOfficialRequestId.set(record.officialRequestId, record.id)
      }
      if (kind === 'question' && Array.isArray(raw.questions)) {
        if (refreshSemantics(record, { questions: normalizeQuestions(raw.questions) })) changed += 1
      } else if (kind === 'approval' && raw.operation !== undefined) {
        if (refreshSemantics(record, { operation: normalizeOperation(raw.operation) })) changed += 1
      }
    }
    return changed
  }

  // ------------------------------------------------------------- commands

  function normalizeResolveCommand(command) {
    const cmd = isPlainObject(command) ? command : {}
    const payload = isPlainObject(cmd.payload) ? cmd.payload : {}
    const answerPayload = isPlainObject(payload.answer) ? payload.answer : {}
    const interactionId = stringOrEmpty(cmd.interactionId) || stringOrEmpty(payload.interactionId) || stringOrEmpty(answerPayload.interactionId)
    const commandId = stringOrEmpty(cmd.commandId) || stringOrEmpty(payload.commandId)
    const semanticRevision = integerOrNull(cmd.semanticRevision) ?? integerOrNull(payload.semanticRevision) ?? integerOrNull(answerPayload.semanticRevision)
    const selectionRevision = integerOrNull(cmd.selectionRevision) ?? integerOrNull(payload.selectionRevision) ?? integerOrNull(answerPayload.selectionRevision)
    const decision = payload.decision !== undefined ? payload.decision : answerPayload.decision
    const answers = Array.isArray(payload.answers) ? payload.answers
      : Array.isArray(answerPayload.answers) ? answerPayload.answers
        : Array.isArray(cmd.answers) ? cmd.answers : null
    const idempotencyKey = stringOrEmpty(cmd.idempotencyKey) || stringOrEmpty(payload.idempotencyKey) || commandId
    return {
      commandId,
      interactionId,
      semanticRevision,
      selectionRevision,
      decision,
      answers,
      idempotencyKey,
      operationDigest: stringOrEmpty(payload.operationDigest) || stringOrEmpty(cmd.operationDigest) || null,
      sourceConnectionId: stringOrEmpty(cmd.sourceConnectionId),
      rawPayload: payload,
    }
  }

  function contentCanonical(cmd) {
    if (cmd.decision !== undefined) {
      return {
        kind: 'approval',
        interactionId: cmd.interactionId,
        semanticRevision: cmd.semanticRevision,
        decision: String(cmd.decision ?? ''),
      }
    }
    const answers = Array.isArray(cmd.answers) ? cmd.answers : []
    return {
      kind: 'question',
      interactionId: cmd.interactionId,
      semanticRevision: cmd.semanticRevision,
      selectionRevision: cmd.selectionRevision,
      answers: answers.map((answer) => ({
        id: String(answer?.id ?? ''),
        selected: Array.isArray(answer?.selected) ? answer.selected.map((item) => String(item)).sort() : [],
        custom: typeof answer?.custom === 'string' ? answer.custom.trim() : '',
      })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    }
  }

  function findReplay(key, contentDigest, targetDigest) {
    const held = memoryReceipts.get(key)
    if (held) {
      if (held.contentDigest !== contentDigest || held.targetDigest !== targetDigest) return { conflict: true }
      return { held }
    }
    const recovered = recoveredKeys.get(key)
    if (recovered) {
      if (recovered.contentDigest !== contentDigest || recovered.targetDigest !== targetDigest) return { conflict: true }
      return { recovered }
    }
    return null
  }

  function replayConflictReceipt(commandId) {
    return rejectedReceipt(commandId, 'IDEMPOTENCY_CONFLICT', 'this idempotency key was already used with a different payload or target')
  }

  function recoveredInteractionReceipt(commandId, interactionId, recovered) {
    const at = recovered.at || isoNow()
    if (recovered.status === 'resolved') {
      return makeReceipt({
        commandId,
        status: 'resolved',
        result: { interactionId, outcome: recovered.outcome ?? 'answered', semanticRevision: recovered.semanticRevision ?? null, at, alreadyResolved: true, recovered: true },
        at,
      })
    }
    if (recovered.status === 'rejected') {
      return makeReceipt({
        commandId,
        status: 'rejected',
        result: { interactionId, outcome: recovered.outcome ?? 'expired', semanticRevision: recovered.semanticRevision ?? null, at, recovered: true },
        error: recovered.error || { code: 'INTERACTION_EXPIRED', message: 'the interaction expired before a decision arrived' },
        at,
      })
    }
    return makeReceipt({
      commandId,
      status: 'unknown',
      result: { interactionId, outcome: 'unknown', semanticRevision: recovered.semanticRevision ?? null, at, recovered: true },
      error: recovered.error || { code: 'INTERACTION_UNKNOWN', message: 'the official result could not be confirmed' },
      at,
    })
  }

  function finalReceiptFor(record, commandId, key) {
    const mapped = statusForState(record.state)
    const held = key ? memoryReceipts.get(key) : null
    return makeReceipt({
      commandId,
      status: mapped.status,
      result: {
        interactionId: record.id,
        outcome: record.outcome,
        semanticRevision: record.semanticRevision,
        at: held?.at || isoNow(),
        alreadyResolved: true,
      },
      error: mapped.error,
      at: held?.at || isoNow(),
    })
  }

  function resolve(command) {
    if (disposed) return rejectedReceipt(stringOrEmpty(command?.commandId), 'REGISTRY_DISPOSED', 'the interaction registry was disposed')
    const cmd = normalizeResolveCommand(command)
    if (!cmd.commandId) return rejectedReceipt('', 'MISSING_COMMAND_ID', 'commandId is required')
    if (!cmd.interactionId) return rejectedReceipt(cmd.commandId, 'MISSING_INTERACTION_ID', 'interactionId is required')
    const contentDigest = safeDigest(contentCanonical(cmd))
    const targetDigest = safeDigest({ interactionId: cmd.interactionId })
    if (!contentDigest || !targetDigest) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'command payload must be JSON-serializable')
    const replay = findReplay(cmd.idempotencyKey, contentDigest, targetDigest)
    if (replay?.conflict) return replayConflictReceipt(cmd.commandId)
    if (replay?.held) return receiptFromHeld(replay.held, { commandId: cmd.commandId })
    if (replay?.recovered) return receiptFromRecovered(replay.recovered, { commandId: cmd.commandId })
    const record = interactions.get(cmd.interactionId)
    if (!record) {
      const recovered = recoveredByInteraction.get(cmd.interactionId)
      if (recovered) return recoveredInteractionReceipt(cmd.commandId, cmd.interactionId, recovered)
      return rejectedReceipt(cmd.commandId, 'INTERACTION_NOT_FOUND', 'no interaction with this id is known', { result: { interactionId: cmd.interactionId } })
    }
    return resolveForRecord(record, cmd, contentDigest, targetDigest)
  }

  function resolveForRecord(record, cmd, contentDigest, targetDigest) {
    if (record.state === 'expired') {
      return makeReceipt({
        commandId: cmd.commandId,
        status: 'rejected',
        result: { interactionId: record.id, outcome: 'expired', semanticRevision: record.semanticRevision, at: isoNow() },
        error: { code: 'INTERACTION_EXPIRED', message: 'the interaction expired before a decision arrived; no new work was created' },
      })
    }
    if (record.state === 'unknown') {
      return makeReceipt({
        commandId: cmd.commandId,
        status: 'unknown',
        result: { interactionId: record.id, outcome: 'unknown', semanticRevision: record.semanticRevision, at: isoNow() },
        error: { code: 'INTERACTION_UNKNOWN', message: 'the official result is unknown; verify the official interaction before retrying' },
      })
    }
    if (record.state === 'resolved' || record.state === 'cancelled') {
      return finalReceiptFor(record, cmd.commandId, null)
    }
    const wantsApproval = cmd.decision !== undefined
    if (record.kind === 'approval' && !wantsApproval) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'an approval needs a decision')
    if (record.kind === 'question' && wantsApproval) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'a question needs an answer batch, not an approval decision')
    if (record.state === 'resolving') {
      const sameContent = record.deciding && record.deciding.contentDigest === contentDigest
      if (sameContent) {
        const held = {
          key: cmd.idempotencyKey,
          commandId: cmd.commandId,
          interactionId: record.id,
          kind: record.kind,
          contentDigest,
          targetDigest,
          status: 'accepted',
          outcome: null,
          error: null,
          semanticRevision: record.semanticRevision,
          at: isoNow(),
          persist: true,
        }
        rememberReceipt(held)
        bindKey(record.id, held.key)
        persistReceipt(held)
        return makeReceipt({
          commandId: cmd.commandId,
          status: 'accepted',
          result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, inFlight: true, decidingCommandId: record.deciding.commandId, at: held.at },
        })
      }
      return makeReceipt({
        commandId: cmd.commandId,
        status: 'rejected',
        result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, inFlight: true, decidingCommandId: record.deciding?.commandId ?? null, at: isoNow() },
        error: { code: 'DECISION_CONFLICT', message: 'another decision is already being applied to this official interaction' },
      })
    }

    // ---- pending: validate the revision, the operation binding, the payload
    let decision = null
    let answers = null
    if (record.kind === 'approval') {
      decision = typeof cmd.decision === 'string' ? cmd.decision : ''
      if (!DECISIONS.has(decision)) return rejectedReceipt(cmd.commandId, 'INVALID_DECISION', 'decision must be allowed-once or rejected')
      if (cmd.semanticRevision !== null && cmd.semanticRevision !== record.semanticRevision) {
        const previous = record.revisions.find((entry) => entry.revision === cmd.semanticRevision)
        if (!previous || previous.digest !== record.semanticDigest) {
          return rejectedReceipt(cmd.commandId, 'REVISION_MISMATCH', 'the approval operation changed semantically; present the current request again', { result: { interactionId: record.id, currentSemanticRevision: record.semanticRevision, semanticRevision: cmd.semanticRevision } })
        }
      }
      if (cmd.operationDigest && record.operationDigest && cmd.operationDigest !== record.operationDigest) {
        return rejectedReceipt(cmd.commandId, 'OPERATION_MISMATCH', 'the approval decision is bound to a different operation summary', { result: { interactionId: record.id, semanticRevision: record.semanticRevision } })
      }
    } else {
      const prepared = prepareAnswersForRevision(record, cmd.semanticRevision, cmd.answers || [])
      if (prepared.error) return rejectedReceipt(cmd.commandId, prepared.error.code, prepared.error.message, { result: { interactionId: record.id, currentSemanticRevision: record.semanticRevision, semanticRevision: cmd.semanticRevision } })
      if (cmd.selectionRevision !== null && record.draft && cmd.selectionRevision !== record.draft.selectionRevision) {
        return makeReceipt({
          commandId: cmd.commandId,
          status: 'rejected',
          result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, ...draftResult(record) },
          error: { code: 'SELECTION_REVISION_MISMATCH', message: 'the question draft changed since it was shown; refresh the draft before submitting' },
        })
      }
      if (!Array.isArray(cmd.answers) || cmd.answers.length === 0) {
        return rejectedReceipt(cmd.commandId, 'INVALID_ANSWER', 'a complete answer batch is required; partial submits are not accepted')
      }
      try {
        const normalized = normalizeAnswerBatch(record, prepared.answers, cmd.semanticRevision ?? record.semanticRevision)
        answers = normalized
      } catch (error) {
        if (error instanceof ContractError) return rejectedReceipt(cmd.commandId, error.code, error.message)
        return rejectedReceipt(cmd.commandId, 'INVALID_ANSWER', String(error?.message || error))
      }
    }

    // ---- begin the single in-flight decision
    record.state = 'resolving'
    record.deciding = { commandId: cmd.commandId, key: cmd.idempotencyKey, contentDigest, at: clock(), decision }
    record.updatedAt = clock()
    const held = {
      key: cmd.idempotencyKey,
      commandId: cmd.commandId,
      interactionId: record.id,
      kind: record.kind,
      contentDigest,
      targetDigest,
      status: 'accepted',
      outcome: null,
      error: null,
      semanticRevision: record.semanticRevision,
      at: isoNow(),
      persist: true,
      upgraded: false,
    }
    rememberReceipt(held)
    bindKey(record.id, held.key)
    persistReceipt(held)
    persistState()

    let officialResult
    officialCalls += 1
    try {
      officialResult = applyOfficialDecisionOnce(record, { decision, answers, commandId: cmd.commandId })
    } catch (error) {
      record.state = 'pending'
      record.deciding = null
      persistState()
      const info = errorInfo(error)
      if (['BAD_ANSWER', 'INVALID_ANSWER', 'INVALID_DECISION', 'INVALID_PAYLOAD', 'OFFICIAL_UNAVAILABLE', 'OFFICIAL_REJECTED'].includes(info.code)) {
        held.status = 'rejected'
        held.error = info
        persistReceipt(held)
        return makeReceipt({ commandId: cmd.commandId, status: 'rejected', result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, at: held.at }, error: info })
      }
      if (!FINAL_STATES.has(record.state)) {
        finalize(record, {
          state: 'unknown',
          outcome: 'unknown',
          source: 'local',
          error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official decision could not be confirmed: ' + info.message },
        })
      }
      return receiptFromHeld(memoryReceipts.get(cmd.idempotencyKey) || held, { commandId: cmd.commandId })
    }

    if (isPromiseLike(officialResult)) {
      officialResult.then(
        (value) => { settleFromOfficial(value, record) },
        (error) => { settleOfficialFailure(record, error) },
      )
      return makeReceipt({
        commandId: cmd.commandId,
        status: 'accepted',
        result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, inFlight: true, at: held.at },
      })
    }
    if (officialResult === false) {
      // The official answerer no longer holds this request. If a settlement was
      // observed meanwhile it already converged; otherwise the result is unknown
      // and must not be retried blindly.
      if (!FINAL_STATES.has(record.state)) {
        const stillPresent = Boolean(mirror?.snapshot?.().some((view) => view.id === record.mirrorId))
        if (stillPresent) {
          record.state = 'pending'
          record.deciding = null
          persistState()
          held.status = 'rejected'
          held.error = { code: 'OFFICIAL_REJECTED', message: 'the official answerer declined this decision' }
          persistReceipt(held)
          return makeReceipt({ commandId: cmd.commandId, status: 'rejected', result: { interactionId: record.id, outcome: null, semanticRevision: record.semanticRevision, at: held.at }, error: held.error })
        }
        finalize(record, {
          state: 'unknown',
          outcome: 'unknown',
          source: 'local',
          error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official service no longer holds this request and no result was observed' },
        })
        return receiptFromHeld(memoryReceipts.get(cmd.idempotencyKey) || held, { commandId: cmd.commandId })
      }
      return finalReceiptFor(record, cmd.commandId, cmd.idempotencyKey)
    }
    // Synchronous official acceptance that did not settle through the mirror
    // hook (custom officialAnswer): accept the returned concrete result.
    if (!FINAL_STATES.has(record.state)) settleFromOfficial(officialResult, record)
    // The invocation that performed the decision returns the resolved receipt
    // itself; only *late duplicate* answers get alreadyResolved:true.
    const settled = memoryReceipts.get(cmd.idempotencyKey) || held
    settled.upgraded = false
    if (FINAL_STATES.has(record.state)) {
      const mapped = statusForState(record.state)
      settled.status = mapped.status
      settled.outcome = record.outcome
      settled.error = mapped.error
      settled.at = isoNow()
      persistReceipt(settled)
    }
    return receiptFromHeld(settled, { commandId: cmd.commandId })
  }

  function settleFromOfficial(value, record) {
    if (!record) return
    const mapped = mapOfficialReturnValue(record, value)
    if (mapped?.pending) return
    if (!isOpen(record)) {
      if (FINAL_STATES.has(record.state)) {
        if (record.state === 'resolved') {
          record.confirmedByOfficial = true
          if (mapped?.officialOutcome) record.officialOutcome = mapped.officialOutcome
          persistState()
        } else if (mapped && mapped.state === 'resolved') {
          finalize(record, { state: 'resolved', outcome: mapped.outcome, source: 'official', officialOutcome: mapped.officialOutcome ?? mapped.outcome, answerBatch: mapped.answerBatch ?? null, force: true })
        }
      }
      return
    }
    if (!mapped || mapped.state === 'unknown') {
      finalize(record, {
        state: 'unknown',
        outcome: 'unknown',
        source: 'official',
        error: mapped?.error || { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official result could not be confirmed' },
      })
      return
    }
    finalize(record, {
      state: mapped.state,
      outcome: mapped.outcome,
      source: 'official',
      officialOutcome: mapped.officialOutcome ?? mapped.outcome,
      answerBatch: mapped.answerBatch ?? record.answerBatch,
      error: mapped.error ?? null,
      force: true,
    })
  }

  function settleOfficialFailure(record, error) {
    if (!record || !isOpen(record)) return
    const info = errorInfo(error, 'OFFICIAL_RESULT_UNKNOWN')
    if (info.code === 'ASK_ABORTED') {
      finalize(record, { state: 'cancelled', outcome: 'cancelled', source: 'official', error: info })
      return
    }
    finalize(record, { state: 'unknown', outcome: 'unknown', source: 'local', error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official decision could not be confirmed: ' + info.message } })
  }

  function mapOfficialReturnValue(record, value) {
    if (value === null || value === undefined) return { state: 'unknown', error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official answerer returned no result' } }
    if (value === true) {
      if (record.kind === 'approval') {
        const decision = record.deciding?.decision
        if (DECISIONS.has(decision)) return { state: 'resolved', outcome: decision, officialOutcome: decision }
        return { state: 'unknown', error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'the official approval result was not reported' } }
      }
      return { state: 'resolved', outcome: 'answered', officialOutcome: 'answered' }
    }
    if (typeof value === 'string') {
      if (record.kind === 'approval') return officialOutcomeFor('approval', { outcome: value })
      return officialOutcomeFor('question', { outcome: value })
    }
    if (isPlainObject(value)) {
      if (value.pending === true) return { pending: true }
      const status = stringOrEmpty(value.status).toLowerCase()
      if (status === 'unknown') return { state: 'unknown', error: errorInfo(value.error, 'OFFICIAL_RESULT_UNKNOWN') }
      if (status === 'accepted' || status === 'pending') return { pending: true }
      if (value.outcome !== undefined) {
        const mapped = record.kind === 'approval'
          ? officialOutcomeFor('approval', { outcome: value.outcome })
          : officialOutcomeFor('question', { outcome: value.outcome })
        if (value.answers !== undefined) mapped.answerBatch = labelsToAnswerBatch(record, value.answers ? { answers: value.answers } : null)
        return mapped
      }
      if (status === 'resolved' || status === 'rejected') {
        const outcome = record.kind === 'approval' ? (value.decision || record.deciding?.decision) : 'answered'
        if (record.kind === 'approval') return officialOutcomeFor('approval', { outcome })
        return { state: 'resolved', outcome: 'answered', officialOutcome: 'answered' }
      }
      return { state: 'resolved', outcome: record.kind === 'approval' ? (record.deciding?.decision || 'allowed-once') : 'answered', officialOutcome: record.kind === 'approval' ? record.deciding?.decision : 'answered' }
    }
    return { state: 'unknown', error: { code: 'OFFICIAL_RESULT_UNKNOWN', message: 'unrecognized official answerer result' } }
  }

  function normalizeAnswerBatch(record, rawAnswers, semanticRevision) {
    const options = {}
    for (const question of record.questions) {
      options[question.id] = question.options.map((option, index) => exposedOptionId(record, question, option, index))
    }
    // Local import-free validation: contracts.normalizeAnswerValue is the
    // authority, but it needs the option-id map of the *current* revision.
    return validateBatch(record.questions, rawAnswers, options, semanticRevision)
  }

  function validateBatch(questions, rawAnswers, optionIds, semanticRevision) {
    if (!Array.isArray(questions) || questions.length === 0) throw new ContractError('INVALID_QUESTION', 'no questions to answer')
    if (!Array.isArray(rawAnswers) || rawAnswers.length !== questions.length) throw new ContractError('INVALID_ANSWER', 'answer every question exactly once')
    const seen = new Set()
    const answers = []
    for (const raw of rawAnswers) {
      if (!isPlainObject(raw) || typeof raw.id !== 'string' || seen.has(raw.id)) throw new ContractError('INVALID_ANSWER', 'invalid or repeated question id')
      seen.add(raw.id)
      const question = questions.find((candidate) => candidate.id === raw.id)
      if (!question) throw new ContractError('INVALID_ANSWER', 'unknown question id')
      const selection = Array.isArray(raw.selected) ? raw.selected : []
      if (selection.some((item) => typeof item !== 'string')) throw new ContractError('INVALID_ANSWER', 'selection must be option ids')
      const allowed = new Set(optionIds[question.id] || [])
      const unique = [...new Set(selection)]
      if (unique.length !== selection.length) throw new ContractError('INVALID_ANSWER', 'repeated option id')
      if (unique.some((id) => !allowed.has(id))) throw new ContractError('INVALID_ANSWER', 'unknown option id for semantic revision ' + String(semanticRevision))
      if (question.multiSelect !== true && unique.length > 1) throw new ContractError('INVALID_ANSWER', 'single-select question accepts one option')
      const custom = typeof raw.custom === 'string' && raw.custom.trim() !== '' ? raw.custom.trim() : undefined
      answers.push({ id: question.id, selected: unique, ...(custom ? { custom } : {}) })
    }
    for (const question of questions) {
      const answer = answers.find((candidate) => candidate.id === question.id)
      if (!answer) throw new ContractError('INVALID_ANSWER', 'answer every question exactly once')
      if (answer.selected.length === 0 && !answer.custom && question.multiSelect !== true && question.optional !== true) {
        throw new ContractError('INVALID_ANSWER', 'an option or custom answer is required')
      }
    }
    return { answers }
  }

  function applyOfficialDecisionOnce(record, { decision, answers, commandId }) {
    let officialValue = null
    let officialAnswer = null
    if (record.kind === 'approval') {
      officialValue = decision
    } else {
      officialAnswer = { answers: [] }
      for (const answer of answers?.answers || []) {
        const question = (record.questions || []).find((candidate) => candidate.id === answer.id)
        if (!question) continue
        const selected = answer.selected.map((optionId) => {
          const index = question.options.findIndex((_option, position) => exposedOptionId(record, question, question.options[position], position) === optionId)
          return index >= 0 ? question.options[index].label : null
        }).filter((label) => label !== null)
        officialAnswer.answers.push({ id: answer.id, selected, ...(answer.custom ? { custom: answer.custom } : {}) })
      }
      record.answerBatch = answers
    }
    const descriptor = {
      interactionId: record.id,
      mirrorId: record.mirrorId,
      kind: record.kind,
      sessionId: record.sessionId,
      semanticRevision: record.semanticRevision,
      commandId,
      decision: record.kind === 'approval' ? officialValue : null,
      answer: officialAnswer,
      operation: record.operation,
      operationDigest: record.operationDigest,
      interaction: projectionOf(record),
    }
    if (officialAnswerer) return officialAnswerer(descriptor)
    if (record.mirrorId && typeof mirror?.answer === 'function') {
      return mirror.answer(record.mirrorId, record.sessionId, record.kind === 'approval' ? officialValue : officialAnswer)
    }
    throw new ContractError('OFFICIAL_UNAVAILABLE', 'no official answerer is available for this interaction', 503)
  }

  // ---------------------------------------------------------------- drafts

  function normalizeDraftCommand(command, type) {
    const cmd = isPlainObject(command) ? command : {}
    const payload = isPlainObject(cmd.payload) ? cmd.payload : {}
    return {
      commandId: stringOrEmpty(cmd.commandId) || stringOrEmpty(payload.commandId),
      interactionId: stringOrEmpty(cmd.interactionId) || stringOrEmpty(payload.interactionId),
      semanticRevision: integerOrNull(cmd.semanticRevision) ?? integerOrNull(payload.semanticRevision),
      selectionRevision: integerOrNull(cmd.selectionRevision) ?? integerOrNull(payload.selectionRevision),
      questionId: stringOrEmpty(cmd.questionId) || stringOrEmpty(payload.questionId),
      optionId: stringOrEmpty(cmd.optionId) || stringOrEmpty(payload.optionId),
      selected: cmd.selected !== undefined ? cmd.selected : payload.selected,
      text: typeof cmd.text === 'string' ? cmd.text : typeof payload.text === 'string' ? payload.text : '',
      selectionRevisionFromPayload: integerOrNull(payload.selectionRevision),
      type,
    }
  }

  function draftTargetFor(record, cmd) {
    if (!record) return { error: { code: 'INTERACTION_NOT_FOUND', message: 'no interaction with this id is known' } }
    if (record.kind !== 'question') return { error: { code: 'INVALID_INTERACTION_KIND', message: 'only question interactions have drafts' } }
    if (record.state === 'resolved' || record.state === 'cancelled') return { error: statusForState(record.state)?.error || { code: 'INTERACTION_RESOLVED', message: 'the interaction is already resolved' } }
    if (record.state === 'expired') return { error: { code: 'INTERACTION_EXPIRED', message: 'the interaction expired' } }
    if (record.state === 'unknown') return { error: { code: 'INTERACTION_UNKNOWN', message: 'the official result is unknown' } }
    if (record.state === 'resolving') return { error: { code: 'INTERACTION_IN_FLIGHT', message: 'a decision is already being applied to this question' } }
    if (cmd.semanticRevision !== null && cmd.semanticRevision !== record.semanticRevision) {
      return { error: { code: 'REVISION_MISMATCH', message: 'the question changed semantically; refresh the draft', result: { interactionId: record.id, currentSemanticRevision: record.semanticRevision } } }
    }
    if (cmd.selectionRevision !== null && record.draft && cmd.selectionRevision !== record.draft.selectionRevision) {
      return { error: { code: 'SELECTION_REVISION_MISMATCH', message: 'the question draft changed since it was shown', result: { interactionId: record.id, ...draftResult(record) } } }
    }
    let question = null
    if (cmd.questionId) question = (record.questions || []).find((candidate) => candidate.id === cmd.questionId) || null
    else if ((record.questions || []).length === 1) question = record.questions[0]
    if (!question) return { error: { code: 'INVALID_QUESTION', message: 'questionId is required for a multi-question interaction' } }
    return { question }
  }

  function draftCommandContent(cmd) {
    if (cmd.type === 'select') {
      return { type: 'draft.select', interactionId: cmd.interactionId, semanticRevision: cmd.semanticRevision, selectionRevision: cmd.selectionRevision, questionId: cmd.questionId, optionId: cmd.optionId, selected: cmd.selected === true }
    }
    return { type: 'draft.custom', interactionId: cmd.interactionId, semanticRevision: cmd.semanticRevision, selectionRevision: cmd.selectionRevision, questionId: cmd.questionId, text: cmd.text }
  }

  function beginDraftTransaction(cmd, contentDigest, targetDigest) {
    const replay = findReplay(cmd.commandId, contentDigest, targetDigest)
    if (replay?.conflict) return { receipt: replayConflictReceipt(cmd.commandId) }
    if (replay?.held) return { receipt: receiptFromHeld(replay.held, { commandId: cmd.commandId }) }
    if (replay?.recovered) return { receipt: receiptFromRecovered(replay.recovered, { commandId: cmd.commandId }) }
    return null
  }

  function rememberDraftReceipt(cmd, record) {
    const held = {
      key: cmd.commandId,
      commandId: cmd.commandId,
      interactionId: record.id,
      kind: 'draft',
      contentDigest: cmd.__contentDigest || null,
      targetDigest: cmd.__targetDigest || null,
      status: 'resolved',
      outcome: null,
      error: null,
      semanticRevision: record.semanticRevision,
      at: isoNow(),
      persist: false,
      upgraded: false,
      result: draftResult(record),
    }
    rememberReceipt(held)
    return held
  }

  function draftReceipt(cmd, record) {
    const at = isoNow()
    const result = { ...draftResult(record), at }
    const held = rememberDraftReceipt(cmd, record)
    held.at = at
    held.result = result
    return makeReceipt({ commandId: cmd.commandId, status: 'resolved', result, at })
  }


  function draftSelect(command) {
    if (disposed) return rejectedReceipt(stringOrEmpty(command?.commandId), 'REGISTRY_DISPOSED', 'the interaction registry was disposed')
    const cmd = normalizeDraftCommand(command, 'select')
    if (!cmd.commandId) return rejectedReceipt('', 'MISSING_COMMAND_ID', 'commandId is required')
    if (!cmd.interactionId) return rejectedReceipt(cmd.commandId, 'MISSING_INTERACTION_ID', 'interactionId is required')
    if (typeof cmd.selected !== 'boolean') return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'selected must be a boolean (set-selected; toggles are not accepted)')
    const contentDigest = safeDigest(draftCommandContent(cmd))
    const targetDigest = safeDigest({ interactionId: cmd.interactionId })
    if (!contentDigest) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'draft command must be JSON-serializable')
    const replay = beginDraftTransaction(cmd, contentDigest, targetDigest)
    if (replay?.receipt) return replay.receipt
    const record = interactions.get(cmd.interactionId)
    const target = draftTargetFor(record, cmd)
    if (target.error) {
      return makeReceipt({
        commandId: cmd.commandId,
        status: target.error.code === 'INTERACTION_UNKNOWN' ? 'unknown' : 'rejected',
        result: target.error.result || { interactionId: cmd.interactionId },
        error: target.error,
      })
    }
    const optionIds = target.question.options.map((_option, index) => exposedOptionId(record, target.question, target.question.options[index], index))
    if (!optionIds.includes(cmd.optionId)) {
      return rejectedReceipt(cmd.commandId, 'INVALID_OPTION', 'the option does not belong to the current semantic revision', { result: { interactionId: record.id, semanticRevision: record.semanticRevision } })
    }
    const current = record.draft.answers[target.question.id] || { selected: [] }
    const nextSelected = cmd.selected
      ? (target.question.multiSelect === true ? [...new Set([...current.selected, cmd.optionId])] : [cmd.optionId])
      : current.selected.filter((id) => id !== cmd.optionId)
    const unchanged = nextSelected.length === current.selected.length && nextSelected.every((id, index) => id === current.selected[index])
    if (!unchanged) {
      record.draft.answers[target.question.id] = { ...current, selected: nextSelected }
      record.draft.selectionRevision += 1
      record.draft.updatedAt = clock()
      record.viewRevision += 1
      record.updatedAt = record.draft.updatedAt
      emitEvent('interaction.draft.changed', record, { questionId: target.question.id, optionId: cmd.optionId, selected: cmd.selected, ...draftViewOf(record) })
      persistState()
    }
    cmd.__contentDigest = contentDigest
    cmd.__targetDigest = targetDigest
    return draftReceipt(cmd, record)
  }

  function draftCustom(command) {
    if (disposed) return rejectedReceipt(stringOrEmpty(command?.commandId), 'REGISTRY_DISPOSED', 'the interaction registry was disposed')
    const cmd = normalizeDraftCommand(command, 'custom')
    if (!cmd.commandId) return rejectedReceipt('', 'MISSING_COMMAND_ID', 'commandId is required')
    if (!cmd.interactionId) return rejectedReceipt(cmd.commandId, 'MISSING_INTERACTION_ID', 'interactionId is required')
    if (typeof cmd.text !== 'string') return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'text must be a string')
    if (cmd.text.length > MAX_DRAFT_TEXT) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'custom answer is too long')
    const contentDigest = safeDigest(draftCommandContent(cmd))
    const targetDigest = safeDigest({ interactionId: cmd.interactionId })
    if (!contentDigest) return rejectedReceipt(cmd.commandId, 'INVALID_PAYLOAD', 'draft command must be JSON-serializable')
    const replay = beginDraftTransaction(cmd, contentDigest, targetDigest)
    if (replay?.receipt) return replay.receipt
    const record = interactions.get(cmd.interactionId)
    const target = draftTargetFor(record, cmd)
    if (target.error) {
      return makeReceipt({
        commandId: cmd.commandId,
        status: target.error.code === 'INTERACTION_UNKNOWN' ? 'unknown' : 'rejected',
        result: target.error.result || { interactionId: cmd.interactionId },
        error: target.error,
      })
    }
    const current = record.draft.answers[target.question.id] || { selected: [] }
    const nextText = cmd.text.trim()
    const currentText = typeof current.custom === 'string' ? current.custom : ''
    if (nextText !== currentText) {
      record.draft.answers[target.question.id] = { ...current, ...(nextText !== '' ? { custom: nextText } : {}) }
      if (nextText === '' && 'custom' in record.draft.answers[target.question.id]) delete record.draft.answers[target.question.id].custom
      record.draft.selectionRevision += 1
      record.draft.updatedAt = clock()
      record.viewRevision += 1
      record.updatedAt = record.draft.updatedAt
      emitEvent('interaction.draft.changed', record, { questionId: target.question.id, custom: nextText, ...draftViewOf(record) })
      persistState()
    }
    cmd.__contentDigest = contentDigest
    cmd.__targetDigest = targetDigest
    return draftReceipt(cmd, record)
  }

  // ----------------------------------------------------------------- public

  function snapshot() {
    const pending = []
    const drafts = {}
    for (const record of interactions.values()) {
      if (!isOpen(record)) continue
      pending.push(projectionOf(record))
      if (record.kind === 'question' && record.draft) drafts[record.id] = draftViewOf(record)
    }
    return {
      focusedId: focusedId && pending.some((item) => item.id === focusedId) ? focusedId : (pending[0]?.id ?? null),
      pending,
      drafts,
      recentlyResolved: recentlyResolved.map((item) => ({ ...item })),
      unknown: unknownInteractions.map((item) => ({ ...item })),
    }
  }

  function inspect(interactionId) {
    const record = interactions.get(String(interactionId || ''))
    if (!record) {
      const recovered = recoveredByInteraction.get(String(interactionId || ''))
      if (recovered) return { id: String(interactionId), recovered: true, ...recovered }
      return null
    }
    return {
      ...projectionOf(record),
      state: record.state,
      outcome: record.outcome,
      source: record.source,
      officialOutcome: record.officialOutcome,
      confirmedByOfficial: record.confirmedByOfficial,
      deciding: record.deciding ? { commandId: record.deciding.commandId, contentDigest: record.deciding.contentDigest } : null,
      answerBatch: record.answerBatch,
      draft: record.kind === 'question' && record.draft ? draftViewOf(record) : null,
      revisions: record.revisions.map((entry) => ({ revision: entry.revision, digest: entry.digest })),
    }
  }

  function stats() {
    const counts = { pending: 0, resolving: 0, resolved: 0, expired: 0, cancelled: 0, unknown: 0 }
    for (const record of interactions.values()) counts[record.state] = (counts[record.state] || 0) + 1
    return {
      ...counts,
      officialCalls,
      interactions: interactions.size,
      receipts: typeof receiptsStore.size === 'function' ? receiptsStore.size() : memoryReceipts.size,
      recovered: recoveredByInteraction.size,
      unknown: unknownInteractions.length,
      disposed,
    }
  }

  function dispose() {
    if (disposed) return
    persistState()
    disposed = true
    for (const timer of expiryTimers.values()) clearTimeout(timer)
    expiryTimers.clear()
    for (const unsubscribe of unsubscribers.splice(0)) {
      try { unsubscribe() } catch { /* ignore */ }
    }
  }

  // --------------------------------------------------------------- startup

  loadRecovery()
  loadStateRecovery()
  if (mirror && typeof mirror.subscribeRequests === 'function') {
    unsubscribers.push(mirror.subscribeRequests(onMirrorRequest))
  }
  if (mirror && typeof mirror.subscribeSettled === 'function') {
    unsubscribers.push(mirror.subscribeSettled(onMirrorSettled))
  }
  // A registry can be created after the mirror already presents something
  // (integration order, or tests): adopt those requests without answering them.
  // Mirror views are keyed by the mirror's own request id, so adoption must keep
  // that id as both product id and mirror id for later settlement.
  if (mirror && typeof mirror.snapshot === 'function') {
    try {
      for (const view of mirror.snapshot()) {
        if (!view || typeof view.id !== 'string') continue
        adoptMirrorView({ kind: view.kind, id: view.id, sessionId: view.sessionId, view })
      }
    } catch { /* never fail construction on reconciliation */ }
  }

  return {
    observeOfficial,
    syncOfficialRequests,
    resolve,
    draftSelect,
    draftCustom,
    snapshot,
    inspect,
    stats,
    pendingIds: () => [...interactions.values()].filter(isOpen).map((record) => record.id),
    focus(interactionId) {
      const record = interactions.get(String(interactionId || ''))
      if (!record || !isOpen(record)) return false
      focusedId = record.id
      record.viewRevision += 1
      persistState()
      return true
    },
    touchView(interactionId) {
      const record = interactions.get(String(interactionId || ''))
      if (!record) return false
      record.viewRevision += 1
      record.updatedAt = clock()
      persistState()
      return true
    },
    /** Expire an interaction because its product lifetime ended (fail closed). */
    expire(interactionId) {
      const record = interactions.get(String(interactionId || ''))
      if (!record) return false
      return expireInteraction(record)
    },
    dispose,
  }
}
