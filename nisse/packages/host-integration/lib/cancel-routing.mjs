/**
 * Cancel routing: the single decision point for every product stop entry.
 *
 * The product has three independent stop classes and they must never
 * substitute for one another:
 *  - `task`     aborts the official DSH turn (irreversible, owns side effects),
 *  - `playback` stops speech output only; the task keeps running,
 *  - `capture`  discards the microphone capture only; the task keeps running.
 *
 * Every entry (`POST /cancel`, `POST /v2/command`, Desktop IPC) hands its
 * request to {@link createCancelRouter}, which decides one of:
 *  - forward: the request carries a target that this host can prove is the
 *    turn/playback/capture it names, so it reaches the owner;
 *  - reject: the request cannot prove its target (missing, incomplete, stale
 *    epoch/session/turn, or already superseded), so nothing is cancelled and
 *    the caller receives a typed error instead of a silent success;
 *  - duplicate: an identical settled request already ran, so the stored
 *    outcome is replayed instead of touching the owner twice.
 *
 * Task cancellation is the only irreversible class, which is why only it
 * requires the full epoch/session/turn identity. Playback and capture are
 * idempotent, local, and cannot touch a successor turn, so a missing id means
 * "the resource this host currently owns" and the resolved id is reported
 * back. This module is dependency-free apart from the shared protocol error
 * type so both the HTTP adapter and the tests can exercise it directly.
 */
import { ContractError, isPlainObject } from './contracts.mjs'

/** The three stop classes. Values are protocol strings, never localized. */
export const CANCEL_KINDS = Object.freeze({ task: 'task', playback: 'playback', capture: 'capture' })

/**
 * Sources each class accepts. A source that names a different class is
 * rejected, so `playback-stop` can never be forwarded as a task cancel.
 */
const SOURCES_BY_KIND = Object.freeze({
  task: Object.freeze(['idle-pause', 'task-stop', 'voice-command', 'voice-disconnect', 'voice-confirm', 'control.cancel-task', 'api']),
  playback: Object.freeze(['voice-control', 'explicit', 'control.stop-playback']),
  capture: Object.freeze(['voice-control', 'user-cancel', 'control.cancel-capture']),
})

/** Product command types that mean "stop something", keyed to their class. */
const KIND_BY_COMMAND = Object.freeze({
  'control.cancel-task': CANCEL_KINDS.task,
  'control.stop-playback': CANCEL_KINDS.playback,
  'control.cancel-capture': CANCEL_KINDS.capture,
})

/** Where a caller must upgrade when the legacy request cannot be bound safely. */
const UPGRADE_HINT = 'Use POST /v2/command (control.cancel-task) with commandId, hostEpoch and a capture-time payload.target, or send hostEpoch + sessionId + turn/clientTurnId to POST /cancel.'

function protocolError(code, message, status = 400, extra = {}) {
  const error = new ContractError(code, message, status)
  Object.assign(error, extra)
  return error
}

/**
 * Class of the stop command a v2 client asked for.
 * @param {string} type - product command type (`control.*`).
 * @returns {'task'|'playback'|'capture'|null} the stop class, or null when the type is not a stop.
 */
export function cancelKindOfCommand(type) {
  return KIND_BY_COMMAND[String(type || '')] ?? null
}

/**
 * Validate that a source belongs to a stop class.
 * @param {string} kind - one of {@link CANCEL_KINDS}.
 * @param {string} source - caller-declared source string.
 * @returns {string} the accepted source.
 * @throws {ContractError} `INVALID_CANCEL_KIND` or `INVALID_CANCEL_SOURCE`.
 */
export function assertCancelSource(kind, source) {
  const allowed = SOURCES_BY_KIND[String(kind || '')]
  if (allowed === undefined) throw protocolError('INVALID_CANCEL_KIND', 'unknown cancel kind: ' + String(kind))
  const value = String(source ?? '')
  if (!allowed.includes(value)) {
    throw protocolError('INVALID_CANCEL_SOURCE', `source "${value}" cannot request a ${kind} stop`, 400, { kind, allowed })
  }
  return value
}

/**
 * Copy a client-observed execution snapshot into a capture-time target.
 * The caller must pass what the client saw when the user asked to stop, not
 * what the host looks like now: that difference is the whole point.
 * @param {object} execution - `snapshotSections().execution` (or `/task-state`) as observed by the caller.
 * @param {object} [options] - `hostEpoch` the caller observed and an injectable clock.
 * @returns {object|null} target identity, or null when the snapshot carries none.
 */
export function captureCancelTarget(execution, { hostEpoch = '', now = () => Date.now() } = {}) {
  if (!isPlainObject(execution)) return null
  const target = {}
  if (typeof execution.sessionId === 'string' && execution.sessionId !== '') target.sessionId = execution.sessionId
  if (execution.turn !== null && execution.turn !== undefined) target.turn = execution.turn
  if (execution.turnId !== null && execution.turnId !== undefined) target.turnId = String(execution.turnId)
  if (typeof execution.clientTurnId === 'string' && execution.clientTurnId !== '') target.clientTurnId = execution.clientTurnId
  if (typeof hostEpoch === 'string' && hostEpoch !== '') target.hostEpoch = hostEpoch
  if (Object.keys(target).length === 0) return null
  target.capturedAt = now()
  return target
}

/** The host's own current scope, shaped like a target so comparisons are symmetric. */
export function currentCancelScope({ execution = null, sessionId = '', hostEpoch = '', playbackId = '', captureId = '' } = {}) {
  const source = isPlainObject(execution) ? execution : {}
  return {
    active: Boolean(source.state && !['idle', 'unknown', 'error'].includes(String(source.state))),
    sessionId: typeof source.sessionId === 'string' && source.sessionId !== '' ? source.sessionId : String(sessionId || ''),
    turn: source.turn ?? null,
    turnId: source.turnId ?? null,
    clientTurnId: source.clientTurnId ?? null,
    hostEpoch: String(hostEpoch || ''),
    playbackId: String(playbackId || ''),
    captureId: String(captureId || ''),
  }
}

function provided(value) {
  return value !== undefined && value !== null && value !== ''
}

/**
 * Normalize a task-stop target and require that it names a turn at all.
 *
 * This is the identity half: shape and completeness only. Whether that identity
 * is still the live turn is decided by {@link assertTaskTargetCurrent}, after a
 * caller has had the chance to replay an already-settled stop.
 * @param {object} options - `target` as the caller stated it.
 * @returns {object} normalized target.
 * @throws {ContractError} `CANCEL_TARGET_REQUIRED` or `CANCEL_TARGET_INCOMPLETE`.
 */
export function normalizeTaskCancelTarget({ target }) {
  if (!isPlainObject(target)) {
    throw protocolError('CANCEL_TARGET_REQUIRED', 'a task stop must name the turn it stops: send hostEpoch, sessionId and turn/clientTurnId captured when the user asked', 400, { upgrade: UPGRADE_HINT })
  }
  const missing = []
  if (!provided(target.hostEpoch)) missing.push('hostEpoch')
  if (!provided(target.sessionId)) missing.push('sessionId')
  const hasTurnIdentity = provided(target.turn) || provided(target.turnId) || provided(target.clientTurnId)
  if (!hasTurnIdentity) missing.push('turn|turnId|clientTurnId')
  if (missing.length > 0) {
    // Nothing but an inherited epoch means the caller named no target at all;
    // any other gap means it named one incompletely.
    const namedSomething = provided(target.sessionId) || hasTurnIdentity
    const code = namedSomething ? 'CANCEL_TARGET_INCOMPLETE' : 'CANCEL_TARGET_REQUIRED'
    throw protocolError(code, 'a task stop must name its target; missing ' + missing.join(', '), 400, { missing, upgrade: UPGRADE_HINT })
  }
  const normalized = {
    hostEpoch: String(target.hostEpoch),
    sessionId: String(target.sessionId),
  }
  if (provided(target.turn)) normalized.turn = target.turn
  if (provided(target.turnId)) normalized.turnId = String(target.turnId)
  if (provided(target.clientTurnId)) normalized.clientTurnId = String(target.clientTurnId)
  if (provided(target.capturedAt)) normalized.capturedAt = target.capturedAt
  return normalized
}

/**
 * Reject a target whose stated identity contradicts the turn this host owns.
 *
 * A supplied field must equal the host's value for that field; when the host holds
 * no value for a field the target states, the claim cannot have come from this
 * host's snapshot, so it is stale rather than merely unknown. Callers run
 * {@link normalizeTaskCancelTarget} first, so "you named too little" (400) is
 * answered before "that turn already ended" (409).
 * @param {object} options - `target`, the host `current` scope, `hostEpoch`, and
 *   `requireActive` (false when only the identity decision is needed).
 * @returns {object} the target that was proven current.
 * @throws {ContractError} `STALE_HOST_EPOCH`, `STALE_SESSION`, `STALE_TURN`, or `NO_ACTIVE_TURN`.
 */
export function assertTaskTargetCurrent({ target, current, hostEpoch = '', requireActive = true }) {
  const scope = isPlainObject(current) ? current : {}
  if (!isPlainObject(target)) throw protocolError('CANCEL_TARGET_REQUIRED', 'a task stop must name the turn it stops', 400, { upgrade: UPGRADE_HINT })
  const expectedEpoch = String(hostEpoch || scope.hostEpoch || '')
  if (provided(target.hostEpoch) && expectedEpoch !== '' && String(target.hostEpoch) !== expectedEpoch) {
    throw protocolError('STALE_HOST_EPOCH', 'hostEpoch is no longer current; resync the snapshot before cancelling', 409, { upgrade: UPGRADE_HINT })
  }
  const compare = (field, code, message) => {
    if (!provided(target[field])) return
    if (!provided(scope[field]) || String(target[field]) !== String(scope[field])) throw protocolError(code, message, 409)
  }
  compare('sessionId', 'STALE_SESSION', 'the cancelled target belongs to a different session')
  compare('turnId', 'STALE_TURN', 'the cancelled turn is no longer the active turn')
  compare('clientTurnId', 'STALE_TURN', 'the cancelled request is no longer the active request')
  compare('turn', 'STALE_TURN', 'the cancelled DSH turn is no longer the active turn')
  if (requireActive !== false && scope.active === false) {
    // Nothing is running: say so, never answer 200 as if a stop happened.
    throw protocolError('NO_ACTIVE_TURN', 'no turn is running, so there is nothing to stop', 409)
  }
  return target
}

/**
 * Normalize and prove one task target in one call.
 * @param {object} options - `target`, `current`, `hostEpoch`, `requireActive`.
 * @returns {object} the normalized, proven target.
 * @throws {ContractError} every refusal of the two functions above.
 */
export function assertTaskCancelTarget({ target, current, hostEpoch = '', requireActive = true }) {
  const normalized = normalizeTaskCancelTarget({ target })
  return assertTaskTargetCurrent({ target: normalized, current, hostEpoch, requireActive })
}

/**
 * Prove that a playback or capture stop names the resource the host owns.
 * These classes are idempotent and cannot affect a successor turn, so an
 * omitted id resolves to the host's current resource and the caller learns
 * which id was used. `NO_PLAYBACK_*`/`NO_CAPTURE` is still an explicit refusal.
 * @param {object} options - `kind`, `target`, and the host `current` scope.
 * @returns {object} normalized target with the resolved resource id.
 * @throws {ContractError} `NO_CAPTURE` or `CANCEL_TARGET_REQUIRED`.
 */
export function assertLocalStopTarget({ kind, target, current }) {
  const scope = isPlainObject(current) ? current : {}
  const requested = isPlainObject(target) ? target : {}
  if (kind === CANCEL_KINDS.capture) {
    const captureId = String(requested.captureId || scope.captureId || '')
    if (captureId === '') throw protocolError('NO_CAPTURE', 'no capture is active, so there is nothing to discard', 409)
    return { captureId }
  }
  if (kind === CANCEL_KINDS.playback) {
    const playbackId = String(requested.playbackId || scope.playbackId || '')
    if (playbackId === '') throw protocolError('NO_PLAYBACK', 'nothing is being spoken, so there is nothing to stop', 409)
    return { playbackId }
  }
  throw protocolError('INVALID_CANCEL_KIND', 'unknown cancel kind: ' + String(kind))
}

/**
 * Decide one stop request against the host's current scope.
 * @param {object} request - `{ kind, source, target, current }`.
 * @param {object} [context] - `{ hostEpoch }` for the shared instance identity.
 * @returns {object} `{ action: 'forward', kind, source, target }`; rejections throw.
 * @throws {ContractError} the typed refusal described by the assert helpers.
 */
export function planCancel(request, { hostEpoch = '' } = {}) {
  const kind = String(request?.kind || '')
  const source = assertCancelSource(kind, request?.source)
  if (kind !== CANCEL_KINDS.task) {
    const target = assertLocalStopTarget({ kind, target: request?.target, current: request?.current })
    return { action: 'forward', kind, source, target, binding: 'captured-target' }
  }
  // Completeness first, then contradiction, then liveness; a caller replaying a
  // settled stop goes through the router, which consults its settled table before
  // any of these checks.
  const normalized = normalizeTaskCancelTarget({ target: request?.target })
  const target = assertTaskTargetCurrent({ target: normalized, current: request?.current, hostEpoch })
  return { action: 'forward', kind, source, target, binding: 'captured-target' }
}

/**
 * V2 client target: the payload target is authoritative, and the session the
 * command envelope declared becomes the fallback only when it is the current
 * session (a mismatched envelope session never reaches here: `validateCommand`
 * already rejected it as `STALE_SESSION`).
 * @param {object} payload - `control.cancel-task` payload.
 * @param {object} [options] - `hostEpoch` for the shared instance identity.
 * @returns {object|undefined} the target to prove, or undefined when the client sent none.
 */
export function commandCancelTarget(payload, { hostEpoch = '' } = {}) {
  if (!isPlainObject(payload) || !isPlainObject(payload.target)) return undefined
  const target = { ...payload.target }
  if (provided(hostEpoch) && !provided(target.hostEpoch)) target.hostEpoch = hostEpoch
  return target
}

/**
 * Map a legacy `/cancel` body onto a request-shaped plan.
 * Only the task class is reachable here: the legacy endpoint has no playback
 * or capture variant, and an unknown source is refused rather than guessed.
 * @param {object} body - decoded legacy request body.
 * @param {object} options - the host `current` scope and `hostEpoch`.
 * @returns {object} `{ kind, source, target, current }` ready for {@link planCancel}.
 */
export function legacyCancelRequest(body, { current, hostEpoch = '' }) {
  const request = isPlainObject(body) ? body : {}
  const source = request.source === undefined ? 'task-stop' : String(request.source)
  const target = {}
  for (const field of ['hostEpoch', 'sessionId', 'turn', 'turnId', 'clientTurnId']) {
    if (provided(request[field])) target[field] = request[field]
  }
  if (!provided(target.hostEpoch) && provided(hostEpoch)) target.hostEpoch = hostEpoch
  return { kind: CANCEL_KINDS.task, source, target, current }
}

/**
 * Turn an owner result into the only classifier the UI may read.
 *
 * `cancelled` alone is not a stop: the owner sets it before the official turn
 * has ended, so success requires the official confirmation *and* the target the
 * owner reports back to be the target that was asked for.
 * @param {object|null} result - the owner result (`cancelTurn` / `requestCancelTask`).
 * @param {object} [request] - the forwarded `{ kind, target }` plan.
 * @returns {object} `{ state, confirmed, success, code }`.
 */
export function classifyCancelResult(result, request = {}) {
  const kind = String(request.kind || CANCEL_KINDS.task)
  const wanted = isPlainObject(request.target) ? request.target : null
  if (!isPlainObject(result)) return { kind, state: 'unknown', confirmed: false, success: false, code: 'CANCEL_OUTCOME_UNKNOWN' }
  if (result.error !== undefined && result.error !== null && result.error !== '') {
    return { kind, state: 'failed', confirmed: false, success: false, code: 'CANCEL_FAILED' }
  }
  if (result.cancelled !== true) return { kind, state: 'not-cancelled', confirmed: false, success: false, code: 'NOT_CANCELLED' }
  if (result.confirmed !== true) return { kind, state: 'unconfirmed', confirmed: false, success: false, code: 'CANCEL_UNCONFIRMED' }
  const reported = isPlainObject(result.target) ? result.target : null
  if (wanted !== null && reported !== null) {
    for (const field of ['sessionId', 'turn', 'clientTurnId']) {
      if (provided(wanted[field]) && provided(reported[field]) && String(wanted[field]) !== String(reported[field])) {
        // The owner confirmed some other turn: never present that as this stop.
        return { kind, state: 'mismatch', confirmed: false, success: false, code: 'CANCEL_TARGET_MISMATCH' }
      }
    }
  }
  return { kind, state: 'confirmed', confirmed: true, success: true, code: 'CANCELLED' }
}

const NOTICE_TEXT = Object.freeze({
  task: Object.freeze({
    confirmed: Object.freeze({ severity: 'info', text: 'DSH 已确认任务停止。' }),
    pending: Object.freeze({ severity: 'warning', text: '已请求停止任务，正在等待 DSH 确认；在确认前不会显示为已停止。' }),
    'not-cancelled': Object.freeze({ severity: 'info', text: '没有正在执行的任务，未发生停止。' }),
    unconfirmed: Object.freeze({ severity: 'warning', text: '已发出停止请求，DSH 未确认；任务结果未知，不会自动重试，请打开主窗口检查。' }),
    mismatch: Object.freeze({ severity: 'error', text: '停止请求指向的不是当前任务，已拒绝；当前任务继续执行。' }),
    failed: Object.freeze({ severity: 'error', text: '停止请求未被接受，任务仍在执行或结果未知；请打开主窗口检查。' }),
    unknown: Object.freeze({ severity: 'error', text: '无法确认停止结果，任务可能仍在执行；请打开主窗口检查。' }),
  }),
  playback: Object.freeze({
    confirmed: Object.freeze({ severity: 'info', text: '已停止播报；任务仍在执行。' }),
    pending: Object.freeze({ severity: 'info', text: '正在停止播报；任务不受影响。' }),
    'not-cancelled': Object.freeze({ severity: 'info', text: '当前没有播报，未发生停止。' }),
    unconfirmed: Object.freeze({ severity: 'warning', text: '停止播报请求未被确认；任务不受影响，需要停止任务请单独确认。' }),
    mismatch: Object.freeze({ severity: 'error', text: '停止播报请求指向的不是当前播报，已拒绝；任务不受影响。' }),
    failed: Object.freeze({ severity: 'error', text: '停止播报失败；任务不受影响。' }),
    unknown: Object.freeze({ severity: 'error', text: '无法确认播报是否已停止；任务不受影响。' }),
  }),
  capture: Object.freeze({
    confirmed: Object.freeze({ severity: 'info', text: '已取消录音；任务不受影响。' }),
    pending: Object.freeze({ severity: 'info', text: '正在取消录音；任务不受影响。' }),
    'not-cancelled': Object.freeze({ severity: 'info', text: '当前没有录音，未发生变更。' }),
    unconfirmed: Object.freeze({ severity: 'warning', text: '取消录音请求未被确认；任务不受影响。' }),
    mismatch: Object.freeze({ severity: 'error', text: '取消录音请求指向的不是当前录音，已拒绝；任务不受影响。' }),
    failed: Object.freeze({ severity: 'error', text: '取消录音失败；任务不受影响。' }),
    unknown: Object.freeze({ severity: 'error', text: '无法确认录音是否已取消；任务不受影响。' }),
  }),
})

/**
 * User-visible text for one classified outcome. The wording is per class, so a
 * playback or capture stop can never read as "the task stopped".
 * @param {string} kind - one of {@link CANCEL_KINDS}.
 * @param {'confirmed'|'pending'|'not-cancelled'|'unconfirmed'|'mismatch'|'failed'|'unknown'} state - classification state.
 * @returns {{severity: string, text: string}} notice payload.
 */
export function cancelNotice(kind, state) {
  const table = NOTICE_TEXT[String(kind || '')] ?? NOTICE_TEXT.task
  return table[String(state)] ?? NOTICE_TEXT.task.unknown
}

function targetKey(kind, source, target) {
  const scope = isPlainObject(target) ? target : {}
  const identity = kind === CANCEL_KINDS.task
    ? [scope.sessionId, scope.turn ?? '', scope.turnId ?? '', scope.clientTurnId ?? '']
    : [scope.playbackId ?? '', scope.captureId ?? '']
  return [kind, source, ...identity.map(item => String(item))].join('\u0000')
}

/**
 * Router shared by every entry: plans, deduplicates, and classifies. It owns no
 * cancellation side effect of its own, so the HTTP adapter stays the only place
 * that calls into the turn/playback/capture owners.
 * @param {object} options - `hostEpoch`, an injectable clock, a logger, and the dedupe capacity.
 * @returns {object} router with `plan`, `record`, `outcome`, and `describe`.
 */
export function createCancelRouter({ hostEpoch, now = () => Date.now(), log = () => {}, capacity = 128 } = {}) {
  const settled = new Map()

  function remember(key, outcome) {
    settled.set(key, outcome)
    while (settled.size > capacity) settled.delete(settled.keys().next().value)
    return outcome
  }

  function plan(request) {
    const kind = String(request?.kind || '')
    const source = assertCancelSource(kind, request?.source)
    if (kind !== CANCEL_KINDS.task) {
      const computed = assertLocalStopTarget({ kind, target: request?.target, current: request?.current })
      const key = targetKey(kind, source, computed)
      const previous = settled.get(key)
      if (previous !== undefined) return { action: 'duplicate', kind, source, target: computed, outcome: previous }
      return { action: 'forward', kind, source, target: computed, key }
    }
    // The settled table is consulted first, on the identity the caller stated: an
    // exact repeat of a stop that already settled replays its outcome even though
    // the turn it names is now correctly idle. Running the owner twice would
    // settle interactions of a successor turn.
    const key = targetKey(kind, source, request?.target)
    const previous = settled.get(key)
    if (previous !== undefined) return { action: 'duplicate', kind, source, target: request?.target, outcome: previous }
    // Completeness before contradiction: a request that names too little is told
    // which fields are missing, rather than being reported as stale because the one
    // field it did send is no longer current.
    const computed = normalizeTaskCancelTarget({ target: request?.target })
    assertTaskTargetCurrent({ target: computed, current: request?.current, hostEpoch })
    return { action: 'forward', kind, source, target: computed, key }
  }

  function record(forwarded, result) {
    const outcome = classifyCancelResult(result, forwarded)
    remember(forwarded.key ?? targetKey(forwarded.kind, forwarded.source, forwarded.target), outcome)
    if (!outcome.success) log('cancel.not_confirmed', { kind: forwarded.kind, source: forwarded.source, code: outcome.code })
    return outcome
  }

  return {
    plan,
    record,
    describe: (kind, outcome) => cancelNotice(kind, outcome?.state ?? 'unknown'),
    /** Complete a planned request and return the wire result for one entry. */
    settle(forwarded, result) {
      const outcome = record(forwarded, result)
      const notice = cancelNotice(forwarded.kind, outcome.state)
      return {
        ok: outcome.success,
        kind: forwarded.kind,
        state: outcome.state,
        confirmed: outcome.confirmed,
        cancelled: outcome.confirmed,
        code: outcome.code,
        target: forwarded.target,
        notice,
        settledAt: now(),
      }
    },
    /** Test/diagnostic view: how many settled requests this router remembers. */
    size: () => settled.size,
  }
}
