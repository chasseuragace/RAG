/**
 * PostgresBM25Store — persistent BM25 keyword store backed by pg_search (ParadeDB).
 *
 * Drop-in replacement for the in-memory BM25Store when corpus size exceeds
 * available RAM.  Implements the same KeywordStore interface so HybridStore
 * and all callers are unaffected.
 *
 * Requires:
 *   - paradedb/paradedb:0.19.11-pg16 Docker image (pg_search pre-installed)
 *   - postgres started with: -c shared_preload_libraries=pg_search
 *   - CREATE EXTENSION pg_search; (done automatically in init())
 *
 * pg_search API used (v0.19.x):
 *   - CREATE INDEX ... USING bm25 (key, content) WITH (key_field=..., text_fields=...)
 *   - key @@@ paradedb.parse('content:"term1" content:"term2"')
 *   - paradedb.score(key) → BM25 relevance score
 *   - paradedb.term('content', value) → exact post-tokenization term match
 *   - paradedb.match('content', query) → tokenized match (handles multi-word)
 *
 * Graceful degradation: if Postgres/pg_search is unavailable on init(), the
 * store disables itself and all operations become no-ops returning empty results.
 */
const { Pool } = require('pg');
const { KeywordStore } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');
const { PG_CONNECTION_STRING } = require('../../shared/config');

class PostgresBM25Store extends KeywordStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.connectionString]  Postgres DSN (default: PG_CONNECTION_STRING)
   */
  constructor(opts = {}) {
    super();
    this._connectionString = opts.connectionString || PG_CONNECTION_STRING;
    this._pool = null;
    this._disabled = false;
    this._totalDocs = 0;  // in-memory counter for cheap getStats()
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async init() {
    if (this._pool) return;
    try {
      this._pool = new Pool({ connectionString: this._connectionString });
      const client = await this._pool.connect();
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS pg_search`);

        // Chunk table — content column is what pg_search indexes
        await client.query(`
          CREATE TABLE IF NOT EXISTS bm25_chunks (
            chunk_id   TEXT PRIMARY KEY,
            doc_id     TEXT NOT NULL,
            content    TEXT NOT NULL DEFAULT '',
            metadata   JSONB NOT NULL DEFAULT '{}',
            indexed_at TIMESTAMP DEFAULT NOW()
          )
        `);
        await client.query(`
          CREATE INDEX IF NOT EXISTS idx_bm25_chunks_doc_id ON bm25_chunks(doc_id)
        `);

        // BM25 index using pg_search v0.19.x DDL.
        // The index is identified by its name; IF NOT EXISTS avoids duplicate errors.
        await client.query(`
          CREATE INDEX IF NOT EXISTS bm25_chunks_search
          ON bm25_chunks
          USING bm25 (chunk_id, content)
          WITH (
            key_field = 'chunk_id',
            text_fields = '{"content": {"tokenizer": {"type": "default"}}}'
          )
        `);

        const { rows } = await client.query(
          `SELECT COUNT(DISTINCT doc_id) AS n FROM bm25_chunks`
        );
        this._totalDocs = parseInt(rows[0].n, 10) || 0;

      } finally {
        client.release();
      }

      serverEvents.logEvent('bm25:postgres:ready', { totalDocs: this._totalDocs });
    } catch (err) {
      console.warn('PostgresBM25Store: init failed, disabling BM25:', err.message);
      this._disabled = true;
      this._pool = null;
    }
  }

  async close() {
    if (this._pool) {
      try { await this._pool.end(); } catch (_) {}
      this._pool = null;
    }
  }

  // ── KeywordStore interface ────────────────────────────────────────────────

  /**
   * Index a single chunk. Upserts so re-ingestion is safe.
   */
  async index(id, content, metadata = {}) {
    if (this._disabled) return;
    const docId = (metadata && metadata.original_id) || id;
    const start = Date.now();
    try {
      await this._pool.query(
        `INSERT INTO bm25_chunks (chunk_id, doc_id, content, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chunk_id) DO UPDATE SET
           doc_id     = EXCLUDED.doc_id,
           content    = EXCLUDED.content,
           metadata   = EXCLUDED.metadata,
           indexed_at = NOW()`,
        [id, docId, content || '', JSON.stringify(metadata)]
      );
      this._totalDocs = await this._countDistinctDocs();
      serverEvents.logEvent('bm25:indexed', { id, duration: Date.now() - start });
    } catch (err) {
      serverEvents.logEvent('bm25:error', { stage: 'index', id, message: err.message });
    }
  }

  /**
   * BM25 keyword search using pg_search's @@@ operator.
   *
   * Tokenizes the query into individual terms and ORs them together using
   * paradedb.match(), which applies the same tokenizer as the index.
   * Falls back to empty results on any error.
   */
  async search(query, topK = 10) {
    if (this._disabled || !query || !query.trim()) return [];
    const start = Date.now();
    try {
      // Tokenize query client-side: split on whitespace, strip punctuation,
      // keep terms > 2 chars (mirrors BM25Store._tokenize).
      const terms = query.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(t => t.length > 2);

      if (terms.length === 0) return [];

      // Build a paradedb.boolean OR across all terms using paradedb.match.
      // paradedb.match applies the index's tokenizer, so "learning" matches
      // the token "learning" from "deep learning".
      const placeholders = terms.map((_, i) => `paradedb.match('content', $${i + 2})`);
      const boolExpr = placeholders.length === 1
        ? placeholders[0]
        : `paradedb.boolean(should => ARRAY[${placeholders.join(', ')}])`;

      const { rows } = await this._pool.query(
        `SELECT chunk_id AS id,
                paradedb.score(chunk_id) AS score,
                metadata
         FROM   bm25_chunks
         WHERE  chunk_id @@@ ${boolExpr}
         ORDER  BY score DESC
         LIMIT  $1`,
        [topK, ...terms]
      );

      const results = rows.map(r => ({
        id:       r.id,
        score:    parseFloat(r.score),
        metadata: typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata,
      }));

      serverEvents.logEvent('bm25:search', {
        query, resultsCount: results.length, duration: Date.now() - start
      });
      return results;
    } catch (err) {
      serverEvents.logEvent('bm25:error', { stage: 'search', message: err.message });
      return [];
    }
  }

  /**
   * Remove all chunks belonging to a document.
   */
  async deleteByDocId(docId) {
    if (this._disabled) return 0;
    try {
      const { rowCount } = await this._pool.query(
        `DELETE FROM bm25_chunks WHERE doc_id = $1`,
        [docId]
      );
      this._totalDocs = await this._countDistinctDocs();
      serverEvents.logEvent('bm25:deleted', { docId, removed: rowCount });
      return rowCount;
    } catch (err) {
      serverEvents.logEvent('bm25:error', { stage: 'deleteByDocId', docId, message: err.message });
      return 0;
    }
  }

  async clear() {
    if (this._disabled) return;
    try {
      await this._pool.query(`TRUNCATE bm25_chunks`);
      this._totalDocs = 0;
      serverEvents.logEvent('bm25:cleared', {});
    } catch (err) {
      serverEvents.logEvent('bm25:error', { stage: 'clear', message: err.message });
    }
  }

  async getStats() {
    if (this._disabled) return { totalDocuments: 0, avgDocLength: 'n/a', backend: 'disabled' };
    try {
      const [countRow, avgRow] = await Promise.all([
        this._pool.query(`SELECT COUNT(DISTINCT doc_id) AS n FROM bm25_chunks`),
        this._pool.query(`SELECT ROUND(AVG(LENGTH(content))::numeric, 1) AS avg FROM bm25_chunks`),
      ]);
      this._totalDocs = parseInt(countRow.rows[0].n, 10) || 0;
      return {
        totalDocuments: this._totalDocs,
        avgDocLength:   avgRow.rows[0].avg || '0',
        backend:        'postgres-pg_search',
      };
    } catch (_) {
      return { totalDocuments: this._totalDocs, avgDocLength: 'n/a', backend: 'postgres-pg_search' };
    }
  }

  // ── private ───────────────────────────────────────────────────────────────

  async _countDistinctDocs() {
    try {
      const { rows } = await this._pool.query(
        `SELECT COUNT(DISTINCT doc_id) AS n FROM bm25_chunks`
      );
      return parseInt(rows[0].n, 10) || 0;
    } catch (_) {
      return this._totalDocs;
    }
  }
}

module.exports = { PostgresBM25Store };
