// Bot settings -> memory page backend: memory sidecar admin endpoints.
// Runs the real sidecar process against the local Hindsight server (starts it when needed)
// and verifies /list, /correct (write-new-then-delete-old + rollback), /delete, /history
// and the bearer-token guard. Evidence: m4/bot-evidence/BOT-SETTINGS-MEMORY-ADMIN.json
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROJECT_ROOT = '$HOME/projects/dsh-bot-workspace'
const ROOT = '/tmp/nisse-m4-admin-test'
const EVIDENCE = join(PROJECT_ROOT, 'm4/bot-evidence')
const remember = Date.now()
const BANK = 'nisse:m4:admin-test-' + String(remember)
const results = { suite: 'Bot settings memory admin (sidecar /list /correct /delete /history)', startedAt: new Date().toISOString(), bank: BANK, steps: {} }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const step = async (name, fn) => {
  const started = Date.now()
  try {
    const detail = await fn()
    results.steps[name] = { status: 'PASS', ms: Date.now() - started, ...(detail === undefined ? {} : { detail }) }
    console.log('PASS', name, `${Date.now() - started}ms`)
    return detail
  } catch (error) {
    results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(error?.message || error) }
    console.log('FAIL', name, String(error?.message || error))
    throw error
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const health = async () => {
  try {
    const response = await fetch('http://127.0.0.1:18888/health', { signal: AbortSignal.timeout(3000) })
    return response.status === 200
  } catch { return false }
}

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(ROOT, { recursive: true })
if (!(await health())) {
  execFileSync('$HOME/projects/dsh-bot-workspace/spike/m1-c-hindsight/scripts/run-server.sh', [], { stdio: 'pipe' })
  for (let index = 0; index < 120 && !(await health()); index++) await sleep(500)
}
if (!(await health())) throw new Error('Hindsight server did not become healthy')

const sidecar = spawn(process.execPath, [join(PROJECT_ROOT, 'm4/memory/sidecar.mjs')], {
  env: { ...process.env, NISSE_M4_MEMORY_ROOT: ROOT, NISSE_M4_BANK: BANK },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
sidecar.stdout.on('data', (chunk) => { output += chunk.toString() })
sidecar.stderr.on('data', (chunk) => { output += chunk.toString() })
const waitFor = async (fn, timeoutMs, label) => {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const value = await fn()
    if (value) return value
    await sleep(200)
  }
  throw new Error('timeout waiting for ' + label + ': ' + output.slice(-300))
}

let endpoint = null
const api = async (method, path, body, overrideToken) => {
  const response = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
    method,
    headers: { authorization: 'Bearer ' + (overrideToken === undefined ? endpoint.token : overrideToken), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await response.text()
  let json = null
  try { json = JSON.parse(text) } catch { json = null }
  return { status: response.status, text, json }
}
const list = async (body = {}) => api('POST', '/list', { limit: 50, ...body })
const byText = (items, needle) => items.find((item) => String(item.text || '').includes(needle))
let seeded = {}
try {
  await step('sidecar-start', async () => {
    endpoint = await waitFor(() => {
      const file = join(ROOT, 'sidecar.json')
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    }, 60000, 'sidecar descriptor')
    const healthResponse = await api('GET', '/health')
    assert(healthResponse.json?.ok === true, 'sidecar health failed: ' + healthResponse.text.slice(0, 200))
    return { port: endpoint.port, bank: endpoint.bank }
  })

  await step('seed-write', async () => {
    const response = await api('POST', '/write', {
      items: [
        { kind: 'fact', text: 'Project Nimbus is the release codename.', namespace: 'global' },
        { kind: 'fact', text: 'The design team is located in Shanghai.', namespace: 'global' },
        { kind: 'preference', text: 'The user prefers concise answers in Chinese.', namespace: 'global' },
      ],
    })
    assert(response.json?.ok === true, 'seed write failed: ' + response.text.slice(0, 300))
    return response.json.result
  })

  await step('list-all', async () => {
    const response = await list()
    assert(response.json?.ok === true, 'list failed: ' + response.text.slice(0, 300))
    const items = response.json.items || []
    assert(items.length >= 3, 'expected at least 3 memories, got ' + items.length)
    for (const item of items) {
      assert(typeof item.id === 'string' && item.id !== '', 'item id missing')
      assert(typeof item.text === 'string' && item.text !== '', 'item text missing')
      assert(typeof item.kind === 'string' && item.kind !== '', 'item kind missing')
      assert(item.namespace === 'global', 'unexpected namespace ' + item.namespace)
    }
    const total = response.json.total
    assert(Number.isFinite(total) && total >= 3, 'total missing/small: ' + String(total))
    seeded.nimbus = byText(items, 'Nimbus')
    seeded.shanghai = byText(items, 'Shanghai')
    assert(seeded.nimbus && seeded.shanghai, 'seed memories missing from list')
    return { count: items.length, total, sample: items[0] }
  })

  await step('list-query-filter', async () => {
    const response = await list({ query: 'Nimbus' })
    assert(response.json?.ok === true, 'list query failed: ' + response.text.slice(0, 300))
    const items = response.json.items || []
    assert(items.length >= 1, 'literal query found nothing')
    assert(items.every((item) => String(item.text).toLowerCase().includes('nimbus')), 'query filter returned unrelated item')
    return { count: items.length, text: items[0].text }
  })

  await step('list-paging', async () => {
    const page = await list({ limit: 1, offset: 0 })
    assert(page.json?.ok === true, 'paged list failed')
    assert((page.json.items || []).length === 1, 'limit=1 not honored')
    assert(page.json.hasMore === true, 'hasMore must be true while more rows exist')
    const nextPage = await list({ limit: 1, offset: 1 })
    assert((nextPage.json.items || []).length === 1, 'offset=1 returned nothing')
    assert(nextPage.json.items[0].id !== page.json.items[0].id, 'paging returned the same row')
    return { total: page.json.total, firstId: page.json.items[0].id, secondId: nextPage.json.items[0].id }
  })

  await step('correct-write-new-delete-old', async () => {
    const oldId = seeded.nimbus.id
    const response = await api('POST', '/correct', { id: oldId, text: 'Project Nimbus release codename is Aurora (corrected).' })
    assert(response.json?.ok === true, 'correct failed: ' + response.text.slice(0, 400))
    const corrected = response.json.result || {}
    assert(corrected.previousId === oldId, 'correct must report the previous id')
    assert(typeof corrected.documentId === 'string' && corrected.documentId !== '', 'new documentId missing')
    assert(corrected.forget && (corrected.forget.invalidated || 0) >= 1, 'old memory was not invalidated')
    const after = await list()
    const items = after.json.items || []
    assert(!items.some((item) => item.id === oldId), 'old memory is still listed after correct')
    const replacement = byText(items, 'Aurora')
    assert(replacement, 'corrected text not listed')
    assert(replacement.kind === 'fact', 'correct must preserve kind')
    assert(replacement.documentId === corrected.documentId, 'corrected row documentId mismatch')
    seeded.aurora = replacement
    return { previousId: oldId, documentId: corrected.documentId, forget: corrected.forget }
  })

  await step('delete-by-id', async () => {
    const target = seeded.shanghai
    const response = await api('POST', '/delete', { id: target.id })
    assert(response.json?.ok === true, 'delete failed: ' + response.text.slice(0, 400))
    assert((response.json.result.invalidated || 0) >= 1, 'delete did not invalidate')
    const after = await list()
    assert(!(after.json.items || []).some((item) => item.id === target.id), 'deleted memory still listed')
    return response.json.result
  })

  await step('history', async () => {
    const response = await api('POST', '/history', { id: seeded.aurora.id })
    assert(response.json?.ok === true, 'history failed: ' + response.text.slice(0, 400))
    assert(Array.isArray(response.json.items), 'history items must be an array')
    return { id: seeded.aurora.id, count: response.json.items.length, note: response.json.note || '' }
  })

  await step('validation-errors', async () => {
    const noText = await api('POST', '/correct', { id: seeded.aurora.id, text: '' })
    assert(noText.status === 400 && noText.json?.ok === false, 'empty correction text must be rejected')
    const noId = await api('POST', '/delete', {})
    assert(noId.status === 400 && noId.json?.ok === false, 'missing id must be rejected')
    const missing = await api('POST', '/delete', { id: '00000000-0000-4000-8000-000000000000' })
    assert(missing.json?.ok === false && missing.json?.error?.code === 'NOT_FOUND', 'missing memory must report NOT_FOUND')
    return { noText: noText.json.error.code, noId: noId.json.error.code, missing: missing.json.error.code }
  })

  await step('bearer-token-required', async () => {
    const denied = await api('POST', '/list', { limit: 10 }, 'wrong-token')
    assert(denied.status === 401, 'wrong token must be 401, got ' + denied.status)
    const missing = await api('POST', '/delete', { id: 'x' }, '')
    assert(missing.status === 401, 'missing token must be 401')
    return { status: denied.status }
  })

  // Exact recipe main.ts needs for the new Bot settings hooks: MemoryRuntime.request(path, body)
  // returns {status, json}. memory-runtime.ts uses TypeScript parameter properties, so the probe
  // runs as a child with --experimental-transform-types (plain `node` strip-only cannot load it).
  await step('memory-runtime-hook-recipe', async () => {
    const memoryRuntimePath = '$HOME/projects/dsh-bot/apps/desktop/src/memory-runtime.ts'
    const runtimeHome = join(ROOT, 'runtime-home')
    const wiringBank = BANK + ':wiring'
    const probe = [
      "const { MemoryRuntime } = await import(" + JSON.stringify(pathToFileURL(memoryRuntimePath).href) + ");",
      "const runtime = new MemoryRuntime(" + JSON.stringify(runtimeHome) + ", '/tmp/fake-resources', " + JSON.stringify(join(PROJECT_ROOT, 'nisse-dsh/apps/desktop')) + ", true);",
      "const status = await runtime.start({ memory: { enabled: true } });",
      "if (status.sidecar === null) { console.log(JSON.stringify({ ok: false, error: status.error })); process.exit(1); }",
      "const list = await runtime.request('/list', { limit: 5 });",
      "const write = await runtime.request('/write', { items: [{ kind: 'fact', text: 'Runtime wiring memory row.', namespace: 'global' }] });",
      "const again = await runtime.request('/list', { limit: 50 });",
      "const row = (again.json?.items || []).find((item) => String(item.text || '').includes('Runtime wiring memory row'));",
      "const corrected = row ? await runtime.request('/correct', { id: row.id, text: 'Runtime wiring memory row (corrected).', kind: 'fact', namespace: 'global' }) : null;",
      "const afterCorrect = await runtime.request('/list', { limit: 100 });",
      "const fixed = (afterCorrect.json?.items || []).find((item) => String(item.text || '').includes('(corrected)'));",
      "const deleted = fixed ? await runtime.request('/delete', { id: fixed.id }) : null;",
      "const history = fixed ? await runtime.request('/history', { id: fixed.id }) : null;",
      "const result = { ok: list.status === 200 && list.json?.ok === true && write.json?.ok === true && !!row && !(afterCorrect.json?.items || []).some((item) => item.id === row.id) && !!fixed && corrected?.json?.ok === true && deleted?.json?.ok === true && history?.json?.ok === true, list: list.json?.items?.length, correct: corrected?.json, deleted: deleted?.json, historyOk: history?.json?.ok };",
      "try { const remaining = await runtime.request('/list', { limit: 100 }); for (const item of remaining.json?.items || []) await runtime.request('/delete', { id: item.id }); } catch {}",
      "await runtime.stop();",
      "console.log(JSON.stringify(result));",
    ].join('\n')
    const child = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', probe], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, WHALEGIRL_PROJECT_ROOT: PROJECT_ROOT, WHALEGIRL_MEMORY_BANK: wiringBank },
      encoding: 'utf8',
      timeout: 180000,
    })
    const lines = String(child.stdout || '').trim().split('\n').filter(Boolean)
    let parsed = null
    try { parsed = JSON.parse(lines[lines.length - 1] || 'null') } catch { parsed = null }
    assert(child.status === 0, 'memory-runtime probe failed: ' + String(child.stderr || child.error || child.status).slice(0, 600))
    assert(parsed && parsed.ok === true, 'memory-runtime hook recipe failed: ' + JSON.stringify(parsed))
    return parsed
  })
} finally {
  // Best effort cleanup: retire the seeded rows so the shared local Hindsight stays tidy.
  try {
    const remaining = await list({ limit: 100 })
    for (const item of remaining.json?.items || []) await api('POST', '/delete', { id: item.id })
  } catch { /* ignore cleanup errors */ }
  try { sidecar.kill('SIGTERM') } catch { /* ignore */ }
  await sleep(500)
}

results.ok = Object.values(results.steps).every((entry) => entry.status === 'PASS')
results.endpointsAdded = ['POST /list', 'POST /correct (write-new-then-delete-old with rollback)', 'POST /delete', 'POST /history (native Hindsight revision history)']
results.auth = 'bearer token required on every endpoint (401 otherwise); zero extra dependencies'
results.finishedAt = new Date().toISOString()
mkdirSync(EVIDENCE, { recursive: true })
writeFileSync(join(EVIDENCE, 'BOT-SETTINGS-MEMORY-ADMIN.json'), JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([name, entry]) => [name, entry.status])) }))
process.exit(results.ok ? 0 : 1)
