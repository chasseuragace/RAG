/**
 * Abstract base classes defining the seams of the system. Concrete mock and
 * real implementations live under loaders/, embedders/, stores/, pipelines/.
 */
class DocumentLoader { async loadDocuments(folderPath) { throw new Error('not implemented'); } }
class Embedder { async embed(text) { throw new Error('not implemented'); } async embedBatch(texts) { throw new Error('not implemented'); } }
class VectorStore { async store(id, embedding, metadata) { throw new Error('not implemented'); } async query(queryEmbedding, topK, queryText = '') { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }
class InjectionPipeline { constructor(loader, embedder, store) { this.loader = loader; this.embedder = embedder; this.store = store; } async run(folderPath) { throw new Error('not implemented'); } }
class RetrievalPipeline { constructor(embedder, store) { this.embedder = embedder; this.store = store; } async run(query, topK) { throw new Error('not implemented'); } }
class Reranker { async rerank(query, documents) { throw new Error('not implemented'); } }
class KeywordStore { async index(id, content, metadata) { throw new Error('not implemented'); } async search(query, topK) { throw new Error('not implemented'); } async clear() { throw new Error('not implemented'); } async deleteByDocId(docId) { throw new Error('not implemented'); } async getStats() { throw new Error('not implemented'); } }

class Planner { async decide(observation) { throw new Error('not implemented'); } }
class Executor { async execute(action, observation) { throw new Error('not implemented'); } }
class Judge { async evaluate(observation) { throw new Error('not implemented'); } }
class RetrievalStrategy {
  constructor(planner, executor, judge) { this.planner = planner; this.executor = executor; this.judge = judge; }
  async run(observation, maxIterations) {
    let obs = observation;
    for (let i = 0; i < maxIterations; i++) {
      const action = await this.planner.decide(obs);
      if (action.type === 'answer' || action.type === 'stop') return { ...obs, finalAction: action };
      obs = await this.executor.execute(action, obs);
      const judgment = await this.judge.evaluate(obs);
      obs = { ...obs, judgment, retrievalQuality: judgment.quality, missingEvidence: judgment.missing };
      if (judgment.sufficient) return { ...obs, finalAction: { type: 'answer', reason: judgment.reason } };
    }
    return { ...obs, finalAction: { type: 'stop', reason: 'max_iterations_reached' } };
  }
}

module.exports = { DocumentLoader, Embedder, VectorStore, InjectionPipeline, RetrievalPipeline, Reranker, KeywordStore, Planner, Executor, Judge, RetrievalStrategy };
