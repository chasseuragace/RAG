const { InjectionPipeline } = require('../core/interfaces');
const { chunkText } = require('../core/chunker');
const { CHUNK_SIZE, CHUNK_OVERLAP } = require('../config');
const { serverEvents } = require('../events');

class ConcreteInjectionPipeline extends InjectionPipeline {
  // Full rebuild: clear the store, then chunk/embed/store every document.
  // Kept as an escape hatch; prefer runIncremental() for routine syncs.
  async run(folderPath) {
    const start = Date.now();
    serverEvents.logEvent('injection:start', { folderPath });
    try {
      // 1. Clear existing vectors
      await this.store.clear();
      serverEvents.logEvent('injection:cleared', {});

      // 2. Load raw documents (whole files)
      const docs = await this.loader.loadDocuments(folderPath);
      if (!docs.length) throw new Error('No documents found');
      serverEvents.logEvent('injection:documents-loaded', { count: docs.length });

      // 3. Chunk each document
      const chunks = [];
      for (const doc of docs) {
        const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
        for (let i = 0; i < textChunks.length; i++) {
          chunks.push({
            id: `${doc.id}_chunk_${i}`,
            content: textChunks[i],
            metadata: {
              ...doc.metadata,
              chunk_index: i,
              total_chunks: textChunks.length,
              original_id: doc.id
            }
          });
        }
      }
      serverEvents.logEvent('injection:chunks-created', { totalChunks: chunks.length });

      // 4. Embed all chunks
      const texts = chunks.map(c => c.content);
      const embeddings = await this.embedder.embedBatch(texts);
      serverEvents.logEvent('injection:embeddings-generated', { count: embeddings.length });

      // 5. Store each chunk
      for (let i = 0; i < chunks.length; i++) {
        await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
        serverEvents.logEvent('injection:document-stored', { id: chunks[i].id, progress: `${i+1}/${chunks.length}` });
      }

      const duration = Date.now() - start;
      serverEvents.logEvent('injection:complete', { documentsProcessed: docs.length, chunksStored: chunks.length, duration });
      return { success: true, documentsProcessed: docs.length, chunksStored: chunks.length, duration: `${duration}ms` };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'injection', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }

  // Chunk + embed + store a single document. Caller is responsible for
  // deleting any previous chunks of this doc first (see runIncremental).
  async _indexDoc(doc) {
    const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
    const chunks = textChunks.map((content, i) => ({
      id: `${doc.id}_chunk_${i}`,
      content,
      metadata: { ...doc.metadata, chunk_index: i, total_chunks: textChunks.length, original_id: doc.id }
    }));
    const embeddings = await this.embedder.embedBatch(chunks.map(c => c.content));
    for (let i = 0; i < chunks.length; i++) {
      await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
    }
    return chunks.length;
  }

  // Differential sync: only re-embed added/changed docs, delete removed docs.
  // Never clears the whole store, so retrieval stays available throughout.
  async runIncremental(folderPath, registry) {
    const start = Date.now();
    serverEvents.logEvent('injection:start', { folderPath, mode: 'incremental' });
    try {
      const docs = await this.loader.loadDocuments(folderPath);
      const { added, changed, unchanged, removed } = registry.diff(docs);
      serverEvents.logEvent('injection:diff', {
        added: added.length, changed: changed.length, unchanged: unchanged.length, removed: removed.length
      });

      // 1. Deletions: drop chunks for files no longer present.
      for (const docId of removed) {
        await this.store.deleteByDocId(docId);
        registry.remove(docId);
      }

      // 2. Additions + changes: re-index only the delta.
      //    For changed docs, delete old chunks FIRST so that when a file
      //    shrinks (fewer chunks than before) no orphan chunks survive.
      const changedIds = new Set(changed.map(d => d.id));
      let chunksStored = 0;
      for (const doc of [...added, ...changed]) {
        if (changedIds.has(doc.id)) await this.store.deleteByDocId(doc.id);
        const n = await this._indexDoc(doc);
        registry.set(doc.id, {
          hash: doc._hash,
          size: doc.metadata.size,
          mtime: doc.metadata.mtime,
          chunkCount: n,
          lastIndexedAt: Date.now()
        });
        chunksStored += n;
      }

      const duration = Date.now() - start;
      const result = {
        success: true, mode: 'incremental',
        added: added.length, changed: changed.length,
        unchanged: unchanged.length, removed: removed.length,
        chunksStored, duration: `${duration}ms`
      };
      serverEvents.logEvent('injection:complete', result);
      return result;
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'injection-incremental', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

module.exports = { ConcreteInjectionPipeline };
