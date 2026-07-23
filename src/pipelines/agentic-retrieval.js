const { RetrievalPipeline } = require('../core/interfaces');
const { Observation } = require('../agentic/observation');
const { HeuristicRetrievalStrategy } = require('../agentic/strategies/heuristic');
const { serverEvents } = require('../events');

class AgenticRetrievalPipeline extends RetrievalPipeline {
  constructor(embedder, hybridStore, reranker, strategy, maxSteps = 2) {
    super(embedder, hybridStore);
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    this.strategy = strategy || new HeuristicRetrievalStrategy(embedder, hybridStore, reranker);
    this.maxSteps = maxSteps;
  }

  async run(query, topK = 5) {
    const start = Date.now();
    serverEvents.logEvent('agentic:start', { query, maxSteps: this.maxSteps });
    try {
      const observation = Observation.create(query, topK);
      const result = await this.strategy.run(observation, this.maxSteps);
      const final = result.rerankedResults.slice(0, topK);
      const duration = Date.now() - start;
      serverEvents.logEvent('agentic:complete', {
        steps: result.previousActions.filter(a => a.type === 'search' || a.type === 'increase_topk' || a.type === 'rewrite_query').length,
        finalCount: final.length,
        duration,
        finalAction: result.finalAction
      });
      return {
        success: true,
        query,
        resultsCount: final.length,
        duration: `${duration}ms`,
        retrievalQuality: result.retrievalQuality,
        missingEvidence: result.missingEvidence,
        finalAction: result.finalAction,
        steps: result.previousActions,
        results: final.map(r => ({ id: r.id, relevance: (r.score * 100).toFixed(2) + '%', metadata: r.metadata, rerankReason: r.rerankReason }))
      };
    } catch (err) {
      serverEvents.logEvent('error', { stage: 'agentic', message: err.message });
      return { success: false, error: err.message, duration: `${Date.now() - start}ms` };
    }
  }
}

module.exports = { AgenticRetrievalPipeline };
