/**
 * Product approval-decision policy for the Bot bridge.
 *
 * This module answers one question only: given the approval request DSH already
 * raised (a one-shot sandbox escalation, a hook gate, a persistent exact
 * grant), does the PRODUCT auto-answer it, reject it without prompting, or
 * hand it to the pet bubble for the human? It never decides whether an
 * operation is safe and never widens a sandbox mode: DSH's `approveEscalation`
 * already proved the requested mode is strictly wider and applies the grant to
 * one call only.
 *
 * Fail-closed defaults: an unknown product mode prompts the human (not allows),
 * `never-ask` rejects, and an escalation that cannot be identified from the
 * recorded operation is never auto-allowed. `ask` means "no product decision —
 * ask the human", which the caller maps to the interactive bubble.
 *
 * @module nisse-host-integration/approval-decision
 */

/** The closed product approval modes stored in `config.json` (unknown values normalize to `ask-each`). */
export const PRODUCT_APPROVAL_MODES = Object.freeze(['ask-each', 'ask-before-acting', 'ask-once', 'never-ask'])

/** The modes that may auto-allow inside an active "once per N minutes" window. */
const ONCE_MODES = new Set(['ask-once'])

/**
 * The sandbox mode a recorded operation escalated to, or '' when the call is
 * not an escalation. The record is written by the product pre-execute guard
 * from the model-supplied arguments; DSH's own tool validation has already
 * rejected malformed escalation pairs before an approval request can happen.
 * @param {object|undefined} operation - the recorded operation (toolName/arguments/cwd).
 * @returns {string} the requested `sandbox_permissions` value, or ''.
 */
export function escalationOf(operation) {
  if (!operation || typeof operation !== 'object') return ''
  const args = operation.arguments
  if (!args || typeof args !== 'object') return ''
  const requested = args.sandbox_permissions
  return typeof requested === 'string' ? requested : ''
}

/** A product decision outcome; `ask` delegates to the interactive approval bubble. */
export const APPROVAL_DECISIONS = Object.freeze(['allowed-once', 'rejected', 'ask'])

/**
 * @typedef {object} ApprovalDecisionInput
 * @property {string} toolName - the tool the approval request names.
 * @property {object|undefined} operation - the product-recorded operation for the call, when available.
 * @property {string} mode - the stored product approval mode (unknown values fall back conservatively).
 * @property {boolean} grantMatched - whether the user already confirmed this exact tool/cwd/arguments.
 * @property {boolean} askOnceWindowOpen - whether an "ask-once" authorization window is still open.
 */

/**
 * Decide one approval request from the product's point of view.
 * @param {ApprovalDecisionInput} input - the request facts and product settings.
 * @returns {{ outcome: 'allowed-once'|'rejected'|'ask', reason: string }} the product decision.
 */
export function decideProductApproval({ toolName, operation, mode, grantMatched, askOnceWindowOpen }) {
  if (toolName === 'read') return { outcome: 'allowed-once', reason: 'read-probe' }
  if (grantMatched === true) return { outcome: 'allowed-once', reason: 'exact-grant' }
  if (mode === 'never-ask') return { outcome: 'rejected', reason: 'never-ask' }
  const escalation = escalationOf(operation)
  if (ONCE_MODES.has(mode) && escalation !== '' && askOnceWindowOpen === true) {
    return { outcome: 'allowed-once', reason: 'ask-once-window' }
  }
  // Unknown or corrupt product mode: never auto-answer; make the human decide.
  if (!PRODUCT_APPROVAL_MODES.includes(mode)) return { outcome: 'ask', reason: 'unknown-mode' }
  return { outcome: 'ask', reason: escalation === '' ? 'non-escalation' : 'prompt' }
}
