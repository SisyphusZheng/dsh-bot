/**
 * Snapshot + versioned event log for the beta2 Host.
 *
 * Guarantees implemented here:
 * - one monotonic `seq` counter per Host process (`hostEpoch` changes on restart);
 * - a snapshot is a consistent cut at `snapshotSeq`;
 * - a subscriber that starts from a snapshot never loses events recorded between
 *   taking the snapshot and subscribing, because all retained events replay;
 * - out-of-window clients are told to resync instead of silently skipping a gap;
 * - duplicate data is bounded by `retention`, never renumbered or rewritten.
 *
 * `snapshot@1` additive extension — `interactions.unknown` (R2, 0.0.1 closure):
 * - `interactions` keeps `focusedId`, `pending`, `drafts`, `recentlyResolved` with
 *   their exact previous shape and meaning; `unknown` is a new optional array of
 *   final interactions whose official outcome could not be confirmed (for example
 *   a crash/restart before the official lifetime settled, reason
 *   `HOST_RESTARTED`/`INTERACTION_UNKNOWN_AFTER_RESTART`).
 * - Each entry is `{ id, kind, sessionId, reason, at, action: { id, label } }`:
 *   `id` is the product interaction id, `kind` is `'approval' | 'question' | null`,
 *   `reason` is a bounded machine code (never a fabricated outcome), `at` is an ISO
 *   timestamp or null, and `action` is the only safe recovery entry (`open-main`:
 *   open the main window and verify the official state). Unknown entries are final:
 *   clients MUST NOT answer, retry, replay or present them as resolved/cancelled.
 * - Compatibility: the field is optional and additive, so the schema stays
 *   `snapshot@1` and it may be absent (older Hosts) or ignored (older clients,
 *   which keep reading the unchanged legacy fields). New clients must treat an
 *   absent/empty list as "nothing known to be unconfirmed", never as success.
 *   A non-empty list sets `presentation.displayMode` to `'unknown'` rather than
 *   `'idle'`, so the UI does not present an unconfirmed result as ordinary idle.
 */
import { PROTOCOL_VERSION, SNAPSHOT_SCHEMA, newId, nowIso } from './contracts.mjs'

export const DEFAULT_EVENT_RETENTION = 5000

export function createSnapshotStore({ hostEpoch, now = nowIso, retention = DEFAULT_EVENT_RETENTION } = {}) {
  if (typeof hostEpoch !== 'string' || hostEpoch === '') throw new Error('snapshot store requires hostEpoch')
  const capacity = Number.isSafeInteger(retention) && retention > 0 ? retention : DEFAULT_EVENT_RETENTION
  const events = []
  const listeners = new Set()
  let seq = 0
  let disposed = false

  function minRetainedSeq() {
    return events.length ? events[0].seq : seq + 1
  }

  function record(type, { source = 'host', sessionId = null, turn = null, causedByCommandId = null, data = {} } = {}) {
    if (disposed) throw new Error('snapshot store disposed')
    seq += 1
    const event = {
      protocolVersion: PROTOCOL_VERSION,
      eventId: newId(),
      hostEpoch,
      seq,
      type: String(type),
      source,
      sessionId: sessionId ?? null,
      turn: Number.isInteger(turn) ? turn : null,
      causedByCommandId: causedByCommandId ?? null,
      at: now(),
      data: data && typeof data === 'object' ? data : {},
    }
    events.push(event)
    if (events.length > capacity) events.splice(0, events.length - capacity)
    for (const listener of [...listeners]) {
      try { listener(event) } catch { /* a bad subscriber must not break the host */ }
    }
    return event
  }

  /**
   * Build a consistent snapshot: `buildSections()` must be synchronous so no
   * event can be recorded between reading sections and reading `snapshotSeq`.
   */
  function snapshot(buildSections) {
    const sections = typeof buildSections === 'function' ? buildSections() : buildSections
    return {
      protocolVersion: PROTOCOL_VERSION,
      schema: SNAPSHOT_SCHEMA,
      hostEpoch,
      snapshotSeq: seq,
      generatedAt: now(),
      ...(sections && typeof sections === 'object' ? sections : {}),
    }
  }

  function eventsAfter(after, { limit = 500 } = {}) {
    const cursor = Number.isSafeInteger(after) && after >= 0 ? after : -1
    if (cursor < 0 || cursor > seq) {
      return { events: [], next: seq, resyncRequired: true, minRetainedSeq: minRetainedSeq() }
    }
    const minimum = minRetainedSeq()
    if (cursor < minimum - 1) {
      return { events: [], next: seq, resyncRequired: true, minRetainedSeq: minimum }
    }
    const list = []
    for (const event of events) {
      if (event.seq <= cursor) continue
      list.push(event)
      if (list.length >= Math.max(1, limit)) break
    }
    return {
      events: list,
      next: list.length ? list[list.length - 1].seq : cursor,
      resyncRequired: false,
      minRetainedSeq: minimum,
    }
  }

  /**
   * Replay retained events after `after`, then deliver live events.
   * @returns {{ok: boolean, resyncRequired?: boolean, snapshotSeq?: number, unsubscribe?: Function}}
   */
  function subscribe(after, listener) {
    const replay = eventsAfter(after, { limit: capacity })
    if (replay.resyncRequired) return { ok: false, resyncRequired: true, snapshotSeq: seq }
    for (const event of replay.events) {
      try { listener(event) } catch { /* ignore subscriber error during replay */ }
    }
    listeners.add(listener)
    return {
      ok: true,
      snapshotSeq: seq,
      unsubscribe() { listeners.delete(listener) },
    }
  }

  return {
    hostEpoch,
    seq: () => seq,
    minRetainedSeq,
    record,
    snapshot,
    eventsAfter,
    subscribe,
    stats: () => ({ seq, retained: events.length, capacity, subscribers: listeners.size }),
    dispose() {
      disposed = true
      listeners.clear()
      events.length = 0
    },
  }
}
