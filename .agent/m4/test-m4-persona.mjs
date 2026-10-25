// M4-5 persona: single source, editable, next-turn effect in the same session.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'
const ROOT = '/tmp/nisse-m4-persona'
const FORK = '$HOME/projects/dsh-bot'
const DSH_HOME = join(ROOT, 'dsh-home'); const HOME = join(ROOT, 'home')
const results = { suite: 'M4-5 persona', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => { const started = Date.now(); try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - started, detail: d }; console.log(`PASS ${name} (${Date.now() - started}ms)`); return d } catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(e?.message || e) }; console.log(`FAIL ${name}: ${e?.message || e}`); throw e } }
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true }); mkdirSync(DSH_HOME, { recursive: true })
execFileSync(join(FORK, 'nisse/scripts/install-profile.sh'), [DSH_HOME, 'nisse-smoke', 'false'], { stdio: 'pipe' })
copyFileSync('$HOME/.dsh/.credentials.yaml', join(DSH_HOME, '.credentials.yaml')); try { execFileSync('chmod', ['600', join(DSH_HOME, '.credentials.yaml')]) } catch {}
const host = new DshHostSupervisor({ forkDir: FORK, profile: 'nisse-smoke', dshHome: DSH_HOME, homeDir: HOME, logFile: join(ROOT, 'host.log') })
let ep
const api = async (method, path, body) => { const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) }); const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: res.status, json, text } }
const events = async (after = 0) => (await api('GET', `/events?after=${after}`)).json?.events || []
const waitFor = async (fn, timeoutMs = 180000, label = 'condition') => { const start = Date.now(); while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await sleep(500) } throw new Error(`timeout ${label}`) }
const runTurn = async (text, turnId) => {
  const before = (await events(0)).length
  const res = await api('POST', '/turn', { text, turnId })
  if (res.status !== 200 || !res.json?.ok) throw new Error(`turn ${res.status} ${res.text.slice(0, 300)}`)
  await waitFor(async () => (await events(before)).find((e) => e.type === 'agent.status' && e.data?.status === 'idle'), 180000, 'idle')
  const list = await events(before)
  return { text: list.filter((e) => e.type === 'assistant.delta' || e.type === 'assistant.message').map((e) => String(e.data?.text || e.data?.delta || '')).join(''), events: list }
}
try {
  await step('setup-host', async () => {
    const started = await host.start()
    ep = await waitFor(() => { const f = join(DSH_HOME, 'nisse', 'host-integration.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'descriptor')
    const created = await api('POST', '/sessions/create', {}); if (!created.json?.sessionId) throw new Error('no session')
    return { pid: started.pid, httpStatus: started.httpStatus, sessionId: created.json.sessionId }
  })
  await step('default-persona', async () => {
    const p = await api('GET', '/persona')
    if (!p.json?.ok || !p.json.persona?.name) throw new Error('persona GET failed')
    return { name: p.json.persona.name }
  })
  await step('persona-set-next-turn', async () => {
    const set = await api('POST', '/persona', { name: '小蓝', personality: '可爱', tone: '简短', instructions: '回答末尾必须加【蓝】' })
    if (!set.json?.ok) throw new Error('persona set failed')
    await sleep(500)
    const t = await runTurn('请只回复好。', 'M4-PERSONA-1')
    if (!t.text.includes('【蓝】')) throw new Error(`persona marker missing: ${t.text.slice(0, 160)}`)
    return { marker: '【蓝】', answerPreview: t.text.slice(0, 120) }
  })
  await step('persona-change-next-turn', async () => {
    const set = await api('POST', '/persona', { name: '小蓝', personality: '可爱', tone: '简短', instructions: '回答末尾必须加【橙】' })
    if (!set.json?.ok) throw new Error('persona change failed')
    await sleep(500)
    const t = await runTurn('请只回复好。', 'M4-PERSONA-2')
    if (!t.text.includes('【橙】')) throw new Error(`new persona marker missing: ${t.text.slice(0, 160)}`)
    if (t.text.includes('【蓝】')) throw new Error('old persona marker leaked into new turn')
    return { marker: '【橙】', answerPreview: t.text.slice(0, 120) }
  })
  await step('persisted-persona', async () => {
    const file = join(DSH_HOME, 'nisse', 'persona.json')
    if (!existsSync(file)) throw new Error('persona file missing')
    const p = JSON.parse(readFileSync(file, 'utf8'))
    if (!String(p.instructions).includes('【橙】')) throw new Error('persona file not updated')
    return { file, instructions: p.instructions }
  })
} finally { try { await host.stop() } catch {} }
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-PERSONA-RESULT.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
