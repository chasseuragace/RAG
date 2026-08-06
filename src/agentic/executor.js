const { serverEvents } = require('../shared/events');
const { HeuristicQueryRewriter, LLMQueryRewriter } = require('./query-rewriter');

class RetrievalExecutor {
  constructor(embedder, hybridStore, reranker, queryRewriter, unifiedPipeline = null) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    this.queryRewriter = queryRewriter || new HeuristicQueryRewriter();
    this.unifiedPipeline = unifiedPipeline;
  }

  async execute(action, observation) {
    // Decision objects use .action; plain action objects use .type — support both.
    const actionType = action.action || action.type;
    serverEvents.logEvent('agentic:plan', { action: actionType, reason: action.rationale || action.reason, iteration: observation.iteration });

    switch (actionType) {
      case 'search':
        return this._search(observation, observation.topK, 'initial_search');

      case 'increase_topk':
        return this._search(observation, observation.topK * 2, 'increase_topk');

      case 'rewrite_query': {
        const expandedQuery = await this.queryRewriter.rewrite(observation.query, observation, action.rationale || action.reason, action.evidence);
        const newObs = observation.withAction({ type: 'rewrite_query', expandedQuery, reason: action.rationale || action.reason });
        return this._search(newObs, newObs.topK, 'rewrite_query', expandedQuery);
      }

      case 'answer':
        return observation.withAction(action);

      case 'stop':
        return observation.withAction(action);

      default:
        serverEvents.logEvent('error', { stage: 'agentic:executor', message: `Unknown action: ${actionType}` });
        return observation.withAction({ ...action, error: 'unknown_action' });
    }
  }

  async _search(observation, topK, actionType, queryOverride = null) {
    const query = queryOverride || observation.query;
    const start = Date.now();
    let reranked;
    let enrichment = null;
    if (this.unifiedPipeline) {
      const fused = await this.unifiedPipeline.retrieve(query, { topK: topK * 4 });
      const pool = fused.candidates || [];
      reranked = this.reranker && pool.length > 0
        ? await this.reranker.rerank(query, pool)
        : pool;
      enrichment = {
        expandedQuery: fused.expandedQuery || query,
        entities:      fused.entities      || {},
        graphFacts:    fused.graphFacts    || [],
      };
      serverEvents.logEvent('agentic:search', { query, topK, resultCount: reranked.length, duration: Date.now() - start, actionType, mode: 'unified' });
    } else {
      const qEmb = await this.embedder.embed(query);
      const candidates = await this.hybridStore.search(qEmb, query, topK);
      reranked = this.reranker ? await this.reranker.rerank(query, candidates) : candidates;
      serverEvents.logEvent('agentic:search', { query, topK, resultCount: reranked.length, duration: Date.now() - start, actionType });
    }
    let newObs = observation.withResults(reranked);
    if (enrichment) newObs = newObs.withEnrichment(enrichment);
    return newObs.withAction({ type: actionType, query, resultCount: reranked.length, duration: Date.now() - start });
  }
}

module.exports = { RetrievalExecutor };
