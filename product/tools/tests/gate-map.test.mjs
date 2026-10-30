import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVerifyLog } from '../gate-map.mjs'

// Synthetic verify-local output shaped like the real script: two run-gates
// blocks (typecheck then build), node --test totals, vitest summary, python
// unittest and the final completion marker. This tests the parser contract, not
// any gate result (gate-map never hardcodes PASS).
const LOG = `PASS 16347 official files, 47 explicit product overrides; abc
Already up to date
Done in 467ms using pnpm v11.28.5
PASS pinned wake model prepared: /tmp/wake-model
ℹ tests 104
ℹ pass 104
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
run-gates: 5 passed, 0 failed, 0 skipped in 140.65s.
run-gates: 9 passed, 0 failed, 0 skipped in 36.96s.
 Test Files  22 passed (22)
      Tests  477 passed (477)
Ran 99 tests in 1.2s
OK
PASS macOS native wake word
PASS verify-local
`

test('parses the real verify-local stages without inventing results', () => {
  const { stages } = parseVerifyLog(LOG)
  assert.equal(stages.verifyUpstream, true)
  assert.equal(stages.install, true)
  assert.equal(stages.wakeModel, true)
  assert.deepEqual(stages.nodeTest, { observed: true, tests: 104, pass: 104, fail: 0 })
  assert.equal(stages.typecheck.observed, true)
  assert.equal(stages.typecheck.passed, 5)
  assert.equal(stages.build.passed, 9)
  assert.equal(stages.vitest.observed, true)
  assert.equal(stages.vitest.failedTests, 0)
  assert.equal(stages.vitest.passedTests, 477)
  assert.equal(stages.python.observed, true)
  assert.equal(stages.python.tests, 99)
  assert.equal(stages.python.ok, true)
  assert.equal(stages.completion, true)
})

test('a failed/incomplete log never reports PASS stages', () => {
  const failed = `run-gates: 5 passed, 0 failed, 0 skipped in 1s.
run-gates: 9 passed, 0 failed, 0 skipped in 1s.
ℹ tests 3
ℹ fail 3
 Test Files  1 failed | 2 passed (3)
      Tests  3 failed | 7 passed (10)
FAIL  apps/desktop/tests/example.spec.ts > does a thing
Ran 4 tests in 0.1s
FAILED (failures=2)
`
  const { stages, failureLines } = parseVerifyLog(failed)
  assert.equal(stages.nodeTest.fail, 3)
  assert.equal(stages.vitest.failedTests, 3)
  assert.equal(stages.vitest.failedFiles, 1)
  assert.equal(stages.python.ok, false)
  assert.equal(stages.python.failed, true)
  assert.equal(stages.completion, false)
  assert.ok(failureLines.length >= 2)
})

test('missing sections stay unobserved instead of defaulting to true', () => {
  const { stages } = parseVerifyLog('noise only\n')
  assert.equal(stages.verifyUpstream, false)
  assert.equal(stages.install, false)
  assert.equal(stages.nodeTest.observed, false)
  assert.equal(stages.typecheck.observed, false)
  assert.equal(stages.build.observed, false)
  assert.equal(stages.vitest.observed, false)
  assert.equal(stages.python.observed, false)
  assert.equal(stages.completion, false)
})
