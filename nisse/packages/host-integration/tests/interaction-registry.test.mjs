/**
 * InteractionRegistry contract tests: plan v2.1 §6 / §11 B2-G01 + B2-G03 and
 * .agent/plan/beta2-kernel.md §3.4.
 *
 * These tests exercise the real InteractionMirror (not a fake) so the official
 * lifetime hooks are covered: request observation, local decision settlement,
 * external (main-window) official settlement, timeout, cancellation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInteractionMirror } from '../lib/interactions.mjs'
import { createInteractionRegistry } from '../lib/interaction-registry.mjs'
import { createReceiptStore, createStateStore } from '../lib/persistence.mjs'
import { digest } from '../lib/contracts.mjs'

const SESSION = 'session-alpha'
const HOST_EPOCH = 'host-epoch-fixture'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const agent = () => ({ session: { id: SESSION } })
const neverAnswerer = () => new Promise(() => {})

function fixture(t, { forward, feedOfficialEvents = false, mirror: mirrorOptions = {}, registry: registryOptions = {} } = {}) {
  const events = []
  let registry = null
  const sink = (type, fields) => {
    events.push({ type, fields })
    // Mirrors the production index.js wiring: every mirror settle event is also
    // pushed into the legacy event sink, which feeds registry.observeOfficial.
    if (feedOfficialEvents && registry && (type === 'approval.decided' || type === 'question.decided')) {
      try { registry.observeOfficial({ type, sessionId: fields?.sessionId, data: fields?.data }) } catch { /* ignore */ }
    }
  }
  const mirror = createInteractionMirror({
    forward: forward || (async () => neverAnswerer()),
    emit: sink,
    hasLocalUi: () => true,
    ...mirrorOptions,
  })
  registry = createInteractionRegistry({
    mirror,
    hostEpoch: HOST_EPOCH,
    getSessionId: () => SESSION,
    emit: sink,
    ...registryOptions,
  })
  t.after(() => {
    try { registry.dispose() } catch { /* ignore */ }
    try { mirror.dispose() } catch { /* ignore */ }
  })
  return {
    events,
    mirror,
    registry,
    firstId: () => registry.snapshot().pending[0]?.id || null,
    eventTypes: () => events.map((event) => event.type),
    pendingQuestion: (id) => registry.snapshot().pending.find((item) => item.id === id),
  }
}

function askApproval(mirror, overrides = {}) {
  return mirror.ask('approval', {
    agent: agent(),
    toolName: 'write',
    reason: 'write outside workspace: /etc/hosts',
    callId: 'call-write-1',
    ...overrides,
  })
}

const PRODUCT_QUESTIONS = () => [
  { id: 'q-destination', question: '去哪？', options: [{ label: '上海' }, { label: '杭州' }, { label: '北京' }] },
  { id: 'q-activity', question: '做什么？', multiSelect: true, options: [{ label: '吃饭' }, { label: '散步' }] },
]

const OFFICIAL_ID_QUESTIONS = () => [
  {
    id: 'q1',
    question: '去哪？',
    options: [{ id: 'o-shanghai', label: '上海' }, { id: 'o-hangzhou', label: '杭州' }],
  },
]

const MULTI_QUESTIONS = () => [
  { id: 'q-activity', question: '做什么？', multiSelect: true, options: [{ label: '吃饭' }, { label: '散步' }, { label: '学习' }] },
]

function approvalsBatch(interactionId, semanticRevision, decision) {
  return { commandId: `cmd-${decision}-${Math.random().toString(36).slice(2)}`, interactionId, semanticRevision, payload: { decision } }
}

// ---------------------------------------------------------------------------
// B2-G01: main-window decision wins, late voice converges, single decision
// ---------------------------------------------------------------------------

test('main-window decision converges the registry and a late voice answer returns the final status without a second official call', async (t) => {
  let decideOfficial
  const f = fixture(t, { forward: () => new Promise((resolve) => { decideOfficial = resolve }) })
  const pending = askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  assert.ok(interactionId, 'the mirror request was observed as a product interaction')
  assert.equal(f.registry.snapshot().pending[0].kind, 'approval')
  assert.equal(f.registry.snapshot().pending[0].semanticRevision, 1)
  assert.equal(f.registry.snapshot().pending[0].viewRevision, 1)

  // The official approval identity is bound to the product interaction by its call id.
  assert.equal(f.registry.observeOfficial({
    type: 'approval/asked',
    data: { id: 'official-approval-1', callId: 'call-write-1', toolName: 'write', sessionId: SESSION },
  }), true)
  assert.equal(f.registry.snapshot().pending[0].officialCallId, 'official-approval-1')

  // The DSH main window answers first; the registry sees the official result.
  decideOfficial('allowed-once')
  assert.equal(await pending, 'allowed-once')
  await tick()
  const after = f.registry.snapshot()
  assert.equal(after.pending.length, 0)
  assert.equal(after.recentlyResolved.length, 1)
  assert.equal(after.recentlyResolved[0].id, interactionId)
  assert.equal(after.recentlyResolved[0].outcome, 'allowed-once')
  assert.equal(after.recentlyResolved[0].source, 'official')

  // The late voice answer must not call the official service again, must not
  // flip the decision, and must return the known final status.
  const late = f.registry.resolve({ commandId: 'voice-late-1', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(late.status, 'resolved')
  assert.equal(late.result.outcome, 'allowed-once')
  assert.equal(late.result.alreadyResolved, true)
  const lateAgain = f.registry.resolve({ commandId: 'voice-late-2', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(lateAgain.status, 'resolved')
  assert.equal(f.registry.stats().officialCalls, 0)
  assert.equal(f.mirror.snapshot().length, 0)
  assert.ok(f.eventTypes().includes('interaction.requested'))
  assert.ok(f.eventTypes().includes('interaction.resolved'))
})

test('approval/decided from the official lifetime converges the unambiguous pending approval', async (t) => {
  const f = fixture(t)
  const pending = askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  // Durable official events carry a durableSeq; the registry only uses the
  // unambiguous single-pending fallback for genuinely observed official results.
  assert.equal(f.registry.observeOfficial({
    type: 'approval/decided',
    data: { outcome: 'rejected', sessionId: SESSION, durableSeq: 11 },
  }), true)
  assert.equal(await pending, 'cancelled')
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].id, interactionId)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'rejected')
  assert.equal(snapshot.recentlyResolved[0].source, 'official')
  assert.equal(f.registry.stats().officialCalls, 0)
})

test('click and voice racing for the same approval produce exactly one official decision', async (t) => {
  const f = fixture(t)
  const pending = askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const click = f.registry.resolve({ commandId: 'click-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  const voice = f.registry.resolve({ commandId: 'voice-1', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(click.status, 'resolved')
  assert.equal(click.result.outcome, 'allowed-once')
  assert.equal(voice.status, 'resolved')
  assert.equal(voice.result.outcome, 'allowed-once')
  assert.equal(voice.result.alreadyResolved, true)
  assert.equal(await pending, 'allowed-once')
  assert.equal(f.registry.stats().officialCalls, 1)
  assert.equal(f.registry.snapshot().pending.length, 0)
  assert.equal(f.registry.snapshot().recentlyResolved.length, 1)
})

test('a second decision while the official call is in flight is not applied and converges on the observed official result', async (t) => {
  let settleOfficial
  let officialCalls = 0
  const f = fixture(t, {
    registry: {
      officialAnswer: () => {
        officialCalls += 1
        return new Promise((resolve) => { settleOfficial = resolve })
      },
    },
  })
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()

  const first = f.registry.resolve({ commandId: 'async-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(first.status, 'accepted')
  assert.equal(first.result.inFlight, true)
  assert.equal(f.registry.stats().resolving, 1)

  const sameContent = f.registry.resolve({ commandId: 'async-2', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(sameContent.status, 'accepted')
  assert.equal(sameContent.result.inFlight, true)
  const conflicting = f.registry.resolve({ commandId: 'async-3', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(conflicting.status, 'rejected')
  assert.equal(conflicting.error.code, 'DECISION_CONFLICT')
  assert.equal(officialCalls, 1)
  assert.equal(f.registry.stats().officialCalls, 1)

  settleOfficial({ status: 'resolved', outcome: 'allowed-once' })
  await tick()
  assert.equal(f.registry.snapshot().pending.length, 0)
  assert.equal(f.registry.snapshot().recentlyResolved[0].outcome, 'allowed-once')
  const replay = f.registry.resolve({ commandId: 'async-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(replay.status, 'resolved')
  assert.equal(replay.result.outcome, 'allowed-once')
  assert.equal(replay.result.alreadyResolved, true)
  const late = f.registry.resolve({ commandId: 'async-4', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(late.status, 'resolved')
  assert.equal(late.result.outcome, 'allowed-once')
  assert.equal(officialCalls, 1)
  const loserReplay = f.registry.resolve({ commandId: 'async-2', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(loserReplay.status, 'resolved')
  assert.equal(loserReplay.result.outcome, 'allowed-once')
  assert.equal(loserReplay.result.alreadyResolved, true)
  assert.equal(officialCalls, 1)
})

test('a registry created after the mirror already presents a request adopts it and settles on the decision', async (t) => {
  let decideOfficial
  const events = []
  const mirror = createInteractionMirror({
    forward: () => new Promise((resolve) => { decideOfficial = resolve }),
    emit: () => {},
    hasLocalUi: () => true,
  })
  t.after(() => { try { mirror.dispose() } catch { /* ignore */ } })
  const pending = askApproval(mirror)
  await tick()
  // Integration order: the mirror request exists before the registry is built.
  const registry = createInteractionRegistry({
    mirror,
    hostEpoch: HOST_EPOCH,
    getSessionId: () => SESSION,
    emit: (type, fields) => events.push({ type, fields }),
  })
  t.after(() => registry.dispose())
  const pendingInteractions = registry.snapshot().pending
  assert.equal(pendingInteractions.length, 1)
  const interactionId = pendingInteractions[0].id
  assert.equal(interactionId, mirror.snapshot()[0].id)
  decideOfficial('rejected')
  assert.equal(await pending, 'rejected')
  await tick()
  assert.equal(registry.snapshot().pending.length, 0)
  assert.equal(registry.snapshot().recentlyResolved[0].id, interactionId)
  assert.equal(registry.snapshot().recentlyResolved[0].outcome, 'rejected')
  assert.equal(registry.stats().officialCalls, 0)
})

test('production wiring: a voice decision is recorded as a local decision, never double-counted', async (t) => {
  const f = fixture(t, { feedOfficialEvents: true })
  const pending = askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const result = f.registry.resolve({ commandId: 'wired-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(result.status, 'resolved')
  assert.equal(await pending, 'allowed-once')
  await tick()
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'allowed-once')
  assert.equal(snapshot.recentlyResolved[0].source, 'local')
  assert.equal(f.registry.stats().officialCalls, 1)
})

test('production wiring: the mirror settle echo is not mistaken for an out-of-band official result', async (t) => {
  const f = fixture(t, { feedOfficialEvents: true })
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const mirrorId = f.mirror.snapshot()[0].id
  assert.equal(f.registry.observeOfficial({ type: 'approval.decided', data: { id: mirrorId, outcome: 'rejected' } }), false)
  assert.equal(f.registry.snapshot().pending.length, 1)
  assert.equal(f.registry.stats().officialCalls, 0)
})

test('production wiring: the official lifetime timeout converges as expired, not as a fabricated cancellation', async (t) => {
  const f = fixture(t, { feedOfficialEvents: true, mirror: { approvalTimeoutMs: 20 } })
  const pending = askApproval(f.mirror)
  await tick()
  f.firstId()
  assert.equal(await pending, 'cancelled')
  await tick()
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'expired')
  assert.equal(f.registry.stats().officialCalls, 0)
})

test('production wiring: a durable official decision (with durableSeq) converges the unambiguous pending approval', async (t) => {
  const f = fixture(t, { feedOfficialEvents: true })
  const pending = askApproval(f.mirror)
  await tick()
  f.firstId()
  assert.equal(f.registry.observeOfficial({
    type: 'approval.decided',
    data: { id: 'official-durable-7', outcome: 'rejected', durableSeq: 7 },
  }), true)
  await pending.catch(() => {})
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'rejected')
  assert.equal(snapshot.recentlyResolved[0].source, 'official')
  assert.equal(f.registry.stats().officialCalls, 0)
  assert.equal(f.mirror.snapshot().length, 0, 'the withdrawn product request is pulled from the pet surface')
})

// ---------------------------------------------------------------------------
// B2-G01/G03: idempotency keys + receipts
// ---------------------------------------------------------------------------

test('same idempotency key and same canonical content returns the same receipt and never re-executes', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const command = { commandId: 'same-key-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } }
  const first = f.registry.resolve(command)
  assert.equal(first.status, 'resolved')
  assert.equal(f.registry.stats().officialCalls, 1)
  const replay = f.registry.resolve(command)
  assert.deepEqual(replay, first)
  const replayWithObjectKeyOrder = f.registry.resolve({
    payload: { decision: 'allowed-once' },
    commandId: 'same-key-1',
    interactionId,
    semanticRevision: 1,
  })
  assert.equal(replayWithObjectKeyOrder.status, 'resolved')
  assert.equal(replayWithObjectKeyOrder.result.outcome, 'allowed-once')
  assert.equal(f.registry.stats().officialCalls, 1)
})

test('same idempotency key with a different decision, revision or target is an IDEMPOTENCY_CONFLICT', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const secondPending = askApproval(f.mirror, { callId: 'call-write-2' })
  await tick()
  const secondId = f.registry.snapshot().pending.find((item) => item.id !== interactionId)?.id
  assert.ok(secondId)

  const first = f.registry.resolve({ commandId: 'idem-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(first.status, 'resolved')

  const differentDecision = f.registry.resolve({ commandId: 'idem-1', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(differentDecision.status, 'rejected')
  assert.equal(differentDecision.error.code, 'IDEMPOTENCY_CONFLICT')

  const differentRevision = f.registry.resolve({ commandId: 'idem-1', interactionId, semanticRevision: 2, payload: { decision: 'allowed-once' } })
  assert.equal(differentRevision.error.code, 'IDEMPOTENCY_CONFLICT')

  const differentTarget = f.registry.resolve({ commandId: 'idem-1', interactionId: secondId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(differentTarget.error.code, 'IDEMPOTENCY_CONFLICT')

  assert.equal(f.registry.stats().officialCalls, 1)
  assert.equal(f.registry.snapshot().pending.length, 1)
  assert.equal(f.registry.snapshot().pending[0].id, secondId)
  // The second interaction still resolves normally with its own key.
  const second = f.registry.resolve({ commandId: 'idem-2', interactionId: secondId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(second.status, 'resolved')
  assert.equal(second.result.outcome, 'rejected')
  assert.equal(f.registry.stats().officialCalls, 2)
  assert.equal(await secondPending, 'rejected')
})

// ---------------------------------------------------------------------------
// B2-G01: expiry / cancellation lifetime
// ---------------------------------------------------------------------------

test('an expired approval is withdrawn from both UIs and late answers get an explicit expired reason', async (t) => {
  const f = fixture(t, { registry: { approvalTimeoutMs: 25, graceMs: 0 } })
  const pending = askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  await delay(120)
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'expired')
  assert.equal(snapshot.recentlyResolved[0].source, 'local')
  assert.equal(f.mirror.snapshot().length, 0, 'the pet surface was withdrawn')
  assert.equal(await pending, 'cancelled')

  const late = f.registry.resolve({ commandId: 'expired-late-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(late.status, 'rejected')
  assert.equal(late.error.code, 'INTERACTION_EXPIRED')
  assert.equal(late.result.outcome, 'expired')
  const retry = f.registry.resolve({ commandId: 'expired-late-2', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(retry.status, 'rejected')
  assert.equal(retry.error.code, 'INTERACTION_EXPIRED')
  assert.equal(f.registry.stats().officialCalls, 0, 'expiry never creates new official work')
  assert.ok(f.eventTypes().includes('interaction.expired'))
})

test('an expired question is withdrawn and cannot be answered afterwards', async (t) => {
  const f = fixture(t, { registry: { questionTimeoutMs: 25, graceMs: 0 } })
  const pending = f.mirror.ask('question', { agent: agent(), questions: MULTI_QUESTIONS() })
  pending.catch(() => { /* withdrawn question rejects with ASK_ABORTED */ })
  await tick()
  const interactionId = f.firstId()
  await delay(120)
  assert.equal(f.registry.snapshot().pending.length, 0)
  assert.equal(f.registry.snapshot().recentlyResolved[0].outcome, 'expired')
  const late = f.registry.resolve({
    commandId: 'expired-q-1',
    interactionId,
    semanticRevision: 1,
    payload: { answers: [{ id: 'q-activity', selected: [] }] },
  })
  assert.equal(late.error.code, 'INTERACTION_EXPIRED')
  assert.equal(f.registry.stats().officialCalls, 0)
})

// ---------------------------------------------------------------------------
// B2-G03: semanticRevision vs viewRevision
// ---------------------------------------------------------------------------

test('option reorder with product ids bumps semanticRevision; old revisions and old option ids are not re-interpreted', async (t) => {
  const f = fixture(t)
  f.mirror.ask('question', { agent: agent(), questions: PRODUCT_QUESTIONS() }).catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const before = f.registry.snapshot().pending[0]
  const oldHangzhou = before.questions[0].options[1].id
  assert.equal(f.registry.draftSelect({
    commandId: 'draft-before-change',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 0,
    questionId: 'q-destination',
    optionId: oldHangzhou,
    selected: true,
  }).status, 'resolved')

  const changed = f.registry.syncOfficialRequests([{
    id: interactionId,
    kind: 'question',
    sessionId: SESSION,
    questions: [
      { id: 'q-destination', question: '去哪？', options: [{ label: '北京' }, { label: '上海' }, { label: '杭州' }] },
      { id: 'q-activity', question: '做什么？', multiSelect: true, options: [{ label: '吃饭' }, { label: '散步' }] },
    ],
  }])
  assert.equal(changed, 1)
  const after = f.registry.snapshot().pending[0]
  assert.equal(after.semanticRevision, 2)
  assert.ok(after.viewRevision >= 2)
  const draft = f.registry.snapshot().drafts[interactionId]
  assert.equal(draft.semanticRevision, 2)
  assert.equal(draft.selectionRevision, 0, 'the old draft is invalidated, not silently remapped')
  assert.deepEqual(draft.answers['q-destination'].selected, [])

  const staleRevision = f.registry.resolve({
    commandId: 'stale-revision',
    interactionId,
    semanticRevision: 1,
    payload: { answers: [{ id: 'q-destination', selected: [oldHangzhou] }, { id: 'q-activity', selected: [] }] },
  })
  assert.equal(staleRevision.status, 'rejected')
  assert.equal(staleRevision.error.code, 'REVISION_MISMATCH')

  const oldOptionId = f.registry.resolve({
    commandId: 'stale-option',
    interactionId,
    semanticRevision: 2,
    payload: { answers: [{ id: 'q-destination', selected: [oldHangzhou] }, { id: 'q-activity', selected: [] }] },
  })
  assert.equal(oldOptionId.status, 'rejected')
  assert.equal(oldOptionId.error.code, 'INVALID_ANSWER')

  const freshHangzhou = after.questions[0].options[2].id
  const accepted = f.registry.resolve({
    commandId: 'fresh-revision',
    interactionId,
    semanticRevision: 2,
    payload: { answers: [{ id: 'q-destination', selected: [freshHangzhou] }, { id: 'q-activity', selected: [] }] },
  })
  assert.equal(accepted.status, 'resolved')
  assert.equal(accepted.result.outcome, 'answered')
  assert.equal(f.registry.stats().officialCalls, 1)
})

test('question wording or identity changes bump semanticRevision instead of re-interpreting old answers', async (t) => {
  const f = fixture(t)
  f.mirror.ask('question', { agent: agent(), questions: PRODUCT_QUESTIONS() }).catch(() => {})
  await tick()
  const interactionId = f.firstId()
  f.registry.syncOfficialRequests([{ id: interactionId, kind: 'question', sessionId: SESSION, questions: [
    { id: 'q-destination', question: '你要去哪里？', options: [{ label: '上海' }, { label: '杭州' }, { label: '北京' }] },
    { id: 'q-activity', question: '做什么？', multiSelect: true, options: [{ label: '吃饭' }, { label: '散步' }] },
  ] }])
  assert.equal(f.registry.snapshot().pending[0].semanticRevision, 2)
  f.registry.syncOfficialRequests([{ id: interactionId, kind: 'question', sessionId: SESSION, questions: [
    { id: 'q-destination-v2', question: '你要去哪里？', options: [{ label: '上海' }, { label: '杭州' }, { label: '北京' }] },
    { id: 'q-activity', question: '做什么？', multiSelect: true, options: [{ label: '吃饭' }, { label: '散步' }] },
  ] }])
  assert.equal(f.registry.snapshot().pending[0].semanticRevision, 3)
  const rejected = f.registry.resolve({
    commandId: 'swap-question',
    interactionId,
    semanticRevision: 2,
    payload: { answers: [{ id: 'q-destination', selected: [] }, { id: 'q-activity', selected: [] }] },
  })
  assert.equal(rejected.error.code, 'REVISION_MISMATCH')
  assert.equal(f.registry.stats().officialCalls, 0)
})

test('a viewRevision-only change keeps the same semantic revision and the valid answer/draft', async (t) => {
  const f = fixture(t)
  f.mirror.ask('question', { agent: agent(), questions: OFFICIAL_ID_QUESTIONS() }).catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const before = f.registry.snapshot().pending[0]
  const hangzhou = before.questions[0].options.find((option) => option.label === '杭州').id
  assert.equal(hangzhou, 'official:o-hangzhou')
  const draft = f.registry.draftSelect({
    commandId: 'view-draft-1',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 0,
    questionId: 'q1',
    optionId: hangzhou,
    selected: true,
  })
  assert.equal(draft.result.selectionRevision, 1)

  // Reorder + display-only header/detail change: same official option identities.
  const changed = f.registry.syncOfficialRequests([{
    id: interactionId,
    kind: 'question',
    sessionId: SESSION,
    questions: [{
      id: 'q1',
      header: '出行方式',
      detail: '仅展示，便于阅读',
      question: '去哪？',
      options: [{ id: 'o-hangzhou', label: '杭州' }, { id: 'o-shanghai', label: '上海' }],
    }],
  }])
  assert.equal(changed, 1)
  const after = f.registry.snapshot().pending[0]
  assert.equal(after.semanticRevision, 1, 'display-only changes never invalidate the semantic revision')
  assert.ok(after.viewRevision > before.viewRevision)
  assert.deepEqual(f.registry.snapshot().drafts[interactionId].answers.q1.selected, [hangzhou])

  const accepted = f.registry.resolve({
    commandId: 'view-answer-1',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 1,
    payload: { answers: [{ id: 'q1', selected: [hangzhou] }] },
  })
  assert.equal(accepted.status, 'resolved')
  assert.equal(accepted.result.outcome, 'answered')
  assert.equal(f.registry.stats().officialCalls, 1)
})

// ---------------------------------------------------------------------------
// B2-G03: multi-select drafts, set-selected, submit binding
// ---------------------------------------------------------------------------

test('multi-select set-selected is idempotent, replay never inverts, and submit binds the seen selectionRevision', async (t) => {
  const f = fixture(t)
  const pending = f.mirror.ask('question', { agent: agent(), questions: MULTI_QUESTIONS() })
  pending.catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const options = f.registry.snapshot().pending[0].questions[0].options
  const [eat, walk] = options

  const selectEat = { commandId: 'ms-1', interactionId, semanticRevision: 1, selectionRevision: 0, questionId: 'q-activity', optionId: eat.id, selected: true }
  const first = f.registry.draftSelect(selectEat)
  assert.equal(first.status, 'resolved')
  assert.deepEqual(first.result.selectedOptionIds, [eat.id])
  assert.equal(first.result.selectionRevision, 1)

  const replay = f.registry.draftSelect(selectEat)
  assert.deepEqual(replay.result, first.result, 'same key + same content returns the same receipt')

  const setAgain = f.registry.draftSelect({ ...selectEat, commandId: 'ms-2' })
  assert.equal(setAgain.result.selectionRevision, 1, 'set-selected true is idempotent in state, not a toggle')
  assert.deepEqual(setAgain.result.selectedOptionIds, [eat.id])

  const addWalk = f.registry.draftSelect({ commandId: 'ms-3', interactionId, semanticRevision: 1, selectionRevision: 1, questionId: 'q-activity', optionId: walk.id, selected: true })
  assert.equal(addWalk.result.selectionRevision, 2)
  assert.deepEqual(addWalk.result.selectedOptionIds, [eat.id, walk.id])

  // Replaying the first command returns its original receipt but does not
  // invert or rewrite the current draft.
  const replayLater = f.registry.draftSelect(selectEat)
  assert.deepEqual(replayLater.result, first.result)
  assert.deepEqual(f.registry.snapshot().drafts[interactionId].answers['q-activity'].selected, [eat.id, walk.id])

  const deselectEat = f.registry.draftSelect({ commandId: 'ms-4', interactionId, semanticRevision: 1, selectionRevision: 2, questionId: 'q-activity', optionId: eat.id, selected: false })
  assert.equal(deselectEat.result.selectionRevision, 3)
  assert.deepEqual(deselectEat.result.selectedOptionIds, [walk.id])

  const stale = f.registry.draftSelect({ commandId: 'ms-5', interactionId, semanticRevision: 1, selectionRevision: 2, questionId: 'q-activity', optionId: walk.id, selected: false })
  assert.equal(stale.status, 'rejected')
  assert.equal(stale.error.code, 'SELECTION_REVISION_MISMATCH')
  assert.equal(stale.result.selectionRevision, 3)

  const submitted = f.registry.resolve({
    commandId: 'ms-submit-1',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 3,
    payload: { answers: [{ id: 'q-activity', selected: [walk.id] }] },
  })
  assert.equal(submitted.status, 'resolved')
  assert.equal(submitted.result.outcome, 'answered')
  const officialAnswer = await pending
  assert.deepEqual(officialAnswer.answers[0].selected, ['散步'])
  assert.equal(f.registry.stats().officialCalls, 1)
})

test('single-select draft uses set-selected replacement semantics', async (t) => {
  const f = fixture(t)
  f.mirror.ask('question', { agent: agent(), questions: [{ id: 'q1', question: '去哪？', options: [{ label: '上海' }, { label: '杭州' }] }] }).catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const options = f.registry.snapshot().pending[0].questions[0].options
  f.registry.draftSelect({ commandId: 'ss-1', interactionId, semanticRevision: 1, selectionRevision: 0, optionId: options[0].id, selected: true })
  const replaced = f.registry.draftSelect({ commandId: 'ss-2', interactionId, semanticRevision: 1, selectionRevision: 1, optionId: options[1].id, selected: true })
  assert.deepEqual(replaced.result.selectedOptionIds, [options[1].id])
  assert.equal(replaced.result.selectionRevision, 2)
  const cleared = f.registry.draftSelect({ commandId: 'ss-3', interactionId, semanticRevision: 1, selectionRevision: 2, optionId: options[1].id, selected: false })
  assert.deepEqual(cleared.result.selectedOptionIds, [])
})

test('draft custom text participates in the bound submit and partial batches are rejected', async (t) => {
  const f = fixture(t)
  const pending = f.mirror.ask('question', { agent: agent(), questions: PRODUCT_QUESTIONS() })
  pending.catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const custom = f.registry.draftCustom({ commandId: 'custom-1', interactionId, semanticRevision: 1, selectionRevision: 0, questionId: 'q-destination', text: '  私人飞机  ' })
  assert.equal(custom.status, 'resolved')
  assert.equal(custom.result.answers['q-destination'].custom, '私人飞机')
  assert.equal(custom.result.selectionRevision, 1)

  const partial = f.registry.resolve({
    commandId: 'partial-1',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 1,
    payload: { answers: [{ id: 'q-destination', selected: [], custom: '私人飞机' }] },
  })
  assert.equal(partial.status, 'rejected')
  assert.equal(partial.error.code, 'INVALID_ANSWER')
  assert.equal(f.registry.snapshot().pending.length, 1, 'no silent drop: the question stays pending')

  const option = f.registry.snapshot().pending[0].questions[1].options[0].id
  const full = f.registry.resolve({
    commandId: 'full-1',
    interactionId,
    semanticRevision: 1,
    selectionRevision: 1,
    payload: { answers: [{ id: 'q-destination', selected: [], custom: '私人飞机' }, { id: 'q-activity', selected: [option] }] },
  })
  assert.equal(full.status, 'resolved')
  assert.equal(full.result.outcome, 'answered')
  assert.equal(f.registry.stats().officialCalls, 1)
  const officialAnswer = await pending
  assert.deepEqual(officialAnswer.answers[0], { id: 'q-destination', selected: [], custom: '私人飞机' })
})

// ---------------------------------------------------------------------------
// B2-G01/G08: restart / receipt recovery / unknown, never blind replay
// ---------------------------------------------------------------------------

function receiptFile(t) {
  const dir = mkdtempSync(join(tmpdir(), 'beta2-registry-'))
  return join(dir, 'interaction-receipts.json')
}

test('a resolved receipt survives a restart as read-only history and no official call is replayed', async (t) => {
  const file = receiptFile(t)
  const mirrorA = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const registryA = createInteractionRegistry({ mirror: mirrorA, hostEpoch: 'epoch-a', receipts: createReceiptStore({ file, maxEntries: 16 }) })
  const pending = askApproval(mirrorA)
  await tick()
  const interactionId = registryA.snapshot().pending[0].id
  const first = registryA.resolve({ commandId: 'restart-resolved-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(first.status, 'resolved')
  assert.equal(await pending, 'allowed-once')
  registryA.dispose()
  mirrorA.dispose()

  let officialCalls = 0
  const registryB = createInteractionRegistry({
    mirror: null,
    hostEpoch: 'epoch-b',
    receipts: createReceiptStore({ file, maxEntries: 16 }),
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registryB.dispose())
  const replay = registryB.resolve({ commandId: 'restart-resolved-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(replay.status, 'resolved')
  assert.equal(replay.result.outcome, 'allowed-once')
  assert.equal(replay.result.recovered, true)
  const late = registryB.resolve({ commandId: 'restart-resolved-2', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(late.status, 'resolved')
  assert.equal(late.result.outcome, 'allowed-once')
  assert.equal(late.result.alreadyResolved, true)
  assert.equal(officialCalls, 0, 'restart recovery is read-only: never re-apply the decision')
})

test('an in-flight receipt at crash becomes unknown after restart and is never replayed', async (t) => {
  const file = receiptFile(t)
  const mirrorA = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const registryA = createInteractionRegistry({
    mirror: mirrorA,
    hostEpoch: 'epoch-a',
    receipts: createReceiptStore({ file, maxEntries: 16 }),
    officialAnswer: () => neverAnswerer(),
  })
  askApproval(mirrorA)
  await tick()
  const interactionId = registryA.snapshot().pending[0].id
  const accepted = registryA.resolve({ commandId: 'restart-unknown-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(accepted.status, 'accepted')
  registryA.dispose()
  mirrorA.dispose()

  let officialCalls = 0
  const registryB = createInteractionRegistry({
    mirror: null,
    hostEpoch: 'epoch-b',
    receipts: createReceiptStore({ file, maxEntries: 16 }),
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registryB.dispose())
  const sameKey = registryB.resolve({ commandId: 'restart-unknown-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(sameKey.status, 'unknown')
  assert.equal(sameKey.error.code, 'INTERACTION_UNKNOWN_AFTER_RESTART')
  const newKey = registryB.resolve({ commandId: 'restart-unknown-2', interactionId, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(newKey.status, 'unknown')
  assert.equal(newKey.error.code, 'INTERACTION_UNKNOWN_AFTER_RESTART')
  assert.equal(officialCalls, 0, 'unknown is never retried blindly')
  const snapshot = registryB.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.ok(snapshot.unknown.some((item) => item.id === interactionId))
})

test('with an optional state store, restarting exposes the unconfirmed interaction as unknown and keeps its draft for inspection', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'beta2-registry-state-'))
  const file = join(dir, 'interaction-state.json')
  const mirrorA = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const stateA = createStateStore({ file })
  const registryA = createInteractionRegistry({ mirror: mirrorA, hostEpoch: 'epoch-a', store: stateA })
  const pendingQuestion = mirrorA.ask('question', { agent: agent(), questions: MULTI_QUESTIONS() })
  pendingQuestion.catch(() => {})
  await tick()
  const interactionId = registryA.snapshot().pending[0].id
  const option = registryA.snapshot().pending[0].questions[0].options[0].id
  registryA.draftSelect({ commandId: 'state-draft-1', interactionId, semanticRevision: 1, selectionRevision: 0, questionId: 'q-activity', optionId: option, selected: true })
  registryA.dispose()
  mirrorA.dispose()

  let officialCalls = 0
  const stateB = createStateStore({ file })
  const registryB = createInteractionRegistry({
    mirror: null,
    hostEpoch: 'epoch-b',
    store: stateB,
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registryB.dispose())
  const snapshot = registryB.snapshot()
  assert.equal(snapshot.pending.length, 0)
  const unknown = snapshot.unknown.find((item) => item.id === interactionId)
  assert.ok(unknown, 'the unconfirmed interaction is inspectable after restart')
  assert.equal(unknown.reason, 'HOST_RESTARTED')
  assert.deepEqual(unknown.draft.answers['q-activity'].selected, [option], 'the unsubmitted draft text survives for diagnostics only')
  const retry = registryB.resolve({ commandId: 'state-retry-1', interactionId, semanticRevision: 1, payload: { answers: [{ id: 'q-activity', selected: [option] }] } })
  assert.equal(retry.status, 'unknown')
  assert.equal(officialCalls, 0)
})

test('lost receipts do not create a new interaction or call the official service', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'beta2-registry-'))
  let officialCalls = 0
  const registry = createInteractionRegistry({
    mirror: null,
    hostEpoch: 'epoch-lost',
    receipts: createReceiptStore({ file: join(dir, 'missing-receipts.json'), maxEntries: 16 }),
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registry.dispose())
  const receipt = registry.resolve({ commandId: 'lost-1', interactionId: 'interaction-that-never-existed', semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(receipt.status, 'rejected')
  assert.equal(receipt.error.code, 'INTERACTION_NOT_FOUND')
  assert.equal(officialCalls, 0)
})

test('an unconfirmable official answerer result becomes unknown and is not replayed', async (t) => {
  let officialCalls = 0
  const f = fixture(t, {
    registry: {
      officialAnswer: () => {
        officialCalls += 1
        return Promise.reject(Object.assign(new Error('bridge socket closed'), { code: 'TRANSPORT_CLOSED' }))
      },
    },
  })
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  const first = f.registry.resolve({ commandId: 'unknown-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(first.status, 'accepted')
  await tick()
  assert.equal(f.registry.snapshot().pending.length, 0)
  assert.equal(f.registry.snapshot().recentlyResolved[0].outcome, 'unknown')
  const replay = f.registry.resolve({ commandId: 'unknown-1', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(replay.status, 'unknown')
  const retry = f.registry.resolve({ commandId: 'unknown-2', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(retry.status, 'unknown')
  assert.equal(retry.error.code, 'INTERACTION_UNKNOWN')
  assert.equal(officialCalls, 1)
})

test('an unbound official decision with several pending approvals is not mis-targeted', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror, { callId: 'call-ambiguous-a' })
  askApproval(f.mirror, { callId: 'call-ambiguous-b' })
  await tick()
  assert.equal(f.registry.snapshot().pending.length, 2)
  const handled = f.registry.observeOfficial({ type: 'approval/decided', data: { outcome: 'allowed-once', sessionId: SESSION } })
  assert.equal(handled, false, 'two pending approvals are ambiguous; the registry never picks "the first request"')
  assert.equal(f.registry.snapshot().pending.length, 2)
  assert.equal(f.registry.stats().officialCalls, 0)
  // Once the official request identity is bound, convergence is unambiguous.
  assert.equal(f.registry.observeOfficial({
    type: 'approval/asked',
    data: { id: 'official-ambiguous-b', callId: 'call-ambiguous-b', toolName: 'write', sessionId: SESSION },
  }), true)
  assert.equal(f.registry.observeOfficial({
    type: 'approval/decided',
    data: { id: 'official-ambiguous-b', outcome: 'rejected', sessionId: SESSION },
  }), true)
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.pending.length, 1)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'rejected')
  assert.equal(snapshot.recentlyResolved[0].source, 'official')
})

// ---------------------------------------------------------------------------
// approval operation summary binding
// ---------------------------------------------------------------------------

test('an approval decision is bound to the operation summary it was shown for', async (t) => {
  const operation = { toolName: 'write', arguments: { path: '/etc/hosts', content: 'x' }, cwd: '/tmp/workspace' }
  const f = fixture(t)
  askApproval(f.mirror, { operation })
  await tick()
  const interactionId = f.firstId()
  const pending = f.registry.snapshot().pending[0]
  assert.deepEqual(pending.operation, operation)

  const wrongOperation = f.registry.resolve({
    commandId: 'op-1',
    interactionId,
    semanticRevision: 1,
    operationDigest: digest({ toolName: 'bash', arguments: { command: 'rm -rf /' } }),
    payload: { decision: 'allowed-once' },
  })
  assert.equal(wrongOperation.status, 'rejected')
  assert.equal(wrongOperation.error.code, 'OPERATION_MISMATCH')
  assert.equal(f.registry.stats().officialCalls, 0)
  assert.equal(f.registry.snapshot().pending.length, 1)

  const changedOperation = { ...operation, arguments: { path: '/usr/local/bin/tool', content: 'y' } }
  f.registry.syncOfficialRequests([{ id: interactionId, kind: 'approval', sessionId: SESSION, operation: changedOperation }])
  const after = f.registry.snapshot().pending[0]
  assert.equal(after.semanticRevision, 2)
  assert.deepEqual(after.operation, changedOperation)

  const staleRevision = f.registry.resolve({ commandId: 'op-2', interactionId, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(staleRevision.error.code, 'REVISION_MISMATCH')

  const accepted = f.registry.resolve({
    commandId: 'op-3',
    interactionId,
    semanticRevision: 2,
    operationDigest: digest(changedOperation),
    payload: { decision: 'allowed-once' },
  })
  assert.equal(accepted.status, 'resolved')
  assert.equal(accepted.result.outcome, 'allowed-once')
  assert.equal(f.registry.stats().officialCalls, 1)
})

// ---------------------------------------------------------------------------
// Presentation projection: official request label (toolName/reason)
// ---------------------------------------------------------------------------

test('the approval projection carries the official toolName and reason; questions keep both null', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror, { toolName: 'write', reason: 'write outside workspace: /etc/hosts', callId: 'call-label-1' })
  await tick()
  const approval = f.registry.snapshot().pending[0]
  assert.equal(approval.kind, 'approval')
  assert.equal(approval.toolName, 'write')
  assert.equal(approval.reason, 'write outside workspace: /etc/hosts')
  assert.equal(approval.questions, null)
  assert.equal(approval.operation, null)

  const q = fixture(t)
  q.mirror.ask('question', { agent: agent(), questions: OFFICIAL_ID_QUESTIONS() }).catch(() => {})
  await tick()
  const question = q.registry.snapshot().pending[0]
  assert.equal(question.kind, 'question')
  assert.equal(question.toolName, null)
  assert.equal(question.reason, null)
})

test('an official approval/asked binding fills a missing toolName/reason and operation supplies the fallback tool name', async (t) => {
  let officialCalls = 0
  const registry = createInteractionRegistry({
    mirror: null,
    hostEpoch: HOST_EPOCH,
    getSessionId: () => SESSION,
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registry.dispose())
  // Adopted from a bare official projection: no label yet.
  registry.syncOfficialRequests([{ interactionId: 'int-approval-label', kind: 'approval', sessionId: SESSION, callId: 'call-label-late' }])
  assert.equal(registry.snapshot().pending[0].toolName, null)
  assert.equal(registry.snapshot().pending[0].reason, null)
  // The durable approval/asked names the tool and reason; binding preserves them.
  assert.equal(registry.observeOfficial({
    type: 'approval/asked',
    data: { id: 'official-label-1', callId: 'call-label-late', toolName: 'terminal', reason: 'run: rm -rf /tmp/scratch', sessionId: SESSION },
  }), true)
  const bound = registry.snapshot().pending[0]
  assert.equal(bound.toolName, 'terminal')
  assert.equal(bound.reason, 'run: rm -rf /tmp/scratch')

  // An operation summary is a fallback source for the tool name.
  registry.syncOfficialRequests([{
    interactionId: 'int-approval-op',
    kind: 'approval',
    sessionId: SESSION,
    callId: 'call-label-op',
    operation: { toolName: 'write', arguments: { path: '/etc/hosts' }, cwd: '/tmp' },
  }])
  const withOperation = registry.snapshot().pending.find((item) => item.id === 'int-approval-op')
  assert.equal(withOperation.toolName, 'write')
  assert.equal(withOperation.reason, null)
  assert.deepEqual(withOperation.operation, { toolName: 'write', arguments: { path: '/etc/hosts' }, cwd: '/tmp' })
  assert.equal(officialCalls, 0)
})

// ---------------------------------------------------------------------------
// main-window-initiated interactions observed through official projections
// ---------------------------------------------------------------------------

test('a main-window-initiated question is adopted, converges on the official result, and late answers stay resolved', async (t) => {
  let officialCalls = 0
  const registry = createInteractionRegistry({
    mirror: null,
    hostEpoch: HOST_EPOCH,
    getSessionId: () => SESSION,
    officialAnswer: () => { officialCalls += 1; return true },
  })
  t.after(() => registry.dispose())
  const adopted = registry.syncOfficialRequests([{
    interactionId: 'int-main-window',
    kind: 'question',
    sessionId: SESSION,
    callId: 'call-main-window',
    questions: OFFICIAL_ID_QUESTIONS(),
  }])
  assert.equal(adopted, 1)
  const pending = registry.snapshot().pending
  assert.equal(pending.length, 1)
  assert.equal(pending[0].id, 'int-main-window')
  assert.equal(pending[0].officialCallId, 'call-main-window')

  assert.equal(registry.observeOfficial({
    type: 'question/decided',
    data: { id: 'call-main-window', outcome: 'answered', answers: [{ id: 'q1', selected: ['杭州'] }] },
  }), true)
  const snapshot = registry.snapshot()
  assert.equal(snapshot.pending.length, 0)
  assert.equal(snapshot.recentlyResolved[0].outcome, 'answered')
  assert.equal(snapshot.recentlyResolved[0].source, 'official')

  const late = registry.resolve({
    commandId: 'main-late-1',
    interactionId: 'int-main-window',
    semanticRevision: 1,
    payload: { answers: [{ id: 'q1', selected: ['official:o-shanghai'] }] },
  })
  assert.equal(late.status, 'resolved')
  assert.equal(late.result.outcome, 'answered')
  assert.equal(late.result.alreadyResolved, true)
  assert.equal(officialCalls, 0, 'the registry never answers a request the main window already settled')
})

// ---------------------------------------------------------------------------
// command validation and single-writer invariants
// ---------------------------------------------------------------------------

test('invalid commands are rejected without side effects and never fall through to new work', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror)
  await tick()
  const interactionId = f.firstId()
  askApproval(f.mirror, { callId: 'call-write-2' })
  await tick()

  const missingId = f.registry.resolve({ commandId: 'bad-1', interactionId: '', semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(missingId.status, 'rejected')
  assert.equal(missingId.error.code, 'MISSING_INTERACTION_ID')

  const badDecision = f.registry.resolve({ commandId: 'bad-2', interactionId, semanticRevision: 1, payload: { decision: 'yes please' } })
  assert.equal(badDecision.status, 'rejected')
  assert.equal(badDecision.error.code, 'INVALID_DECISION')

  const answerForApproval = f.registry.resolve({ commandId: 'bad-3', interactionId, semanticRevision: 1, payload: { answers: [{ id: 'q1', selected: [] }] } })
  assert.equal(answerForApproval.status, 'rejected')
  assert.equal(answerForApproval.error.code, 'INVALID_PAYLOAD')

  const notFound = f.registry.resolve({ commandId: 'bad-4', interactionId: 'does-not-exist', semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(notFound.status, 'rejected')
  assert.equal(notFound.error.code, 'INTERACTION_NOT_FOUND')

  assert.equal(f.registry.stats().officialCalls, 0)
  assert.equal(f.registry.snapshot().pending.length, 2, 'invalid commands never silently drop or answer a request')
})

test('snapshot projects every pending interaction with stable option ids and drafts; resolution clears the focus', async (t) => {
  const f = fixture(t)
  f.mirror.ask('question', { agent: agent(), questions: OFFICIAL_ID_QUESTIONS() }).catch(() => {})
  await tick()
  const interactionId = f.firstId()
  const snapshot = f.registry.snapshot()
  assert.equal(snapshot.focusedId, interactionId)
  const item = snapshot.pending[0]
  assert.equal(item.kind, 'question')
  assert.equal(item.sessionId, SESSION)
  assert.equal(typeof item.createdAt, 'string')
  assert.equal(typeof item.expiresAt, 'string')
  assert.equal(item.operation, null)
  for (const question of item.questions) {
    for (const option of question.options) {
      assert.equal(typeof option.id, 'string')
      assert.ok(option.id.length > 0)
      assert.equal(typeof option.label, 'string')
    }
  }
  assert.deepEqual(snapshot.drafts[interactionId].answers.q1.selected, [])
  assert.equal(snapshot.drafts[interactionId].selectionRevision, 0)

  f.registry.resolve({
    commandId: 'snap-1',
    interactionId,
    semanticRevision: 1,
    payload: { answers: [{ id: 'q1', selected: ['official:o-shanghai'] }] },
  })
  const after = f.registry.snapshot()
  assert.equal(after.pending.length, 0)
  assert.equal(after.focusedId, null)
  assert.equal(after.recentlyResolved[0].id, interactionId)
  assert.ok(f.eventTypes().includes('interaction.requested'))
  assert.ok(f.eventTypes().includes('interaction.resolved'))
  const resolvedEvent = f.events.map((event) => event).find((event) => event.type === 'interaction.resolved')
  assert.ok(resolvedEvent)
})
