/**
 * Nisse thin MemoryAdapter over Hindsight v1.0.0 (pinned).
 *
 * Scope (MEMORY-SERVICE-SPEC §3, MASTER-CORRECTION §14.3): map Hindsight's native
 * retain/recall/curation/export onto the product contract and add only the missing
 * product concerns:
 *   - namespaces (global / project:<id> / session:<id>)  -> native per-memory tags + metadata
 *   - provenance (source sessionId/turnId, writer)       -> native per-memory metadata/tags
 *   - sensitive-information screen                       -> adapter-side pre-write rejection
 *   - single-writer policy                               -> role policy + cross-process lease
 *   - validity window / asOf                             -> metadata + minimal result-layer pruning
 *   - error mapping                                      -> typed errors, never fake success
 * It deliberately does NOT re-implement Hindsight's extraction, indexing, retrieval,
 * ranking or consolidation. Filters/ranking stay server-side; only the documented
 * minimal product-layer pruning happens on results.
 *
 * Namespace design: one Hindsight bank is the isolation boundary (one Nisse user/profile);
 * namespaces are native tags inside the bank (`ns:global`, `ns:project:<id>`,
 * `ns:session:<id>`) so a single recall can rank across scopes without cross-bank fan-out
 * and merging. Rationale + rejected alternative (bank-per-namespace) in REPORT.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { HindsightClient } from '../vendor/hindsight-client/runtime.mjs';

import {
  MemoryUnavailableError,
  InvalidRequestError,
  BackendRejectedError,
  BackendError,
  SensitiveContentError,
  IdempotencyConflictError,
  mapBackendError,
} from './errors.mjs';
import { scanSensitive } from './sensitive.mjs';
import { WriterLock } from './writer-lock.mjs';

export const ADAPTER_VERSION = '0.1.0';
export const DEFAULT_BANK_ID = 'nisse:default';
export const MEMORY_KINDS = ['profile', 'preference', 'fact', 'entity', 'episode', 'project', 'skill', 'procedure'];
export const NAMESPACE_RE = /^(?:global|project:[A-Za-z0-9._-]{1,64}|session:[A-Za-z0-9._-]{1,128})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAG_NS = (ns) => `ns:${ns}`;
const TAG_KIND = (kind) => `kind:${kind}`;
const CUSTOM_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

const DEFAULT_BANK_CONFIG = {
  // Deterministic adapter behaviour during the spike: no background LLM consolidation.
  // Native default is true; the product decision belongs to M4 (documented in REPORT.md).
  enableObservations: false,
  auditLogEnabled: true,
  storeDocumentText: true,
  // Defense in depth: Hindsight's native Memory Defense (45-pattern redact) on top of the
  // adapter pre-screen. The adapter screen blocks first; this catches anything that slips past.
  memoryDefense: { enabled: true, rules: [{ on: 'sensitive_data', action: 'redact' }] },
};

/**
 * @typedef {object} MemoryWrite
 * @property {'profile'|'preference'|'fact'|'entity'|'episode'|'project'|'skill'|'procedure'} kind
 * @property {string} text
 * @property {string[]} [entities]
 * @property {string} [validFrom] ISO-8601
 * @property {string} [validTo] ISO-8601 (adapter-level validity metadata)
 * @property {number} [confidence] 0..1
 * @property {string} [namespace] global|project:<id>|session:<id>
 * @property {string[]} [tags] extra product tags
 * @property {string} [context] native Hindsight context label
 */

/**
 * @typedef {object} MemoryHit
 * @property {string} id
 * @property {'profile'|'preference'|'fact'|'entity'|'episode'|'project'|'skill'|'procedure'} kind
 * @property {string} namespace
 * @property {string} text
 * @property {number} score
 * @property {string} [validFrom]
 * @property {string} [validTo]
 * @property {number} [confidence]
 * @property {{sessionId?: string, turnId?: string}} [source]
 * @property {string} updatedAt
 * @property {string} [documentId]
 * @property {string} [nativeType] Hindsight fact type: world|experience|observation
 * @property {{semantic?: number|null, keyword?: number|null, reranker?: number|null, final?: number}} [scores]
 */

export class MemoryAdapter {
  /**
   * @param {{
   *   baseUrl?: string,
   *   apiKey?: string,
   *   bankId?: string,
   *   runtimeDir?: string,
   *   writer?: string,
   *   allowedWriters?: string[],
   *   sensitiveScreen?: boolean,
   *   manageBankConfig?: boolean,
   *   bankConfig?: Record<string, unknown>,
   *   requestTimeoutMs?: number,
   *   writerLeaseTtlMs?: number,
   *   identity?: string,
   * }} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.NISSE_MEMORY_URL ?? 'http://127.0.0.1:18888').replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.bankId = opts.bankId ?? DEFAULT_BANK_ID;
    if (!/^[A-Za-z0-9:._-]{1,128}$/.test(this.bankId)) throw new InvalidRequestError(`invalid bankId '${this.bankId}'`);

    this.writer = opts.writer ?? 'bot';
    this.runtimeDir = opts.runtimeDir ?? process.env.NISSE_M1C_ROOT ?? '/tmp/nisse-m1-hindsight';
    this.sensitiveScreen = opts.sensitiveScreen !== false;
    this.manageBankConfig = opts.manageBankConfig !== false;
    this.bankConfig = { ...DEFAULT_BANK_CONFIG, ...(opts.bankConfig ?? {}) };
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30_000;
    this.identity = opts.identity ?? `pid:${process.pid}:adapter`;

    this.allowedWriters = opts.allowedWriters ?? ['bot', 'ui'];
    this.writerLock = new WriterLock({
      lockPath: path.join(this.runtimeDir, 'run', `writer-${this.bankId.replace(/[^A-Za-z0-9._-]/g, '_')}.lock`),
      allowedWriters: this.allowedWriters,
      ttlMs: opts.writerLeaseTtlMs ?? 120_000,
      identity: this.identity,
    });

    this.client = new HindsightClient({
      baseUrl: this.baseUrl,
      ...(this.apiKey ? { apiKey: this.apiKey } : {}),
      maxAttempts: 2,
      userAgent: `nisse-memory-adapter/${ADAPTER_VERSION}`,
    });

    /** @type {Promise<void> | null} */
    this._bankReady = null;
  }

  // ---------------------------------------------------------------------------
  // health
  // ---------------------------------------------------------------------------

  /**
   * Probe the backend. Never throws: `{ ok: false, degraded }` is the failure signal.
   * @returns {Promise<{ok: boolean, version?: string, degraded?: string, latencyMs: number, bankId: string, writerHeld?: boolean}>}
   */
  async health() {
    const started = Date.now();
    try {
      const [healthRes, versionRes] = await Promise.all([
        this.#fetchJson('GET', '/health', { timeoutMs: Math.min(this.requestTimeoutMs, 5000) }),
        this.#fetchJson('GET', '/version', { timeoutMs: Math.min(this.requestTimeoutMs, 5000) }).catch(() => null),
      ]);
      const version = versionRes?.json?.api_version;
      const lockStatus = this.writerLock.status();
      if (healthRes.status !== 200) {
        return {
          ok: false,
          version,
          degraded: `health_http_${healthRes.status}`,
          latencyMs: Date.now() - started,
          bankId: this.bankId,
          writerHeld: lockStatus.held,
        };
      }
      return { ok: true, version, latencyMs: Date.now() - started, bankId: this.bankId, writerHeld: lockStatus.held };
    } catch (err) {
      return {
        ok: false,
        degraded: (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 200),
        latencyMs: Date.now() - started,
        bankId: this.bankId,
      };
    }
  }

  // ---------------------------------------------------------------------------
  // bank bootstrap
  // ---------------------------------------------------------------------------

  /** Create-or-update the bank once and apply product bank config. */
  async ensureBank() {
    if (!this._bankReady) {
      this._bankReady = this.#call('ensureBank', async () => {
        await this.client.createBank(this.bankId, {});
        if (this.manageBankConfig && Object.keys(this.bankConfig).length > 0) {
          await this.client.updateBankConfig(this.bankId, this.bankConfig);
        }
      }).catch((err) => {
        this._bankReady = null;
        throw err;
      });
    }
    return this._bankReady;
  }

  // ---------------------------------------------------------------------------
  // write / retain
  // ---------------------------------------------------------------------------

  /**
   * Write memories. Semantics: all-or-nothing at the adapter layer — if validation or the
   * sensitive screen fails, NOTHING is sent. Backend failure throws (no fake success).
   * @param {MemoryWrite[]} items
   * @param {{writer?: string, source?: {sessionId?: string, turnId?: string}, idempotencyKey?: string, async?: boolean, supersedes?: string[], context?: string}} [opts]
   * @returns {Promise<{ok: true, bankId: string, documentId: string, itemsWritten: number, async: boolean, deduplicated?: boolean, usage?: object, operationId?: string, superseded?: {requested: number, invalidated: number, failed: string[]}}>}
   */
  async write(items, opts = {}) {
    const writer = opts.writer ?? this.writer;
    this.writerLock.assertWriterAuthorized(writer);
    const validated = this.#validateWriteItems(items, opts);

    // 1) sensitive screen BEFORE any egress
    if (this.sensitiveScreen) {
      /** @type {Set<string>} */
      const labels = new Set();
      for (const item of validated) for (const label of scanSensitive(`${item.text}\n${item.context ?? ''}`)) labels.add(label);
      if (labels.size > 0) throw new SensitiveContentError([...labels]);
    }

    if (opts.idempotencyKey !== undefined) this.#validateIdempotencyKey(opts.idempotencyKey);
    if (opts.supersedes !== undefined && !Array.isArray(opts.supersedes)) throw new InvalidRequestError('supersedes must be an array of memory ids');
    if (opts.async === true && opts.supersedes?.length) {
      throw new InvalidRequestError('supersedes requires synchronous write (async retain cannot report memory ids in time)');
    }

    await this.ensureBank();

    const lease = this.writerLock.acquire({ writer, reason: `write(${validated.length})` });
    try {
      const idempotencyHash = opts.idempotencyKey !== undefined ? sha256(opts.idempotencyKey).slice(0, 40) : undefined;
      const documentId = idempotencyHash ? `idem_${idempotencyHash}` : `nisse_${crypto.randomUUID()}`;

      // 2) idempotency: same key -> same document. Identical payload = no-op, different = conflict.
      if (idempotencyHash) {
        const existing = await this.#getDocumentOrNull(documentId);
        if (existing) {
          // Prefer the per-memory content hashes written by this adapter (works even when the
          // backend does not persist document bodies); fall back to the stored original text.
          const units = await this.#call('listMemories', () =>
            this.client.listMemories(this.bankId, { documentId, limit: 200 })
          );
          const storedHashes = new Set((units?.items ?? []).map((u) => u?.metadata?.contentHash).filter(Boolean));
          const wantedHashes = new Set(validated.map((item) => sha256(item.text).slice(0, 16)));
          const sameByHash = storedHashes.size > 0 && wantedHashes.size === storedHashes.size && [...wantedHashes].every((h) => storedHashes.has(h));
          const original = String(existing.original_text ?? '');
          const sameByText = original.length > 0 && validated.every((item) => original.includes(item.text.trim().slice(0, 80)));
          if (sameByHash || sameByText) {
            return {
              ok: true,
              bankId: this.bankId,
              documentId,
              itemsWritten: 0,
              async: false,
              deduplicated: true,
              superseded: opts.supersedes?.length ? { requested: opts.supersedes.length, invalidated: 0, failed: [...opts.supersedes] } : undefined,
            };
          }
          throw new IdempotencyConflictError(idempotencyHash);
        }
      }

      const retainItems = validated.map((item) => ({
        content: item.text,
        context: item.context ?? opts.context ?? undefined,
        timestamp: item.validFrom ?? new Date().toISOString(),
        document_id: documentId,
        tags: [TAG_NS(item.namespace), TAG_KIND(item.kind), ...(item.tags ?? [])],
        metadata: {
          adapter: `nisse-memory-adapter/${ADAPTER_VERSION}`,
          kind: item.kind,
          ns: item.namespace,
          writer,
          ...(opts.source?.sessionId ? { sourceSessionId: String(opts.source.sessionId).slice(0, 128) } : {}),
          ...(opts.source?.turnId ? { sourceTurnId: String(opts.source.turnId).slice(0, 128) } : {}),
          ...(item.validFrom ? { validFrom: item.validFrom } : {}),
          ...(item.validTo ? { validTo: item.validTo } : {}),
          ...(item.confidence !== undefined ? { confidence: String(item.confidence) } : {}),
          ...(idempotencyHash ? { idempotencyHash } : {}),
          contentHash: sha256(item.text).slice(0, 16),
        },
      }));

      const response = await this.#call('retain', () =>
        this.client.retainBatch(this.bankId, retainItems, {
          documentId,
          async: opts.async === true,
          ...(opts.async === true && opts.idempotencyKey !== undefined ? { operationId: crypto.randomUUID() } : {}),
        })
      );

      let superseded;
      if (opts.supersedes?.length) {
        const failed = [];
        let invalidated = 0;
        for (const memoryId of opts.supersedes) {
          try {
            await this.#invalidateMemory(memoryId, `superseded by ${documentId}`);
            invalidated++;
          } catch {
            failed.push(memoryId);
          }
        }
        superseded = { requested: opts.supersedes.length, invalidated, failed };
      }

      return {
        ok: true,
        bankId: this.bankId,
        documentId,
        itemsWritten: validated.length,
        async: opts.async === true,
        ...(response?.usage ? { usage: response.usage } : {}),
        ...(response?.operation_id ? { operationId: response.operation_id } : {}),
        ...(superseded ? { superseded } : {}),
      };
    } catch (err) {
      throw mapBackendError(err, 'write');
    } finally {
      lease.release();
    }
  }

  // ---------------------------------------------------------------------------
  // search / recall
  // ---------------------------------------------------------------------------

  /**
   * Recall memories. Server-side retrieval/ranking; adapter adds only scope/kind filtering
   * (native tags), `asOf` validity pruning (documented adapter metadata) and top-N trim.
   * @param {{query: string, namespaces?: string[], kinds?: string[], limit?: number, budgetTokens?: number, asOf?: string, budget?: 'low'|'mid'|'high', minScore?: number}} q
   * @returns {Promise<MemoryHit[]>}
   */
  async search(q) {
    const query = q?.query;
    if (typeof query !== 'string' || query.trim().length === 0) throw new InvalidRequestError('search requires a non-empty query');
    if (query.length > 2000) throw new InvalidRequestError('search query too long (>2000 chars)');
    const namespaces = this.#validateNamespaces(q.namespaces);
    const kinds = this.#validateKinds(q.kinds);
    const limit = q.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvalidRequestError('limit must be an integer 1..100');
    const budgetTokens = q.budgetTokens ?? 1000;
    if (!Number.isInteger(budgetTokens) || budgetTokens < 64 || budgetTokens > 8000) throw new InvalidRequestError('budgetTokens must be an integer 64..8000');
    const budget = q.budget ?? 'mid';
    if (!['low', 'mid', 'high'].includes(budget)) throw new InvalidRequestError("budget must be 'low'|'mid'|'high'");
    if (q.asOf !== undefined && Number.isNaN(Date.parse(q.asOf))) throw new InvalidRequestError('asOf must be an ISO-8601 timestamp');
    if (q.minScore !== undefined && (typeof q.minScore !== 'number' || q.minScore < 0 || q.minScore > 1)) throw new InvalidRequestError('minScore must be 0..1');

    await this.ensureBank();

    /** @type {any[]} */
    const tagGroups = [];
    if (namespaces.length) tagGroups.push({ or: namespaces.map((ns) => ({ tags: [TAG_NS(ns)], match: 'any_strict' })) });
    if (kinds.length) tagGroups.push({ or: kinds.map((kind) => ({ tags: [TAG_KIND(kind)], match: 'any_strict' })) });

    const response = await this.#call('recall', () =>
      this.client.recall(this.bankId, query, {
        budget,
        maxTokens: budgetTokens,
        includeEntities: false,
        includeChunks: false,
        ...(q.asOf ? { queryTimestamp: q.asOf } : {}),
        ...(tagGroups.length ? { tagGroups } : {}),
        ...(q.minScore !== undefined ? { minScores: { final: q.minScore } } : {}),
      })
    );

    const results = Array.isArray(response?.results) ? response.results : [];
    /** @type {MemoryHit[]} */
    const hits = [];
    for (const r of results) {
      const hit = this.#mapHit(r);
      // Minimal result-layer pruning (documented): defensive scope check + asOf validity window.
      if (namespaces.length && !namespaces.includes(hit.namespace)) continue;
      if (kinds.length && !kinds.includes(hit.kind)) continue;
      if (q.asOf && !isValidAsOf(hit, q.asOf)) continue;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    return hits;
  }

  // ---------------------------------------------------------------------------
  // forget / delete
  // ---------------------------------------------------------------------------

  /**
   * Forget memories. Two documented modes:
   *   - `ids` (memory ids and/or document ids): memory ids are soft-retired via native curation
   *     (`state: invalidated`, excluded from recall, reversible); document ids are hard-deleted
   *     with the document endpoint (document + its memory units removed).
   *   - filter (`query` | `namespaces` | `before`): resolves candidates through native recall/list,
   *     then soft-retires them. Broad (non-id/query) filters additionally require `confirm: true`.
   * Verification is not assumed: the adapter re-reads the backend and reports `verified`.
   * @param {{ids?: string[], query?: string, namespaces?: string[], before?: string}} filter
   * @param {{writer?: string, confirm?: boolean, limit?: number, mode?: 'invalidate'|'delete-documents'}} [opts]
   * @returns {Promise<{deleted: number, invalidated: number, deletedDocuments: number, notFound: string[], verified: boolean, remaining: number}>}
   */
  async forget(filter = {}, opts = {}) {
    const writer = opts.writer ?? this.writer;
    this.writerLock.assertWriterAuthorized(writer);
    const hasIds = Array.isArray(filter.ids) && filter.ids.length > 0;
    const hasQuery = typeof filter.query === 'string' && filter.query.trim().length > 0;
    const namespaces = this.#validateNamespaces(filter.namespaces);
    const hasNamespaces = namespaces.length > 0;
    const hasBefore = filter.before !== undefined;
    if (!hasIds && !hasQuery && !hasNamespaces && !hasBefore) {
      throw new InvalidRequestError('forget requires at least one filter (ids|query|namespaces|before); refusing to wipe a bank implicitly');
    }
    if (hasBefore && Number.isNaN(Date.parse(filter.before))) throw new InvalidRequestError('before must be an ISO-8601 timestamp');
    if (!hasIds && !hasQuery && !opts.confirm) {
      throw new InvalidRequestError('broad forget (namespaces/before) requires confirm:true');
    }
    const cap = Math.min(opts.limit ?? 1000, 5000);
    await this.ensureBank();
    const lease = this.writerLock.acquire({ writer, reason: 'forget' });
    try {
      const notFound = [];
      let invalidated = 0;
      let deletedDocuments = 0;
      /** @type {string[]} */
      const affectedMemoryIds = [];
      /** @type {string[]} */
      const affectedDocuments = [];

      if (hasIds) {
        for (const id of filter.ids) {
          if (typeof id !== 'string' || id.length === 0 || id.length > 200) throw new InvalidRequestError('ids must be non-empty strings');
          // Memory unit ids are UUIDs; document ids are adapter-generated (nisse_/idem_). Only ask
          // the memory endpoint for UUID-shaped ids — the backend rejects anything else with HTTP 400.
          const memory = UUID_RE.test(id) ? await this.#getMemoryOrNull(id) : null;
          if (memory) {
            await this.#invalidateMemory(id, 'user forget request');
            invalidated++;
            affectedMemoryIds.push(id);
            continue;
          }
          const deleted = await this.#deleteDocumentOrNull(id);
          if (deleted) {
            deletedDocuments++;
            affectedDocuments.push(id);
            continue;
          }
          notFound.push(id);
        }
      } else {
        const candidates = await this.#resolveForgetCandidates({ query: hasQuery ? filter.query : undefined, namespaces, before: filter.before, cap });
        if (candidates.truncated) throw new InvalidRequestError(`forget filter matches more than ${cap} memories; narrow the filter or raise limit (no implicit mass delete)`);
        for (const memoryId of candidates.memoryIds) {
          await this.#invalidateMemory(memoryId, 'user forget request (filter)');
          invalidated++;
          affectedMemoryIds.push(memoryId);
        }
      }

      let verified = true;
      let remaining = 0;
      if (hasIds) {
        for (const id of affectedMemoryIds) {
          const mem = await this.#getMemoryOrNull(id);
          if (mem && mem.state !== 'invalidated') remaining++;
        }
        // Documents are hard-deleted: they must 404 now and their facts must not be recallable.
        for (const docId of affectedDocuments) {
          const doc = await this.#getDocumentOrNull(docId);
          if (doc) remaining++;
        }
        verified = remaining === 0;
      }
      if (hasQuery) {
        const after = await this.search({ query: filter.query, namespaces: namespaces.length ? namespaces : undefined, limit: 100, budgetTokens: 4000 });
        const leaked = after.filter((hit) => affectedMemoryIds.includes(hit.id));
        remaining += leaked.length;
        verified = verified && leaked.length === 0;
      }
      if (hasNamespaces || hasBefore) {
        const still = await this.#listActiveMemories({ namespaces, before: filter.before, cap: 5000 });
        remaining += still.items.length;
        verified = verified && still.items.length === 0;
      }

      return { deleted: invalidated + deletedDocuments, invalidated, deletedDocuments, notFound, verified, remaining };
    } catch (err) {
      throw mapBackendError(err, 'forget');
    } finally {
      lease.release();
    }
  }

  // ---------------------------------------------------------------------------
  // export
  // ---------------------------------------------------------------------------

  /**
   * Export active memories to a local JSONL/Markdown file (product-readable export).
   * This is an export/backup format only — the adapter does not keep a parallel
   * authoritative store (MASTER-CORRECTION §14.3). For full-fidelity native backup use
   * `exportArchive()` (Hindsight bank-transfer ZIP, importable via `importArchive`).
   * @param {{namespaces?: string[], format?: 'jsonl'|'markdown', outPath?: string, includeInvalidated?: boolean, limit?: number}} [q]
   * @returns {Promise<{path: string, count: number, format: 'jsonl'|'markdown', bankId: string, namespaces: string[]}>}
   */
  async export(q = {}) {
    const namespaces = this.#validateNamespaces(q.namespaces);
    const format = q.format ?? 'jsonl';
    if (!['jsonl', 'markdown'].includes(format)) throw new InvalidRequestError("format must be 'jsonl' or 'markdown'");
    const includeInvalidated = q.includeInvalidated === true;
    const limit = Math.min(q.limit ?? 100_000, 100_000);
    await this.ensureBank();

    /** @type {any[]} */
    const rows = [];
    let offset = 0;
    const pageSize = 100;
    while (rows.length < limit) {
      const page = await this.#call('listMemories', () =>
        this.client.listMemories(this.bankId, {
          limit: pageSize,
          offset,
          ...(namespaces.length ? { tags: namespaces.map(TAG_NS), tagsMatch: 'any_strict' } : {}),
          ...(includeInvalidated ? {} : { state: 'valid' }),
        })
      );
      const items = page?.items ?? [];
      for (const item of items) {
        rows.push({
          bank: this.bankId,
          id: item.id,
          documentId: item.document_id ?? undefined,
          namespace: this.#namespaceOf(item),
          kind: this.#kindOf(item),
          nativeType: item.fact_type ?? undefined,
          text: item.text,
          date: item.mentioned_at ?? item.date ?? undefined,
          occurredStart: item.occurred_start ?? undefined,
          occurredEnd: item.occurred_end ?? undefined,
          state: item.state ?? undefined,
          tags: item.tags ?? [],
          metadata: item.metadata ?? {},
        });
        if (rows.length >= limit) break;
      }
      if (items.length < pageSize) break;
      offset += pageSize;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath =
      q.outPath ?? path.join(this.runtimeDir, 'exports', `nisse-memory-${stamp}.${format === 'jsonl' ? 'jsonl' : 'md'}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const body = format === 'jsonl' ? rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '') : renderMarkdown(rows, this.bankId, namespaces);
    fs.writeFileSync(outPath, body, { mode: 0o600 });
    return { path: outPath, count: rows.length, format, bankId: this.bankId, namespaces };
  }

  /**
   * Native full-fidelity export (Hindsight bank-transfer ZIP; can be imported by Hindsight
   * admin/transfer APIs on the same pinned version). This is the backup/rollback path.
   * @param {{outPath?: string, includeBankConfig?: boolean, includeHistory?: boolean}} [opts]
   * @returns {Promise<{path: string, bytes: number, bankId: string}>}
   */
  async exportArchive(opts = {}) {
    await this.ensureBank();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outPath = opts.outPath ?? path.join(this.runtimeDir, 'exports', `nisse-bank-transfer-${stamp}.zip`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    let bytes;
    try {
      bytes = await this.client.exportBank(this.bankId, {
        includeData: true,
        includeBankConfig: opts.includeBankConfig !== false,
        includeHistory: opts.includeHistory === true,
      });
    } catch (err) {
      throw mapBackendError(err, 'exportArchive');
    }
    fs.writeFileSync(outPath, Buffer.from(bytes), { mode: 0o600 });
    return { path: outPath, bytes: Buffer.from(bytes).byteLength, bankId: this.bankId };
  }

  // ---------------------------------------------------------------------------
  // digest helper (product layer: bounded standing context, spec §6)
  // ---------------------------------------------------------------------------

  /**
   * Build a small digest of active memories for prompt injection. Hindsight has no native
   * token-budgeted digest endpoint for arbitrary scopes; this reuses recall/list ordering
   * (server-side) and trims at the result layer — it does not re-rank or re-index.
   * Token count is an estimate (chars/4) unless the caller supplies a tokenizer.
   * @param {{namespaces?: string[], maxTokens?: number, maxItems?: number, tokenizer?: (text: string) => number}} [opts]
   * @returns {Promise<{text: string, tokensEstimated: number, items: number, truncated: boolean}>}
   */
  async buildDigest(opts = {}) {
    const namespaces = this.#validateNamespaces(opts.namespaces);
    const maxTokens = Math.min(Math.max(opts.maxTokens ?? 800, 100), 2000);
    const maxItems = Math.min(opts.maxItems ?? 40, 100);
    const tokenizer = opts.tokenizer ?? ((text) => Math.ceil(text.length / 4));
    await this.ensureBank();
    const page = await this.#call('listMemories', () =>
      this.client.listMemories(this.bankId, {
        limit: Math.min(maxItems * 3, 200),
        state: 'valid',
        ...(namespaces.length ? { tags: namespaces.map(TAG_NS), tagsMatch: 'any_strict' } : {}),
      })
    );
    const lines = [];
    let tokens = 0;
    let truncated = false;
    for (const item of page?.items ?? []) {
      const ns = this.#namespaceOf(item);
      const kind = this.#kindOf(item);
      const line = `- [${kind}] ${String(item.text ?? '').replace(/\s+/g, ' ').trim()}${ns !== 'global' ? ` (${ns})` : ''}`;
      const cost = tokenizer(line) + 1;
      if (tokens + cost > maxTokens || lines.length >= maxItems) {
        truncated = true;
        break;
      }
      lines.push(line);
      tokens += cost;
    }
    return { text: lines.join('\n'), tokensEstimated: tokens, items: lines.length, truncated };
  }

  // ---------------------------------------------------------------------------
  // low-level helpers
  // ---------------------------------------------------------------------------

  /**
   * Thin pass-through to the native recall API (debug/benchmark only). No product
   * semantics: callers get Hindsight's raw RecallResponse.
   * @param {string} query
   * @param {Record<string, unknown>} [options]
   */
  async recallRaw(query, options = {}) {
    await this.ensureBank();
    return this.#call('recallRaw', () => this.client.recall(this.bankId, query, options));
  }

  /**
   * @param {any} r RecallResult
   * @returns {MemoryHit}
   */
  #mapHit(r) {
    const metadata = /** @type {Record<string,string>} */ (r?.metadata ?? {});
    const tags = Array.isArray(r?.tags) ? r.tags : [];
    const namespace = metadata.ns ?? tagValue(tags, 'ns:') ?? 'unknown';
    const kind = metadata.kind ?? tagValue(tags, 'kind:') ?? 'fact';
    const source = {};
    if (metadata.sourceSessionId) source.sessionId = metadata.sourceSessionId;
    if (metadata.sourceTurnId) source.turnId = metadata.sourceTurnId;
    const confidence = metadata.confidence !== undefined ? Number(metadata.confidence) : undefined;
    return {
      id: String(r?.id ?? ''),
      kind: /** @type {any} */ (kind),
      namespace,
      text: String(r?.text ?? ''),
      score: Number(r?.scores?.final ?? 0),
      ...(metadata.validFrom || r?.occurred_start ? { validFrom: metadata.validFrom ?? r.occurred_start } : {}),
      ...(metadata.validTo || r?.occurred_end ? { validTo: metadata.validTo ?? r.occurred_end } : {}),
      ...(Number.isFinite(confidence) ? { confidence } : {}),
      ...(Object.keys(source).length ? { source } : {}),
      updatedAt: r?.mentioned_at ?? new Date().toISOString(),
      ...(r?.document_id ? { documentId: r.document_id } : {}),
      ...(r?.type ? { nativeType: r.type } : {}),
      ...(r?.scores ? { scores: r.scores } : {}),
    };
  }

  /**
   * @param {unknown} items
   * @param {{source?: {sessionId?: string}}} opts
   * @returns {Array<{kind: string, text: string, namespace: string, tags: string[], context?: string, validFrom?: string, validTo?: string, confidence?: number}>}
   */
  #validateWriteItems(items, opts) {
    if (!Array.isArray(items) || items.length === 0) throw new InvalidRequestError('write requires a non-empty items array');
    if (items.length > 200) throw new InvalidRequestError('write accepts at most 200 items per call');
    const defaultNamespace = opts?.source?.sessionId ? makeNamespace('session', opts.source.sessionId) : 'global';
    return items.map((item, index) => {
      if (!item || typeof item !== 'object') throw new InvalidRequestError(`items[${index}] must be an object`);
      if (typeof item.text !== 'string' || item.text.trim().length === 0) throw new InvalidRequestError(`items[${index}].text must be a non-empty string`);
      if (item.text.length > 20_000) throw new InvalidRequestError(`items[${index}].text too long (>20000 chars)`);
      const kind = item.kind ?? 'fact';
      if (!MEMORY_KINDS.includes(kind)) throw new InvalidRequestError(`items[${index}].kind must be one of ${MEMORY_KINDS.join('|')}`);
      const namespace = item.namespace ?? defaultNamespace;
      if (!NAMESPACE_RE.test(namespace)) throw new InvalidRequestError(`items[${index}].namespace must be global|project:<id>|session:<id>`);
      const tags = item.tags ?? [];
      if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !CUSTOM_TAG_RE.test(t))) {
        throw new InvalidRequestError(`items[${index}].tags must be valid tag strings`);
      }
      if (item.validFrom !== undefined && Number.isNaN(Date.parse(item.validFrom))) throw new InvalidRequestError(`items[${index}].validFrom must be ISO-8601`);
      if (item.validTo !== undefined && Number.isNaN(Date.parse(item.validTo))) throw new InvalidRequestError(`items[${index}].validTo must be ISO-8601`);
      if (item.validFrom && item.validTo && Date.parse(item.validTo) < Date.parse(item.validFrom)) {
        throw new InvalidRequestError(`items[${index}].validTo must not precede validFrom`);
      }
      if (item.confidence !== undefined && (typeof item.confidence !== 'number' || item.confidence < 0 || item.confidence > 1)) {
        throw new InvalidRequestError(`items[${index}].confidence must be 0..1`);
      }
      if (item.context !== undefined && typeof item.context !== 'string') throw new InvalidRequestError(`items[${index}].context must be a string`);
      return {
        kind,
        text: item.text,
        namespace,
        tags,
        ...(item.context !== undefined ? { context: item.context.slice(0, 500) } : {}),
        ...(item.validFrom ? { validFrom: new Date(item.validFrom).toISOString() } : {}),
        ...(item.validTo ? { validTo: new Date(item.validTo).toISOString() } : {}),
        ...(item.confidence !== undefined ? { confidence: item.confidence } : {}),
      };
    });
  }

  /** @param {unknown} value */
  #validateIdempotencyKey(value) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 200) {
      throw new InvalidRequestError('idempotencyKey must be a non-empty string (<=200 chars)');
    }
  }

  /** @param {unknown} namespaces @returns {string[]} */
  #validateNamespaces(namespaces) {
    if (namespaces === undefined || namespaces === null) return [];
    if (!Array.isArray(namespaces) || namespaces.some((ns) => typeof ns !== 'string' || !NAMESPACE_RE.test(ns))) {
      throw new InvalidRequestError('namespaces must be an array of global|project:<id>|session:<id>');
    }
    return [...new Set(namespaces)];
  }

  /** @param {unknown} kinds @returns {string[]} */
  #validateKinds(kinds) {
    if (kinds === undefined || kinds === null) return [];
    if (!Array.isArray(kinds) || kinds.some((k) => typeof k !== 'string' || !MEMORY_KINDS.includes(k))) {
      throw new InvalidRequestError(`kinds must be an array of ${MEMORY_KINDS.join('|')}`);
    }
    return [...new Set(kinds)];
  }

  /**
   * Resolve forget candidates through native recall (query) or native list (scope/time).
   * @param {{query?: string, namespaces: string[], before?: string, cap: number}} args
   */
  async #resolveForgetCandidates({ query, namespaces, before, cap }) {
    /** @type {Set<string>} */
    const memoryIds = new Set();
    let truncated = false;
    if (query) {
      const response = await this.#call('recall', () =>
        this.client.recall(this.bankId, query, {
          budget: 'high',
          maxTokens: 8000,
          includeEntities: false,
          includeChunks: false,
          ...(namespaces.length ? { tagGroups: [{ or: namespaces.map((ns) => ({ tags: [TAG_NS(ns)], match: 'any_strict' })) }] } : {}),
        })
      );
      for (const r of response?.results ?? []) {
        if (r?.id) memoryIds.add(String(r.id));
        if (memoryIds.size > cap) {
          truncated = true;
          break;
        }
      }
    } else {
      const listed = await this.#listActiveMemories({ namespaces, before, cap });
      for (const item of listed.items) if (item?.id) memoryIds.add(String(item.id));
      truncated = listed.truncated;
    }
    return { memoryIds: [...memoryIds], truncated };
  }

  /**
   * @param {{namespaces?: string[], before?: string, cap: number}} args
   */
  async #listActiveMemories({ namespaces = [], before, cap }) {
    /** @type {any[]} */
    const items = [];
    let offset = 0;
    const pageSize = 100;
    let truncated = false;
    for (;;) {
      const page = await this.#call('listMemories', () =>
        this.client.listMemories(this.bankId, {
          limit: pageSize,
          offset,
          state: 'valid',
          ...(namespaces.length ? { tags: namespaces.map(TAG_NS), tagsMatch: 'any_strict' } : {}),
          ...(before ? { timeField: 'created_at', endDate: before } : {}),
        })
      );
      const batch = page?.items ?? [];
      for (const item of batch) {
        items.push(item);
        if (items.length > cap) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
      if (batch.length < pageSize) break;
      offset += pageSize;
      if (offset > 1_000_000) break;
    }
    return { items, truncated };
  }

  /** @param {string} memoryId @param {string} reason */
  async #invalidateMemory(memoryId, reason) {
    await this.#fetchJson('PATCH', `/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/${encodeURIComponent(memoryId)}`, {
      body: { state: 'invalidated', reason: String(reason).slice(0, 200) },
    });
  }

  /** @param {string} memoryId @returns {Promise<any | null>} */
  async #getMemoryOrNull(memoryId) {
    const res = await this.#fetchJson('GET', `/v1/default/banks/${encodeURIComponent(this.bankId)}/memories/${encodeURIComponent(memoryId)}`, {
      // 400 = backend says "not a valid UUID" => definitively not a memory unit.
      acceptStatuses: [200, 400, 404],
    });
    if (res.status !== 200) return null;
    return res.json;
  }

  /** @param {string} documentId @returns {Promise<any | null>} */
  async #getDocumentOrNull(documentId) {
    const res = await this.#fetchJson('GET', `/v1/default/banks/${encodeURIComponent(this.bankId)}/documents/${encodeURIComponent(documentId)}`, {
      acceptStatuses: [200, 404],
    });
    if (res.status === 404) return null;
    return res.json;
  }

  /** @param {string} documentId @returns {Promise<boolean>} */
  async #deleteDocumentOrNull(documentId) {
    const res = await this.#fetchJson('DELETE', `/v1/default/banks/${encodeURIComponent(this.bankId)}/documents/${encodeURIComponent(documentId)}`, {
      acceptStatuses: [200, 404],
    });
    return res.status === 200;
  }

  /** @param {any} item */
  #namespaceOf(item) {
    const metadata = item?.metadata ?? {};
    if (typeof metadata.ns === 'string') return metadata.ns;
    return tagValue(Array.isArray(item?.tags) ? item.tags : [], 'ns:') ?? 'unknown';
  }

  /** @param {any} item */
  #kindOf(item) {
    const metadata = item?.metadata ?? {};
    if (typeof metadata.kind === 'string') return metadata.kind;
    return tagValue(Array.isArray(item?.tags) ? item.tags : [], 'kind:') ?? 'fact';
  }

  /**
   * @param {string} op
   * @param {() => Promise<any>} fn
   */
  async #call(op, fn) {
    try {
      return await fn();
    } catch (err) {
      throw mapBackendError(err, op);
    }
  }

  /**
   * Minimal raw HTTP for endpoints the pinned Node client does not wrap (health/version,
   * memory curation PATCH/GET, document GET/DELETE). Returns {status, json}; throws typed
   * errors only for unexpected statuses.
   * @param {'GET'|'PATCH'|'DELETE'|'POST'} method
   * @param {string} pathname
   * @param {{body?: unknown, timeoutMs?: number, acceptStatuses?: number[]}} [opts]
   */
  async #fetchJson(method, pathname, opts = {}) {
    const url = `${this.baseUrl}${pathname}`;
    const headers = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.requestTimeoutMs),
      });
    } catch (err) {
      throw mapBackendError(err, `${method} ${pathname}`);
    }
    const text = await res.text().catch(() => '');
    let json;
    // eslint-disable-next-line no-empty
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    const accepted = opts.acceptStatuses ?? [200];
    if (!accepted.includes(res.status)) {
      const detail = typeof json?.detail === 'string' ? json.detail.slice(0, 200) : undefined;
      if (res.status === 429 || res.status >= 500) {
        throw new BackendError(`${method} ${pathname} failed: HTTP ${res.status}`, { statusCode: res.status, details: detail ? { detail } : undefined });
      }
      throw new BackendRejectedError(`${method} ${pathname} failed: HTTP ${res.status}`, {
        statusCode: res.status,
        details: res.status === 404 ? { notFound: true } : detail ? { detail } : undefined,
      });
    }
    return { status: res.status, json };
  }
}

// -----------------------------------------------------------------------------
// small pure helpers
// -----------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * @param {string} prefix 'session'|'project'
 * @param {string} rawId
 */
function makeNamespace(prefix, rawId) {
  const safe = String(rawId)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, prefix === 'session' ? 128 : 64);
  const candidate = `${prefix}:${safe}`;
  return NAMESPACE_RE.test(candidate) ? candidate : `${prefix}:unknown`;
}

/**
 * @param {string[]} tags
 * @param {string} prefix
 */
function tagValue(tags, prefix) {
  const found = tags.find((t) => typeof t === 'string' && t.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

/**
 * Adapter-level validity: a hit is valid "as of" a timestamp when its validFrom <= asOf
 * and validTo >= asOf. Items without a window are always considered valid.
 * @param {{validFrom?: string, validTo?: string}} hit
 * @param {string} asOf
 */
function isValidAsOf(hit, asOf) {
  const at = Date.parse(asOf);
  if (!Number.isFinite(at)) return true;
  if (hit.validFrom) {
    const from = Date.parse(hit.validFrom);
    if (Number.isFinite(from) && from > at) return false;
  }
  if (hit.validTo) {
    const to = Date.parse(hit.validTo);
    if (Number.isFinite(to) && to < at) return false;
  }
  return true;
}

/**
 * @param {any[]} rows
 * @param {string} bankId
 * @param {string[]} namespaces
 */
function renderMarkdown(rows, bankId, namespaces) {
  const lines = [
    `# Nisse memory export`,
    ``,
    `- bank: \`${bankId}\``,
    `- exportedAt: ${new Date().toISOString()}`,
    `- namespaces: ${namespaces.length ? namespaces.join(', ') : 'all'}`,
    `- count: ${rows.length}`,
    ``,
  ];
  /** @type {Map<string, any[]>} */
  const byNs = new Map();
  for (const row of rows) {
    const key = row.namespace ?? 'unknown';
    if (!byNs.has(key)) byNs.set(key, []);
    byNs.get(key).push(row);
  }
  for (const [ns, items] of [...byNs.entries()].sort()) {
    lines.push(`## ${ns}`, '');
    for (const item of items) {
      lines.push(`- **[${item.kind}]** ${String(item.text).replace(/\n/g, ' ')}`);
      const prov = [];
      if (item.date) prov.push(`mentioned ${item.date}`);
      if (item.occurredStart || item.occurredEnd) prov.push(`occurred ${item.occurredStart ?? '?'}..${item.occurredEnd ?? '?'}`);
      if (item.documentId) prov.push(`document ${item.documentId}`);
      if (item.metadata?.sourceSessionId) prov.push(`session ${item.metadata.sourceSessionId}`);
      if (item.metadata?.sourceTurnId) prov.push(`turn ${item.metadata.sourceTurnId}`);
      if (item.state && item.state !== 'valid') prov.push(`state ${item.state}`);
      if (prov.length) lines.push(`  - _${prov.join(' · ')}_`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
