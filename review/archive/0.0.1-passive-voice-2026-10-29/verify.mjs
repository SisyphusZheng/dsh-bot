/** Verify this review's source identity and saved bytes; it does not rerun checks. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import assert from 'node:assert/strict'
const root = new URL('../../', import.meta.url), dir = new URL('./', import.meta.url)
const results = JSON.parse(readFileSync(new URL('RESULTS.json', dir), 'utf8'))
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
assert.equal(git('rev-parse', `${results.sourceCommit}^{tree}`), results.sourceTree)
git('diff', '--exit-code', results.sourceCommit, 'HEAD', '--', '.', ':!review/0.0.1-passive-voice-2026-10-29')
for (const file of results.evidence) {
  const bytes = readFileSync(new URL(file.path, dir))
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path)
  if (file.rawSha256) assert.equal(createHash('sha256').update(gunzipSync(bytes)).digest('hex'), file.rawSha256, file.path)
}
console.log(`PASS source ${results.sourceCommit} and ${results.evidence.length} evidence files; integrity only, not test execution`)
