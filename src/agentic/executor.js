const { serverEvents } = require('../shared/events');
const { HeuristicQueryRewriter, LLMQueryRewriter } = require('./query-rewriter');

class RetrievalExecutor {
  constructor(embedder, hybridStore, reranker, queryRewriter) {
    this.embedder = embedder;
    this.hybridStore = hybridStore;
    this.reranker = reranker;
    this.queryRewriter = queryRewriter || new HeuristicQueryRewriter();
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
    const qEmb = await this.embedder.embed(query);
    const candidates = await this.hybridStore.search(qEmb, query, topK);
    const reranked = await this.reranker.rerank(query, candidates);
    const duration = Date.now() - start;
    serverEvents.logEvent('agentic:search', { query, topK, resultCount: reranked.length, duration, actionType });
    const newObs = observation.withResults(reranked);
    return newObs.withAction({ type: actionType, query, resultCount: reranked.length, duration });
  }
}

module.exports = { RetrievalExecutor };
