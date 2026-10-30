/**
 * beta2 kernel §3.5 / plan §11 gates B2-G02, B2-G05, B2-G07 (routing half).
 *
 * Covers: mixed control+work grammar, negation/quotation/hypothetical, duplicate
 * and cumulative finals, hold release + bounded drain, toggle quiet window, always
 * confirmation, discarded capture, late finals after the boundary, welcome-echo
 * regression, ambiguous interaction answers never falling through to input, and
 * randomized sequences asserting the path/boundary invariants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createUtteranceAssembler,
  createSegmenter,
  mergeFinalItems,
  CONTROL_KINDS,
  CONTROL_VALUES,
  SETTLE_MS_DEFAULT,
  DRAIN_MS_DEFAULT,
} from '../lib/utterance.mjs'

function fakeClock(start = 0) {
  let value = start
  return {
    now: () => value,
    set(next) { value = next; return value },
    advance(ms) { value += ms; return value },
  }
}

function assembler(clock, extra = {}) {
  return createUtteranceAssembler({ now: clock.now, settleMs: 100, drainMs: 500, ...extra })
}

function final(captureId, utteranceId, itemId, text, revision = 0, confidence = null) {
  return { kind: 'asr.final', captureId, utteranceId, itemId, revision, text, confidence }
}

function partial(captureId, utteranceId, itemId, text, revision = 0) {
  return { kind: 'asr.partial', captureId, utteranceId, itemId, revision, text }
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
/* Utterance assembler                                                       */
/* ------------------------------------------------------------------------- */

test('partial facts never submit, even through release and drain', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.fact(partial('c1', 'u1', 'p1', '请帮我'), { mode: 'hold' }).accepted, true)
  clock.set(50)
  assert.deepEqual(a.tick(), [])
  const released = a.release({ captureId: 'c1' })
  assert.deepEqual(released.utterances, [])
  clock.set(600) // drain deadline reached
  assert.deepEqual(a.tick(), [])
  assert.equal(a.emittedUtterances().length, 0)
  assert.ok(a.state().preview === null || a.state().preview.hasFinal === false)
})

test('duplicate provider items are deduped and late duplicates stay into inspection records', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.fact(final('c1', 'u1', 'i1', '请整理报告'), { mode: 'toggle' }).accepted, true)
  const duplicate = a.fact(final('c1', 'u1', 'i1', '请整理报告'), { mode: 'toggle' })
  assert.equal(duplicate.accepted, false)
  assert.equal(duplicate.duplicate, true)
  clock.set(120)
  const emitted = a.tick()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].text, '请整理报告')
  assert.equal(emitted[0].segments.length, 1)
  clock.set(130)
  const late = a.fact(final('c1', 'u1', 'i1', '请整理报告'), { mode: 'toggle' })
  assert.equal(late.accepted, false)
  clock.set(200)
  // Late-after-boundary content is delivered once as an inspectable late record,
  // never as a second submittable utterance.
  const lateBatch = a.tick()
  assert.equal(lateBatch.length, 1)
  assert.equal(lateBatch[0].late, true)
  assert.equal(lateBatch[0].reason, 'after-boundary')
  assert.deepEqual(a.tick(), [], 'a late record is delivered exactly once')
  assert.ok(a.lateRecords().some((record) => record.reason === 'after-boundary'))
  assert.equal(a.emittedUtterances().length, 1)
})

test('cumulative revisions merge without repeating words (same item and new items)', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '请整理', 0), { mode: 'hold' })
  const revision2 = a.fact(final('c1', 'u1', 'i1', '请整理报告', 1), { mode: 'hold' })
  assert.equal(revision2.accepted, true)
  assert.equal(revision2.reason, 'revision-updated')
  a.fact(final('c1', 'u1', 'i2', '请整理报告，谢谢', 0), { mode: 'hold' })
  clock.set(10)
  a.release({ captureId: 'c1' })
  clock.set(200)
  const [utterance] = a.tick()
  assert.equal(utterance.text, '请整理报告，谢谢')
  assert.equal(mergeFinalItems([
    { segmentId: 's1', itemId: 'a', revision: 0, text: '请帮我', confidence: null },
    { segmentId: 's2', itemId: 'b', revision: 0, text: '请帮我整理报告。', confidence: null },
  ]).text, '请帮我整理报告。')
})

test('distinct captures never merge into one utterance', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '旧录音'), { mode: 'hold' })
  a.fact(final('c2', 'u2', 'i2', '新的录音'), { mode: 'hold' })
  clock.set(10)
  a.release({ captureId: 'c1' })
  a.release({ captureId: 'c2' })
  clock.set(200)
  const utterances = a.tick()
  assert.equal(utterances.length, 2)
  assert.deepEqual(utterances.map((item) => item.captureId).sort(), ['c1', 'c2'])
  assert.equal(utterances[0].text, '旧录音')
  assert.equal(utterances[1].text, '新的录音')
})

test('hold stays closed until release, then waits the bounded drain', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '请帮我整理报告'), { mode: 'hold' })
  clock.set(80)
  assert.deepEqual(a.tick(), [], 'no submission before release')
  const released = a.release({ captureId: 'c1' })
  assert.equal(released.drained, false)
  assert.deepEqual(released.utterances, [])
  clock.set(99)
  assert.deepEqual(a.tick(), [])
  clock.set(100) // lastActivity(0) + settle(100)
  const emitted = a.tick()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].text, '请帮我整理报告')
  // Post-boundary content is inspection-only, never a second utterance.
  clock.set(150)
  assert.equal(a.fact(final('c1', 'u1', 'i2', '再补一句'), { mode: 'hold' }).accepted, false)
  clock.set(200)
  const lateBatch = a.tick()
  assert.equal(lateBatch.filter((item) => item.late === false).length, 0)
  assert.deepEqual(lateBatch.map((item) => item.late), [true])
  assert.equal(a.emittedUtterances().length, 1)
})

test('release defers emission to tick so one producer emits every utterance', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '已经说完'), { mode: 'hold' })
  clock.set(150) // settle elapsed before release
  const released = a.release({ captureId: 'c1' })
  assert.deepEqual(released.utterances, [], 'release never competes with tick for emission')
  assert.equal(released.drained, false)
  const emitted = a.tick()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].text, '已经说完')
  assert.equal(emitted[0].late, false)
})

test('the release drain deadline caps convergence even with continuing finals', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '第一段'), { mode: 'hold' })
  a.release({ captureId: 'c1' })
  clock.set(100)
  assert.equal(a.fact(final('c1', 'u1', 'i2', '第二段'), { mode: 'hold' }).accepted, true)
  clock.set(400)
  assert.equal(a.fact(final('c1', 'u1', 'i3', '第三段'), { mode: 'hold' }).accepted, true)
  clock.set(499)
  assert.deepEqual(a.tick(), [], 'settle would extend past drain; hard deadline wins')
  clock.set(500)
  const emitted = a.tick()
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0].text, '第一段第二段第三段')
  assert.equal(emitted[0].readyAt, 500)
  clock.set(510)
  assert.equal(a.fact(final('c1', 'u1', 'i4', '迟到'), { mode: 'hold' }).accepted, false)
})

test('toggle quiet window forms one utterance per quiet period in the same capture', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '就是'), { mode: 'toggle' })
  clock.advance(40)
  a.fact(final('c1', 'u1', 'i2', '最后一个选项。'), { mode: 'toggle' })
  clock.set(79)
  assert.deepEqual(a.tick(), [])
  clock.set(140) // last activity 40 + settle 100
  const first = a.tick()
  assert.equal(first.length, 1)
  assert.equal(first[0].text, '就是最后一个选项。')
  assert.equal(first[0].utteranceId, 'u1')
  clock.set(200)
  a.fact(final('c1', 'u2', 'i3', '再打开浏览器'), { mode: 'toggle' })
  clock.set(300)
  const second = a.tick()
  assert.equal(second.length, 1)
  assert.equal(second[0].text, '再打开浏览器')
  assert.notEqual(second[0].utteranceId, first[0].utteranceId)
})

test('always mode forms the utterance but always requires confirmation', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '整理一下文档'), { mode: 'always' })
  clock.set(101)
  const [utterance] = a.tick()
  assert.equal(utterance.mode, 'always')
  assert.equal(utterance.needsConfirmation, true)
})

test('a discarded capture can never flush and its late facts are rejected', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '不要这段'), { mode: 'hold' })
  const released = a.release({ captureId: 'c1', discard: true })
  assert.deepEqual(released.utterances, [])
  clock.set(200)
  assert.deepEqual(a.tick(), [])
  const late = a.fact(final('c1', 'u1', 'i1', '不要这段'), { mode: 'hold' })
  assert.equal(late.accepted, false)
  assert.equal(late.reason, 'discarded-capture')
  // Discard before any fact still poisons the capture (out-of-order transport).
  a.release('c2', { discard: true })
  assert.equal(a.fact(final('c2', 'u2', 'i2', '迟到'), { mode: 'hold' }).accepted, false)
  clock.set(300)
  assert.deepEqual(a.tick(), [])
})

test('release before facts within the drain window still forms exactly one utterance', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  const released = a.release({ captureId: 'c1' })
  assert.equal(released.drained, false)
  clock.set(50)
  assert.equal(a.fact(final('c1', 'u1', 'i1', '松键后才到的 final'), { mode: 'hold' }).accepted, true)
  clock.set(149)
  assert.deepEqual(a.tick(), [])
  clock.set(150) // last activity 50 + settle 100, inside drain 500
  assert.equal(a.tick().length, 1)
})

test('conflicting revisions are rejected and force confirmation, never silent replacement', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '正确内容', 2), { mode: 'toggle' })
  assert.equal(a.fact(final('c1', 'u1', 'i1', '旧修订', 1), { mode: 'toggle' }).reason, 'stale-revision')
  assert.equal(a.fact(final('c1', 'u1', 'i1', '矛盾内容', 2), { mode: 'toggle' }).reason, 'conflicting-revision')
  clock.set(101)
  const [utterance] = a.tick()
  assert.equal(utterance.text, '正确内容')
  assert.equal(utterance.needsConfirmation, true)
  assert.equal(utterance.conflicts.length, 2)
})

test('utterance identity, segment ids, item ids and spans survive assembly', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('cap-9', 'utt-9', 'item-1', '请帮我', 0, 0.4), { mode: 'hold' })
  a.fact(final('cap-9', 'utt-9', 'item-2', '整理报告。', 0, null), { mode: 'hold' })
  clock.set(10)
  a.release({ captureId: 'cap-9' })
  clock.set(200)
  const [utterance] = a.tick()
  assert.equal(utterance.utteranceId, 'utt-9')
  assert.equal(utterance.captureId, 'cap-9')
  assert.equal(utterance.mode, 'hold')
  assert.equal(utterance.createdAt, 0)
  assert.equal(utterance.late, false)
  assert.equal(utterance.segments.length, 2)
  assert.deepEqual(utterance.segments.map((segment) => segment.itemIds), [['item-1'], ['item-2']])
  assert.equal(utterance.segments[0].segmentId, 'utt-9:item-1')
  assert.equal(utterance.segments[0].confidence, 0.4)
  assert.equal(utterance.segments[1].confidence, null) // unknown ASR confidence is not fabricated
  assert.deepEqual(utterance.segments[0].span, [0, 3])
  assert.deepEqual(utterance.segments[1].span, [3, 8])
})

test('bad tunables and oversized input fail explicitly', () => {
  assert.throws(() => createUtteranceAssembler({ settleMs: 0 }), /settleMs/)
  assert.throws(() => createUtteranceAssembler({ drainMs: -1, now: () => 0 }), /drainMs/)
  assert.throws(() => createUtteranceAssembler({ maxChars: 0, now: () => 0 }), /maxChars/)
  assert.throws(() => createUtteranceAssembler({ now: 'later' }), /now/)
  const clock = fakeClock()
  const a = assembler(clock, { maxChars: 10 })
  assert.throws(
    () => a.fact(final('c1', 'u1', 'i1', 'x'.repeat(11)), { mode: 'hold' }),
    /exceeds 10/,
  )
})

test('active capture capacity is bounded and rejects excess admission without eviction', () => {
  const clock = fakeClock()
  const a = assembler(clock, { maxActiveCaptures: 1 })
  assert.equal(a.fact(final('c1', 'u1', 'i1', '第一段'), { mode: 'toggle' }).accepted, true)
  const rejected = a.fact(final('c2', 'u2', 'i2', '第二段'), { mode: 'toggle' })
  assert.equal(rejected.accepted, false)
  assert.equal(rejected.reason, 'capacity')
  clock.set(101)
  assert.equal(a.tick().length, 1)
  // c1 remains open in toggle mode; release it to free one slot.
  a.release({ captureId: 'c1' })
  clock.set(700)
  a.tick()
  assert.equal(a.fact(final('c2', 'u2', 'i2', '第二段'), { mode: 'toggle' }).accepted, true)
})

test('state() preview exposes partial/final activity without submitting', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.state().preview, null)
  a.fact(partial('c1', 'u1', 'p1', '正在说'), { mode: 'hold' })
  a.fact(final('c1', 'u1', 'i1', '正在说话'), { mode: 'hold' })
  const state = a.state()
  assert.equal(state.preview.utteranceId, 'u1')
  assert.equal(state.preview.text, '正在说话')
  assert.equal(state.preview.hasFinal, true)
  assert.equal(a.emittedUtterances().length, 0)
})

test('randomized assembler sequences keep the submission-boundary invariants', () => {
  const clock = fakeClock()
  const a = assembler(clock, { maxActiveCaptures: 6, maxUtteranceMs: 5000 })
  const random = rng(0x5eed)
  const captures = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']
  const modes = { c0: 'hold', c1: 'toggle', c2: 'toggle', c3: 'always', c4: 'hold', c5: 'toggle' }
  const discarded = new Set()
  const released = new Set()
  const finalsSeen = new Map()
  const texts = ['请帮我', '整理报告。', '打开浏览器', '然后呢', '你好', '写一段介绍', '最后一个选项。', '停一下', '谢谢']
  const emittedIds = new Set()
  const emittedPerCapture = new Map()

  for (let step = 0; step < 400; step += 1) {
    const capture = captures[Math.floor(random() * captures.length)]
    if (!discarded.has(capture)) {
      const kind = random() < 0.3 ? 'asr.partial' : 'asr.final'
      const itemId = `i${Math.floor(random() * 4)}`
      const revision = Math.floor(random() * 3)
      const text = texts[Math.floor(random() * texts.length)]
      const result = a.fact(
        { kind, captureId: capture, utteranceId: `u${capture}-${step}`, itemId, revision, text },
        { mode: modes[capture] },
      )
      if (kind === 'asr.final' && result.accepted) {
        finalsSeen.set(capture, (finalsSeen.get(capture) || 0) + 1)
      }
      if (random() < 0.08 && !released.has(capture)) {
        if (random() < 0.2) {
          const releasedResult = a.release({ captureId: capture, discard: true })
          assert.deepEqual(releasedResult.utterances, [])
          discarded.add(capture)
        } else {
          a.release({ captureId: capture })
          released.add(capture)
        }
      }
    }
    clock.advance(1 + Math.floor(random() * 30))
    const utterances = a.tick()
    for (const utterance of utterances) {
      if (utterance.late) {
        // Late-after-boundary content is inspection-only: never a submittable task.
        assert.equal(utterance.reason, 'after-boundary')
        assert.ok(utterance.text.trim().length > 0)
        assert.equal(utterance.segments.length, 1)
        assert.ok(!discarded.has(utterance.captureId))
        continue
      }
      assert.ok(!discarded.has(utterance.captureId), 'discarded capture must never flush')
      assert.ok(utterance.text.trim().length > 0)
      assert.ok(utterance.segments.length > 0)
      assert.equal(new Set(utterance.segments.map((segment) => segment.itemIds[0])).size, utterance.segments.length)
      assert.ok(!emittedIds.has(utterance.utteranceId), 'one utterance identity is submitted at most once')
      emittedIds.add(utterance.utteranceId)
      emittedPerCapture.set(utterance.captureId, (emittedPerCapture.get(utterance.captureId) || 0) + 1)
      for (const segment of utterance.segments) {
        assert.ok(segment.span[0] >= 0 && segment.span[0] <= segment.span[1] && segment.span[1] <= utterance.text.length)
        assert.ok(Number.isInteger(segment.revision) && segment.revision >= 0)
      }
    }
  }
  // Partial-only captures never produce a submitted utterance.
  for (const [capture, finals] of finalsSeen) {
    if (finals === 0) assert.equal(emittedPerCapture.get(capture) || 0, 0)
  }
  // Close everything left and drain.
  for (const capture of captures) {
    if (!discarded.has(capture)) a.release({ captureId: capture })
  }
  clock.advance(1000)
  const tail = a.tick()
  for (const utterance of tail) assert.ok(!discarded.has(utterance.captureId))
})

/* ------------------------------------------------------------------------- */
/* Segmenter: plan §5.3 grammar table / B2-G02 / B2-G05 / B2-G07             */
/* ------------------------------------------------------------------------- */

const SEGMENT_KINDS = new Set(['control', 'interaction-answer', 'input', 'ignore'])

function assertSegmentShape(result, text) {
  assert.ok(Array.isArray(result.segments) && result.segments.length > 0, 'at least one segment')
  assert.ok(Array.isArray(result.clarifications), 'clarifications is always an array')
  const ids = new Set()
  for (const segment of result.segments) {
    assert.ok(SEGMENT_KINDS.has(segment.kind), `unexpected kind ${segment.kind}`)
    assert.ok(segment.segmentId && !ids.has(segment.segmentId), 'stable unique segmentId')
    ids.add(segment.segmentId)
    assert.ok(Array.isArray(segment.span) && segment.span.length === 2)
    assert.ok(segment.span[0] >= 0 && segment.span[0] <= segment.span[1] && segment.span[1] <= text.length)
    assert.equal(typeof segment.reason, 'string')
    assert.ok(segment.reason.length > 0)
    if (segment.kind === 'control') assert.ok(CONTROL_KINDS.includes(segment.control), `control ${segment.control}`)
    if (segment.kind === 'input' || segment.kind === 'ignore') assert.equal(segment.control, undefined)
  }
}

test('B2-G02: “停一下。然后写小作文” -> one playback-stop + one complete input', () => {
  const segmenter = createSegmenter()
  const text = '停一下。然后写小作文'
  const result = segmenter.route(text, { mode: 'hold', captureId: 'c1', utteranceId: 'u1' })
  assertSegmentShape(result, text)
  assert.equal(result.segments.length, 2)
  assert.equal(result.segments[0].kind, 'control')
  assert.equal(result.segments[0].control, 'playback-stop')
  assert.equal(result.segments[0].text, '停一下')
  assert.equal(result.segments[1].kind, 'input')
  assert.equal(result.segments[1].text, '写小作文')
  assert.equal(result.interactionAnswerRejected, undefined)
})

test('B2-G02: “停一下然后写小作文” splits reliably when the connector is explicit', () => {
  const segmenter = createSegmenter()
  const result = segmenter.route('停一下然后写小作文', { mode: 'toggle', utteranceId: 'u1' })
  assertSegmentShape(result, '停一下然后写小作文')
  assert.deepEqual(result.segments.map((segment) => segment.kind), ['control', 'input'])
  assert.equal(result.segments[1].text, '写小作文')
})

test('B2-G02: an ambiguous bare control + connector clarifies instead of guessing', () => {
  const segmenter = createSegmenter()
  const result = segmenter.route('停然后写小作文', { mode: 'toggle', utteranceId: 'u1' })
  assertSegmentShape(result, '停然后写小作文')
  assert.equal(result.segments.length, 1)
  assert.equal(result.segments[0].kind, 'ignore')
  assert.equal(result.segments[0].reason, 'ambiguous-control-boundary')
  assert.equal(result.segments[0].control, undefined)
  assert.ok(result.clarifications.length > 0)
})

test('B2-G02: negation, quotation and hypothetical forms never stop playback', () => {
  const segmenter = createSegmenter()
  for (const text of ['不要停，继续讲', '文档里写停一下', '如果我说停一下', '“停一下”然后写小作文', '别停。然后写小作文', '停不下来']) {
    const result = segmenter.route(text, { mode: 'toggle', utteranceId: 'u1' })
    assertSegmentShape(result, text)
    assert.equal(result.segments.filter((segment) => segment.kind === 'control').length, 0, text)
    assert.equal(result.segments[0].kind, 'input', text)
  }
})

test('B2-G02: control and interaction scopes stay separate', () => {
  const segmenter = createSegmenter()
  const playback = segmenter.route('停一下', { mode: 'hold', utteranceId: 'u1' })
  assert.equal(playback.segments[0].control, 'playback-stop')
  const stopTask = segmenter.route('停止任务', { mode: 'hold', utteranceId: 'u1' })
  assert.equal(stopTask.segments[0].kind, 'control')
  assert.equal(stopTask.segments[0].control, 'task-stop')
  assert.equal(stopTask.segments[0].reason, 'task-stop-request')
  const confirmStop = segmenter.route('确认停止任务', { mode: 'hold', utteranceId: 'u1' })
  assert.equal(confirmStop.segments[0].control, 'task-stop')
  assert.equal(confirmStop.segments[0].reason, 'task-stop-confirm')
  assert.equal(confirmStop.segments[0].confirm, true)
  const cancelCapture = segmenter.route('取消录音', { mode: 'hold', captureId: 'cap-1', utteranceId: 'u1' })
  assert.equal(cancelCapture.segments[0].control, 'cancel-capture')
  assert.equal(cancelCapture.segments[0].captureId, 'cap-1')
  const legacyCancel = segmenter.route('取消', { mode: 'hold', utteranceId: 'u1' })
  assert.equal(legacyCancel.segments[0].control, 'playback-stop')
  for (const [text, control] of [['详细播报', 'playback-full'], ['只说结论', 'playback-brief'], ['现在做到哪里了', 'task-status'], ['别说了', 'playback-stop']]) {
    assert.equal(segmenter.route(text, { utteranceId: 'u1' }).segments[0].control, control, text)
  }
})

test('B2-G02: approval spoken control binds only in explicit approval context', () => {
  const segmenter = createSegmenter()
  const approval = { id: 'ap-1', semanticRevision: 7, operation: { toolName: 'write' } }
  const allowed = segmenter.route('我允许一次', { mode: 'always', approval, utteranceId: 'u1' })
  assert.equal(allowed.segments.length, 1)
  assert.equal(allowed.segments[0].kind, 'control')
  assert.equal(allowed.segments[0].control, 'approval-allow')
  assert.deepEqual(allowed.segments[0].answer, {
    kind: 'approval',
    interactionId: 'ap-1',
    semanticRevision: 7,
    decision: 'allowed-once',
  })
  const rejected = segmenter.route('拒绝', { approval, utteranceId: 'u1' })
  assert.equal(rejected.segments[0].control, 'approval-reject')
  assert.equal(rejected.segments[0].answer.decision, 'rejected')
  // Without an official approval there is nothing to authorise: never a task.
  for (const text of ['确认允许一次', '我允许一次', '拒绝', '始终允许']) {
    const result = segmenter.route(text, { mode: 'always', utteranceId: 'u1' })
    assertSegmentShape(result, text)
    assert.equal(result.segments[0].kind, 'ignore', text)
    assert.ok(['no-pending-approval', 'persistent-approval-requires-ui'].includes(result.segments[0].reason), text)
    assert.equal(result.segments.some((segment) => segment.kind === 'control'), false, text)
    assert.equal(result.segments.some((segment) => segment.kind === 'input'), false, text)
  }
})

test('B2-G02: ambiguous approvals are rejected for clarification and never become input', () => {
  const segmenter = createSegmenter()
  const approval = { id: 'ap-1', semanticRevision: 2 }
  for (const text of ['可以', '好像可以', '应该可以', '好的', '嗯']) {
    const result = segmenter.route(text, { mode: 'always', approval, utteranceId: 'u1' })
    assertSegmentShape(result, text)
    assert.equal(result.interactionAnswerRejected, true, text)
    assert.equal(result.segments[0].kind, 'interaction-answer', text)
    assert.equal(result.segments[0].answer.status, 'rejected', text)
    assert.equal(result.segments.some((segment) => segment.kind === 'input'), false, text)
    assert.ok(result.clarifications.length > 0, text)
  }
  const persistent = segmenter.route('始终允许', { mode: 'always', approval, utteranceId: 'u1' })
  assert.equal(persistent.segments[0].kind, 'ignore')
  assert.equal(persistent.segments[0].reason, 'persistent-approval-requires-ui')
})

test('B2-G02: “确认允许一次，然后整理文件” -> approval answer + remaining work', () => {
  const segmenter = createSegmenter()
  const approval = { id: 'ap-9', semanticRevision: 4 }
  const text = '确认允许一次，然后整理文件'
  const result = segmenter.route(text, { mode: 'always', approval, utteranceId: 'u1' })
  assertSegmentShape(result, text)
  assert.equal(result.segments.length, 2)
  assert.equal(result.segments[0].kind, 'control')
  assert.equal(result.segments[0].control, 'approval-allow')
  assert.equal(result.segments[0].answer.semanticRevision, 4)
  assert.equal(result.segments[1].kind, 'input')
  assert.equal(result.segments[1].text, '整理文件')
  assert.equal(result.segments[1].requiresConfirmation, true, 'always mode work still needs confirmation')
  // Deterministic: the same item retransmitted routes to the same decision, no new work.
  assert.deepEqual(segmenter.route(text, { mode: 'always', approval, utteranceId: 'u1' }), result)
})

test('B2-G05: welcome echo is ignored only with evidence; normal greetings survive', () => {
  const segmenter = createSegmenter()
  for (const text of ['你好', '我在', '想聊什么', '你好呀']) {
    const normal = segmenter.route(text, { mode: 'toggle', utteranceId: 'u1' })
    assertSegmentShape(normal, text)
    assert.equal(normal.segments[0].kind, 'input', text)
    const echoed = segmenter.route(text, { mode: 'toggle', utteranceId: 'u1', options: { welcomeEcho: true } })
    assert.equal(echoed.segments[0].kind, 'ignore', text)
    assert.equal(echoed.segments[0].reason, 'welcome-echo', text)
    const acoustic = segmenter.route('欢迎使用 dsh-bot', { options: { echo: true }, utteranceId: 'u1' })
    assert.equal(acoustic.segments[0].reason, 'welcome-echo')
  }
  // A welcome-echo flag on longer legitimate speech must not swallow it.
  const longer = segmenter.route('你好，帮我写一段介绍', { welcomeEcho: true, utteranceId: 'u1' })
  assert.equal(longer.segments[0].kind, 'input')
})

test('ignore paths always carry an explicit reason (empty / duplicate)', () => {
  const segmenter = createSegmenter()
  for (const [text, options, reason] of [
    ['   ', {}, 'empty'],
    ['', {}, 'empty'],
    ['请整理报告', { duplicate: true }, 'duplicate'],
    ['随便写点什么', { options: { ignoreReason: 'welcome-echo' } }, 'welcome-echo'],
  ]) {
    const result = segmenter.route(text, { utteranceId: 'u1', options, ...options })
    assertSegmentShape(result, text)
    assert.equal(result.segments[0].kind, 'ignore')
    assert.equal(result.segments[0].reason, reason)
  }
})

test('B2-G05: question answers bind stable option id/label/ordinal inside semanticRevision', () => {
  const segmenter = createSegmenter()
  const interaction = {
    kind: 'question', id: 'q-1', semanticRevision: 3,
    questions: [{
      id: 'where', question: '去哪？', multiSelect: false,
      options: [{ id: 'official-a', label: '上海' }, { id: 'official-b', label: '杭州' }],
    }],
  }
  const second = segmenter.route('第二个', { interaction, utteranceId: 'u1' })
  assertSegmentShape(second, '第二个')
  assert.equal(second.segments[0].kind, 'interaction-answer')
  assert.equal(second.segments[0].reason, 'question-answer')
  const answer = second.segments[0].answer
  assert.equal(answer.interactionId, 'q-1')
  assert.equal(answer.semanticRevision, 3)
  assert.equal(answer.questionId, 'where')
  assert.equal(answer.optionIndex, 1)
  assert.equal(answer.optionLabel, '杭州')
  assert.deepEqual(answer.selected, ['official:official-b'])
  assert.equal(answer.setSelected, true)

  const last = segmenter.route('最后一个', { interaction, utteranceId: 'u1' })
  assert.equal(last.segments[0].answer.optionLabel, '杭州')
  const byLabel = segmenter.route('选上海', { interaction, utteranceId: 'u1' })
  assert.equal(byLabel.segments[0].answer.optionLabel, '上海')
  // A different semantic revision yields different product option ids: old
  // ordinals/labels must never be reinterpreted across revisions.
  const productOptions = {
    kind: 'question', id: 'q-2', semanticRevision: 1,
    questions: [{ id: 'q', question: '选一个', options: [{ label: '苹果' }, { label: '香蕉' }] }],
  }
  const product1 = segmenter.route('第一个', { interaction: productOptions, utteranceId: 'u1' }).segments[0].answer
  const product2 = segmenter.route('第一个', {
    interaction: { ...productOptions, semanticRevision: 2 },
    utteranceId: 'u1',
  }).segments[0].answer
  assert.notEqual(product1.optionId, product2.optionId)
  assert.equal(product2.semanticRevision, 2)
})

test('B2-G05: multi-select uses set-selected, never an idempotent toggle', () => {
  const segmenter = createSegmenter()
  const interaction = {
    kind: 'question', id: 'q-multi', semanticRevision: 5,
    questions: [{ id: 'pick', question: '选哪些？', multiSelect: true, options: [{ label: '苹果' }, { label: '香蕉' }, { label: '梨' }] }],
  }
  const select = segmenter.route('第三个', { interaction, utteranceId: 'u1' }).segments[0].answer
  assert.equal(select.multiSelect, true)
  assert.equal(select.selectionIntent, 'select')
  assert.equal(select.setSelected, true)
  assert.equal(select.optionLabel, '梨')
  const deselect = segmenter.route('取消第三个', { interaction, utteranceId: 'u1' }).segments[0].answer
  assert.equal(deselect.selectionIntent, 'deselect')
  assert.equal(deselect.setSelected, false)
  assert.equal(deselect.optionLabel, '梨')
  assert.deepEqual(deselect.selected, [])
  // Integration contract: plain selects expose a registry answer batch; a
  // set-selected deselect is a draft command, never an answer batch.
  assert.deepEqual(select.answers, [{ id: 'pick', selected: [select.optionId] }])
  assert.equal(deselect.answers, undefined)
  // Replaying the same route is the same set-selected command, not a flip.
  const replay = segmenter.route('取消第三个', { interaction, utteranceId: 'u1' }).segments[0].answer
  assert.deepEqual(replay, deselect)
})

test('B2-G05: ambiguous or invalid question answers clarify and never fall through to input', () => {
  const segmenter = createSegmenter()
  const interaction = {
    kind: 'question', id: 'q-1', semanticRevision: 1,
    questions: [{ id: 'where', question: '去哪？', options: [{ label: '上海' }, { label: '杭州' }] }],
  }
  for (const text of ['第五个', '好的', '嗯', '第一个和第二个', '第三个']) {
    const result = segmenter.route(text, { interaction, utteranceId: 'u1' })
    assertSegmentShape(result, text)
    assert.equal(result.interactionAnswerRejected, true, text)
    assert.equal(result.segments[0].kind, 'interaction-answer', text)
    assert.equal(result.segments[0].answer.status, 'rejected', text)
    assert.equal(result.segments.some((segment) => segment.kind === 'input'), false, text)
    assert.equal(result.segments.some((segment) => segment.kind === 'control'), false, text)
    assert.ok(result.clarifications.length > 0, text)
  }
  // Ordinary work with a pending question still routes as input (not an answer).
  const work = segmenter.route('帮我整理文件', { interaction, utteranceId: 'u1' })
  assert.equal(work.segments[0].kind, 'input')
  // Control priority: playback stop wins even while a question is pending.
  const control = segmenter.route('停一下', { interaction, utteranceId: 'u1' })
  assert.equal(control.segments[0].kind, 'control')
  assert.equal(control.segments[0].control, 'playback-stop')
})

test('B2-G05: question index binds to the focused question inside the interaction', () => {
  const segmenter = createSegmenter()
  const interaction = {
    kind: 'question', id: 'q-many', semanticRevision: 2,
    questions: [
      { id: 'first', question: '第一个问题', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'second', question: '第二个问题', options: [{ label: 'C' }, { label: 'D' }] },
    ],
  }
  const answer = segmenter.route('第二个', { interaction, utteranceId: 'u1', options: { questionIndex: 1 } }).segments[0].answer
  assert.equal(answer.questionId, 'second')
  assert.equal(answer.optionLabel, 'D')
  assert.equal(answer.questionIndex, 1)
})

test('route is pure and deterministic (no shared state between calls)', () => {
  const segmenter = createSegmenter()
  const context = {
    mode: 'always',
    approval: { id: 'ap-1', semanticRevision: 1 },
    captureId: 'c1',
    utteranceId: 'u1',
  }
  const snapshot = JSON.stringify(context)
  const first = segmenter.route('确认允许一次，然后整理文件', context)
  const second = segmenter.route('确认允许一次，然后整理文件', context)
  assert.deepEqual(first, second)
  assert.equal(JSON.stringify(context), snapshot, 'route must not mutate context')
  const third = segmenter.route('停一下。然后写小作文', { mode: 'hold', utteranceId: 'u1' })
  const fourth = segmenter.route('停一下。然后写小作文', { mode: 'hold', utteranceId: 'u1' })
  assert.deepEqual(third, fourth)
})

test('invalid route context fails closed instead of routing to input', () => {
  const segmenter = createSegmenter()
  assert.throws(() => segmenter.route('停一下', { mode: 'push-to-talk' }), /input mode/)
  assert.throws(() => segmenter.route('第二个', { interaction: { kind: 'question', id: 'q' } }), /semanticRevision/)
})

test('randomized routing sequences keep exactly-one-path and no-fallthrough invariants', () => {
  const segmenter = createSegmenter()
  const random = rng(0xc0ffee)
  const approval = { id: 'ap-1', semanticRevision: 1 }
  const question = {
    kind: 'question', id: 'q-1', semanticRevision: 2,
    questions: [{ id: 'qq', question: '选哪个？', options: [{ label: '上海' }, { label: '杭州' }, { label: '广州' }] }],
  }
  const contextVariants = [
    {},
    { mode: 'hold' },
    { mode: 'toggle' },
    { mode: 'always' },
    { mode: 'toggle', approval },
    { mode: 'always', approval },
    { mode: 'hold', interaction: question },
    { mode: 'toggle', interaction: question, options: { questionIndex: 0 } },
  ]
  const corpus = [
    '停一下。然后写小作文', '停一下然后写小作文', '停然后写小作文', '不要停，继续讲',
    '文档里写停一下', '如果我说停一下', '停一下', '停止任务', '确认停止任务', '取消录音',
    '取消任务', '别说了', '详细播报', '只说结论', '现在做到哪里了',
    '确认允许一次', '我允许一次', '拒绝', '可以', '好像可以', '始终允许', '好的',
    '第二个', '最后一个', '选上海', '第五个', '第一个和第二个', '取消第三个',
    '你好', '我在', '想聊什么', '帮我整理文件', '打开浏览器', '写一段介绍', '随便聊聊',
  ]
  const pureAnswerTexts = new Set(['第五个', '好的', '第一个和第二个', '第二个', '最后一个', '选上海', '取消第三个'])
  const neverControlTexts = new Set(['不要停，继续讲', '文档里写停一下', '如果我说停一下'])

  for (let step = 0; step < 250; step += 1) {
    const text = corpus[Math.floor(random() * corpus.length)]
    const context = { ...contextVariants[Math.floor(random() * contextVariants.length)], utteranceId: `u${step % 5}`, captureId: 'c1' }
    const result = segmenter.route(text, context)
    assertSegmentShape(result, text)
    const kinds = result.segments.map((segment) => segment.kind)
    assert.equal(kinds.length, new Set(result.segments.map((segment) => segment.segmentId)).size)
    if (neverControlTexts.has(text)) assert.equal(kinds.includes('control'), false, text)
    if (!context.interaction && !context.approval) assert.equal(kinds.includes('interaction-answer'), false, `${text} without interaction`)
    if (!context.interaction && context.approval && !result.interactionAnswerRejected) {
      assert.equal(kinds.includes('interaction-answer'), false, `${text}: non-ambiguous approval only becomes control/ignore`)
    }
    const hasApprovalContext = Boolean(context.approval || context.interaction?.kind === 'approval')
    for (const segment of result.segments) {
      if (segment.control === 'approval-allow' || segment.control === 'approval-reject') {
        assert.equal(hasApprovalContext, true, `${text}: approval control without approval context`)
      }
    }
    if (result.interactionAnswerRejected) {
      assert.ok(kinds.includes('interaction-answer'), text)
      if (context.interaction && pureAnswerTexts.has(text)) assert.equal(kinds.includes('input'), false, text)
    }
    // The same call remains deterministic.
    assert.deepEqual(segmenter.route(text, context), result)
  }
})

test('assembler -> segmenter integration: a mixed final routes once per segment', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '停一下。然后写小作文'), { mode: 'hold' })
  clock.set(10)
  a.release({ captureId: 'c1' })
  clock.set(200)
  const [utterance] = a.tick()
  const segmenter = createSegmenter()
  const routed = segmenter.route(utterance.text, {
    mode: utterance.mode,
    captureId: utterance.captureId,
    utteranceId: utterance.utteranceId,
  })
  assert.deepEqual(routed.segments.map((segment) => segment.kind), ['control', 'input'])
  assert.equal(routed.segments[1].text, '写小作文')
  assert.ok(CONTROL_VALUES.includes(routed.segments[0].control))
  assert.equal(SETTLE_MS_DEFAULT, 650)
  assert.equal(DRAIN_MS_DEFAULT, 3000)
})

/* ------------------------------------------------------------------------- */
/* Integration-edge regressions (ConversationService voice.facts pattern)    */
/* ------------------------------------------------------------------------- */

test('release-then-tick (service pattern) loses no utterance; release output is empty by contract', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '松键后的一句话'), { mode: 'hold' })
  clock.set(20)
  const released = a.release({ captureId: 'c1' })
  assert.deepEqual(released.utterances, [])
  assert.equal(released.pending, 1)
  // The service calls tick() immediately after release (quiet window not elapsed yet)
  // and its 100 ms tick timer emits once the hold settle deadline passes.
  assert.deepEqual(a.tick(), [])
  clock.set(100)
  const ready = a.tick()
  assert.equal(ready.length, 1)
  assert.equal(ready[0].late, false)
  assert.equal(ready[0].text, '松键后的一句话')
})

test('a discarded capture also suppresses buffered late inspection records', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  a.fact(final('c1', 'u1', 'i1', '第一段'), { mode: 'toggle' })
  clock.set(101)
  assert.equal(a.tick().length, 1)
  clock.set(120)
  // Late final is buffered but not yet delivered.
  assert.equal(a.fact(final('c1', 'u1', 'i2', '迟到的内容'), { mode: 'toggle' }).late, true)
  // The capture is discarded before the next tick drains the late record.
  a.release({ captureId: 'c1', discard: true })
  clock.set(200)
  assert.deepEqual(a.tick(), [], 'discarded capture cannot flush buffered late content')
  assert.equal(a.emittedUtterances().length, 1)
})

test('legacy finals without provider itemId do not collide as conflicting revisions', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.fact({ kind: 'asr.final', captureId: 'c1', utteranceId: 'u1', revision: 0, text: '第一句' }, { mode: 'hold' }).accepted, true)
  assert.equal(a.fact({ kind: 'asr.final', captureId: 'c1', utteranceId: 'u1', revision: 0, text: '第二句' }, { mode: 'hold' }).accepted, true)
  clock.set(10)
  a.release({ captureId: 'c1' })
  clock.set(200)
  const [utterance] = a.tick()
  assert.equal(utterance.text, '第一句第二句')
  assert.equal(utterance.conflicts.length, 0)
})

test('a mode change inside one capture is rejected explicitly', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.fact(final('c1', 'u1', 'i1', '一'), { mode: 'hold' }).accepted, true)
  const conflict = a.fact(final('c1', 'u1', 'i2', '二'), { mode: 'toggle' })
  assert.equal(conflict.accepted, false)
  assert.equal(conflict.reason, 'mode-conflict')
})

test('an empty final never emits a submittable utterance and is recorded', () => {
  const clock = fakeClock()
  const a = assembler(clock)
  assert.equal(a.fact(final('c1', 'u1', 'i1', ''), { mode: 'hold' }).accepted, true)
  clock.set(10)
  a.release({ captureId: 'c1' })
  clock.set(200)
  assert.deepEqual(a.tick(), [])
  assert.ok(a.droppedRecords().some((record) => record.reason === 'empty-text'))
})
