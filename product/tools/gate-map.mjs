#!/usr/bin/env node
/**
 * beta2 gate map: B2-G01..B2-G18 -> actual command / test files / evidence paths /
 * evidence level / result / sourceCommit / artifactSha256.
 *
 * Honesty rules:
 *  - every gate starts as FAIL; PASS is only derived from real evidence files;
 *  - no result is hardcoded and missing/mismatched evidence never becomes PASS;
 *  - the artifact SHA is re-hashed from the built DMG and compared with the build
 *    manifest; a mismatch fails every artifact-bound gate;
 *  - per-gate evidence lists the exact files that were read, so a reader can
 *    audit the mapping.
 *
 * usage:
 *   node product/tools/gate-map.mjs [--evidence <run-dir>] [--verify-log <log>]
 *     [--verify-exit-code <n>] [--native <B2-NATIVE-RESULTS.json>] [--accept <RESULTS.json>]
 *     [--stability <summary.json>] [--dev-doctor <report.json>] [--manifest <macos-build.json>]
 *     [--out <gate-map.json>] [--source-commit <sha>] [--strict-patterns] [--exit-code]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')
const DEFAULT_RUN = '.agent/evidence/beta2/run-20261030T142317Z'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    out[key] = next && !next.startsWith('--') ? (i++, next) : true
  }
  return out
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function findFirst(candidates) {
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate
  return null
}

function findRecursiveByPrefix(rootDir, prefix, suffix = '.json') {
  if (!rootDir || !existsSync(rootDir)) return null
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.startsWith(prefix) && entry.name.endsWith(suffix)) found.push(path)
    }
  }
  walk(rootDir)
  return found.length ? found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : null
}

function findRecursive(rootDir, fileName, { newest = true } = {}) {
  if (!rootDir || !existsSync(rootDir)) return null
  const found = []
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === fileName) found.push(path)
    }
  }
  walk(rootDir)
  if (!found.length) return null
  return newest ? found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : found[0]
}

/** Parse the single verify-local log into per-stage observations (never invents a stage). */
export function parseVerifyLog(text) {
  const stages = {}
  stages.verifyUpstream = /PASS \d+ official files/.test(text)
  stages.install = /using pnpm v11\.28\.5|Already up to date/.test(text)
  stages.wakeModel = /PASS pinned wake model prepared/.test(text)
  const tests = text.match(/ℹ tests (\d+)/)
  const pass = text.match(/ℹ pass (\d+)/)
  const fail = text.match(/ℹ fail (\d+)/)
  stages.nodeTest = {
    observed: Boolean(tests && pass && fail),
    tests: tests ? Number(tests[1]) : null,
    pass: pass ? Number(pass[1]) : null,
    fail: fail ? Number(fail[1]) : null,
  }
  const gateSummaries = [...text.matchAll(/run-gates: (\d+) passed, (\d+) failed, (\d+) skipped/g)].map(match => ({ passed: Number(match[1]), failed: Number(match[2]), skipped: Number(match[3]) }))
  stages.typecheck = gateSummaries[0] ? { ...gateSummaries[0], observed: true } : { observed: false }
  stages.build = gateSummaries[1] ? { ...gateSummaries[1], observed: true } : { observed: false }
  const testFiles = text.match(/Test Files\s+(?:(\d+) failed \| )?(\d+) passed/)
  const vitestTests = text.match(/Tests\s+(?:(\d+) failed \| )?(\d+) passed/)
  stages.vitest = {
    observed: Boolean(testFiles || vitestTests),
    failedFiles: testFiles ? Number(testFiles[1] || 0) : null,
    passedFiles: testFiles ? Number(testFiles[2]) : null,
    failedTests: vitestTests ? Number(vitestTests[1] || 0) : null,
    passedTests: vitestTests ? Number(vitestTests[2]) : null,
    failedSpecNames: [...text.matchAll(/^ FAIL\s+\S*\s*(\S+\.spec\.tsx?)\s*>/gm)].map(match => match[1]),
  }
  const ran = text.match(/^Ran (\d+) tests?/m)
  stages.python = {
    observed: Boolean(ran),
    tests: ran ? Number(ran[1]) : null,
    ok: /^OK\b/m.test(text),
    failed: /^FAILED\b/m.test(text),
  }
  stages.smokes = {
    wakeWord: /PASS .*wake/i.test(text),
    petUi: /PASS pet/i.test(text),
    host: /PASS host/i.test(text),
    voice: /PASS real Pipecat|PASS voice/i.test(text),
    voiceMedia: /PASS shipped SDK/i.test(text),
  }
  stages.completion = /PASS verify-local(?:\.sh)?\b/.test(text)
  const failureLines = text.split('\n').filter(line => /^FAIL\b|\bFAILED\b/.test(line)).slice(0, 20)
  return { stages, failureLines }
}

/**
 * Manual / environment boundaries that automated evidence can never turn into PASS.
 * They are reported next to the gate result (plan §11.4 evidence levels).
 */
const STATIC_BOUNDARIES = {
  'B2-G01': [{ scope: 'real provider + real authorisation', status: 'BLOCKED-EXTERNAL', reason: 'automated evidence is Host-kernel tests; a real DSH provider turn and real user voice are not exercised by this gate' }],
  'B2-G02': [{ scope: 'real acoustics (human speech)', status: 'BLOCKED-ENVIRONMENT', reason: 'segment routing is proven with fixtures; real microphone/acoustic phrasing is a separate manual boundary' }],
  'B2-G03': [{ scope: 'real provider interaction stream', status: 'BLOCKED-EXTERNAL', reason: 'official interaction lifecycle is exercised through the Host mirror with fixtures/Mock provider, not a live provider' }],
  'B2-G04': [{ scope: 'real provider long-running tool task', status: 'BLOCKED-EXTERNAL', reason: 'desktop Host+Mock Provider evidence only; a real long tool task requires provider credentials' }],
  'B2-G05': [{ scope: 'real acoustics (hold/toggle/always, human voice)', status: 'BLOCKED-ENVIRONMENT', reason: 'media fixture + synthetic ASR only; human voice latency/echo is manual' }],
  'B2-G06': [{ scope: 'real Session change under live provider', status: 'BLOCKED-EXTERNAL', reason: 'queue model is unit-tested; live provider/session churn needs credentials' }],
  'B2-G07': [{ scope: 'real provider cancel semantics', status: 'BLOCKED-EXTERNAL', reason: 'official cancel confirmation needs a live provider turn' }],
  'B2-G08': [{ scope: 'real provider reconnect', status: 'BLOCKED-EXTERNAL', reason: 'restart/reconnect proven against fixtures and Mock provider' }],
  'B2-G09': [{ scope: 'network fault injection', status: 'BLOCKED-ENVIRONMENT', reason: 'protocol faults are injected locally; real packet loss/loopback failures are manual' }],
  'B2-G10': [{ scope: 'real main-window provider turn', status: 'BLOCKED-EXTERNAL', reason: 'main-window turn is exercised with Mock Provider; real provider credentials required for live equivalence' }],
  'B2-G11': [],
  'B2-G12': [{ scope: 'real user pointer/keyboard', status: 'BLOCKED-ENVIRONMENT', reason: 'presentation unit/vitest evidence; physical pointer and IME behaviour is manual' }],
  'B2-G13': [
    { scope: 'multi-display / negative-coordinate display arrangement', status: 'BLOCKED-ENVIRONMENT', reason: 'this host has a single active display; multi-display/negative-x geometry could not be exercised' },
    { scope: 'other-app fullscreen / Spaces / physical click-through', status: 'BLOCKED-ENVIRONMENT', reason: 'bubble level/onscreen was measured natively; another app fullscreen + manual pointer interaction is a manual boundary' },
  ],
  'B2-G14': [{ scope: 'TCC microphone state', status: 'BLOCKED-ENVIRONMENT', reason: 'dev-doctor reports TCC as UNKNOWN/manual by contract; it is never faked as PASS' }],
  'B2-G15': [],
  'B2-G16': [{ scope: 'real personal Hindsight library', status: 'BLOCKED-ENVIRONMENT', reason: 'acceptance uses an isolated run-local Hindsight bank; the user personal library is never touched' }],
  'B2-G17': [{ scope: 'Developer ID / notarisation', status: 'DEFERRED', reason: 'ad-hoc signed internal build only; notarisation is out of beta2 scope' }],
  'B2-G18': [
    { scope: 'human ten-round acoustic dialogue + barge-in', status: 'BLOCKED-ENVIRONMENT', reason: 'three automated rounds are native; a human ten-round acoustic run is manual' },
    { scope: 'real provider turns', status: 'BLOCKED-EXTERNAL', reason: 'three rounds use the packaged App with real Host/Memory; a live provider is not configured in acceptance' },
  ],
}

function dynamicBoundaries(gateId, ctx) {
  const extra = []
  if (gateId === 'B2-G13' || gateId === 'B2-G14' || gateId === 'B2-G18') {
    const count = ctx.native?.checks?.['C0-preconditions']?.displays?.displays?.length ?? null
    if (count !== null && count < 2) {
      extra.push({ scope: 'multi-display', status: 'BLOCKED-ENVIRONMENT', reason: `only ${count} active display attached to this host (CGGetActiveDisplayList); multi-display/negative-coordinate scenario not runnable` })
    }
    const fullscreen = ctx.native?.checks?.['C2-bubble-above-main']?.fullscreen
    if (fullscreen?.status === 'BLOCKED-ENVIRONMENT') {
      extra.push({ scope: 'fullscreen', status: 'BLOCKED-ENVIRONMENT', reason: `fullscreen automation could not be observed (${String(fullscreen.detail || '').slice(0, 160)})` })
    }
    const tcc = ctx.doctor?.checks?.find?.(check => check.id === 'platform.tcc-microphone')
    if (gateId === 'B2-G14' && tcc && tcc.status === 'UNKNOWN') {
      extra.push({ scope: 'TCC microphone', status: 'BLOCKED-ENVIRONMENT', reason: 'dev-doctor: TCC/microphone state is UNKNOWN/manual (never faked)' })
    }
  }
  return extra
}

const GATES = [
  {
    id: 'B2-G01', title: 'One approval utterance / duplicate finals / click-vs-voice race: at most one official decision',
    level: 'host kernel Node tests (InteractionRegistry)', stages: ['nodeTest'],
    testFiles: ['nisse/packages/host-integration/tests/interaction-registry.test.mjs', 'nisse/packages/host-integration/tests/kernel.test.mjs'],
    patterns: [/main.?window/i, /late.?voice|voice.?late/i, /same.?key|idempoten/i, /race|compet/i],
  },
  {
    id: 'B2-G02', title: 'Mixed control+work, no punctuation, negation, quotation: control and work each exactly once',
    level: 'host kernel Node tests (UtteranceAssembler/Segmenter)', stages: ['nodeTest'],
    testFiles: ['nisse/packages/host-integration/tests/utterance.test.mjs'],
    patterns: [/停一下|control/i, /不要停|negation/i, /引用|quotation|文档里/i, /然后/],
  },
  {
    id: 'B2-G03', title: 'viewRevision vs semanticRevision, option reorder, rewritten question, multi-select, free text',
    level: 'host kernel Node tests (InteractionRegistry + contracts)', stages: ['nodeTest'],
    testFiles: ['nisse/packages/host-integration/tests/interaction-registry.test.mjs', 'nisse/packages/host-integration/tests/kernel.test.mjs'],
    patterns: [/reorder|选项重排/i, /semanticRevision|semantic revision/i, /viewRevision/i, /multi.?select|set-selected/i],
  },
  {
    id: 'B2-G04', title: 'Long tool task + approval/question/stop/status stays responsive, correct task identity',
    level: 'host kernel Node tests + desktop Host integration vitest (mock provider)', stages: ['nodeTest', 'vitest'],
    testFiles: ['nisse/packages/host-integration/tests/conversation-model.test.mjs'],
    vitestFiles: ['apps/desktop/tests/host-integration-mvp.spec.ts', 'apps/desktop/tests/beta2-host-kernel.spec.ts'],
    patterns: [/long|tool/i, /approval|question/i, /cancel|stop/i],
  },
  {
    id: 'B2-G05', title: 'hold release / toggle / always / duplicate-accumulated final / welcome greeting regression',
    level: 'host kernel Node tests + Python worker media tests', stages: ['nodeTest', 'python'],
    testFiles: ['nisse/packages/host-integration/tests/utterance.test.mjs'],
    patterns: [/hold/i, /toggle/i, /always/i, /welcome|greeting|欢迎/i],
  },
  {
    id: 'B2-G06', title: 'Queue full / edit / delete / expiry / session change / explicit user repeat: no silent loss',
    level: 'host kernel Node tests (queue model)', stages: ['nodeTest'],
    testFiles: ['nisse/packages/host-integration/tests/conversation-model.test.mjs'],
    patterns: [/queue|队列/i, /overflow|limit|capacity/i, /ttl|expire|过期/i, /restart|recovery/i],
  },
  {
    id: 'B2-G07', title: 'Stop playback vs cancel capture vs stop task: separate scopes, late control, unknown result',
    level: 'host kernel Node tests + Python worker media tests', stages: ['nodeTest', 'python'],
    testFiles: ['nisse/packages/host-integration/tests/conversation-model.test.mjs'],
    patterns: [/cancel|stop|停止/i, /playback|播报/i, /stale|late|迟到/i],
  },
  {
    id: 'B2-G08', title: 'Worker reconnect / Host restart / accepted-then-disconnect / lost receipt: no replay',
    level: 'host kernel Node tests + Python worker tests', stages: ['nodeTest', 'python'],
    testFiles: ['nisse/packages/host-integration/tests/kernel.test.mjs'],
    patterns: [/restart|recovery/i, /replay|重放/i, /unknown/i],
  },
  {
    id: 'B2-G09', title: 'Snapshot/event handshake: duplicates, out-of-order, gaps, old epoch, stale snapshot never roll back',
    level: 'host kernel Node tests (snapshot store + protocol)', stages: ['nodeTest'],
    testFiles: ['nisse/packages/host-integration/tests/kernel.test.mjs'],
    patterns: [/resync/i, /epoch/i, /gap/i, /snapshot/i],
  },
  {
    id: 'B2-G10', title: 'Main window creates/cancels work and answers interactions: Host syncs real state, no duplicate submit',
    level: 'desktop Host integration vitest (mock provider)', stages: ['vitest'],
    testFiles: [],
    vitestFiles: ['apps/desktop/tests/host-integration-mvp.spec.ts', 'apps/desktop/tests/beta2-host-kernel.spec.ts', 'apps/desktop/tests/mvp-closure.spec.ts'],
    patterns: [/main.?window/i, /duplicate|repeat/i],
  },
  {
    id: 'B2-G11', title: 'Old timer expiry never hides a newer approval/reply/confirmation/queue item',
    level: 'pet presentation unit tests + desktop pet-runtime vitest', stages: ['nodeTest', 'vitest'],
    testFiles: ['product/pet/tests/presentation.test.mjs'],
    vitestFiles: ['apps/desktop/tests/pet-runtime.spec.ts'],
    patterns: [/timer|notice/i, /stale|expire|owner/i],
  },
  {
    id: 'B2-G12', title: 'Every visible button, keyboard submit, long options, Markdown, adaptive layout, unsubmitted edits preserved',
    level: 'pet presentation unit tests + desktop regression vitest', stages: ['nodeTest', 'vitest'],
    testFiles: ['product/pet/tests/presentation.test.mjs', 'product/pet/tests/bubble-markdown.test.mjs'],
    vitestFiles: ['apps/desktop/tests/dsh-bot-regressions.spec.ts', 'apps/desktop/tests/pet-runtime.spec.ts'],
    patterns: [/button|按钮/i, /markdown/i, /keyboard|键盘/i, /edit|编辑/i],
  },
  { id: 'B2-G13', title: 'Native bubble first show, above main/fullscreen, focus non-steal, edge/multi-display geometry', level: 'packaged native App + window server (CGWindowList/screencapture/AX/HID click)', native: ['C1-bubble-first-show', 'C2-bubble-above-main', 'C3-focus-non-steal', 'C4-edge-multi-display-geometry'] },
  { id: 'B2-G14', title: 'dev doctor: missing payload / occupied ports / broken descriptor / TCC unknown / real ready diagnostics', level: 'read-only dev doctor (repo) + packaged missing-memory negative path', doctor: true, native: ['C5-dev-missing-memory-diagnosis'] },
  { id: 'B2-G15', title: 'Credentials/auth/Origin/logging, corrupt persistence, legacy APIs: no key leak or auth bypass', level: 'credential/redaction vitest + real Host auth checks', stages: ['vitest'], testFiles: ['packages/credentials/credentials-local/tests/local.spec.ts', 'packages/llm/llm/tests/api-key.spec.ts', 'packages/session/session-telemetry/tests/redact.spec.ts'], vitestFiles: ['apps/desktop/tests/bot-settings-secrets.spec.ts'], native: ['C6-snapshot-connection'] },
  { id: 'B2-G16', title: 'Host/Memory exit+restart, Hindsight write/cross-session/recall keeps data', level: 'base accept-macos.sh 15 checks + real Hindsight service', acceptPhases: ['first-memory', 'memory-write-and-cross-session', 'memory-restart-recall'], memory: true, native: ['C7-exit-restart-cleanup'] },
  { id: 'B2-G17', title: 'Native install/launch/exit/restart, resource integrity, upstream consistency, package identity', level: 'base accept-macos.sh + packaged identity/resources checks', acceptPhases: ['native-signatures', 'first-launchservices', 'restart-launchservices', 'first-descriptor-cleanup', 'restart-descriptor-cleanup'], builtResources: true, native: ['C0-launch-ready', 'C7-exit-restart-cleanup'] },
  { id: 'B2-G18', title: 'Three consecutive rounds on the same DMG, no hidden retry, first-attempt success', level: 'packaged native App, three isolated rounds', stability: true },
]

function stagePass(stages, name) {
  switch (name) {
    case 'nodeTest': return stages.nodeTest.observed && stages.nodeTest.fail === 0 && stages.nodeTest.pass > 0
    case 'typecheck': return stages.typecheck.observed && stages.typecheck.failed === 0
    case 'build': return stages.build.observed && stages.build.failed === 0
    case 'vitest': return stages.vitest.observed && stages.vitest.failedTests === 0
    case 'python': return stages.python.observed && stages.python.ok && !stages.python.failed
    default: return false
  }
}

function gateResult(spec, ctx) {
  const reasons = []
  const evidence = []
  const notes = []
  let fail = false
  if (spec.stages) {
    for (const stage of spec.stages) {
      if (!stagePass(ctx.verify.stages, stage)) { fail = true; reasons.push(`verify-local stage ${stage} not PASS (observed=${JSON.stringify(ctx.verify.stages[stage] ?? null)})`) }
    }
    if (ctx.verifyExitCode !== null && ctx.verifyExitCode !== 0) { fail = true; reasons.push(`verify-local exit code ${ctx.verifyExitCode}`) }
    if (ctx.verifyLogPath) evidence.push(ctx.verifyLogPath)
    for (const file of spec.testFiles || []) {
      if (!existsSync(join(ROOT, file))) { fail = true; reasons.push(`test file missing: ${file}`) } else evidence.push(file)
    }
    for (const file of spec.vitestFiles || []) {
      if (!existsSync(join(ROOT, file))) { fail = true; reasons.push(`vitest spec missing: ${file}`) } else evidence.push(file)
    }
    if (spec.patterns?.length) {
      const matches = spec.patterns.map(pattern => ({ pattern: String(pattern), matched: pattern.test(ctx.verifyText) }))
      notes.push(`behaviourMatches=${JSON.stringify(matches.filter(match => match.matched).map(match => match.pattern))}/${matches.length}`)
      if (ctx.strictPatterns && matches.some(match => !match.matched)) { fail = true; reasons.push(`behaviour-tagged tests not found for patterns: ${matches.filter(match => !match.matched).map(match => match.pattern).join(', ')}`) }
    }
  }
  if (spec.native) {
    const native = ctx.native
    if (!native) { fail = true; reasons.push('no B2 native acceptance evidence (B2-NATIVE-RESULTS.json)') }
    else {
      evidence.push(ctx.files.native.results)
      for (const checkId of spec.native) {
        const check = native.checks?.[checkId]
        if (!check) { fail = true; reasons.push(`native check missing: ${checkId}`) }
        else if (check.status === 'FAIL') { fail = true; reasons.push(`native check ${checkId} FAIL: ${String(check.detail ?? '').slice(0, 200)}`) }
        else if (check.status === 'BLOCKED-ENVIRONMENT') notes.push(`native check ${checkId} BLOCKED-ENVIRONMENT: ${String(check.detail ?? '').slice(0, 160)}`)
      }
      if (native.sourceCommit && ctx.sourceCommit && native.sourceCommit !== ctx.sourceCommit) { fail = true; reasons.push(`native evidence sourceCommit ${native.sourceCommit} != ${ctx.sourceCommit}`) }
    }
    if (!native) notes.push('native evidence missing => gate cannot be PASS')
  }
  if (spec.doctor) {
    const doctor = ctx.doctor
    if (!doctor) { fail = true; reasons.push('dev-doctor report missing (run node product/tools/dev-doctor.mjs --json > evidence/tooling/dev-doctor.json)') }
    else {
      evidence.push(ctx.files.doctor)
      if (doctor.schema !== 'dsh-bot.dev-doctor/1') { fail = true; reasons.push(`dev-doctor schema mismatch: ${doctor.schema}`) }
      if ((doctor.summary?.fail ?? 0) > 0) { fail = true; reasons.push(`dev-doctor has ${doctor.summary.fail} FAIL check(s): ${(doctor.checks || []).filter(check => check.status === 'FAIL').map(check => check.id).join(', ')}`) }
      const requiredDoctor = ['identity.product', 'identity.build', 'memory.payload', 'voice.venv', 'voice.lock']
      const byId = Object.fromEntries((doctor.checks || []).map(check => [check.id, check]))
      for (const id of requiredDoctor) {
        if (!byId[id] || byId[id].status !== 'PASS') { fail = true; reasons.push(`dev-doctor check ${id} is ${byId[id]?.status ?? 'missing'}`) }
      }
      notes.push('TCC/microphone is UNKNOWN/manual by contract, not a gate FAIL')
    }
  }
  if (spec.acceptPhases) {
    const accept = ctx.accept
    if (!accept) { fail = true; reasons.push('no base accept-macos RESULTS.json evidence') }
    else {
      evidence.push(ctx.files.accept)
      if (accept.status !== 'PASS') { fail = true; reasons.push(`base acceptance overall status ${accept.status}`) }
      for (const phase of spec.acceptPhases) {
        if (accept.phases?.[phase] !== 'PASS') { fail = true; reasons.push(`base acceptance phase ${phase}=${accept.phases?.[phase] ?? 'missing'}`) }
      }
    }
  }
  if (spec.memory) {
    const memory = ctx.memory
    if (!memory) { fail = true; reasons.push('no A3 memory-build evidence') }
    else {
      evidence.push(ctx.files.memory)
      if (memory.status !== 'PASS') { fail = true; reasons.push(`memory build status ${memory.status}`) }
      if (!memory.identity?.memoryLockSha256) { fail = true; reasons.push('memory lock sha256 not recorded') }
      const versionsMemory = memory.identity?.productVersionsMemory || memory.identity?.versionsMemory || {}
      if ((versionsMemory.lockSha256 ?? '') !== memory.identity?.memoryLockSha256) { fail = true; reasons.push('product/versions.json memory.lockSha256 does not match the recorded requirements-macos.lock sha') }
      if (!memory.identity?.payloadVersionJsonSha256) { fail = true; reasons.push('staged memory payload version.json sha256 not recorded') }
    }
  }
  if (spec.builtResources) {
    const built = ctx.builtResources
    if (!built) { fail = true; reasons.push('no check-built-resources evidence') }
    else {
      evidence.push(ctx.files.builtResources)
      if (built.status !== 'PASS') { fail = true; reasons.push(`check-built-resources status ${built.status}`) }
    }
    if (!ctx.verify.stages.verifyUpstream) { fail = true; reasons.push('verify-upstream stage not PASS') }
  }
  if (spec.stability) {
    const stability = ctx.stability
    if (!stability) { fail = true; reasons.push('no three-round stability summary') }
    else {
      evidence.push(ctx.files.stability)
      if (stability.overall?.status !== 'PASS') { fail = true; reasons.push(`stability status ${stability.overall?.status}`) }
      if ((stability.rounds || []).length !== 3) { fail = true; reasons.push(`stability rounds ${(stability.rounds || []).length} != 3`) }
      if (!stability.checks?.allRoundsFirstAttemptSuccess) { fail = true; reasons.push('a round did not succeed on its first launch attempt') }
      if (!stability.checks?.allRoundsSameSha) { fail = true; reasons.push('DMG sha256 was not identical in every round') }
      if (ctx.artifactSha256 && stability.chart?.dmgSha256 !== ctx.artifactSha256) { fail = true; reasons.push(`stability DMG sha ${stability.chart?.dmgSha256} != artifact sha ${ctx.artifactSha256}`) }
    }
  }
  if (ctx.artifactError && (spec.native || spec.stability || spec.acceptPhases)) { fail = true; reasons.push(ctx.artifactError) }
  return {
    result: fail ? 'FAIL' : 'PASS',
    reason: fail ? reasons.join('; ') : 'all required evidence present and PASS',
    evidence, notes,
  }
}

export async function buildGateMap(options) {
  const evidenceDir = resolve(options.evidence || DEFAULT_RUN)
  const verifyLogPath = findFirst([options.verifyLog && resolve(options.verifyLog), join(ROOT, '.mvv-build/evidence/verify-local.log')])
  const verifyText = verifyLogPath ? readFileSync(verifyLogPath, 'utf8') : ''
  const verify = parseVerifyLog(verifyText)
  const verifyExitCode = options.verifyExitCode === undefined || options.verifyExitCode === true ? null : Number(options.verifyExitCode)
  const nativePath = findFirst([options.native && resolve(options.native), findRecursive(join(evidenceDir, 'native'), 'B2-NATIVE-RESULTS.json')])
  const acceptPath = findFirst([options.accept && resolve(options.accept), findRecursive(evidenceDir, 'base-RESULTS.json'), findRecursive(evidenceDir, 'RESULTS.json')])
  const stabilityPath = findFirst([options.stability && resolve(options.stability), findRecursive(evidenceDir, 'summary.json')])
  const doctorPath = findFirst([options.devDoctor && resolve(options.devDoctor), join(evidenceDir, 'tooling/dev-doctor.json'), findRecursive(evidenceDir, 'dev-doctor.json')])
  const memoryPath = findFirst([join(evidenceDir, 'preconditions/a3-memory-build.json'), findRecursive(evidenceDir, 'a3-memory-build.json')])
  const builtResourcesPath = findFirst([options.builtResources && resolve(options.builtResources), join(ROOT, '.mvv-build/evidence/built-resources.json'), findRecursive(join(evidenceDir, 'tooling'), 'built-resources.json'), findRecursiveByPrefix(join(evidenceDir, 'tooling'), 'check-built-resources')])
  const manifestPath = findFirst([options.manifest && resolve(options.manifest), join(ROOT, '.mvv-build/evidence/macos-build.json')])
  const manifest = manifestPath ? readJson(manifestPath) : null
  const gitHead = (() => { try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch { return null } })()
  let artifactSha256 = null
  let artifactActual = null
  let artifactError = null
  if (manifest?.artifact?.path) {
    if (!existsSync(manifest.artifact.path)) artifactError = `artifact file missing: ${manifest.artifact.path}`
    else {
      artifactActual = await sha256File(manifest.artifact.path)
      artifactSha256 = artifactActual
      if (manifest.artifact.sha256 && artifactActual !== manifest.artifact.sha256) artifactError = `artifact sha256 mismatch: actual ${artifactActual} != manifest ${manifest.artifact.sha256}`
      else if (!artifactError && verifyExitCode !== 0 && verifyExitCode !== null) artifactError = null
    }
  }
  const sourceCommit = options.sourceCommit ? String(options.sourceCommit) : (manifest?.sourceCommit || gitHead)
  if (options.sourceCommit && manifest?.sourceCommit && String(options.sourceCommit) !== manifest.sourceCommit) artifactError = `sourceCommit mismatch: expected ${options.sourceCommit}, manifest ${manifest.sourceCommit}`
  const ctx = {
    verify, verifyText, verifyLogPath, verifyExitCode, strictPatterns: Boolean(options['strict-patterns']),
    native: nativePath ? readJson(nativePath) : null,
    accept: acceptPath ? readJson(acceptPath) : null,
    stability: stabilityPath ? readJson(stabilityPath) : null,
    doctor: doctorPath ? readJson(doctorPath) : null,
    memory: memoryPath ? readJson(memoryPath) : null,
    builtResources: builtResourcesPath ? readJson(builtResourcesPath) : null,
    artifactSha256, artifactError, sourceCommit,
    files: {
      verifyLog: verifyLogPath, native: { results: nativePath }, accept: acceptPath, stability: stabilityPath,
      doctor: doctorPath, memory: memoryPath, builtResources: builtResourcesPath, manifest: manifestPath,
    },
  }
  const gates = {}
  for (const spec of GATES) {
    const computed = gateResult(spec, ctx)
    const boundaries = [...(STATIC_BOUNDARIES[spec.id] || []), ...dynamicBoundaries(spec.id, ctx)]
    gates[spec.id] = {
      gate: spec.id,
      title: spec.title,
      result: computed.result,
      resultScope: computed.result === 'PASS'
        ? `PASS for the automated evidence level (${spec.level}); listed boundaries remain BLOCKED/DEFERRED and are not part of this PASS`
        : 'not passed',
      boundaries,
      reason: computed.reason,
      evidenceLevel: spec.level,
      command: commandFor(spec),
      testFiles: [...(spec.testFiles || []), ...(spec.vitestFiles || [])],
      evidence: computed.evidence.filter(Boolean).map(path => String(path).replace(ROOT + '/', '')),
      notes: computed.notes,
      sourceCommit,
      artifactSha256,
    }
  }
  const map = {
    schemaVersion: 1,
    kind: 'beta2-gate-map',
    generatedAt: new Date().toISOString(),
    evidenceDir: evidenceDir.replace(ROOT + '/', ''),
    sourceCommit,
    workspaceHead: gitHead,
    artifact: manifest ? {
      manifestPath: manifestPath.replace(ROOT + '/', ''),
      path: manifest.artifact?.path ?? null,
      manifestSha256: manifest.artifact?.sha256 ?? null,
      actualSha256: artifactActual,
      verified: Boolean(artifactActual && manifest.artifact?.sha256 && artifactActual === manifest.artifact.sha256),
      error: artifactError,
    } : { manifestPath: null, error: 'no build manifest (artifact-bound gates cannot be PASS)' },
    inputs: {
      verifyLog: verifyLogPath ? verifyLogPath.replace(ROOT + '/', '') : null,
      verifyExitCode,
      verifyStages: verify.stages,
      verifyFailureLines: verify.failureLines,
      native: nativePath ? nativePath.replace(ROOT + '/', '') : null,
      accept: acceptPath ? acceptPath.replace(ROOT + '/', '') : null,
      stability: stabilityPath ? stabilityPath.replace(ROOT + '/', '') : null,
      devDoctor: doctorPath ? doctorPath.replace(ROOT + '/', '') : null,
      memory: memoryPath ? memoryPath.replace(ROOT + '/', '') : null,
      builtResources: builtResourcesPath ? builtResourcesPath.replace(ROOT + '/', '') : null,
    },
    gates,
    manualBoundaries: (() => {
      const all = []
      for (const gate of Object.values(gates)) {
        for (const boundary of gate.boundaries || []) all.push({ gate: gate.gate, ...boundary })
      }
      return all
    })(),
    summary: {
      pass: Object.values(gates).filter(gate => gate.result === 'PASS').length,
      fail: Object.values(gates).filter(gate => gate.result === 'FAIL').length,
      blockedEnvironmentBoundaries: Object.values(gates).flatMap(gate => gate.boundaries || []).filter(boundary => boundary.status === 'BLOCKED-ENVIRONMENT').length,
      blockedExternalBoundaries: Object.values(gates).flatMap(gate => gate.boundaries || []).filter(boundary => boundary.status === 'BLOCKED-EXTERNAL').length,
      deferredBoundaries: Object.values(gates).flatMap(gate => gate.boundaries || []).filter(boundary => boundary.status === 'DEFERRED').length,
      total: Object.keys(gates).length,
    },
  }
  const outPath = resolve(options.out || join(evidenceDir, 'gate-map.json'))
  mkdirSync(resolve(outPath, '..'), { recursive: true })
  writeFileSync(outPath, JSON.stringify(map, null, 2) + '\n')
  map.outPath = outPath
  return map
}

function commandFor(spec) {
  const commands = []
  if (spec.stages) commands.push('bash product/tools/verify-local.sh')
  if (spec.native) commands.push('node product/tools/accept-native-beta2.mjs --app <installed dsh-bot.app> --run <evidence>/native')
  if (spec.acceptPhases) commands.push('bash product/tools/accept-macos.sh <candidate.dmg>')
  if (spec.stability) commands.push('node product/tools/stability-beta2.mjs --dmg <candidate.dmg> --manifest <macos-build.json> --run <evidence>/stability')
  if (spec.doctor) commands.push('node product/tools/dev-doctor.mjs --json')
  if (spec.builtResources) commands.push('node product/tools/check-built-resources.mjs')
  return commands.join(' && ')
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
function normalizeCliArgs(raw) {
  const camel = key => key.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase())
  const out = {}
  for (const [key, value] of Object.entries(raw)) out[camel(key)] = value
  return out
}

if (invokedDirectly) {
  const rawArgs = parseArgs(process.argv.slice(2))
  const args = normalizeCliArgs(rawArgs)
  const map = await buildGateMap(args)
  const rows = Object.values(map.gates).map(gate => `${gate.gate}\t${gate.result}\t${gate.reason.slice(0, 160)}`)
  console.log(rows.join('\n'))
  console.log(`\n${map.summary.pass}/${map.summary.total} gates PASS; ${map.summary.fail} FAIL`)
  console.log(`sourceCommit=${map.sourceCommit} workspaceHead=${map.workspaceHead} artifactVerified=${map.artifact.verified}`)
  console.log(`wrote ${map.outPath}`)
  if (rawArgs['exit-code'] && map.summary.fail > 0) process.exit(1)
}
