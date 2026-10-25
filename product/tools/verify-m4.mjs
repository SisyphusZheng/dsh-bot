#!/usr/bin/env node
// verify-m4.mjs — repeatable M4 verification orchestrator (exit-code judged).
//
// Modes:
//   (default)      deterministic local suites + REAL approval allow/reject E2E (real model)
//   --no-model     deterministic local suites only; approval E2E reported as SKIP (UNVERIFIED)
//   --full         additionally rerun the full M4 E2E/security suite (m4/run-all.mjs, 6 files)
//
// What it runs:
//   1. m4/test-m4-stop-semantics.mjs   deterministic, no host/network (voice state + product state)
//   2. m4/test-m4-memory.mjs           local Hindsight + mock LLM sidecar (zero egress); if the
//                                      Hindsight server was not running before this step, it is
//                                      stopped again afterwards (cleanup)
//   3. tools/m4-approval-e2e.mjs       REAL DSH host in isolated /tmp DSH_HOME + real model turn,
//                                      write tool to a path outside the workspace, bridge
//                                      /approval answered allow/reject; asserts allow => file
//                                      exists, reject => file absent  (requires ~/.dsh credentials)
//   4. m4/run-all.mjs                  only with --full: the 6-file M4 E2E/security suite
//
// Evidence: m4/evidence/VERIFY-M4.json (summary) + the step suites' own result JSONs.
// Exit codes: 0 all executed-and-required steps PASS; 1 any FAIL; 2 preflight/usage error.
// No writes outside nisse/m4 and /tmp; ~/.dsh is only read (credentials copied read-only
// into the isolated DSH_HOME by the approval E2E).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const NISSE = resolve(HERE, '..')
const FORK = process.env.NISSE_DSH_FORK || '$HOME/projects/dsh-bot'
const EVIDENCE_DIR = join(NISSE, 'm4', 'evidence')
const SUMMARY_FILE = join(EVIDENCE_DIR, 'VERIFY-M4.json')
const APPROVAL_RESULT = join(EVIDENCE_DIR, 'HOST-APPROVAL-RERUN.json')
const HINDSIGHT_HEALTH = 'http://127.0.0.1:18888/health'
const HINDSIGHT_STOP = join(NISSE, 'spike/m1-c-hindsight/scripts/stop-server.sh')
const NODE = process.execPath

const args = new Set(process.argv.slice(2))
if (args.has('-h') || args.has('--help')) {
  console.log('usage: tools/verify-m4.sh [--no-model] [--full]\n' +
    '  default     deterministic local suites + real approval allow/reject E2E (real model)\n' +
    '  --no-model  skip the real-model approval E2E (reported SKIP/UNVERIFIED)\n' +
    '  --full      also rerun the full 6-file M4 E2E/security suite (real model)')
  process.exit(0)
}
const noModel = args.has('--no-model')
const full = args.has('--full')

const summary = {
  suite: 'M4 repeatable verification (verify-m4)',
  startedAt: new Date().toISOString(),
  env: {
    node: process.version,
    nodeBin: NODE,
    fork: FORK,
    mode: noModel ? 'deterministic-only' : full ? 'default+full' : 'default',
    isolation: {
      approvalDshHome: '/tmp/nisse-m4-approval-verify/dsh-home',
      note: 'approval E2E uses an isolated /tmp DSH_HOME; ~/.dsh is only read for a credentials copy',
    },
  },
  preflight: {},
  steps: {},
  ok: false,
}

function finish(code, message) {
  summary.ok = code === 0
  summary.finishedAt = new Date().toISOString()
  summary.exitCode = code
  if (message) summary.message = message
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 2) + '\n')
  } catch {}
  const marks = { PASS: '✅ PASS', FAIL: '❌ FAIL', SKIP: '⚠️  SKIP' }
  console.log('\n=== verify-m4 summary (' + summary.env.mode + ') ===')
  for (const [name, step] of Object.entries(summary.steps)) {
    console.log(`${marks[step.status] || step.status}  ${name}  (${step.ms ?? '?'}ms)` + (step.detail ? '  ' + step.detail : ''))
  }
  console.log('evidence: ' + SUMMARY_FILE)
  console.log('result: ' + (code === 0 ? 'PASS' : code === 2 ? 'PRECHECK FAILED' : 'FAIL'))
  process.exit(code)
}

function preflight() {
  const checks = {}
  const bad = []
  const major = Number(String(process.versions.node).split('.')[0])
  checks.node = { ok: major >= 22, value: process.version }
  checks.dshCli = { ok: existsSync(join(FORK, 'apps/cli/lib/bin.js')), value: join(FORK, 'apps/cli/lib/bin.js') }
  checks.installProfile = { ok: existsSync(join(FORK, 'nisse/scripts/install-profile.sh')), value: join(FORK, 'nisse/scripts/install-profile.sh') }
  checks.supervisor = { ok: existsSync(join(NISSE, 'm3/supervisor/supervisor.mjs')), value: join(NISSE, 'm3/supervisor/supervisor.mjs') }
  try {
    execFileSync('which', ['zstd'], { stdio: 'pipe' })
    checks.zstd = { ok: true, value: 'on PATH' }
  } catch {
    checks.zstd = { ok: false, value: 'missing' }
  }
  const credentials = join(process.env.HOME || '', '.dsh', '.credentials.yaml')
  const credOk = existsSync(credentials) && readFileSync(credentials, 'utf8').trim().length > 0
  checks.credentials = { ok: credOk, value: credentials, required: !noModel }
  summary.preflight = checks
  for (const [name, check] of Object.entries(checks)) {
    if (!check.ok && (check.required !== false)) bad.push(name)
  }
  if (bad.length) finish(2, 'preflight failed: ' + bad.join(', '))
}

async function runStep(name, command, argv, { timeoutMs = 900000 } = {}) {
  const started = Date.now()
  const step = { command: [command, ...argv].join(' '), status: 'FAIL', ms: null, exitCode: null, tail: '' }
  summary.steps[name] = step
  console.log(`\n>>> ${name}: ${step.command}`)
  const code = await new Promise((resolvePromise) => {
    const child = spawn(command, argv, { cwd: NISSE, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.once('exit', (exitCode, signal) => {
      clearTimeout(timer)
      step.exitCode = exitCode
      step.signal = signal || null
      step.tail = out.trim().split('\n').slice(-6).join(' | ')
      console.log(step.tail)
      resolvePromise(exitCode ?? 1)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      step.tail = String(error?.message || error)
      resolvePromise(1)
    })
  })
  step.ms = Date.now() - started
  step.status = code === 0 ? 'PASS' : 'FAIL'
  return code
}

async function hindsightUp() {
  try {
    const res = await fetch(HINDSIGHT_HEALTH, { signal: AbortSignal.timeout(2000) })
    return res.status === 200
  } catch {
    return false
  }
}

async function main() {
  preflight()

  // 1) deterministic: stop-speaking vs cancel-task semantics (no host, no network)
  const stopCode = await runStep('stop-semantics', NODE, [join(NISSE, 'm4/test-m4-stop-semantics.mjs')], { timeoutMs: 120000 })
  if (stopCode !== 0) finish(1, 'stop-semantics failed')

  // 2) deterministic: memory adapter against local Hindsight (mock LLM, zero egress)
  const hindsightWasUp = await hindsightUp()
  const memoryCode = await runStep('memory-adapter', NODE, [join(NISSE, 'm4/test-m4-memory.mjs')], { timeoutMs: 300000 })
  if (!hindsightWasUp) {
    // The memory test starts the spike Hindsight server; stop it again so verification is
    // hermetic. stop-server.sh is idempotent.
    const stop = await new Promise((resolvePromise) => {
      const child = spawn(HINDSIGHT_STOP, [], { cwd: NISSE, stdio: ['ignore', 'pipe', 'pipe'] })
      child.once('exit', (code) => resolvePromise(code ?? 1))
      child.once('error', () => resolvePromise(1))
    })
    summary.steps['memory-adapter'].hindsightCleanup = { wasRunningBefore: false, stoppedAfter: stop === 0, stopExit: stop }
  } else {
    summary.steps['memory-adapter'].hindsightCleanup = { wasRunningBefore: true, stoppedAfter: false }
  }
  if (memoryCode !== 0) finish(1, 'memory-adapter failed')

  // 3) real approval allow/reject E2E (real model; skipped with --no-model)
  if (noModel) {
    summary.steps['approval-e2e'] = {
      status: 'SKIP',
      ms: 0,
      reason: '--no-model: real-model approval E2E not executed; result UNVERIFIED',
    }
  } else {
    const code = await runStep('approval-e2e', NODE, [join(NISSE, 'tools/m4-approval-e2e.mjs')], { timeoutMs: 900000 })
    let approval = null
    try { approval = JSON.parse(readFileSync(APPROVAL_RESULT, 'utf8')) } catch {}
    summary.steps['approval-e2e'].evidence = APPROVAL_RESULT
    summary.steps['approval-e2e'].cases = approval?.cases
      ? Object.fromEntries(Object.entries(approval.cases).map(([key, value]) => [key, {
        pass: value.pass, ms: value.ms, fileExists: value.fileExists,
        expectedFileExists: value.expectedFileExists, outcome: value.approval?.answer?.outcome ?? null,
      }]))
      : null
    if (code !== 0 || approval?.ok !== true) finish(1, 'approval-e2e failed')
  }

  // 4) optional full 6-file suite (real model)
  if (full) {
    const code = await runStep('full-e2e-suite', NODE, [join(NISSE, 'm4/run-all.mjs')], { timeoutMs: 1500000 })
    const suiteFile = join(EVIDENCE_DIR, 'M4-E2E-SUITE.json')
    try {
      const suite = JSON.parse(readFileSync(suiteFile, 'utf8'))
      summary.steps['full-e2e-suite'].results = suite.tests?.map((t) => ({ file: t.file, code: t.code, ms: t.ms }))
      summary.steps['full-e2e-suite'].evidence = suiteFile
    } catch {}
    if (code !== 0) finish(1, 'full-e2e-suite failed')
  }

  finish(0)
}

main().catch((error) => {
  summary.error = String(error?.stack || error)
  finish(1, 'unhandled: ' + (error?.message || error))
})
