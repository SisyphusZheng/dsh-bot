/**
 * Sensitive-information screen (adapter layer, BEFORE anything is sent to Hindsight).
 *
 * Product rule (MEMORY-SERVICE-SPEC §4): "敏感信息（Key/token/密码/身份证等）写入前拦截".
 * Hindsight also ships a native per-bank "Memory Defense" redactor/blocker; the adapter
 * screen is defense-in-depth so that (a) secrets never leave the process at all, and
 * (b) the failure is a clear product error instead of a redacted memory.
 *
 * The screen returns only pattern LABELS (never the matched text), so they are safe to
 * put into errors/logs.
 */

/** @typedef {{label: string, re: RegExp}} SensitivePattern */

/** @type {SensitivePattern[]} */
export const SENSITIVE_PATTERNS = [
  // --- private keys / certificates -------------------------------------------------
  { label: 'private_key_block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },

  // --- AI / LLM provider keys ------------------------------------------------------
  { label: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { label: 'openai_key', re: /\bsk-(?:proj-|admin-)?[A-Za-z0-9_-]{20,}/ },
  { label: 'deepseek_key', re: /\bsk-[a-f0-9]{32}\b/ },
  { label: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { label: 'xai_key', re: /\bxai-[A-Za-z0-9]{20,}/ },
  { label: 'groq_key', re: /\bgsk_[A-Za-z0-9]{20,}/ },
  { label: 'huggingface_token', re: /\bhf_[A-Za-z0-9]{30,}/ },
  { label: 'replicate_token', re: /\br8_[A-Za-z0-9]{30,}/ },

  // --- source control / CI ---------------------------------------------------------
  { label: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/ },
  { label: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { label: 'gitlab_pat', re: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { label: 'npm_token', re: /\bnpm_[A-Za-z0-9]{30,}/ },
  { label: 'pypi_token', re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}/ },

  // --- cloud / payment -------------------------------------------------------------
  { label: 'aws_access_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { label: 'stripe_secret', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  { label: 'slack_token', re: /\bxox[bpars]-[A-Za-z0-9-]{10,}/ },
  { label: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/ },
  { label: 'sendgrid_key', re: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/ },

  // --- generic credentials ---------------------------------------------------------
  { label: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  {
    label: 'credential_assignment',
    re: /\b(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*["']?[^\s"',;]{6,}/i,
  },
  { label: 'credential_url', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]{6,}@[^\s]+/i },
  // Chinese resident ID (18 chars, checksum-friendly shape). Avoids plain 18-digit numbers
  // by requiring a valid-looking birth-date segment.
  { label: 'cn_id_card', re: /\b[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/ },
];

/**
 * Scan one text for sensitive patterns.
 * @param {string} text
 * @returns {string[]} unique pattern labels (never matched substrings)
 */
export function scanSensitive(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  /** @type {Set<string>} */
  const hits = new Set();
  for (const { label, re } of SENSITIVE_PATTERNS) {
    // clone regex so lastIndex state from /g patterns can never leak between calls
    if (new RegExp(re.source, re.flags.replace('g', '')).test(text)) hits.add(label);
  }
  return [...hits];
}

/**
 * Throw if any of the given texts contains sensitive information.
 * @param {Array<{text: string, context?: string}>} items
 * @throws {import('./errors.mjs').SensitiveContentError}
 */
export function assertSensitiveFree(items) {
  /** @type {Set<string>} */
  const labels = new Set();
  for (const item of items) {
    for (const label of scanSensitive(`${item.text ?? ''}\n${item.context ?? ''}`)) labels.add(label);
  }
  if (labels.size > 0) {
    // Imported lazily to avoid an import cycle at module init time.
    const { SensitiveContentError } = awaitImportErrors();
    throw new SensitiveContentError([...labels]);
  }
}

// Small indirection so this module stays importable in isolation (and tests can
// import patterns without pulling the adapter in).
import * as errorsModule from './errors.mjs';
function awaitImportErrors() {
  return errorsModule;
}
