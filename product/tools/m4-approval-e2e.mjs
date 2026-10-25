#!/usr/bin/env node
// M4 approval allow/reject E2E: real DSH host in an isolated DSH_HOME, real model turn,
// real `write` tool call to a path OUTSIDE the agent workspace, bridge approval answered
// through the Host Integration `/approval` endpoint. Asserts:
//   allow  => target file exists with content
//   reject => target file does NOT exist
// Adapted from the Lead's /tmp/approval-host-e2e.mjs probe (2026-10-22), de-hardcoded:
//   - isolated roots under /tmp, never touches ~/.dsh (~/.dsh/.credentials.yaml is only
//     read and copied read-only into the isolated DSH_HOME, mode 600)
//   - evidence + result paths are configurable and default under nisse/m4/evidence/
// Requires: node >= 22, built DSH CLI in the product fork, readable model credentials,
//           zstd on PATH (DSH host dependency), nisse install-profile.sh with the
//           `bot-outside-write` permission preset (danger-full-access + approval ask).
import { execFileSync } from 'node:child_process'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DshHostSupervisor } from '../m3/supervisor/supervisor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NISSE = resolve(HERE, '..')
const FORK = process.env.NISSE_DSH_FORK || '$HOME/projects/dsh-bot'
const ROOT = process.env.NISSE_M4_APPROVAL_ROOT || '/tmp/nisse-m4-approval-verify'
const DSH_HOME = join(ROOT, 'dsh-home')
const HOME = join(ROOT, 'home')
const EVIDENCE_DIR = process.env.NISSE_M4_APPROVAL_EVIDENCE_DIR || join(NISSE, 'm4', 'evidence', 'approval-rerun')
const RESULT_FILE = process.env.NISSE_M4_APPROVAL_RESULT_FILE || join(NISSE, 'm4', 'evidence', 'HOST-APPROVAL-RERUN.json')
const CREDENTIALS = join(process.env.HOME || '', '.dsh', '.credentials.yaml')
const CLI = join(FORK, 'apps/cli/lib/bin.js')
const INSTALL_PROFILE = join(FORK, 'nisse/scripts/install-profile.sh')
const PROMPT_FOR = (target) => `请用 write 工具把一行 hello 写入文件 ${target} ，只执行这一步，不要征求我的意见。`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const result = {
  suite: 'M4 approval allow/reject E2E (real DSH host, real model, bridge /approval)',
  env: {
    node: process.version,
    fork: FORK,
    isolatedDshHome: DSH_HOME,
    evidenceDir: EVIDENCE_DIR,
    credentialsSource: CREDENTIALS,
  },
  startedAt: new Date().toISOString(),
  forkCommit: null,
  preflight: {},
  cases: {},
  ok: false,
}

function fail(message) {
  result.error = message
  result.finishedAt = new Date().toISOString()
  try {
    mkdirSync(dirname(RESULT_FILE), { recursive: true })
    writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n')
  } catch {}
  console.error('PREFLIGHT FAIL: ' + message)
  process.exit(2)
}

function preflight() {
  let version = null
  try {
    version = execFileSync(process.execPath, ['--version'], { encoding: 'utf8' }).trim()
  } catch {}
  const major = Number(String(process.versions.node).split('.')[0])
  if (!(major >= 22)) fail(`node >= 22 required, got ${process.version}`)
  if (!existsSync(CLI)) fail(`built DSH CLI not found: ${CLI}`)
  if (!existsSync(INSTALL_PROFILE)) fail(`install-profile.sh not found: ${INSTALL_PROFILE}`)
  if (!existsSync(CREDENTIALS) || !readFileSync(CREDENTIALS, 'utf8').trim()) {
    fail(`model credentials missing/empty: ${CREDENTIALS} (real-model approval E2E needs the opencode-go credentials)`)
  }
  try {
    execFileSync('which', ['zstd'], { stdio: 'pipe' })
  } catch {
    fail('zstd not on PATH (DSH host dependency)')
  }
  try {
    result.forkCommit = execFileSync('git', ['-C', FORK, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {}
  result.preflight = { nodeVersion: version, cli: CLI, credentialsReadable: true, zstd: true, forkCommit: result.forkCommit }
}

async function main() {
  preflight()

  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(DSH_HOME, { recursive: true })
  rmSync(EVIDENCE_DIR, { recursive: true, force: true })
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  mkdirSync(dirname(RESULT_FILE), { recursive: true })

  // Profile + read-only credential copy (never write ~/.dsh).
  execFileSync(INSTALL_PROFILE, [DSH_HOME, 'nisse-smoke', 'true'], { stdio: 'pipe' })
  copyFileSync(CREDENTIALS, join(DSH_HOME, '.credentials.yaml'))
  try { execFileSync('chmod', ['600', join(DSH_HOME, '.credentials.yaml')]) } catch {}

  const host = new DshHostSupervisor({
    forkDir: FORK,
    profile: 'nisse-smoke',
    dshHome: DSH_HOME,
    homeDir: HOME,
    logFile: join(ROOT, 'host.log'),
    startupTimeoutMs: 120000,
  })
  let endpoint = null
  const api = async (path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${endpoint.port}${path}`, {
      method,
      headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(150000),
    })
    const text = await res.text()
    let json = null
    try { json = JSON.parse(text) } catch {}
    return { status: res.status, json, text }
  }
  const events = async (after = 0) => (await api(`/events?after=${after}`)).json?.events || []
  const waitFor = async (fn, { timeoutMs = 180000, label = 'condition', intervalMs = 400 } = {}) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const value = await fn()
      if (value) return value
      await sleep(intervalMs)
    }
    throw new Error(`timeout waiting for ${label}`)
  }

  try {
    result.host = await host.start()
    endpoint = await waitFor(() => {
      const file = join(DSH_HOME, 'nisse', 'host-integration.json')
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null
    }, { timeoutMs: 90000, label: 'host-integration descriptor' })
    const health = await api('/health')
    result.contractVersion = health.json?.contractVersion || null
    result.pluginVersion = health.json?.pluginVersion || null

    const created = await api('/sessions/create', 'POST', {})
    result.sessionId = created.json?.sessionId || null
    if (!result.sessionId) throw new Error('session create failed: ' + created.text.slice(0, 300))

    for (const [name, decision] of [['allow', 'allow'], ['reject', 'reject']]) {
      const target = join(EVIDENCE_DIR, `host-approval-${name}.txt`)
      rmSync(target, { force: true })
      const startedAt = Date.now()
      const before = (await events(0)).length
      const turn = await api('/turn', 'POST', { text: PROMPT_FOR(target), turnId: 'M4-VERIFY-' + name + '-' + startedAt })
      if (turn.status !== 200) throw new Error(`${name} turn rejected: ${turn.status} ${turn.text.slice(0, 300)}`)
      let approval = null
      let ended = null
      while (Date.now() - startedAt < 240000) {
        for (const e of await events(before)) {
          if (!approval && e.type === 'approval.request' && e.data?.id) {
            approval = { ...e.data }
            approval.answer = (await api('/approval', 'POST', { id: e.data.id, decision })).json
          }
          if (e.type === 'turn.ended') ended = e
        }
        if (approval && ended) break
        await sleep(400)
      }
      // Give the fs tool a moment to settle before the final assertion.
      await sleep(1500)
      const fileExists = existsSync(target)
      const fileContent = fileExists ? readFileSync(target, 'utf8') : null
      const expectedFileExists = decision === 'allow'
      const answerOutcome = approval?.answer?.outcome || null
      const expectedOutcome = decision === 'allow' ? 'allowed-once' : 'rejected'
      result.cases[name] = {
        decision,
        target,
        expectedFileExists,
        fileExists,
        fileContent,
        approval: approval ? {
          id: approval.id,
          toolName: approval.toolName,
          reason: approval.reason,
          answer: approval.answer,
        } : null,
        ended: ended ? ended.data : null,
        ms: Date.now() - startedAt,
        pass: Boolean(approval) &&
          Boolean(ended) &&
          answerOutcome === expectedOutcome &&
          fileExists === expectedFileExists &&
          (!expectedFileExists || (fileContent !== null && fileContent.trim().length > 0)),
      }
      if (!result.cases[name].pass) {
        result.cases[name].diagnostics = {
          hostLogTail: existsSync(join(ROOT, 'host.log'))
            ? readFileSync(join(ROOT, 'host.log'), 'utf8').trim().split('\n').slice(-10)
            : [],
          eventTypes: (await events(before)).map((e) => e.type),
        }
      }
    }
  } finally {
    try { await host.stop() } catch {}
  }

  result.ok = Object.values(result.cases).every((c) => c && c.pass) && Object.keys(result.cases).length === 2
  result.finishedAt = new Date().toISOString()
  writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({
    ok: result.ok,
    resultFile: RESULT_FILE,
    cases: Object.fromEntries(Object.entries(result.cases).map(([k, v]) => [k, {
      pass: v.pass,
      ms: v.ms,
      fileExists: v.fileExists,
      expectedFileExists: v.expectedFileExists,
      outcome: v.approval?.answer?.outcome ?? null,
      toolName: v.approval?.toolName ?? null,
    }])),
  }, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  result.error = String(error?.stack || error)
  result.finishedAt = new Date().toISOString()
  try {
    mkdirSync(dirname(RESULT_FILE), { recursive: true })
    writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2) + '\n')
  } catch {}
  console.error('FAIL: ' + (error?.message || error))
  process.exit(1)
})
