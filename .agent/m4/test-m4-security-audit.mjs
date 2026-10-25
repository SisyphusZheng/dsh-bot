// M4-7/8 security + audit: always-allow scope/TTL/revocation, approval binding,
// cancel/persona audit, secret scan.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'
const ROOT = '/tmp/nisse-m4-security'
const FORK = '$HOME/projects/dsh-bot'
const DSH_HOME = join(ROOT, 'dsh-home'); const HOME = join(ROOT, 'home')
const EVIDENCE = '$HOME/projects/dsh-bot-workspace/m4/evidence'
const results = { suite: 'M4-7/8 security+audit', startedAt: new Date().toISOString(), steps: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = async (name, fn) => { const started = Date.now(); try { const d = await fn(); results.steps[name] = { status: 'PASS', ms: Date.now() - started, detail: d }; console.log(`PASS ${name} (${Date.now() - started}ms)`); return d } catch (e) { results.steps[name] = { status: 'FAIL', ms: Date.now() - started, error: String(e?.message || e) }; console.log(`FAIL ${name}: ${e?.message || e}`); throw e } }
rmSync(ROOT, { recursive: true, force: true }); mkdirSync(HOME, { recursive: true }); mkdirSync(DSH_HOME, { recursive: true }); mkdirSync(join(EVIDENCE, 'policy', 'revoked'), { recursive: true }); mkdirSync(join(EVIDENCE, 'policy', 'ttl'), { recursive: true })
execFileSync(join(FORK, 'nisse/scripts/install-profile.sh'), [DSH_HOME, 'nisse-smoke', 'true'], { stdio: 'pipe' })
copyFileSync('$HOME/.dsh/.credentials.yaml', join(DSH_HOME, '.credentials.yaml')); try { execFileSync('chmod', ['600', join(DSH_HOME, '.credentials.yaml')]) } catch {}
const host = new DshHostSupervisor({ forkDir: FORK, profile: 'nisse-smoke', dshHome: DSH_HOME, homeDir: HOME, logFile: join(ROOT, 'host.log') })
let ep
const api = async (method, path, body) => { const res = await fetch(`http://127.0.0.1:${ep.port}${path}`, { method, headers: { authorization: 'Bearer ' + ep.token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(180000) }); const text = await res.text(); let json = null; try { json = JSON.parse(text) } catch {} return { status: res.status, json, text } }
const events = async (after = 0) => (await api('GET', `/events?after=${after}`)).json?.events || []
const waitFor = async (fn, timeoutMs = 180000, label = 'condition') => { const start = Date.now(); while (Date.now() - start < timeoutMs) { const v = await fn(); if (v) return v; await sleep(400) } throw new Error(`timeout ${label}`) }
const waitIdle = async (after) => waitFor(async () => (await events(after)).find((e) => e.type === 'agent.status' && e.data?.status === 'idle'), 180000, 'idle')
const drainUntilIdle = async (after, timeoutMs = 180000) => {
  const handled = new Set()
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const list = await events(after)
    for (const e of list) {
      if (e.type === 'approval.request' && e.data?.id && !handled.has(e.data.id)) {
        handled.add(e.data.id)
        await api('POST', '/approval', { id: e.data.id, decision: 'reject' }).catch(() => {})
      }
    }
    if (list.some((e) => e.type === 'agent.status' && e.data?.status === 'idle')) return true
    await sleep(500)
  }
  throw new Error('timeout draining to idle')
}
const submit = async (text, turnId) => { const res = await api('POST', '/turn', { text, turnId }); if (res.status !== 200) throw new Error(`turn ${res.status} ${res.text.slice(0, 200)}`); return (await events(0)).length }
const audit = async () => (await api('GET', '/audit?limit=500')).json?.events || []
try {
  await step('setup', async () => {
    const started = await host.start()
    ep = await waitFor(() => { const f = join(DSH_HOME, 'nisse', 'host-integration.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null }, 60000, 'descriptor')
    const created = await api('POST', '/sessions/create', {}); if (!created.json?.sessionId) throw new Error('no session')
    return { pid: started.pid, httpStatus: started.httpStatus }
  })
  await step('always-allow-scope', async () => {
    const policy = await api('POST', '/policies', { toolName: 'write', ttlMs: 60000 })
    if (!policy.json?.ok) throw new Error('policy add failed')
    const before = (await events(0)).length
    const target = join(EVIDENCE, 'policy', 'auto-allowed.txt'); try { rmSync(target, { force: true }) } catch {}
    const startIdx = await submit(`请用 write 工具把一行 hello scope 写进 ${target}，只写这一行。`, 'M4-SEC-1')
    await waitFor(() => existsSync(target), 90000, 'auto-allowed file')
    const list = await events(startIdx)
    if (list.some((e) => e.type === 'approval.request')) throw new Error('auto-allow still asked for approval')
    const a = await audit()
    if (!a.some((e) => e.event === 'policy.auto_allow')) throw new Error('no policy.auto_allow audit')
    rmSync(target, { force: true })
    await drainUntilIdle(startIdx)
    return { policyId: policy.json.rule.id, autoAllowed: true }
  })
  await step('revocation', async () => {
    const existing = await api('GET', '/policies')
    for (const rule of existing.json?.rules || []) await api('DELETE', `/policies?id=${rule.id}`)
    const policy = await api('POST', '/policies', { toolName: 'write', ttlMs: 60000 })
    const removed = await api('DELETE', `/policies?id=${policy.json.rule.id}`)
    if (!removed.json?.ok || removed.json.removed !== 1) throw new Error('policy revoke failed')
    const target = join(EVIDENCE, 'policy', 'revoked', 'should-ask.txt'); try { rmSync(target, { force: true }) } catch {}
    const startIdx = await submit(`请用 write 工具把一行 hello revoke 写进 ${target}，只写这一行。`, 'M4-SEC-2')
    const approval = await waitFor(async () => (await events(startIdx)).find((e) => e.type === 'approval.request' && e.data?.id), 120000, 'approval after revoke')
    const wrong = await api('POST', '/approval', { id: 'not-a-real-id', decision: 'allow' })
    if (wrong.status !== 404) throw new Error(`wrong id accepted: ${wrong.status}`)
    await api('POST', '/approval', { id: approval.data.id, decision: 'reject' })
    await drainUntilIdle(startIdx)
    if (existsSync(target)) throw new Error('revoked policy still wrote file')
    return { revokedPolicyId: policy.json.rule.id, approvalAsked: true, wrongIdRejected: true, fileExists: false }
  })
  await step('ttl-expiry', async () => {
    const existing = await api('GET', '/policies')
    for (const rule of existing.json?.rules || []) await api('DELETE', `/policies?id=${rule.id}`)
    const policy = await api('POST', '/policies', { toolName: 'write', ttlMs: 800 })
    await sleep(1200)
    const target = join(EVIDENCE, 'policy', 'ttl', 'should-ask.txt'); try { rmSync(target, { force: true }) } catch {}
    const startIdx = await submit(`请用 write 工具把一行 hello ttl 写进 ${target}，只写这一行。`, 'M4-SEC-3')
    const approval = await waitFor(async () => (await events(startIdx)).find((e) => e.type === 'approval.request' && e.data?.id), 120000, 'approval after ttl')
    await api('POST', '/approval', { id: approval.data.id, decision: 'reject' })
    await drainUntilIdle(startIdx)
    if (existsSync(target)) throw new Error('expired policy still wrote file')
    const listed = await api('GET', '/policies')
    if (listed.json.rules.some((r) => r.id === policy.json.rule.id)) throw new Error('expired policy still listed')
    return { ttlMs: 800, expired: true, approvalAsked: true }
  })
  await step('cancel-and-persona-audit', async () => {
    const startIdx = await submit('请写一篇 800 字长文，主题是安静。直接输出正文。', 'M4-SEC-4')
    await sleep(1200)
    const cancel = await api('POST', '/cancel', {})
    if (!cancel.json?.cancelled) throw new Error('cancel failed')
    await drainUntilIdle(startIdx).catch(() => {})
    const persona = await api('POST', '/persona', { name: '小蓝', personality: '可爱', tone: '简短', instructions: '回答末尾加【蓝】' })
    if (!persona.json?.ok) throw new Error('persona set failed')
    const a = await audit()
    for (const want of ['session.cancelled', 'persona.changed', 'approval.requested', 'approval.decided']) {
      if (!a.some((e) => e.event === want)) throw new Error(`audit missing ${want}`)
    }
    return { events: a.length }
  })
  await step('secret-scan', async () => {
    const files = [join(DSH_HOME, 'nisse', 'audit.jsonl'), join(ROOT, 'host.log')]
    const token = ep.token
    const findings = []
    for (const file of files) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      if (token && text.includes(token)) findings.push({ file, pattern: 'bridge-token' })
      if (/sk-[A-Za-z0-9]{20,}/.test(text)) findings.push({ file, pattern: 'api-key-like' })
      if (/OPENCODE_GO_API_KEY\s*[:=]\s*\S+/.test(text)) findings.push({ file, pattern: 'env-key-assignment' })
    }
    if (findings.length) throw new Error('secret-like material found: ' + JSON.stringify(findings))
    return { scanned: files.length, findings: 0 }
  })
} finally { try { await host.stop() } catch {} }
results.ok = Object.values(results.steps).every((s) => s.status === 'PASS')
results.finishedAt = new Date().toISOString()
writeFileSync(join(EVIDENCE, 'M4-SECURITY-AUDIT-RESULT.json'), JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, summary: Object.fromEntries(Object.entries(results.steps).map(([k, v]) => [k, v.status])) }))
process.exit(results.ok ? 0 : 1)
