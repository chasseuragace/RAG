const { serverEvents } = require('../events');

class RetrievalExecutor {
  constructor(embedder, hybridStore, reranker) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
  }

  async execute(action, observation) {
    serverEvents.logEvent('agentic:plan', { action: action.type, reason: action.reason, iteration: observation.iteration });

    switch (action.type) {
      case 'search':
        return this._search(observation, observation.topK, 'initial_search');

      case 'increase_topk':
        return this._search(observation, observation.topK * 2, 'increase_topk');

      case 'rewrite_query': {
        const expandedQuery = this._rewriteQuery(observation);
        const newObs = observation.withAction({ type: 'rewrite_query', expandedQuery, reason: action.reason });
        return this._search(newObs, newObs.topK, 'rewrite_query', expandedQuery);
      }

      case 'answer':
        return observation.withAction(action);

      case 'stop':
        return observation.withAction(action);

      default:
        serverEvents.logEvent('error', { stage: 'agentic:executor', message: `Unknown action: ${action.type}` });
        return observation.withAction({ ...action, error: 'unknown_action' });
    }
  }

  async _search(observation, topK, actionType, queryOverride = null) {
    const query = queryOverride || observation.query;
    const start = Date.now();
    const qEmb = await this.embedder.embed(query);
    const candidates = await this.hybridStore.search(qEmb, query, topK);
    const reranked = await this.reranker.rerank(query, candidates);
    const duration = Date.now() - start;
    serverEvents.logEvent('agentic:search', { query, topK, resultCount: reranked.length, duration, actionType });
    const newObs = observation.withResults(reranked);
    return newObs.withAction({ type: actionType, query, resultCount: reranked.length, duration });
  }

  _rewriteQuery(observation) {
    const topWords = observation.rerankedResults.slice(0, 2).flatMap(d =>
      (d.metadata.content || '').toLowerCase().split(/\s+/).filter(w => w.length > 4)
    ).slice(0, 5);
    const expanded = `${observation.originalQuery} ${topWords.join(' ')}`.trim();
    return expanded.length > observation.originalQuery.length ? expanded : observation.originalQuery;
  }
}

module.exports = { RetrievalExecutor };
