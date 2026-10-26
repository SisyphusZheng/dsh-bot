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
export function createInteractionMirror({ forward, emit, userQuestions, approvalTimeoutMs = 120000 }) {
  const pending = new Map()
  const forwarded = new WeakSet()
  let disposed = false
  const view = request => ({
    id: request.id, kind: request.kind, sessionId: request.sessionId,
    ...(request.kind === 'question' ? { questions: request.source.questions, callId: request.source.wait?.callId }
      : { toolName: request.source.toolName, reason: request.source.reason || '', callId: request.source.callId }),
  })
  return {
    isForwarded: request => forwarded.has(request),
    snapshot: () => [...pending.values()].map(view),
    cancel(sessionId) {
      for (const item of [...pending.values()]) if (!sessionId || item.sessionId === sessionId) item.finish(null)
    },
    dispose() {
      disposed = true
      for (const item of [...pending.values()]) item.finish(null)
    },
    answer(id, sessionId, value) {
      const item = pending.get(id)
      if (!item || item.sessionId !== sessionId) return false
      const answer = item.kind === 'question' ? validateAnswer(item.source.questions, value) : value
      if (item.kind === 'approval' && !['allowed-once', 'rejected'].includes(answer)) throw invalid('Invalid approval decision')
      item.finish(answer)
      return true
    },
    async ask(kind, source) {
      if (disposed || source.signal?.aborted) {
        if (kind === 'approval') return 'cancelled'
        throw Object.assign(new Error('Question cancelled'), { code: 'ASK_ABORTED' })
      }
      const id = randomUUID(), controller = new AbortController()
      let resolve, reject, timer
      const result = new Promise((yes, no) => { resolve = yes; reject = no })
      const abort = () => item.finish(null)
      const item = {
        id, kind, source, sessionId: String(source.agent.session.id),
        finish(answer) {
          if (!pending.delete(id)) return
          clearTimeout(timer)
          source.signal?.removeEventListener('abort', abort)
          controller.abort()
          emit(kind === 'approval' ? 'approval.decided' : 'question.decided', {
            sessionId: item.sessionId, data: { id, outcome: answer === null ? 'cancelled' : kind === 'approval' ? answer : 'answered' },
          })
          if (answer !== null) resolve(answer)
          else if (kind === 'approval') resolve('cancelled')
          else reject(Object.assign(new Error('Question cancelled'), { code: 'ASK_ABORTED' }))
        },
      }
      pending.set(id, item)
      source.signal?.addEventListener('abort', abort, { once: true })
      if (kind === 'approval') timer = setTimeout(abort, approvalTimeoutMs)
      const copy = { ...source, signal: controller.signal }
      forwarded.add(copy)
      emit(kind === 'approval' ? 'approval.request' : 'question.request', { sessionId: item.sessionId, data: view(item) })
      // A timed question must be held through the official service while the pet presents it.
      const claim = kind === 'question' && source.wait?.timed
        ? userQuestions()?.attachWait(source.agent, source.wait.callId, controller.signal) : null
      if (claim) void (async () => {
        try { for await (const frame of claim) { if (!frame) break } }
        finally { if (pending.has(id)) item.finish(null) }
      })().catch(() => item.finish(null))
      void Promise.resolve().then(() => forward(kind === 'approval' ? 'approval/request' : 'user-questions/request', copy)).then(answer => {
        if (!pending.has(id)) return
        if (kind === 'approval') {
          if (['allowed-once', 'rejected', 'cancelled'].includes(answer)) item.finish(answer === 'cancelled' ? null : answer)
        } else item.finish(validateAnswer(source.questions, answer))
      }).catch(() => {
        // No connected DSH answerer leaves the pet as the live UI; cancellation ends both.
      })
      return result
    },
  }
}
