// M4-6 integration: Host Integration memory proxy + digest injected into the agent prompt.
import { spawn, execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'
const ROOT = '/tmp/nisse-m4-memory-host'; const FORK = '$HOME/projects/dsh-bot'
const DSH_HOME = join(ROOT, 'dsh-home'); const HOME = join(ROOT, 'home')
const results = { suite: 'M4-6 memory host integration', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => { const started = Date.now(); try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - started, detail: d }; console.log(`PASS ${name} (${Date.now() - started}ms)`); return d } catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(e?.message || e) }; console.log(`FAIL ${name}: ${e?.message || e}`); throw e } }
const waitFor = async (fn, timeoutMs = 60000, label = 'condition') => { const start = Date.now(); while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await sleep(200) } throw new Error(`timeout ${label}`) }
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true }); mkdirSync(DSH_HOME, { recursive: true })
execFileSync(join(FORK, 'nisse/scripts/install-profile.sh'), [DSH_HOME, 'nisse-smoke', 'false'], { stdio: 'pipe' })
copyFileSync('$HOME/.dsh/.credentials.yaml', join(DSH_HOME, '.credentials.yaml')); try { execFileSync('chmod', ['600', join(DSH_HOME, '.credentials.yaml')]) } catch {}
const sidecar = spawn(process.execPath, ['$HOME/projects/dsh-bot-workspace/m4/memory/sidecar.mjs'], { env: { ...process.env, NISSE_M4_MEMORY_ROOT: ROOT + '/memory', NISSE_M4_BANK: 'nisse:m4:host', HINDSIGHT_URL: 'http://127.0.0.1:18888' }, stdio: ['ignore', 'pipe', 'pipe'] })
let sText = ''; sidecar.stdout.on('data', (d) => { sText += d.toString() }); sidecar.stderr.on('data', (d) => { sText += d.toString() })
let host, ep, side
const api = async (method, path, body) => { const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) }); const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: res.status, json, text } }
const events = async (after = 0) => (await api('GET', `/events?after=${after}`)).json?.events || []
try {
  await step('setup', async () => {
    side = await waitFor(() => { const f = join(ROOT, 'memory', 'sidecar.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'sidecar')
    host = new DshHostSupervisor({ forkDir: FORK, profile: 'nisse-smoke', dshHome: DSH_HOME, homeDir: HOME, logFile: join(ROOT, 'host.log'), extraEnv: { NISSE_MEMORY_URL: `http://127.0.0.1:${side.port}`, NISSE_MEMORY_TOKEN: side.token } })
    const started = await host.start()
    ep = await waitFor(() => { const f = join(DSH_HOME, 'nisse', 'host-integration.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'descriptor')
    const w = await api('POST', '/memory/write', { items: [{ kind: 'fact', text: 'Project Nimbus is the release codename for the next launch.', namespace: 'global' }] })
    if (!w.json?.ok) throw new Error('memory write via host failed: ' + JSON.stringify(w.json).slice(0, 300))
    const created = await api('POST', '/sessions/create', {}); if (!created.json?.sessionId) throw new Error('no session')
    return { pid: started.pid, httpStatus: started.httpStatus, memory: true }
  })
  await step('digest-recall-in-answer', async () => {
    const before = (await events(0)).length
    const res = await api('POST', '/turn', { text: 'What is the release codename for the next launch? 只回答代号。', turnId: 'M4-MEM-1' })
    if (res.status !== 200) throw new Error('turn failed')
    await waitFor(async () => (await events(before)).find((e) => e.type === 'agent.status' && e.data?.status === 'idle'), 180000, 'idle')
    const text = (await events(before)).filter((e) => e.type === 'assistant.delta' || e.type === 'assistant.message').map((e) => String(e.data?.text || e.data?.delta || '')).join('')
    if (!/Nimbus/i.test(text)) throw new Error('memory not used in answer: ' + text.slice(0, 200))
    return { answerPreview: text.slice(0, 160) }
  })
  await step('memory-endpoints', async () => {
    const h = await api('GET', '/memory/health'); if (!h.json?.ok) throw new Error('memory health failed')
    const s = await api('POST', '/memory/search', { query: 'Nimbus codename', namespaces: ['global'], limit: 5, budgetTokens: 500 })
    if (!/Nimbus/i.test(JSON.stringify(s.json?.hits || []))) throw new Error('memory search via host failed')
    const f = await api('POST', '/memory/forget', { filter: { query: 'Nimbus' }, opts: { confirm: true } })
    if (!f.json?.ok) throw new Error('forget via host failed')
    return { health: true, search: true, forget: true }
  })
} finally {
  try { await host?.stop() } catch {}
  try { sidecar.kill('SIGTERM') } catch {}
  await sleep(500)
}
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-MEMORY-HOST-RESULT.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
