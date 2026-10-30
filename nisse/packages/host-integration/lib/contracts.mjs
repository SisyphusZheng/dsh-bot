/**
 * beta2 product protocol contract helpers.
 *
 * This module is the single source of protocol identity/validation for the Host
 * Integration v1 (`dsh-bot-v1`). It is deliberately dependency-free and has no
 * side effects so it can be unit-tested and reused by tests/fixtures.
 *
 * Authority boundaries (see .agent/plan/beta2-kernel.md):
 * - Host owns product business state (queue, drafts, receipts, snapshots).
 * - DSH owns turns/tools/official approvals and questions.
 * - This module never talks to DSH, the filesystem, or the network.
 */
import { createHash, randomUUID } from 'node:crypto'

export const PROTOCOL_VERSION = 'dsh-bot-v1'
export const SNAPSHOT_SCHEMA = 'snapshot@1'
export const KERNEL_VERSION = '1'
export const COMMAND_SOURCES = new Set(['worker', 'desktop', 'test'])
export const EVENT_SOURCES = new Set(['host', 'dsh', 'worker', 'desktop', 'test'])
export const MAX_BODY_BYTES = 256 * 1024
export const RECEIPT_STATUSES = new Set(['accepted', 'pending', 'resolved', 'rejected', 'unknown'])

export class ContractError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ContractError'
    this.code = code
    this.status = status
  }
}

/** Stable JSON: object keys sorted recursively, undefined dropped, arrays keep order. */
export function canonicalJson(value) {
  const seen = new Set()
  const walk = (node) => {
    if (node === null || node === undefined) return undefined
    const type = typeof node
    if (type === 'string' || type === 'boolean') return node
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new ContractError('INVALID_JSON', 'non-finite number')
      return node
    }
    if (type === 'bigint' || type === 'symbol' || type === 'function') {
      throw new ContractError('INVALID_JSON', 'unsupported value type: ' + type)
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw new ContractError('INVALID_JSON', 'cyclic value')
      seen.add(node)
      const list = node.map((item) => {
        const next = walk(item)
        return next === undefined ? null : next
      })
      seen.delete(node)
      return list
    }
    if (type === 'object') {
      if (seen.has(node)) throw new ContractError('INVALID_JSON', 'cyclic value')
      seen.add(node)
      const out = {}
      for (const key of Object.keys(node).sort()) {
        const next = walk(node[key])
        if (next !== undefined) out[key] = next
      }
      seen.delete(node)
      return out
    }
    return undefined
  }
  const result = walk(value)
  return result === undefined ? 'null' : JSON.stringify(result)
}

/** SHA-256 hex digest of the canonical JSON form of `value`. */
export function digest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

export function newId(prefix = '') {
  const id = randomUUID()
  return prefix ? prefix + id : id
}

export function nowIso() {
  return new Date().toISOString()
}

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function boundedString(value, max = 4000) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

export function isIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

/** Validate and normalize a client command envelope (before routing). */
export function validateCommand(body, { hostEpoch, sessionId = null } = {}) {
  if (!isPlainObject(body)) throw new ContractError('INVALID_COMMAND', 'command body must be an object')
  if (body.protocolVersion !== PROTOCOL_VERSION) throw new ContractError('UNSUPPORTED_PROTOCOL', 'unsupported protocolVersion', 426)
  const commandId = boundedString(body.commandId, 200)
  if (!commandId) throw new ContractError('MISSING_COMMAND_ID', 'commandId is required')
  if (typeof body.hostEpoch !== 'string' || !body.hostEpoch) throw new ContractError('MISSING_HOST_EPOCH', 'hostEpoch is required')
  if (hostEpoch && body.hostEpoch !== hostEpoch) throw new ContractError('STALE_HOST_EPOCH', 'hostEpoch no longer current; resync snapshot', 409)
  const type = boundedString(body.type, 120)
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(type)) throw new ContractError('INVALID_COMMAND_TYPE', 'unknown command type')
  const sourceConnectionId = boundedString(body.sourceConnectionId, 200)
  if (!sourceConnectionId) throw new ContractError('MISSING_SOURCE', 'sourceConnectionId is required', 401)
  if (body.sessionId !== undefined && body.sessionId !== null && typeof body.sessionId !== 'string') {
    throw new ContractError('INVALID_SESSION', 'sessionId must be a string')
  }
  if (sessionId && body.sessionId && body.sessionId !== sessionId) {
    throw new ContractError('STALE_SESSION', 'sessionId is not the current Bot session', 409)
  }
  const payload = body.payload === undefined ? {} : body.payload
  if (!isPlainObject(payload)) throw new ContractError('INVALID_PAYLOAD', 'payload must be an object')
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    hostEpoch: body.hostEpoch,
    sourceConnectionId,
    sessionId: body.sessionId === undefined ? null : body.sessionId,
    type,
    payload,
  }
}

/** Build a command receipt. Never include secrets, paths outside the product, or raw queue text. */
export function receipt({ commandId, hostEpoch, status, result = {}, error = null, at = nowIso() }) {
  if (!RECEIPT_STATUSES.has(status)) throw new ContractError('INVALID_RECEIPT_STATUS', 'invalid receipt status')
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId,
    hostEpoch,
    status,
    result: isPlainObject(result) ? result : {},
    error: error ? { code: String(error.code || 'COMMAND_ERROR'), message: boundedString(error.message, 1000) } : null,
    at,
  }
}

/**
 * Product option identity. Official stable option ids win when the upstream
 * request carries them. Otherwise the product id is derived from the question
 * id + label + index and is only guaranteed stable inside one semanticRevision;
 * callers must include the semanticRevision when persisting a selection.
 */
export function optionId(questionId, semanticRevision, label, index) {
  const base = [String(questionId || ''), String(semanticRevision ?? ''), String(label ?? ''), String(index ?? '')].join('\u0000')
  return 'opt_' + createHash('sha256').update(base).digest('hex').slice(0, 20)
}

export function stableOptionId(option, questionId, semanticRevision, index) {
  const official = option && typeof option === 'object' ? option.id || option.optionId || option.value?.id : ''
  if (typeof official === 'string' && official !== '') return 'official:' + official
  return optionId(questionId, semanticRevision, option?.label, index)
}

/** Validate an approval decision payload. */
export function approvalDecision(payload) {
  const decision = boundedString(payload?.decision, 40)
  if (!['allowed-once', 'rejected'].includes(decision)) throw new ContractError('INVALID_DECISION', 'decision must be allowed-once or rejected')
  const operationDigest = payload?.operationDigest === undefined ? null : boundedString(payload.operationDigest, 128)
  return { decision, ...(operationDigest ? { operationDigest } : {}) }
}

/**
 * Validate a complete question answer batch.
 * `questions` is the official question array for the bound semanticRevision.
 * Options are matched by stable product/official option id, never by raw position.
 */
export function normalizeAnswerValue(questions, value, { optionIds = null } = {}) {
  if (!Array.isArray(questions) || questions.length === 0) throw new ContractError('INVALID_QUESTION', 'no questions to answer')
  if (!isPlainObject(value) || !Array.isArray(value.answers) || value.answers.length !== questions.length) {
    throw new ContractError('INVALID_ANSWER', 'answer every question exactly once')
  }
  const ids = new Set()
  const answers = value.answers.map((answer) => {
    if (!isPlainObject(answer) || typeof answer.id !== 'string' || ids.has(answer.id)) {
      throw new ContractError('INVALID_ANSWER', 'invalid or repeated question id')
    }
    ids.add(answer.id)
    const index = questions.findIndex((question) => question && question.id === answer.id)
    if (index < 0) throw new ContractError('INVALID_ANSWER', 'unknown question id')
    const question = questions[index]
    const options = Array.isArray(question.options) ? question.options : []
    const selection = Array.isArray(answer.selected) ? answer.selected : []
    if (selection.some((item) => typeof item !== 'string')) throw new ContractError('INVALID_ANSWER', 'selection must be option ids')
    const allowed = new Set(options.map((option, position) => optionIds?.[question.id]?.[position] ?? stableOptionId(option, question.id, value.semanticRevision, position)))
    const selected = [...new Set(selection)]
    if (selected.length !== selection.length) throw new ContractError('INVALID_ANSWER', 'repeated option id')
    if (selected.some((id) => !allowed.has(id))) throw new ContractError('INVALID_ANSWER', 'unknown option id')
    if (question.multiSelect !== true && selected.length > 1) throw new ContractError('INVALID_ANSWER', 'single-select question accepts one option')
    const custom = typeof answer.custom === 'string' ? answer.custom.trim() : ''
    if (custom.length > 20000) throw new ContractError('INVALID_ANSWER', 'custom answer too long')
    if (selected.length === 0 && custom === '' && question.optional !== true && question.multiSelect !== true) {
      throw new ContractError('INVALID_ANSWER', 'an option or custom answer is required')
    }
    return { id: answer.id, selected, ...(custom ? { custom } : {}) }
  })
  return { answers }
}

/** Validate canonical command target identity (session/epoch/interaction/queue). */
export function requireString(value, field, { max = 200, status = 400 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new ContractError('INVALID_FIELD', field + ' is required', status)
  return value.slice(0, max)
}

export function assertEpoch(value, hostEpoch) {
  if (typeof value !== 'string' || value !== hostEpoch) throw new ContractError('STALE_HOST_EPOCH', 'host epoch mismatch', 409)
  return true
}

/** Default empty snapshot sections; callers override every section they own. */
export function emptySnapshotSections() {
  return {
    identity: {},
    connection: {},
    capture: {},
    playback: {},
    execution: {},
    interactions: { focusedId: null, pending: [], drafts: {}, recentlyResolved: [] },
    inputDraft: null,
    queue: { revision: 0, items: [] },
    notices: [],
    presentation: { displayMode: 'idle', priority: [], bubble: { visible: false, requestId: null, kind: null } },
  }
}
