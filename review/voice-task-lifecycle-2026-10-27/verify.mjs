/** Verify evidence bytes and bind the checked source tree to this checkout's HEAD. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const directory = import.meta.dirname, root = resolve(directory, '../..')
const results = JSON.parse(readFileSync(join(directory, 'RESULTS.json'), 'utf8'))
for (const artifact of results.artifacts) {
  const bytes = readFileSync(join(directory, artifact.path))
  assert.equal(bytes.length, artifact.bytes, artifact.path)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), artifact.sha256, artifact.path)
}
const temporary = mkdtempSync(join(tmpdir(), 'dsh-source-identity-'))
const env = { ...process.env, GIT_INDEX_FILE: join(temporary, 'index') }
const git = (...args) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim()
try {
  git('read-tree', 'HEAD')
  git('rm', '-r', '--cached', '--ignore-unmatch', '--', results.reviewDirectory)
  assert.equal(git('write-tree'), results.testedSourceTreeExcludingThisReview)
  console.log(`PASS ${results.artifacts.length} evidence hashes; HEAD ${git('rev-parse', 'HEAD')} matches tested source tree`)
} finally { rmSync(temporary, { recursive: true, force: true }) }
