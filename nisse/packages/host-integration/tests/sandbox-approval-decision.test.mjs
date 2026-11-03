/**
 * Product approval-decision policy for the Bot bridge.
 *
 * DSH's approval service (not this module) owns whether a request may execute;
 * these tests pin the product's answers for the security review: `never-ask` is
 * fail-closed (reject, never allow), NO mode auto-allows because time passed — a
 * stored `ask-once` runs as `ask-each` in 0.0.1 because its window covered any
 * later escalation rather than the operation the button named — an unknown
 * product mode and a changed operation are never auto-allowed, and a persistent
 * exact grant is honoured only for the exact tool/cwd/arguments the user confirmed.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASK_ONCE_UNAVAILABLE_REASON,
  PRODUCT_APPROVAL_MODES,
  decideProductApproval,
  effectiveApprovalMode,
  escalationOf,
} from '../lib/approval-decision.mjs'
import { createApprovalPolicies, operationKey } from '../lib/approval-policies.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const escalation = (mode = 'danger-full-access') => ({
  toolName: 'write',
  cwd: '/work',
  arguments: { file_path: '/outside/a.txt', content: 'x', sandbox_permissions: mode, justification: 'the user asked for this path' },
})

test('the product mode vocabulary is closed', () => {
  assert.deepEqual([...PRODUCT_APPROVAL_MODES], ['ask-each', 'ask-before-acting', 'ask-once', 'never-ask'])
})

test('escalationOf reads only a recorded escalation and never invents one', () => {
  assert.equal(escalationOf(escalation()), 'danger-full-access')
  assert.equal(escalationOf({ toolName: 'write', cwd: '/work', arguments: { file_path: '/x' } }), '')
  assert.equal(escalationOf(undefined), '')
  assert.equal(escalationOf({ arguments: { sandbox_permissions: 42 } }), '')
})

test('never-ask rejects without prompting, for escalations and other approval requests alike', () => {
  for (const toolName of ['write', 'bash', 'mcp__thing__act']) {
    const decision = decideProductApproval({ toolName, operation: escalation(), mode: 'never-ask', grantMatched: false })
    assert.equal(decision.outcome, 'rejected', toolName)
    assert.equal(decision.reason, 'never-ask')
  }
})

test('no stored mode auto-allows because a time window is open', () => {
  // A legacy caller that still passes the removed `askOnceWindowOpen` flag must not widen consent.
  for (const toolName of ['write', 'bash', 'mcp__thing__act']) {
    for (const windowOpen of [true, false]) {
      const decision = decideProductApproval({ toolName, operation: escalation(), mode: 'ask-once', grantMatched: false, askOnceWindowOpen: windowOpen })
      assert.equal(decision.outcome, 'ask', `${toolName} windowOpen=${windowOpen}`)
    }
  }
})

test('a stored ask-once runs as ask-each and says why, without rewriting the stored value', () => {
  const effective = effectiveApprovalMode('ask-once')
  assert.equal(effective.mode, 'ask-each')
  assert.equal(effective.requested, 'ask-once')
  assert.equal(effective.unavailableReason, ASK_ONCE_UNAVAILABLE_REASON)
  const approved = decideProductApproval({ toolName: 'write', operation: escalation(), mode: effective.mode, grantMatched: false })
  assert.equal(approved.outcome, 'ask')
  assert.equal(approved.reason, 'prompt')
})

test('the effective mode leaves every other stored value unchanged', () => {
  for (const stored of ['ask-each', 'ask-before-acting', 'never-ask']) {
    const effective = effectiveApprovalMode(stored)
    assert.equal(effective.mode, stored)
    assert.equal(effective.requested, stored)
    assert.equal(effective.unavailableReason, '')
  }
  for (const stored of ['', 'ask-once-minutes', 'allow-all', undefined]) {
    const effective = effectiveApprovalMode(stored)
    assert.equal(effective.mode, 'ask-each', String(stored))
    assert.equal(effective.unavailableReason, '')
  }
})

test('ask-each and ask-before-acting always ask the human', () => {
  for (const mode of ['ask-each', 'ask-before-acting']) {
    const decision = decideProductApproval({ toolName: 'bash', operation: escalation(), mode, grantMatched: false })
    assert.equal(decision.outcome, 'ask')
    assert.equal(decision.reason, 'prompt')
  }
})

test('an unknown/corrupt product mode fails closed to asking, never to allowing', () => {
  for (const mode of ['', 'allow-all', 'never', null, undefined]) {
    const decision = decideProductApproval({ toolName: 'write', operation: escalation(), mode, grantMatched: false })
    assert.equal(decision.outcome, 'ask', String(mode))
    assert.equal(decision.reason, 'unknown-mode')
  }
})

test('read probes stay auto-allowed (a read cannot produce a file effect)', () => {
  const decision = decideProductApproval({ toolName: 'read', operation: undefined, mode: 'never-ask', grantMatched: false })
  assert.equal(decision.outcome, 'allowed-once')
  assert.equal(decision.reason, 'read-probe')
})

test('an exact grant is honoured only for the same tool/cwd/complete arguments; any change asks again', t => {
  const home = mkdtempSync(join(tmpdir(), 'sandbox-approval-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const grants = createApprovalPolicies(join(home, 'grants.json'))
  const granted = grants.grant(escalation())
  assert.ok(granted)
  assert.ok(grants.match(escalation()), 'the confirmed operation matches its own grant')
  const changedArguments = { ...escalation(), arguments: { ...escalation().arguments, content: 'y' } }
  assert.equal(grants.match(changedArguments), null, 'a changed argument must not match the previous grant')
  const changedCwd = { ...escalation(), cwd: '/elsewhere' }
  assert.equal(grants.match(changedCwd), null, 'a changed working directory must not match')
  assert.notEqual(operationKey(escalation()), operationKey(changedArguments))
  const matched = decideProductApproval({ toolName: 'write', operation: escalation(), mode: 'never-ask', grantMatched: Boolean(grants.match(escalation())) })
  assert.equal(matched.outcome, 'allowed-once', 'an explicitly granted exact operation may auto-allow even under never-ask')
  assert.equal(matched.reason, 'exact-grant')
  const notMatched = decideProductApproval({ toolName: 'write', operation: changedArguments, mode: 'ask-each', grantMatched: Boolean(grants.match(changedArguments)) })
  assert.equal(notMatched.outcome, 'ask', 'the changed operation must be asked again')
})

test('an incomplete approval target (no recorded operation) is never auto-allowed', () => {
  for (const mode of ['ask-each', 'ask-once', 'ask-before-acting']) {
    const decision = decideProductApproval({ toolName: 'bash', operation: undefined, mode, grantMatched: false })
    assert.equal(decision.outcome, 'ask', mode)
  }
  const never = decideProductApproval({ toolName: 'bash', operation: undefined, mode: 'never-ask', grantMatched: false })
  assert.equal(never.outcome, 'rejected')
})
