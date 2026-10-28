/** Keep failed as well as successful native phases bound to the inspected build. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const [run, manifest, phase, status] = process.argv.slice(2), path = join(run, 'RESULTS.json')
const build = JSON.parse(readFileSync(manifest, 'utf8'))
const result = phase === 'initialize' || !existsSync(path) ? {
  sourceCommit: build.sourceCommit, dmg: build.artifact, status: 'FAIL', phases: {},
  scope: 'packaged macOS App with isolated user-data (not a HOME sandbox), strict inner signatures and normal LaunchServices startup, real web boot, sprite double-click, official Bot Session selection, Bridge and Hindsight persistence',
  voice: 'BLOCKED-EXTERNAL: real provider/microphone not exercised',
  nativePointerAndTcc: 'DEFERRED: physical click-through, Spaces and TCC require manual acceptance',
} : JSON.parse(readFileSync(path, 'utf8'))
if (phase === 'overall') {
  if (status === 'PASS') {
    const required = ['native-signatures', 'first-launchservices', 'restart-launchservices', 'first-bridge', 'first-web-boot-and-navigation', 'first-memory', 'memory-write-and-cross-session', 'first-shutdown', 'first-descriptor-cleanup', 'restart-bridge', 'restart-web-boot-and-navigation', 'restart-memory', 'memory-restart-recall', 'restart-shutdown', 'restart-descriptor-cleanup']
    if (required.some(name => result.phases[name] !== 'PASS')) throw new Error('Native acceptance is incomplete or has a failed phase')
  }
  result.status = status
}
else if (phase !== 'initialize') result.phases[phase] = status
result.updatedAt = new Date().toISOString()
writeFileSync(path, JSON.stringify(result, null, 2) + '\n')
