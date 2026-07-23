const { RetrievalPipeline } = require('../core/interfaces');
const { serverEvents } = require('../events');

class ConcreteRetrievalPipeline extends RetrievalPipeline {
  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('retrieval:start', { query, topK });
    try {
      const qEmb = await this.embedder.embed(query);
      serverEvents.logEvent('retrieval:query-embedded', { queryLength: query.length });
      const results = await this.store.query(qEmb, topK);
      const duration = Date.now() - start;
      serverEvents.logEvent('retrieval:complete', { resultsCount: results.length, duration });
      return {
        success: true,
        query,
        resultsCount: results.length,
        duration: `${duration}ms`,
        results: results.map(r => ({ id: r.id, relevance: (r.score*100).toFixed(2)+'%', metadata: r.metadata }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'retrieval', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now()-start}ms` };
    }
  }
}

class HybridRetrievalPipeline {
  constructor(embedder, hybridStore) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
  }
  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('retrieval:start', { query, topK, mode: 'hybrid' });
    try {
      const qEmb = await this.embedder.embed(query);
      serverEvents.logEvent('retrieval:query-embedded', { queryLength: query.length });
      const results = await this.hybridStore.search(qEmb, query, topK);
      const duration = Date.now() - start;
      serverEvents.logEvent('retrieval:complete', { resultsCount: results.length, duration, mode: 'hybrid' });
      return {
        success: true,
        query,
        resultsCount: results.length,
        duration: `${duration}ms`,
        results: results.map(r => ({ id: r.id, relevance: (r.score*100).toFixed(2)+'%', metadata: r.metadata, rrfRank: r.rrfRank }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'retrieval', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now()-start}ms` };
    }
  }
}

module.exports = { ConcreteRetrievalPipeline, HybridRetrievalPipeline };
