const { InjectionPipeline } = require('../shared/interfaces');
const { chunkText } = require('../shared/chunker');
const { hashContent } = require('../ingestion/registry');
const { CHUNK_SIZE, CHUNK_OVERLAP } = require('../shared/config');
const { serverEvents } = require('../shared/events');

// NER enrichment is opt-in: pass an EntityExtractor instance to the pipeline
// constructor. When absent the pipeline behaves identically to before.

class ConcreteInjectionPipeline extends InjectionPipeline {
  /**
   * @param {DocumentLoader}        loader
   * @param {Embedder}              embedder
   * @param {VectorStore}           store
   * @param {EntityExtractor}       [ner]          — tags chunk metadata with entities
   * @param {RelationshipExtractor} [relExtractor] — extracts triples for the graph store
   * @param {GraphStore}            [graphStore]   — receives extracted triples
   * @param {ProvenanceAnnotator}   [annotator]    — attaches authority_signal to chunk metadata
   */
  constructor(loader, embedder, store, ner = null, relExtractor = null, graphStore = null, annotator = null) {
    super(loader, embedder, store);
    this.ner          = ner;
    this.relExtractor = relExtractor;
    this.graphStore   = graphStore;
    this.annotator    = annotator;
  }

  // Full rebuild: clear the store, then chunk/embed/store every document.
  // Kept as an escape hatch; prefer runIncremental() for routine syncs.
  // When a `registry` is passed it is rebuilt to mirror exactly what was just
  // embedded, so a subsequent incremental run sees everything as unchanged
  // (instead of re-embedding the whole corpus a second time).
   async run(folderPath, registry = null, abortSignal = null) {
     const start = Date.now();
     serverEvents.logEvent('injection:start', { folderPath });
     try {
       if (abortSignal) abortSignal.throwIfAborted();
      // 1. Clear existing vectors
      await this.store.clear();
      serverEvents.logEvent('injection:cleared', {});

      // 1b. Clear existing graph triples on full rebuild
      if (this.graphStore) {
        await this.graphStore.clear();
        serverEvents.logEvent('injection:graph-cleared', {});
      }

      // 2. Load raw documents (whole files)
      const docs = await this.loader.loadDocuments(folderPath);
      if (!docs.length) throw new Error('No documents found');
      serverEvents.logEvent('injection:documents-loaded', { count: docs.length });

      // 3. Chunk each document (tracking per-doc info for the registry)
      const chunks = [];
      const registryRecords = {};
      for (const doc of docs) {
        const textChunks = chunkText(doc.content, CHUNK_SIZE, CHUNK_OVERLAP);
        // Authority annotation: compute once per doc, stamp on every chunk.
        const authoritySignal = this.annotator ? this.annotator.annotate(doc.metadata) : null;
        for (let i = 0; i < textChunks.length; i++) {
          const chunkMeta = {
            ...doc.metadata,
            chunk_index:  i,
            total_chunks: textChunks.length,
            original_id:  doc.id,
          };
          if (authoritySignal) chunkMeta.authority_signal = authoritySignal;
          chunks.push({ id: `${doc.id}_chunk_${i}`, content: textChunks[i], metadata: chunkMeta });
        }
        registryRecords[doc.id] = {
          hash:          hashContent(doc.content),
          size:          doc.metadata.size,
          mtime:         doc.metadata.mtime,
          chunkCount:    textChunks.length,
          lastIndexedAt: Date.now()
        };
      }
      serverEvents.logEvent('injection:chunks-created', { totalChunks: chunks.length });

      // 3b. NER tagging — run entity extraction on each chunk and attach to metadata.
      //     Skipped when no extractor is configured (graceful degradation).
      if (this.ner) {
        await this._tagChunksWithEntities(chunks);
        serverEvents.logEvent('injection:ner-tagged', { totalChunks: chunks.length });
      }

      // 3c. Relationship extraction → graph store triples.
      //     Skipped when either relExtractor or graphStore is absent.
      if (this.relExtractor && this.graphStore) {
        const tripleCount = await this._extractAndStoreTriples(chunks);
        serverEvents.logEvent('injection:graph-triples', { tripleCount });
      }

      // 4. Embed all chunks
      const texts = chunks.map(c => c.content);
      const embeddings = await this.embedder.embedBatch(texts);
      serverEvents.logEvent('injection:embeddings-generated', { count: embeddings.length });

      // 5. Store each chunk
      for (let i = 0; i < chunks.length; i++) {
        await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
        serverEvents.logEvent('injection:document-stored', { id: chunks[i].id, progress: `${i+1}/${chunks.length}` });
      }

      // 6. Rebuild the registry to match the freshly-embedded corpus.
      if (registry) await registry.replaceAll(registryRecords);

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
    const authoritySignal = this.annotator ? this.annotator.annotate(doc.metadata) : null;
    const chunks = textChunks.map((content, i) => {
      const meta = { ...doc.metadata, chunk_index: i, total_chunks: textChunks.length, original_id: doc.id };
      if (authoritySignal) meta.authority_signal = authoritySignal;
      return { id: `${doc.id}_chunk_${i}`, content, metadata: meta };
    });

    // NER tagging (opt-in)
    if (this.ner) {
      await this._tagChunksWithEntities(chunks);
    }

    // Relationship extraction → graph store (opt-in)
    // Uses atomic replaceTriplesForDoc so old triples are deleted and new ones
    // inserted in a single Neo4j transaction. If anything fails, the graph is
    // left unchanged (no orphaned partial state).
    if (this.relExtractor && this.graphStore) {
      const triples = [];
      for (const chunk of chunks) {
        try {
          const extracted = await this.relExtractor.extract(chunk.content, chunk.id);
          for (const t of extracted) {
            t.documentId = doc.id;
            triples.push(t);
          }
        } catch (err) {
          serverEvents.logEvent('injection:graph-error', { chunkId: chunk.id, error: err.message });
        }
      }
      if (triples.length > 0) {
        await this.graphStore.replaceTriplesForDoc(doc.id, triples);
        serverEvents.logEvent('injection:graph-triples', { tripleCount: triples.length, docId: doc.id });
      }
    }

    const embeddings = await this.embedder.embedBatch(chunks.map(c => c.content));
    for (let i = 0; i < chunks.length; i++) {
      await this.store.store(chunks[i].id, embeddings[i], { ...chunks[i].metadata, content: chunks[i].content });
    }
    return chunks.length;
  }

  /**
   * In-place: runs NER on each chunk's content and adds an `entities` field
   * to its metadata.
   *
   * chunk.metadata.entities = { DRUG: ['azt'], DISEASE: ['hiv'], ... }
   *
   * @param {{ id: string, content: string, metadata: object }[]} chunks
   */
  async _tagChunksWithEntities(chunks) {
    await Promise.all(chunks.map(async (chunk) => {
      try {
        const entities = await this.ner.extract(chunk.content);
        chunk.metadata.entities = entities;
      } catch (err) {
        // Soft failure: NER error should not block ingestion.
        serverEvents.logEvent('injection:ner-error', { chunkId: chunk.id, error: err.message });
        chunk.metadata.entities = {};
      }
    }));
  }

  /**
   * Runs relationship extraction on each chunk and stores resulting triples
   * in the graph store.  Returns the total number of triples stored.
   *
   * Soft failure per chunk: one bad chunk never blocks the rest.
   *
   * @param {{ id: string, content: string, metadata: object }[]} chunks
   * @returns {Promise<number>}
   * @deprecated Replaced by inline atomic graph logic in _indexDoc.
   */
  async _extractAndStoreTriples(chunks) {
    let total = 0;
    await Promise.all(chunks.map(async (chunk) => {
      try {
        const triples = await this.relExtractor.extract(chunk.content, chunk.id);
        if (triples.length > 0) {
          await this.graphStore.storeTriples(triples);
          total += triples.length;
        }
      } catch (err) {
        serverEvents.logEvent('injection:graph-error', { chunkId: chunk.id, error: err.message });
      }
    }));
    return total;
  }

  // Differential sync: only re-embed added/changed docs, delete removed docs.
  // Never clears the whole store, so retrieval stays available throughout.
   async runIncremental(folderPath, registry, abortSignal = null) {
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
        if (this.graphStore) {
          await this.graphStore.deleteByDocId(docId);
        }
        await registry.remove(docId);
      }

      // 2. Additions + changes: re-index only the delta.
      //    For changed docs, delete old chunks FIRST so that when a file
      //    shrinks (fewer chunks than before) no orphan chunks survive.
      const changedIds = new Set(changed.map(d => d.id));
      let chunksStored = 0;
      for (const doc of [...added, ...changed]) {
        if (changedIds.has(doc.id)) {
          await this.store.deleteByDocId(doc.id);
          if (this.graphStore) {
            await this.graphStore.deleteByDocId(doc.id);
          }
        }
        const n = await this._indexDoc(doc);
        await registry.set(doc.id, {
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
