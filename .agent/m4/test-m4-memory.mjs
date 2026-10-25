// M4-6 memory v1: Hindsight local server + thin adapter sidecar. Write/recall/forget/export.
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const ROOT = '/tmp/nisse-m4-memory'
const results = { suite: 'M4-6 memory v1', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => { const started = Date.now(); try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - started, detail: d }; console.log(`PASS ${name} (${Date.now() - started}ms)`); return d } catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(e?.message || e) }; console.log(`FAIL ${name}: ${e?.message || e}`); throw e } }
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(ROOT, { recursive: true })
const health = async () => { try { const r = await fetch('http://127.0.0.1:18888/health', { signal: AbortSignal.timeout(3000) }); return r.status === 200 } catch { return false } }
if (!(await health())) { execFileSync('$HOME/projects/dsh-bot-workspace/spike/m1-c-hindsight/scripts/run-server.sh', [], { stdio: 'pipe' }); for (let i = 0; i < 120 && !(await health()); i++) await sleep(500) }
const sidecar = spawn(process.execPath, ['$HOME/projects/dsh-bot-workspace/m4/memory/sidecar.mjs'], { env: { ...process.env, NISSE_M4_MEMORY_ROOT: ROOT }, stdio: ['ignore', 'pipe', 'pipe'] })
let sText = ''; sidecar.stdout.on('data', (d) => { sText += d.toString() }); sidecar.stderr.on('data', (d) => { sText += d.toString() })
const waitFor = async (fn, timeoutMs = 60000, label = 'condition') => { const start = Date.now(); while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await sleep(200) } throw new Error(`timeout ${label}`) }
let ep
const api = async (method, path, body) => { const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120000) }); return { status: res.status, json: await res.json().catch(() => null) } }
try {
  await step('sidecar-start', async () => {
    ep = await waitFor(() => { const f = join(ROOT, 'sidecar.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'sidecar')
    const h = await api('GET', '/health'); if (!h.json?.ok) throw new Error('health failed')
    return { port: ep.port, bank: ep.bank, health: h.json }
  })
  await step('write-recall', async () => {
    const w = await api('POST', '/write', { items: [
      { kind: 'fact', text: 'Project Nimbus is the release codename.', namespace: 'global' },
      { kind: 'fact', text: 'The design team is located in Shanghai.', namespace: 'global' },
      { kind: 'preference', text: 'The user prefers concise answers in Chinese.', namespace: 'global' },
    ] })
    if (!w.json?.ok) throw new Error('write failed: ' + JSON.stringify(w.json).slice(0, 300))
    const hits = await api('POST', '/search', { query: 'Which codename did we choose for the release?', namespaces: ['global'], limit: 5, budgetTokens: 800 })
    const text = JSON.stringify(hits.json?.hits || [])
    if (!/Nimbus/i.test(text)) throw new Error('recall did not find Nimbus: ' + text.slice(0, 300))
    const sh = await api('POST', '/search', { query: 'Where is the design team located?', namespaces: ['global'], limit: 5, budgetTokens: 800 })
    if (!/Shanghai/i.test(JSON.stringify(sh.json?.hits || []))) throw new Error('recall did not find Shanghai')
    return { write: w.json.result?.documents?.length ?? w.json.result?.ids?.length ?? 'ok', nimbus: true, shanghai: true }
  })
  await step('sensitive-rejected', async () => {
    const w = await api('POST', '/write', { items: [{ kind: 'fact', text: 'The API key is [REDACTED_KEY]', namespace: 'global' }] })
    if (w.status !== 400) throw new Error('sensitive write not rejected: ' + w.status)
    return { status: w.status, code: w.json?.error?.code }
  })
  await step('forget-not-recallable', async () => {
    const f = await api('POST', '/forget', { filter: { query: 'Nimbus' }, opts: { confirm: true } })
    if (!f.json?.ok) throw new Error('forget failed: ' + JSON.stringify(f.json).slice(0, 300))
    await sleep(800)
    const hits = await api('POST', '/search', { query: 'Project Nimbus release codename', namespaces: ['global'], limit: 5, budgetTokens: 800 })
    if (/Nimbus/i.test(JSON.stringify(hits.json?.hits || []))) throw new Error('deleted memory still recallable')
    return { forget: f.json.result, noNimbus: true }
  })
  await step('export', async () => {
    const e = await api('POST', '/export', { format: 'jsonl', limit: 1000 })
    if (!e.json?.ok) throw new Error('export failed: ' + JSON.stringify(e.json).slice(0, 300))
    const path = e.json.export?.path || e.json.export?.file || null
    if (!path || !existsSync(path)) throw new Error('export path missing/not found: ' + String(path))
    return { path, bytes: e.json.export?.bytes ?? null }
  })
} finally {
  try { sidecar.kill('SIGTERM') } catch {}
  await sleep(500)
}
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-MEMORY-RESULT.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
