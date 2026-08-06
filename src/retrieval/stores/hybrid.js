const { VectorStore } = require('../../shared/interfaces');
const { serverEvents } = require('../../shared/events');

class HybridStore extends VectorStore {
  constructor(vectorStore, bm25Store, rrfK = 60, fusionMultiple = 3) {
    super();
    this.vectorStore = vectorStore;
    this.bm25Store = bm25Store;
    this.rrfK = rrfK;
    this.fusionMultiple = fusionMultiple;
  }

  async store(id, embedding, metadata) {
    await this.vectorStore.store(id, embedding, metadata);
    await this.bm25Store.index(id, metadata.content || '', metadata);
    serverEvents.logEvent('hybrid:stored', { id });
  }

  async query(queryEmbedding, topK, queryText = '') {
    return this.search(queryEmbedding, queryText, topK);
  }

  async search(queryEmbedding, queryText, topK = 5) {
    const start = Date.now();
    const vResults = await this.vectorStore.query(queryEmbedding, topK * this.fusionMultiple);
    const bResults = await this.bm25Store.search(queryText, topK * this.fusionMultiple);
    const results = this._rrfFusion(vResults, bResults, topK);
    serverEvents.logEvent('hybrid:search', { vectorCount: vResults.length, bm25Count: bResults.length, fusedCount: results.length, duration: Date.now() - start });
    return results;
  }

  _rrfFusion(vectorResults, bm25Results, topK) {
    const scores = new Map();
    const docs = new Map();
    const k = this.rrfK;
    vectorResults.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i + 1));
      docs.set(r.id, r);
    });
    bm25Results.forEach((r, i) => {
      scores.set(r.id, (scores.get(r.id) || 0) + 1 / (k + i + 1));
      if (!docs.has(r.id)) docs.set(r.id, r);
    });
    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, topK)
      .map(([id, rrfScore], rank) => ({ ...docs.get(id), score: rrfScore, rrfRank: rank + 1 }));
  }

  async clear() {
    await this.vectorStore.clear();
    await this.bm25Store.clear();
    serverEvents.logEvent('hybrid:cleared', {});
  }

  async deleteByDocId(docId) {
    await this.vectorStore.deleteByDocId(docId);
    await this.bm25Store.deleteByDocId(docId);
    serverEvents.logEvent('hybrid:deleted', { docId });
  }

  async getStats() {
    const vs = await this.vectorStore.getStats();
    const bm25Stats = await this.bm25Store.getStats();
    return { ...vs, bm25Documents: bm25Stats.totalDocuments };
  }
}

module.exports = { HybridStore };
