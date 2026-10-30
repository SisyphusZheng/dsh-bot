/**
 * beta2 kernel §3.6 / plan §11 gates B2-G05, B2-G06, B2-G07, B2-G08 (models half).
 *
 * Queue: capacity/TTL/revision CAS/edit/delete/confirm/restore/quarantine/restart.
 * Draft: single active draft, single-use confirm, exact revision, TTL.
 * Turn:  official lifecycle projection, main-window turns, cancel target capture,
 *        cancel-requested -> unknown, late confirmations never hit a successor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createQueueModel,
  createDraftModel,
  createTurnModel,
  QUEUE_LIMIT_DEFAULT,
  QUEUE_TTL_MS_DEFAULT,
  DRAFT_TTL_MS_DEFAULT,
} from '../lib/conversation-model.mjs'

function fakeClock(start = 0) {
  let value = start
  return {
    now: () => value,
    set(next) { value = next; return value },
    advance(ms) { value += ms; return value },
  }
}

function rng(seed) {
  let state = seed >>> 0 || 1
  return () => {
    state ^= state << 13; state >>>= 0
    state ^= state >>> 17
    state ^= state << 5; state >>>= 0
    return state / 0xffffffff
  }
}

/* ------------------------------------------------------------------------- */
/* Input queue / B2-G06                                                      */
/* ------------------------------------------------------------------------- */

test('queue snapshot exposes identity, position, wait time and confirmation state', () => {
  const clock = fakeClock(1000)
  const queue = createQueueModel({ now: clock.now })
  const first = queue.add({ id: 'input-1', text: '打开浏览器', source: 'voice' })
  assert.equal(QUEUE_LIMIT_DEFAULT, 5)
  assert.equal(QUEUE_TTL_MS_DEFAULT, 60000)
  assert.equal(first.id, 'input-1')
  assert.equal(first.position, 1)
  clock.set(4000)
  queue.add({ text: '写报告', source: 'desktop' })
  const snapshot = queue.snapshot()
  assert.equal(snapshot.revision, 2)
  assert.equal(snapshot.items.length, 2)
  assert.deepEqual(
    snapshot.items.map((item) => ({ id: item.id, position: item.position, waitedSeconds: item.waitedSeconds, status: item.status })),
    [
      { id: 'input-1', position: 1, waitedSeconds: 3, status: 'waiting' },
      { id: snapshot.items[1].id, position: 2, waitedSeconds: 0, status: 'waiting' },
    ],
  )
  assert.equal(queue.revision(), 2)
  // Timestamps are epoch ms numbers that ConversationService converts to ISO.
  assert.equal(typeof snapshot.items[0].createdAt, 'number')
  assert.equal(typeof snapshot.items[0].expiresAt, 'number')
})

test('queue deduplicates identity, never user-visible text', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'id-1', text: '再打开一次浏览器' })
  assert.throws(() => queue.add({ id: 'id-1', text: '再打开一次浏览器' }), /已在等待队列/)
  // A user repeating the same sentence is a new request with a new identity.
  queue.add({ id: 'id-2', text: '再打开一次浏览器' })
  assert.equal(queue.snapshot().items.length, 2)
  assert.throws(() => queue.add({ id: 'id-1', text: 'different text' }), /已在等待队列/)
})

test('queue overflow rejects new admission with a user-facing message, never evicting', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now, limit: 2 })
  queue.add({ id: 'a', text: '第一条' })
  queue.add({ id: 'b', text: '第二条' })
  const revisionBefore = queue.revision()
  assert.throws(() => queue.add({ id: 'c', text: '第三条' }), (error) => {
    assert.equal(error.code, 'QUEUE_FULL')
    assert.match(error.message, /等待队列已满/)
    return true
  })
  assert.deepEqual(queue.snapshot().items.map((item) => item.id), ['a', 'b'])
  assert.equal(queue.revision(), revisionBefore)
})

test('queue edit/delete/confirm are CAS-bound to revision and item identity', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  const item = queue.add({ id: 'a', text: '错误输入', needsConfirmation: true })
  const revision = queue.revision()
  assert.equal(queue.take(), null)
  assert.throws(() => queue.edit('a', revision - 1, 'edit', '新指令'), /队列已变化/)
  assert.throws(() => queue.edit('missing', revision, 'edit', '新指令'), /已被接收或删除/)
  assert.throws(() => queue.edit('a', revision, 'explode'), /不支持的队列操作/)
  const edited = queue.edit('a', revision, 'edit', '整理报告')
  assert.equal(edited.item.text, '整理报告')
  assert.equal(edited.item.needsConfirmation, false)
  assert.throws(() => queue.edit('a', revision, 'delete'), /队列已变化/)
  assert.equal(queue.take().text, '整理报告')
  assert.throws(() => queue.edit('a', queue.revision(), 'confirm'), /已经提交，不能从等待队列中取消/)
  assert.equal(item.id, 'a')
})

test('B2-G06: queue TTL expiry keeps an inspectable record that requires re-confirmation', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now, ttlMs: 1000 })
  queue.add({ id: 'old', text: '旧指令' })
  queue.add({ id: 'new', text: '第二条' })
  clock.set(1001)
  const snapshot = queue.snapshot()
  assert.equal(snapshot.items[0].needsConfirmation, true)
  assert.equal(snapshot.items[0].status, 'confirming')
  assert.equal(snapshot.items.length, 2, 'expired inputs stay inspectable, never dropped')
  assert.equal(queue.take(), null, 'expired head blocks strict FIFO, it is not silently skipped')
  // Explicit re-confirmation makes the preserved item runnable again, in order.
  queue.edit('old', queue.revision(), 'confirm')
  assert.equal(queue.take().id, 'old')
  clock.set(1002)
  assert.equal(queue.take(), null, 'the second item is also expired; no auto-execution')
})

test('queue take only returns unconfirmed and unexpired items, strictly in FIFO order', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'a', text: '第一条' })
  queue.add({ id: 'b', text: '第二条', needsConfirmation: true })
  assert.equal(queue.take().id, 'a')
  assert.equal(queue.take(), null) // b needs confirmation and blocks the line
  queue.edit('b', queue.revision(), 'confirm')
  assert.equal(queue.take().id, 'b')
  assert.equal(queue.take(), null)
})

test('B2-G06: an item already submitted to DSH cannot be cancelled by a queue delete', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'submitted', text: '正在执行的工作', metadata: { captureId: 'c1', utteranceId: 'u1' } })
  const taken = queue.take()
  assert.equal(taken.id, 'submitted')
  assert.equal(taken.status, 'submitting')
  assert.deepEqual(taken.metadata, { captureId: 'c1', utteranceId: 'u1' })
  assert.equal(queue.snapshot().items.length, 0)
  assert.throws(() => queue.edit('submitted', queue.revision(), 'delete'), (error) => {
    assert.equal(error.code, 'ITEM_ALREADY_SUBMITTED')
    assert.match(error.message, /已经提交/)
    return true
  })
  assert.equal(queue.isSubmitted('submitted'), true)
  assert.equal(queue.take(), null, 'the submitted item is never replayed')
})

test('queue restore keeps the exact identity and original wait timestamps', () => {
  const clock = fakeClock(500)
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'race', text: '准入竞争的工作', metadata: { captureId: 'c1' } })
  clock.set(9000)
  const taken = queue.take()
  const restored = queue.restore(taken)
  assert.equal(restored.id, 'race')
  assert.equal(restored.position, 1)
  assert.equal(restored.createdAt, 500)
  assert.equal(restored.expiresAt, 60500)
  assert.equal(restored.needsConfirmation, false)
  assert.equal(queue.take().id, 'race')
  // Restore after a failed admission must not be blocked by a temporarily full queue.
  queue.add({ id: 'r2', text: '第二项' })
  const takenAgain = queue.take()
  queue.add({ id: 'filler', text: '占位' })
  assert.equal(queue.restore(takenAgain).id, 'r2')
  assert.equal(queue.snapshot().items.length, 2, 'restored admitted text is preserved even at capacity')
})

test('queue quarantine keeps every text but disables automatic submission', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'a', text: '待执行' })
  queue.add({ id: 'b', text: '第二条' })
  const result = queue.quarantineAll('session-changed')
  assert.equal(result.quarantined, 2)
  assert.equal(queue.take(), null)
  assert.deepEqual(queue.snapshot().items.map((item) => item.text), ['待执行', '第二条'])
  assert.equal(queue.snapshot().items.every((item) => item.needsConfirmation), true)
  assert.equal(queue.snapshot().lastQuarantineReason, 'session-changed')
})

test('B2-G08: restart restores persisted queue items as needs-confirmation only', () => {
  const clock = fakeClock(10000)
  const queue = createQueueModel({ now: clock.now })
  const result = queue.restoreFromPersisted([
    { id: 'persisted-1', text: '重启前的第一项', source: 'voice', createdAt: 1000, expiresAt: 61000 },
    { id: 'persisted-2', text: '重启前的第二项', source: 'desktop', createdAt: '1970-01-01T00:00:20.000Z', expiresAt: '1970-01-01T00:02:20.000Z' },
  ])
  assert.equal(result.restored, 2)
  const snapshot = queue.snapshot()
  assert.deepEqual(snapshot.items.map((item) => item.id), ['persisted-1', 'persisted-2'])
  assert.equal(snapshot.items.every((item) => item.needsConfirmation === true), true)
  assert.equal(queue.take(), null, 'restored work never auto-executes')
  assert.throws(() => queue.restoreFromPersisted([{ id: 'x' }]), /text|有效内容/)
  assert.throws(() => queue.restoreFromPersisted([{ id: 'a', text: 'x' }, { id: 'a', text: 'y' }]), /duplicate/)
})

test('queue validates tunables and inputs explicitly', () => {
  assert.throws(() => createQueueModel({ limit: 0 }), /limit/)
  assert.throws(() => createQueueModel({ limit: 21 }), /limit/)
  assert.throws(() => createQueueModel({ ttlMs: 0 }), /ttlMs/)
  assert.throws(() => createQueueModel({ now: 'soon' }), /now/)
  const queue = createQueueModel({ now: () => 0 })
  assert.throws(() => queue.add({ text: '   ' }), /有效内容/)
  assert.throws(() => queue.add({ text: 'x'.repeat(20001) }), /20000/)
  assert.throws(() => queue.add({ text: 'ok', source: 'telepathy' }), /voice, desktop/)
})

test('randomized queue sequences never lose admitted text, never double-take', () => {
  const clock = fakeClock()
  const random = rng(0x51a7)
  const queue = createQueueModel({ now: clock.now, limit: 4, ttlMs: 5000 })
  const admitted = new Set()
  const taken = new Set()
  const deleted = new Set()
  let counter = 0
  let lastRevision = -1

  const takeOnce = () => {
    const item = queue.take()
    if (item) {
      assert.equal(taken.has(item.id), false, 'an item is taken at most once without an explicit restore')
      taken.add(item.id)
    }
    return item
  }

  for (let step = 0; step < 600; step += 1) {
    const action = Math.floor(random() * 7)
    const snapshot = queue.snapshot()
    assert.ok(queue.revision() >= lastRevision, 'queue revision is monotonic')
    lastRevision = queue.revision()
    const ids = snapshot.items.map((item) => item.id)
    assert.equal(new Set(ids).size, ids.length, 'no duplicate item identity')
    assert.deepEqual(snapshot.items.map((item) => item.position), ids.map((_, index) => index + 1))

    if (action === 0) {
      const id = `in-${counter += 1}`
      try {
        queue.add({ id, text: `工作 ${id}` })
        admitted.add(id)
      } catch (error) {
        assert.equal(error.code, 'QUEUE_FULL')
      }
    } else if (action === 1 && ids.length > 0) {
      const id = ids[Math.floor(random() * ids.length)]
      const revision = queue.revision()
      try {
        if (random() < 0.5) queue.edit(id, revision, 'edit', `改过的 ${id}`)
        else queue.edit(id, revision, 'confirm')
      } catch (error) {
        assert.ok(['STALE_QUEUE_REVISION', 'UNKNOWN_QUEUE_ITEM', 'ITEM_ALREADY_SUBMITTED'].includes(error.code))
      }
    } else if (action === 2 && ids.length > 0) {
      const id = ids[Math.floor(random() * ids.length)]
      try {
        queue.edit(id, queue.revision(), 'delete')
        deleted.add(id)
      } catch (error) {
        assert.equal(error.code, 'STALE_QUEUE_REVISION')
      }
    } else if (action === 3) {
      const item = takeOnce()
      if (item) {
        assert.equal(item.needsConfirmation, false)
        assert.equal(clock.now() >= item.expiresAt, false)
        if (random() < 0.5) {
          taken.delete(item.id)
          queue.restore(item)
        }
      }
    } else if (action === 4) {
      queue.quarantineAll('random')
    } else if (action === 5) {
      clock.advance(200 + Math.floor(random() * 800))
    } else {
      // Confirm whatever wake-up happens after a TTL bump.
      for (const item of queue.snapshot().items) {
        if (item.needsConfirmation) {
          try { queue.edit(item.id, queue.revision(), 'confirm') } catch (error) { assert.equal(error.code, 'STALE_QUEUE_REVISION') }
        }
      }
    }

    // Invariant: every admitted id is in exactly one of {queue, taken, deleted}.
    const present = new Set(queue.snapshot().items.map((item) => item.id))
    for (const id of admitted) {
      const places = Number(present.has(id)) + Number(taken.has(id)) + Number(deleted.has(id))
      assert.equal(places, 1, `admitted ${id} must be in exactly one state, found ${places}`)
    }
  }
})

/* ------------------------------------------------------------------------- */
/* Input draft / B2-G05                                                      */
/* ------------------------------------------------------------------------- */

test('draft offer requires confirmation and returns the full draft object', () => {
  const clock = fakeClock(100)
  const draft = createDraftModel({ now: clock.now })
  assert.equal(DRAFT_TTL_MS_DEFAULT, 30000)
  assert.equal(draft.snapshot(), null)
  const offered = draft.offer({ text: '写小作文', source: 'voice', captureId: 'c1', metadata: { utteranceId: 'u1', itemId: 'i1' } })
  assert.equal(typeof offered.id, 'string')
  assert.equal(offered.revision, 1)
  assert.equal(offered.status, 'pending')
  assert.equal(offered.needsConfirmation, true)
  assert.equal(offered.captureId, 'c1')
  assert.deepEqual(offered.metadata, { utteranceId: 'u1', itemId: 'i1' })
  assert.equal(typeof offered.createdAt, 'number')
  assert.equal(offered.expiresAt, 30100)
  const snapshot = draft.snapshot()
  assert.equal(snapshot.text, '写小作文')
  assert.equal(snapshot.status, 'pending')
})

test('draft confirm is single-use and bound to the exact revision', () => {
  const clock = fakeClock()
  const draft = createDraftModel({ now: clock.now })
  const offered = draft.offer({ text: '写一段介绍' })
  assert.throws(() => draft.confirm(offered.id, offered.revision + 1), /输入已变化/)
  const confirmed = draft.confirm(offered.id, offered.revision)
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.item.text, '写一段介绍')
  assert.equal(confirmed.item.id, offered.id)
  assert.throws(() => draft.confirm(offered.id, offered.revision), /已确认或已失效/)
  assert.throws(() => draft.reject(offered.id, offered.revision), /已确认或已失效/)
  assert.equal(draft.snapshot().status, 'confirmed')
})

test('draft edit bumps the revision and renews the confirmation window', () => {
  const clock = fakeClock()
  const draft = createDraftModel({ now: clock.now, ttlMs: 1000 })
  const offered = draft.offer({ text: '错的' })
  clock.set(400)
  const edited = draft.edit(offered.id, offered.revision, '改好的')
  assert.equal(edited.text, '改好的')
  assert.equal(edited.revision, 2)
  assert.equal(edited.status, 'editing')
  assert.equal(edited.expiresAt, 1400)
  assert.throws(() => draft.confirm(offered.id, 1), /输入已变化/)
  const confirmed = draft.confirm(offered.id, 2, '最终文本')
  assert.equal(confirmed.item.text, '最终文本')
})

test('draft reject and clear never execute anything', () => {
  const clock = fakeClock()
  const draft = createDraftModel({ now: clock.now })
  const first = draft.offer({ text: '不要执行' })
  const rejected = draft.reject(first.id, first.revision)
  assert.equal(rejected.ok, true)
  assert.equal(draft.snapshot().status, 'rejected')
  assert.throws(() => draft.confirm(first.id, first.revision), /已确认或已失效/)
  assert.equal(draft.clear(), true)
  assert.equal(draft.snapshot(), null)
  assert.deepEqual(draft.history().map((record) => record.status), ['rejected'])
})

test('draft TTL expires inspectable and requires a new draft', () => {
  const clock = fakeClock()
  const draft = createDraftModel({ now: clock.now, ttlMs: 1000 })
  const offered = draft.offer({ text: '过期前' })
  clock.set(1000)
  assert.equal(draft.snapshot().status, 'expired')
  assert.throws(() => draft.confirm(offered.id, offered.revision), /已过期/)
  assert.deepEqual(draft.expire(), [])
  clock.set(2000)
  const next = draft.offer({ text: '新输入' })
  assert.notEqual(next.id, offered.id)
  assert.equal(draft.snapshot().text, '新输入')
  assert.ok(draft.history().some((record) => record.id === offered.id && record.status === 'expired'))
})

test('a second offer cannot silently replace a fresh pending draft', () => {
  const clock = fakeClock()
  const draft = createDraftModel({ now: clock.now })
  const offered = draft.offer({ text: '第一条' })
  assert.throws(() => draft.offer({ text: '第二条' }), (error) => {
    assert.equal(error.code, 'DRAFT_PENDING')
    return true
  })
  assert.equal(draft.snapshot().id, offered.id)
  assert.equal(draft.snapshot().text, '第一条')
})

test('draft accepts the internal queue origin used by admission rollback', () => {
  const draft = createDraftModel({ now: () => 0 })
  const offered = draft.offer({ text: '准入失败后保留的输入', source: 'queue', metadata: { reason: 'admission-failed' } })
  assert.equal(offered.source, 'queue')
  assert.deepEqual(offered.metadata, { reason: 'admission-failed' })
  assert.throws(() => draft.offer({ text: 'bad', source: 'telepathy' }), /voice, desktop, queue/)
})

test('draft deterministic sequence keeps one active draft and single resolution', () => {
  const clock = fakeClock()
  const random = rng(0xd4af7)
  const draft = createDraftModel({ now: clock.now, ttlMs: 5000 })
  let live = null
  for (let step = 0; step < 300; step += 1) {
    const action = Math.floor(random() * 5)
    if (action === 0) {
      if (!live) {
        const offered = draft.offer({ text: `输入 ${step}` })
        live = { id: offered.id, revision: offered.revision }
      }
    } else if (action === 1 && live) {
      try {
        draft.confirm(live.id, live.revision)
        live = null
      } catch (error) {
        assert.ok(['STALE_DRAFT_REVISION', 'DRAFT_EXPIRED'].includes(error.code))
      }
    } else if (action === 2 && live) {
      try {
        const edited = draft.edit(live.id, live.revision, `编辑 ${step}`)
        live.revision = edited.revision
      } catch (error) {
        assert.equal(error.code, 'DRAFT_EXPIRED')
        live = null
      }
    } else if (action === 3 && live) {
      try {
        draft.reject(live.id, live.revision)
      } catch (error) {
        assert.equal(error.code, 'DRAFT_EXPIRED')
      }
      live = null
    } else {
      clock.advance(500 + Math.floor(random() * 1500))
      const snapshot = draft.snapshot()
      if (snapshot && snapshot.status !== 'pending' && snapshot.status !== 'editing') live = null
    }
    const snapshot = draft.snapshot()
    if (live && snapshot) {
      assert.equal(snapshot.id, live.id)
      assert.ok(['pending', 'editing', 'expired', 'confirmed', 'rejected'].includes(snapshot.status))
    }
  }
})

/* ------------------------------------------------------------------------- */
/* Turn model / B2-G07, B2-G08                                               */
/* ------------------------------------------------------------------------- */

test('turn starts idle with a complete lastTurn shape', () => {
  const turn = createTurnModel({ now: () => 0 })
  const snapshot = turn.snapshot()
  assert.equal(snapshot.state, 'idle')
  assert.equal(snapshot.turn, null)
  assert.equal(snapshot.cancelTarget, null)
  assert.deepEqual(snapshot.lastTurn, { turn: null, terminal: null, reason: null })
  assert.equal(turn.isBusy(), false)
  assert.equal(turn.isMainWindowTurn(), false)
})

test('host admission: submitting -> working -> official idle', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  assert.equal(turn.beginAdmission({ sessionId: 'session-1', clientTurnId: 'client-1', inputSource: 'voice', text: '请整理报告' }).state, 'submitting')
  assert.equal(turn.isBusy(), true)
  assert.throws(() => turn.beginAdmission({ inputSource: 'desktop' }), (error) => {
    assert.equal(error.code, 'TURN_BUSY')
    assert.match(error.message, /尚未结束/)
    return true
  })
  assert.equal(turn.admitted({ turn: 4 }).state, 'working')
  assert.equal(turn.snapshot().turn, 4)
  // A non-official end never fakes completion.
  turn.observeTurnEnd({ turn: 4, terminal: 'cancelled', official: false })
  assert.equal(turn.snapshot().state, 'working')
  const settled = turn.observeTurnEnd({ turn: 4, terminal: 'completed', reason: { kind: 'completed' } })
  assert.equal(settled.state, 'idle')
  assert.equal(settled.lastTurn.turn, 4)
  assert.equal(settled.lastTurn.terminal, 'completed')
})

test('a main-window turn observed from idle pauses the queue consumer', () => {
  const turn = createTurnModel({ now: () => 0 })
  const observing = turn.observeTurnStart({ turnId: 's:7', turn: 7, inputSource: 'desktop' })
  assert.equal(observing.state, 'working')
  assert.equal(observing.mainWindow, true)
  assert.equal(turn.isMainWindowTurn(), true)
  assert.equal(turn.isBusy(), true)
  const settled = turn.observeTurnEnd({ turnId: 's:7', turn: 7, terminal: 'completed' })
  assert.equal(settled.state, 'idle')
  assert.equal(turn.isMainWindowTurn(), false)
})

test('a main-window turn that races the host admission is surfaced as a conflict', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.beginAdmission({ sessionId: 's', clientTurnId: 'client-2', inputSource: 'voice' })
  const raced = turn.observeTurnStart({ turn: 9, inputSource: 'desktop' })
  assert.equal(raced.state, 'working')
  assert.equal(raced.mainWindow, true)
  assert.equal(raced.conflict, 'main-window-race')
  assert.equal(turn.isMainWindowTurn(), true)
})

test('a late turn-end for an older turn never settles the successor', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'desktop' })
  turn.admitted({ turn: 1 })
  turn.observeTurnEnd({ turn: 1, terminal: 'completed' })
  assert.equal(turn.snapshot().state, 'idle')
  // Main window starts turn 2 (not admitted by Host).
  turn.observeTurnStart({ turn: 2, inputSource: 'desktop' })
  const stale = turn.observeTurnEnd({ turn: 1, terminal: 'completed' })
  assert.equal(stale.state, 'working')
  assert.equal(stale.turn, 2)
  assert.equal(turn.snapshot().lastTurn.turn, 1, 'lastTurn still refers to the settled turn')
})

test('B2-G07: cancel captures the target and only official confirmation settles it', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  turn.beginAdmission({ sessionId: 's', clientTurnId: 'c', inputSource: 'queue', text: '长任务' })
  turn.admitted({ turn: 3 })
  const requested = turn.requestCancel({ target: { turn: 3, requestId: 'req-1', queueItemId: 'input-9' } })
  assert.equal(requested.state, 'cancel-requested')
  assert.equal(requested.cancelTarget.turn, 3)
  assert.equal(requested.cancelTarget.requestId, 'req-1')
  assert.equal(requested.cancelTarget.queueItemId, 'input-9')
  assert.equal(requested.cancelTarget.capturedAt, 0)
  // A local timeout is not a confirmed stop.
  assert.equal(turn.cancelExpired({ expireMs: 30000 }), false)
  clock.set(4000)
  assert.equal(turn.cancelExpired({ expireMs: 30000 }), false)
  const confirmed = turn.cancelConfirmed()
  assert.equal(confirmed.state, 'idle')
  assert.equal(confirmed.lastTurn.terminal, 'cancelled')
  assert.equal(confirmed.lastCancel.confirmed, true)
})

test('B2-G07: unconfirmed cancel becomes unknown, never a claimed success', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'voice' })
  turn.admitted({ turn: 5 })
  turn.requestCancel({ target: { turn: 5 } })
  clock.set(30000)
  assert.equal(turn.cancelExpired({ expireMs: 30000 }), true)
  const snapshot = turn.snapshot()
  assert.equal(snapshot.state, 'unknown')
  assert.equal(turn.isBusy(), true)
  assert.equal(snapshot.cancelTarget.turn, 5, 'cancel source and target are retained')
  assert.equal(snapshot.lastError.code, 'CANCEL_UNCONFIRMED')
  // A late official confirmation converges to idle (official result wins) ...
  const recovered = turn.cancelConfirmed()
  assert.equal(recovered.state, 'idle')
  assert.equal(recovered.lastTurn.terminal, 'cancelled')
})

test('B2-G07: late cancel confirmation cannot hit a successor turn', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  turn.beginAdmission({ clientTurnId: 'c1', inputSource: 'voice' })
  turn.admitted({ turn: 1 })
  turn.requestCancel({ target: { turn: 1 } })
  turn.observeTurnEnd({ turn: 1, terminal: 'cancelled' })
  assert.equal(turn.snapshot().state, 'idle')
  // A successor starts (e.g. main window), then the old confirmation arrives late.
  turn.observeTurnStart({ turn: 2, inputSource: 'desktop' })
  const late = turn.cancelConfirmed()
  assert.equal(late.state, 'working')
  assert.equal(late.turn, 2, 'successor turn untouched')
  assert.equal(turn.isMainWindowTurn(), true)
  // The successor can only finish through its own official end.
  const settled = turn.observeTurnEnd({ turn: 2, terminal: 'completed' })
  assert.equal(settled.state, 'idle')
  assert.equal(settled.lastTurn.turn, 2)
  assert.equal(settled.lastTurn.terminal, 'completed')
})

test('B2-G07: a successor start during cancel-requested supersedes the stale target', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'voice' })
  turn.admitted({ turn: 10 })
  turn.requestCancel({ target: { turn: 10 } })
  const superseded = turn.observeTurnStart({ turn: 11, inputSource: 'desktop' })
  assert.equal(superseded.state, 'working')
  assert.equal(superseded.turn, 11)
  assert.equal(superseded.lastTurn.turn, 10)
  assert.equal(superseded.lastTurn.terminal, 'unknown')
  assert.equal(superseded.conflict, 'cancel-superseded')
  const staleConfirm = turn.cancelConfirmed()
  assert.equal(staleConfirm.state, 'working')
  assert.equal(turn.snapshot().turn, 11)
})

test('B2-G08: unknown turn state is inspectable and recovers only from official evidence', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'voice', text: '可能已提交' })
  const unknown = turn.markUnknown({ code: 'RECEIPT_LOST', message: '回执丢失，结果未知。' })
  assert.equal(unknown.state, 'unknown')
  assert.equal(turn.isBusy(), true)
  assert.equal(unknown.lastError.code, 'RECEIPT_LOST')
  // A late official end for the unconfirmed turn settles it.
  const settled = turn.observeTurnEnd({ turn: 1, terminal: 'completed' })
  assert.equal(settled.state, 'idle')
  assert.equal(settled.lastTurn.turn, 1)
})

test('B2-G08: markUnknown is allowed from a fresh idle model after host restart', () => {
  const turn = createTurnModel({ now: () => 0 })
  assert.equal(turn.snapshot().state, 'idle')
  const unknown = turn.markUnknown('host-restart')
  assert.equal(unknown.state, 'unknown')
  assert.equal(turn.isBusy(), true, 'queue draining stays paused until official evidence')
  assert.equal(unknown.lastError.code, 'UNKNOWN')
  assert.equal(turn.reset().state, 'idle')
})

test('turn restart sync never assumes idle before official status', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.adoptOfficialSnapshot({ status: 'working', session: 's', currentTurn: 6 })
  const snapshot = turn.snapshot()
  assert.equal(snapshot.state, 'working')
  assert.equal(snapshot.turn, 6)
  assert.equal(snapshot.inputSource, 'recovery')
  assert.equal(snapshot.mainWindow, true)
  turn.adoptOfficialSnapshot({ status: 'idle' })
  assert.equal(turn.snapshot().state, 'working', 'idle input cannot roll a working turn backwards')
  turn.observeTurnEnd({ turn: 6, terminal: 'completed' })
  assert.equal(turn.snapshot().state, 'idle')
  assert.equal(turn.adoptOfficialSnapshot({ status: 'idle' }).state, 'idle')
})

test('B2-G06/B2-G07: a submitted queue item is never cancelled by queue deletion', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  const turn = createTurnModel({ now: clock.now })
  const item = queue.add({ id: 'q-item', text: '长任务指令', metadata: { captureId: 'c1' } })
  const taken = queue.take()
  turn.beginAdmission({ sessionId: 's', clientTurnId: 'client-1', inputSource: 'queue', text: taken.text })
  turn.admitted({ turn: 1 })
  // Removing the waiting input cannot cancel the submitted work.
  assert.throws(() => queue.edit(item.id, queue.revision(), 'delete'), /已经提交/)
  // Cancel requests capture the submitted identity; queue deletion still cannot touch it.
  const requested = turn.requestCancel({ target: { turn: 1, queueItemId: item.id } })
  assert.equal(requested.cancelTarget.queueItemId, item.id)
  assert.throws(() => queue.edit(item.id, queue.revision(), 'delete'), /已经提交/)
  turn.observeTurnEnd({ turn: 1, terminal: 'cancelled' })
  assert.equal(turn.snapshot().state, 'idle')
})

test('turn validates tunables explicitly', () => {
  assert.throws(() => createTurnModel({ now: null }), /now/)
  const turn = createTurnModel({ now: () => 0 })
  assert.throws(() => turn.cancelExpired({ expireMs: -1 }), /expireMs/)
})

test('randomized turn sequences keep cancel/target/successor invariants', () => {
  const clock = fakeClock()
  const random = rng(0x7a3b)
  const turn = createTurnModel({ now: clock.now })
  let officialTurn = 0
  let officialWorking = false
  let lastOfficialTurn = 0

  const officialStart = () => {
    officialTurn += 1
    officialWorking = true
    lastOfficialTurn = officialTurn
    return officialTurn
  }

  for (let step = 0; step < 500; step += 1) {
    const action = Math.floor(random() * 8)
    if (action === 0 && !turn.isBusy() && !officialWorking) {
      turn.beginAdmission({ sessionId: 's', clientTurnId: `c${step}`, inputSource: 'voice' })
    } else if (action === 1 && turn.snapshot().state === 'submitting' && !officialWorking) {
      const number = officialStart()
      turn.admitted({ turn: number })
    } else if (action === 2) {
      // A main-window turn starts outside the host admission.
      if (officialWorking && !turn.isBusy()) {
        // already ended outside; ignore
      } else if (!officialWorking) {
        const number = officialStart()
        turn.observeTurnStart({ turn: number, inputSource: 'desktop' })
      }
    } else if (action === 3 && officialWorking) {
      const endTurn = random() < 0.8 ? lastOfficialTurn : lastOfficialTurn - 1
      const terminal = random() < 0.3 ? 'cancelled' : 'completed'
      const before = turn.snapshot()
      turn.observeTurnEnd({ turn: endTurn, terminal })
      officialWorking = false
      if (endTurn !== lastOfficialTurn) {
        // Stale official end for a previous turn: at most it settles that turn,
        // it must never turn a different active successor idle.
        const after = turn.snapshot()
        if (before.state === 'working' && before.turn !== endTurn && endTurn < lastOfficialTurn) {
          assert.equal(after.state, 'working', 'stale end must not settle the successor')
          assert.equal(after.turn, before.turn)
        }
      }
    } else if (action === 4 && turn.isBusy()) {
      const state = turn.snapshot()
      turn.requestCancel({ target: { turn: state.turn, token: `t${step}` } })
    } else if (action === 5) {
      const before = turn.snapshot()
      const confirmed = turn.cancelConfirmed()
      const after = turn.snapshot()
      if (before.state !== 'cancel-requested' && before.state !== 'unknown') {
        // Late confirmation without a pending cancel never changes anything.
        if (confirmed) assert.equal(after.state, before.state)
      }
    } else if (action === 6 && turn.snapshot().state === 'cancel-requested') {
      clock.advance(1000 + Math.floor(random() * 40000))
      turn.cancelExpired({ expireMs: 30000 })
    } else {
      clock.advance(300)
    }

    const snapshot = turn.snapshot()
    assert.ok(['idle', 'submitting', 'working', 'cancel-requested', 'unknown', 'error'].includes(snapshot.state))
    if (snapshot.state === 'idle') {
      assert.equal(snapshot.cancelTarget, null, 'idle never keeps a cancel target')
      assert.equal(snapshot.cancelRequestedAt, null)
    }
    if (snapshot.state === 'cancel-requested') {
      assert.ok(snapshot.cancelTarget, 'cancel-requested always has a captured target')
      assert.notEqual(snapshot.cancelRequestedAt, null)
    }
    // A successor that is working is never reported as cancelled by a stale token.
    if (snapshot.lastTurn.terminal === 'cancelled' && snapshot.state === 'working') {
      assert.notEqual(snapshot.lastTurn.turn, snapshot.turn, 'a working successor turn is not the cancelled turn')
    }
  }
})

/* ------------------------------------------------------------------------- */
/* Integration-edge regressions                                              */
/* ------------------------------------------------------------------------- */

test('take() returns full metadata while snapshot keeps the protocol projection', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now })
  queue.add({ id: 'q1', text: '保留身份', metadata: { captureId: 'c1', utteranceId: 'u1', mode: 'hold' } })
  const snapshotItem = queue.snapshot().items[0]
  assert.equal(Object.hasOwn(snapshotItem, 'metadata'), false, 'snapshot keeps the protocol shape')
  const taken = queue.take()
  assert.deepEqual(taken.metadata, { captureId: 'c1', utteranceId: 'u1', mode: 'hold' })
  assert.equal(taken.id, 'q1')
})

test('an expired queue item can still be inspected, edited, confirmed or deleted', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now, ttlMs: 1000 })
  const first = queue.add({ id: 'a', text: '旧指令' })
  queue.add({ id: 'b', text: '第二条' })
  clock.set(2000)
  assert.equal(queue.take(), null)
  // Deleting an expired record (user dismissed it) still works with the CAS revision.
  const deleted = queue.edit('a', queue.revision(), 'delete')
  assert.equal(deleted.deletedId, 'a')
  assert.deepEqual(queue.snapshot().items.map((item) => item.id), ['b'])
  // Editing an expired record renews it and clears the confirmation flag.
  const edited = queue.edit('b', queue.revision(), 'edit', '更新后的指令')
  assert.equal(edited.item.needsConfirmation, false)
  assert.equal(queue.take().id, 'b')
  assert.equal(first.id, 'a')
})

test('an expired record still occupies capacity: overflow stays explicit (no silent eviction)', () => {
  const clock = fakeClock()
  const queue = createQueueModel({ now: clock.now, limit: 1, ttlMs: 1000 })
  queue.add({ id: 'expired', text: '过期但未处理' })
  clock.set(5000)
  assert.throws(() => queue.add({ text: '新输入' }), (error) => {
    assert.equal(error.code, 'QUEUE_FULL')
    return true
  })
  assert.deepEqual(queue.snapshot().items.map((item) => item.id), ['expired'])
  queue.edit('expired', queue.revision(), 'delete')
  assert.equal(queue.add({ text: '新输入' }).id.length > 0, true)
})

test('a queue-sourced admission is not mistaken for a main-window turn', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.beginAdmission({ sessionId: 's', clientTurnId: 'c', inputSource: 'queue', text: '排队的工作' })
  // conversation-service maps host-originated starts to inputSource 'voice'.
  const observed = turn.observeTurnStart({ turnId: 's:1', turn: 1, inputSource: 'voice' })
  assert.equal(observed.state, 'working')
  assert.equal(observed.mainWindow, false)
  assert.equal(observed.conflict, null)
  assert.equal(turn.isMainWindowTurn(), false)
  assert.equal(turn.observeTurnEnd({ turnId: 's:1', turn: 1, terminal: 'completed' }).state, 'idle')
})

test('repeated cancel requests keep the first captured target and timestamp', () => {
  const clock = fakeClock()
  const turn = createTurnModel({ now: clock.now })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'voice' })
  turn.admitted({ turn: 8 })
  turn.requestCancel({ target: { turn: 8, requestId: 'first' } })
  clock.set(100)
  const second = turn.requestCancel({ target: { turn: 8, requestId: 'second' } })
  assert.equal(second.cancelTarget.requestId, 'first')
  assert.equal(second.cancelRequestedAt, 0)
})

test('a late official end for an already settled turn is a no-op, never a rollback', () => {
  const turn = createTurnModel({ now: () => 0 })
  turn.beginAdmission({ clientTurnId: 'c', inputSource: 'voice' })
  turn.admitted({ turn: 2 })
  const ended = turn.observeTurnEnd({ turn: 2, terminal: 'completed' })
  assert.equal(ended.state, 'idle')
  const again = turn.observeTurnEnd({ turn: 2, terminal: 'cancelled' })
  assert.equal(again.state, 'idle')
  assert.equal(again.lastTurn.terminal, 'completed', 'official first result wins; late event does not rewrite it')
})
