/**
 * S2 cancel-routing behaviour.
 *
 * These cases drive the real routing module against the real Host turn model
 * (`conversation-model.mjs`) plus playback/capture/interaction state, and assert
 * the *official* state of the successor turn after every request — refusing a
 * stale request is only half the claim; the other half is that nothing else moved.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTurnModel } from '../lib/conversation-model.mjs'
import {
  CANCEL_KINDS,
  assertCancelSource,
  assertTaskTargetCurrent,
  cancelNotice,
  captureCancelTarget,
  classifyCancelResult,
  commandCancelTarget,
  createCancelRouter,
  currentCancelScope,
  legacyCancelRequest,
  planCancel,
} from '../lib/cancel-routing.mjs'

const EPOCH = 'host-epoch-alpha'
const CLOCK = 1_700_000_000_000

/** A stop that the fake owner reports as fully confirmed by DSH. */
function confirmed(target) {
  return { ok: true, cancelled: true, confirmed: true, sessionId: target.sessionId, target: { sessionId: target.sessionId, turn: target.turn ?? null } }
}

/**
 * Fake Host: the turn model owns task identity, and playback/capture/approval
 * state is projected the same way `conversation-service.mjs` projects it.
 */
function createFakeHost({ hostEpoch = EPOCH, now = () => CLOCK } = {}) {
  const turn = createTurnModel({ now })
  const model = {
    playback: { playbackId: null, state: 'idle' },
    capture: { captureId: null, state: 'off' },
    approvals: [],
    cancelCalls: 0,
    cancelTargets: [],
    cancelResults: [],
    playbackStops: [],
    captureDiscards: [],
  }

  function startTurn({ sessionId = 'session-1', number = 1, clientTurnId = '' } = {}) {
    turn.beginAdmission({ sessionId, clientTurnId, inputSource: 'voice', text: 'fixture' })
    turn.admitted({ turn: number })
    model.approvals.push({ id: `approval-${sessionId}-${String(number)}`, kind: 'approval', sessionId, turn: number, outcome: null })
    return turn.snapshot()
  }

  function endTurn({ terminal = 'completed' } = {}) {
    const snapshot = turn.snapshot()
    turn.observeTurnEnd({ turn: snapshot.turn, turnId: snapshot.turnId, terminal, reason: { kind: terminal } })
    return turn.snapshot()
  }

  function startPlayback(playbackId) {
    model.playback = { playbackId, state: 'speaking' }
  }

  function startCapture(captureId) {
    model.capture = { captureId, state: 'capturing' }
  }

  const host = {
    model,
    turn,
    startTurn,
    endTurn,
    startPlayback,
    startCapture,
    execution: () => turn.snapshot(),
    current: () => currentCancelScope({
      execution: turn.snapshot(),
      hostEpoch,
      playbackId: model.playback.playbackId,
      captureId: model.capture.captureId,
    }),
    /** What an observer and the gate may treat as official state. */
    officialState() {
      const snapshot = turn.snapshot()
      return {
        state: snapshot.state,
        sessionId: snapshot.sessionId,
        turn: snapshot.turn,
        clientTurnId: snapshot.clientTurnId,
        approvals: model.approvals.map(item => ({ id: item.id, turn: item.turn, outcome: item.outcome })),
        playback: { ...model.playback },
        capture: { ...model.capture },
      }
    },
    apply(forwarded) {
      if (forwarded.kind === CANCEL_KINDS.task) {
        const target = forwarded.target
        model.cancelCalls += 1
        model.cancelTargets.push(target)
        turn.requestCancel({ target })
        for (const approval of model.approvals) {
          if (approval.outcome === null && String(approval.turn) === String(target.turn)) approval.outcome = 'cancelled'
        }
        const result = model.cancelResults.shift() ?? confirmed(target)
        if (result.confirmed === true) turn.cancelConfirmed()
        else turn.markUnknown('cancel-not-confirmed')
        return result
      }
      if (forwarded.kind === CANCEL_KINDS.playback) {
        model.playbackStops.push(forwarded.target.playbackId)
        model.playback = { playbackId: forwarded.target.playbackId, state: 'stopping' }
        return { ok: true, cancelled: true, confirmed: true, target: { playbackId: forwarded.target.playbackId } }
      }
      model.captureDiscards.push(forwarded.target.captureId)
      model.capture = { captureId: forwarded.target.captureId, state: 'closing' }
      return { ok: true, cancelled: true, confirmed: true, target: { captureId: forwarded.target.captureId } }
    },
  }
  return host
}

/** Drive one stop request exactly the way the HTTP entry will. */
function stop(host, router, request) {
  const forwarded = router.plan({ ...request, current: host.current() })
  if (forwarded.action === 'duplicate') return { duplicate: true, outcome: forwarded.outcome }
  const raw = host.apply(forwarded)
  return { duplicate: false, receipt: router.settle(forwarded, raw) }
}

function routerFor(hostEpoch = EPOCH) {
  return createCancelRouter({ hostEpoch, now: () => CLOCK })
}

test('a late stop for A cannot touch B and leaves B official state identical', () => {
  const host = createFakeHost()
  const router = routerFor()
  const turnA = host.startTurn({ number: 1, clientTurnId: 'client-A' })
  const capturedForA = captureCancelTarget(turnA, { hostEpoch: EPOCH, now: () => CLOCK })
  assert.equal(capturedForA.turn, 1)
  host.endTurn({ terminal: 'completed' })
  host.startTurn({ number: 2, clientTurnId: 'client-B' })
  const before = host.officialState()
  assert.equal(before.state, 'working')
  assert.equal(before.turn, 2)

  // The delayed confirmation carries the target the user actually saw: turn 1.
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target: capturedForA }),
    (error) => error.code === 'STALE_TURN' && error.status === 409,
  )
  assert.deepEqual(host.officialState(), before, 'the successor turn is untouched, including its pending approval')
  assert.equal(host.model.cancelCalls, 0, 'the owner never ran for a superseded target')
  assert.equal(host.model.approvals.at(-1).outcome, null, "B's approval is still pending")
})

test('a late stop with the previous epoch is refused before identity can match', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 7 })
  const captured = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
  // A restarted Host keeps the same session/turn numbers but a new epoch.
  const successor = createFakeHost({ hostEpoch: 'host-epoch-beta' })
  successor.startTurn({ number: 7 })
  const before = successor.officialState()
  assert.throws(
    () => stop(successor, routerFor('host-epoch-beta'), { kind: CANCEL_KINDS.task, source: 'task-stop', target: captured }),
    (error) => error.code === 'STALE_HOST_EPOCH' && error.status === 409,
  )
  assert.deepEqual(successor.officialState(), before)
  assert.equal(successor.model.cancelCalls, 0)
})

test('a stop without any target is refused with an upgrade hint and cancels nothing', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 1 })
  const before = host.officialState()
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target: undefined }),
    (error) => error.code === 'CANCEL_TARGET_REQUIRED' && /v2\/command/.test(String(error.upgrade)),
  )
  assert.deepEqual(host.officialState(), before)
  assert.equal(host.model.cancelCalls, 0)
})

test('partial identity names every missing field and cancels nothing', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 1 })
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target: { sessionId: 'session-1' } }),
    (error) => error.code === 'CANCEL_TARGET_INCOMPLETE' && error.missing.includes('hostEpoch') && error.missing.some(field => field.includes('turn')),
  )
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target: { hostEpoch: EPOCH, sessionId: 'session-1' } }),
    (error) => error.code === 'CANCEL_TARGET_INCOMPLETE' && error.missing.includes('turn|turnId|clientTurnId'),
  )
  assert.equal(host.model.cancelCalls, 0)
})

test('a duplicate stop replays the settled outcome and runs the owner once', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 3, clientTurnId: 'client-3' })
  const target = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
  const first = stop(host, router, { kind: CANCEL_KINDS.task, source: 'voice-command', target })
  assert.equal(first.receipt.state, 'confirmed')
  assert.equal(first.receipt.ok, true)
  const second = stop(host, router, { kind: CANCEL_KINDS.task, source: 'voice-command', target })
  assert.equal(second.duplicate, true)
  assert.equal(second.outcome.state, 'confirmed')
  assert.equal(host.model.cancelCalls, 1, 'the retry never reached the owner a second time')
})

test('an unconfirmed stop never reports success', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 1 })
  host.model.cancelResults.push({ ok: true, cancelled: true, confirmed: false, sessionId: 'session-1' })
  const target = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
  const outcome = stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target })
  assert.equal(outcome.receipt.state, 'unconfirmed')
  assert.equal(outcome.receipt.ok, false)
  assert.equal(outcome.receipt.confirmed, false)
  assert.equal(outcome.receipt.cancelled, false)
  assert.doesNotMatch(outcome.receipt.notice.text, /已停止|已确认停止/)
  assert.equal(outcome.receipt.notice.severity, 'warning')
})

test('a failed stop and an unknown outcome are both reported as non-success', () => {
  const failed = classifyCancelResult({ ok: true, cancelled: false, error: 'agent refused' }, { kind: 'task' })
  assert.deepEqual([failed.state, failed.success, failed.code], ['failed', false, 'CANCEL_FAILED'])
  const unknown = classifyCancelResult(undefined, { kind: 'task' })
  assert.deepEqual([unknown.state, unknown.success, unknown.code], ['unknown', false, 'CANCEL_OUTCOME_UNKNOWN'])
  const notRunning = classifyCancelResult({ ok: true, cancelled: false, confirmed: false }, { kind: 'task' })
  assert.deepEqual([notRunning.state, notRunning.success, notRunning.code], ['not-cancelled', false, 'NOT_CANCELLED'])
})

test('a confirmed stop that names another turn is never presented as this stop', () => {
  const outcome = classifyCancelResult(
    { cancelled: true, confirmed: true, target: { sessionId: 'session-1', turn: 2 } },
    { kind: 'task', target: { sessionId: 'session-1', turn: 1 } },
  )
  assert.equal(outcome.state, 'mismatch')
  assert.equal(outcome.success, false)
  assert.equal(outcome.code, 'CANCEL_TARGET_MISMATCH')
})

test('cancelling while an approval is pending settles only the bound turn', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 1 })
  const targetA = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
  const outcome = stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target: targetA })
  assert.equal(outcome.receipt.state, 'confirmed')
  assert.equal(host.model.approvals[0].outcome, 'cancelled', "A's approval is settled fail-closed by the stop")

  host.startTurn({ number: 2 })
  const pendingB = host.model.approvals.at(-1)
  const before = host.officialState()
  // A different request for A's old turn (not a replay of the settled one).
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'voice-command', target: targetA }),
    (error) => error.code === 'STALE_TURN',
  )
  assert.deepEqual(host.officialState(), before)
  assert.equal(pendingB.outcome, null, "B's approval was not settled by A's late stop")
})

test('the three stop classes never substitute for one another', () => {
  // A source is accepted by exactly one class.
  for (const [kind, foreign] of [
    [CANCEL_KINDS.task, ['control.stop-playback', 'control.cancel-capture', 'user-cancel']],
    [CANCEL_KINDS.playback, ['task-stop', 'control.cancel-task', 'idle-pause']],
    [CANCEL_KINDS.capture, ['task-stop', 'control.cancel-task', 'explicit']],
  ]) {
    for (const source of foreign) {
      assert.throws(() => assertCancelSource(kind, source), (error) => error.code === 'INVALID_CANCEL_SOURCE' && error.status === 400)
    }
  }

  const host = createFakeHost()
  const router = routerFor()
  host.startTurn({ number: 1 })
  host.startPlayback('playback-1')
  host.startCapture('capture-1')
  const turnBefore = host.officialState().turn

  const playback = stop(host, router, { kind: CANCEL_KINDS.playback, source: 'voice-control', target: { playbackId: 'playback-1' } })
  assert.equal(playback.receipt.ok, true)
  assert.equal(host.officialState().turn, turnBefore, 'stopping playback left the task alone')
  assert.equal(host.officialState().state, 'working')
  assert.doesNotMatch(playback.receipt.notice.text, /任务已停止|已停止任务|已确认任务停止/)

  const capture = stop(host, router, { kind: CANCEL_KINDS.capture, source: 'user-cancel', target: { captureId: 'capture-1' } })
  assert.equal(capture.receipt.ok, true)
  assert.equal(host.officialState().turn, turnBefore, 'discarding the capture left the task alone')
  assert.doesNotMatch(capture.receipt.notice.text, /任务已停止|已停止任务|已确认任务停止/)
  assert.equal(host.model.cancelCalls, 0, 'neither local stop reached the task owner')

  const target = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
  const task = stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target })
  assert.equal(task.receipt.state, 'confirmed')
  assert.equal(host.officialState().playback.state, 'stopping', 'the task stop did not stop playback itself')
  assert.equal(host.officialState().capture.state, 'closing', 'the task stop did not touch the capture')
})

test('every class has its own success wording', () => {
  const task = cancelNotice(CANCEL_KINDS.task, 'confirmed')
  const playback = cancelNotice(CANCEL_KINDS.playback, 'confirmed')
  const capture = cancelNotice(CANCEL_KINDS.capture, 'confirmed')
  assert.match(task.text, /任务停止/)
  assert.doesNotMatch(playback.text, /任务停止|已停止任务/)
  assert.doesNotMatch(capture.text, /任务停止|已停止任务/)
  assert.match(playback.text, /任务仍在执行/)
  assert.match(capture.text, /任务不受影响/)
})

test('a capture stop with no capture and a playback stop with no playback are explicit refusals', () => {
  const host = createFakeHost()
  const router = routerFor()
  assert.throws(() => stop(host, router, { kind: CANCEL_KINDS.capture, source: 'user-cancel', target: {} }), (error) => error.code === 'NO_CAPTURE' && error.status === 409)
  assert.throws(() => stop(host, router, { kind: CANCEL_KINDS.playback, source: 'explicit', target: {} }), (error) => error.code === 'NO_PLAYBACK' && error.status === 409)
  host.startPlayback('playback-live')
  const resolved = stop(host, router, { kind: CANCEL_KINDS.playback, source: 'explicit', target: {} })
  assert.equal(resolved.receipt.target.playbackId, 'playback-live')
  assert.deepEqual(host.model.playbackStops, ['playback-live'], 'the resolved id is the one that was stopped and reported')
})

test('an idle Host refuses a task stop instead of answering success', () => {
  const host = createFakeHost()
  const router = routerFor()
  // A complete identity the idle Host does not own is reported as stale...
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'idle-pause', target: { hostEpoch: EPOCH, sessionId: 'session-1', turn: 1 } }),
    (error) => error.code === 'STALE_SESSION' && error.status === 409,
  )
  // ...and a request that names nothing but the epoch is told exactly that.
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'idle-pause', target: { hostEpoch: EPOCH } }),
    (error) => error.code === 'CANCEL_TARGET_REQUIRED' && error.missing.includes('turn|turnId|clientTurnId'),
  )
  // A partial identity is reported as incomplete instead.
  assert.throws(
    () => stop(host, router, { kind: CANCEL_KINDS.task, source: 'idle-pause', target: { hostEpoch: EPOCH, sessionId: 'session-1' } }),
    (error) => error.code === 'CANCEL_TARGET_INCOMPLETE' && error.missing.length === 1,
  )
  // Liveness is the last gate: a target that matches a Host state which owns the
  // identity but is not running (unknown/error) still cannot be stopped.
  assert.throws(
    () => assertTaskTargetCurrent({
      target: { hostEpoch: EPOCH, sessionId: 'session-1', turn: 1 },
      current: { active: false, sessionId: 'session-1', turn: 1, clientTurnId: null, hostEpoch: EPOCH },
      hostEpoch: EPOCH,
    }),
    (error) => error.code === 'NO_ACTIVE_TURN' && error.status === 409,
  )
  assert.equal(host.model.cancelCalls, 0)
})

test('cancellation during admission is allowed when the request id is the target', () => {
  const host = createFakeHost()
  const router = routerFor()
  host.turn.beginAdmission({ sessionId: 'session-1', clientTurnId: 'request-9', inputSource: 'voice', text: 'fixture' })
  const scope = host.current()
  assert.equal(scope.active, true, 'a submitted-but-not-yet-admitted turn is active work')
  const forwarded = planCancel(
    { kind: CANCEL_KINDS.task, source: 'voice-command', target: { hostEpoch: EPOCH, sessionId: 'session-1', clientTurnId: 'request-9' }, current: scope },
    { hostEpoch: EPOCH },
  )
  assert.equal(forwarded.action, 'forward')
  assert.equal(forwarded.target.clientTurnId, 'request-9')
  // The same shape with another request id is stale, not "the current task".
  assert.throws(
    () => planCancel({ kind: CANCEL_KINDS.task, source: 'voice-command', target: { hostEpoch: EPOCH, sessionId: 'session-1', clientTurnId: 'request-8' }, current: scope }, { hostEpoch: EPOCH }),
    (error) => error.code === 'STALE_TURN',
  )
})

test('the legacy adapter keeps its source default and refuses unknown sources', () => {
  const host = createFakeHost()
  host.startTurn({ number: 1 })
  const current = host.current()
  const request = legacyCancelRequest({ sessionId: 'session-1', turn: 1 }, { current, hostEpoch: EPOCH })
  assert.equal(request.kind, 'task')
  assert.equal(request.source, 'task-stop')
  assert.equal(request.target.hostEpoch, EPOCH, 'the legacy body inherits the Host epoch when it cannot state one')
  assert.throws(
    () => planCancel(legacyCancelRequest({ source: 'invalid-source' }, { current, hostEpoch: EPOCH }), { hostEpoch: EPOCH }),
    (error) => error.code === 'INVALID_CANCEL_SOURCE',
  )
  assert.throws(
    () => planCancel(legacyCancelRequest({}, { current, hostEpoch: EPOCH }), { hostEpoch: EPOCH }),
    (error) => error.code === 'CANCEL_TARGET_REQUIRED',
  )
})

test('a v2 command target inherits the envelope epoch only when it states none', () => {
  assert.equal(commandCancelTarget({ target: { sessionId: 's', turn: 1 } }, { hostEpoch: EPOCH })?.hostEpoch, EPOCH)
  assert.equal(commandCancelTarget({ target: { sessionId: 's', turn: 1, hostEpoch: 'stale' } }, { hostEpoch: EPOCH })?.hostEpoch, 'stale')
  assert.equal(commandCancelTarget({}, { hostEpoch: EPOCH }), undefined)
})

test('the router keeps its settled-replay memory bounded', () => {
  const router = createCancelRouter({ hostEpoch: EPOCH, now: () => CLOCK, capacity: 4 })
  const host = createFakeHost()
  for (let index = 1; index <= 8; index += 1) {
    host.startTurn({ number: index, clientTurnId: `client-${String(index)}` })
    const target = captureCancelTarget(host.execution(), { hostEpoch: EPOCH, now: () => CLOCK })
    stop(host, router, { kind: CANCEL_KINDS.task, source: 'task-stop', target })
  }
  assert.equal(router.size(), 4)
})
