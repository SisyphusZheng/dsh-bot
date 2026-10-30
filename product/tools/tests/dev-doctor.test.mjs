import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  DOCTOR_SCHEMA,
  DOCTOR_STATUS,
  formatDoctorHuman,
  parseLsofListeners,
  resolveDoctorPaths,
  runDevDoctor,
} from '../dev-doctor.mjs'

const DOCTOR_PATH = join(import.meta.dirname, '..', 'dev-doctor.mjs')
const sha256 = value => createHash('sha256').update(value).digest('hex')

function writeFile(path, content = '', options = {}) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content, options)
}

function memoryPayload(payloadPath) {
  const sidecar = 'export const staged = true\n'
  writeFile(join(payloadPath, 'VERSION.json'), JSON.stringify({
    schema: 'dsh-bot.memory/v2',
    generatedAt: '2026-10-30T14:34:19.364Z',
    product: { name: 'dsh-bot', version: '0.0.1-beta' },
    runtime: { name: 'DeepSeek Harness', version: '0.2.1-rc.3' },
    dependencies: { hindsight: '1.0.0', postgres: '18.1.0' },
    components: [{ path: 'runtime/hindsight', files: 1, sha256: 'fixture' }],
    sidecarSha256: sha256(sidecar),
  }, null, 2))
  writeFile(join(payloadPath, 'sidecar.mjs'), sidecar)
  writeFile(join(payloadPath, 'scripts/run-server.sh'), '#!/bin/bash\nexit 0\n')
  writeFile(join(payloadPath, 'adapter/m1-c-hindsight/src/index.js'), 'export {}\n')
  writeFile(join(payloadPath, 'runtime/hindsight/HindsightAPI'), 'fixture\n')
  writeFile(join(payloadPath, 'runtime/models/Xenova/multilingual-e5-small/onnx/model_int8.onnx'), 'fixture\n')
  writeFile(join(payloadPath, 'runtime/pg0/installation/18.1.0/bin/postgres'), 'fixture\n')
}

function doctorFixture({ memory = true, envOverride = null, dirty = false, descriptors = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dev-doctor-'))
  const appRoot = join(root, 'apps/desktop')
  const userData = join(root, 'user-data')
  const dshHome = join(userData, 'dsh-home')
  const lock = 'hindsight==1.0.0\n'
  writeFile(join(root, 'product/versions.json'), JSON.stringify({
    product: { name: 'dsh-bot', version: '0.0.1-beta' },
    runtime: { version: '0.2.1-rc.3' },
    voice: { lockSha256: sha256(lock) },
    memory: { hindsight: '1.0.0', postgres: '18.1.0' },
  }))
  writeFile(join(appRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.0.1-beta' }))
  writeFile(join(root, 'apps/cli/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.3' }))
  writeFile(join(root, 'apps/desktop-host/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '0.2.1-rc.3' }))
  writeFile(join(root, 'apps/desktop-host/lib/index.js'), 'export {}\n')
  writeFile(join(appRoot, 'lib/main.js'), 'export {}\n')
  writeFile(join(appRoot, 'scripts/dev.ts'), 'export {}\n')
  for (const file of ['pet.html', 'bubble.html', 'bubble-window.mjs', 'window-layer-policy.mjs']) writeFile(join(appRoot, 'resources/pet', file), 'fixture\n')
  writeFile(join(appRoot, 'node_modules/electron/path.txt'), 'Electron.app/Contents/MacOS/Electron')
  writeFile(join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), 'fixture\n')
  mkdirSync(join(appRoot, '.desktop-build/targets/mac-arm64/runtime/primary-runtime'), { recursive: true })
  writeFile(join(root, 'product/voice-worker-src/requirements-macos.lock'), lock)
  mkdirSync(join(root, '.mvv-build/voice-venv/bin'), { recursive: true })
  writeFile(join(root, '.mvv-build/voice-venv/bin/python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  if (memory) memoryPayload(join(root, '.mvv-build/memory'))
  if (envOverride) memoryPayload(envOverride)
  if (descriptors) {
    writeFile(join(dshHome, 'bot/bridge.json'), JSON.stringify({ port: 7_002, token: 'bridge-token-1234', pid: 4_242 }))
    writeFile(join(dshHome, 'memory/runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:7001', token: 'memory-token-1234', bank: 'whalegirl:bot' }))
  }
  return { root, appRoot, userData, dshHome, lock, dirty }
}

function fakeExec({ listeners = [], gitFails = false } = {}) {
  return (command, args) => {
    if (command === 'git') {
      if (gitFails) return { ok: false, status: 128, stdout: '', stderr: 'not a git repository', error: null }
      if (args.includes('status')) return { ok: true, status: 0, stdout: '', stderr: '', error: null }
      if (args.includes('--abbrev-ref')) return { ok: true, status: 0, stdout: 'work/0.0.1-beta2\n', stderr: '', error: null }
      if (args.includes('^{tree}')) return { ok: true, status: 0, stdout: 'fixture-tree\n', stderr: '', error: null }
      return { ok: true, status: 0, stdout: 'fixture-head\n', stderr: '', error: null }
    }
    if (command === 'lsof') {
      return { ok: true, status: 0, stdout: listeners.join('\n'), stderr: '', error: null }
    }
    if (String(command).endsWith('/python')) {
      if (args[0] === '--version') return { ok: true, status: 0, stdout: 'Python 3.12.13\n', stderr: '', error: null }
      if (args[0] === '-c') return { ok: true, status: 0, stdout: 'voice-deps-ok\n', stderr: '', error: null }
    }
    return { ok: false, status: 127, stdout: '', stderr: `unexpected command ${command}`, error: null }
  }
}

function fakeHttpGet(downMemory = false) {
  return async (url) => {
    if (url === 'http://127.0.0.1:7001/health') {
      return downMemory
        ? { ok: false, status: 503, json: null, text: '', error: 'unavailable' }
        : { ok: true, status: 200, json: { ok: true, bankId: 'whalegirl:bot' }, text: '', error: null }
    }
    if (url === 'http://127.0.0.1:7002/health') {
      return { ok: true, status: 200, json: { pid: 4_242 }, text: '', error: null }
    }
    return { ok: false, status: 0, json: null, text: '', error: 'ECONNREFUSED' }
  }
}

const lsofRows = [
  'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME',
  'Electron 4242 user 4u  IPv4 0x123  0t0  TCP 127.0.0.1:7002 (LISTEN)',
  'node     4243 user 5u  IPv4 0x124  0t0  TCP 127.0.0.1:7001 (LISTEN)',
]

function checkById(report, id) {
  const found = report.checks.find(entry => entry.id === id)
  assert.ok(found, `missing check ${id}`)
  return found
}

test('doctor resolves the documented dev launch paths without Electron', () => {
  const fixture = doctorFixture()
  try {
    const paths = resolveDoctorPaths({ repositoryRoot: fixture.root, env: {}, platform: 'darwin', arch: 'arm64' })
    assert.equal(paths.userData, join(fixture.appRoot, '.desktop-build', 'development', 'electron-user-data'))
    assert.equal(paths.dshHome, join(paths.userData, 'dsh-home'))
    assert.equal(paths.bridgeDescriptor, join(paths.dshHome, 'bot', 'bridge.json'))
    assert.equal(paths.memoryDescriptor, join(paths.dshHome, 'memory', 'runtime.json'))
    assert.equal(paths.primaryRuntime, join(fixture.appRoot, '.desktop-build/targets/mac-arm64/runtime/primary-runtime'))
    assert.equal(paths.voicePython, join(fixture.root, '.mvv-build/voice-venv/bin/python'))
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a healthy dev preflight is PASS with manual/UNKNOWN items and no fake TCC pass', async () => {
  const fixture = doctorFixture()
  try {
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      now: () => new Date('2026-10-30T00:00:00.000Z'),
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: fakeHttpGet(),
    })
    assert.equal(report.schema, DOCTOR_SCHEMA)
    assert.equal(report.readOnly, true)
    assert.equal(report.status, DOCTOR_STATUS.pass)
    assert.equal(report.generatedAt, '2026-10-30T00:00:00.000Z')
    assert.equal(report.summary.total, report.checks.length)
    assert.equal(report.summary.fail, 0)
    assert.equal(checkById(report, 'memory.payload').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'identity.build').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'identity.product').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'voice.venv').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'voice.lock').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'launch.path').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'bridge.descriptor').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'bridge.health').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'memory.descriptor').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'memory.health').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'ports.bridge').status, DOCTOR_STATUS.pass)
    assert.equal(checkById(report, 'ports.memory').status, DOCTOR_STATUS.pass)
    const tcc = checkById(report, 'platform.tcc-microphone')
    assert.equal(tcc.status, DOCTOR_STATUS.unknown)
    assert.notEqual(tcc.status, DOCTOR_STATUS.pass)
    assert.equal(tcc.evidenceLevel, 'manual')
    assert.ok(formatDoctorHuman(report).includes('read-only'))
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a missing Memory payload is a FAIL naming build-memory.sh (never a fake ready)', async () => {
  const fixture = doctorFixture({ memory: false })
  try {
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: fakeHttpGet(),
    })
    assert.equal(report.status, DOCTOR_STATUS.fail)
    const memory = checkById(report, 'memory.payload')
    assert.equal(memory.status, DOCTOR_STATUS.fail)
    assert.match(memory.detail, /bash product\/tools\/build-memory\.sh/u)
    assert.ok(memory.remediation.includes('bash product/tools/build-memory.sh'))
    assert.ok(report.nextActions.includes('bash product/tools/build-memory.sh'))
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('an explicit NISSE_MEMORY_DIR payload is WARN with source+validation, not a silent PASS', async () => {
  const fixture = doctorFixture({ memory: false })
  const override = join(fixture.root, 'explicit-memory')
  try {
    memoryPayload(override)
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: { NISSE_MEMORY_DIR: override },
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: fakeHttpGet(),
    })
    const memory = checkById(report, 'memory.payload')
    assert.equal(memory.status, DOCTOR_STATUS.warn)
    assert.equal(memory.evidence.source, 'env-override')
    assert.equal(memory.evidence.envOverride.name, 'NISSE_MEMORY_DIR')
    assert.equal(memory.evidence.envOverride.path, override)
    assert.equal(memory.evidence.envOverride.valid, true)
    assert.ok(memory.remediation.includes('bash product/tools/build-memory.sh'))
    assert.equal(report.status, DOCTOR_STATUS.pass, 'a WARN does not fail the read-only gate')
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('dirty source is a WARN, not a silent PASS or a FAIL', async () => {
  const fixture = doctorFixture()
  try {
    const exec = (command, args, options) => {
      if (command === 'git' && args.includes('status')) return { ok: true, status: 0, stdout: ' M product/pet/src/bubble-window.mjs\n', stderr: '', error: null }
      return fakeExec({ listeners: lsofRows })(command, args, options)
    }
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec,
      httpGet: fakeHttpGet(),
    })
    assert.equal(checkById(report, 'identity.source').status, DOCTOR_STATUS.warn)
    assert.equal(report.status, DOCTOR_STATUS.pass)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('malformed descriptors and stale health are classified exactly', async () => {
  const fixture = doctorFixture()
  try {
    writeFile(join(fixture.dshHome, 'bot/bridge.json'), '{broken json')
    writeFile(join(fixture.dshHome, 'memory/runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:7001', token: 'memory-token-1234' }))
    let report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: fakeHttpGet(),
    })
    assert.equal(checkById(report, 'bridge.descriptor').status, DOCTOR_STATUS.unknown)
    assert.equal(checkById(report, 'bridge.health').status, DOCTOR_STATUS.unknown)
    assert.equal(checkById(report, 'memory.health').status, DOCTOR_STATUS.pass)

    // A structurally valid descriptor whose /health reports another pid is stale.
    writeFile(join(fixture.dshHome, 'bot/bridge.json'), JSON.stringify({ port: 7_002, token: 'bridge-token-1234', pid: 4_242 }))
    report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: async (url) => (url === 'http://127.0.0.1:7002/health'
        ? { ok: true, status: 200, json: { pid: 9999 }, text: '', error: null }
        : fakeHttpGet()(url)),
    })
    assert.equal(checkById(report, 'bridge.health').status, DOCTOR_STATUS.fail)
    assert.match(checkById(report, 'bridge.health').detail, /stale/u)
    assert.equal(report.status, DOCTOR_STATUS.fail)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('a dead Memory health endpoint is FAIL even when the descriptor looks valid', async () => {
  const fixture = doctorFixture()
  try {
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners: lsofRows }),
      httpGet: fakeHttpGet(true),
    })
    assert.equal(checkById(report, 'memory.health').status, DOCTOR_STATUS.fail)
    assert.equal(report.status, DOCTOR_STATUS.fail)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('ports are reported with owning PIDs and unrelated listeners are only ever WARN', async () => {
  const fixture = doctorFixture()
  try {
    const listeners = [
      ...lsofRows,
      'other    5150 user 6u  IPv4 0x125  0t0  TCP 127.0.0.1:8765 (LISTEN)',
      'Electron 4242 user 7u  IPv4 0x126  0t0  TCP 127.0.0.1:9229 (LISTEN)',
    ]
    const report = await runDevDoctor({
      repositoryRoot: fixture.root,
      env: {},
      platform: 'darwin',
      arch: 'arm64',
      userData: fixture.userData,
      exec: fakeExec({ listeners }),
      httpGet: fakeHttpGet(),
    })
    const voicePort = checkById(report, 'ports.voice')
    assert.equal(voicePort.status, DOCTOR_STATUS.warn)
    assert.match(voicePort.detail, /did not kill/u)
    const bridge = checkById(report, 'ports.bridge')
    assert.equal(bridge.status, DOCTOR_STATUS.pass)
    assert.equal(bridge.evidence.port, 7_002)
    assert.deepEqual(bridge.evidence.listeners.map(entry => entry.pid), [4_242])
    assert.equal(report.status, DOCTOR_STATUS.pass, 'unrelated listeners warn but do not fail the doctor')
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('lsof listener parsing ignores headers and handles loopback address forms', () => {
  const listeners = parseLsofListeners([
    'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME',
    'node 11 me 4u IPv4 0x1 0t0 TCP 127.0.0.1:8765 (LISTEN)',
    'node 12 me 5u IPv6 0x2 0t0 TCP [::1]:9229 (LISTEN)',
    '*:7000 (LISTEN)',
  ].join('\n'))
  assert.deepEqual(listeners.map(entry => [entry.pid, entry.port]), [[11, 8765], [12, 9229]])
})

test('the doctor source contains no destructive or signalling operation', () => {
  const source = readFileSync(DOCTOR_PATH, 'utf8')
  assert.doesNotMatch(source, /\brmSync\s*\(/u)
  assert.doesNotMatch(source, /\bunlinkSync\s*\(/u)
  assert.doesNotMatch(source, /\bwriteFileSync\s*\(/u)
  assert.doesNotMatch(source, /\bmkdirSync\s*\(/u)
  assert.doesNotMatch(source, /\bprocess\.kill\s*\(/u)
  assert.doesNotMatch(source, /\bexecFileSync\s*\(/u)
  assert.match(source, /readOnly: true/u)
})

test('the CLI emits parseable read-only JSON, exits 1 on FAIL, spawns nothing destructive, and writes no files', () => {
  const fixture = doctorFixture({ memory: false })
  try {
    const tree = directory => readdirSync(directory, { recursive: true }).sort().map(path => `${relative(directory, path)}:${statSync(join(directory, path)).size}`)
    const before = tree(fixture.root)
    // The build wrapper exports NISSE_MEMORY_DIR for its own dev run; the doctor CLI
    // test must not inherit it or the missing-payload fixture becomes a WARN override.
    const isolatedEnv = { ...process.env }
    delete isolatedEnv.NISSE_MEMORY_DIR
    delete isolatedEnv.DSH_HOME
    const result = spawnSync(process.execPath, [DOCTOR_PATH, '--json', '--repo', fixture.root, '--user-data', fixture.userData], { encoding: 'utf8', timeout: 120_000, env: isolatedEnv })
    assert.equal(result.status, 1, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.equal(report.schema, DOCTOR_SCHEMA)
    assert.equal(report.readOnly, true)
    assert.equal(report.status, DOCTOR_STATUS.fail)
    assert.ok(Array.isArray(report.checks))
    assert.equal(report.summary.total, report.checks.length)
    assert.equal(checkById(report, 'memory.payload').status, DOCTOR_STATUS.fail)
    const after = tree(fixture.root)
    assert.deepEqual(after, before, 'the doctor must not create/delete/modify any file in the workspace')
    assert.equal(result.signal, null)
  } finally { rmSync(fixture.root, { recursive: true, force: true }) }
})

test('CLI usage errors exit 2 and --help exits 0', () => {
  const help = spawnSync(process.execPath, [DOCTOR_PATH, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Read-only/u)
  const invalid = spawnSync(process.execPath, [DOCTOR_PATH, '--nonsense'], { encoding: 'utf8' })
  assert.equal(invalid.status, 2)
  assert.match(invalid.stderr, /Unknown argument/u)
})
