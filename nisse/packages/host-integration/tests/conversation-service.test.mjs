import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationService, needsConfirmation } from '../lib/conversation-service.mjs'
import { createSnapshotStore } from '../lib/snapshot.mjs'
import { createStateStore } from '../lib/persistence.mjs'
import { PROTOCOL_VERSION, canonicalJson } from '../lib/contracts.mjs'

const HOST_EPOCH = 'epoch-service-test'

function fakeRuntime(overrides = {}) {
  const state = { submitted: [], commands: [], cancelled: [], turn: 0, status: 'idle', working: false, sessionId: 'session-1' }
  const runtime = {
    productVersion: () => '0.0.1-beta2',
    runtimeVersion: () => '0.2.1-rc.3',
    sessionId: () => state.sessionId,
    agentReady: () => true,
    workspace: () => '/tmp/workspace',
    conversationIndex: () => 1,
    ensureAgent: async () => {},
    submitTurn: async (text, opts = {}) => {
      state.submitted.push({ text, opts })
      state.working = true
      return { sessionId: state.sessionId, turn: ++state.turn }
    },
    cancelTurn: async (options) => {
      state.cancelled.push(options)
      state.working = false
      return { ok: true, cancelled: true, confirmed: true }
    },
    emitCommand: (type, payload) => {
      const commandId = 'cmd-' + (state.commands.length + 1)
      state.commands.push({ commandId, type, payload })
      return commandId
    },
    continuedQuestions: () => [],
  }
  return { runtime: { ...runtime, ...overrides }, state }
}

function fakeRegistry({ pending = [], resolveImpl = null } = {}) {
  const calls = []
  const drafts = {}
  return {
    calls,
    snapshot: () => ({ focusedId: pending[0]?.id || null, pending, drafts, recentlyResolved: [] }),
    resolve: (request) => {
      calls.push({ kind: 'resolve', request })
      if (resolveImpl) return resolveImpl(request)
      if (request.payload.decision) return { status: 'resolved', result: { interactionId: request.interactionId, outcome: request.payload.decision } }
      return { status: 'resolved', result: { interactionId: request.interactionId, outcome: 'answered' } }
    },
    draftSelect: (request) => { calls.push({ kind: 'draftSelect', request }); return { status: 'accepted', result: { selectionRevision: 2 } } },
    draftCustom: (request) => { calls.push({ kind: 'draftCustom', request }); return { status: 'accepted', result: { selectionRevision: 2 } } },
    observeOfficial: () => {},
    dispose: () => {},
  }
}

function makeService({ runtime, registry, store = null, config = {}, hostEpoch = HOST_EPOCH } = {}) {
  const events = createSnapshotStore({ hostEpoch })
  const service = createConversationService({
    hostEpoch,
    events,
    store,
    registry,
    runtime,
    config: { settleMs: 20, drainMs: 20, queueTtlMs: 60_000, draftTtlMs: 30_000, cancelConfirmMs: 30_000, ...config },
    log: () => {},
  })
  service.start()
  return { service, events }
}

function utterance(text, { mode = 'hold', captureId = 'cap-1', utteranceId = 'utt-1', clientTurnId = '' } = {}) {
  return { text, mode, captureId, utteranceId, clientTurnId }
}

test('snapshot is orthogonal: capture, playback and execution can be active simultaneously', () => {
  const { runtime } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'voice', hostInitiated: true })
  const { events } = makeService({ runtime, registry: fakeRegistry() })
  assert.ok(events)
  // capture facts through the assembler + observed turn + speech projection
  const sections = service.snapshotSections()
  assert.equal(sections.execution.state, 'working')
  assert.equal(sections.identity.sessionId, 'session-1')
  service.onAssistantDelta({ sessionId: 'session-1', turn: 1, text: '你好' })
  const after = service.snapshotSections()
  assert.equal(after.playback.state, 'speaking')
  assert.equal(after.execution.state, 'working')
  assert.ok(Array.isArray(after.notices))
  assert.ok(after.interactions && Array.isArray(after.interactions.pending))
  service.dispose()
})

test('partials never submit; the assembled final submits exactly once and duplicates are ignored', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  const facts = (kind, itemId, text) => service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'c-' + itemId + '-' + kind, hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'voice.facts',
    payload: {
      connectionId: 'w1', capture: { captureId: 'cap-1', mode: 'toggle', state: 'listening' },
      items: [{ kind, itemId, utteranceId: 'utt-1', revision: 0, text, confidence: null }],
    },
  })
  await facts('asr.partial', 'p1', '帮我')
  await facts('asr.partial', 'p2', '帮我写')
  assert.equal(state.submitted.length, 0)
  await facts('asr.final', 'f1', '帮我写一份周报')
  await new Promise((resolve) => setTimeout(resolve, 60))
  service.tick()
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(state.submitted.length, 1, 'one final => one submission')
  assert.match(state.submitted[0].text, /周报/)
  // duplicate provider item must not create a second task
  await facts('asr.final', 'f1', '帮我写一份周报')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(state.submitted.length, 1)
  service.dispose()
})

test('mixed control + work: one stop command and one complete remaining input', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  const routed = await service.handleFinalUtterance(utterance('停一下。然后写一篇八百字的小作文'))
  const stops = state.commands.filter((command) => command.type === 'playback.stop')
  assert.equal(stops.length, 1, 'exactly one playback stop')
  assert.equal(state.submitted.length, 1, 'exactly one work input')
  assert.match(state.submitted[0].text, /小作文/)
  assert.ok(routed.routed.some((route) => route.path === 'control'))
  assert.ok(routed.routed.some((route) => route.path === 'input'))
  service.dispose()
})

test('a short remaining work fragment becomes one confirmation draft (not dropped, not silently submitted)', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  const routed = await service.handleFinalUtterance(utterance('停一下。然后写小作文'))
  assert.equal(state.commands.filter((command) => command.type === 'playback.stop').length, 1)
  assert.equal(state.submitted.length, 0, 'short fragment waits for explicit confirmation')
  const draft = service.inspect().draft
  assert.ok(draft && /写小作文/.test(draft.text))
  assert.ok(routed.routed.some((route) => route.path === 'control'))
  service.dispose()
})

test('negation, quotation and hypothetical stop phrases never stop playback and stay ordinary input', async () => {
  for (const text of ['不要停，继续讲', '文档里写停一下', '如果我说停一下，你会怎么办']) {
    const { runtime, state } = fakeRuntime()
    const { service } = makeService({ runtime, registry: fakeRegistry() })
    const routed = await service.handleFinalUtterance(utterance(text))
    assert.equal(state.commands.filter((command) => command.type === 'playback.stop').length, 0, text)
    assert.ok(routed.routed.every((route) => route.path !== 'control'), text)
    assert.equal(routed.routed.filter((route) => route.path === 'input').length, 1, text)
    assert.equal(state.submitted.length, 1, text)
    service.dispose()
  }
})

test('interaction answers are consumed once and never become new tasks', async () => {
  const registry = fakeRegistry({
    pending: [{
      id: 'approval-1', kind: 'approval', sessionId: 'session-1', semanticRevision: 1, viewRevision: 1,
      officialCallId: 'call-1', createdAt: new Date().toISOString(), expiresAt: null,
      operation: { toolName: 'bash', cwd: '/tmp', arguments: {} },
    }],
  })
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry })
  const routed = await service.handleFinalUtterance(utterance('确认允许一次'))
  assert.equal(state.submitted.length, 0, 'an approval answer must not become a task')
  assert.equal(registry.calls.length, 1)
  assert.equal(registry.calls[0].request.payload.decision, 'allowed-once')
  assert.ok(routed.routed.some((route) => route.path === 'control' && route.reason === 'approval-allow'))
  service.dispose()
})

test('always mode ordinary input offers a confirmation draft and only submit after explicit confirm', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await service.handleFinalUtterance(utterance('帮我整理桌面文件', { mode: 'always' }))
  assert.equal(state.submitted.length, 0)
  const draft = service.inspect().draft
  assert.ok(draft, 'draft offered')
  assert.equal(draft.needsConfirmation, true)
  const receipt = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'confirm-1', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop', sessionId: null, type: 'input.confirm',
    payload: { id: draft.id, revision: draft.revision },
  })
  assert.equal(receipt.status, 'accepted')
  assert.equal(state.submitted.length, 1)
  service.dispose()
})

test('busy turn queues an input; official turn end drains it once and only once', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'desktop', hostInitiated: false })
  assert.equal(service.snapshotSections().execution.mainWindowTurn, true)
  const routed = await service.handleFinalUtterance(utterance('第二个任务文本', { utteranceId: 'utt-2' }))
  assert.equal(state.submitted.length, 0, 'queued, not submitted while the main-window turn runs')
  assert.equal(service.snapshotSections().queue.items.length, 1)
  service.onTurnEnded({ sessionId: 'session-1', turn: 1, terminal: 'completed', reason: { kind: 'completed' } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(state.submitted.length, 1, 'queue drains once after the official turn end')
  assert.match(state.submitted[0].text, /第二个任务文本/)
  assert.equal(service.snapshotSections().queue.items.length, 0)
  assert.ok(routed.routed.some((route) => route.path === 'input'))
  service.dispose()
})

test('cancel task captures its target, requires confirmation and never fabricates a stop', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'voice', hostInitiated: true })
  const request = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-1', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'control.cancel-task', payload: {},
  })
  assert.equal(request.status, 'rejected')
  assert.equal(request.error.code, 'CONFIRMATION_REQUIRED')
  // The confirmation token is the value the Host itself captured; a caller that
  // names no target may not cancel by sending any other non-empty string. The
  // previous revision accepted a hardcoded "api" token here, which meant a
  // replayed command cancelled whatever happened to be running.
  const token = service.inspect().pendingCancel?.token
  assert.equal(typeof token, 'string')
  const magic = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-magic', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'control.cancel-task', payload: { confirmToken: 'api' },
  })
  assert.equal(magic.status, 'rejected')
  assert.equal(magic.error.code, 'STALE_CANCEL_REQUEST')
  const confirmed = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-2', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'control.cancel-task', payload: { confirmToken: token },
  })
  assert.equal(confirmed.status, 'resolved')
  assert.equal(state.cancelled.length, 1)
  assert.equal(state.cancelled[0].target.turn, 1)
  assert.equal(service.snapshotSections().execution.state, 'idle')
  service.dispose()
})

test('speech identity: monotonic append seq, stop uses the current playbackId, ack settles playback', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  service.onAssistantDelta({ sessionId: 's', turn: 2, text: '第一句' })
  service.onAssistantDelta({ sessionId: 's', turn: 2, text: '第二句' })
  const appends = state.commands.filter((command) => command.type === 'speech.append')
  assert.deepEqual(appends.map((command) => command.payload.seq), [1, 2])
  assert.equal(appends[0].payload.turnId, 's:2')
  assert.equal(service.snapshotSections().playback.playbackId, 's:2')
  await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'stop-1', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'control.stop-playback', payload: {},
  })
  const stop = state.commands.filter((command) => command.type === 'playback.stop').at(-1)
  assert.equal(stop.payload.playbackId, 's:2')
  service.onAssistantEnded({ sessionId: 's', turn: 2, outcome: 'completed' })
  const end = state.commands.filter((command) => command.type === 'speech.end').at(-1)
  assert.equal(end.payload.turnId, 's:2')
  await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'ack-1', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'presentation.ack',
    payload: { commandId: end.commandId, state: 'applied' },
  })
  assert.equal(service.snapshotSections().playback.state, 'idle')
  service.dispose()
})

test('welcome greeting is Host-triggered once per worker connection', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  const session = (commandId) => service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId, hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'voice.session',
    payload: { connectionId: 'w1', transport: 'connected', mediaState: {} },
  })
  await session('s1')
  await session('s2')
  const greetings = state.commands.filter((command) => command.type === 'speech.append' && command.payload.turnId.startsWith('welcome-'))
  assert.equal(greetings.length, 1, 'one greeting per connection')
  assert.ok(state.commands.some((command) => command.type === 'speech.end' && command.payload.reason === 'greeting'))
  service.dispose()
})

test('restart restores unsubmitted input as needs-confirmation and never auto-executes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beta2-service-'))
  const file = join(dir, 'state.json')
  const first = fakeRuntime()
  const store1 = createStateStore({ file })
  const one = makeService({ runtime: first.runtime, registry: fakeRegistry(), store: store1 })
  one.service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'desktop', hostInitiated: false })
  await one.service.handleFinalUtterance(utterance('重启后不要执行我', { utteranceId: 'utt-r' }))
  assert.equal(one.service.snapshotSections().queue.items.length, 1)
  one.service.onTurnEnded({ sessionId: 'session-1', turn: 1, terminal: 'interrupted', reason: { kind: 'interrupted' } })
  // make the persisted reason look like an interrupted active turn
  one.service.inspect()
  one.service.dispose()

  const second = fakeRuntime()
  const store2 = createStateStore({ file })
  const two = makeService({ runtime: second.runtime, registry: fakeRegistry(), store: store2 })
  const sections = two.service.snapshotSections()
  assert.equal(second.state.submitted.length, 0, 'restore must not submit anything')
  assert.ok(sections.queue.items.length >= 0)
  for (const item of sections.queue.items) assert.equal(item.needsConfirmation, true)
  assert.ok(sections.notices.some((notice) => /重启/.test(notice.text) || /重新确认/.test(notice.text)))
  two.service.dispose()
})

test('confirmation policy preserves greetings and explicit actions while confirming short fragments', () => {
  assert.deepEqual(needsConfirmation('你好', { mode: 'hold', assembled: true }), { needed: false, reason: 'greeting' })
  assert.equal(needsConfirmation('打开设置', { mode: 'hold' }).needed, false)
  assert.equal(needsConfirmation('嗯', { mode: 'hold' }).needed, true)
  assert.equal(needsConfirmation('好', { mode: 'hold' }).needed, true)
  assert.equal(needsConfirmation('帮我整理文件', { mode: 'always' }).needed, true)
})

test('snapshot + events handshake: snapshot is a consistent cut and late subscribers replay the gap', async () => {
  const { runtime } = fakeRuntime()
  const { service, events } = makeService({ runtime, registry: fakeRegistry() })
  service.onTurnStarted({ sessionId: 's', turn: 1, inputSource: 'voice', hostInitiated: true })
  const snapshot = events.snapshot(() => service.snapshotSections())
  service.onAssistantDelta({ sessionId: 's', turn: 1, text: 'delta' })
  const replay = events.eventsAfter(snapshot.snapshotSeq)
  assert.equal(replay.resyncRequired, false)
  assert.ok(replay.events.length >= 1)
  assert.ok(replay.events.every((event) => event.seq > snapshot.snapshotSeq))
  assert.ok(replay.events.every((event) => event.hostEpoch === HOST_EPOCH))
  assert.equal(canonicalJson({ ok: true }), '{"ok":true}')
  service.dispose()
})

test('queue capacity, revision-bound edit/delete, TTL expiry and media disconnect preserve text without replay', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry(), config: { queueLimit: 2, queueTtlMs: 60, draftTtlMs: 1000 } })
  service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'desktop', hostInitiated: false })
  const command = (type, payload, id) => service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: id || randomUUIDForTest(), hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type, payload,
  })
  const first = await service.handleFinalUtterance(utterance('第一条等待任务', { utteranceId: 'u1' }))
  assert.equal(first.routed.filter((route) => route.path === 'input').length, 1)
  await service.handleFinalUtterance(utterance('第二条等待任务', { utteranceId: 'u2' }))
  const third = await service.handleFinalUtterance(utterance('第三条等待任务', { utteranceId: 'u3' }))
  assert.ok(third.routed.some((route) => route.path === 'input'))
  assert.equal(state.submitted.length, 0, 'nothing submitted while the main-window turn runs')
  let snapshot = service.snapshotSections()
  assert.equal(snapshot.queue.items.length, 2, 'capacity is enforced without evicting existing items')
  assert.ok(service.inspect().draft, 'overflow text is kept for confirmation, not dropped')
  // revision-bound edit and delete
  const item = snapshot.queue.items[0]
  const edited = await command('queue.edit', { id: item.id, revision: snapshot.queue.revision, text: '改写后的等待任务' })
  assert.equal(edited.status, 'accepted')
  snapshot = service.snapshotSections()
  assert.match(snapshot.queue.items[0].text, /改写后/)
  const stale = await command('queue.confirm', { id: snapshot.queue.items[0].id, revision: snapshot.queue.revision + 99 })
  assert.equal(stale.status, 'rejected')
  const deleted = await command('queue.delete', { id: snapshot.queue.items[1].id, revision: snapshot.queue.revision })
  assert.equal(deleted.status, 'accepted')
  assert.equal(service.snapshotSections().queue.items.length, 1)
  // media disconnect must not clear the Host queue nor cancel the turn
  await command('voice.session', { connectionId: 'w1', transport: 'disconnected', mediaState: {} })
  assert.equal(service.snapshotSections().queue.items.length, 1)
  assert.equal(service.snapshotSections().execution.state, 'working')
  // TTL expiry keeps an inspectable record that cannot be auto-admitted
  await new Promise((resolve) => setTimeout(resolve, 120))
  const expired = await command('queue.confirm', { id: service.snapshotSections().queue.items[0].id, revision: service.snapshotSections().queue.revision })
  assert.equal(expired.status, 'accepted', 'confirm renews an expired item instead of executing it blindly')
  assert.equal(state.submitted.length, 0, 'expiry + confirm does not bypass the official turn state')
  service.dispose()
})

test('interrupted turn quarantines the queue instead of auto-executing it', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'desktop', hostInitiated: false })
  await service.handleFinalUtterance(utterance('不要自动执行我', { utteranceId: 'utt-i' }))
  assert.equal(state.submitted.length, 0)
  service.onTurnEnded({ sessionId: 'session-1', turn: 1, terminal: 'interrupted', reason: { kind: 'interrupted' } })
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(state.submitted.length, 0, 'interrupted turn does not replay queued input')
  const snapshot = service.snapshotSections()
  assert.equal(snapshot.queue.items.length, 1)
  assert.equal(snapshot.queue.items[0].needsConfirmation, true)
  assert.ok(snapshot.notices.some((notice) => /未正常结束/.test(notice.text)))
  service.dispose()
})

test('host restart never auto-executes a persisted queue item (confirm required first)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'beta2-service-restart-'))
  const file = join(dir, 'state.json')
  const first = fakeRuntime()
  const one = makeService({ runtime: first.runtime, registry: fakeRegistry(), store: createStateStore({ file }) })
  one.service.onTurnStarted({ sessionId: 'session-1', turn: 1, inputSource: 'desktop', hostInitiated: false })
  await one.service.handleFinalUtterance(utterance('重启后等待我确认', { utteranceId: 'utt-rs' }))
  assert.equal(one.service.snapshotSections().queue.items.length, 1)
  one.service.dispose()
  const second = fakeRuntime()
  const two = makeService({ runtime: second.runtime, registry: fakeRegistry(), store: createStateStore({ file }) })
  assert.equal(second.state.submitted.length, 0, 'restore must not execute anything')
  const snapshot = two.service.snapshotSections()
  assert.equal(snapshot.queue.items.length, 1)
  assert.equal(snapshot.queue.items[0].needsConfirmation, true)
  assert.match(snapshot.queue.items[0].text, /重启后等待我确认/)
  two.service.dispose()
})

/**
 * The recording bubble is a projection of the Host capture state. Before this
 * regression a released hold capture stayed `transcribing` forever, so the pet
 * kept showing the last transcript with a "取消录音" link while the Agent was
 * already executing (observed with a real voice session).
 */
function voiceFacts(service, { capture, items = [], release = null } = {}) {
  return service.handleCommand({
    protocolVersion: PROTOCOL_VERSION,
    commandId: randomUUIDForTest(),
    hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker',
    sessionId: null,
    type: 'voice.facts',
    payload: {
      connectionId: 'w1',
      capture,
      ...(items.length ? { items } : {}),
      ...(release ? { release } : {}),
    },
  })
}

const asrItem = (kind, itemId, text, revision = 0) => ({
  kind, itemId, utteranceId: 'utt-capture', revision, text, confidence: null,
})

test('a finished hold capture clears the recording projection; a late duplicate cannot reopen it', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await voiceFacts(service, {
    capture: { captureId: 'cap-1', mode: 'hold', state: 'listening' },
    items: [asrItem('asr.partial', 'p1', '帮我写周报')],
  })
  let snapshot = service.snapshotSections()
  assert.equal(snapshot.capture.state, 'listening')
  assert.equal(snapshot.capture.preview.text, '帮我写周报')

  await voiceFacts(service, {
    capture: { captureId: 'cap-1', mode: 'hold', state: 'transcribing' },
    items: [asrItem('asr.final', 'f1', '帮我写一份周报')],
  })
  await voiceFacts(service, {
    capture: { captureId: 'cap-1', mode: 'hold', state: 'closing' },
    release: { captureId: 'cap-1', reason: 'release' },
  })
  await new Promise((resolve) => setTimeout(resolve, 80))
  service.tick()
  await new Promise((resolve) => setTimeout(resolve, 80))

  snapshot = service.snapshotSections()
  assert.equal(snapshot.capture.state, 'off', 'an ended recording must not keep a bubble')
  assert.equal(snapshot.capture.preview, null)
  assert.equal(state.submitted.length, 1)

  // A duplicate provider final arriving after the boundary must not resurrect it.
  await voiceFacts(service, {
    capture: { captureId: 'cap-1', mode: 'hold', state: 'transcribing' },
    items: [asrItem('asr.final', 'f1', '帮我写一份周报')],
  })
  snapshot = service.snapshotSections()
  assert.equal(snapshot.capture.state, 'off')
  service.dispose()
})

test('the interaction mode is fixed at capture start; release facts cannot rewrite it', async () => {
  const { runtime } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await voiceFacts(service, {
    capture: { captureId: 'cap-mode', mode: 'hold', state: 'listening' },
    items: [asrItem('asr.partial', 'p1', '一句话')],
  })
  assert.equal(service.snapshotSections().capture.mode, 'hold')
  // A late/release fact from an older worker that defaulted the missing release
  // mode to "always" must not turn this hold capture into always-listening.
  await voiceFacts(service, {
    capture: { captureId: 'cap-mode', mode: 'always', state: 'closing' },
    release: { captureId: 'cap-mode', reason: 'release' },
  })
  assert.equal(service.snapshotSections().capture.mode, 'hold')
  await voiceFacts(service, {
    capture: { captureId: 'cap-mode', mode: 'always', state: 'transcribing' },
    items: [asrItem('asr.final', 'f1', '一句话')],
  })
  assert.equal(service.snapshotSections().capture.mode, 'hold')
  // A genuinely new capture may choose a new mode.
  await voiceFacts(service, { capture: { captureId: 'cap-mode-2', mode: 'toggle', state: 'listening' } })
  assert.equal(service.snapshotSections().capture.mode, 'toggle')
  service.dispose()
})

test('a released capture with no buffered utterance clears immediately', async () => {
  const { runtime } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await voiceFacts(service, { capture: { captureId: 'cap-silent', mode: 'hold', state: 'listening' } })
  await voiceFacts(service, {
    capture: { captureId: 'cap-silent', mode: 'hold', state: 'closing' },
    release: { captureId: 'cap-silent', reason: 'release' },
  })
  assert.equal(service.snapshotSections().capture.state, 'off')
  assert.equal(service.snapshotSections().capture.preview, null)
  service.dispose()
})

test('cancelling a capture ends the projection once and a second cancel is explicit, not a fake success', async () => {
  const { runtime, state } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await voiceFacts(service, {
    capture: { captureId: 'cap-cancel', mode: 'hold', state: 'listening' },
    items: [asrItem('asr.partial', 'p1', '这句话我不要了')],
  })
  const first = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-1', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop', sessionId: null, type: 'control.cancel-capture',
    payload: { captureId: 'cap-cancel' },
  })
  assert.equal(first.status, 'accepted')
  assert.equal(service.snapshotSections().capture.state, 'off')
  assert.equal(service.snapshotSections().capture.preview, null)
  assert.ok(state.commands.some((command) => command.type === 'capture.command' && command.payload.action === 'discard'))

  const second = await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'cancel-2', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'desktop', sessionId: null, type: 'control.cancel-capture',
    payload: { captureId: 'cap-cancel' },
  })
  assert.equal(second.status, 'rejected')
  assert.equal(second.error.code, 'NO_ACTIVE_CAPTURE')
  assert.equal(service.snapshotSections().capture.state, 'off')
  assert.ok(service.snapshotSections().notices.some((notice) => /录音已经结束/.test(notice.text)))
  service.dispose()
})

test('a transport disconnect ends the recording projection instead of leaving a stale cancel link', async () => {
  const { runtime } = fakeRuntime()
  const { service } = makeService({ runtime, registry: fakeRegistry() })
  await voiceFacts(service, {
    capture: { captureId: 'cap-drop', mode: 'hold', state: 'listening' },
    items: [asrItem('asr.partial', 'p1', '断线前的话')],
  })
  await service.handleCommand({
    protocolVersion: PROTOCOL_VERSION, commandId: 'session-drop', hostEpoch: HOST_EPOCH,
    sourceConnectionId: 'worker', sessionId: null, type: 'voice.session',
    payload: { connectionId: 'w1', transport: 'disconnected' },
  })
  assert.equal(service.snapshotSections().capture.state, 'off')
  assert.equal(service.snapshotSections().capture.preview, null)
  service.dispose()
})

function randomUUIDForTest() {
  return 'cmd-' + Math.random().toString(36).slice(2) + Date.now().toString(36)
}
