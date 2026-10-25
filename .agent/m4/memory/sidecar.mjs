// M4-6 memory sidecar: thin HTTP wrapper over the M1-C Hindsight MemoryAdapter.
// Product Host Integration calls this internal loopback service for memory.* contract ops.
//
// Bot settings (memory page) additionally uses the read/manage endpoints below, behind the
// same bearer token and still zero extra dependencies:
//   POST /list     {query?, limit?, offset?, kind?, namespace?} -> {ok, items, total, hasMore}
//   POST /correct  {id, text, kind?, namespace?}                -> write new + delete old (rollback on failure)
//   POST /delete   {id}                                         -> {ok, result:{invalidated|deletedDocuments,...}}
//   POST /history  {id}                                         -> native Hindsight version history (read-only)
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MemoryAdapter } from '../../spike/m1-c-hindsight/src/index.mjs'
const ROOT = process.env.NISSE_M4_MEMORY_ROOT || '/tmp/nisse-m4-memory'
mkdirSync(join(ROOT, 'run'), { recursive: true })
const token = process.env.NISSE_M4_MEMORY_TOKEN || 'm4-memory-token'
const adapter = new MemoryAdapter({
  baseUrl: process.env.HINDSIGHT_URL || 'http://127.0.0.1:18888',
  bankId: process.env.NISSE_M4_BANK || 'nisse:m4:test',
  writer: 'bot',
  runtimeDir: ROOT,
  bankConfig: { retainExtractionMode: 'chunks', enableObservations: false, storeDocumentText: true },
  identity: 'm4-sidecar:' + process.pid,
})
const body = (req) => new Promise((resolve, reject) => { let s = ''; req.on('data', (d) => { s += d; if (s.length > 1e6) reject(new Error('too large')) }); req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}) } catch (e) { reject(e) } }) })

// ---------------------------------------------------------------------------
// Bot settings memory administration helpers (pure mapping + adapter calls)
// ---------------------------------------------------------------------------
const TAG_NS = 'ns:'
const TAG_KIND = 'kind:'
function tagValue(tags, prefix) {
  if (!Array.isArray(tags)) return undefined
  const found = tags.find((t) => typeof t === 'string' && t.startsWith(prefix))
  return found ? found.slice(prefix.length) : undefined
}
function namespaceOf(item) {
  const metadata = item?.metadata ?? {}
  return (typeof metadata.ns === 'string' && metadata.ns) || tagValue(item?.tags, TAG_NS) || 'global'
}
function kindOf(item) {
  const metadata = item?.metadata ?? {}
  return (typeof metadata.kind === 'string' && metadata.kind) || tagValue(item?.tags, TAG_KIND) || item?.fact_type || 'fact'
}
const intInRange = (value, fallback, min, max) => {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}
function mapItem(item) {
  return {
    id: String(item?.id ?? ''),
    text: String(item?.text ?? ''),
    kind: String(kindOf(item)),
    namespace: String(namespaceOf(item)),
    date: String(item?.mentioned_at ?? item?.date ?? item?.created_at ?? item?.updated_at ?? ''),
    documentId: item?.document_id ?? undefined,
    state: item?.state ?? undefined,
  }
}
async function listItems(b) {
  const limit = intInRange(b.limit, 50, 1, 100)
  const offset = intInRange(b.offset, 0, 0, 1_000_000)
  const query = typeof b.query === 'string' ? b.query.trim().slice(0, 200) : ''
  const kind = typeof b.kind === 'string' ? b.kind.trim() : ''
  const namespace = typeof b.namespace === 'string' ? b.namespace.trim() : ''
  await adapter.ensureBank()
  let page
  try {
    page = await adapter.client.listMemories(adapter.bankId, { limit, offset, state: 'valid', ...(query ? { q: query } : {}) })
  } catch (error) {
    // Older Hindsight servers may reject the free-text `q` filter; fall back to a literal scan.
    if (query === '') throw error
    page = await adapter.client.listMemories(adapter.bankId, { limit: 100, offset: 0, state: 'valid' })
    const scanned = page?.items ?? []
    const needle = query.toLowerCase()
    const filtered = scanned.filter((item) => String(item?.text ?? '').toLowerCase().includes(needle))
    return { items: filtered.slice(offset, offset + limit).map(mapItem), total: filtered.length, offset, limit, hasMore: offset + limit < filtered.length, query }
  }
  let items = (page?.items ?? []).map(mapItem)
  // The native tag filter is OR-based; keep exact kind/namespace equality client-side.
  if (kind !== '') items = items.filter((item) => item.kind === kind)
  if (namespace !== '') items = items.filter((item) => item.namespace === namespace)
  const total = Number.isFinite(Number(page?.total)) ? Number(page?.total) : items.length
  return { items, total, offset, limit, hasMore: offset + items.length < total }
}
async function findItem(id) {
  for (let offset = 0; offset < 5000; offset += 100) {
    const page = await adapter.client.listMemories(adapter.bankId, { limit: 100, offset, state: 'valid' })
    const items = page?.items ?? []
    const found = items.find((item) => item?.id === id)
    if (found) return found
    if (items.length < 100) break
  }
  return null
}
function resultError(code, message, extra = {}) {
  return { ok: false, error: { code, message: String(message).slice(0, 500), ...extra } }
}
async function correctMemory(b) {
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  const text = typeof b.text === 'string' ? b.text.trim().slice(0, 4000) : ''
  if (id === '' || text === '') return { status: 400, payload: resultError('INVALID_REQUEST', 'correct requires id and text') }
  const writer = typeof b.writer === 'string' && b.writer !== '' ? b.writer : 'bot'
  await adapter.ensureBank()
  let previous = null
  try { previous = await findItem(id) } catch { previous = null }
  const kind = (previous && kindOf(previous)) || (typeof b.kind === 'string' && b.kind.trim()) || 'fact'
  const namespace = (previous && namespaceOf(previous)) || (typeof b.namespace === 'string' && b.namespace.trim()) || 'global'
  let written
  try {
    written = await adapter.write([{ kind, text, namespace }], { writer })
  } catch (error) {
    return { status: /SENSITIVE/i.test(String(error?.code || error?.name || '')) ? 400 : 503, payload: resultError(error?.code || 'WRITE_FAILED', error?.message || String(error)) }
  }
  let forgotten
  try {
    forgotten = await adapter.forget({ ids: [id] }, { writer })
  } catch (error) {
    const rollback = await rollbackDocument(written.documentId, writer)
    return { status: 200, payload: resultError('CORRECT_DELETE_FAILED', error?.message || String(error), { documentId: written.documentId, rollback, forget: null }) }
  }
  const deleted = (forgotten.invalidated || 0) + (forgotten.deletedDocuments || 0)
  if (deleted === 0 || forgotten.verified === false) {
    const rollback = await rollbackDocument(written.documentId, writer)
    return { status: 200, payload: resultError('CORRECT_DELETE_FAILED', 'old memory was not deleted; new write rolled back', { documentId: written.documentId, forget: forgotten, rollback }) }
  }
  return {
    status: 200,
    payload: {
      ok: true,
      result: {
        previousId: id,
        documentId: written.documentId,
        itemsWritten: written.itemsWritten,
        forget: forgotten,
        verified: forgotten.verified === true,
      },
    },
  }
}
async function rollbackDocument(documentId, writer) {
  if (typeof documentId !== 'string' || documentId === '') return { ok: false, error: 'missing documentId' }
  try {
    const result = await adapter.forget({ ids: [documentId] }, { writer })
    return { ok: result.verified !== false, result }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}
async function deleteMemory(b) {
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  if (id === '') return { status: 400, payload: resultError('INVALID_REQUEST', 'delete requires id') }
  const writer = typeof b.writer === 'string' && b.writer !== '' ? b.writer : 'bot'
  await adapter.ensureBank()
  const result = await adapter.forget({ ids: [id] }, { writer })
  const deleted = (result.invalidated || 0) + (result.deletedDocuments || 0)
  if (deleted === 0) return { status: 200, payload: resultError('NOT_FOUND', 'memory not found', { result }) }
  return { status: 200, payload: { ok: true, result } }
}
async function memoryHistory(b) {
  const id = typeof b.id === 'string' ? b.id.trim() : ''
  const limit = intInRange(b.limit, 50, 1, 200)
  if (id === '') return { status: 400, payload: resultError('INVALID_REQUEST', 'history requires id') }
  const url = `${adapter.baseUrl}/v1/default/banks/${encodeURIComponent(adapter.bankId)}/memories/${encodeURIComponent(id)}/history`
  const headers = { accept: 'application/json' }
  if (adapter.apiKey) headers.authorization = `Bearer ${adapter.apiKey}`
  let response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
  } catch (error) {
    return { status: 200, payload: { ok: true, items: [], note: 'history unavailable: ' + String(error?.message || error) } }
  }
  if (!response.ok) return { status: 200, payload: { ok: true, items: [], note: 'HTTP ' + response.status } }
  const json = await response.json().catch(() => null)
  const rawItems = Array.isArray(json) ? json : Array.isArray(json?.items) ? json.items : Array.isArray(json?.history) ? json.history : []
  const items = rawItems.slice(0, limit).map((entry) => ({
    at: String(entry?.at ?? entry?.time ?? entry?.timestamp ?? entry?.created_at ?? ''),
    action: String(entry?.action ?? entry?.op ?? entry?.event ?? entry?.type ?? 'history'),
    text: String(entry?.text ?? entry?.content ?? entry?.value ?? ''),
    previousText: String(entry?.previousText ?? entry?.oldText ?? entry?.before ?? ''),
  }))
  return { status: 200, payload: { ok: true, items, history: json } }
}

// ---------------------------------------------------------------------------
// HTTP server (all endpoints require the runtime bearer token)
// ---------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)) }
  if (req.headers.authorization !== 'Bearer ' + token) return send(401, { ok: false, error: 'unauthorized' })
  try {
    if (req.url === '/health') return send(200, { ok: true, ...(await adapter.health()) })
    if (req.url === '/digest' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, digest: await adapter.buildDigest(b) }) }
    if (req.url === '/write' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, result: await adapter.write(b.items, { writer: b.writer || 'bot', ...(b.opts || {}) }) }) }
    if (req.url === '/search' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, hits: await adapter.search(b) }) }
    if (req.url === '/forget' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, result: await adapter.forget(b.filter || {}, { writer: b.writer || 'bot', ...(b.opts || {}) }) }) }
    if (req.url === '/export' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, export: await adapter.export(b) }) }
    if (req.url === '/list' && req.method === 'POST') { const b = await body(req); return send(200, { ok: true, ...(await listItems(b)) }) }
    if (req.url === '/correct' && req.method === 'POST') { const b = await body(req); const r = await correctMemory(b); return send(r.status, r.payload) }
    if (req.url === '/delete' && req.method === 'POST') { const b = await body(req); const r = await deleteMemory(b); return send(r.status, r.payload) }
    if (req.url === '/history' && req.method === 'POST') { const b = await body(req); const r = await memoryHistory(b); return send(r.status, r.payload) }
    return send(404, { ok: false, error: 'not_found' })
  } catch (error) {
    const status = /SENSITIVE/i.test(String(error?.code || error?.name || '')) ? 400 : 503
    return send(status, { ok: false, error: { code: error?.code || error?.name || 'ERROR', message: String(error?.message || error) } })
  }
})
server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  writeFileSync(join(ROOT, 'sidecar.json'), JSON.stringify({ pid: process.pid, port: address.port, token, bank: process.env.NISSE_M4_BANK || 'nisse:m4:test' }, null, 2) + '\n')
  console.log('MEMORY_SIDECAR_READY ' + JSON.stringify({ port: address.port }))
})
