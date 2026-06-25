/**
 * DocRegistry — source of truth for what is in the vector store.
 *
 * JSON-file backed map: docId -> { hash, size, mtime, chunkCount, lastIndexedAt }
 * Used by the incremental injection pipeline to diff incoming files against
 * what has already been embedded, so only the delta is re-embedded.
 */
const fs = require('fs');
const crypto = require('crypto');
const { REGISTRY_FILE } = require('../config');

function hashContent(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

class DocRegistry {
  constructor(filePath = REGISTRY_FILE) {
    this.filePath = filePath;
    this.docs = this._load();
  }
  _load() {
    if (fs.existsSync(this.filePath)) {
      try { return JSON.parse(fs.readFileSync(this.filePath, 'utf8')); } catch (e) { return {}; }
    }
    return {};
  }
  _save() { fs.writeFileSync(this.filePath, JSON.stringify(this.docs, null, 2)); }
  get(docId) { return this.docs[docId]; }
  set(docId, record) { this.docs[docId] = record; this._save(); }
  remove(docId) { delete this.docs[docId]; this._save(); }
  allIds() { return Object.keys(this.docs); }
  /**
   * Classify loaded documents against the registry by content hash.
   * Mutates each loaded doc with `_hash` so callers don't re-hash.
   * Returns { added, changed, unchanged, removed }.
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
}

module.exports = { DocRegistry, hashContent };
