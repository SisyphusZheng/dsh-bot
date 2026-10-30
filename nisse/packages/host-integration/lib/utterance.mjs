/**
 * Host speech assembly and deterministic utterance routing (beta2 kernel v1 §3.5).
 *
 * Two independent, side-effect-free-on-import units:
 *
 * 1. `createUtteranceAssembler` owns the submission boundary over ASR/capture facts:
 *    partials are preview only, finals are merged per capture/utterance identity,
 *    duplicate provider items are deduplicated, cumulative revisions never repeat
 *    words, hold captures stay closed until release and then wait a bounded drain,
 *    toggle/always captures settle on a quiet window, and everything that arrives
 *    after the boundary becomes an inspectable late record instead of a second task.
 *
 * 2. `createSegmenter` routes one utterance text into exactly one path per segment:
 *    control | interaction-answer | input | ignore. Only exact leading control
 *    phrases followed by a sentence separator may split an utterance into more
 *    than one segment (plan §5.3). Negation, quotation and hypothetical forms stay
 *    ordinary input; an attempted-but-ambiguous interaction answer is rejected for
 *    clarification and never falls through to a new task. No LLM, no keyword
 *    truncation.
 *
 * Authority boundary: this module never touches DSH, the filesystem or the
 * network, and owns no official interaction decision. It only assembles product
 * utterances and classifies text; the ConversationService/Registry executes.
 */
import { newId as contractNewId, stableOptionId } from './contracts.mjs'

export const SETTLE_MS_DEFAULT = 650
export const DRAIN_MS_DEFAULT = 3000
export const MAX_CHARS_DEFAULT = 20000
export const MODES = Object.freeze(['hold', 'toggle', 'always'])

/** Control values emitted by the segmenter (see Lead integration API). */
export const CONTROL_VALUES = Object.freeze([
  'playback-stop',
  'playback-brief',
  'playback-full',
  'task-stop',
  'task-status',
  'cancel-capture',
  'approval-allow',
  'approval-reject',
])
/** Alias used by ConversationService integration (same frozen union). */
export const CONTROL_KINDS = CONTROL_VALUES

function modelError(code, message, status = 400) {
  const error = new Error(message)
  error.code = code
  error.status = status
  return error
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function assertTunable(name, value, min, max) {
  if (!isFiniteNumber(value) || value < min || value > max) {
    throw modelError('INVALID_TUNABLE', `${name} must be a finite number between ${min} and ${max}`)
  }
  return value
}

function assertFunction(name, value) {
  if (typeof value !== 'function') throw modelError('INVALID_TUNABLE', `${name} must be a function`)
  return value
}

function pushBounded(list, value, max) {
  list.push(value)
  if (list.length > max) list.splice(0, list.length - max)
}

function copy(value) {
  return value === null || value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function normalizeMode(value, { fallback = null } = {}) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string' || !MODES.includes(value)) {
    throw modelError('INVALID_MODE', `input mode must be one of ${MODES.join(', ')}`)
  }
  return value
}

function confidenceOf(value) {
  // ASR confidence is nullable and provider-owned: missing/unknown stays unknown,
  // never fabricated into a high local score.
  if (!isFiniteNumber(value)) return null
  if (value < 0 || value > 1) return null
  return value
}

/** Longest k such that `suffix` ends with `prefixText.slice(0, k)`. */
function suffixPrefixOverlap(suffix, prefixText) {
  const max = Math.min(suffix.length, prefixText.length)
  for (let k = max; k > 0; k -= 1) {
    if (suffix.endsWith(prefixText.slice(0, k))) return k
  }
  return 0
}

/**
 * Merge accepted provider finals into one utterance text and per-item segments.
 * Cumulative revisions (provider echoes the previous text) contribute only the
 * new suffix, so the same words never appear twice. Segment spans are offsets in
 * the merged text; every segment keeps its provider item ids and revision.
 */
export function mergeFinalItems(items) {
  let text = ''
  const segments = []
  for (const item of items) {
    const source = item.text
    let contribution = ''
    if (text.length > 0) {
      if (text.endsWith(source)) {
        contribution = ''
      } else {
        const overlap = suffixPrefixOverlap(text, source)
        contribution = source.slice(overlap)
      }
    } else {
      contribution = source
    }
    const start = text.length
    text += contribution
    segments.push({
      segmentId: item.segmentId,
      text: contribution,
      itemIds: [item.itemId],
      itemId: item.itemId,
      revision: item.revision,
      providerText: source,
      span: [start, text.length],
      confidence: item.confidence,
      itemKind: 'asr.final',
    })
  }
  if (text !== text.trim()) {
    // Keep spans meaningful after trimming provider edge whitespace once.
    const trimmed = text.trim()
    const leading = text.length - text.trimStart().length
    if (trimmed !== text) {
      const offset = (start) => Math.max(0, Math.min(trimmed.length, start - leading))
      for (const segment of segments) segment.span = [offset(segment.span[0]), offset(segment.span[1])]
      text = trimmed
    }
  }
  if (segments.length > 0) {
    segments[segments.length - 1].span[1] = text.length
  }
  return { text, segments }
}

/* ------------------------------------------------------------------------- */
/* Utterance assembler                                                        */
/* ------------------------------------------------------------------------- */

/**
 * @param {object} options
 * @param {number} options.settleMs  quiet window after the last fact before submission
 * @param {number} options.drainMs   hard deadline after release for late finals
 * @param {() => number} options.now  monotonic-ish epoch-ms clock (injectable)
 * @param {number} options.maxChars  maximum assembled utterance length
 */
export function createUtteranceAssembler({
  settleMs = SETTLE_MS_DEFAULT,
  drainMs = DRAIN_MS_DEFAULT,
  now = () => Date.now(),
  maxChars = MAX_CHARS_DEFAULT,
  newId = contractNewId,
  maxActiveCaptures = 16,
  maxGroupsPerCapture = 16,
  maxUtteranceMs = 120000,
  captureRetention = 256,
} = {}) {
  assertTunable('settleMs', settleMs, 1, 10000)
  assertTunable('drainMs', drainMs, 1, 120000)
  assertTunable('maxChars', maxChars, 1, 200000)
  assertTunable('maxActiveCaptures', maxActiveCaptures, 1, 256)
  assertTunable('maxGroupsPerCapture', maxGroupsPerCapture, 1, 256)
  assertTunable('maxUtteranceMs', maxUtteranceMs, 1, 3600000)
  assertTunable('captureRetention', captureRetention, 8, 4096)
  assertFunction('now', now)
  assertFunction('newId', newId)

  const finishedRetention = Math.max(8, Math.min(1024, captureRetention))
  const discardedRetention = Math.max(8, Math.min(1024, captureRetention))
  const lateRetention = 128
  const emittedRetention = 128

  /** @type {Map<string, object>} */
  let captures = new Map()
  /** Discarded capture tombstones: a discarded capture must never flush later. */
  let discardedCaptures = new Map()
  /** Recently finished captures keep enough identity to reject/annotate late facts. */
  let finishedCaptures = new Map()
  let emitted = []
  let lateRecords = []
  let pendingLate = []
  let anonymousItems = 0
  let droppedRecords = []
  let counters = { facts: 0, acceptedFinals: 0, duplicates: 0, late: 0, emitted: 0, discarded: 0, rejected: 0 }

  function clock() {
    const value = now()
    if (!isFiniteNumber(value)) throw modelError('INVALID_CLOCK', 'now() must return a finite epoch-ms number')
    return value
  }

  function makeCapture(captureId, mode, t) {
    return {
      captureId,
      mode: mode || null,
      state: 'open', // open | closing | finished | discarded
      createdAt: t,
      releasedAt: null,
      drainDeadline: null,
      finishedAt: null,
      discardedAt: null,
      groups: new Map(),
      activeKey: null,
      lastUtteranceId: null,
      finishedUtteranceIds: [],
      seenItems: new Map(), // itemId -> {utteranceId, revision, text, kind, emitted}
    }
  }

  function activeCaptureCount() {
    let count = 0
    for (const capture of captures.values()) {
      if (capture.state === 'open' || capture.state === 'closing') count += 1
    }
    return count
  }

  function resolveMode(contextMode, capture) {
    const requested = normalizeMode(contextMode, { fallback: null })
    if (capture && capture.mode) {
      if (requested && requested !== capture.mode) {
        return { conflict: true, mode: capture.mode }
      }
      return { conflict: false, mode: capture.mode }
    }
    const mode = requested || capture?.mode || 'hold'
    if (capture && !capture.mode) capture.mode = mode
    return { conflict: false, mode }
  }

  function groupKeyFor(fact, capture, mode) {
    if (mode === 'hold') return 'hold'
    if (fact.utteranceId) return fact.utteranceId
    const t = clock()
    const current = capture.activeKey ? capture.groups.get(capture.activeKey) : null
    if (current && t - current.lastActivityAt <= settleMs) return capture.activeKey
    const key = 'utt_' + newId()
    capture.activeKey = key
    return key
  }

  function makeGroup(capture, utteranceId, mode, t) {
    return {
      utteranceId,
      captureId: capture.captureId,
      mode,
      createdAt: t,
      lastActivityAt: t,
      lastFinalAt: null,
      items: [],
      itemById: new Map(),
      partial: null,
      partialRevision: -1,
      conflicts: [],
      needsConfirmation: mode === 'always',
      sawFinal: false,
    }
  }

  function recordLate(fact, capture, t, reason, utteranceId) {
    counters.late += 1
    const record = {
      captureId: fact.captureId,
      utteranceId: utteranceId || fact.utteranceId || null,
      itemId: fact.itemId,
      revision: fact.revision,
      kind: fact.kind,
      text: fact.text,
      at: t,
      reason,
      boundaryUtteranceId: capture?.lastUtteranceId || null,
    }
    pushBounded(lateRecords, record, lateRetention)
    // Deliver each late final once so the ConversationService can surface it as a
    // pending-inspection item (draft/notice); it must never be queued as a task.
    const key = `${record.captureId}\u0000${record.itemId}\u0000${record.revision}\u0000${record.text}`
    if (!pendingLate.some((entry) => entry.key === key)) {
      pushBounded(pendingLate, { key, record: { ...record, mode: capture?.mode || 'hold' } }, 32)
    }
    return { accepted: false, duplicate: false, late: true, utteranceId: record.utteranceId, reason }
  }

  function recordDrop(capture, group, reason, t) {
    pushBounded(droppedRecords, {
      captureId: capture.captureId,
      utteranceId: group.utteranceId,
      reason,
      at: t,
      segmentCount: group.items.length,
      chars: group.items.reduce((sum, item) => sum + item.text.length, 0),
      needsConfirmation: group.mode === 'always' || group.conflicts.length > 0,
    }, lateRetention)
  }

  function normalizeFact(item, context) {
    if (!item || typeof item !== 'object') throw modelError('INVALID_FACT', 'speech fact must be an object')
    const kind = item.kind
    if (kind !== 'asr.partial' && kind !== 'asr.final') {
      throw modelError('INVALID_FACT', 'speech fact kind must be asr.partial or asr.final')
    }
    if (typeof item.captureId !== 'string' || item.captureId.trim() === '') {
      throw modelError('INVALID_FACT', 'speech fact captureId is required')
    }
    if (typeof item.text !== 'string') throw modelError('INVALID_FACT', 'speech fact text must be a string')
    if (item.text.length > maxChars) {
      throw modelError('UTTERANCE_TOO_LARGE', `speech input exceeds ${maxChars} characters`)
    }
    let revision = item.revision === undefined || item.revision === null ? 0 : item.revision
    if (!Number.isInteger(revision) || revision < 0) {
      throw modelError('INVALID_FACT', 'speech fact revision must be a non-negative integer')
    }
    const utteranceId = typeof item.utteranceId === 'string' && item.utteranceId.trim() !== ''
      ? item.utteranceId.trim()
      : null
    const itemId = typeof item.itemId === 'string' && item.itemId.trim() !== '' ? item.itemId.trim() : null
    return {
      kind,
      captureId: item.captureId.trim(),
      utteranceId,
      // The v1 protocol requires a provider itemId. If a legacy caller omits it,
      // invent a per-fact anonymous identity instead of a revision-derived one so
      // distinct finals are never mistaken for conflicting revisions of one item.
      itemId: itemId || 'anon:' + String((anonymousItems += 1)),
      text: item.text,
      revision,
      confidence: confidenceOf(item.confidence),
      context: context || {},
    }
  }

  function findOrCreateCapture(fact, requestedMode, t) {
    const existing = captures.get(fact.captureId)
    if (existing) return { capture: existing, created: false }
    const mode = normalizeMode(requestedMode, { fallback: null }) || 'hold'
    if (activeCaptureCount() >= maxActiveCaptures) return { capture: null, created: false }
    const capture = makeCapture(fact.captureId, mode, t)
    captures.set(capture.captureId, capture)
    return { capture, created: true }
  }

  function appendOrUpdateItem(group, fact, t) {
    const existing = group.itemById.get(fact.itemId)
    if (existing) {
      if (fact.revision < existing.revision) {
        group.conflicts.push({ itemId: fact.itemId, reason: 'stale-revision', revision: fact.revision, knownRevision: existing.revision })
        return { accepted: false, reason: 'stale-revision', conflict: true }
      }
      if (fact.revision === existing.revision) {
        if (fact.text === existing.text) return { accepted: false, duplicate: true, reason: 'duplicate-item' }
        group.conflicts.push({ itemId: fact.itemId, reason: 'conflicting-revision', revision: fact.revision })
        return { accepted: false, reason: 'conflicting-revision', conflict: true }
      }
      // Higher revision: provider correction/extension of this item.
      if (itemTextLength(group, { ...existing, text: fact.text }) > maxChars) {
        throw modelError('UTTERANCE_TOO_LARGE', `speech input exceeds ${maxChars} characters`)
      }
      existing.text = fact.text
      existing.revision = fact.revision
      existing.confidence = fact.confidence
      existing.updatedAt = t
      group.needsConfirmation = true // a contradictory revision always needs confirmation
      return { accepted: true, updated: true }
    }
    if (itemTextLength(group, fact) > maxChars) {
      throw modelError('UTTERANCE_TOO_LARGE', `speech input exceeds ${maxChars} characters`)
    }
    const item = {
      segmentId: `${group.utteranceId}:${fact.itemId}`,
      itemId: fact.itemId,
      revision: fact.revision,
      text: fact.text,
      confidence: fact.confidence,
      at: t,
    }
    group.items.push(item)
    group.itemById.set(item.itemId, item)
    return { accepted: true, created: true }
  }

  function itemTextLength(group, candidate) {
    // Conservative bound: cumulative provider text may include previous words, so
    // the merged length is at most the sum; enforce the cap per provider item too.
    let sum = candidate.text.length
    for (const item of group.items) {
      if (item.itemId !== candidate.itemId) sum += item.text.length
    }
    return sum
  }

  function handleFinal(capture, fact, mode, t) {
    const key = groupKeyFor(fact, capture, mode)
    let group = capture.groups.get(key)
    if (!group) {
      if (capture.groups.size >= maxGroupsPerCapture) {
        counters.rejected += 1
        return { accepted: false, duplicate: false, reason: 'capacity', utteranceId: null }
      }
      const utteranceId = fact.utteranceId || (key === 'hold' ? 'utt_' + newId() : key)
      group = makeGroup(capture, utteranceId, mode, t)
      capture.groups.set(key, group)
      if (mode !== 'hold') capture.activeKey = key
    }
    group.lastActivityAt = t
    group.lastFinalAt = t
    group.partial = null
    const result = appendOrUpdateItem(group, fact, t)
    if (!result.accepted) return { ...result, utteranceId: group.utteranceId }
    group.sawFinal = true
    if (mode === 'always') group.needsConfirmation = true
    counters.acceptedFinals += 1
    const record = capture.seenItems.get(fact.itemId)
    const entry = { utteranceId: group.utteranceId, revision: fact.revision, text: fact.text, kind: 'asr.final', emitted: false }
    if (record) Object.assign(record, entry)
    else capture.seenItems.set(fact.itemId, entry)
    if (capture.seenItems.size > 1024) capture.seenItems.delete(capture.seenItems.keys().next().value)
    return { accepted: true, duplicate: false, reason: result.updated ? 'revision-updated' : 'final', utteranceId: group.utteranceId }
  }

  function handlePartial(capture, fact, mode, t) {
    const key = groupKeyFor(fact, capture, mode)
    let group = capture.groups.get(key)
    if (!group) {
      if (capture.groups.size >= maxGroupsPerCapture) {
        counters.rejected += 1
        return { accepted: false, duplicate: false, reason: 'capacity', utteranceId: null }
      }
      const utteranceId = fact.utteranceId || (key === 'hold' ? 'utt_' + newId() : key)
      group = makeGroup(capture, utteranceId, mode, t)
      capture.groups.set(key, group)
      if (mode !== 'hold') capture.activeKey = key
    }
    const knownFinal = group.itemById.get(fact.itemId)
    if (knownFinal && fact.revision <= knownFinal.revision) {
      counters.rejected += 1
      return { accepted: false, duplicate: false, reason: 'partial-after-final', utteranceId: group.utteranceId }
    }
    if (group.partial && group.partial.revision === fact.revision && group.partial.text === fact.text) {
      counters.duplicates += 1
      return { accepted: false, duplicate: true, reason: 'duplicate-partial', utteranceId: group.utteranceId }
    }
    if (!group.partial || fact.revision >= group.partial.revision) {
      group.partial = { text: fact.text, revision: fact.revision, at: t }
      group.partialRevision = fact.revision
    }
    // A partial only extends activity/preview; it never creates a submittable segment.
    group.lastActivityAt = t
    return { accepted: true, duplicate: false, reason: 'partial-preview', utteranceId: group.utteranceId }
  }

  /**
   * Receive one ASR fact.
   * @param {object} item {kind, captureId, utteranceId, itemId, revision, text, confidence}
   * @param {{mode?: string}} [context]
   * @returns {{accepted: boolean, duplicate: boolean, utteranceId: string|null, reason: string, late?: boolean}}
   */
  function fact(item, context = {}) {
    const parsed = normalizeFact(item, context)
    const t = clock()
    counters.facts += 1

    const tombstone = discardedCaptures.get(parsed.captureId)
    if (tombstone) {
      counters.rejected += 1
      pushBounded(lateRecords, {
        captureId: parsed.captureId,
        utteranceId: parsed.utteranceId,
        itemId: parsed.itemId,
        revision: parsed.revision,
        kind: parsed.kind,
        text: parsed.text,
        at: t,
        reason: 'discarded-capture',
        boundaryUtteranceId: null,
      }, lateRetention)
      return { accepted: false, duplicate: false, late: true, utteranceId: null, reason: 'discarded-capture' }
    }

    const { capture } = findOrCreateCapture(parsed, context.mode, t)
    if (!capture) {
      counters.rejected += 1
      return { accepted: false, duplicate: false, utteranceId: null, reason: 'capacity' }
    }
    const modeResolution = resolveMode(context.mode, capture)
    if (modeResolution.conflict) {
      counters.rejected += 1
      return { accepted: false, duplicate: false, utteranceId: null, reason: 'mode-conflict' }
    }
    const mode = modeResolution.mode

    if (capture.state === 'discarded') {
      counters.rejected += 1
      return { accepted: false, duplicate: false, late: true, utteranceId: null, reason: 'discarded-capture' }
    }
    if (capture.state === 'finished') {
      return recordLate(parsed, capture, t, 'after-boundary', capture.lastUtteranceId)
    }

    const seen = capture.seenItems.get(parsed.itemId)
    if (parsed.utteranceId && capture.finishedUtteranceIds.includes(parsed.utteranceId) && !capture.groups.has(parsed.utteranceId)) {
      // The provider utterance identity was already submitted: any later fact for
      // it is inspection content, never a second task.
      return recordLate(parsed, capture, t, 'after-boundary', parsed.utteranceId)
    }
    if (seen && seen.emitted) {
      return recordLate(parsed, capture, t, 'after-boundary', seen.utteranceId)
    }
    if (seen && seen.utteranceId !== parsed.utteranceId && parsed.utteranceId && seen.utteranceId) {
      // The same provider item cannot change utterance identity after the fact.
      counters.rejected += 1
      return { accepted: false, duplicate: false, utteranceId: seen.utteranceId, reason: 'item-identity-conflict' }
    }
    if (seen && parsed.kind === 'asr.partial' && parsed.revision <= seen.revision) {
      counters.rejected += 1
      return { accepted: false, duplicate: false, utteranceId: seen.utteranceId, reason: 'partial-after-final' }
    }

    if (seen && seen.utteranceId !== parsed.utteranceId && !parsed.utteranceId) {
      // Facts without an utterance id are attributed to the capture's current group.
      parsed.utteranceId = seen.utteranceId
    }

    if (parsed.kind === 'asr.partial') {
      const result = handlePartial(capture, parsed, mode, t)
      if (result.duplicate) counters.duplicates += 1
      return result
    }

    // A final for an item that was already accepted in an older (unemitted) group
    // of the same capture is a cumulative revision of that group, not a new group.
    if (seen && seen.utteranceId && seen.utteranceId !== parsed.utteranceId && !capture.groups.has(groupKeyFor(parsed, capture, mode))) {
      const priorGroup = capture.groups.get(seen.utteranceId) || (mode === 'hold' ? capture.groups.get('hold') : null)
      if (priorGroup) {
        parsed.utteranceId = priorGroup.utteranceId
        const result = appendOrUpdateItem(priorGroup, parsed, t)
        if (!result.accepted) return { ...result, utteranceId: priorGroup.utteranceId }
        priorGroup.lastActivityAt = t
        priorGroup.lastFinalAt = t
        priorGroup.sawFinal = true
        const entry = { utteranceId: priorGroup.utteranceId, revision: parsed.revision, text: parsed.text, kind: 'asr.final', emitted: false }
        Object.assign(seen, entry)
        counters.acceptedFinals += 1
        return { accepted: true, duplicate: false, reason: 'late-revision-merged', utteranceId: priorGroup.utteranceId }
      }
    }

    const result = handleFinal(capture, parsed, mode, t)
    if (result.duplicate) counters.duplicates += 1
    else if (!result.accepted) counters.rejected += 1
    return result
  }

  function readyDeadline(capture, group) {
    if (capture.state === 'discarded') return Infinity
    if (group.mode === 'hold' && capture.releasedAt == null) return Infinity // hold stays closed until release
    const settleDeadline = group.lastActivityAt + settleMs
    if (capture.releasedAt != null) return Math.min(settleDeadline, capture.drainDeadline)
    return settleDeadline
  }

  function dropDeadline(capture, group) {
    const hard = group.createdAt + maxUtteranceMs
    if (capture.releasedAt != null) return Math.min(capture.drainDeadline, hard)
    return hard
  }

  function finishCapture(capture, t) {
    if (capture.state === 'finished' || capture.state === 'discarded') return
    capture.state = 'finished'
    capture.finishedAt = t
    finishedCaptures.set(capture.captureId, {
      captureId: capture.captureId,
      mode: capture.mode,
      finishedAt: t,
      lastUtteranceId: capture.lastUtteranceId,
      finishedUtteranceIds: capture.finishedUtteranceIds.slice(),
    })
    if (finishedCaptures.size > finishedRetention) {
      finishedCaptures.delete(finishedCaptures.keys().next().value)
    }
  }

  function emitGroup(capture, key, group, t, boundaryReason) {
    capture.groups.delete(key)
    if (capture.activeKey === key) capture.activeKey = null
    const { text, segments } = mergeFinalItems(group.items)
    if (segments.length === 0 || text === '') {
      recordDrop(capture, group, 'empty-text', t)
      return null
    }
    const utterance = {
      utteranceId: group.utteranceId,
      captureId: capture.captureId,
      mode: group.mode,
      text,
      segments,
      createdAt: group.createdAt,
      readyAt: t,
      late: false,
      reason: boundaryReason,
      segmentCount: segments.length,
      needsConfirmation: group.mode === 'always' || group.conflicts.length > 0,
      conflicts: group.conflicts.slice(),
      releasedAt: capture.releasedAt,
      discarded: false,
    }
    for (const segment of segments) {
      const record = capture.seenItems.get(segment.itemId)
      if (record) record.emitted = true
    }
    capture.lastUtteranceId = group.utteranceId
    pushBounded(capture.finishedUtteranceIds, group.utteranceId, 8)
    pushBounded(emitted, utterance, emittedRetention)
    counters.emitted += 1
    // Once the submission boundary is crossed, the capture's remaining audio
    // belongs to inspection records only; a hold capture is closed at release.
    if (capture.releasedAt != null) finishCapture(capture, t)
    return utterance
  }

  function collectReady(capture, t, into) {
    for (const [key, group] of [...capture.groups]) {
      if (group.sawFinal) {
        if (t >= readyDeadline(capture, group)) {
          const utterance = emitGroup(capture, key, group, t, 'settled')
          if (utterance) into.push(utterance)
          continue
        }
        if (group.mode === 'hold' && capture.releasedAt == null && t >= group.createdAt + maxUtteranceMs) {
          // Missing release: never submit a hold utterance without its boundary.
          capture.groups.delete(key)
          recordDrop(capture, group, 'release-missing', t)
          continue
        }
        if (t >= group.createdAt + maxUtteranceMs) {
          const utterance = emitGroup(capture, key, group, t, 'expired-boundary')
          if (utterance) into.push(utterance)
        }
        continue
      }
      // Partial-only groups never submit; they are dropped after a bounded wait.
      if (t >= dropDeadline(capture, group)) {
        capture.groups.delete(key)
        if (capture.activeKey === key) capture.activeKey = null
        recordDrop(capture, group, capture.releasedAt != null ? 'no-final-drain' : 'no-final', t)
      }
    }
    if (capture.state === 'closing' && capture.groups.size === 0 && capture.releasedAt != null && t >= capture.drainDeadline) {
      finishCapture(capture, t)
    }
  }

  function normalizeRelease(first, second) {
    let captureId = null
    let discard = false
    if (typeof first === 'string') {
      captureId = first
      if (second && typeof second === 'object') discard = second.discard === true
    } else if (first && typeof first === 'object') {
      captureId = first.captureId
      discard = first.discard === true
    }
    if (typeof captureId !== 'string' || captureId.trim() === '') {
      throw modelError('INVALID_RELEASE', 'release requires a captureId')
    }
    return { captureId: captureId.trim(), discard }
  }

  /**
   * Close a capture. With `discard` the capture tombstone guarantees no flush;
   * otherwise the bounded drain deadline starts (hold waits for late finals).
   * @returns {{utterances: object[], drained: boolean, discarded?: boolean, duplicate?: boolean}}
   */
  function release(first, second) {
    const { captureId, discard } = normalizeRelease(first, second)
    const t = clock()
    if (discardedCaptures.has(captureId)) return { utterances: [], drained: true, discarded: true, duplicate: true }
    let capture = captures.get(captureId)
    if (!capture) {
      const finished = finishedCaptures.get(captureId)
      if (finished) return { utterances: [], drained: true, duplicate: true }
      capture = makeCapture(captureId, null, t)
      captures.set(captureId, capture)
    }
    if (capture.state === 'finished') return { utterances: [], drained: true, duplicate: true }
    if (discard) {
      const dropped = [...capture.groups.values()]
      for (const group of dropped) recordDrop(capture, group, 'discarded', t)
      capture.groups.clear()
      capture.activeKey = null
      capture.state = 'discarded'
      capture.discardedAt = t
      for (const group of dropped) pushBounded(capture.finishedUtteranceIds, group.utteranceId, 8)
      captures.delete(captureId)
      // A discarded capture also suppresses already-buffered late inspection content:
      // "canceled capture cannot flush" applies to every delayed fragment.
      pendingLate = pendingLate.filter((entry) => entry.record.captureId !== captureId)
      discardedCaptures.set(captureId, { discardedAt: t, mode: capture.mode })
      if (discardedCaptures.size > discardedRetention) discardedCaptures.delete(discardedCaptures.keys().next().value)
      counters.discarded += 1
      return { utterances: [], drained: true, discarded: true }
    }
    if (capture.releasedAt == null) {
      capture.releasedAt = t
      capture.drainDeadline = t + drainMs
    }
    capture.state = 'closing'
    // Emission is deferred to tick() so a caller that does `release(); tick()` (the
    // ConversationService voice.facts path) never loses a ready utterance; callers
    // must not route `release().utterances` and tick() both. This also keeps every
    // submission behind one single producer.
    return { utterances: [], drained: capture.state === 'finished', pending: capture.groups.size }
  }

  /** Emit every utterance whose settle/drain deadline has passed. */
  function tick() {
    const t = clock()
    const utterances = []
    for (const capture of [...captures.values()]) {
      if (capture.state === 'discarded') {
        captures.delete(capture.captureId)
        continue
      }
      if (capture.state === 'finished') continue // retained by finishedCaptures for late attribution
      collectReady(capture, t, utterances)
    }
    // Late-after-boundary finals become inspectable utterances for the service's
    // draft/notice path; they are never submitted as work (late:true).
    if (pendingLate.length > 0) {
      const lateBatch = pendingLate.splice(0, pendingLate.length)
      for (const entry of lateBatch) {
        const record = entry.record
        utterances.push({
          utteranceId: record.utteranceId || 'late-' + newId(),
          captureId: record.captureId,
          mode: record.mode,
          text: record.text,
          segments: [{
            segmentId: `${record.captureId}:${record.itemId}:late`,
            text: record.text,
            itemIds: [record.itemId],
            itemId: record.itemId,
            revision: record.revision,
            span: [0, record.text.length],
          }],
          createdAt: record.at,
          readyAt: t,
          late: true,
          reason: record.reason,
          segmentCount: 1,
          needsConfirmation: true,
          conflicts: [],
          releasedAt: null,
          discarded: false,
        })
      }
    }
    // Bounded active-capture retention: only finished/discarded records may leave.
    if (captures.size > captureRetention) {
      for (const [captureId, capture] of captures) {
        if (captures.size <= captureRetention) break
        if (capture.state === 'finished') captures.delete(captureId)
      }
    }
    return utterances
  }

  function previewOf(capture) {
    let latest = null
    for (const group of capture.groups.values()) {
      if (!latest || group.lastActivityAt >= latest.lastActivityAt) latest = group
    }
    if (!latest) return null
    const merged = latest.sawFinal ? mergeFinalItems(latest.items) : { text: latest.partial?.text || '', segments: [] }
    const text = merged.text.length > 2000 ? merged.text.slice(0, 2000) : merged.text
    return {
      utteranceId: latest.utteranceId,
      captureId: capture.captureId,
      mode: latest.mode,
      text,
      truncated: merged.text.length > text.length,
      segmentCount: merged.segments.length,
      revision: latest.items.reduce((max, item) => Math.max(max, item.revision), latest.partial?.revision ?? 0),
      hasFinal: latest.sawFinal,
      closing: capture.state === 'closing',
    }
  }

  /** Inspectable state for Snapshot capture.preview and diagnostics (never submits). */
  function state() {
    const capturesView = []
    let preview = null
    let previewAt = -Infinity
    for (const capture of captures.values()) {
      if (capture.state === 'finished' || capture.state === 'discarded') continue
      const capturePreview = previewOf(capture)
      capturesView.push({
        captureId: capture.captureId,
        mode: capture.mode,
        state: capture.state,
        createdAt: capture.createdAt,
        releasedAt: capture.releasedAt,
        drainDeadline: capture.drainDeadline,
        utteranceCount: capture.groups.size,
        preview: capturePreview,
      })
      const at = capturePreview ? capturePreview.utteranceId : ''
      if (capturePreview && at !== previewAt) {
        preview = capturePreview
        previewAt = at
      }
    }
    return {
      preview,
      captures: capturesView,
      activeCaptures: capturesView.length,
      late: lateRecords.slice(-20),
      dropped: droppedRecords.slice(-20),
      discarded: [...discardedCaptures.keys()].slice(-20),
      counts: { ...counters, emittedRetained: emitted.length, activeCaptures: capturesView.length },
      tunables: { settleMs, drainMs, maxChars },
    }
  }

  function reset() {
    captures = new Map()
    discardedCaptures = new Map()
    finishedCaptures = new Map()
    emitted = []
    lateRecords = []
    pendingLate = []
    anonymousItems = 0
    droppedRecords = []
    counters = { facts: 0, acceptedFinals: 0, duplicates: 0, late: 0, emitted: 0, discarded: 0, rejected: 0 }
  }

  return {
    fact,
    addFact: fact, // kernel §3.5 alias
    release,
    tick,
    state,
    reset,
    // Read-only helpers used by tests/integration.
    emittedUtterances: () => emitted.map(copy),
    lateRecords: () => lateRecords.map(copy),
    droppedRecords: () => droppedRecords.map(copy),
    tunables: () => ({ settleMs, drainMs, maxChars }),
  }
}

/* ------------------------------------------------------------------------- */
/* Deterministic segmenter                                                    */
/* ------------------------------------------------------------------------- */

const TERMINAL_PUNCT = new Set(['。', '！', '？', '.', '!', '?'])
const SEPARATOR_PUNCT = new Set(['。', '！', '？', '.', '!', '?', '，', ',', '、', ';', '；', '：', ':'])

function normalizeWithMap(raw) {
  let norm = ''
  const map = []
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i]
    const lower = char.toLowerCase()
    if (/[0-9a-z\u4e00-\u9fff]/.test(lower)) {
      norm += lower
      map.push(i)
    }
  }
  return { norm, map }
}

function trimStartIndex(raw, from = 0) {
  let index = from
  while (index < raw.length && /\s/u.test(raw[index])) index += 1
  return index
}

function trimEndIndex(raw, from = 0) {
  let index = raw.length
  while (index > from && /\s/u.test(raw[index - 1])) index -= 1
  return index
}

function consumeSeparator(raw, index) {
  let cursor = index
  while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1
  let punct = false
  while (cursor < raw.length && SEPARATOR_PUNCT.has(raw[cursor])) {
    punct = true
    cursor += 1
  }
  while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1
  let connector = false
  if (raw.startsWith('然后', cursor)) {
    connector = true
    cursor += 2
  } else if (raw.startsWith('接着', cursor)) {
    connector = true
    cursor += 2
  }
  if (!punct && !connector) return null
  while (cursor < raw.length && /\s/u.test(raw[cursor])) cursor += 1
  return { end: cursor, punct, connector, connectorOnly: connector && !punct }
}

/** Remainder that merely continues the same polite request, not new work. */
const POLITENESS_REMAINDERS = new Set([
  '好吗', '行吗', '可以吗', '好不好', '成吗', '对吗', '对吧', '是吧',
  '谢谢', '谢了', '谢谢你', '麻烦你', '拜托', '吧', '啊', '呢', '哦', '嗯', '啦', '嘛',
])

/** Leading discourse fillers stripped only when an exact directive follows. */
const DISCOURSE_FILLERS = ['我这边', '确认一下', '麻烦', '好的', '那就', '嗯', '呃', '额', '啊', '哦', '那', '我', '请', '喂', '嗨', 'okay', 'ok', '好']
  .map((value) => ({ raw: value, norm: normalizeWithMap(value).norm }))
  .filter((entry) => entry.norm.length > 0)
  .sort((left, right) => right.norm.length - left.norm.length)

const CONTROL_TABLE = [
  { control: 'task-status', phrases: ['现在做到哪里了', '现在做到哪了', '任务进度', '当前任务状态', '任务怎么样了', '任务状态', '现在在做什么', '做到哪了'] },
  { control: 'task-stop', phrases: ['确认停止任务', '确认取消任务', '确认停止当前任务'], confirm: true },
  { control: 'task-stop', phrases: ['停止任务', '停止当前任务', '停止这个任务', '取消任务', '取消当前任务', '取消这个任务', 'stoptask', 'canceltask'], confirm: false },
  { control: 'cancel-capture', phrases: ['取消这次录音', '取消本次录音', '取消录音', '丢弃录音', '作废录音', '别录了'] },
  { control: 'playback-brief', phrases: ['只说结论', '简短播报', '跳过细节', '简要播报'] },
  { control: 'playback-full', phrases: ['详细播报', '完整播报', '展开说说'] },
  {
    control: 'playback-stop',
    phrases: [
      '停一下', '先停一下', '停止播放', '停止播报', '停止朗读', '停止说话', '别说了', '别念了', '别播了',
      '停下来', '停下', '停止', '暂停', '先停', '停播', '打断', '不用了', '安静', '取消', '停',
      'stop talking', 'stop reading', 'stop',
    ],
  },
].flatMap((entry) => entry.phrases.map((phrase) => ({
  control: entry.control,
  confirm: entry.confirm === true,
  raw: phrase,
  norm: normalizeWithMap(phrase).norm,
}))).filter((entry) => entry.norm.length > 0)
  .sort((left, right) => right.norm.length - left.norm.length)

/** Phrases that stay ambiguous when the punctuation is dropped ("停然后…"). */
const BARE_AMBIGUOUS_CONTROLS = new Set(['停', '取消', '停啊', '停吧', 'stop', 'cancel', '不用了', '打断'])

const APPROVAL_ALLOW = ['确认允许一次', '我允许一次', '允许一次', '允许这次', '批准这次', '同意这次', '确认允许', '批准一次', '同意一次', '允许', '批准', '同意', 'allow once', 'allow', 'approve']
const APPROVAL_REJECT = ['不允许', '拒绝这次', '拒绝一次', '不要执行', '拒绝', '否', '不行', 'reject', 'deny']
const APPROVAL_AMBIGUOUS = ['好像可以', '应该可以', '大概可以', '差不多可以', '允许吧', '可以', '好的', '没问题', '是的', '对的', '行', '好', '嗯', 'ok', 'okay']
const APPROVAL_PERSISTENT = ['始终允许', '总是允许', '永远允许', '永久允许', '一直允许', '以后都允许', '始终批准', 'always allow']
const APPROVAL_ATTEMPT_WORDS = ['允许', '批准', '同意', '拒绝', '确认允许', '始终允许', '永久允许', '可以', '不行', '好的']

function approvalTable() {
  const rows = []
  for (const phrase of APPROVAL_PERSISTENT) rows.push({ kind: 'persistent', norm: normalizeWithMap(phrase).norm, raw: phrase })
  for (const phrase of APPROVAL_ALLOW) rows.push({ kind: 'allow', norm: normalizeWithMap(phrase).norm, raw: phrase })
  for (const phrase of APPROVAL_REJECT) rows.push({ kind: 'reject', norm: normalizeWithMap(phrase).norm, raw: phrase })
  for (const phrase of APPROVAL_AMBIGUOUS) rows.push({ kind: 'ambiguous', norm: normalizeWithMap(phrase).norm, raw: phrase })
  return rows.filter((row) => row.norm.length > 0).sort((left, right) => right.norm.length - left.norm.length)
}
const APPROVAL_ROWS = approvalTable()

const WELCOME_PHRASES = new Set([
  '你好', '你好呀', '你好啊', '我在', '想聊什么', '嗨', 'hi', 'hello', '在吗', '谢谢', '好的',
])

const QUESTION_SELECT_VERBS = ['就选', '选择', '我要', '我选', '就要', '选', '就']
const QUESTION_DESELECT_VERBS = ['不要选', '不要', '不选', '去掉', '取消']
const QUESTION_ORDINAL_RE = /^第?([0-9]+|[一二三四五六七八九十两]+)(?:个|项|条|号)?(?:选项|选择)?$/
const QUESTION_LAST_RE = /^(?:最后|末尾|倒数第一)(?:一个|一项|那个|个|项)?$/
const QUESTION_ATTEMPT_RE = /^(?:第|最后|倒数)/
const QUESTION_JOIN_RE = /(?:和|、|跟|以及)/

const CN_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
function parseChineseNumber(token) {
  if (/^[0-9]+$/.test(token)) return Number(token)
  if (token === '十') return 10
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + CN_DIGITS[token.slice(1)]
  if (/^[一二三四五六七八九]十$/.test(token)) return CN_DIGITS[token[0]] * 10
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(token)) return CN_DIGITS[token[0]] * 10 + CN_DIGITS[token[2]]
  if (token.length === 1) return CN_DIGITS[token] ?? null
  return null
}

const ORDINAL_LABELS = ['第一个', '第二个', '第三个', '第四个', '第五个', '第六个', '第七个', '第八个', '第九个', '第十个']

function normalizeOptionLabel(label) {
  return normalizeWithMap(String(label ?? '')).norm
}

function stableOptionIds(questions, semanticRevision) {
  const map = new Map()
  for (const question of questions) {
    const options = Array.isArray(question?.options) ? question.options : []
    options.forEach((option, index) => {
      const id = stableOptionId(option, question.id, semanticRevision, index)
      map.set(id, { questionId: question.id, index, option, label: String(option?.label ?? '') })
    })
  }
  return map
}

/* ------------------------------------------------------------------------- */

/**
 * Build the deterministic router. Pure: no state, no clock, no ids from entropy.
 * @returns {{route: (text: string, context?: object) => object}}
 */
export function createSegmenter() {
  function validateContext(context) {
    if (context === null || context === undefined) return {}
    if (typeof context !== 'object') throw modelError('INVALID_CONTEXT', 'route context must be an object')
    if (context.mode !== undefined && context.mode !== null && context.mode !== '') {
      normalizeMode(context.mode)
    }
    const approval = context.approval || (context.interaction?.kind === 'approval' ? context.interaction : null)
    if (approval) validateInteraction(approval, 'approval')
    if (context.interaction && context.interaction.kind === 'question') validateInteraction(context.interaction, 'question')
    return context
  }

  function validateInteraction(interaction, label) {
    if (typeof interaction !== 'object') throw modelError('INVALID_INTERACTION', `${label} context must be an object`)
    if (typeof interaction.id !== 'string' || interaction.id.trim() === '') {
      throw modelError('INVALID_INTERACTION', `${label}.id is required`)
    }
    if (!Number.isInteger(interaction.semanticRevision) || interaction.semanticRevision < 0) {
      throw modelError('INVALID_INTERACTION', `${label}.semanticRevision must be a non-negative integer`)
    }
  }

  function baseSegmentId(context, index) {
    const base = context.utteranceId || context.captureId || 'route'
    return `${base}:seg:${index}`
  }

  function makeSegment(context, index, kind, text, reason, extra = {}) {
    return {
      segmentId: baseSegmentId(context, index),
      kind,
      text,
      reason,
      span: extra.span || [0, 0],
      ...extra,
    }
  }

  function trimmedSpan(raw, start) {
    const from = trimStartIndex(raw, start)
    const to = trimEndIndex(raw, from)
    return { from, to }
  }

  function politenessRemainder(raw, start) {
    const { from, to } = trimmedSpan(raw, start)
    if (from >= to) return true
    const norm = normalizeWithMap(raw.slice(from, to)).norm
    return POLITENESS_REMAINDERS.has(norm)
  }

  /**
   * Match one leading directive (control phrase or approval phrase) at `from`.
   * Returns null when the text does not begin with an exact directive and a
   * sentence separator (or is exactly that directive).
   */
  function matchLeadingDirective(raw, from, context, approvalContext) {
    const end = trimEndIndex(raw)
    const start = trimStartIndex(raw, from)
    if (start >= end) return null
    const segmentRaw = raw.slice(start, end)
    const { norm, map } = normalizeWithMap(segmentRaw)

    const candidates = []
    for (const row of CONTROL_TABLE) candidates.push({ type: 'control', row, norm: row.norm })
    if (approvalContext) {
      for (const row of APPROVAL_ROWS) candidates.push({ type: 'approval', row, norm: row.norm })
    }
    candidates.sort((left, right) => right.norm.length - left.norm.length)

    const attempts = []
    for (const candidate of candidates) {
      if (!norm.startsWith(candidate.norm)) continue
      const rawEnd = start + map[candidate.norm.length - 1] + 1
      attempts.push({ ...candidate, start, rawEnd, end })
    }

    // Discourse fillers are only stripped when an exact directive follows.
    for (const filler of DISCOURSE_FILLERS) {
      if (!norm.startsWith(filler.norm)) continue
      const fillerNormEnd = filler.norm.length
      const fillerRawEnd = start + map[fillerNormEnd - 1] + 1
      // A filler may be separated from the directive by whitespace or a comma,
      // never by terminal punctuation (that would be a new sentence).
      const gap = raw.slice(fillerRawEnd, start + (map[fillerNormEnd] ?? map[fillerNormEnd - 1] + 1))
      if (gap.includes('\n')) continue
      if ([...gap].some((char) => TERMINAL_PUNCT.has(char))) continue
      const nextRaw = start + (map[fillerNormEnd] ?? raw.length - start)
      const next = matchDirectiveAt(raw, nextRaw, end, candidates)
      if (next) attempts.push({ ...next, fillerStripped: true, fillerRawEnd, start })
    }

    attempts.sort((left, right) => {
      const leftRawEnd = left.rawEnd
      const rightRawEnd = right.rawEnd
      return rightRawEnd - leftRawEnd
    })

    let ambiguity = null
    for (const attempt of attempts) {
      const parsed = finishDirective(raw, attempt, end, context, approvalContext)
      if (!parsed) continue
      if (parsed.ambiguousBoundary) {
        ambiguity = parsed
        continue
      }
      return parsed
    }
    return ambiguity
  }

  function matchDirectiveAt(raw, from, end, candidates) {
    const { norm, map } = normalizeWithMap(raw.slice(from, end))
    for (const candidate of candidates) {
      if (!norm.startsWith(candidate.norm)) continue
      const rawEnd = from + map[candidate.norm.length - 1] + 1
      return { ...candidate, start: from, rawEnd }
    }
    return null
  }

  function finishDirective(raw, attempt, end, context, approvalContext) {
    const rawEnd = attempt.rawEnd
    const phraseText = raw.slice(attempt.start, rawEnd).trim()
    if (phraseText === '') return null
    const restRaw = raw.slice(rawEnd, end)
    if (restRaw.trim() === '') {
      return { whole: true, start: attempt.start, rawEnd, phraseText, row: attempt.row, type: attempt.type, end }
    }
    const separator = consumeSeparator(raw, rawEnd)
    if (!separator) return null
    const remainderStart = separator.end
    if (politenessRemainder(raw, remainderStart)) {
      return { whole: true, start: attempt.start, rawEnd, phraseText, row: attempt.row, type: attempt.type, end, polite: true }
    }
    if (separator.connectorOnly && attempt.type === 'control' && BARE_AMBIGUOUS_CONTROLS.has(attempt.row.norm)) {
      return {
        ambiguousBoundary: true,
        start: attempt.start,
        rawEnd: end,
        phraseText: raw.slice(attempt.start, end).trim(),
        row: attempt.row,
        type: attempt.type,
        end,
      }
    }
    return {
      whole: false,
      start: attempt.start,
      rawEnd,
      phraseText,
      row: attempt.row,
      type: attempt.type,
      remainderStart,
      remainderEnd: end,
      separator,
      end,
    }
  }

  function stripLeadingFillers(raw) {
    let start = trimStartIndex(raw)
    const end = trimEndIndex(raw)
    for (let round = 0; round < 2; round += 1) {
      const { norm, map } = normalizeWithMap(raw.slice(start, end))
      let advanced = false
      for (const filler of DISCOURSE_FILLERS) {
        if (!norm.startsWith(filler.norm)) continue
        const nextRaw = start + map[filler.norm.length - 1] + 1
        const gap = raw.slice(nextRaw, start + (map[filler.norm.length] ?? end - start))
        if ([...gap].some((char) => TERMINAL_PUNCT.has(char))) break
        start = trimStartIndex(raw, nextRaw)
        advanced = true
        break
      }
      if (!advanced) break
    }
    return { start, end }
  }

  function approvalDirectiveSegment(parsed, index, context) {
    const approval = context.approval || context.interaction
    const base = {
      kind: 'control',
      control: parsed.row.kind === 'reject' ? 'approval-reject' : 'approval-allow',
      reason: parsed.row.kind === 'reject' ? 'approval-reject-explicit' : 'approval-allow-explicit',
      answer: {
        kind: 'approval',
        interactionId: approval.id,
        semanticRevision: approval.semanticRevision,
        decision: parsed.row.kind === 'reject' ? 'rejected' : 'allowed-once',
      },
      requiresConfirmation: false,
      confirmedTarget: approval.id,
    }
    const text = parsed.phraseText
    return {
      ...makeSegment(context, index, 'control', text, base.reason, {
        control: base.control,
        answer: base.answer,
        requiresConfirmation: false,
      }),
      span: [parsed.start, parsed.rawEnd],
    }
  }

  function ignoreSegment(context, index, text, reason, span, extra = {}) {
    return makeSegment(context, index, 'ignore', text, reason, { span, ...extra })
  }

  function clarify(context, index, text, reason, span, message, extra = {}) {
    const segment = makeSegment(context, index, 'interaction-answer', text, reason, {
      span,
      answer: {
        status: 'rejected',
        reason,
        ...extra.answer,
      },
    })
    return { segment, message }
  }

  function parseQuestionTarget(raw, startedAt, candidates) {
    // `candidates` includes every known option for the focused question.
    const { from, to } = trimmedSpan(raw, startedAt)
    if (from >= to) return { type: 'none' }
    const text = raw.slice(from, to)
    const norm = stripFillerNorm(text)
    if (norm === '') return { type: 'none' }

    const deselect = QUESTION_DESELECT_VERBS.filter((verb) => norm.startsWith(verb)).sort((a, b) => b.length - a.length)[0]
    const select = QUESTION_SELECT_VERBS.filter((verb) => norm.startsWith(verb)).sort((a, b) => b.length - a.length)[0]
    const verbTaken = deselect || select
    const innerNorm = verbTaken ? norm.slice(verbTaken.length) : norm
    const intent = deselect ? 'deselect' : 'select'

    if (innerNorm === '') return { type: 'attempt', reason: 'incomplete-answer', intent, verb: verbTaken || '' }
    if (QUESTION_JOIN_RE.test(innerNorm)) return { type: 'attempt', reason: 'unsupported-multi-answer', intent }

    if (QUESTION_LAST_RE.test(innerNorm)) {
      if (candidates.length === 0) return { type: 'attempt', reason: 'no-options', intent }
      return { type: 'resolve', intent, option: candidates[candidates.length - 1], ordinal: candidates.length }
    }
    const ordinal = innerNorm.match(QUESTION_ORDINAL_RE)
    if (ordinal) {
      const number = parseChineseNumber(ordinal[1])
      if (number === null || number < 1 || number > candidates.length) {
        return { type: 'attempt', reason: 'ordinal-out-of-range', intent }
      }
      return { type: 'resolve', intent, option: candidates[number - 1], ordinal: number }
    }
    if (QUESTION_ATTEMPT_RE.test(innerNorm)) return { type: 'attempt', reason: 'unparsed-ordinal', intent }

    const normLabel = normalizeOptionLabel
    const exact = candidates.filter((candidate) => normLabel(candidate.label) === innerNorm)
    if (exact.length === 1) return { type: 'resolve', intent, option: exact[0], ordinal: exact[0].index + 1 }
    if (exact.length > 1) return { type: 'attempt', reason: 'ambiguous-label', intent }
    if (innerNorm.length >= 2) {
      const prefixed = candidates.filter((candidate) => {
        const label = normLabel(candidate.label)
        return label.length >= 2 && (label.startsWith(innerNorm) || innerNorm.startsWith(label))
      })
      if (prefixed.length === 1) return { type: 'resolve', intent, option: prefixed[0], ordinal: prefixed[0].index + 1 }
      if (prefixed.length > 1) return { type: 'attempt', reason: 'ambiguous-label', intent }
    }
    if (verbTaken) return { type: 'attempt', reason: 'unknown-option', intent }
    return { type: 'none' }
  }

  function fillerVariants(text) {
    const variants = []
    let { norm } = normalizeWithMap(text)
    if (norm !== '') variants.push(norm)
    for (let round = 0; round < 2; round += 1) {
      let advanced = false
      for (const filler of DISCOURSE_FILLERS) {
        if (!filler.norm || !norm.startsWith(filler.norm)) continue
        norm = norm.slice(filler.norm.length)
        if (norm !== '') variants.push(norm)
        advanced = true
        break
      }
      if (!advanced) break
    }
    return variants
  }

  function stripFillerNorm(text) {
    const variants = fillerVariants(text)
    return variants.length > 0 ? variants[variants.length - 1] : ''
  }

  function isApprovalAttempt(text) {
    const variants = fillerVariants(text)
    if (variants.length === 0) return false
    return variants.some((norm) => APPROVAL_ATTEMPT_WORDS.some((word) => norm === word || norm.startsWith(word)))
  }

  function isVagueAnswer(text) {
    return fillerVariants(text).some((norm) => VAGUE_ANSWER_WORDS.has(norm))
  }

  /**
   * Deterministic route.
   * @param {string} text raw ASR final text
   * @param {object} context {mode, captureId, utteranceId, interaction, approval, options}
   * @returns {{segments: object[], clarifications?: string[], interactionAnswerRejected?: boolean}}
   */
  function route(text, context = {}) {
    validateContext(context)
    const raw = typeof text === 'string' ? text : String(text ?? '')
    const trimmed = trimLeadingAndTrailing(raw)
    if (trimmed.text === '') {
      return {
        segments: [makeSegment(context, 0, 'ignore', '', 'empty', { span: [0, 0] })],
        clarifications: [],
      }
    }
    if (context.options?.ignoreReason && typeof context.options.ignoreReason === 'string') {
      return {
        segments: [ignoreSegment(context, 0, trimmed.text, context.options.ignoreReason, [trimmed.start, trimmed.end])],
        clarifications: [],
      }
    }
    const { norm: wholeNorm } = normalizeWithMap(trimmed.text)
    if (wholeNorm === '') {
      return {
        segments: [makeSegment(context, 0, 'ignore', trimmed.text, 'no-speech-content', { span: [trimmed.start, trimmed.end] })],
        clarifications: [],
      }
    }
    if (context.options?.echo === true) {
      return {
        segments: [ignoreSegment(context, 0, trimmed.text, 'welcome-echo', [trimmed.start, trimmed.end])],
        clarifications: [],
      }
    }
    if (context.options?.duplicate === true) {
      return {
        segments: [ignoreSegment(context, 0, trimmed.text, 'duplicate', [trimmed.start, trimmed.end])],
        clarifications: [],
      }
    }
    if (context.options?.welcomeEcho === true && WELCOME_PHRASES.has(wholeNorm)) {
      // Only an exact known welcome phrase may be dropped on lexical evidence; a
      // normal "你好/我在/想聊什么" is never swallowed merely for being a substring.
      return {
        segments: [ignoreSegment(context, 0, trimmed.text, 'welcome-echo', [trimmed.start, trimmed.end])],
        clarifications: [],
      }
    }

    const approvalContext = context.approval || (context.interaction?.kind === 'approval' ? context.interaction : null)
    const questionContext = context.interaction?.kind === 'question' ? context.interaction : null
    const segments = []
    const clarifications = []
    let interactionAnswerRejected = false
    let cursor = trimStartIndex(raw)
    const end = trimEndIndex(raw)

    // 1. Leading exact controls / approval directives, one separator each.
    for (let guard = 0; guard < 6 && cursor < end; guard += 1) {
      const parsed = matchLeadingDirective(raw, cursor, context, approvalContext)
      if (!parsed) break
      if (parsed.ambiguousBoundary) {
        segments.push(ignoreSegment(context, segments.length, raw.slice(cursor, end).trim(), 'ambiguous-control-boundary', [cursor, end]))
        clarifications.push('无法可靠区分停止指令和后续工作，请分开说。')
        cursor = end
        break
      }
      if (parsed.type === 'approval') {
        if (parsed.row.kind === 'persistent') {
          segments.push(ignoreSegment(context, segments.length, parsed.phraseText, 'persistent-approval-requires-ui', [parsed.start, parsed.rawEnd]))
          clarifications.push('“始终允许”不能仅凭语音建立；请在主窗口查看实际操作后确认。')
        } else if (parsed.row.kind === 'ambiguous') {
          interactionAnswerRejected = true
          const rejected = clarify(context, segments.length, parsed.phraseText, 'ambiguous-approval', [parsed.start, parsed.rawEnd], '检测到含糊的授权表达，请明确说“确认允许一次”或“拒绝”。', {
            answer: {
              kind: 'approval',
              interactionId: approvalContext.id,
              semanticRevision: approvalContext.semanticRevision,
            },
          })
          segments.push(rejected.segment)
          clarifications.push(rejected.message)
        } else {
          segments.push(approvalDirectiveSegment(parsed, segments.length, context))
        }
      } else if (parsed.type === 'control') {
        const row = parsed.row
        const control = row.control
        const partial = {
          control,
          requiresConfirmation: control === 'task-stop' ? row.confirm === false : false,
          ...(row.confirm ? { confirm: true } : {}),
        }
        if (control === 'task-stop') {
          partial.reason = row.confirm ? 'task-stop-confirm' : 'task-stop-request'
        } else if (control === 'cancel-capture') {
          partial.captureId = context.captureId || null
        } else if (control === 'playback-stop') {
          partial.playbackTarget = 'current'
        }
        segments.push(makeSegment(context, segments.length, 'control', parsed.phraseText, partial.reason || control + '-explicit', {
          ...partial,
          span: [parsed.start, parsed.rawEnd],
        }))
      }
      if (parsed.whole) {
        cursor = end
        break
      }
      cursor = parsed.remainderStart
    }

    // 2. Remaining text: interaction answer, ignore, or ordinary input.
    const remainderStart = trimStartIndex(raw, cursor)
    const remainderEnd = end
    const hasRemainder = remainderStart < remainderEnd
    if (hasRemainder) {
      const remainderText = raw.slice(remainderStart, remainderEnd).trim()
      const approvalOnly = isApprovalAttempt(remainderText)

      if (questionContext && questionContext.kind === 'question') {
        const result = classifyQuestion(questionContext, context, remainderText, remainderStart, remainderEnd)
        if (result?.segment) {
          if (result.segment.kind === 'interaction-answer' && result.segment.answer?.status === 'rejected') {
            interactionAnswerRejected = true
          }
          segments.push(result.segment)
          if (result.clarification) clarifications.push(result.clarification)
        } else {
          segments.push(inputSegment(context, segments.length, remainderText, [remainderStart, remainderEnd]))
        }
      } else if (approvalOnly && !approvalContext) {
        segments.push(ignoreSegment(context, segments.length, remainderText, 'no-pending-approval', [remainderStart, remainderEnd]))
        clarifications.push('当前没有待处理的审批，已忽略这段授权口令。')
      } else if (approvalContext && approvalOnly) {
        // A phrase that starts like an approval but could not be matched exactly:
        // clarify instead of turning it into work (ambiguous approval never executes).
        interactionAnswerRejected = true
        const rejected = clarify(context, segments.length, remainderText, 'ambiguous-approval', [remainderStart, remainderEnd], '检测到含糊的授权表达，请明确说“确认允许一次”或“拒绝”。', {
          answer: {
            kind: 'approval',
            interactionId: approvalContext.id,
            semanticRevision: approvalContext.semanticRevision,
          },
        })
        segments.push(rejected.segment)
        clarifications.push(rejected.message)
      } else {
        segments.push(inputSegment(context, segments.length, remainderText, [remainderStart, remainderEnd]))
      }
    }

    if (segments.length === 0) {
      // No leading directive and no remainder means the text was reduced to the
      // directive itself; the loop above always emits in that case.
      segments.push(inputSegment(context, 0, trimmed.text, [trimmed.start, trimmed.end]))
    }

    const result = { segments, clarifications }
    if (interactionAnswerRejected) result.interactionAnswerRejected = true
    return result
  }

  function trimLeadingAndTrailing(raw) {
    const start = trimStartIndex(raw)
    const end = trimEndIndex(raw)
    return { start, end, text: raw.slice(start, end) }
  }

  function inputSegment(context, index, text, span) {
    return makeSegment(context, index, 'input', text, 'ordinary-input', {
      span,
      requiresConfirmation: requiresConfirmationFor(text, context),
    })
  }

  function requiresConfirmationFor(text, context) {
    if (context.mode === 'always') return true
    if (context.options?.requiresConfirmation === true || context.requiresConfirmation === true) return true
    const value = normalizeWithMap(text).norm.replace(/^[嗯啊呃额]+/, '')
    if (['你好', '我在', '想聊什么', '谢谢', '好的', 'hello', 'thanks'].includes(value)) return false
    if (/^(打开|搜索|查找|整理|创建|读取|列出|翻译|计算|解释|总结|请|帮我)/.test(value)) return false
    return value.length <= 4 || ['我需要', '我想要', '帮我把', '然后呢'].includes(value)
  }

  function classifyQuestion(interaction, context, text, start, end) {
    const questions = Array.isArray(interaction.questions) ? interaction.questions : []
    let questionIndex = context.options?.questionIndex
    if (!Number.isInteger(questionIndex) || questionIndex < 0 || questionIndex >= questions.length) questionIndex = 0
    const question = questions[questionIndex]
    if (!question) {
      return {
        segment: rejectedAnswer(context, 0, text, start, end, interaction, 'interaction-has-no-question', '没有可回答的题目，请稍后重试。'),
        clarification: '没有可回答的题目，请稍后重试。',
      }
    }
    const options = Array.isArray(question.options) ? question.options : []
    const candidates = []
    options.forEach((option, index) => {
      candidates.push({
        index,
        option,
        label: String(option?.label ?? ''),
        optionId: stableOptionId(option, question.id, interaction.semanticRevision, index),
      })
    })
    const target = parseQuestionTarget(text, 0, candidates)
    if (target.type === 'resolve') {
      const option = target.option
      const selected = target.intent === 'deselect' ? [] : [option.optionId]
      const answer = {
        kind: 'question',
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
        questionId: question.id,
        questionIndex,
        multiSelect: question.multiSelect === true,
        optionId: option.optionId,
        optionIndex: option.index,
        optionLabel: option.label,
        selected,
        selectionIntent: target.intent,
        setSelected: target.intent !== 'deselect',
        ordinal: target.ordinal,
        // Registry-facing batch shape (conversation-service forwards payload.answers);
        // only a plain select is a complete single-answer batch. A multi-select
        // deselect is a set-selected command, not an answer batch.
        ...(target.intent === 'select' ? { answers: [{ id: question.id, selected: [option.optionId] }] } : {}),
      }
      if (question.multiSelect !== true && target.intent === 'deselect') {
        return {
          segment: rejectedAnswer(context, 0, text, start, end, interaction, 'deselect-on-single-select', '这道题是单选，请说您选择的选项。'),
          clarification: '这道题是单选，请说您选择的选项。',
        }
      }
      return {
        segment: makeSegment(context, 0, 'interaction-answer', text, 'question-answer', {
          span: [start, end],
          answer,
        }),
      }
    }
    if (target.type === 'attempt') {
      const messages = {
        'ordinal-out-of-range': '选项序号超出范围，请说当前题目的选项编号或名称。',
        'ambiguous-label': '选项名称无法唯一确定，请说当前题目的选项编号或名称。',
        'unparsed-ordinal': '无法确定选项序号，请说当前题目的选项编号或名称。',
        'unsupported-multi-answer': '一次只能回答一个选项，请分开说。',
        'no-options': '这道题没有可选项，请直接说出答案。',
        'incomplete-answer': '请说出具体选项。',
      }
      const message = messages[target.reason] || '无法确定这道题的选项答案，请重新说选项编号或名称。'
      return {
        segment: rejectedAnswer(context, 0, text, start, end, interaction, target.reason, message),
        clarification: message,
      }
    }
    if (isApprovalAttempt(text) || isVagueAnswer(text)) {
      const message = '无法把这句话对应到当前题目的选项，请说选项编号或名称。'
      return {
        segment: rejectedAnswer(context, 0, text, start, end, interaction, 'ambiguous-question-answer', message),
        clarification: message,
      }
    }
    if (context.options?.allowCustom === true && options.length === 0) {
      const answer = {
        kind: 'question',
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
        questionId: question.id,
        questionIndex,
        multiSelect: false,
        selected: [],
        custom: text.trim(),
        selectionIntent: 'custom',
        setSelected: false,
        answers: [{ id: question.id, selected: [], custom: text.trim() }],
      }
      return {
        segment: makeSegment(context, 0, 'interaction-answer', text, 'question-custom-answer', {
          span: [start, end],
          answer,
        }),
      }
    }
    return null
  }

  function rejectedAnswer(context, index, text, start, end, interaction, reason, message) {
    return makeSegment(context, index, 'interaction-answer', text, reason, {
      span: [start, end],
      answer: {
        status: 'rejected',
        reason,
        kind: 'question',
        interactionId: interaction.id,
        semanticRevision: interaction.semanticRevision,
      },
      clarification: message,
    })
  }

  return { route }
}

const VAGUE_ANSWER_WORDS = new Set(['可以', '好', '好的', '行', '嗯', '对', '是', '否', '不是', '都行', '随便', '你决定', '那个', '这个'])

export default { createUtteranceAssembler, createSegmenter, mergeFinalItems, SETTLE_MS_DEFAULT, DRAIN_MS_DEFAULT, MAX_CHARS_DEFAULT, CONTROL_VALUES }
