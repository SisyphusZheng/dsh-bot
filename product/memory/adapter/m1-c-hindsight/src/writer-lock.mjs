/**
 * Single-writer lease for one Hindsight bank.
 *
 * Hindsight itself has no write lease: concurrent clients can write the same bank.
 * The product rule (MEMORY-SERVICE-SPEC §5) is "默认 Bot/Host Integration 写；subagent 只读".
 * The adapter therefore enforces:
 *   1. role policy — only authorized writers may write at all (subagents/read-only always rejected);
 *   2. a cross-process advisory lease — at most one authorized writer process mutates a bank
 *      at a time; contenders get a typed WRITER_CONFLICT instead of silently double-writing.
 *
 * The lease is a 0600 JSON file created with O_EXCL under the runtime dir, holding the owner
 * identity and an expiry. It is an *advisory* lock (like most desktop apps): stale leases are
 * taken over after `ttlMs`, and a crashed holder cannot block writes forever. A live lease is
 * renewed by a heartbeat so a slow (real-LLM) retain does not expire mid-write.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ReadonlyWriterError, WriterConflictError, MemoryUnavailableError } from './errors.mjs';

const DEFAULT_TTL_MS = 120_000;

export class WriterLock {
  /**
   * @param {{
   *   lockPath: string,
   *   allowedWriters?: string[],
   *   ttlMs?: number,
   *   identity?: string,
   * }} opts
   */
  constructor({ lockPath, allowedWriters = ['bot', 'ui'], ttlMs = DEFAULT_TTL_MS, identity }) {
    if (!lockPath) throw new Error('WriterLock requires lockPath');
    this.lockPath = lockPath;
    this.allowedWriters = allowedWriters;
    this.ttlMs = ttlMs;
    this.identity = identity ?? `pid:${process.pid}`;
    /** @type {{token: string, writer: string, acquiredAt: number, expiresAt: number} | null} */
    this._lease = null;
    /** @type {NodeJS.Timeout | null} */
    this._heartbeat = null;
  }

  /** @param {string} writer */
  assertWriterAuthorized(writer) {
    if (!this.allowedWriters.includes(writer)) throw new ReadonlyWriterError(writer, this.allowedWriters);
  }

  /**
   * Acquire the lease (reentrant for the same lock instance with the same writer).
   * @param {{writer: string, reason?: string}} opts
   * @returns {{token: string, writer: string, acquiredAt: number, expiresAt: number, release: () => void}}
   */
  acquire({ writer, reason = '' }) {
    this.assertWriterAuthorized(writer);
    if (this._lease && this._lease.writer === writer) return this.#leaseHandle(this._lease);

    const payload = {
      token: crypto.randomUUID(),
      identity: this.identity,
      pid: process.pid,
      writer,
      reason: String(reason).slice(0, 120),
      acquiredAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
    };

    fs.mkdirSync(path.dirname(this.lockPath), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        try {
          fs.writeSync(fd, JSON.stringify(payload));
        } finally {
          fs.closeSync(fd);
        }
        this._lease = payload;
        // Heartbeat so a long real-LLM retain does not expire its own lease.
        this._heartbeat = setInterval(() => {
          try {
            const now = Date.now();
            fs.writeFileSync(this.lockPath, JSON.stringify({ ...payload, expiresAt: now + this.ttlMs }), { mode: 0o600 });
          } catch {
            /* best effort: expiry takeover is the fallback */
          }
        }, Math.max(1000, Math.floor(this.ttlMs / 3)));
        this._heartbeat.unref?.();
        return this.#leaseHandle(payload);
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== 'EEXIST') throw new MemoryUnavailableError(`writer lease create failed: ${err?.code ?? err}`, { cause: err });
        const holder = this.holder();
        if (!holder || !Number.isFinite(holder.expiresAt) || holder.expiresAt <= Date.now()) {
          // Stale lease (crashed/hung owner): best-effort removal, then retry.
          this.#unlinkIfMatches(holder?.token ?? null);
          continue;
        }
        throw new WriterConflictError(holder);
      }
    }
    throw new WriterConflictError(this.holder());
  }

  /** @returns {{token:string,identity:string,pid:number,writer:string,reason:string,acquiredAt:number,expiresAt:number} | null} */
  holder() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /** @param {{token:string}} lease */
  release(lease = this._lease) {
    if (!lease) return;
    this.#unlinkIfMatches(lease.token);
    if (this._lease?.token === lease.token) this._lease = null;
    if (this._heartbeat) {
      clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
  }

  status() {
    const holder = this.holder();
    return {
      path: this.lockPath,
      held: holder !== null,
      holder,
      stale: holder !== null && Number.isFinite(holder.expiresAt) && holder.expiresAt <= Date.now(),
      self: this._lease !== null,
    };
  }

  /**
   * @param {string | null} expectedToken
   */
  #unlinkIfMatches(expectedToken) {
    try {
      if (expectedToken !== null) {
        const current = this.holder();
        if (current && current.token !== expectedToken) return false;
      }
      fs.unlinkSync(this.lockPath);
      return true;
    } catch {
      return false;
    }
  }

  /** @param {{token:string,writer:string,acquiredAt:number,expiresAt:number}} payload */
  #leaseHandle(payload) {
    return {
      token: payload.token,
      writer: payload.writer,
      acquiredAt: payload.acquiredAt,
      expiresAt: payload.expiresAt,
      release: () => this.release(payload),
    };
  }
}
