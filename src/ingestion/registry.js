/**
 * DocRegistry — source of truth for what is in the vector store.
 *
 * Postgres-backed map: doc_id -> { hash, size, mtime, chunkCount, lastIndexedAt }
 * Used by the incremental injection pipeline to diff incoming files against
 * what has already been embedded, so only the delta is re-embedded.
 *
 * Graceful degradation: if Postgres is unavailable on init(), falls back to
 * the legacy JSON file so local / offline runs keep working.
 *
 * Call `await registry.init()` once before using the registry.
 */
const fs = require('fs');
const crypto = require('crypto');
const { Pool } = require('pg');
const { REGISTRY_FILE, PG_CONNECTION_STRING } = require('../shared/config');

function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ── helpers ────────────────────────────────────────────────────────────────

function _rowToRecord(row) {
  return {
    hash:          row.hash,
    size:          row.size !== null ? Number(row.size) : null,
    mtime:         row.mtime !== null ? Number(row.mtime) : null,
    chunkCount:    row.chunk_count,
    lastIndexedAt: Number(row.last_indexed_at),
  };
}

// ── DocRegistry ────────────────────────────────────────────────────────────

class DocRegistry {
  /**
   * @param {object} [opts]
   * @param {string} [opts.filePath]          — fallback JSON path (default: REGISTRY_FILE)
   * @param {string} [opts.connectionString]  — Postgres DSN (default: PG_CONNECTION_STRING)
   */
  constructor(opts = {}) {
    this.filePath = opts.filePath || REGISTRY_FILE;
    this._connectionString = opts.connectionString || PG_CONNECTION_STRING;
    this._pool = null;
    this._disabled = false;   // true when PG is unreachable → fall back to JSON

    // In-memory cache used by the fallback path and diff()
    this.docs = {};
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /**
   * Connect to Postgres and ensure the table exists.
   * Falls back to the legacy JSON file on any error.
   * Safe to call multiple times (idempotent).
   */
  async init() {
    if (this._pool) return;   // already initialised
    try {
      this._pool = new Pool({ connectionString: this._connectionString });
      const client = await this._pool.connect();
      try {
        await client.query(`
          CREATE TABLE IF NOT EXISTS doc_registry (
            doc_id          TEXT PRIMARY KEY,
            hash            TEXT NOT NULL,
            size            BIGINT,
            mtime           BIGINT,
            chunk_count     INTEGER NOT NULL DEFAULT 0,
            last_indexed_at BIGINT NOT NULL,
            created_at      TIMESTAMP DEFAULT NOW(),
            updated_at      TIMESTAMP DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_doc_registry_doc_id ON doc_registry(doc_id)
        `);
      } finally {
        client.release();
      }
      // Warm the in-memory cache from PG
      this.docs = await this._loadAll();
    } catch (err) {
      console.warn('DocRegistry: Postgres unavailable, falling back to JSON file:', err.message);
      this._disabled = true;
      this._pool = null;
      this.docs = this._loadJson();
    }
  }

  async close() {
    if (this._pool) {
      try { await this._pool.end(); } catch (_) {}
      this._pool = null;
    }
  }

  // ── public API (async, mirrors the old sync API) ───────────────────────

  async get(docId) {
    if (this._disabled) return this.docs[docId];
    try {
      const { rows } = await this._pool.query(
        'SELECT * FROM doc_registry WHERE doc_id = $1',
        [docId]
      );
      return rows.length ? _rowToRecord(rows[0]) : undefined;
    } catch (err) {
      console.warn('DocRegistry.get error:', err.message);
      return this.docs[docId];
    }
  }

  async set(docId, record) {
    this.docs[docId] = record;   // keep cache consistent
    if (this._disabled) { this._saveJson(); return; }
    try {
      await this._pool.query(
        `INSERT INTO doc_registry (doc_id, hash, size, mtime, chunk_count, last_indexed_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (doc_id) DO UPDATE SET
           hash            = EXCLUDED.hash,
           size            = EXCLUDED.size,
           mtime           = EXCLUDED.mtime,
           chunk_count     = EXCLUDED.chunk_count,
           last_indexed_at = EXCLUDED.last_indexed_at,
           updated_at      = NOW()`,
        [docId, record.hash, record.size ?? null, record.mtime ?? null, record.chunkCount ?? 0, record.lastIndexedAt ?? Date.now()]
      );
    } catch (err) {
      console.warn('DocRegistry.set error:', err.message);
      this._saveJson();
    }
  }

  async remove(docId) {
    delete this.docs[docId];
    if (this._disabled) { this._saveJson(); return; }
    try {
      await this._pool.query('DELETE FROM doc_registry WHERE doc_id = $1', [docId]);
    } catch (err) {
      console.warn('DocRegistry.remove error:', err.message);
      this._saveJson();
    }
  }

  /**
   * Replace the entire registry with `records` (docId → record).
   * Used after a full rebuild so the registry reflects exactly what is now in the store.
   */
  async replaceAll(records) {
    this.docs = { ...records };
    if (this._disabled) { this._saveJson(); return; }
    const client = await this._pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM doc_registry');
      for (const [docId, record] of Object.entries(records)) {
        await client.query(
          `INSERT INTO doc_registry (doc_id, hash, size, mtime, chunk_count, last_indexed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [docId, record.hash, record.size ?? null, record.mtime ?? null, record.chunkCount, record.lastIndexedAt]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.warn('DocRegistry.replaceAll error:', err.message);
      this._saveJson();
    } finally {
      client.release();
    }
  }

  allIds() { return Object.keys(this.docs); }

  /**
   * Classify loaded documents against the registry by content hash.
   * Mutates each loaded doc with `_hash` so callers don't re-hash.
   * Returns { added, changed, unchanged, removed }.
   *
   * Uses the in-memory cache (kept in sync by set/remove/replaceAll).
   */
  diff(loadedDocs) {
    const incoming = new Set(loadedDocs.map(d => d.id));
    const added = [], changed = [], unchanged = [];
    for (const doc of loadedDocs) {
      doc._hash = hashContent(doc.content);
      const prev = this.docs[doc.id];
      if (!prev) added.push(doc);
      else if (prev.hash !== doc._hash) changed.push(doc);
      else unchanged.push(doc);
    }
    const removed = Object.keys(this.docs).filter(id => !incoming.has(id));
    return { added, changed, unchanged, removed };
  }

  // ── private helpers ────────────────────────────────────────────────────

  async _loadAll() {
    const { rows } = await this._pool.query('SELECT * FROM doc_registry');
    const out = {};
    for (const row of rows) out[row.doc_id] = _rowToRecord(row);
    return out;
  }

  _loadJson() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (_) {}
    }
    return {};
  }

  _saveJson() {
    try { fs.writeFileSync(this.filePath, JSON.stringify(this.docs, null, 2)); } catch (_) {}
  }
}

module.exports = { DocRegistry, hashContent };
