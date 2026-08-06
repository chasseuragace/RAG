CREATE TABLE IF NOT EXISTS doc_registry (
  doc_id         TEXT PRIMARY KEY,
  hash           TEXT NOT NULL,
  size           BIGINT,
  mtime          BIGINT,
  chunk_count    INTEGER NOT NULL DEFAULT 0,
  last_indexed_at BIGINT NOT NULL,
  created_at     TIMESTAMP DEFAULT NOW(),
  updated_at     TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_registry_doc_id ON doc_registry(doc_id);
