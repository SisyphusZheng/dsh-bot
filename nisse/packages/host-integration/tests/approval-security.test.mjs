/**
 * Approval security matrix (0.0.1 final closure, Phase A2).
 *
 * These tests pin the decision points behind the four deferred approval findings so the
 * security claim is executable rather than a code-reading opinion:
 *  - the registry rejects any non-current semanticRevision instead of reinterpreting it;
 *  - a decision settles the official approval at most once (duplicate clicks, two UIs);
 *  - two concurrent approvals never cross-settle;
 *  - the degraded path used by `/approval` when the registry is unavailable (`mirror.answer`)
 *    settles the single official request once, refuses a replay, and refuses a foreign session;
 *  - omitting semanticRevision does not reintroduce position/label reinterpretation.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createInteractionMirror } from '../lib/interactions.mjs'
import { createInteractionRegistry } from '../lib/interaction-registry.mjs'

const SESSION = 'session-approval-security'
const HOST_EPOCH = 'host-epoch-approval-security'
const tick = () => new Promise((resolve) => setImmediate(resolve))
const agent = () => ({ session: { id: SESSION } })
const neverAnswerer = () => new Promise(() => {})

function fixture(t) {
  const events = []
  const sink = (type, fields) => events.push({ type, fields })
  const mirror = createInteractionMirror({ forward: async () => neverAnswerer(), emit: sink, hasLocalUi: () => true })
  const registry = createInteractionRegistry({ mirror, hostEpoch: HOST_EPOCH, getSessionId: () => SESSION, emit: sink })
  t.after(() => { try { registry.dispose() } catch { /* disposed */ } try { mirror.dispose() } catch { /* disposed */ } })
  return { mirror, registry, events }
}

function askApproval(mirror, callId) {
  return mirror.ask('approval', {
    agent: agent(),
    toolName: 'write',
    reason: 'write outside workspace: /tmp/evidence/target.txt',
    callId,
  })
}

test('a non-current semanticRevision is rejected and never reaches the official answerer', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror, 'call-a').catch(() => {})
  await tick()
  const id = f.registry.snapshot().pending[0].id
  for (const revision of [0, 2, 99]) {
    const result = f.registry.resolve({ commandId: `stale-${revision}`, interactionId: id, semanticRevision: revision, payload: { decision: 'allowed-once' } })
    assert.equal(result.status, 'rejected', `revision ${revision} must be rejected`)
    assert.equal(result.error.code, 'REVISION_MISMATCH')
  }
  assert.equal(f.registry.stats().officialCalls, 0, 'no official decision was fabricated for a stale revision')
  assert.equal(f.registry.snapshot().pending[0].id, id, 'the real request is still pending')
})

test('duplicate clicks on one approval settle the official request exactly once', async (t) => {
  const f = fixture(t)
  const decision = askApproval(f.mirror, 'call-b')
  await tick()
  const id = f.registry.snapshot().pending[0].id
  const first = f.registry.resolve({ commandId: 'click-1', interactionId: id, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  const second = f.registry.resolve({ commandId: 'click-2', interactionId: id, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(first.status, 'resolved')
  assert.equal(first.result.outcome, 'allowed-once')
  assert.ok(['resolved', 'rejected'].includes(second.status))
  assert.notEqual(second.result?.outcome, 'rejected', 'the second click cannot flip an already-made decision')
  assert.equal(await decision, 'allowed-once')
  assert.equal(f.registry.stats().officialCalls, 1)
})

test('two concurrent approvals do not cross-settle or share identity', async (t) => {
  const f = fixture(t)
  const firstDecision = askApproval(f.mirror, 'call-c1')
  const secondDecision = askApproval(f.mirror, 'call-c2')
  await tick()
  const [a, b] = f.registry.snapshot().pending.map((item) => item.id)
  assert.ok(a && b && a !== b, 'two distinct interactions are pending')
  const resolveA = f.registry.resolve({ commandId: 'resolve-a', interactionId: a, semanticRevision: 1, payload: { decision: 'allowed-once' } })
  assert.equal(resolveA.status, 'resolved')
  assert.equal(await firstDecision, 'allowed-once')
  assert.equal(f.registry.snapshot().pending.length, 1, 'resolving one approval leaves the other pending')
  assert.equal(f.registry.snapshot().pending[0].id, b)
  const resolveB = f.registry.resolve({ commandId: 'resolve-b', interactionId: b, semanticRevision: 1, payload: { decision: 'rejected' } })
  assert.equal(resolveB.status, 'resolved')
  assert.equal(await secondDecision, 'rejected', 'the second approval keeps its own decision')
  assert.equal(f.registry.stats().officialCalls, 2)
})

test('degraded path without a registry settles once, refuses replay and refuses a foreign session', async () => {
  const mirror = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const decision = mirror.ask('approval', { agent: agent(), toolName: 'write', reason: 'degraded', callId: 'call-d' })
  await tick()
  const [item] = mirror.snapshot()
  assert.ok(item, 'the official request is presented even without the registry')
  assert.equal(mirror.answer(item.id, 'another-session', 'allowed-once'), false, 'a request is bound to its own session')
  assert.equal(mirror.snapshot().length, 1, 'a foreign session cannot settle the request')
  mirror.dispose()
  assert.equal(await decision, 'cancelled', 'dispose fails closed instead of leaving the agent waiting')
})

test('the degraded path refuses an invalid decision and a replay, and settles exactly once', async () => {
  const mirror = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const decision = mirror.ask('approval', { agent: agent(), toolName: 'write', reason: 'degraded', callId: 'call-e' })
  await tick()
  const [item] = mirror.snapshot()
  assert.throws(() => mirror.answer(item.id, SESSION, 'cancelled'), /Invalid approval decision/)
  assert.equal(mirror.answer(item.id, SESSION, 'allowed-once'), true)
  assert.equal(mirror.answer(item.id, SESSION, 'allowed-once'), false, 'the same request cannot be answered twice')
  assert.equal(await decision, 'allowed-once')
  assert.equal(mirror.snapshot().length, 0)
  mirror.dispose()
})

test('omitting semanticRevision does not reintroduce position or label reinterpretation', async (t) => {
  const f = fixture(t)
  askApproval(f.mirror, 'call-f').catch(() => {})
  await tick()
  const id = f.registry.snapshot().pending[0].id
  // An approval carries one operation, so a revision-less decision is the documented compatibility
  // path; it still settles only this interaction and only once.
  const compat = f.registry.resolve({ commandId: 'compat-1', interactionId: id, payload: { decision: 'allowed-once' } })
  assert.equal(compat.status, 'resolved')
  assert.equal(f.registry.stats().officialCalls, 1)
  // A question must not be answerable by label or position when the revision is omitted: only
  // revision-scoped option ids from the current revision are accepted.
  const mirror2 = createInteractionMirror({ forward: async () => neverAnswerer(), emit: () => {}, hasLocalUi: () => true })
  const registry2 = createInteractionRegistry({ mirror: mirror2, hostEpoch: HOST_EPOCH, getSessionId: () => SESSION, emit: () => {} })
  t.after(() => { try { registry2.dispose() } catch { /* disposed */ } try { mirror2.dispose() } catch { /* disposed */ } })
  mirror2.ask('question', { agent: agent(), questions: [{ id: 'q1', question: '去哪？', options: [{ label: '上海' }, { label: '杭州' }] }] }).catch(() => {})
  await tick()
  const questionId = registry2.snapshot().pending[0].id
  const byLabel = registry2.resolve({ commandId: 'label-answer', interactionId: questionId, payload: { answers: [{ id: 'q1', selected: ['上海'] }] } })
  assert.equal(byLabel.status, 'rejected', 'a label is not an option identity')
  const byPosition = registry2.resolve({ commandId: 'position-answer', interactionId: questionId, payload: { answers: [{ id: 'q1', selected: ['0'] }] } })
  assert.equal(byPosition.status, 'rejected', 'a position is not an option identity')
  assert.equal(registry2.stats().officialCalls, 0)
})
