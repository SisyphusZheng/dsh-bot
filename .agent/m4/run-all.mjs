// M4 E2E/security suite: runs the text-level acceptance tests sequentially.
import { spawn, execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const tests = [
  'test-m4-paths.mjs',
  'test-m4-persona.mjs',
  'test-m4-security-audit.mjs',
  'test-m4-memory.mjs',
  'test-m4-memory-host.mjs',
  'test-m4-stop-semantics.mjs',
]
const results = { suite: 'M4 E2E/security', startedAt: new Date().toISOString(), tests: [], ok: false }
const run = (file) => new Promise((resolve) => {
  const started = Date.now()
  const child = spawn(process.execPath, [file], { cwd: '$HOME/projects/dsh-bot-workspace/m4', stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d.toString() })
  child.stderr.on('data', (d) => { out += d.toString() })
  child.once('exit', (code) => resolve({ file, code, ms: Date.now() - started, tail: out.trim().split('\n').slice(-3).join(' | ') }))
})
for (const test of tests) {
  const r = await run(test)
  results.tests.push(r)
  console.log((r.code === 0 ? 'PASS' : 'FAIL') + ' ' + test + ' (' + r.ms + 'ms) ' + (r.code === 0 ? '' : r.tail))
}
results.ok = results.tests.every((t) => t.code === 0)
results.finishedAt = new Date().toISOString()
writeFileSync('$HOME/projects/dsh-bot-workspace/m4/evidence/M4-E2E-SUITE.json', JSON.stringify(results, null, 2) + '\n')
console.log(JSON.stringify({ ok: results.ok, passed: results.tests.filter((t) => t.code === 0).length, total: results.tests.length }))
process.exit(results.ok ? 0 : 1)
