// M4 main paths (text-injected E2E; real mic/TCC deferred to user): Q&A, in-workspace
// file task, outside-workspace approval allow, history, cancel.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'

const ROOT = '/tmp/nisse-m4-paths'
const FORK = '$HOME/projects/dsh-bot'
const DSH_HOME = join(ROOT, 'dsh-home')
const HOME = join(ROOT, 'home')
const results = { suite: 'M4 main paths', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => {
  const started = Date.now()
  try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - started, detail: d }; console.log(`PASS ${name} (${Date.now() - started}ms)`); return d }
  catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(e?.message || e) }; console.log(`FAIL ${name}: ${e?.message || e}`); throw e }
}
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true }); mkdirSync(DSH_HOME, { recursive: true })
execFileSync(join(FORK, 'nisse/scripts/install-profile.sh'), [DSH_HOME, 'nisse-smoke', 'true'], { stdio: 'pipe' })
copyFileSync('$HOME/.dsh/.credentials.yaml', join(DSH_HOME, '.credentials.yaml'))
try { execFileSync('chmod', ['600', join(DSH_HOME, '.credentials.yaml')]) } catch {}
const host = new DshHostSupervisor({ forkDir: FORK, profile: 'nisse-smoke', dshHome: DSH_HOME, homeDir: HOME, logFile: join(ROOT, 'host.log') })
let ep, sessionId
const api = async (method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) })
  const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}
const events = async (after = 0) => (await api('GET', `/events?after=${after}`)).json?.events || []
const waitFor = async (fn, timeoutMs = 180000, label = 'condition') => { const start = Date.now(); while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await sleep(500) } throw new Error(`timeout ${label}`) }
const waitTurnIdle = async (after) => waitFor(async () => {
  const list = (await events(after)).filter((e) => e.type === 'agent.status' && e.data?.status === 'idle')
  return list.length ? list.at(-1) : null
}, 180000, 'turn idle')
const runTurn = async (text, turnId) => {
  const before = (await events(0)).length
  const res = await api('POST', '/turn', { text, turnId })
  if (res.status !== 200 || !res.json?.ok) throw new Error(`turn rejected ${res.status} ${res.text.slice(0, 200)}`)
  await waitTurnIdle(before)
  const list = await events(before)
  const textOut = list.filter((e) => e.type === 'assistant.delta' || e.type === 'assistant.message').map((e) => String(e.data?.text || e.data?.delta || '')).join('')
  return { textOut, events: list }
}
try {
  await step('setup-host', async () => {
    const started = await host.start()
    ep = await waitFor(() => { const f = join(DSH_HOME, 'nisse', 'host-integration.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'descriptor')
    const created = await api('POST', '/sessions/create', {})
    if (!created.json?.sessionId) throw new Error('no session')
    sessionId = created.json.sessionId
    return { pid: started.pid, httpStatus: started.httpStatus, sessionId }
  })
  await step('path1-qa', async () => {
    const t = await runTurn('请用一句话说明你能做什么。', 'M4-P1')
    if (!t.textOut.trim()) throw new Error('empty answer')
    return { answerPreview: t.textOut.slice(0, 120), eventCount: t.events.length }
  })
  await step('path2a-inside-workspace-file', async () => {
    const target = join(DSH_HOME, 'workspace', 'm4-inside.txt')
    try { rmSync(target, { force: true }) } catch {}
    const t = await runTurn(`请用 write 工具把一行 hello m4 写进 ${target}，只写这一行。`, 'M4-P2A')
    await waitFor(() => existsSync(target), 60000, 'inside file')
    const content = readFileSync(target, 'utf8').trim()
    if (!content.includes('hello m4')) throw new Error('wrong content')
    return { target, content, answerPreview: t.textOut.slice(0, 80) }
  })
  await step('path2b-outside-approval-allow', async () => {
    const target = '$HOME/projects/dsh-bot-workspace/m4/evidence/outside-allow.txt'
    try { rmSync(target, { force: true }) } catch {}
    const before = (await events(0)).length
    const res = await api('POST', '/turn', { text: `请用 write 工具把一行 hello m4 写进 ${target}，只写这一行。`, turnId: 'M4-P2B' })
    if (res.status !== 200) throw new Error('turn rejected')
    const approval = await waitFor(async () => (await events(before)).find((e) => e.type === 'approval.request' && e.data?.id), 120000, 'approval')
    const decision = await api('POST', '/approval', { id: approval.data.id, decision: 'allow' })
    if (!decision.json?.ok || decision.json?.outcome !== 'allowed-once') throw new Error('approval allow failed')
    await waitFor(() => existsSync(target), 60000, 'outside file')
    const content = readFileSync(target, 'utf8').trim()
    if (!content.includes('hello m4')) throw new Error('wrong outside content')
    rmSync(target, { force: true })
    return { approvalId: approval.data.id, created: true, cleanedUp: true }
  })
  await step('path3-history', async () => {
    const h = await api('GET', '/history?limit=50')
    if (!h.json?.ok || !h.json.events?.length) throw new Error('history empty')
    const types = new Set(h.json.events.map((e) => e.type))
    for (const want of ['user.message', 'assistant.message']) if (!types.has(want)) throw new Error(`history missing ${want}`)
    const tool = h.json.events.find((e) => e.type === 'tool.call')
    if (!tool) throw new Error('history missing tool.call')
    return { count: h.json.events.length, types: [...types], toolPreview: tool.summary?.name }
  })
  await step('path4-cancel', async () => {
    const before = (await events(0)).length
    await api('POST', '/turn', { text: '请写一篇 800 字长文，主题是安静。直接输出正文。', turnId: 'M4-P4' })
    await sleep(1200)
    const cancel = await api('POST', '/cancel', {})
    if (!cancel.json?.ok || cancel.json?.cancelled !== true) throw new Error(`cancel failed ${cancel.text.slice(0, 200)}`)
    await waitTurnIdle(before)
    return { cancelled: true }
  })
} finally {
  try { await host.stop() } catch {}
}
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-PATHS-RESULT.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
