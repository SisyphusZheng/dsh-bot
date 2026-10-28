/** Verify frozen source identity and the declared cloud evidence without rebuilding it. */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
const here = import.meta.dirname, root = resolve(here, '../..')
const result = JSON.parse(readFileSync(resolve(here, 'RESULTS.json'), 'utf8'))
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim()
assert.equal(git('rev-parse', `${result.codeCommit}^{tree}`), result.codeTree)
git('merge-base', '--is-ancestor', result.codeCommit, 'HEAD')
for (const path of git('diff', '--name-only', result.codeCommit, 'HEAD').split('\n').filter(Boolean)) {
  assert.ok(path.startsWith('review/0.0.1-cloud-closure/'), `Candidate source changed: ${path}`)
}
assert.equal(git('status', '--porcelain'), '', 'Commit or revert workspace edits before verifying the frozen candidate')
const sums = readFileSync(resolve(here, 'SHA256SUMS'), 'utf8').trim().split('\n')
for (const line of sums) {
  const match = /^([0-9a-f]{64})  (.+)$/.exec(line)
  assert.ok(match, 'Invalid checksum entry')
  const path = resolve(here, match[2])
  assert.ok(path.startsWith(here + '/'), 'Evidence path escaped its directory')
  assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), match[1], match[2])
}
console.log(`PASS frozen code ${result.codeCommit}; ${sums.length} evidence hashes. Scope: ${result.scope}`)
