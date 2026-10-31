/**
 * F1 projection determinism (closure 2026-10-31): snapshot/event ordering at the desktop
 * projection boundary. The product pet surface (`product/pet/src/companion-presentation.mjs`)
 * is the second UI besides the DSH main window; these tests pin the behaviour F1 requires:
 *
 *   - a duplicated event applies once and never duplicates text,
 *   - an older (out-of-order) event never rolls the projection back,
 *   - a sequence gap or a foreign Host epoch forces a snapshot resync and applies nothing,
 *   - a stale snapshot (lower seq / old epoch) never rolls the UI back,
 *   - official interaction state is never fabricated locally: interaction events only resync,
 *   - the UI never claims completion before the official turn end.
 *
 * Evidence level: pure projection boundary (no Electron, no real Host). It proves the client-side
 * deterministic rules; transport + official convergence is proven by beta2-host-kernel.spec.ts and
 * the unit suites under nisse/packages/host-integration/tests.
 */
import { describe, expect, it } from 'vitest'
import { createCompanionPresentation } from '../../../product/pet/src/companion-presentation.mjs'

type BubblePayload = { text?: string; kind?: string; title?: string; requestId?: string }
type KernelSnapshot = Record<string, unknown>
type KernelEvent = {
  protocolVersion: string
  eventId: string
  hostEpoch: string
  seq: number
  type: string
  source: string
  sessionId: string
  turn: number
  causedByCommandId: null
  at: string
  data: Record<string, unknown>
}
type Projection = ReturnType<typeof make>

function snapshot(overrides: KernelSnapshot = {}): KernelSnapshot {
  return {
    protocolVersion: 'dsh-bot-v1',
    schema: 'snapshot@1',
    hostEpoch: 'epoch-a',
    snapshotSeq: 1,
    identity: { sessionId: 's', hostPid: 99, botSessionReady: true, workspace: '/w' },
    capture: { state: 'off', mode: 'hold', captureId: null, preview: null },
    playback: { state: 'idle', playbackId: null, sourceTurnId: null, style: 'full' },
    execution: {
      state: 'idle', sessionId: 's', requestId: null, clientTurnId: null, turn: null,
      startedAt: null, inputSource: 'desktop', lastTurn: { turn: null, terminal: null, reason: null },
    },
    interactions: { focusedId: null, pending: [], drafts: {}, recentlyResolved: [], unknown: [] },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: [],
    presentation: {
      displayMode: 'idle',
      priority: ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices'],
      bubble: { visible: false, requestId: null, kind: null },
      bubblePolicy: { placement: 'above', anchorGapPx: 24 },
    },
    ...overrides,
  }
}

function make() {
  const shown: BubblePayload[] = []
  const notices: object[] = []
  const animations: object[] = []
  const commands: unknown[][] = []
  let hidden = 0
  let seq = 0
  let snapshotSeq = 0
  const timers = new Map<number, () => void>()
  const presentation = createCompanionPresentation({
    show: (payload) => { shown.push(payload as BubblePayload) },
    hide: () => { hidden += 1 },
    animate: (payload) => { animations.push(payload) },
    send: async (type: string, payload?: object) => {
      commands.push(payload === undefined ? [type] : [type, payload])
      return { protocolVersion: 'dsh-bot-v1', commandId: 'cmd', hostEpoch: 'epoch-a', status: 'accepted', result: {}, error: null }
    },
    setTimer: (fn: () => void) => { seq += 1; timers.set(seq, fn); return seq },
    clearTimer: (id: number) => { timers.delete(id) },
    publishQuestion: (view) => { if (view !== null) notices.push(view) },
  })
  return {
    presentation, shown, notices, animations, commands, timers,
    hidden: () => hidden,
    nextSnapshot(overrides: KernelSnapshot = {}) { snapshotSeq += 1; return snapshot({ snapshotSeq, ...overrides }) },
    event(type: string, data: Record<string, unknown> = {}, at: number, hostEpoch = 'epoch-a'): KernelEvent {
      return {
        protocolVersion: 'dsh-bot-v1', eventId: `e${at}`, hostEpoch, seq: at, type,
        source: 'dsh', sessionId: 's', turn: 1, causedByCommandId: null,
        at: new Date(at * 1000).toISOString(), data,
      }
    },
  }
}

function stop(projection: Projection | null | undefined): void {
  try { projection?.presentation.stop() } catch { /* already stopped */ }
}

describe('F1 desktop projection ordering rules', () => {
  it('applies a duplicated event once and never duplicates streamed text', () => {
    const projection = make()
    try {
      expect(projection.presentation.applySnapshot(projection.nextSnapshot()).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.started', { inputSource: 'voice' }, 2)).applied).toBe(true)
      drawText(projection, 3, '你')
      drawText(projection, 4, '好')
      const textAfterFirstDelivery = projection.shown.at(-1)?.text
      expect(textAfterFirstDelivery).toBe('你好')

      const duplicate = projection.presentation.applyEvent(projection.event('turn.delta', { text: '你好' }, 4))
      expect(duplicate).toMatchObject({ applied: false, duplicate: true })
      expect(projection.shown.at(-1)?.text).toBe(textAfterFirstDelivery)
      expect(projection.presentation.state().lastEventSeq).toBe(4)
    } finally { stop(projection) }
    function drawText(target: Projection, at: number, text: string): void {
      expect(target.presentation.applyEvent(target.event('turn.delta', { text }, at)).applied).toBe(true)
    }
  })

  it('ignores an out-of-order older event without rolling the projection back', () => {
    const projection = make()
    try {
      expect(projection.presentation.applySnapshot(projection.nextSnapshot()).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.started', {}, 2)).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.delta', { text: '第一段' }, 3)).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.delta', { text: '第二段' }, 4)).applied).toBe(true)
      const before = projection.presentation.state()
      const shownBefore = projection.shown.at(-1)?.text
      const late = projection.presentation.applyEvent(projection.event('turn.delta', { text: '迟到片段' }, 2))
      expect(late).toMatchObject({ applied: false, duplicate: true })
      expect(projection.presentation.state().lastEventSeq).toBe(before.lastEventSeq)
      expect(projection.presentation.state().snapshotSeq).toBe(before.snapshotSeq)
      expect(projection.shown.at(-1)?.text).toBe(shownBefore)
      expect(projection.shown.at(-1)?.text).not.toContain('迟到片段')
    } finally { stop(projection) }
  })

  it('forces a resync on a sequence gap and applies nothing from the gapped event', () => {
    const projection = make()
    try {
      expect(projection.presentation.applySnapshot(projection.nextSnapshot()).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.started', {}, 2)).applied).toBe(true)
      const shownBefore = projection.shown.length
      const gap = projection.presentation.applyEvent(projection.event('turn.delta', { text: '缺口事件' }, 9))
      expect(gap).toMatchObject({ applied: false, resync: true, reason: 'gap' })
      expect(projection.shown.length).toBe(shownBefore)
      expect(projection.presentation.state().lastEventSeq).toBe(2)
      // A fresh snapshot re-bases the cursor; the following contiguous event applies again.
      expect(projection.presentation.applySnapshot(projection.nextSnapshot({ snapshotSeq: 9 })).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.delta', { text: '继续' }, 10)).applied).toBe(true)
      expect(projection.shown.at(-1)?.text).toContain('继续')
    } finally { stop(projection) }
  })

  it('rejects events and snapshots from a foreign or older Host epoch', () => {
    const projection = make()
    try {
      const first = projection.nextSnapshot()
      expect(projection.presentation.applySnapshot(first).applied).toBe(true)
      const shownBefore = projection.shown.length
      const foreign = projection.presentation.applyEvent(projection.event('turn.delta', { text: '旧 epoch' }, 2, 'epoch-stale'))
      expect(foreign).toMatchObject({ applied: false, resync: true, reason: 'epoch' })
      expect(projection.shown.length).toBe(shownBefore)

      // A late replay of the old epoch snapshot must not roll the UI back.
      expect(projection.presentation.applySnapshot(projection.nextSnapshot({ hostEpoch: 'epoch-b', snapshotSeq: 5 })).applied).toBe(true)
      const afterEpochChange = projection.presentation.state().hostEpoch
      expect(afterEpochChange).toBe('epoch-b')
      expect(projection.presentation.applySnapshot({ ...first, hostEpoch: 'epoch-a', snapshotSeq: 99 }).applied).toBe(false)
      expect(projection.presentation.state().hostEpoch).toBe('epoch-b')
      expect(projection.presentation.state().snapshotSeq).toBeLessThan(99)
      // An older snapshot of the current epoch is stale but harmless.
      const stale = projection.presentation.applySnapshot({ ...snapshot({ hostEpoch: 'epoch-b' }), snapshotSeq: 1 })
      expect(stale.applied).toBe(false)
    } finally { stop(projection) }
  })

  it('never fabricates official interaction state: interaction events only request a resync', () => {
    const projection = make()
    try {
      expect(projection.presentation.applySnapshot(projection.nextSnapshot()).applied).toBe(true)
      for (const type of ['interaction.requested', 'interaction.resolved', 'interaction.expired', 'interaction.unknown', 'interactions.changed']) {
        const result = projection.presentation.applyEvent(projection.event(type, { id: 'interaction-1' }, 2))
        expect(result, type).toMatchObject({ applied: false, resync: true })
      }
      // None of those events created a local waiting surface or a fabricated decision.
      expect(projection.presentation.state().waiting).toBe(false)
      expect(projection.commands).toEqual([])
    } finally { stop(projection) }
  })

  it('never claims completion before the official turn end', () => {
    const projection = make()
    try {
      expect(projection.presentation.applySnapshot(projection.nextSnapshot()).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.started', { inputSource: 'voice' }, 2)).applied).toBe(true)
      expect(projection.presentation.applyEvent(projection.event('turn.delta', { text: '正在处理' }, 3)).applied).toBe(true)
      // Mid-turn the surface reports work in progress, not completion.
      expect(projection.presentation.state().working).toBe(true)
      expect(projection.shown.at(-1)?.text).toBe('正在处理')
      expect(completionWords(projection.shown)).toBe(false)

      // A failed/interrupted official terminal must surface an actionable notice, not success.
      expect(projection.presentation.applyEvent(projection.event('turn.ended', { terminal: 'interrupted', reason: { kind: 'interrupted' } }, 4)).applied).toBe(true)
      expect(projection.presentation.state().working).toBe(false)
      const failureText = projection.shown.map(item => String(item?.text ?? '')).join('\n')
      expect(failureText).toMatch(/未完成|未知|检查|恢复/)
      expect(failureText).not.toMatch(/已完成/)
    } finally { stop(projection) }
    function completionWords(shown: BubblePayload[]): boolean {
      return shown.some(item => /任务完成|已完成|全部完成/.test(String(item?.text ?? '')))
    }
  })
})
