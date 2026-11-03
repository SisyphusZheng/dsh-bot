/**
 * R2 unknown-interaction user visibility (closure 0.0.1, plan §5.2 / F1 DEFERRED gap).
 *
 * Pins the additive `snapshot@1` `interactions.unknown` projection and the one Chinese
 * "result unconfirmed" notice that rides on it:
 *   - a recovered unknown interaction is projected in `interactions.unknown` while the
 *     legacy `focusedId/pending/drafts/recentlyResolved` fields keep their exact meaning;
 *   - the visible hint is a warning notice with the safe "打开主窗口确认" action and never
 *     claims success, cancellation or ordinary idle;
 *   - the projection is read-only: the service never resolves, retries or replays anything;
 *   - an older registry/Host without the field stays compatible (absent means "nothing
 *     known to be unconfirmed", never a fabricated result);
 *   - a graceful / known cancellation is not reclassified as unknown;
 *   - announce-once semantics for polling, refresh on a new unknown, and re-announce when a
 *     desktop attaches after the hint expired.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConversationService } from '../lib/conversation-service.mjs'
import { createSnapshotStore } from '../lib/snapshot.mjs'
import {PRODUCT_VERSION} from './product-version.mjs'

const HOST_EPOCH = 'epoch-r2-unknown'
const UNKNOWN_AT = '2026-10-31T03:00:00.000Z'

function fakeRuntime() {
  const state = { submitted: [], commands: [], cancelled: [], turn: 0, sessionId: 'session-1' }
  const runtime = {
    productVersion: () => PRODUCT_VERSION,
    runtimeVersion: () => '0.2.1-rc.3',
    sessionId: () => state.sessionId,
    agentReady: () => true,
    workspace: () => '/tmp/workspace',
    conversationIndex: () => 1,
    ensureAgent: async () => {},
    submitTurn: async (text, opts = {}) => {
      state.submitted.push({ text, opts })
      state.turn += 1
      return { sessionId: state.sessionId, turn: state.turn }
    },
    cancelTurn: async (options) => {
      state.cancelled.push(options)
      return { ok: true, cancelled: true, confirmed: true }
    },
    emitCommand: (type, payload) => {
      const commandId = 'cmd-' + (state.commands.length + 1)
      state.commands.push({ commandId, type, payload })
      return commandId
    },
    continuedQuestions: () => [],
  }
  return { runtime, state }
}

/** Fake registry whose recovered projection the test can mutate between polls. */
function fakeRegistry({ pending = [], recentlyResolved = [], unknown = null } = {}) {
  const calls = []
  const state = {
    pending: [...pending],
    recentlyResolved: [...recentlyResolved],
    unknown: unknown === null ? null : [...unknown],
  }
  return {
    calls,
    state,
    snapshot: () => ({
      focusedId: state.pending[0]?.id || null,
      pending: [...state.pending],
      drafts: {},
      recentlyResolved: [...state.recentlyResolved],
      ...(state.unknown === null ? {} : { unknown: [...state.unknown] }),
    }),
    resolve: (request) => {
      calls.push({ kind: 'resolve', request })
      return { status: 'resolved', result: { interactionId: request.interactionId, outcome: 'answered' } }
    },
    draftSelect: (request) => {
      calls.push({ kind: 'draftSelect', request })
      return { status: 'accepted', result: {} }
    },
    draftCustom: (request) => {
      calls.push({ kind: 'draftCustom', request })
      return { status: 'accepted', result: {} }
    },
    observeOfficial: () => {},
    dispose: () => {},
  }
}

const recoveredUnknown = (id = 'ix-recovered') => ({
  id,
  kind: 'approval',
  sessionId: 'session-1',
  reason: 'HOST_RESTARTED',
  at: UNKNOWN_AT,
  draft: null,
})

function makeService({ runtime, registry, config = {} } = {}) {
  const events = createSnapshotStore({ hostEpoch: HOST_EPOCH })
  let clock = Date.parse('2026-10-31T03:00:00.000Z')
  const service = createConversationService({
    hostEpoch: HOST_EPOCH,
    events,
    registry,
    runtime,
    config: {
      settleMs: 20, drainMs: 20, queueTtlMs: 60_000, draftTtlMs: 30_000, cancelConfirmMs: 30_000,
      now: () => clock,
      ...config,
    },
    log: () => {},
  })
  service.start()
  return {
    service,
    events,
    advance(ms) { clock += ms; return clock },
    dispose() { service.dispose() },
  }
}

const hintNotices = (sections) => sections.notices.filter((notice) => notice.diagnosticId === 'INTERACTION_UNKNOWN')

test('snapshot projects recovered unknown interactions in the additive interactions.unknown list', () => {
  const { runtime, state } = fakeRuntime()
  const registry = fakeRegistry({ unknown: [recoveredUnknown()] })
  const service = makeService({ runtime, registry })
  try {
    const sections = service.service.snapshotSections()
    // Additive field: the exact registry-recovered identity, never a fabricated outcome.
    assert.deepEqual(sections.interactions.unknown, [{
      id: 'ix-recovered',
      kind: 'approval',
      sessionId: 'session-1',
      reason: 'HOST_RESTARTED',
      at: UNKNOWN_AT,
      action: { id: 'open-main', label: '打开主窗口确认' },
    }])
    // Legacy fields keep their previous shape and meaning.
    assert.equal(sections.interactions.focusedId, null)
    assert.deepEqual(sections.interactions.pending, [])
    assert.deepEqual(sections.interactions.drafts, {})
    assert.deepEqual(sections.interactions.recentlyResolved, [])
    // Unconfirmed is not a normal idle state.
    assert.equal(sections.presentation.displayMode, 'unknown')
    // No replay: only the read-only projection was called.
    assert.equal(state.submitted.length, 0)
    assert.equal(registry.calls.length, 0)
  } finally {
    service.dispose()
  }
})

test('the unconfirmed hint is one Chinese warning with the safe open-main action and no success claim', () => {
  const { runtime } = fakeRuntime()
  const service = makeService({ runtime, registry: fakeRegistry({ unknown: [recoveredUnknown()] }) })
  try {
    const sections = service.service.snapshotSections()
    const hints = hintNotices(sections)
    assert.equal(hints.length, 1)
    const [hint] = hints
    assert.equal(hint.kind, 'warning')
    assert.equal(hint.severity, 'warning')
    assert.match(hint.text, /尚未确认/)
    assert.doesNotMatch(hint.text, /已成功|已完成|已取消|已停止/)
    assert.deepEqual(hint.actions, [{ id: 'open-main', label: '打开主窗口确认' }])
    // The hint is additive to the existing ready notice, not a replacement for it.
    assert.ok(sections.notices.some((notice) => /Host 已就绪/.test(notice.text)))
  } finally {
    service.dispose()
  }
})

test('unknown interactions are never resolved, retried or submitted by the service', async () => {
  const { runtime, state } = fakeRuntime()
  const registry = fakeRegistry({ unknown: [recoveredUnknown('ix-a'), recoveredUnknown('ix-b')] })
  const service = makeService({ runtime, registry })
  try {
    service.service.snapshotSections()
    service.service.noteDesktopSeen()
    service.service.tick()
    service.advance(5_000)
    service.service.tick()
    service.service.snapshotSections()
    assert.equal(registry.calls.length, 0, 'no official decision may be re-issued for an unknown interaction')
    assert.equal(state.submitted.length, 0, 'no task may be submitted on the user\'s behalf')
    assert.equal(state.cancelled.length, 0)
  } finally {
    service.dispose()
  }
})

test('an older registry/Host without the unknown field stays compatible and fabricates nothing', () => {
  const { runtime } = fakeRuntime()
  const service = makeService({ runtime, registry: fakeRegistry() })
  try {
    const sections = service.service.snapshotSections()
    assert.deepEqual(sections.interactions.unknown, [])
    assert.equal(sections.presentation.displayMode, 'idle')
    assert.equal(hintNotices(sections).length, 0)
    // The legacy client view keeps parsing exactly the old four fields.
    const oldClientView = JSON.parse(JSON.stringify({
      focusedId: sections.interactions.focusedId,
      pending: sections.interactions.pending,
      drafts: sections.interactions.drafts,
      recentlyResolved: sections.interactions.recentlyResolved,
    }))
    assert.deepEqual(Object.keys(oldClientView).sort(), ['drafts', 'focusedId', 'pending', 'recentlyResolved'])
    assert.deepEqual(oldClientView.pending, [])
  } finally {
    service.dispose()
  }
})

test('a graceful cancellation stays a known outcome, never projected as unknown', () => {
  const { runtime } = fakeRuntime()
  const service = makeService({
    runtime,
    registry: fakeRegistry({ recentlyResolved: [{ id: 'ix-cancelled', kind: 'approval', outcome: 'cancelled', at: UNKNOWN_AT }] }),
  })
  try {
    const sections = service.service.snapshotSections()
    assert.deepEqual(sections.interactions.unknown, [])
    assert.equal(hintNotices(sections).length, 0)
    assert.equal(sections.interactions.recentlyResolved.length, 1)
    assert.equal(sections.interactions.recentlyResolved[0].outcome, 'cancelled')
    assert.equal(sections.presentation.displayMode, 'idle')
  } finally {
    service.dispose()
  }
})

test('a mid-session unknown is announced once, and a new one refreshes the hint', () => {
  const { runtime } = fakeRuntime()
  const registry = fakeRegistry()
  const service = makeService({ runtime, registry })
  try {
    assert.equal(hintNotices(service.service.snapshotSections()).length, 0)
    registry.state.unknown = [recoveredUnknown('ix-late')]
    service.advance(2_000)
    service.service.tick()
    const announced = hintNotices(service.service.snapshotSections())
    assert.equal(announced.length, 1)
    const firstHintId = announced[0].id
    // Repeated polling must not duplicate the hint.
    service.advance(2_000)
    service.service.tick()
    service.service.snapshotSections()
    assert.deepEqual(hintNotices(service.service.snapshotSections()).map((notice) => notice.id), [firstHintId])
    // A genuinely new unknown replaces the hint (still exactly one visible hint).
    registry.state.unknown = [recoveredUnknown('ix-late'), recoveredUnknown('ix-later')]
    service.advance(2_000)
    service.service.tick()
    const refreshed = hintNotices(service.service.snapshotSections())
    assert.equal(refreshed.length, 1)
    assert.notEqual(refreshed[0].id, firstHintId)
    assert.equal(service.service.snapshotSections().interactions.unknown.length, 2)
    assert.equal(registry.calls.length, 0)
  } finally {
    service.dispose()
  }
})

test('an expired hint is re-announced when a desktop reattaches', async () => {
  const { runtime } = fakeRuntime()
  const service = makeService({ runtime, registry: fakeRegistry({ unknown: [recoveredUnknown()] }), config: { unknownNoticeTtlMs: 20 } })
  try {
    const initial = hintNotices(service.service.snapshotSections())
    assert.equal(initial.length, 1)
    await new Promise((done) => setTimeout(done, 80))
    assert.equal(hintNotices(service.service.snapshotSections()).length, 0, 'the hint expired while no desktop was attached')
    service.service.noteDesktopSeen()
    const reannounced = hintNotices(service.service.snapshotSections())
    assert.equal(reannounced.length, 1)
    assert.notEqual(reannounced[0].id, initial[0].id)
    assert.equal(service.events.stats().seq > 0, true)
  } finally {
    service.dispose()
  }
})

test('the projection drops malformed or repeated recovered records instead of echoing them', () => {
  const { runtime } = fakeRuntime()
  const registry = fakeRegistry({
    unknown: [
      recoveredUnknown('ix-once'),
      recoveredUnknown('ix-once'),
      { id: '', reason: 'HOST_RESTARTED' },
      { id: 'ix-bare', kind: 'unknown-kind', at: 'not-a-date' },
      { id: 'ix-wrong-type', kind: 'question', sessionId: 42, reason: { code: 'X' }, at: UNKNOWN_AT },
    ],
  })
  const service = makeService({ runtime, registry })
  try {
    const unknown = service.service.snapshotSections().interactions.unknown
    assert.deepEqual(unknown.map((item) => item.id), ['ix-once', 'ix-bare', 'ix-wrong-type'])
    assert.equal(unknown[1].kind, null)
    assert.equal(unknown[1].at, null)
    assert.equal(unknown[1].reason, 'INTERACTION_UNKNOWN')
    assert.equal(unknown[2].sessionId, null)
    assert.equal(unknown[2].reason, 'INTERACTION_UNKNOWN')
    assert.equal(unknown[2].at, UNKNOWN_AT)
    for (const item of unknown) assert.deepEqual(item.action, { id: 'open-main', label: '打开主窗口确认' })
  } finally {
    service.dispose()
  }
})

test('a pending interaction still outranks the unknown hint in display mode', () => {
  const { runtime } = fakeRuntime()
  const registry = fakeRegistry({
    pending: [{ id: 'ix-open', kind: 'approval', sessionId: 'session-1', semanticRevision: 1 }],
    unknown: [recoveredUnknown()],
  })
  const service = makeService({ runtime, registry })
  try {
    const sections = service.service.snapshotSections()
    assert.equal(sections.presentation.displayMode, 'awaiting-input')
    assert.equal(sections.presentation.bubble.visible, true)
    assert.equal(sections.presentation.bubble.requestId, 'ix-open')
    assert.equal(sections.interactions.unknown.length, 1)
  } finally {
    service.dispose()
  }
})
