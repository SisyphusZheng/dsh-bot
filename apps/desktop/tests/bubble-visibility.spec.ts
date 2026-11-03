import { expect, it } from 'vitest'
import { createCompanionPresentation } from '../../../product/pet/src/companion-presentation.mjs'
import { onboardingOwnsBubble, presentationMayHideBubble } from '../src/bubble-visibility.ts'

it('lets the onboarding overlay own the bubble only when nothing blocks the agent', () => {
  expect(onboardingOwnsBubble(true, false)).toBe(true)
  expect(onboardingOwnsBubble(true, true)).toBe(false)
  expect(onboardingOwnsBubble(false, false)).toBe(false)
  expect(onboardingOwnsBubble(false, true)).toBe(false)
})

it('lets the presentation hide the bubble during onboarding only when it shows an interaction', () => {
  expect(presentationMayHideBubble(true, false)).toBe(false)
  expect(presentationMayHideBubble(true, true)).toBe(true)
  expect(presentationMayHideBubble(false, false)).toBe(true)
  expect(presentationMayHideBubble(false, true)).toBe(true)
})

function snapshot(pending: { id?: string }[]) {
  return {
    protocolVersion: 'dsh-bot-v1', schema: 'snapshot@1', hostEpoch: 'epoch-a', snapshotSeq: 1,
    identity: { sessionId: 's', hostPid: 1, botSessionReady: true, workspace: '/w' },
    capture: { state: 'off', mode: 'hold', captureId: null, preview: null },
    playback: { state: 'idle', playbackId: null, sourceTurnId: null, style: 'full' },
    execution: { state: 'idle', sessionId: 's', requestId: null, clientTurnId: null, turn: null, startedAt: null, inputSource: 'desktop', lastTurn: { turn: null, terminal: null, reason: null } },
    interactions: { focusedId: null, pending, drafts: {}, recentlyResolved: [] },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: [],
    presentation: {
      displayMode: pending.length > 0 ? 'awaiting-input' : 'idle',
      priority: ['interactions', 'inputDraft', 'queue', 'execution', 'playback', 'notices'],
      bubble: { visible: pending.length > 0, requestId: pending[0]?.id ?? null, kind: pending.length > 0 ? 'approval' : null },
      bubblePolicy: { placement: 'above', anchorGapPx: 24 },
    },
  }
}

const approval = { id: 'a-1', kind: 'approval', sessionId: 's', toolName: 'bash', semanticRevision: 1, reason: 'bash outside workspace: /tmp/x' }

type PresentationLike = {
  applySnapshot(snapshot: object): { applied?: boolean }
  state?: () => { waiting?: boolean }
}

function mount(owns: (onboarding: boolean, waiting: boolean) => boolean) {
  const shown: { kind?: string; requestId?: string }[] = []
  // The show callback closes over this binding; it only runs after construction returns.
  const presentation: PresentationLike = createCompanionPresentation({
    show: (payload: { kind?: string; requestId?: string }) => {
      const waiting = presentation?.state?.().waiting === true
      if (owns(true, waiting)) return
      shown.push(payload)
    },
    hide: () => {},
    animate: () => {},
    send: async () => ({}),
    setTimer: () => 0,
    clearTimer: () => {},
  })
  return { presentation, shown }
}

it('the old onboarding-only gate swallows an approval that arrives mid-onboarding', () => {
  // Documents the defect: `onboarding` alone suppresses the approval payload before the overlay
  // learns that a request is pending, and the presentation then caches it as already shown.
  const { presentation, shown } = mount(onboarding => onboarding)
  presentation.applySnapshot(snapshot([approval]))
  expect(shown).toHaveLength(0)
})

it('the fixed gate shows an approval that arrives mid-onboarding', () => {
  const { presentation, shown } = mount(onboardingOwnsBubble)
  expect(presentation.applySnapshot(snapshot([approval])).applied).toBe(true)
  expect(shown.map(payload => payload.requestId)).toContain('a-1')
})
