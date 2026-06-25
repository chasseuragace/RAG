/**
 * Abstract base classes defining the seams of the system. Concrete mock and
 * real implementations live under loaders/, embedders/, stores/, pipelines/.
 */
class DocumentLoader { async loadDocuments(folderPath) { throw new Error('not implemented'); } }
class Embedder { async embed(text) { throw new Error('not implemented'); } async embedBatch(texts) { throw new Error('not implemented'); } }
class VectorStore { async store(id, embedding, metadata) { throw new Error('not implemented'); } async query(queryEmbedding, topK) { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }
class InjectionPipeline { constructor(loader, embedder, store) { this.loader = loader; this.embedder = embedder; this.store = store; } async run(folderPath) { throw new Error('not implemented'); } }
class RetrievalPipeline { constructor(embedder, store) { this.embedder = embedder; this.store = store; } async run(query, topK) { throw new Error('not implemented'); } }

module.exports = { DocumentLoader, Embedder, VectorStore, InjectionPipeline, RetrievalPipeline };
