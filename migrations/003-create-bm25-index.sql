-- Enable pg_search (ParadeDB BM25 extension).
-- Requires: shared_preload_libraries = 'pg_search' in postgresql.conf
-- (set via -c shared_preload_libraries=pg_search in docker-compose command).
CREATE EXTENSION IF NOT EXISTS pg_search;

-- Chunk keyword table.
CREATE TABLE IF NOT EXISTS bm25_chunks (
  chunk_id   TEXT PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  content    TEXT NOT NULL DEFAULT '',
  metadata   JSONB NOT NULL DEFAULT '{}',
  indexed_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bm25_chunks_doc_id ON bm25_chunks(doc_id);

-- BM25 index using pg_search v0.19.x DDL.
-- Creates a Tantivy index over the content column with the default tokenizer.
CREATE INDEX IF NOT EXISTS bm25_chunks_search
ON bm25_chunks
USING bm25 (chunk_id, content)
WITH (
  key_field   = 'chunk_id',
  text_fields = '{"content": {"tokenizer": {"type": "default"}}}'
);
