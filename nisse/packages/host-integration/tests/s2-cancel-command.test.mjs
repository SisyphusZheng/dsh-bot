/**
 * S2 v2 command path (`control.cancel-task`) behaviour.
 *
 * The Host turn model already binds a target at capture time; these cases prove
 * the command adapter cannot be talked out of that binding: a stop must name the
 * live turn or carry the token of a confirmation whose target is still live, and
 * every refusal leaves the successor turn's official state untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createConversationService } from '../lib/conversation-service.mjs'
import { createSnapshotStore } from '../lib/snapshot.mjs'
import { PROTOCOL_VERSION } from '../lib/contracts.mjs'
import { CANCEL_KINDS, captureCancelTarget } from '../lib/cancel-routing.mjs'

const HOST_EPOCH = 'epoch-cancel-command'

function fakeRuntime() {
  const state = { cancelled: [], commands: [], sessionId: 'session-1' }
  const runtime = {
    productVersion: () => '0.0.1-beta2',
    runtimeVersion: () => '0.2.1-rc.3',
    sessionId: () => state.sessionId,
    agentReady: () => true,
    workspace: () => '/tmp/workspace',
    conversationIndex: () => 1,
    ensureAgent: async () => {},
    submitTurn: async () => ({ sessionId: state.sessionId, turn: 1 }),
    cancelTurn: async (options) => {
      state.cancelled.push(options)
      return { ok: true, cancelled: true, confirmed: true, sessionId: state.sessionId, target: { sessionId: options.target.sessionId, turn: options.target.turn ?? null } }
    },
    emitCommand: (type, payload) => {
      state.commands.push({ type, payload })
      return 'cmd-' + String(state.commands.length)
    },
    continuedQuestions: () => [],
  }
  return { runtime, state }
}

function fakeRegistry() {
  return {
    calls: [],
    snapshot: () => ({ focusedId: null, pending: [], drafts: {}, recentlyResolved: [] }),
    resolve: (request) => ({ status: 'resolved', result: { interactionId: request.interactionId, outcome: 'answered' } }),
    draftSelect: () => ({ status: 'accepted', result: {} }),
    draftCustom: () => ({ status: 'accepted', result: {} }),
    observeOfficial: () => {},
    dispose: () => {},
  }
}

function makeService() {
  const { runtime, state } = fakeRuntime()
  const events = createSnapshotStore({ hostEpoch: HOST_EPOCH })
  const service = createConversationService({
    hostEpoch: HOST_EPOCH,
    events,
    registry: fakeRegistry(),
    runtime,
    config: { settleMs: 20, drainMs: 20, queueTtlMs: 60_000, draftTtlMs: 30_000, cancelConfirmMs: 30_000 },
    log: () => {},
  })
  service.start()
  return { service, state }
}

function command(commandId, payload) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop',
    sessionId: null,
    type: 'control.cancel-task',
    payload,
  }
}

/** Start one official turn and return the target a client would have captured. */
function startTurn(service, { sessionId = 'session-1', turn = 1, clientTurnId = '' } = {}) {
  service.onTurnStarted({ sessionId, turn, clientTurnId, inputSource: 'desktop', hostInitiated: false })
  return captureCancelTarget(service.snapshotSections().execution, { hostEpoch: HOST_EPOCH })
}

test('a target-bound stop cancels exactly that turn without a confirmation token', async () => {
  const { service, state } = makeService()
  const target = startTurn(service, { turn: 4 })
  const receipt = await service.handleCommand(command('cancel-bound', { target }))
  assert.equal(receipt.status, 'resolved')
  assert.equal(state.cancelled.length, 1)
  assert.equal(state.cancelled[0].target.turn, 4)
  assert.equal(service.snapshotSections().execution.state, 'idle')
  service.dispose()
})

test('a late target for the previous turn is refused and the successor keeps running', async () => {
  const { service, state } = makeService()
  const targetA = startTurn(service, { turn: 1, clientTurnId: 'client-A' })
  service.onTurnEnded({ sessionId: 'session-1', turn: 1, terminal: 'completed', reason: { kind: 'completed' } })
  startTurn(service, { turn: 2, clientTurnId: 'client-B' })
  const before = service.snapshotSections().execution
  assert.equal(before.state, 'working')
  assert.equal(before.turn, 2)

  const receipt = await service.handleCommand(command('cancel-late-A', { target: targetA }))
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.error.code, 'STALE_TURN')
  const after = service.snapshotSections().execution
  assert.deepEqual(after, before, 'the successor turn official state is byte-identical after the late stop')
  assert.equal(state.cancelled.length, 0, 'the owner was never asked to cancel anything')
  service.dispose()
})

test('a replayed magic confirmation token cannot cancel the current task', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 2 })
  // The previous revision treated any non-empty token as "confirmed"; the value
  // "api" was a test-only bypass that a client could send at any later time.
  const receipt = await service.handleCommand(command('cancel-magic', { confirmToken: 'api' }))
  // The token is simply not a confirmation the Host ever issued, so the request
  // falls back to asking — and asking never cancels anything.
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.error.code, 'CONFIRMATION_REQUIRED')
  // Once the Host has asked, only the token it captured is acceptable; the same
  // magic string is now simply a mismatched token.
  const again = await service.handleCommand(command('cancel-magic-2', { confirmToken: 'api' }))
  assert.equal(again.status, 'rejected')
  assert.equal(again.error.code, 'STALE_CANCEL_REQUEST')
  assert.equal(state.cancelled.length, 0)
  assert.equal(service.snapshotSections().execution.state, 'working')
  service.dispose()
})

test('a confirmation captured for A cannot settle B after A ended', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 1, clientTurnId: 'client-A' })
  const first = await service.handleCommand(command('cancel-request', {}))
  assert.equal(first.status, 'rejected')
  assert.equal(first.error.code, 'CONFIRMATION_REQUIRED')
  const pending = service.inspect().pendingCancel
  assert.ok(pending, 'the Host captured a target when it asked for confirmation')
  assert.equal(pending.target.turn, 1)
  service.onTurnEnded({ sessionId: 'session-1', turn: 1, terminal: 'completed', reason: { kind: 'completed' } })
  startTurn(service, { turn: 2, clientTurnId: 'client-B' })
  const before = service.snapshotSections().execution

  const confirmed = await service.handleCommand(command('cancel-confirm-stale', { confirmToken: pending.token }))
  assert.equal(confirmed.status, 'rejected')
  assert.equal(confirmed.error.code, 'STALE_CANCEL_REQUEST')
  assert.deepEqual(service.snapshotSections().execution, before)
  assert.equal(state.cancelled.length, 0)
  assert.equal(service.inspect().pendingCancel, null, 'the expired confirmation cannot be replayed')
  service.dispose()
})

test('the confirmation token still stops the turn it was captured for', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 3 })
  const first = await service.handleCommand(command('cancel-request-2', {}))
  assert.equal(first.error.code, 'CONFIRMATION_REQUIRED')
  const pending = service.inspect().pendingCancel
  const confirmed = await service.handleCommand(command('cancel-confirm-2', { confirmToken: pending.token }))
  assert.equal(confirmed.status, 'resolved')
  assert.equal(state.cancelled.length, 1)
  assert.equal(state.cancelled[0].target.turn, 3)
  service.dispose()
})

test('a client target that names a different request id is refused', async () => {
  const { service, state } = makeService()
  const target = startTurn(service, { turn: 5, clientTurnId: 'client-live' })
  const stale = { ...target, clientTurnId: 'client-other' }
  const receipt = await service.handleCommand(command('cancel-wrong-request', { target: stale }))
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.error.code, 'STALE_TURN')
  assert.equal(state.cancelled.length, 0)
  service.dispose()
})

test('an incomplete target names the missing fields instead of guessing', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 1 })
  const receipt = await service.handleCommand(command('cancel-partial', { target: { sessionId: 'session-1' } }))
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.error.code, 'CANCEL_TARGET_INCOMPLETE')
  assert.equal(state.cancelled.length, 0)
  service.dispose()
})

test('stopping playback or discarding a capture never cancels the task', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 6 })
  service.onAssistantDelta({ sessionId: 'session-1', turn: 6, text: '正在播报' })
  const playback = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'stop-playback', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop', sessionId: null, type: 'control.stop-playback', payload: {},
  })
  assert.equal(playback.status, 'accepted')
  assert.equal(service.snapshotSections().execution.state, 'working', 'the task kept running')
  const capture = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-capture', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop', sessionId: null, type: 'control.cancel-capture', payload: { captureId: 'cap-1' },
  })
  assert.equal(capture.status, 'accepted')
  assert.equal(service.snapshotSections().execution.state, 'working', 'the capture discard left the task alone')
  assert.equal(state.cancelled.length, 0, 'neither local stop reached the task owner')
  service.dispose()
})

test('voice "stop playback" and "cancel capture" never cancel the task', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 8 })
  service.onAssistantDelta({ sessionId: 'session-1', turn: 8, text: '正在播报的长句' })
  const playback = await service.handleFinalUtterance({ text: '停一下', captureId: 'cap-voice', utteranceId: 'utt-stop', mode: 'hold' })
  assert.ok(playback.routed.some((route) => route.path === 'control'))
  assert.equal(service.snapshotSections().execution.state, 'working', 'the task keeps running after a playback stop')
  assert.equal(service.snapshotSections().playback.state, 'stopping')

  const capture = await service.handleFinalUtterance({ text: '取消录音', captureId: 'cap-voice', utteranceId: 'utt-cancel', mode: 'hold' })
  assert.ok(capture.routed.some((route) => route.path === 'control'))
  assert.equal(service.snapshotSections().execution.state, 'working', 'the task keeps running after a capture discard')
  assert.equal(state.cancelled.length, 0, 'neither voice control reached the task owner')
  service.dispose()
})

test('voice "stop task" asks for a confirmation and captures the target then', async () => {
  const { service, state } = makeService()
  startTurn(service, { turn: 9, clientTurnId: 'client-9' })
  const asked = await service.handleFinalUtterance({ text: '停止任务', captureId: 'cap-voice', utteranceId: 'utt-task-stop', mode: 'hold' })
  assert.ok(asked.routed.some((route) => route.path === 'control'))
  const pending = service.inspect().pendingCancel
  assert.ok(pending, 'the Host captured a target before asking')
  assert.equal(pending.target.turn, 9)
  assert.equal(state.cancelled.length, 0, 'asking alone never cancels')
  const confirmed = await service.handleFinalUtterance({ text: '确认停止任务', captureId: 'cap-voice', utteranceId: 'utt-task-confirm', mode: 'hold' })
  assert.ok(confirmed.routed.some((route) => route.path === 'control'))
  assert.equal(state.cancelled.length, 1)
  assert.equal(state.cancelled[0].target.turn, 9)
  service.dispose()
})

test('the stop request kind is explicit: the routing table has one class per command type', () => {
  assert.equal(CANCEL_KINDS.task, 'task')
  assert.notEqual(CANCEL_KINDS.playback, CANCEL_KINDS.task)
  assert.notEqual(CANCEL_KINDS.capture, CANCEL_KINDS.task)
})
