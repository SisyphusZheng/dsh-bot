/** Mirrors official DSH requests; the official waterfall still owns each decision. */
import { randomUUID } from 'node:crypto'

function invalid(message) {
  return Object.assign(new Error(message), { code: 'BAD_ANSWER' })
}

/** Validate a complete answer batch at the local HTTP boundary. */
export function validateAnswer(questions, value) {
  if (!value || !Array.isArray(value.answers) || value.answers.length !== questions.length) throw invalid('Answer every question exactly once')
  const ids = new Set()
  const answers = value.answers.map(answer => {
    if (!answer || typeof answer.id !== 'string' || ids.has(answer.id)) throw invalid('Invalid or repeated question id')
    ids.add(answer.id)
    const question = questions.find(q => q.id === answer.id)
    if (!question || !Array.isArray(answer.selected) || answer.selected.some(x => typeof x !== 'string')) throw invalid('Invalid selection')
    const selected = [...new Set(answer.selected)]
    if (selected.length !== answer.selected.length || (!question.multiSelect && selected.length > 1)) throw invalid('Invalid selection count')
    if (selected.some(label => !question.options?.some(option => option.label === label))) throw invalid('Unknown option')
    if (answer.custom !== undefined && (typeof answer.custom !== 'string' || answer.custom.length > 20000)) throw invalid('Invalid custom answer')
    const custom = answer.custom?.trim()
    return { id: answer.id, selected, ...(custom ? { custom } : {}) }
  })
  return { answers }
}

/** One bridge instance, with private requests and a cancellation lifetime for both UIs. */
export function createInteractionMirror({
  forward,
  emit,
  userQuestions,
  approvalTimeoutMs = 120000,
  hasLocalUi = () => true,
  noAnswererGraceMs = 750,
}) {
  const pending = new Map()
  const forwarded = new WeakSet()
  /** Observers the product InteractionRegistry subscribes to (see kernel spec §3.4). */
  const requestListeners = new Set()
  const settleListeners = new Set()
  let disposed = false
  function notify(listeners, payload) {
    for (const listener of [...listeners]) {
      try { listener(payload) } catch { /* an observer must never break the mirror */ }
    }
  }
  const view = request => ({
    id: request.id, kind: request.kind, sessionId: request.sessionId,
    ...(request.kind === 'question' ? { questions: request.source.questions, callId: request.source.wait?.callId }
      : { toolName: request.source.toolName, reason: request.source.reason || '', callId: request.source.callId, ...(request.source.operation ? { operation: request.source.operation } : {}) }),
  })
  return {
    isForwarded: request => forwarded.has(request),
    snapshot: () => [...pending.values()].map(view),
    /** Observe every new official request this mirror starts presenting. */
    subscribeRequests(listener) {
      if (typeof listener !== 'function') return () => {}
      requestListeners.add(listener)
      return () => requestListeners.delete(listener)
    },
    /** Observe every settlement of an official request (answer, timeout, cancel, official close). */
    subscribeSettled(listener) {
      if (typeof listener !== 'function') return () => {}
      settleListeners.add(listener)
      return () => settleListeners.delete(listener)
    },
    /**
     * Withdraw one presented request because its product lifetime ended (expiry).
     * The official answerer then fails closed through its own lifetime; this never
     * fabricates an official decision.
     */
    expire(id) {
      const item = pending.get(id)
      if (!item) return false
      item.finish(null, 'expired')
      return true
    },
    cancel(sessionId) {
      for (const item of [...pending.values()]) if (!sessionId || item.sessionId === sessionId) item.finish(null, 'cancelled')
    },
    dispose() {
      disposed = true
      for (const item of [...pending.values()]) item.finish(null, 'cancelled')
    },
    answer(id, sessionId, value) {
      const item = pending.get(id)
      if (!item || item.sessionId !== sessionId) return false
      const answer = item.kind === 'question' ? validateAnswer(item.source.questions, value) : value
      if (item.kind === 'approval' && !['allowed-once', 'rejected'].includes(answer)) throw invalid('Invalid approval decision')
      item.finish(answer, 'local')
      return true
    },
    async ask(kind, source) {
      if (disposed || source.signal?.aborted) {
        if (kind === 'approval') return 'cancelled'
        throw Object.assign(new Error('Question cancelled'), { code: 'ASK_ABORTED' })
      }
      const id = randomUUID(), controller = new AbortController()
      let resolve, reject, timer, noAnswererTimer
      const result = new Promise((yes, no) => { resolve = yes; reject = no })
      const abort = () => item.finish(null, 'aborted')
      const item = {
        id, kind, source, sessionId: String(source.agent.session.id),
        /**
         * Settle once. `reason` records who ended the official lifetime:
         * 'local' (pet/voice/HTTP decision), 'official' (another official answerer
         * decided), 'aborted' (asking turn cancelled), 'timeout', 'expired',
         * 'cancelled', 'official-closed' (the official timed wait closed), or
         * 'no-answerer'. Observers use it to distinguish a real official result
         * from a fail-closed product timeout.
         */
        finish(answer, reason = 'local') {
          if (!pending.delete(id)) return
          clearTimeout(timer)
          clearTimeout(noAnswererTimer)
          source.signal?.removeEventListener('abort', abort)
          controller.abort()
          emit(kind === 'approval' ? 'approval.decided' : 'question.decided', {
            sessionId: item.sessionId, data: { id, outcome: answer === null ? 'cancelled' : kind === 'approval' ? answer : 'answered' },
          })
          notify(settleListeners, {
            kind, id, sessionId: item.sessionId, reason, source, view: view(item),
            outcome: answer === null ? null : kind === 'approval' ? answer : 'answered',
            answer,
          })
          if (answer !== null) resolve(answer)
          else if (kind === 'approval') resolve('cancelled')
          else reject(Object.assign(new Error('Question cancelled'), { code: 'ASK_ABORTED' }))
        },
      }
      pending.set(id, item)
      source.signal?.addEventListener('abort', abort, { once: true })
      if (kind === 'approval') timer = setTimeout(() => item.finish(null, 'timeout'), approvalTimeoutMs)
      const copy = { ...source, signal: controller.signal }
      forwarded.add(copy)
      emit(kind === 'approval' ? 'approval.request' : 'question.request', { sessionId: item.sessionId, data: view(item) })
      notify(requestListeners, { kind, id, sessionId: item.sessionId, source, view: view(item) })
      // A timed question must be held through the official service while the pet presents it.
      const claim = kind === 'question' && source.wait?.timed
        ? userQuestions()?.attachWait(source.agent, source.wait.callId, controller.signal) : null
      if (claim) void (async () => {
        try { for await (const frame of claim) { if (!frame) break } }
        finally { if (pending.has(id)) item.finish(null, 'official-closed') }
      })().catch(() => item.finish(null, 'official-closed'))
      void Promise.resolve().then(() => forward(kind === 'approval' ? 'approval/request' : 'user-questions/request', copy)).then(answer => {
        if (!pending.has(id)) return
        if (kind === 'approval') {
          if (['allowed-once', 'rejected', 'cancelled'].includes(answer)) item.finish(answer === 'cancelled' ? null : answer, 'official')
        } else item.finish(validateAnswer(source.questions, answer), 'official')
      }).catch(() => {
        // The official waterfall reports "No DSH answerer". If the pet UI is also not
        // connected, fail closed after a short grace instead of holding the Agent for
        // the full approval timeout. A late pet connection inside the grace still wins.
        if (hasLocalUi()) return
        noAnswererTimer = setTimeout(() => {
          if (!hasLocalUi() && pending.has(id)) item.finish(null, 'no-answerer')
        }, Math.max(0, Number(noAnswererGraceMs) || 0))
      })
      return result
    },
  }
}
